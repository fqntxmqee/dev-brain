import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";

/**
 * v0.8.0: Native agent adapter config defaults — match the user's
 * existing cc-connect MiniMax config so the v0.7.0→v0.8.0 switch is
 * zero-friction. Advanced users override via DEV_BRAIN_* env vars.
 */
describe("v0.8.0: native agent backend config defaults", () => {
  it("agentBackend_defaults_to_native", () => {
    expect(loadConfig({}).agentBackend).toBe("native");
  });

  it("agentBackend_accepts_cc_connect_override", () => {
    expect(
      loadConfig({ DEV_BRAIN_AGENT_BACKEND: "cc-connect" }).agentBackend,
    ).toBe("cc-connect");
  });

  it("agentBackend_ignores_unknown_values_and_defaults_to_native", () => {
    expect(
      loadConfig({ DEV_BRAIN_AGENT_BACKEND: "something-weird" }).agentBackend,
    ).toBe("native");
  });

  it("claudeBin_defaults_to_claude", () => {
    expect(loadConfig({}).claudeBin).toBe("claude");
  });

  it("claudeBaseUrl_defaults_to_minimaxi", () => {
    expect(loadConfig({}).claudeBaseUrl).toBe(
      "https://api.minimaxi.com/anthropic",
    );
  });

  it("claudeModel_defaults_to_M3_highspeed", () => {
    expect(loadConfig({}).claudeModel).toBe("MiniMax-M3-highspeed");
  });

  it("claudePermissionMode_defaults_to_bypassPermissions", () => {
    expect(loadConfig({}).claudePermissionMode).toBe("bypassPermissions");
  });

  it("claudeExtraArgs_defaults_to_empty", () => {
    expect(loadConfig({}).claudeExtraArgs).toEqual([]);
  });

  it("claudeExtraArgs_splits_on_whitespace", () => {
    expect(
      loadConfig({
        DEV_BRAIN_CLAUDE_EXTRA_ARGS: "--add-dir /extra --verbose",
      }).claudeExtraArgs,
    ).toEqual(["--add-dir", "/extra", "--verbose"]);
  });

  it("claudeApiKey_chain_falls_back_to_MINIMAX_API_KEY", () => {
    const c = loadConfig({ MINIMAX_API_KEY: "sk-minimax-xxx" });
    expect(c.claudeApiKey).toBe("sk-minimax-xxx");
  });

  it("claudeApiKey_chain_falls_back_to_ANTHROPIC_API_KEY", () => {
    const c = loadConfig({ ANTHROPIC_API_KEY: "sk-anthropic-yyy" });
    expect(c.claudeApiKey).toBe("sk-anthropic-yyy");
  });

  it("claudeApiKey_explicit_overrides_env_chain", () => {
    const c = loadConfig({
      DEV_BRAIN_CLAUDE_API_KEY: "sk-explicit",
      MINIMAX_API_KEY: "sk-minimax",
    });
    expect(c.claudeApiKey).toBe("sk-explicit");
  });

  it("codexBin_defaults_to_codex_minimax", () => {
    expect(loadConfig({}).codexBin).toBe("codex-minimax");
  });

  it("codexProfile_defaults_to_m27", () => {
    expect(loadConfig({}).codexProfile).toBe("m27");
  });

  it("codexBaseUrl_defaults_to_minimaxi", () => {
    expect(loadConfig({}).codexBaseUrl).toBe(
      "https://api.minimaxi.com/anthropic",
    );
  });

  it("codexModel_defaults_to_M2_7_highspeed", () => {
    expect(loadConfig({}).codexModel).toBe("MiniMax-M2.7-highspeed");
  });

  it("codexApiKey_chain_falls_back_to_MINIMAX_API_KEY", () => {
    const c = loadConfig({ MINIMAX_API_KEY: "sk-minimax-zzz" });
    expect(c.codexApiKey).toBe("sk-minimax-zzz");
  });

  it("nativeTimeoutMs_defaults_to_300000", () => {
    expect(loadConfig({}).nativeTimeoutMs).toBe(300000);
  });

  it("nativeTimeoutMs_rejects_negative", () => {
    expect(
      loadConfig({ DEV_BRAIN_NATIVE_TIMEOUT_MS: "-1" }).nativeTimeoutMs,
    ).toBe(300000);
  });

  it("nativeTimeoutMs_rejects_above_1h", () => {
    expect(
      loadConfig({
        DEV_BRAIN_NATIVE_TIMEOUT_MS: "99999999",
      }).nativeTimeoutMs,
    ).toBe(300000);
  });

  it("cursorFallback_defaults_to_cc_connect", () => {
    expect(loadConfig({}).cursorFallback).toBe("cc-connect");
  });

  it("cursorFallback_explicit_error_is_honored", () => {
    expect(
      loadConfig({ DEV_BRAIN_CURSOR_FALLBACK: "error" }).cursorFallback,
    ).toBe("error");
  });
});
