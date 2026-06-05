import { describe, expect, it, vi } from "vitest";
import {
  FeishuApiError,
  classifyLarkCliError,
  withTransientRetry,
} from "../../src/gateway/feishu-reporter.js";

describe("classifyLarkCliError (CAP-GW-08 / T-96)", () => {
  it("classifies_99991663_as_AUTH_EXPIRED", () => {
    const err = new Error(
      'lark-cli exited with code 1: {"code": 99991663, "msg": "token expired"}',
    );
    const result = classifyLarkCliError(err);
    expect(result).toBeInstanceOf(FeishuApiError);
    expect(result?.code).toBe("AUTH_EXPIRED");
    expect(result?.feishuCode).toBe(99991663);
  });

  it("classifies_230020_as_RATE_LIMIT", () => {
    const err = new Error(
      'lark-cli exited with code 1: {"code": 230020, "msg": "rate limit"}',
    );
    const result = classifyLarkCliError(err);
    expect(result?.code).toBe("RATE_LIMIT");
    expect(result?.feishuCode).toBe(230020);
  });

  it("classifies_230021_as_RATE_LIMIT", () => {
    const err = new Error("lark-cli exited with code 1: 230021");
    const result = classifyLarkCliError(err);
    expect(result?.code).toBe("RATE_LIMIT");
  });

  it("returns_undefined_for_unknown_codes", () => {
    const err = new Error("lark-cli exited with code 1: 12345");
    expect(classifyLarkCliError(err)).toBeUndefined();
  });

  it("returns_undefined_for_non_api_errors", () => {
    const err = new Error("connection refused");
    expect(classifyLarkCliError(err)).toBeUndefined();
  });

  it("handles_non_error_input", () => {
    expect(classifyLarkCliError("plain string with 99991663")).toBeInstanceOf(
      FeishuApiError,
    );
    expect(classifyLarkCliError(42)).toBeUndefined();
  });
});

describe("withTransientRetry (CAP-GW-08 / T-97)", () => {
  it("returns_immediately_on_success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withTransientRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries_on_RATE_LIMIT_and_eventually_succeeds", async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls < 3) {
        throw new Error('lark-cli exited with code 1: {"code": 230020}');
      }
      return Promise.resolve("ok");
    });
    const result = await withTransientRetry(fn, { baseMs: 5, maxRetries: 3 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does_not_retry_on_AUTH_EXPIRED", async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(
        new Error('lark-cli exited with code 1: {"code": 99991663}'),
      );
    await expect(withTransientRetry(fn)).rejects.toThrow(/99991663/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does_not_retry_on_unknown_errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("connection refused"));
    await expect(withTransientRetry(fn)).rejects.toThrow(/connection/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives_up_after_maxRetries_on_RATE_LIMIT", async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(
        new Error('lark-cli exited with code 1: {"code": 230020}'),
      );
    await expect(
      withTransientRetry(fn, { maxRetries: 2, baseMs: 1 }),
    ).rejects.toThrow(/230020/);
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
