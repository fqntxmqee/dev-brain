import { describe, expect, it } from "vitest";
import { redactMessage, redactError } from "../../src/core/redact.js";

describe("redactMessage", () => {
  it("redacts_openai_sk_tokens", () => {
    expect(
      redactMessage("auth failed with sk-proj-1234567890abcdefghij"),
    ).toContain("[REDACTED]");
    expect(
      redactMessage("auth failed with sk-proj-1234567890abcdefghij"),
    ).not.toContain("sk-proj-");
  });

  it("redacts_github_pat_prefix", () => {
    expect(
      redactMessage("token gho_abcdefghijklmnopqrstuvwxyz leaked"),
    ).toContain("[REDACTED]");
  });

  it("redacts_bearer_authorization", () => {
    const out = redactMessage(
      "GET /api Authorization: Bearer abc.def.ghi1234567890",
    );
    expect(out).toContain("Bearer [REDACTED]");
    expect(out).not.toContain("abc.def.ghi");
  });

  it("redacts_jwt_tokens", () => {
    const jwt =
      "eyJabc1234567890abcdefghij.eyJabc1234567890abcdefghij.signature1234567890";
    const out = redactMessage(`token=${jwt}`);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts_aws_access_key_prefix", () => {
    expect(
      redactMessage("aws_access_key_id=AKIAIOSFODNN7EXAMPLE leaked"),
    ).toContain("[REDACTED]");
  });

  it("preserves_safe_text", () => {
    expect(redactMessage("普通消息，无需脱敏")).toBe("普通消息，无需脱敏");
  });

  it("redacts_key_value_pair_sensitive_keys", () => {
    const out = redactMessage(
      "config: api_key=secret123 password=hunter2 user=alice",
    );
    expect(out).toContain("api_key=[REDACTED]");
    expect(out).toContain("password=[REDACTED]");
    expect(out).toContain("user=alice");
  });
});

describe("redactError", () => {
  it("redacts_Error_message", () => {
    const e = new Error("auth failed with sk-proj-abcdefghijklmnopqrst");
    expect(redactError(e)).toContain("[REDACTED]");
  });

  it("handles_null_and_undefined", () => {
    expect(redactError(null)).toBe("Unknown error");
    expect(redactError(undefined)).toBe("Unknown error");
  });

  it("handles_string_throw", () => {
    expect(redactError("bearer xyz123456789abcdefg")).toContain(
      "Bearer [REDACTED]",
    );
  });

  it("handles_primitive_numbers", () => {
    expect(redactError(42)).toBe("42");
  });
});
