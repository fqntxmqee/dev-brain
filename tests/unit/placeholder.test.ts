import { describe, expect, it } from "vitest";
import {
  looksLikePlaceholder,
  detectPlaceholders,
  loadConfig,
} from "../../src/config/env.js";

describe("looksLikePlaceholder (CAP-CONF-02 / T-71)", () => {
  it("detects_cli_xxx", () => {
    expect(looksLikePlaceholder("cli_xxx")).toBe(true);
    expect(looksLikePlaceholder("cli_xxxxxx")).toBe(true);
  });

  it("detects_your_keyword", () => {
    expect(looksLikePlaceholder("your_app_id")).toBe(true);
    expect(looksLikePlaceholder("YOUR_API_KEY")).toBe(true);
  });

  it("detects_replace_me", () => {
    expect(looksLikePlaceholder("replace_me_value")).toBe(true);
    expect(looksLikePlaceholder("replace-me-value")).toBe(true);
  });

  it("detects_xxxx", () => {
    expect(looksLikePlaceholder("xxx")).toBe(true);
  });

  it("rejects_real_values", () => {
    expect(looksLikePlaceholder("cli_a1b2c3d4e5f6g7h8")).toBe(false);
    expect(looksLikePlaceholder("real-secret-1234567890")).toBe(false);
  });

  it("rejects_short_or_empty", () => {
    expect(looksLikePlaceholder("")).toBe(false);
    expect(looksLikePlaceholder("ab")).toBe(false);
  });
});

describe("detectPlaceholders", () => {
  it("returns_empty_for_real_config", () => {
    const c = loadConfig({});
    expect(detectPlaceholders(c)).toEqual([]);
  });

  it("detects_placeholder_feishu_app_id", () => {
    const c = loadConfig({
      DEV_BRAIN_FEISHU_APP_ID: "cli_xxx",
      DEV_BRAIN_FEISHU_APP_SECRET: "your_secret",
    });
    const hits = detectPlaceholders(c);
    expect(hits).toContain("DEV_BRAIN_FEISHU_APP_ID");
    expect(hits).toContain("DEV_BRAIN_FEISHU_APP_SECRET");
  });
});
