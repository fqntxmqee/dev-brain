import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PostmortemStore } from "../../src/brain/postmortem-store.js";
import type { BrainTaskResult } from "../../src/core/types.js";

describe("PostmortemStore (T-62/T-65)", () => {
  it("writes a redacted JSON file under postmortem/", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pm-test-"));
    try {
      const fixedDate = new Date("2026-06-05T12:34:56.000Z");
      const store = new PostmortemStore({ dataDir: dir, now: () => fixedDate });
      const result: BrainTaskResult = {
        taskId: "abcdef1234567890abcd",
        success: true,
        summary: "done at /Users/secret-user/project",
        subTaskOutputs: [
          {
            subTaskId: "st-1",
            runtime: "claude-code",
            output: "open /home/me/file.txt\ntoken: sk-1234567890abcdef",
          },
        ],
      };
      const file = await store.write(result);
      const content = await readFile(file, "utf8");
      const parsed = JSON.parse(content) as {
        taskId: string;
        shortId: string;
        subTaskOutputs: { output: string }[];
        summary: string;
      };
      expect(parsed.taskId).toBe(result.taskId);
      expect(parsed.shortId).toBe("abcdef123456");
      expect(parsed.subTaskOutputs[0]?.output).toContain("/home/<user>");
      expect(parsed.subTaskOutputs[0]?.output).toContain("[REDACTED");
      expect(parsed.summary).toContain("/Users/<user>");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("read() round-trips a written entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pm-test-"));
    try {
      const store = new PostmortemStore({ dataDir: dir });
      const result: BrainTaskResult = {
        taskId: "0123456789abcdef",
        success: false,
        summary: "failed",
        subTaskOutputs: [
          { subTaskId: "st-x", runtime: "codex", output: "boom" },
        ],
      };
      const file = await store.write(result);
      const back = await store.read(file);
      expect(back?.taskId).toBe("0123456789abcdef");
      expect(back?.success).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("read() returns undefined for missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pm-test-"));
    try {
      const store = new PostmortemStore({ dataDir: dir });
      const back = await store.read("nonexistent");
      expect(back).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
