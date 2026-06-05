import { describe, expect, it } from "vitest";
import {
  buildDefaultSubTasks,
  buildSessionKey,
  formatPlanSummary,
  pickRuntimeForTest,
  shortTaskId,
} from "../../src/brain/task-planner.js";

describe("task-planner", () => {
  // Covers: L5-BRAIN-02
  it("should_build_three_subtasks_by_default", () => {
    const subTasks = buildDefaultSubTasks("实现用户登录");
    expect(subTasks).toHaveLength(3);
    expect(subTasks.map((s) => s.runtime)).toContain("claude-code");
  });

  it("should_include_approve_hint_in_summary", () => {
    const subTasks = buildDefaultSubTasks("fix bug");
    const summary = formatPlanSummary("fix bug", subTasks);
    expect(summary).toContain("/approve");
  });

  // Regression for codex/codex ternary bug: even/odd indices must produce different runtimes
  it("should_alternate_codex_and_cursor_for_code_keyword", () => {
    expect(pickRuntimeForTest("实现 / refactor 一下", 0)).toBe("codex");
    expect(pickRuntimeForTest("实现 / refactor 一下", 1)).toBe("cursor");
    expect(pickRuntimeForTest("实现 / refactor 一下", 2)).toBe("codex");
    expect(pickRuntimeForTest("实现 / refactor 一下", 3)).toBe("cursor");
  });

  it("should_route_explore_keyword_to_claude_code", () => {
    expect(pickRuntimeForTest("分析一下架构", 0)).toBe("claude-code");
    expect(pickRuntimeForTest("分析一下架构", 1)).toBe("claude-code");
  });

  it("should_route_debug_keyword_to_cursor", () => {
    expect(pickRuntimeForTest("fix bug", 0)).toBe("cursor");
  });
});

describe("shortTaskId (CAP-BRAIN-04 / T-49)", () => {
  it("truncates_to_12_chars", () => {
    const full = "1234567890abcdef-1234-5678-9abcdef01234";
    expect(shortTaskId(full)).toBe("1234567890ab");
  });

  it("returns_short_id_unchanged_when_already_short", () => {
    expect(shortTaskId("abc")).toBe("abc");
  });
});

describe("buildSessionKey", () => {
  it("uses_unified_template", () => {
    expect(
      buildSessionKey("1234567890abcdef-1234-5678-9abcdef01234", "st-1"),
    ).toBe("dev-brain:task:1234567890ab:subtask:st-1");
  });
});
