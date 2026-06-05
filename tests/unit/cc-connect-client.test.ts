import { describe, expect, it } from "vitest";
import { CcConnectClient } from "../../src/adapters/cc-connect/index.js";
import { parseSessionsBody } from "../../src/adapters/cc-connect/index.js";

describe("CcConnectClient", () => {
  it("should_return_stub_output_without_socket_in_stub_mode", async () => {
    const client = new CcConnectClient({
      socketPath: "/nonexistent/api.sock",
      mode: "stub",
      syncMode: "send",
      bin: "cc-connect",
      dataDir: "/tmp",
      relayTimeoutMs: 1000,
    });
    const result = await client.send({
      project: "workspace-claude",
      prompt: "explore auth module",
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("[bridge stub/workspace-claude]");
  });

  it("should_fail_when_live_mode_and_socket_unreachable", async () => {
    const client = new CcConnectClient({
      socketPath: "/nonexistent/api.sock",
      mode: "live",
      syncMode: "send",
      bin: "cc-connect",
      dataDir: "/tmp",
      relayTimeoutMs: 1000,
    });
    const result = await client.send({
      project: "workspace-codex",
      prompt: "implement feature",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("unreachable");
  });
});

describe("parseSessionsBody", () => {
  it("should_parse_session_array", () => {
    const sessions = parseSessionsBody(
      JSON.stringify([
        {
          project: "workspace-claude",
          session_key: "dev-brain:test:1",
          platform: "feishu",
        },
      ]),
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.project).toBe("workspace-claude");
  });
});
