import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkHeadlessConfig,
  migrateToHeadless,
  applyHeadlessConfig,
  stripPlatformBlocks,
  escapeTomlStringForTest,
  undoHeadlessConfig,
} from "../../src/cli/migrate-headless.js";

describe("migrate-headless", () => {
  it("should_detect_platforms_section", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dev-brain-"));
    const configPath = join(dir, "config.toml");
    await writeFile(
      configPath,
      `[[projects]]\nname = "workspace-claude"\n\n[projects.platforms]\ntype = "feishu"\n`,
      "utf8",
    );

    const check = await checkHeadlessConfig(configPath);
    expect(check.hasPlatforms).toBe(true);
    expect(check.ok).toBe(false);
  });

  it("should_strip_platforms_and_write_headless", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dev-brain-"));
    const sourcePath = join(dir, "config.toml");
    const outputPath = join(dir, "headless.toml");

    await writeFile(
      sourcePath,
      [
        "[[projects]]",
        'name = "workspace-claude"',
        "",
        "[projects.platforms]",
        'type = "feishu"',
        "",
        "[projects.agent]",
        'type = "claudecode"',
      ].join("\n"),
      "utf8",
    );

    const stripped = stripPlatformBlocks(
      await import("node:fs/promises").then((m) =>
        m.readFile(sourcePath, "utf8"),
      ),
    );
    expect(stripped).not.toContain("[projects.platforms]");
    expect(stripped).toContain("[[projects]]");

    const result = await migrateToHeadless({
      sourcePath,
      outputPath,
      workDir: "/tmp/workspace",
    });
    expect(result.written).toBe(true);
  });

  it("should_apply_headless_in_place_with_backup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dev-brain-apply-"));
    const sourcePath = join(dir, "config.toml");
    await writeFile(
      sourcePath,
      '[[projects]]\nname = "workspace-claude"\n\n[projects.platforms]\ntype = "feishu"\n',
      "utf8",
    );

    const result = await applyHeadlessConfig({
      sourcePath,
      workDir: "/tmp/workspace",
    });
    expect(result.applied).toBe(true);
    expect(result.backupPath).toContain(".bak.");

    const applied = await readFile(sourcePath, "utf8");
    expect(applied).not.toContain("[projects.platforms]");
  });

  // Regression: workDir 含引号/反斜杠/换行不得突破 TOML 字符串
  it("should_escape_quotes_and_newlines_in_work_dir", () => {
    expect(escapeTomlStringForTest("/tmp/normal")).toBe("/tmp/normal");
    expect(escapeTomlStringForTest('/tmp/with"quote')).toBe(
      '/tmp/with\\"quote',
    );
    expect(escapeTomlStringForTest("C:\\path\\to\\dir")).toBe(
      "C:\\\\path\\\\to\\\\dir",
    );
    expect(escapeTomlStringForTest("/tmp/multi\nline")).toBe(
      "/tmp/multi\\nline",
    );
  });
});

describe("undoHeadlessConfig (T-35 / T-73 / T-76)", () => {
  it("restores_from_backup_atomically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dev-brain-undo-"));
    const targetPath = join(dir, "config.toml");
    const backupPath = join(dir, "config.toml.bak.test");
    const original = '[[projects]]\nname = "original"\n';
    const modified = '[[projects]]\nname = "modified"\n';

    await writeFile(targetPath, modified, "utf8");
    await writeFile(backupPath, original, "utf8");

    const result = await undoHeadlessConfig({ backupPath, targetPath });
    expect(result.restored).toBe(true);

    const restored = await readFile(targetPath, "utf8");
    expect(restored).toBe(original);
  });

  it("returns_not_restored_when_backup_missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dev-brain-undo-miss-"));
    const targetPath = join(dir, "config.toml");
    const backupPath = join(dir, "missing.bak");
    await writeFile(targetPath, "abc", "utf8");

    const result = await undoHeadlessConfig({ backupPath, targetPath });
    expect(result.restored).toBe(false);
    expect(result.message).toContain("备份不存在");
  });
});
