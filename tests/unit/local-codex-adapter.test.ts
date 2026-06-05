/**
 * v0.8.0: LocalCodexAdapter — mock node:child_process.spawn to verify
 * bin/args/env/timeout behavior. Mirrors the claude adapter test.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  pid = 54321;
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

import { LocalCodexAdapter } from "../../src/adapters/local-codex-adapter.js";
import type { LocalCodexConfig } from "../../src/adapters/local-codex-adapter.js";

const baseCfg: LocalCodexConfig = {
  codexBin: "/usr/local/bin/codex-minimax",
  codexProfile: "m27",
  codexApiKey: "sk-minimax-codex1234567890abcdef",
  codexBaseUrl: "https://api.minimaxi.com/anthropic",
  codexModel: "MiniMax-M2.7-highspeed",
  nativeTimeoutMs: 60_000,
  adapterMode: "live" as const,
};

beforeEach(() => {
  spawnCalls.length = 0;
  fakeChild.removeAllListeners();
  fakeChild.stdout.removeAllListeners();
  fakeChild.stderr.removeAllListeners();
  fakeChild.pid = 54321;
  fakeChild.kill = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LocalCodexAdapter (v0.8.0)", () => {
  it("runtime_is_codex", () => {
    const adapter = new LocalCodexAdapter(baseCfg);
    expect(adapter.runtime).toBe("codex");
  });

  it("spawns_codex_minimax_exec_with_minimax_env", async () => {
    const adapter = new LocalCodexAdapter(baseCfg);
    const collected: string[] = [];
    const run = (async () => {
      for await (const ev of adapter.send({
        prompt: "fix the lint",
        workDir: "/tmp/work",
        sessionKey: "s1",
      })) {
        collected.push(`${ev.type}:${ev.content}`);
      }
    })();
    await new Promise((r) => setImmediate(r));
    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0]!;
    expect(call.bin).toBe("/usr/local/bin/codex-minimax");
    expect(call.args).toEqual(["exec", "fix the lint"]);
    expect(call.opts.cwd).toBe("/tmp/work");
    const env = call.opts.env!;
    expect(env.MINIMAX_API_KEY).toBe("sk-minimax-codex1234567890abcdef");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-minimax-codex1234567890abcdef");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.minimaxi.com/anthropic");
    expect(env.ANTHROPIC_MODEL).toBe("MiniMax-M2.7-highspeed");
    expect(env.CODEX_MINIMAX_PROFILE).toBe("m27");
    // Close to resolve
    fakeChild.stdout.emit("data", Buffer.from("lint fixed\n"));
    fakeChild.emit("close", 0);
    await run;
    const done = collected.find((s) => s.startsWith("done:"));
    expect(done).toBeDefined();
    expect(done).toContain("lint fixed");
  });

  it("non_zero_exit_yields_error_event_with_redacted_stderr", async () => {
    const adapter = new LocalCodexAdapter(baseCfg);
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
      Buffer.from("auth failed: sk-minimax-codex1234567890abcdef"),
    );
    fakeChild.emit("close", 2);
    await run;
    const err = events.find((s) => s.startsWith("error:"));
    expect(err).toBeDefined();
    expect(err).not.toContain("sk-minimax-codex1234567890abcdef");
    expect(err).toContain("[REDACTED]");
  });

  it("timeout_kills_child_with_SIGTERM", async () => {
    const adapter = new LocalCodexAdapter({
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
    await new Promise((r) => setTimeout(r, 100));
    await run;
    expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
    const err = events.find((s) => s.startsWith("error:"));
    expect(err).toBeDefined();
    expect(err).toContain("timed out");
  });

  it("cancel_calls_process_kill_on_tracked_pid", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const adapter = new LocalCodexAdapter(baseCfg);
    const run = (async () => {
      for await (const _ev of adapter.send({
        prompt: "long",
        workDir: "/tmp",
        sessionKey: "s4",
      })) {
        /* drain */
      }
    })();
    await new Promise((r) => setImmediate(r));
    await adapter.cancel("s4", "stop it");
    fakeChild.emit("close", 0);
    await run;
    expect(killSpy).toHaveBeenCalledWith(54321, "SIGTERM");
  });

  it("status_reports_running_then_idle", async () => {
    const adapter = new LocalCodexAdapter(baseCfg);
    const idle = await adapter.status("never-spawned");
    expect(idle.state).toBe("idle");
    const run = (async () => {
      for await (const _ev of adapter.send({
        prompt: "x",
        workDir: "/tmp",
        sessionKey: "s5",
      })) {
        /* drain */
      }
    })();
    await new Promise((r) => setImmediate(r));
    const running = await adapter.status("s5");
    expect(running.state).toBe("running");
    fakeChild.emit("close", 0);
    await run;
  });

  it("stub_mode_short_circuits_without_spawning", async () => {
    const adapter = new LocalCodexAdapter({
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
    expect(done?.content).toContain("[codex native stub]");
  });
});
