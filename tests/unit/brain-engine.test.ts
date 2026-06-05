import { describe, expect, it } from "vitest";
import { createDevBrainApp } from "../../src/bootstrap.js";
import { InMemoryFeishuReporter } from "../../src/gateway/feishu-reporter.js";
import { getMetrics } from "../../src/observability/metrics.js";

/** Covers: L5-BRAIN-01, L5-BRAIN-02, L5-BRAIN-05 */
describe("BrainEngine via gateway", () => {
  it("should_plan_and_execute_local_flow", async () => {
    const reporter = new InMemoryFeishuReporter();
    const original = process.env.DEV_BRAIN_ALLOW_FROM;
    process.env.DEV_BRAIN_ALLOW_FROM = "ou_test";
    const app = createDevBrainApp(reporter);
    const chatId = "test-chat";

    try {
      await app.gateway.handleMessage({
        messageId: "1",
        chatId,
        senderOpenId: "ou_test",
        senderName: "tester",
        text: "探索 dev-brain 模块结构",
      });

      expect(reporter.sent).toHaveLength(1);
      expect(reporter.sent[0]?.text).toContain("任务计划");

      await app.gateway.handleMessage({
        messageId: "2",
        chatId,
        senderOpenId: "ou_test",
        senderName: "tester",
        text: "/approve",
      });

      expect(reporter.sent).toHaveLength(2);
      expect(reporter.sent[1]?.text).toContain("任务完成");
      expect(app.brain.getStatus().completedTasks).toBe(1);
    } finally {
      if (original === undefined) {
        delete process.env.DEV_BRAIN_ALLOW_FROM;
      } else {
        process.env.DEV_BRAIN_ALLOW_FROM = original;
      }
    }
  });

  it("T-50: getActiveProgress empty when no task in flight", () => {
    const reporter = new InMemoryFeishuReporter();
    process.env.DEV_BRAIN_ALLOW_FROM = "ou_test";
    try {
      const app = createDevBrainApp(reporter);
      expect(app.brain.getActiveProgress()).toEqual([]);
      const text = app.brain.formatStatusText();
      expect(text).toContain("Dev Brain 状态");
      expect(text).not.toContain("— 正在执行 —");
    } finally {
      delete process.env.DEV_BRAIN_ALLOW_FROM;
    }
  });

  it("T-61: overwrite counter increments on duplicate createPlan", () => {
    const reporter = new InMemoryFeishuReporter();
    process.env.DEV_BRAIN_ALLOW_FROM = "ou_test";
    try {
      const app = createDevBrainApp(reporter);
      const chatId = "test-overwrite";
      expect(app.brain.getOverwriteCount()).toBe(0);
      // 直接通过 brain API 触发（不依赖 gateway）
      app.brain.createPlan({
        messageId: "a",
        chatId,
        senderOpenId: "ou_test",
        senderName: "t",
        text: "first",
      });
      expect(app.brain.getOverwriteCount()).toBe(0);
      app.brain.createPlan({
        messageId: "b",
        chatId,
        senderOpenId: "ou_test",
        senderName: "t",
        text: "second",
      });
      expect(app.brain.getOverwriteCount()).toBe(1);
    } finally {
      delete process.env.DEV_BRAIN_ALLOW_FROM;
    }
  });
});

/** v0.7.0: brain engine observability hooks */
describe("BrainEngine observability (v0.7.0)", () => {
  it("increments_brain_tasks_completed_after_successful_approval", async () => {
    const metrics = getMetrics();
    const before = metrics.get("brain.tasks.completed");
    const reporter = new InMemoryFeishuReporter();
    process.env.DEV_BRAIN_ALLOW_FROM = "ou_test";
    try {
      const app = createDevBrainApp(reporter);
      const chatId = "obs-chat";
      await app.gateway.handleMessage({
        messageId: "obs-1",
        chatId,
        senderOpenId: "ou_test",
        senderName: "t",
        text: "run something",
      });
      await app.gateway.handleMessage({
        messageId: "obs-2",
        chatId,
        senderOpenId: "ou_test",
        senderName: "t",
        text: "/approve",
      });
      const after = metrics.get("brain.tasks.completed");
      expect(after).toBeGreaterThanOrEqual(before + 1);
    } finally {
      delete process.env.DEV_BRAIN_ALLOW_FROM;
    }
  });

  it("records_brain_task_duration_histogram_after_execution", async () => {
    const metrics = getMetrics();
    const before = metrics.histogram("brain.task.duration_seconds").count();
    const reporter = new InMemoryFeishuReporter();
    process.env.DEV_BRAIN_ALLOW_FROM = "ou_test";
    try {
      const app = createDevBrainApp(reporter);
      const chatId = "obs-dur-chat";
      await app.gateway.handleMessage({
        messageId: "obs-dur-1",
        chatId,
        senderOpenId: "ou_test",
        senderName: "t",
        text: "task duration test",
      });
      await app.gateway.handleMessage({
        messageId: "obs-dur-2",
        chatId,
        senderOpenId: "ou_test",
        senderName: "t",
        text: "/approve",
      });
      const after = metrics.histogram("brain.task.duration_seconds").count();
      expect(after).toBeGreaterThanOrEqual(before + 1);
    } finally {
      delete process.env.DEV_BRAIN_ALLOW_FROM;
    }
  });

  it("tracks_brain_pending_plans_gauge_through_lifecycle", () => {
    const metrics = getMetrics();
    const reporter = new InMemoryFeishuReporter();
    process.env.DEV_BRAIN_ALLOW_FROM = "ou_test";
    try {
      const app = createDevBrainApp(reporter);
      const chatId = "obs-gauge-chat";
      const before = metrics.gauge("brain.pending_plans").get();
      app.brain.createPlan({
        messageId: "g1",
        chatId,
        senderOpenId: "ou_test",
        senderName: "t",
        text: "gauge test",
      });
      const afterCreate = metrics.gauge("brain.pending_plans").get();
      expect(afterCreate).toBeGreaterThanOrEqual(before + 1);
      app.brain.cancelPlan(chatId);
      const afterCancel = metrics.gauge("brain.pending_plans").get();
      expect(afterCancel).toBe(afterCreate - 1);
    } finally {
      delete process.env.DEV_BRAIN_ALLOW_FROM;
    }
  });
});
