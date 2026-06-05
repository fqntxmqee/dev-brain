import { connect } from "node:net";
import { randomBytes } from "node:crypto";

export interface BridgeWebSocketOptions {
  readonly socketPath: string;
  readonly project: string;
  readonly sessionKey: string;
  readonly timeoutMs: number;
}

function buildWebSocketKey(): string {
  return randomBytes(16).toString("base64");
}

function parseFrame(data: Buffer): string | undefined {
  if (data.length < 2) return undefined;
  const byte0 = data[0]!;
  const byte1 = data[1]!;
  const opcode = byte0 & 0x0f;
  if (opcode !== 0x01) return undefined;
  const masked = (byte1 & 0x80) !== 0;
  let payloadLen = byte1 & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    payloadLen = data.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    payloadLen = Number(data.readBigUInt64BE(2));
    offset = 10;
  }
  if (masked) offset += 4;
  return data.subarray(offset, offset + payloadLen).toString("utf8");
}

/**
 * 最小 WebSocket 客户端：连接 cc-connect bridge.sock，订阅 session 回复。
 * bridge.sock 不可用时由调用方回退 HTTP 轮询。
 */
export function connectBridgeWebSocket(
  options: BridgeWebSocketOptions,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const socket = connect(options.socketPath);
    const key = buildWebSocketKey();

    const subscribe = JSON.stringify({
      type: "subscribe",
      project: options.project,
      session_key: options.sessionKey,
    });

    let settled = false;
    let buffer = Buffer.alloc(0);
    let handshakeDone = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error("bridge websocket timeout"));
      }
    }, options.timeoutMs);

    socket.on("connect", () => {
      const request = [
        "GET / HTTP/1.1",
        "Host: localhost",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n");
      socket.write(request);
    });

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (!handshakeDone) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const header = buffer.subarray(0, headerEnd).toString("utf8");
        if (!header.includes("101")) {
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          reject(new Error("bridge websocket handshake failed"));
          return;
        }
        handshakeDone = true;
        buffer = buffer.subarray(headerEnd + 4);
        socket.write(buildTextFrame(subscribe));
      }

      while (buffer.length >= 2) {
        const b1 = buffer[1]!;
        const payloadLen = b1 & 0x7f;
        const maskBit = (b1 & 0x80) !== 0;
        let frameLen = 2 + payloadLen + (maskBit ? 4 : 0);
        if (payloadLen === 126)
          frameLen = 4 + buffer.readUInt16BE(2) + (maskBit ? 4 : 0);
        if (buffer.length < frameLen) break;

        const frame = buffer.subarray(0, frameLen);
        buffer = buffer.subarray(frameLen);
        const text = parseFrame(frame);
        if (!text) continue;

        try {
          const msg = JSON.parse(text) as {
            type?: string;
            text?: string;
            content?: string;
            done?: boolean;
          };
          const reply = msg.text ?? msg.content;
          if (
            reply &&
            (msg.type === "reply" || msg.type === "message" || msg.done)
          ) {
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            resolve(reply);
            return;
          }
        } catch {
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          resolve(text);
          return;
        }
      }
    });

    socket.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    socket.on("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(undefined);
      }
    });
  });
}

function buildTextFrame(payload: string): Buffer {
  const data = Buffer.from(payload, "utf8");
  const mask = randomBytes(4);
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) {
    masked[i] = data[i]! ^ mask[i % 4]!;
  }
  const header = Buffer.alloc(2 + 4);
  header[0] = 0x81;
  header[1] = 0x80 | data.length;
  mask.copy(header, 2);
  return Buffer.concat([header, masked]);
}
