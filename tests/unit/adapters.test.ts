import { beforeEach, describe, expect, it, vi } from "vitest";

// @cursor/sdk transitively requires sqlite3, whose native binding may be
// missing in CI (frozen lockfile + ignored build scripts). Mock the SDK
// module so the live code path can be exercised without touching native code.
vi.mock("@cursor/sdk", () => ({
  Agent: {
    prompt: async () => ({ status: "ok", result: "mocked cursor output" }),
  },
}));

import {
  ClaudeCodeAdapter,
  CodexAdapter,
} from "../../src/adapters/claude-code-adapter.js";
import { CursorAdapter } from "../../src/adapters/cursor-adapter.js";
import { CcConnectClient } from "../../src/adapters/cc-connect/index.js";
import { loadConfig, type DevBrainConfig } from "../../src/config/env.js";
import type { AdapterEvent } from "../../src/adapters/types.js";

function makeStubConfig(
  overrides: Partial<DevBrainConfig> = {},
): DevBrainConfig {
  const base = loadConfig({});
  return { ...base, adapterMode: "stub", ...overrides };
}

function makeStubClient(config: DevBrainConfig): CcConnectClient {
  return new CcConnectClient({
    socketPath: config.ccConnectSocket,
    mode: config.adapterMode,
    syncMode: config.ccSyncMode,
    bin: config.ccConnectBin,
    dataDir: config.ccDataDir,
    relayTimeoutMs: config.ccRelayTimeoutMs,
  });
}

async function collect(
  adapter: {
    send(req: {
      prompt: string;
      workDir: string;
      sessionKey?: string;
    }): AsyncIterable<AdapterEvent>;
  },
  req: { prompt: string; workDir: string; sessionKey?: string },
): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const ev of adapter.send(req)) {
    out.push(ev);
  }
  return out;
}

describe("ClaudeCodeAdapter / CodexAdapter (T-56 / T-57)", () => {
  let config: DevBrainConfig;
  beforeEach(() => {
    config = makeStubConfig();
  });

  it("send_dispatches_progress_then_done_in_stub_mode", async () => {
    const client = makeStubClient(config);
    const adapter = new ClaudeCodeAdapter(config, client);
    const events = await collect(adapter, {
      prompt: "explore",
      workDir: "/tmp",
      sessionKey: "s1",
    });
    expect(events[0]?.type).toBe("progress");
    const done = events.find((e) => e.type === "done");
    expect(done?.content).toContain("[bridge stub/workspace-claude]");
  });

  it("send_after_cancel_yields_error_event", async () => {
    const client = makeStubClient(config);
    const adapter = new ClaudeCodeAdapter(config, client);
    await adapter.cancel("s-cancel", "user requested");
    const events = await collect(adapter, {
      prompt: "x",
      workDir: "/tmp",
      sessionKey: "s-cancel",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
    expect(events[0]?.content).toContain("cancelled");
    expect(events[0]?.content).toContain("user requested");
  });

  it("status_returns_cancelled_state_after_cancel", async () => {
    const client = makeStubClient(config);
    const adapter = new ClaudeCodeAdapter(config, client);
    await adapter.cancel("s-x", "test reason");
    const status = await adapter.status("s-x");
    expect(status.state).toBe("cancelled");
    expect(status.cancelledReason).toBe("test reason");
  });

  it("status_returns_not_found_when_no_matching_session", async () => {
    const client = makeStubClient(config);
    const adapter = new ClaudeCodeAdapter(config, client);
    const status = await adapter.status("s-unknown");
    // stub mode listSessions returns [] → not_found
    expect(status.state).toBe("not_found");
  });

  it("send_without_sessionKey_uses_no_session_placeholder", async () => {
    const client = makeStubClient(config);
    const adapter = new ClaudeCodeAdapter(config, client);
    const events = await collect(adapter, {
      prompt: "no-session-test",
      workDir: "/tmp",
    });
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
  });

  it("cancel_uses_default_reason_when_omitted", async () => {
    const client = makeStubClient(config);
    const adapter = new ClaudeCodeAdapter(config, client);
    await adapter.cancel("s-y");
    const status = await adapter.status("s-y");
    expect(status.cancelledReason).toBe("user requested");
  });

  it("CodexAdapter_runtime_is_codex", async () => {
    const client = makeStubClient(config);
    const adapter = new CodexAdapter(config, client);
    expect(adapter.runtime).toBe("codex");
    const events = await collect(adapter, {
      prompt: "x",
      workDir: "/tmp",
      sessionKey: "s",
    });
    expect(events.find((e) => e.type === "progress")?.content).toContain(
      "codex",
    );
  });
});

describe("CursorAdapter (T-56)", () => {
  it("stub_mode_emits_progress_then_done", async () => {
    const config = makeStubConfig({ cursorApiKey: "" });
    const client = makeStubClient(config);
    const adapter = new CursorAdapter(config, client);
    const events = await collect(adapter, {
      prompt: "test prompt",
      workDir: "/tmp",
      sessionKey: "s1",
    });
    expect(events[0]?.type).toBe("progress");
    expect(events[0]?.content).toContain("cursor adapter (stub)");
    const done = events.find((e) => e.type === "done");
    expect(done?.content).toContain("[cursor stub]");
  });

  it("live_mode_without_apiKey_falls_back_to_cc_connect", async () => {
    const config = makeStubConfig({
      adapterMode: "live",
      cursorApiKey: "",
    });
    const client = makeStubClient({ ...config, adapterMode: "stub" });
    const adapter = new CursorAdapter(config, client);
    const events = await collect(adapter, {
      prompt: "x",
      workDir: "/tmp",
      sessionKey: "s1",
    });
    const progress = events.find((e) =>
      e.content.includes("falling back to cc-connect"),
    );
    expect(progress).toBeDefined();
  });

  it("live_mode_with_apiKey_uses_sdk_path_and_emits_done", async () => {
    // @cursor/sdk is mocked at file top to avoid sqlite3 native binding in CI.
    const config = makeStubConfig({
      adapterMode: "live",
      cursorApiKey: "sk-test",
    });
    const client = makeStubClient({ ...config, adapterMode: "stub" });
    const adapter = new CursorAdapter(config, client);
    const events = await collect(adapter, {
      prompt: "x",
      workDir: "/tmp",
      sessionKey: "s1",
    });
    // Mock returns { status: "ok", result: "mocked cursor output" }
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(done?.content).toContain("mocked cursor output");
  });

  it("status_delegates_to_cc_connect_fallback", async () => {
    const config = makeStubConfig();
    const client = makeStubClient(config);
    const adapter = new CursorAdapter(config, client);
    const status = await adapter.status("s-x");
    expect(status.sessionKey).toBe("s-x");
  });

  it("cancel_is_a_noop_placeholder", async () => {
    const config = makeStubConfig();
    const client = makeStubClient(config);
    const adapter = new CursorAdapter(config, client);
    await expect(adapter.cancel("s1")).resolves.toBeUndefined();
  });
});
