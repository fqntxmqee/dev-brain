import { describe, expect, it } from "vitest";
import { createDevBrainApp } from "../../src/bootstrap.js";
import { parseFeishuEventLine } from "../../src/gateway/feishu-gateway.js";
import { InMemoryFeishuReporter } from "../../src/gateway/feishu-reporter.js";

/** Covers: L5-BRAIN-01, L5-BRAIN-02, L5-BRAIN-05 */
describe("Feishu gateway integration", () => {
  it("should_parse_event_and_complete_plan_approve_flow", async () => {
    const eventLine = JSON.stringify({
      event_type: "im.message.receive_v1",
      message: {
        message_id: "om_integration_1",
        chat_id: "oc_integration_chat",
        content: JSON.stringify({ text: "给 trade 模块加日期筛选" }),
      },
      sender: {
        sender_id: { open_id: "ou_integration_user" },
        name: "integration-tester",
      },
    });

    const inbound = parseFeishuEventLine(eventLine);
    expect(inbound).toBeDefined();
    expect(inbound?.text).toContain("日期筛选");

    const reporter = new InMemoryFeishuReporter();
    const original = process.env.DEV_BRAIN_ALLOW_FROM;
    process.env.DEV_BRAIN_ALLOW_FROM = "ou_integration_user";

    try {
      const app = createDevBrainApp(reporter);

      await app.gateway.handleMessage(inbound!);
      expect(reporter.sent[0]?.text).toContain("任务计划");
      expect(reporter.sent[0]?.text).toContain("/approve");

      const approveLine = JSON.stringify({
        event_type: "im.message.receive_v1",
        message: {
          message_id: "om_integration_2",
          chat_id: "oc_integration_chat",
          content: JSON.stringify({ text: "/approve" }),
        },
        sender: {
          sender_id: { open_id: "ou_integration_user" },
          name: "integration-tester",
        },
      });

      const approveMsg = parseFeishuEventLine(approveLine);
      await app.gateway.handleMessage(approveMsg!);

      expect(reporter.sent[1]?.text).toContain("任务完成");
      expect(reporter.sent[1]?.text).toContain("st-1");
      expect(reporter.sent[1]?.text).toContain("st-2");
      expect(reporter.sent[1]?.text).toContain("st-3");
    } finally {
      if (original === undefined) {
        delete process.env.DEV_BRAIN_ALLOW_FROM;
      } else {
        process.env.DEV_BRAIN_ALLOW_FROM = original;
      }
    }
  });

  it("should_deny_sender_not_in_allow_from", async () => {
    const reporter = new InMemoryFeishuReporter();

    const original = process.env.DEV_BRAIN_ALLOW_FROM;
    process.env.DEV_BRAIN_ALLOW_FROM = "ou_allowed_only";

    try {
      const gatedApp = createDevBrainApp(reporter);

      await gatedApp.gateway.handleMessage({
        messageId: "m-deny",
        chatId: "oc_deny",
        senderOpenId: "ou_stranger",
        senderName: "stranger",
        text: "hello",
      });

      expect(reporter.sent.at(-1)?.text).toContain("无权限");
    } finally {
      if (original === undefined) {
        delete process.env.DEV_BRAIN_ALLOW_FROM;
      } else {
        process.env.DEV_BRAIN_ALLOW_FROM = original;
      }
    }
  });

  // Regression: fail-closed default — empty allow list rejects all senders
  it("should_deny_all_when_allow_from_unset", async () => {
    const reporter = new InMemoryFeishuReporter();
    const original = process.env.DEV_BRAIN_ALLOW_FROM;
    delete process.env.DEV_BRAIN_ALLOW_FROM;

    try {
      const app = createDevBrainApp(reporter);
      await app.gateway.handleMessage({
        messageId: "m-closed",
        chatId: "oc_closed",
        senderOpenId: "ou_whoever",
        senderName: "whoever",
        text: "test",
      });
      expect(reporter.sent.at(-1)?.text).toContain("无权限");
    } finally {
      if (original !== undefined) {
        process.env.DEV_BRAIN_ALLOW_FROM = original;
      }
    }
  });

  // Wildcard '*' explicitly opts in to legacy allow-all behavior
  it("should_allow_all_when_wildcard_set", async () => {
    const reporter = new InMemoryFeishuReporter();
    const original = process.env.DEV_BRAIN_ALLOW_FROM;
    process.env.DEV_BRAIN_ALLOW_FROM = "*";

    try {
      const app = createDevBrainApp(reporter);
      await app.gateway.handleMessage({
        messageId: "m-wildcard",
        chatId: "oc_wildcard",
        senderOpenId: "ou_random",
        senderName: "random",
        text: "实现加法",
      });
      expect(reporter.sent.at(-1)?.text).toContain("任务计划");
    } finally {
      if (original === undefined) {
        delete process.env.DEV_BRAIN_ALLOW_FROM;
      } else {
        process.env.DEV_BRAIN_ALLOW_FROM = original;
      }
    }
  });
});
