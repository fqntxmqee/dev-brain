import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CcConnectClient,
  CcConnectBridge,
  isSocketReachable,
  udsHttpRequest,
} from "../../src/adapters/cc-connect/index.js";

/**
 * Minimal HTTP-over-UDS mock server. Responds to GET /sessions and POST /send.
 * We support tiny per-request payloads — enough to exercise the client surface.
 */
interface MockHttpServerOpts {
  readonly socketPath: string;
  readonly sessionsBody?: string;
  readonly sessionsStatus?: number;
  readonly sendStatus?: number;
  readonly sendBody?: string;
  readonly replyBody?: string;
}

function safeWrite(socket: Socket, data: string): void {
  if (!socket.writable) return;
  try {
    socket.write(data);
  } catch {
    // intentional swallow
  }
}

async function startHttpServer(opts: MockHttpServerOpts): Promise<Server> {
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const firstLine = buf.split("\r\n", 1)[0] ?? "";
      const [method = "GET", rawPath = "/"] = firstLine.split(" ");

      const respond = (status: number, body: string): void => {
        const reason =
          status === 200 ? "OK" : status === 404 ? "Not Found" : "Error";
        const head = [
          `HTTP/1.1 ${status} ${reason}`,
          `Content-Type: application/json`,
          `Content-Length: ${Buffer.byteLength(body)}`,
          `Connection: close`,
          "",
          "",
        ].join("\r\n");
        safeWrite(socket, head + body);
        socket.end();
      };

      if (method === "GET" && rawPath === "/sessions") {
        respond(opts.sessionsStatus ?? 200, opts.sessionsBody ?? "[]");
        return;
      }
      if (method === "POST" && rawPath === "/send") {
        respond(
          opts.sendStatus ?? 200,
          opts.sendBody ?? JSON.stringify({ status: "ok" }),
        );
        return;
      }
      if (method === "GET" && rawPath.startsWith("/bridge/reply")) {
        respond(
          200,
          opts.replyBody ?? JSON.stringify({ text: "ok", done: true }),
        );
        return;
      }
      respond(404, "{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.socketPath, resolve));
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("CcConnectClient — live UDS paths (T-72)", () => {
  let tmp: string;
  let socketPath: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "cc-client-"));
    socketPath = join(tmp, "api.sock");
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("listSessions_returns_empty_in_stub_mode", async () => {
    const client = new CcConnectClient({
      socketPath,
      mode: "stub",
      syncMode: "send",
      bin: "cc-connect",
      dataDir: "/tmp",
      relayTimeoutMs: 1000,
    });
    expect(await client.listSessions()).toEqual([]);
  });

  it("listSessions_parses_sessions_array_in_live_mode", async () => {
    const server = await startHttpServer({
      socketPath,
      sessionsBody: JSON.stringify([
        { project: "p1", session_key: "k1", platform: "feishu" },
        { project: "p2", session_key: "k2" },
      ]),
    });
    try {
      const client = new CcConnectClient({
        socketPath,
        mode: "live",
        syncMode: "send",
        bin: "cc-connect",
        dataDir: "/tmp",
        relayTimeoutMs: 1000,
      });
      const sessions = await client.listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions[0]?.project).toBe("p1");
    } finally {
      await closeServer(server);
    }
  });

  it("listSessions_returns_empty_when_socket_returns_non_200", async () => {
    const server = await startHttpServer({
      socketPath,
      sessionsStatus: 500,
      sessionsBody: "{}",
    });
    try {
      const client = new CcConnectClient({
        socketPath,
        mode: "live",
        syncMode: "send",
        bin: "cc-connect",
        dataDir: "/tmp",
        relayTimeoutMs: 1000,
      });
      expect(await client.listSessions()).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });

  it("send_dispatches_via_http_when_socket_reachable", async () => {
    const server = await startHttpServer({ socketPath });
    try {
      const client = new CcConnectClient({
        socketPath,
        mode: "live",
        syncMode: "send",
        bin: "cc-connect",
        dataDir: "/tmp",
        relayTimeoutMs: 1000,
      });
      const result = await client.send({
        project: "workspace-claude",
        prompt: "hi",
      });
      expect(result.ok).toBe(true);
      expect(result.dispatched).toBe(true);
      expect(result.output).toContain("workspace-claude");
    } finally {
      await closeServer(server);
    }
  });

  it("send_returns_error_when_http_status_non_200", async () => {
    const server = await startHttpServer({
      socketPath,
      sendStatus: 500,
      sendBody: "boom",
    });
    try {
      const client = new CcConnectClient({
        socketPath,
        mode: "live",
        syncMode: "send",
        bin: "cc-connect",
        dataDir: "/tmp",
        relayTimeoutMs: 1000,
      });
      const result = await client.send({
        project: "workspace-claude",
        prompt: "hi",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("boom");
    } finally {
      await closeServer(server);
    }
  });

  it("send_returns_error_when_status_not_ok_in_body", async () => {
    const server = await startHttpServer({
      socketPath,
      sendBody: JSON.stringify({ status: "error", reason: "oops" }),
    });
    try {
      const client = new CcConnectClient({
        socketPath,
        mode: "live",
        syncMode: "send",
        bin: "cc-connect",
        dataDir: "/tmp",
        relayTimeoutMs: 1000,
      });
      const result = await client.send({
        project: "workspace-claude",
        prompt: "hi",
      });
      expect(result.ok).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it("ping_returns_true_when_socket_accepts", async () => {
    const server = await startHttpServer({ socketPath });
    try {
      const client = new CcConnectClient({
        socketPath,
        mode: "live",
        syncMode: "send",
        bin: "cc-connect",
        dataDir: "/tmp",
        relayTimeoutMs: 1000,
      });
      expect(await client.ping()).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it("ping_returns_false_when_socket_missing", async () => {
    const client = new CcConnectClient({
      socketPath: join(tmp, "missing.sock"),
      mode: "live",
      syncMode: "send",
      bin: "cc-connect",
      dataDir: "/tmp",
      relayTimeoutMs: 1000,
    });
    expect(await client.ping()).toBe(false);
  });

  it("send_uses_explicit_sessionKey_when_provided", async () => {
    const server = await startHttpServer({ socketPath });
    try {
      const client = new CcConnectClient({
        socketPath,
        mode: "live",
        syncMode: "send",
        bin: "cc-connect",
        dataDir: "/tmp",
        relayTimeoutMs: 1000,
      });
      const result = await client.send({
        project: "p",
        prompt: "x",
        sessionKey: "explicit-key",
      });
      expect(result.output).toContain("explicit-key");
    } finally {
      await closeServer(server);
    }
  });

  it("send_with_stub_mode_returns_stub_output", async () => {
    const client = new CcConnectClient({
      socketPath,
      mode: "stub",
      syncMode: "send",
      bin: "cc-connect",
      dataDir: "/tmp",
      relayTimeoutMs: 1000,
    });
    const result = await client.send({ project: "p", prompt: "x" });
    expect(result.ok).toBe(true);
    expect(result.output).toBeDefined();
  });
});

describe("CcConnectBridge — collectReply paths", () => {
  let tmp: string;
  let socketPath: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "cc-bridge-"));
    socketPath = join(tmp, "api.sock");
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns_skipped_when_disabled_in_live_mode", async () => {
    const bridge = new CcConnectBridge({
      apiSocketPath: socketPath,
      bridgeSocketPath: socketPath,
      mode: "live",
      enabled: false,
      pollMs: 100,
      timeoutMs: 200,
      replyPath: "/bridge/reply",
    });
    const result = await bridge.collectReply({
      project: "p",
      sessionKey: "s",
      prompt: "x",
    });
    expect(result.source).toBe("skipped");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("bridge disabled");
  });

  it("falls_back_to_http_when_ws_unavailable_then_returns_text", async () => {
    const server = await startHttpServer({ socketPath });
    try {
      const bridge = new CcConnectBridge({
        apiSocketPath: socketPath,
        bridgeSocketPath: join(tmp, "no-ws.sock"),
        mode: "live",
        enabled: true,
        pollMs: 50,
        timeoutMs: 800,
        replyPath: "/bridge/reply",
        wsMaxRetries: 1,
        wsRetryBackoffMs: 10,
      });
      const result = await bridge.collectReply({
        project: "p",
        sessionKey: "s",
        prompt: "x",
      });
      expect(result.ok).toBe(true);
      expect(result.text).toBe("ok");
      expect(result.source).toBe("bridge-http");
    } finally {
      await closeServer(server);
    }
  });

  it("http_returns_timeout_error_when_endpoint_silent", async () => {
    // create endpoint that returns 404
    const server = await startHttpServer({
      socketPath,
      replyBody: "",
    });
    try {
      const bridge = new CcConnectBridge({
        apiSocketPath: socketPath,
        bridgeSocketPath: join(tmp, "no-ws.sock"),
        mode: "live",
        enabled: true,
        pollMs: 50,
        timeoutMs: 250,
        replyPath: "/nonexistent",
        wsMaxRetries: 1,
        wsRetryBackoffMs: 10,
      });
      const result = await bridge.collectReply({
        project: "p",
        sessionKey: "s",
        prompt: "x",
      });
      expect(result.ok).toBe(false);
      // either 404 endpoint-not-found or polling timeout — both acceptable
      expect(result.error).toContain("[bridge:state]");
    } finally {
      await closeServer(server);
    }
  });

  it("shouldCollectAfterDispatch_returns_enabled_flag", () => {
    const bridge = new CcConnectBridge({
      apiSocketPath: socketPath,
      bridgeSocketPath: socketPath,
      mode: "live",
      enabled: true,
      pollMs: 100,
      timeoutMs: 1000,
      replyPath: "/bridge/reply",
    });
    expect(bridge.shouldCollectAfterDispatch()).toBe(true);
  });

  it("stub_mode_collectReply_returns_stub_text", async () => {
    const bridge = new CcConnectBridge({
      apiSocketPath: socketPath,
      bridgeSocketPath: socketPath,
      mode: "stub",
      enabled: true,
      pollMs: 100,
      timeoutMs: 1000,
      replyPath: "/bridge/reply",
    });
    const result = await bridge.collectReply({
      project: "p1",
      sessionKey: "s1",
      prompt: "hello world",
    });
    expect(result.source).toBe("stub");
    expect(result.text).toContain("[bridge stub/p1]");
  });
});

describe("udsHttpRequest + isSocketReachable", () => {
  let tmp: string;
  let socketPath: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "uds-mod-"));
    socketPath = join(tmp, "api.sock");
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns_response_body_when_server_responds_with_json", async () => {
    const server = await startHttpServer({
      socketPath,
      sessionsBody: '{"hello":"world"}',
    });
    try {
      const res = await udsHttpRequest(socketPath, "GET", "/sessions");
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("hello");
    } finally {
      await closeServer(server);
    }
  });

  it("returns_404_response_for_unknown_path", async () => {
    const server = await startHttpServer({ socketPath });
    try {
      const res = await udsHttpRequest(socketPath, "GET", "/no-such-route");
      expect(res.statusCode).toBe(404);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects_with_friendly_chinese_when_socket_missing", async () => {
    await expect(
      udsHttpRequest(join(tmp, "missing.sock"), "GET", "/sessions"),
    ).rejects.toThrow(/不存在|UDS/);
  });

  it("isSocketReachable_returns_false_on_missing_socket", async () => {
    expect(await isSocketReachable(join(tmp, "missing.sock"))).toBe(false);
  });
});
