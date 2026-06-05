import { describe, expect, it } from "vitest";
import { translateUdsError } from "../../src/adapters/cc-connect-http.js";

describe("translateUdsError", () => {
  it("translates_ENOENT_to_friendly_chinese", () => {
    const e = new Error("spawn ENOENT") as Error & { code?: string };
    e.code = "ENOENT";
    const result = translateUdsError(e, "GET", "/sessions");
    expect(result.message).toContain("cc-connect UDS socket 不存在");
  });

  it("translates_ECONNREFUSED", () => {
    const e = new Error("connect ECONNREFUSED") as Error & { code?: string };
    e.code = "ECONNREFUSED";
    const result = translateUdsError(e, "POST", "/send");
    expect(result.message).toContain("拒绝连接");
  });

  it("translates_ETIMEDOUT", () => {
    const e = new Error("timeout") as Error & { code?: string };
    e.code = "ETIMEDOUT";
    const result = translateUdsError(e, "GET", "/sessions");
    expect(result.message).toContain("通信超时");
  });

  it("falls_back_to_generic_for_unknown_codes", () => {
    const e = new Error("weird error");
    const result = translateUdsError(e, "GET", "/x");
    expect(result.message).toContain("weird error");
  });

  it("handles_string_throw", () => {
    const result = translateUdsError("oops", "GET", "/x");
    expect(result.message).toContain("oops");
  });
});
