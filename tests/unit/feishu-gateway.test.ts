import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDevBrainApp } from "../../src/bootstrap.js";
import { InMemoryFeishuReporter } from "../../src/gateway/feishu-reporter.js";
import type { FeishuCardAction } from "../../src/core/types.js";
import { getMetrics } from "../../src/observability/metrics.js";

const ALLOW_KEY = "DEV_BRAIN_ALLOW_FROM";

function setAllow(value: string): () => void {
  const prev = process.env[ALLOW_KEY];
  process.env[ALLOW_KEY] = value;
  return () => {
    if (prev === undefined) delete process.env[ALLOW_KEY];
    else process.env[ALLOW_KEY] = prev;
  };
}

describe("FeishuGateway handleMessage intents (T-66 / CAP-GW)", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = setAllow("ou_test");
  });
  afterEach(() => {
    restore();
  });

  it("rejects_unauthorised_sender_with_block_emoji", async () => {
    const reporter = new InMemoryFeishuReporter();
    const app = createDevBrainApp(reporter);
    await app.gateway.handleMessage({
      messageId: "m1",
      chatId: "c1",
      senderOpenId: "ou_intruder",
      senderName: "intruder",
      text: "hi",
    });
    expect(reporter.sent[0]?.text).toContain("⛔");
  });

  it("rejects_oversized_prompt_with_byte_count", async () => {
    const reporter = new InMemoryFeishuReporter();
    const app = createDevBrainApp(reporter);
    const big = "a".repeat(5000); // > MAX_PROMPT_BYTES (4096)
    await app.gateway.handleMessage({
      messageId: "m1",
      chatId: "c1",
      senderOpenId: "ou_test",
      senderName: "t",
      text: big,
    });
    expect(reporter.sent[0]?.text).toContain("⛔");
    expect(reporter.sent[0]?.text).toContain("字节上限");
  });

  it("dispatches_help_command", async () => {
    const reporter = new InMemoryFeishuReporter();
    const app = createDevBrainApp(reporter);
    await app.gateway.handleMessage({
      messageId: "m1",
      chatId: "c1",
      senderOpenId: "ou_test",
      senderName: "t",
      text: "/help",
    });
    expect(reporter.sent[0]?.text).toContain("Dev Brain 指令");
  });

  it("dispatches_status_command", async () => {
    const reporter = new InMemoryFeishuReporter();
    const app = createDevBrainApp(reporter);
    await app.gateway.handleMessage({
      messageId: "m1",
      chatId: "c1",
      senderOpenId: "ou_test",
      senderName: "t",
      text: "/status",
    });
    expect(reporter.sent[0]?.text).toContain("Dev Brain 状态");
  });

  it("dispatches_cancel_with_no_pending_plan", async () => {
    const reporter = new InMemoryFeishuReporter();
    const app = createDevBrainApp(reporter);
    await app.gateway.handleMessage({
      messageId: "m1",
      chatId: "c1",
      senderOpenId: "ou_test",
      senderName: "t",
      text: "/cancel",
    });
    expect(reporter.sent[0]?.text).toContain("当前没有待审批任务");
  });

  it("dispatches_cancel_with_pending_plan", async () => {
    const reporter = new InMemoryFeishuReporter();
    const app = createDevBrainApp(reporter);
    await app.gateway.handleMessage({
      messageId: "m1",
      chatId: "c1",
      senderOpenId: "ou_test",
      senderName: "t",
      text: "新任务",
    });
    await app.gateway.handleMessage({
      messageId: "m2",
      chatId: "c1",
      senderOpenId: "ou_test",
      senderName: "t",
      text: "/cancel",
    });
    expect(reporter.sent[1]?.text).toContain("已取消");
  });

  it("dispatches_show_with_unimplemented_message", async () => {
    const reporter = new InMemoryFeishuReporter();
    const app = createDevBrainApp(reporter);
    await app.gateway.handleMessage({
      messageId: "m1",
      chatId: "c1",
      senderOpenId: "ou_test",
      senderName: "t",
      text: "/show abc123",
    });
    expect(reporter.sent[0]?.text).toContain("📋");
    expect(reporter.sent[0]?.text).toContain("abc123");
  });

  it("dispatches_retry_with_unimplemented_message", async () => {
    const reporter = new InMemoryFeishuReporter();
    const app = createDevBrainApp(reporter);
    await app.gateway.handleMessage({
      messageId: "m1",
      chatId: "c1",
      senderOpenId: "ou_test",
      senderName: "t",
      text: "/retry abc123",
    });
    expect(reporter.sent[0]?.text).toContain("🔁");
  });

  it("dispatches_list_with_unimplemented_message", async () => {
    const reporter = new InMemoryFeishuReporter();
    const app = createDevBrainApp(reporter);
    await app.gateway.handleMessage({
      messageId: "m1",
      chatId: "c1",
      senderOpenId: "ou_test",
      senderName: "t",
      text: "/list",
    });
    expect(reporter.sent[0]?.text).toContain("📜");
  });

  it("dispatches_unknown_with_command_echo", async () => {
    const reporter = new InMemoryFeishuReporter();
    const app = createDevBrainApp(reporter);
    await app.gateway.handleMessage({
      messageId: "m1",
      chatId: "c1",
      senderOpenId: "ou_test",
      senderName: "t",
      text: "/garbage now",
    });
    expect(reporter.sent[0]?.text).toContain("未知指令");
    expect(reporter.sent[0]?.text).toContain("garbage");
  });

  it("approve_without_plan_throws_with_chinese_message", async () => {
    const reporter = new InMemoryFeishuReporter();
    const app = createDevBrainApp(reporter);
    await expect(
      app.gateway.handleMessage({
        messageId: "m1",
        chatId: "c1",
        senderOpenId: "ou_test",
        senderName: "t",
        text: "/approve",
      }),
    ).rejects.toThrow(/待审批的任务/);
  });
});

