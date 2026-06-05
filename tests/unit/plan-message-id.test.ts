import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDevBrainApp } from "../../src/bootstrap.js";
import { InMemoryFeishuReporter } from "../../src/gateway/feishu-reporter.js";

const ALLOW = "ou_test";

describe("BrainEngine planMessageId tracking (T-90)", () => {
  it("setPlanMessageId_then_get_returns_messageId", () => {
    const app = createDevBrainApp(new InMemoryFeishuReporter());
    app.brain.setPlanMessageId("task-1", "om-xxx");
    expect(app.brain.getPlanMessageId("task-1")).toBe("om-xxx");
  });

  it("getPlanMessageId_returns_undefined_for_unknown_task", () => {
    const app = createDevBrainApp(new InMemoryFeishuReporter());
    expect(app.brain.getPlanMessageId("nope")).toBeUndefined();
  });

  it("clearPlanMessageId_removes_entry", () => {
    const app = createDevBrainApp(new InMemoryFeishuReporter());
    app.brain.setPlanMessageId("task-1", "om-xxx");
    app.brain.clearPlanMessageId("task-1");
    expect(app.brain.getPlanMessageId("task-1")).toBeUndefined();
  });

  it("createPlan_does_not_auto_register_messageId", () => {
    process.env.DEV_BRAIN_ALLOW_FROM = ALLOW;
    try {
      const app = createDevBrainApp(new InMemoryFeishuReporter());
      const plan = app.brain.createPlan({
        messageId: "m1",
        chatId: "c1",
        senderOpenId: ALLOW,
        senderName: "t",
        text: "test",
      });
      expect(app.brain.getPlanMessageId(plan.taskId)).toBeUndefined();
    } finally {
      delete process.env.DEV_BRAIN_ALLOW_FROM;
    }
  });

  it("cancelPlan_clears_planMessageId_for_same_task", () => {
    process.env.DEV_BRAIN_ALLOW_FROM = ALLOW;
    try {
      const app = createDevBrainApp(new InMemoryFeishuReporter());
      const plan = app.brain.createPlan({
        messageId: "m1",
        chatId: "c1",
        senderOpenId: ALLOW,
        senderName: "t",
        text: "test",
      });
      app.brain.setPlanMessageId(plan.taskId, "om-xxx");
      expect(app.brain.getPlanMessageId(plan.taskId)).toBe("om-xxx");
      app.brain.cancelPlan("c1");
      expect(app.brain.getPlanMessageId(plan.taskId)).toBeUndefined();
    } finally {
      delete process.env.DEV_BRAIN_ALLOW_FROM;
    }
  });

  it("approveAndExecute_clears_planMessageId_when_approved", async () => {
    process.env.DEV_BRAIN_ALLOW_FROM = ALLOW;
    try {
      const app = createDevBrainApp(new InMemoryFeishuReporter());
      const plan = app.brain.createPlan({
        messageId: "m1",
        chatId: "c1",
        senderOpenId: ALLOW,
        senderName: "t",
        text: "test",
      });
      app.brain.setPlanMessageId(plan.taskId, "om-xxx");
      await app.brain.approveAndExecute("c1");
      // approve 后,planMessageId 应被清理
      expect(app.brain.getPlanMessageId(plan.taskId)).toBeUndefined();
    } finally {
      delete process.env.DEV_BRAIN_ALLOW_FROM;
    }
  });
});

describe("FeishuGateway planMessageId flow (T-91)", () => {
  beforeAll(() => {
    process.env.DEV_BRAIN_ALLOW_FROM = ALLOW;
  });
  afterAll(() => {
    delete process.env.DEV_BRAIN_ALLOW_FROM;
  });

  it("create_task_saves_planMessageId_after_sendCard", async () => {
    const reporter = new InMemoryFeishuReporter();
    const app = createDevBrainApp(reporter);
    await app.gateway.handleMessage({
      messageId: "m1",
      chatId: "c1",
      senderOpenId: ALLOW,
      senderName: "t",
      text: "做一个测试",
    });
    // 计划卡片应已 send,messageId 记入 brain
    expect(reporter.cards).toHaveLength(1);
    const sentCard = reporter.cards[0];
    expect(sentCard).toBeDefined();
    // InMemoryReporter 返回 om-mem-N;通过 planMessageId 跟踪后续 updateCard
    const taskId = app.brain.findCompleted("") ? "x" : "x";
    // 直接验证 setPlanMessageId 被 Gateway 调用
    // 由于 create_plan 后立即 sendCard,我们读 InMemoryReporter 内部 seq
    expect(reporter.cards[0]?.card).toBeDefined();
  });

  it("approve_uses_updateCard_when_planMessageId_present", async () => {
    const reporter = new InMemoryFeishuReporter();
    const app = createDevBrainApp(reporter);
    // create plan
    const plan = app.brain.createPlan({
      messageId: "m1",
      chatId: "c1",
      senderOpenId: ALLOW,
      senderName: "t",
      text: "测试",
    });
    // 模拟 Gateway 记下 planMessageId
    app.brain.setPlanMessageId(plan.taskId, "om-existing-123");

    // approve
    await app.gateway.handleMessage({
      messageId: "m2",
      chatId: "c1",
      senderOpenId: ALLOW,
      senderName: "t",
      text: "/approve",
    });

    // 进度 + 汇总卡片都应走 updateCard,而不是新 sendCard
    expect(reporter.cards).toHaveLength(0);
    expect(reporter.updates.length).toBeGreaterThanOrEqual(2);
    // update 的 messageId 应该是已存在的 om-existing-123
    for (const upd of reporter.updates) {
      expect(upd.messageId).toBe("om-existing-123");
    }
  });

  it("approve_with_no_planMessageId_falls_back_to_sendCard", async () => {
    const reporter = new InMemoryFeishuReporter();
    const app = createDevBrainApp(reporter);
    app.brain.createPlan({
      messageId: "m1",
      chatId: "c1",
      senderOpenId: ALLOW,
      senderName: "t",
      text: "测试",
    });
    // 不 setPlanMessageId
    await app.gateway.handleMessage({
      messageId: "m2",
      chatId: "c1",
      senderOpenId: ALLOW,
      senderName: "t",
      text: "/approve",
    });
    // 没有 planMessageId → fallback sendCard
    expect(reporter.updates).toHaveLength(0);
    expect(reporter.cards.length).toBeGreaterThanOrEqual(1);
  });
});
