import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { connectBridgeWebSocket } from "../../src/adapters/cc-connect/ws.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

interface MockHandshake {
  readonly headers: Record<string, string>;
}

interface MockServerOptions {
  readonly socketPath: string;
  /** Reply written after handshake (text frame, server → client). */
  readonly serverReply?: string;
  /** If true, send 400 Bad Request instead of 101. */
  readonly rejectHandshake?: boolean;
  /** If true, accept the socket but never write anything. */
  readonly silent?: boolean;
  /** If true, send a binary opcode frame (should be ignored by client). */
  readonly sendBinaryFrame?: boolean;
  /** If true, send a 200-byte extended-length text frame. */
  readonly sendExtendedFrame?: boolean;
  /** If true, send invalid JSON to trigger plain-text fallback. */
  readonly sendInvalidJson?: boolean;
}

function buildUnmaskedTextFrame(payload: string): Buffer {
  const data = Buffer.from(payload, "utf8");
  if (data.length < 126) {
    const header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text
    header[1] = data.length; // unmasked
    return Buffer.concat([header, data]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(data.length, 2);
  return Buffer.concat([header, data]);
}

function buildUnmaskedBinaryFrame(payload: Buffer): Buffer {
  const header = Buffer.alloc(2);
  header[0] = 0x82; // FIN + binary
  header[1] = payload.length;
  return Buffer.concat([header, payload]);
}

function computeAcceptKey(clientKey: string): string {
  return createHash("sha1")
    .update(clientKey + WS_GUID)
    .digest("base64");
}

function parseHandshakeHeaders(raw: string): MockHandshake {
  const lines = raw.split("\r\n");
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim().toLowerCase();
    const v = line.slice(idx + 1).trim();
    headers[k] = v;
  }
  return { headers };
}

function safeWrite(socket: Socket, payload: Buffer | string): void {
  if (!socket.writable) return;
  try {
    socket.write(payload);
  } catch {
    // Client may have closed before we finished writing; that's fine in tests.
  }
}

async function startMockServer(opts: MockServerOptions): Promise<Server> {
  const server = createServer((socket: Socket) => {
    socket.on("error", () => undefined);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      if (opts.rejectHandshake) {
        safeWrite(socket, "HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.end();
        return;
      }

      const { headers } = parseHandshakeHeaders(
        buffer.subarray(0, headerEnd).toString("utf8"),
      );
      const accept = computeAcceptKey(headers["sec-websocket-key"] ?? "");
      const handshakeResponse = [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n");
      safeWrite(socket, handshakeResponse);

      if (opts.silent) return;

      if (opts.sendBinaryFrame) {
        safeWrite(socket, buildUnmaskedBinaryFrame(Buffer.from("ignored")));
        if (opts.serverReply) {
          safeWrite(socket, buildUnmaskedTextFrame(opts.serverReply));
        }
        return;
      }

      if (opts.sendExtendedFrame) {
        const payload = "x".repeat(200);
        safeWrite(
          socket,
          buildUnmaskedTextFrame(
            JSON.stringify({ type: "reply", text: payload }),
          ),
        );
        return;
      }

      if (opts.sendInvalidJson) {
        safeWrite(socket, buildUnmaskedTextFrame("not-valid-json-{{"));
        return;
      }

      if (opts.serverReply) {
        safeWrite(socket, buildUnmaskedTextFrame(opts.serverReply));
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(opts.socketPath, () => resolve());
  });
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

describe("connectBridgeWebSocket (T-58/T-59)", () => {
  let tmpDir: string;
  let socketPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ws-test-"));
    socketPath = join(tmpDir, "bridge.sock");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("resolves_with_reply_text_when_server_sends_json_reply", async () => {
    const server = await startMockServer({
      socketPath,
      serverReply: JSON.stringify({
        type: "reply",
        text: "hello from bridge",
      }),
    });
    try {
      const reply = await connectBridgeWebSocket({
        socketPath,
        project: "p1",
        sessionKey: "s1",
        timeoutMs: 2000,
      });
      expect(reply).toBe("hello from bridge");
    } finally {
      await closeServer(server);
    }
  });

  it("resolves_with_content_field_when_message_type", async () => {
    const server = await startMockServer({
      socketPath,
      serverReply: JSON.stringify({
        type: "message",
        content: "alt content field",
      }),
    });
    try {
      const reply = await connectBridgeWebSocket({
        socketPath,
        project: "p1",
        sessionKey: "s1",
        timeoutMs: 2000,
      });
      expect(reply).toBe("alt content field");
    } finally {
      await closeServer(server);
    }
  });

  it("resolves_when_done_flag_set", async () => {
    const server = await startMockServer({
      socketPath,
      serverReply: JSON.stringify({
        text: "done payload",
        done: true,
      }),
    });
    try {
      const reply = await connectBridgeWebSocket({
        socketPath,
        project: "p1",
        sessionKey: "s1",
        timeoutMs: 2000,
      });
      expect(reply).toBe("done payload");
    } finally {
      await closeServer(server);
    }
  });

  it("falls_back_to_plain_text_when_invalid_json", async () => {
    const server = await startMockServer({
      socketPath,
      sendInvalidJson: true,
    });
    try {
      const reply = await connectBridgeWebSocket({
        socketPath,
        project: "p1",
        sessionKey: "s1",
        timeoutMs: 2000,
      });
      expect(reply).toBe("not-valid-json-{{");
    } finally {
      await closeServer(server);
    }
  });

  it("ignores_binary_frames_and_uses_following_text_frame", async () => {
    const server = await startMockServer({
      socketPath,
      sendBinaryFrame: true,
      serverReply: JSON.stringify({ type: "reply", text: "after binary" }),
    });
    try {
      const reply = await connectBridgeWebSocket({
        socketPath,
        project: "p1",
        sessionKey: "s1",
        timeoutMs: 2000,
      });
      expect(reply).toBe("after binary");
    } finally {
      await closeServer(server);
    }
  });

  it("handles_extended_length_frames_above_126_bytes", async () => {
    const server = await startMockServer({
      socketPath,
      sendExtendedFrame: true,
    });
    try {
      const reply = await connectBridgeWebSocket({
        socketPath,
        project: "p1",
        sessionKey: "s1",
        timeoutMs: 2000,
      });
      expect(reply).toBe("x".repeat(200));
    } finally {
      await closeServer(server);
    }
  });

  it("rejects_when_server_returns_non_101_handshake", async () => {
    const server = await startMockServer({
      socketPath,
      rejectHandshake: true,
    });
    try {
      await expect(
        connectBridgeWebSocket({
          socketPath,
          project: "p1",
          sessionKey: "s1",
          timeoutMs: 2000,
        }),
      ).rejects.toThrow(/handshake failed/);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects_when_handshake_times_out", async () => {
    const server = await startMockServer({
      socketPath,
      silent: true,
    });
    try {
      await expect(
        connectBridgeWebSocket({
          socketPath,
          project: "p1",
          sessionKey: "s1",
          timeoutMs: 200,
        }),
      ).rejects.toThrow(/timeout/);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects_when_socket_connect_fails", async () => {
    await expect(
      connectBridgeWebSocket({
        socketPath: join(tmpDir, "missing.sock"),
        project: "p1",
        sessionKey: "s1",
        timeoutMs: 500,
      }),
    ).rejects.toBeDefined();
  });
});
