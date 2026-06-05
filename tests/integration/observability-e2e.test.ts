import { describe, expect, it } from "vitest";
import { createDevBrainApp } from "../../src/bootstrap.js";
import { InMemoryFeishuReporter } from "../../src/gateway/feishu-reporter.js";
import { getMetrics } from "../../src/observability/metrics.js";
import type { FeishuCardAction } from "../../src/core/types.js";

/**
 * v0.7.0 end-to-end observability check.
 *
 * Exercises the full plan lifecycle (createPlan → approve → execute) and
 * verifies that production metrics increment in the right order. This is
 * the "real" e2e counterpart to the unit-level metric assertions: the unit
 * tests verify individual counters move on each call site, while this test
 * verifies the wiring is correct end-to-end through the real public API.
 */
describe("observability e2e: plan lifecycle metrics (v0.7.0)", () => {
  it("emits_correct_metrics_for_inbound_to_approve_to_execute", async () => {
    const reporter = new InMemoryFeishuReporter();
    const app = createDevBrainApp(reporter, {
      envOverrides: { DEV_BRAIN_ALLOW_FROM: "ou_test" },
    });
    const m = getMetrics();

    // baseline
    const base = {
      pending: m.gauge("brain.pending_plans").get(),
      received: m.get("gateway.messages.received"),
      card: m.get("gateway.card.action"),
      completed: m.get("brain.tasks.completed"),
      taskHist: m.histogram("brain.task.duration_seconds").count(),
    };

    // 1) inbound message
    await app.gateway.handleMessage({
      messageId: "m-e2e-1",
      chatId: "c-e2e",
      senderOpenId: "ou_test",
      senderName: "alice",
      text: "你好，请帮我跑一个端到端测试",
    });
    expect(m.get("gateway.messages.received")).toBe(base.received + 1);
    expect(m.gauge("brain.pending_plans").get()).toBe(base.pending + 1);

    // 2) approve
    const plan = app.brain.getPendingPlan("c-e2e");
    expect(plan).toBeDefined();
    if (!plan) return;
    const action: FeishuCardAction = {
      action: "approve",
      taskId: plan.taskId,
      chatId: "c-e2e",
      operatorOpenId: "ou_test",
      operatorName: "alice",
    };
    await app.gateway.handleCardAction(action);
    expect(m.get("gateway.card.action")).toBe(base.card + 1);

    // approve synchronously clears the pending plan
    expect(m.gauge("brain.pending_plans").get()).toBe(base.pending);

    // 3) wait for execute to complete (or time out at 8s)
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (m.get("brain.tasks.completed") > base.completed) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(m.get("brain.tasks.completed")).toBe(base.completed + 1);
    expect(m.histogram("brain.task.duration_seconds").count()).toBeGreaterThan(
      base.taskHist,
    );
  });

  it("decrements_pending_plans_gauge_on_cancel", async () => {
    const reporter = new InMemoryFeishuReporter();
    const app = createDevBrainApp(reporter, {
      envOverrides: { DEV_BRAIN_ALLOW_FROM: "ou_test" },
    });
    const m = getMetrics();

    await app.gateway.handleMessage({
      messageId: "m-e2e-cancel",
      chatId: "c-e2e-cancel",
      senderOpenId: "ou_test",
      senderName: "alice",
      text: "再开一个",
    });
    const before = m.gauge("brain.pending_plans").get();
    expect(before).toBeGreaterThan(0);
    const cancelled = app.brain.cancelPlan("c-e2e-cancel");
    expect(cancelled).toBe(true);
    expect(m.gauge("brain.pending_plans").get()).toBe(before - 1);
  });
});
