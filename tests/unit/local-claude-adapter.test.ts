/**
 * v0.8.0: LocalClaudeCodeAdapter — mock node:child_process.spawn
 * to verify bin/args/env/timeout/cancel behavior without invoking a real CLI.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Track spawn calls
const spawnCalls: Array<{
  bin: string;
  args: ReadonlyArray<string>;
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio?: ReadonlyArray<string>;
  };
}> = [];

class FakeStream extends EventEmitter {
  write(_chunk: string): boolean {
    return true;
  }
}

class FakeChild extends EventEmitter {
  pid = 12345;
  stdout = new FakeStream();
  stderr = new FakeStream();
  kill = vi.fn();
}

const fakeChild = new FakeChild();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((bin: string, args: ReadonlyArray<string>, opts: object) => {
      spawnCalls.push({ bin, args, opts: opts as never });
      return fakeChild as unknown as ReturnType<typeof actual.spawn>;
    }),
  };
});

import { LocalClaudeCodeAdapter } from "../../src/adapters/local-claude-code-adapter.js";
import type { LocalClaudeConfig } from "../../src/adapters/local-claude-code-adapter.js";
import { redactMessage } from "../../src/core/redact.js";

const baseCfg: LocalClaudeConfig = {
  claudeBin: "/usr/local/bin/claude",
  claudeApiKey: "sk-minimax-test1234567890abcdef",
  claudeBaseUrl: "https://api.minimaxi.com/anthropic",
  claudeModel: "MiniMax-M3-highspeed",
  claudePermissionMode: "bypassPermissions",
  claudeExtraArgs: ["--add-dir", "/extra"],
  nativeTimeoutMs: 60_000,
  adapterMode: "live" as const,
};

beforeEach(() => {
  spawnCalls.length = 0;
  fakeChild.removeAllListeners();
  fakeChild.stdout.removeAllListeners();
  fakeChild.stderr.removeAllListeners();
  fakeChild.pid = 12345;
  fakeChild.kill = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("LocalClaudeCodeAdapter (v0.8.0)", () => {
  it("runtime_is_claude_code", () => {
    const adapter = new LocalClaudeCodeAdapter(baseCfg);
    expect(adapter.runtime).toBe("claude-code");
  });

  it("spawns_claude_with_dash_p_and_required_flags", async () => {
    const adapter = new LocalClaudeCodeAdapter(baseCfg);
    const collected: string[] = [];
    const run = (async () => {
      for await (const ev of adapter.send({
        prompt: "hello world",
        workDir: "/tmp/work",
        sessionKey: "s1",
      })) {
        collected.push(`${ev.type}:${ev.content}`);
      }
    })();
    // Yield so the spawn call is registered
    await new Promise((r) => setImmediate(r));
    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0]!;
    expect(call.bin).toBe("/usr/local/bin/claude");
    expect(call.args).toEqual([
      "-p",
      "hello world",
      "--model",
      "MiniMax-M3-highspeed",
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "text",
      "--bare",
      "--add-dir",
      "/extra",
    ]);
    expect(call.opts.cwd).toBe("/tmp/work");
    // Env must contain MiniMax vars
    const env = call.opts.env!;
    expect(env.ANTHROPIC_API_KEY).toBe("sk-minimax-test1234567890abcdef");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.minimaxi.com/anthropic");
    expect(env.ANTHROPIC_MODEL).toBe("MiniMax-M3-highspeed");
    // Close child to resolve
    fakeChild.stdout.emit("data", Buffer.from("hi there\n"));
    fakeChild.emit("close", 0);
    await run;
    expect(collected.some((s) => s.startsWith("done:"))).toBe(true);
    expect(collected.find((s) => s.startsWith("done:"))).toContain("hi there");
  });

  it("non_zero_exit_yields_error_event", async () => {
    const adapter = new LocalClaudeCodeAdapter(baseCfg);
    const events: string[] = [];
    const run = (async () => {
      for await (const ev of adapter.send({
        prompt: "x",
        workDir: "/tmp",
        sessionKey: "s2",
      })) {
        events.push(`${ev.type}:${ev.content}`);
      }
    })();
    await new Promise((r) => setImmediate(r));
    fakeChild.stderr.emit(
      "data",
      Buffer.from("api key invalid: sk-minimax-test1234567890abcdef"),
    );
    fakeChild.emit("close", 1);
    await run;
    const err = events.find((s) => s.startsWith("error:"));
    expect(err).toBeDefined();
    // stderr should be redacted — the long sk-*** token must be replaced
    expect(err).not.toContain("sk-minimax-test1234567890abcdef");
    expect(err).toContain("[REDACTED]");
    // Smoke: redactMessage is the function that does the replacement
    expect(redactMessage("sk-minimax-test1234567890abcdef")).toBe("[REDACTED]");
  });

  it("timeout_kills_child_with_SIGTERM", async () => {
    const adapter = new LocalClaudeCodeAdapter({
      ...baseCfg,
      nativeTimeoutMs: 50,
    });
    const events: string[] = [];
    const run = (async () => {
      for await (const ev of adapter.send({
        prompt: "slow",
        workDir: "/tmp",
        sessionKey: "s3",
      })) {
        events.push(`${ev.type}:${ev.content}`);
      }
    })();
    await new Promise((r) => setImmediate(r));
    expect(fakeChild.kill).not.toHaveBeenCalled();
    // Wait past the 50ms timeout for the timer to fire naturally
    await new Promise((r) => setTimeout(r, 100));
    await run;
    expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
    const err = events.find((s) => s.startsWith("error:"));
    expect(err).toBeDefined();
    expect(err).toContain("timed out");
  });

  it("cancel_calls_process_kill_on_tracked_pid", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const adapter = new LocalClaudeCodeAdapter(baseCfg);
    const run = (async () => {
      for await (const _ev of adapter.send({
        prompt: "long running",
        workDir: "/tmp",
        sessionKey: "s4",
      })) {
        /* drain */
      }
    })();
    await new Promise((r) => setImmediate(r));
    await adapter.cancel("s4", "user wants it gone");
    // Now emit close so the iterator finishes
    fakeChild.emit("close", 0);
    await run;
    expect(killSpy).toHaveBeenCalledWith(12345, "SIGTERM");
    killSpy.mockRestore();
  });

  it("status_returns_running_when_proc_is_live", async () => {
    const adapter = new LocalClaudeCodeAdapter(baseCfg);
    const run = (async () => {
      for await (const _ev of adapter.send({
        prompt: "live",
        workDir: "/tmp",
        sessionKey: "s5",
      })) {
        /* drain */
      }
    })();
    await new Promise((r) => setImmediate(r));
    const s = await adapter.status("s5");
    expect(s.state).toBe("running");
    fakeChild.emit("close", 0);
    await run;
  });

  it("status_returns_idle_when_proc_is_not_live", async () => {
    const adapter = new LocalClaudeCodeAdapter(baseCfg);
    const s = await adapter.status("never-spawned");
    expect(s.state).toBe("idle");
  });

  it("stub_mode_short_circuits_without_spawning", async () => {
    const adapter = new LocalClaudeCodeAdapter({
      ...baseCfg,
      adapterMode: "stub",
    });
    const events: Array<{ type: string; content: string }> = [];
    for await (const ev of adapter.send({
      prompt: "hello",
      workDir: "/tmp",
      sessionKey: "s-stub",
    })) {
      events.push({ type: ev.type, content: ev.content });
    }
    expect(spawnCalls).toHaveLength(0);
    expect(events[0]?.type).toBe("progress");
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(done?.content).toContain("[claude-code native stub]");
  });
});
