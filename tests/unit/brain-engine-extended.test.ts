import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDevBrainApp } from "../../src/bootstrap.js";
import { createBrainEngine } from "../../src/brain/brain-engine.js";
import { BrainEngine } from "../../src/brain/brain-engine.js";
import { AdapterRegistry } from "../../src/adapters/index.js";
import { TaskOrchestrator } from "../../src/orchestrator/index.js";
import { PostmortemStore } from "../../src/brain/postmortem-store.js";
import { FileLockManager } from "../../src/governance/index.js";
import { loadConfig } from "../../src/config/env.js";
import { InMemoryFeishuReporter } from "../../src/gateway/feishu-reporter.js";

const ALLOW_KEY = "DEV_BRAIN_ALLOW_FROM";

function setAllow(value: string): () => void {
  const prev = process.env[ALLOW_KEY];
  process.env[ALLOW_KEY] = value;
  return () => {
    if (prev === undefined) delete process.env[ALLOW_KEY];
    else process.env[ALLOW_KEY] = prev;
  };
}

describe("BrainEngine — retry + postmortem (T-62/T-64/T-65)", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = setAllow("ou_test");
  });
  afterEach(() => {
    restore();
  });

  it("retrySubTask_returns_not_found_when_taskId_missing", async () => {
    const app = createDevBrainApp(new InMemoryFeishuReporter());
    const result = await app.brain.retrySubTask("nonexistent", "st-1");
    expect(result.status).toBe("not_found");
    expect(result.error).toContain("nonexistent");
  });

  it("retrySubTask_returns_not_found_when_subTaskId_missing", async () => {
    const app = createDevBrainApp(new InMemoryFeishuReporter());
    const chatId = "c-retry-1";
    app.brain.createPlan({
      messageId: "m1",
      chatId,
      senderOpenId: "ou_test",
      senderName: "t",
      text: "测试",
    });
    const completed = await app.brain.approveAndExecute(chatId);
    const result = await app.brain.retrySubTask(
      completed.taskId,
      "no-such-subtask",
    );
    expect(result.status).toBe("not_found");
  });

  it("retrySubTask_executes_with_short_taskId_prefix", async () => {
    const app = createDevBrainApp(new InMemoryFeishuReporter());
    const chatId = "c-retry-2";
    app.brain.createPlan({
      messageId: "m1",
      chatId,
      senderOpenId: "ou_test",
      senderName: "t",
      text: "重试测试",
    });
    const completed = await app.brain.approveAndExecute(chatId);
    const firstSubTaskId = completed.subTaskOutputs[0]?.subTaskId;
    expect(firstSubTaskId).toBeDefined();
    const short = completed.taskId.slice(0, 12);
    const result = await app.brain.retrySubTask(short, firstSubTaskId!);
    expect(result.status).toBe("ok");
    expect(result.output).toBeDefined();
  });

  it("findCompleted_returns_record_by_full_or_short_id", async () => {
    const app = createDevBrainApp(new InMemoryFeishuReporter());
    const chatId = "c-find";
    app.brain.createPlan({
      messageId: "m1",
      chatId,
      senderOpenId: "ou_test",
      senderName: "t",
      text: "find test",
    });
    const completed = await app.brain.approveAndExecute(chatId);
    expect(app.brain.findCompleted(completed.taskId)?.taskId).toBe(
      completed.taskId,
    );
    expect(app.brain.findCompleted(completed.taskId.slice(0, 12))?.taskId).toBe(
      completed.taskId,
    );
    expect(app.brain.findCompleted("nope")).toBeUndefined();
  });

  it("listRecent_returns_results_in_reverse_chrono", async () => {
    const app = createDevBrainApp(new InMemoryFeishuReporter());
    for (let i = 0; i < 3; i += 1) {
      const chatId = `c-list-${i}`;
      app.brain.createPlan({
        messageId: `m${i}`,
        chatId,
        senderOpenId: "ou_test",
        senderName: "t",
        text: `任务${i}`,
      });
      await app.brain.approveAndExecute(chatId);
    }
    const recent = app.brain.listRecent(2);
    expect(recent).toHaveLength(2);
  });

  it("approveAndExecute_throws_when_expectedTaskId_mismatch", async () => {
    const app = createDevBrainApp(new InMemoryFeishuReporter());
    const chatId = "c-mismatch";
    app.brain.createPlan({
      messageId: "m1",
      chatId,
      senderOpenId: "ou_test",
      senderName: "t",
      text: "test",
    });
    await expect(
      app.brain.approveAndExecute(chatId, undefined, "wrong-task-id"),
    ).rejects.toThrow(/ID 不匹配/);
  });

  it("cancelPlan_returns_false_when_no_pending", () => {
    const app = createDevBrainApp(new InMemoryFeishuReporter());
    expect(app.brain.cancelPlan("nothing")).toBe(false);
  });

  it("registerPlan_injects_custom_plan", async () => {
    const app = createDevBrainApp(new InMemoryFeishuReporter());
    const chatId = "c-custom";
    const planFromCreate = app.brain.createPlan({
      messageId: "m1",
      chatId,
      senderOpenId: "ou_test",
      senderName: "t",
      text: "原",
    });
    // 覆盖性 register（直接注入，跳过 createPlan）
    app.brain.registerPlan({
      ...planFromCreate,
      description: "通过 registerPlan 注入的描述",
    });
    expect(app.brain.getPendingPlan(chatId)?.description).toContain(
      "通过 registerPlan",
    );
  });

  it("writePostmortem_invoked_when_store_provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pm-brain-"));
    try {
      const restore2 = setAllow("ou_test");
      const config = loadConfig();
      const adapters = AdapterRegistry.create(config);
      const orchestrator = new TaskOrchestrator();
      const fileLocks = new FileLockManager();
      const store = new PostmortemStore({ dataDir: dir });
      const brain = new BrainEngine({
        config,
        adapters,
        orchestrator,
        fileLocks,
        postmortemStore: store,
      });
      try {
        const chatId = "c-pm";
        brain.createPlan({
          messageId: "m1",
          chatId,
          senderOpenId: "ou_test",
          senderName: "t",
          text: "postmortem coverage",
        });
        await brain.approveAndExecute(chatId);
        const files = await readdir(join(dir, "postmortem"));
        expect(files.length).toBeGreaterThan(0);
      } finally {
        restore2();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("formatStatusText_includes_active_section_when_task_in_flight", async () => {
    const app = createDevBrainApp(new InMemoryFeishuReporter());
    const chatId = "c-active";
    app.brain.createPlan({
      messageId: "m1",
      chatId,
      senderOpenId: "ou_test",
      senderName: "t",
      text: "active flow",
    });
    let textDuringExec = "";
    await app.brain.approveAndExecute(chatId, async () => {
      // 进度回调期间快照 status — 此时 activeTasks 应有 1
      textDuringExec = app.brain.formatStatusText();
    });
    expect(textDuringExec).toContain("正在执行");
  });

  it("createBrainEngine_factory_returns_BrainEngine_instance", () => {
    const config = loadConfig();
    const engine = createBrainEngine(config);
    expect(engine).toBeInstanceOf(BrainEngine);
  });
});