describe("FeishuGateway handleCardAction (T-51 / CAP-GW-04)", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = setAllow("ou_test");
  });
  afterEach(() => {
    restore();
  });

  it("rejects_unauthorised_operator", async () => {
    const reporter = new InMemoryFeishuReporter();
    const app = createDevBrainApp(reporter);
    const action: FeishuCardAction = {
      action: "approve",
      taskId: "no-task",
      chatId: "c1",
      operatorOpenId: "ou_intruder",
      operatorName: "evil",
    };
    await app.gateway.handleCardAction(action);
    expect(reporter.sent[0]?.text).toContain("⛔");
  });

  it("returns_no_match_when_no_pending_plan", async () => {
    const reporter = new InMemoryFeishuReporter();
    const app = createDevBrainApp(reporter);
    const action: FeishuCardAction = {
      action: "approve",
      taskId: "missing-task",
      chatId: "c1",
      operatorOpenId: "ou_test",
      operatorName: "tester",
    };
    await app.gateway.handleCardAction(action);
    expect(reporter.sent[0]?.text).toContain("没有匹配的待审批任务");
  });

  it("cancel_action_removes_pending_plan", async () => {
    const reporter = new InMemoryFeishuReporter();
    const app = createDevBrainApp(reporter);
    // Create a plan to cancel
    const plan = app.brain.createPlan({
      messageId: "m1",
      chatId: "c1",
      senderOpenId: "ou_test",
      senderName: "t",
      text: "测试",
    });
    const action: FeishuCardAction = {
      action: "cancel",
      taskId: plan.taskId,
      chatId: "c1",
      operatorOpenId: "ou_test",
      operatorName: "tester",
    };
    await app.gateway.handleCardAction(action);
    expect(reporter.sent[0]?.text).toContain("已取消");
    expect(app.brain.getPendingPlan("c1")).toBeUndefined();
  });

  it("approve_action_runs_plan", async () => {
    const reporter = new InMemoryFeishuReporter();
    const app = createDevBrainApp(reporter);
    const plan = app.brain.createPlan({
      messageId: "m1",
      chatId: "c1",
      senderOpenId: "ou_test",
      senderName: "t",
      text: "执行测试",
    });
    const action: FeishuCardAction = {
      action: "approve",
      taskId: plan.taskId,
      chatId: "c1",
      operatorOpenId: "ou_test",
      operatorName: "tester",
    };
    await app.gateway.handleCardAction(action);
    expect(app.brain.getStatus().completedTasks).toBe(1);
  });
});

describe("FeishuGateway observability (v0.7.0)", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = setAllow("ou_test");
  });
  afterEach(() => {
    restore();
  });

  it("increments_gateway_messages_received_counter", async () => {
    const metrics = getMetrics();
    const before = metrics.get("gateway.messages.received");
    const reporter = new InMemoryFeishuReporter();
    const app = createDevBrainApp(reporter);
    await app.gateway.handleMessage({
      messageId: "m-obs-1",
      chatId: "c-obs",
      senderOpenId: "ou_test",
      senderName: "t",
      text: "/status",
    });
    const after = metrics.get("gateway.messages.received");
    expect(after).toBe(before + 1);
  });

  it("records_gateway_message_duration_histogram", async () => {
    const metrics = getMetrics();
    const before = metrics
      .histogram("gateway.message.duration_seconds")
      .count();
    const reporter = new InMemoryFeishuReporter();
    const app = createDevBrainApp(reporter);
    await app.gateway.handleMessage({
      messageId: "m-obs-2",
      chatId: "c-obs",
      senderOpenId: "ou_test",
      senderName: "t",
      text: "/help",
    });
    const after = metrics.histogram("gateway.message.duration_seconds").count();
    expect(after).toBeGreaterThanOrEqual(before + 1);
  });

  it("increments_oversize_rejection_counter", async () => {
    const metrics = getMetrics();
    const before = metrics.get("gateway.messages.rejected_oversize");
    const reporter = new InMemoryFeishuReporter();
    const app = createDevBrainApp(reporter);
    await app.gateway.handleMessage({
      messageId: "m-obs-3",
      chatId: "c-obs",
      senderOpenId: "ou_test",
      senderName: "t",
      text: "a".repeat(5000),
    });
    const after = metrics.get("gateway.messages.rejected_oversize");
    expect(after).toBe(before + 1);
  });

  it("increments_gateway_card_action_counter", async () => {
    const metrics = getMetrics();
    const before = metrics.get("gateway.card.action");
    const reporter = new InMemoryFeishuReporter();
    const app = createDevBrainApp(reporter);
    const action: FeishuCardAction = {
      action: "approve",
      taskId: "no-task",
      chatId: "c-obs",
      operatorOpenId: "ou_test",
      operatorName: "tester",
    };
    await app.gateway.handleCardAction(action);
    const after = metrics.get("gateway.card.action");
    expect(after).toBe(before + 1);
  });
});
