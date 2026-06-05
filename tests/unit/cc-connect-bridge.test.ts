import { describe, expect, it } from "vitest";
import { CcConnectBridge } from "../../src/adapters/cc-connect/index.js";

describe("CcConnectBridge", () => {
  it("should_return_stub_reply_in_stub_mode", async () => {
    const bridge = new CcConnectBridge({
      apiSocketPath: "/tmp/api.sock",
      bridgeSocketPath: "/tmp/bridge.sock",
      mode: "stub",
      enabled: true,
      pollMs: 100,
      timeoutMs: 1000,
      replyPath: "/bridge/reply",
    });

    const result = await bridge.collectReply({
      project: "workspace-claude",
      sessionKey: "dev-brain:test",
      prompt: "hello bridge",
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe("stub");
    expect(result.text).toContain("[bridge stub/workspace-claude]");
  });
});
