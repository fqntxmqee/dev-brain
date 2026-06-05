import { describe, expect, it } from "vitest";
import { splitTextIntoChunks } from "../../src/gateway/text-splitter.js";

describe("splitTextIntoChunks (CAP-GW-06 / T-93)", () => {
  it("returns_empty_string_for_empty_input", () => {
    expect(splitTextIntoChunks("")).toEqual([""]);
  });

  it("returns_single_chunk_for_short_text", () => {
    const text = "hello world";
    expect(splitTextIntoChunks(text)).toEqual([text]);
  });

  it("returns_single_chunk_at_exact_16kb_limit", () => {
    const text = "a".repeat(16 * 1024);
    const chunks = splitTextIntoChunks(text);
    expect(chunks).toHaveLength(1);
    expect(Buffer.byteLength(chunks[0] ?? "", "utf8")).toBe(16 * 1024);
  });

  it("splits_text_exceeding_16kb_into_multiple_chunks", () => {
    const text = "a".repeat(50 * 1024);
    const chunks = splitTextIntoChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(16 * 1024);
    }
  });

  it("preserves_utf8_codepoint_boundaries_no_broken_surrogate", () => {
    // 50K 中文字符,每个 3 字节 = 150KB,需 ~10 段
    const text = "中".repeat(50_000);
    const chunks = splitTextIntoChunks(text);
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(16 * 1024);
      // 每段字符数 * 3 字节 = 段字节数(无 surrogate)
      const codepoints = [...chunk].length;
      expect(Buffer.byteLength(chunk, "utf8")).toBe(codepoints * 3);
    }
  });

  it("prefers_newline_boundary_when_splitting", () => {
    // 在 16KB 边界附近有 \n,应优先在 \n 处切
    const line = "x".repeat(15 * 1024);
    const text = `${line}\n${"y".repeat(15 * 1024)}`;
    const chunks = splitTextIntoChunks(text);
    expect(chunks.length).toBe(2);
    // 第一段应包含换行,第二段从 y 开始
    expect(chunks[0]?.endsWith("\n")).toBe(true);
    expect(chunks[1]?.startsWith("y")).toBe(true);
  });

  it("handles_long_line_without_break", () => {
    // 30KB 单词无空格无换行 → 硬切
    const text = "a".repeat(30 * 1024);
    const chunks = splitTextIntoChunks(text);
    expect(chunks.length).toBe(2);
    expect(Buffer.byteLength(chunks[0] ?? "", "utf8")).toBe(16 * 1024);
    expect(Buffer.byteLength(chunks[1] ?? "", "utf8")).toBe(14 * 1024);
  });

  it("respects_custom_limit", () => {
    const text = "a".repeat(100);
    const chunks = splitTextIntoChunks(text, { limitBytes: 30 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(Buffer.byteLength(c, "utf8")).toBeLessThanOrEqual(30);
    }
  });

  it("joins_chunks_cover_full_input_unchanged", () => {
    const text = "line1\nline2\nline3\n".repeat(2000);
    const chunks = splitTextIntoChunks(text);
    expect(chunks.join("")).toBe(text);
  });
});
