import { describe, expect, it } from "vitest";
import { formatError } from "../../src/core/format-error.js";
import {
  AdapterError,
  AuthError,
  ConfigError,
  PlanError,
} from "../../src/core/errors.js";

describe("formatError (CAP-ERR-03 / T-54)", () => {
  it("feishu_audience_uses_emoji_code_msg", () => {
    const out = formatError(new AuthError("sender not in allowFrom"), "feishu");
    expect(out).toContain("⛔");
    expect(out).toContain("[AUTH_ERROR]");
    expect(out).toContain("sender not in allowFrom");
  });

  it("cli_audience_appends_next_step", () => {
    const out = formatError(new ConfigError("missing"), "cli");
    expect(out).toContain("🔑");
    expect(out).toContain("💡");
  });

  it("log_audience_emits_event_code_msg", () => {
    const out = formatError(new AdapterError("down"), "log");
    expect(out).toContain("event=error");
    expect(out).toContain("code=ADAPTER_ERROR");
  });

  it("redacts_sensitive_in_log_audience", () => {
    const out = formatError(
      new AdapterError("auth failed with sk-proj-1234567890abcdefghij"),
      "log",
    );
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("sk-proj-");
  });

  it("falls_back_to_x_emoji_for_unknown_code", () => {
    const err = new PlanError("nope");
    (err as { code: string }).code = "TOTALLY_UNKNOWN_CODE";
    const out = formatError(err, "feishu");
    expect(out).toContain("❌");
  });
});
