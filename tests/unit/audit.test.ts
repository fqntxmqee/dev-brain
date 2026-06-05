import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileAuditLogger, InMemoryAuditLogger } from "../../src/core/audit.js";

describe("AuditLogger", () => {
  it("InMemoryAuditLogger records events", () => {
    const logger = new InMemoryAuditLogger();
    logger.emit({
      type: "auth.deny",
      actor: "ou_stranger",
      reason: "not_in_allowlist",
    });
    logger.emit({ type: "plan.create", actor: "ou_alice", chatId: "oc_x" });
    expect(logger.events).toHaveLength(2);
    expect(logger.events[0]?.type).toBe("auth.deny");
  });

  it("FileAuditLogger appends JSONL line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "audit-"));
    const path = join(dir, "audit.log");
    const logger = new FileAuditLogger(
      path,
      () => new Date("2026-06-05T10:00:00Z"),
    );

    await logger.emit({ type: "auth.deny", actor: "ou_stranger" });
    await logger.emit({
      type: "plan.approve",
      actor: "ou_alice",
      taskId: "t1",
    });

    const content = await readFile(path, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const e1 = JSON.parse(lines[0]!);
    const e2 = JSON.parse(lines[1]!);
    expect(e1.time).toBe("2026-06-05T10:00:00.000Z");
    expect(e1.type).toBe("auth.deny");
    expect(e1.actor).toBe("ou_stranger");
    expect(e2.type).toBe("plan.approve");
    expect(e2.taskId).toBe("t1");
  });

  it("FileAuditLogger creates parent directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "audit-"));
    const path = join(dir, "nested", "deep", "audit.log");
    const logger = new FileAuditLogger(path);
    await logger.emit({ type: "shutdown" });
    const content = await readFile(path, "utf8");
    expect(content).toContain("shutdown");
  });
});
