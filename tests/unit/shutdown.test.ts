import { describe, expect, it, vi } from "vitest";
import { GracefulShutdown } from "../../src/core/shutdown.js";

describe("GracefulShutdown", () => {
  it("runs_registered_tasks_in_order", async () => {
    const calls: string[] = [];
    const shutdown = new GracefulShutdown({
      timeoutMs: 5000,
      logger: () => undefined,
    });
    shutdown.register("a", () => {
      calls.push("a");
    });
    shutdown.register("b", () => {
      calls.push("b");
    });

    // stub process.exit
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    try {
      await shutdown.run("SIGTERM");
      expect(calls).toEqual(["a", "b"]);
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("continues_after_task_failure", async () => {
    const calls: string[] = [];
    const shutdown = new GracefulShutdown({
      timeoutMs: 5000,
      logger: () => undefined,
    });
    shutdown.register("fail", () => {
      calls.push("fail-start");
      throw new Error("boom");
    });
    shutdown.register("ok", () => {
      calls.push("ok");
    });

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    try {
      await shutdown.run("SIGINT");
      expect(calls).toEqual(["fail-start", "ok"]);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("is_idempotent", async () => {
    const shutdown = new GracefulShutdown({
      timeoutMs: 5000,
      logger: () => undefined,
    });
    let count = 0;
    shutdown.register("t", () => {
      count += 1;
    });

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    try {
      await shutdown.run("SIGTERM");
      await shutdown.run("SIGTERM");
      expect(count).toBe(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("awaits_async_tasks", async () => {
    const order: string[] = [];
    const shutdown = new GracefulShutdown({
      timeoutMs: 5000,
      logger: () => undefined,
    });
    shutdown.register("async", async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("async");
    });
    shutdown.register("sync", () => {
      order.push("sync");
    });

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    try {
      await shutdown.run("SIGTERM");
      expect(order).toContain("async");
      expect(order).toContain("sync");
    } finally {
      exitSpy.mockRestore();
    }
  });
});
