import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

/**
 * Mirror of buildTextFrame + parseFrame in cc-connect-bridge-ws.ts.
 * Kept in sync via test — these helpers are intentionally not exported
 * because they're an implementation detail of the WS handshake.
 */
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
  let maskKey: Buffer | undefined;
  if (masked) {
    maskKey = data.subarray(offset, offset + 4);
    offset += 4;
  }
  const payload = data.subarray(offset, offset + payloadLen);
  if (maskKey) {
    const unmasked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i += 1) {
      unmasked[i] = payload[i]! ^ maskKey[i % 4]!;
    }
    return unmasked.toString("utf8");
  }
  return payload.toString("utf8");
}

describe("WebSocket frame codec", () => {
  it("roundtrips_short_text_frame", () => {
    const frame = buildTextFrame("hello");
    expect(parseFrame(frame)).toBe("hello");
  });

  it("roundtrips_chinese_text", () => {
    const text = "你好，飞书";
    expect(parseFrame(buildTextFrame(text))).toBe(text);
  });

  it("roundtrips_empty_payload", () => {
    const frame = buildTextFrame("");
    expect(parseFrame(frame)).toBe("");
  });

  it("rejects_too_short_buffer", () => {
    expect(parseFrame(Buffer.alloc(0))).toBeUndefined();
    expect(parseFrame(Buffer.alloc(1))).toBeUndefined();
  });

  it("rejects_binary_opcode", () => {
    const buf = Buffer.alloc(4);
    buf[0] = 0x82; // binary frame
    buf[1] = 0x80; // masked, len=0
    buf[2] = 0;
    buf[3] = 0;
    expect(parseFrame(buf)).toBeUndefined();
  });

  it("handles_126_extended_length", () => {
    // Build a 200-byte text frame manually
    const text = "a".repeat(200);
    const data = Buffer.from(text, "utf8");
    const mask = randomBytes(4);
    const masked = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i += 1) {
      masked[i] = data[i]! ^ mask[i % 4]!;
    }
    const header = Buffer.alloc(2 + 2 + 4);
    header[0] = 0x81;
    header[1] = 0x80 | 126; // masked + extended
    header.writeUInt16BE(data.length, 2);
    mask.copy(header, 4);
    const frame = Buffer.concat([header, masked]);
    expect(parseFrame(frame)).toBe(text);
  });
});
