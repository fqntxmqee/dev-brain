import { describe, expect, it } from "vitest";
import { createDevBrainApp } from "../../src/bootstrap.js";
import { InMemoryFeishuReporter } from "../../src/gateway/feishu-reporter.js";

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
});
