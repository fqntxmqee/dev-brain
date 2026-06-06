import { describe, expect, it, vi } from "vitest";
import { RetryPolicy } from "../../src/runtime/retry-policy.js";

describe("RetryPolicy (CAP-RT-03)", () => {
  const noSleep = (_ms: number) => Promise.resolve();

  it("returns_success_immediately_on_first_attempt", async () => {
    const policy = new RetryPolicy({
      maxAttempts: 5,
      baseMs: 100,
      sleep: noSleep,
    });
    const result = await policy.execute(async () => "ok", {
      subtaskId: "st-1",
    });
    expect(result.status).toBe("success");
    expect(result.value).toBe("ok");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.waitedMs).toBe(0);
  });

  it("retries_with_exponential_backoff", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    let calls = 0;
    const policy = new RetryPolicy({
      maxAttempts: 5,
      baseMs: 1000,
      sleep,
    });
    const result = await policy.execute(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("flaky");
        return "done";
      },
      { subtaskId: "st-2" },
    );
    expect(result.status).toBe("success");
    expect(calls).toBe(3);
    // attempt 2 等 1s, attempt 3 等 2s
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("stops_at_maxAttempts_on_persistent_failure", async () => {
    const policy = new RetryPolicy({
      maxAttempts: 3,
      baseMs: 10,
      sleep: noSleep,
    });
    const result = await policy.execute(
      async () => {
        throw new Error("always fail");
      },
      { subtaskId: "st-3" },
    );
    expect(result.status).toBe("failed");
    expect(result.attempts).toHaveLength(3);
    expect(result.error?.message).toBe("always fail");
  });

  it("does_not_retry_when_error_marked_non_retryable", async () => {
    const policy = new RetryPolicy({
      maxAttempts: 5,
      baseMs: 10,
      sleep: noSleep,
    });
    const result = await policy.execute(
      async () => {
        const e = new Error("config bad") as Error & { retryable?: boolean };
        e.retryable = false;
        throw e;
      },
      { subtaskId: "st-4" },
    );
    expect(result.status).toBe("failed");
    expect(result.attempts).toHaveLength(1);
  });

  it("does_not_retry_when_signal_aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const policy = new RetryPolicy({
      maxAttempts: 5,
      baseMs: 10,
      sleep: noSleep,
    });
    const result = await policy.execute(async () => "x", {
      subtaskId: "st-5",
      signal: ctrl.signal,
    });
    expect(result.status).toBe("failed");
    expect(result.attempts).toHaveLength(0);
  });

  it("invokes_onRetry_callback_with_attempt_and_wait", async () => {
    const onRetry = vi.fn();
    let calls = 0;
    const policy = new RetryPolicy({
      maxAttempts: 3,
      baseMs: 500,
      sleep: noSleep,
    });
    await policy.execute(
      async () => {
        calls += 1;
        if (calls < 2) throw new Error("once");
        return "ok";
      },
      { subtaskId: "st-6", onRetry },
    );
    expect(onRetry).toHaveBeenCalledWith(2, 500);
  });

  it("executeOrThrow_throws_SubTaskFailedError_on_exhaust", async () => {
    const policy = new RetryPolicy({
      maxAttempts: 2,
      baseMs: 10,
      sleep: noSleep,
    });
    await expect(
      policy.executeOrThrow(
        async () => {
          throw new Error("nope");
        },
        { subtaskId: "st-7" },
      ),
    ).rejects.toMatchObject({
      name: "SubTaskFailedError",
      subtaskId: "st-7",
    });
  });

  it("first_attempt_has_zero_wait", async () => {
    const policy = new RetryPolicy({
      maxAttempts: 5,
      baseMs: 1000,
      sleep: noSleep,
    });
    const result = await policy.execute(async () => 42, { subtaskId: "st-8" });
    expect(result.attempts[0]?.waitedMs).toBe(0);
  });
});
