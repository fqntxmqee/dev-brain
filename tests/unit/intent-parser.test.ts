import { describe, expect, it } from "vitest";
import { parseIntent } from "../../src/gateway/intent-parser.js";

describe("parseIntent", () => {
  it("should_parse_help_command", () => {
    expect(parseIntent("/help").type).toBe("help");
  });

  it("should_parse_approve_command", () => {
    expect(parseIntent("/approve").type).toBe("approve");
  });

  it("should_treat_natural_language_as_create_task", () => {
    const intent = parseIntent("给 trade 模块加日期筛选");
    expect(intent.type).toBe("create_task");
  });
});

describe("parseIntent mention + extended commands (CAP-GW-03 / T-51)", () => {
  it("strips_mention_prefix_then_parses_approve", () => {
    expect(parseIntent("@bot /approve").type).toBe("approve");
  });

  it("lowercases_command", () => {
    expect(parseIntent("/APPROVE").type).toBe("approve");
  });

  it("parses_approve_with_taskId", () => {
    const i = parseIntent("/approve abc123def456");
    expect(i.type).toBe("approve");
    expect(i.arg).toBe("abc123def456");
  });

  it("parses_show_with_subtask_flag", () => {
    const i = parseIntent("/show abc123 --subtask st-1");
    expect(i.type).toBe("show");
    expect(i.arg).toBe("abc123");
    expect(i.subTaskArg).toBe("st-1");
  });

  it("parses_retry_command", () => {
    const i = parseIntent("/retry abc123def456");
    expect(i.type).toBe("retry");
    expect(i.arg).toBe("abc123def456");
  });

  it("parses_list_command", () => {
    expect(parseIntent("/list").type).toBe("list");
  });

  it("parses_status_command", () => {
    expect(parseIntent("/status").type).toBe("status");
  });

  it("parses_cancel_with_optional_taskId", () => {
    expect(parseIntent("/cancel").type).toBe("cancel");
    const i = parseIntent("/cancel abc123def456");
    expect(i.type).toBe("cancel");
    expect(i.arg).toBe("abc123def456");
  });

  it("returns_unknown_for_unknown_slash_command", () => {
    const i = parseIntent("/foo bar");
    expect(i.type).toBe("unknown");
    expect(i.unknownCommand).toBe("foo");
  });

  it("returns_unknown_for_empty_after_mention", () => {
    const i = parseIntent("@bot   ");
    expect(i.type).toBe("unknown");
  });

  it("non_slash_text_falls_to_create_task", () => {
    expect(parseIntent("实现用户登录").type).toBe("create_task");
  });
});
