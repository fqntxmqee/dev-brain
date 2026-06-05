import { describe, expect, it } from "vitest";
import { buildErrorCard } from "../../src/gateway/feishu-cards.js";
import type { BrainTaskResult } from "../../src/core/types.js";

describe("buildErrorCard (T-92 / CAP-GW-05)", () => {
  const baseResult: BrainTaskResult = {
    taskId: "task-fail-1234",
    success: false,
    summary: "❌ 任务失败：子任务 st-1 异常",
    subTaskOutputs: [
      {
        subTaskId: "st-1",
        runtime: "claude-code",
        output: "❌ claude timed out after 300000ms",
      },
      { subTaskId: "st-2", runtime: "codex", output: "✅ ok output" },
      { subTaskId: "st-3", runtime: "cursor", output: "⛔ 文件锁冲突,已跳过" },
    ],
  };

  it("renders_red_header_with_error_title", () => {
    const card = buildErrorCard(baseResult, "需求");
    expect(card.header?.template).toBe("red");
    expect(card.header?.title.content).toContain("失败");
  });

  it("lists_only_failed_subtasks", () => {
    const card = buildErrorCard(baseResult, "需求");
    const failSection = (card.elements[2] as Record<string, unknown>)
      .text as Record<string, unknown>;
    const content = failSection.content as string;
    expect(content).toContain("st-1");
    expect(content).toContain("st-3");
    // 成功的 st-2 不应列在失败列表中
    expect(content).not.toContain("✅ ok output");
  });

  it("falls_back_to_summary_when_no_failed_subtasks", () => {
    const result: BrainTaskResult = {
      ...baseResult,
      subTaskOutputs: [],
    };
    const card = buildErrorCard(result, "需求");
    const failSection = (card.elements[2] as Record<string, unknown>)
      .text as Record<string, unknown>;
    expect(failSection.content as string).toContain("❌ 任务失败");
  });

  it("includes_description_and_short_task_id", () => {
    const card = buildErrorCard(baseResult, "原始需求文本");
    const firstDiv = (card.elements[0] as Record<string, unknown>)
      .text as Record<string, unknown>;
    expect(firstDiv.content as string).toContain("原始需求文本");
    expect(firstDiv.content as string).toContain("task-fail");
  });

  it("includes_retry_hint_note", () => {
    const card = buildErrorCard(baseResult, "需求");
    const hasRetry = JSON.stringify(card).includes("/retry");
    expect(hasRetry).toBe(true);
  });
});
