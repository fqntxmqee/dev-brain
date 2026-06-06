import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InjectRules } from "../../src/agent/inject-rules.js";

/** helper: 在 dir 下创建 .md 文件,内容为 content */
const writeMd = async (path: string, content: string): Promise<void> => {
  await fs.mkdir(join(path, ".."), { recursive: true });
  await fs.writeFile(path, content, "utf-8");
};

describe("InjectRules (CAP-INS-01 / Phase B.1)", () => {
  let home: string;
  let work: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(join(tmpdir(), "rules-home-"));
    work = await fs.mkdtemp(join(tmpdir(), "rules-work-"));
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(work, { recursive: true, force: true });
  });

  it("returns_empty_when_no_rules_exist", async () => {
    const inj = new InjectRules({
      workDir: work,
      homeDir: home,
    });
    const r = await inj.inject();
    expect(r.appliedRules).toEqual([]);
    expect(r.content).toBe("");
    expect(r.truncated).toBe(false);
  });

  it("injects_global_CLAUDE_md", async () => {
    await writeMd(join(home, ".claude", "CLAUDE.md"), "# global\nbe concise.");
    const r = await new InjectRules({ workDir: work, homeDir: home }).inject();
    expect(r.appliedRules).toHaveLength(1);
    expect(r.appliedRules[0]?.relPath).toBe("~/.claude/CLAUDE.md");
    expect(r.content).toContain("be concise");
  });

  it("injects_global_rules_recursively_alphabetical", async () => {
    await writeMd(
      join(home, ".claude", "rules", "common", "style.md"),
      "rule-style",
    );
    await writeMd(
      join(home, ".claude", "rules", "common", "test.md"),
      "rule-test",
    );
    await writeMd(
      join(home, ".claude", "rules", "ts", "hooks.md"),
      "rule-ts-hooks",
    );

    const r = await new InjectRules({ workDir: work, homeDir: home }).inject();
    const relPaths = r.appliedRules.map((x) => x.relPath);
    expect(relPaths).toEqual([
      "common/style.md",
      "common/test.md",
      "ts/hooks.md",
    ]);
  });

  it("injects_project_CLAUDE_md_after_global", async () => {
    await writeMd(join(home, ".claude", "CLAUDE.md"), "global-first");
    await writeMd(join(work, "CLAUDE.md"), "project-second");

    const r = await new InjectRules({ workDir: work, homeDir: home }).inject();
    const idx = (s: string) => r.content.indexOf(s);
    expect(idx("global-first")).toBeGreaterThanOrEqual(0);
    expect(idx("project-second")).toBeGreaterThan(idx("global-first"));
  });

  it("injects_project_rules_after_global", async () => {
    await writeMd(join(home, ".claude", "rules", "common", "a.md"), "global-a");
    await writeMd(join(work, ".claude", "rules", "z.md"), "project-z");
    const r = await new InjectRules({ workDir: work, homeDir: home }).inject();
    expect(r.appliedRules.map((x) => x.relPath)).toEqual([
      "common/a.md",
      "z.md",
    ]);
  });

  it("truncates_when_token_budget_exceeded", async () => {
    // 制造大内容:每个 rule ~4000 tokens
    const big = "x".repeat(16_000);
    await writeMd(join(home, ".claude", "CLAUDE.md"), big);
    await writeMd(join(home, ".claude", "rules", "common", "a.md"), big);
    const r = await new InjectRules({
      workDir: work,
      homeDir: home,
      tokenBudget: 5_000,
    }).inject();
    expect(r.truncated).toBe(true);
    expect(r.appliedRules).toHaveLength(1); // 只有 CLAUDE.md 装得下
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]?.relPath).toBe("common/a.md");
  });

  it("skips_unreadable_files_silently", async () => {
    // home 不存在 → 静默
    const r = await new InjectRules({
      workDir: work,
      homeDir: "/nonexistent/xxx/yyy",
    }).inject();
    expect(r.appliedRules).toEqual([]);
  });

  it("caches_until_mtime_changes", async () => {
    const path = join(home, ".claude", "CLAUDE.md");
    await writeMd(path, "v1");
    const inj = new InjectRules({ workDir: work, homeDir: home });
    const r1 = await inj.inject();
    expect(r1.content).toContain("v1");

    // 改内容 + 显式改 mtime(macOS 上 mtime 精度可能 1s,等 20ms 不够)
    const future = new Date(Date.now() + 5_000);
    await fs.writeFile(path, "v2", "utf-8");
    await fs.utimes(path, future, future);
    const r2 = await inj.inject();
    expect(r2.content).toContain("v2");
    expect(r1).not.toBe(r2);
  });

  it("force_reload_bypasses_cache", async () => {
    const path = join(home, ".claude", "CLAUDE.md");
    // 锁死 mtime:两次写都 utimes 到同一时间点,确保缓存命中
    const sameMtime = new Date("2026-06-06T00:00:00.000Z");
    await writeMd(path, "v1");
    await fs.utimes(path, sameMtime, sameMtime);
    const inj = new InjectRules({ workDir: work, homeDir: home });
    await inj.inject();

    await fs.writeFile(path, "v2", "utf-8");
    await fs.utimes(path, sameMtime, sameMtime);
    const r2 = await inj.inject();
    // mtime 相同 → 缓存命中,内容仍是 v1
    expect(r2.content).toContain("v1");

    const r3 = await inj.inject({ force: true });
    expect(r3.content).toContain("v2");
  });

  it("invalidate_clears_cache", async () => {
    const path = join(home, ".claude", "CLAUDE.md");
    await writeMd(path, "v1");
    const inj = new InjectRules({ workDir: work, homeDir: home });
    await inj.inject();
    await writeMd(path, "v2");
    inj.invalidate();
    const r = await inj.inject();
    expect(r.content).toContain("v2");
  });

  it("content_wraps_each_rule_in_rule_tag", async () => {
    await writeMd(join(home, ".claude", "rules", "common", "x.md"), "x-body");
    const r = await new InjectRules({ workDir: work, homeDir: home }).inject();
    expect(r.content).toContain('<rule source="common/x.md">');
    expect(r.content).toContain("x-body");
    expect(r.content).toContain("</rule>");
  });

  it("estimates_tokens_via_chars_over_4", async () => {
    await writeMd(join(home, ".claude", "CLAUDE.md"), "a".repeat(400));
    const r = await new InjectRules({ workDir: work, homeDir: home }).inject();
    expect(r.appliedRules[0]?.estTokens).toBe(100);
    expect(r.totalTokens).toBe(100);
  });

  it("appends_extra_sources_after_regular_sources", async () => {
    await writeMd(join(home, ".claude", "CLAUDE.md"), "global-body");
    const inj = new InjectRules({
      workDir: work,
      homeDir: home,
      extraSources: async () => [
        { relPath: "feedback/fb-1", content: "use 2 spaces" },
      ],
    });
    const r = await inj.inject();
    expect(r.appliedRules.map((x) => x.relPath)).toEqual([
      "~/.claude/CLAUDE.md",
      "feedback/fb-1",
    ]);
    expect(r.content).toContain("use 2 spaces");
  });

  it("skips_extra_sources_when_provider_throws", async () => {
    await writeMd(join(home, ".claude", "CLAUDE.md"), "global-body");
    const inj = new InjectRules({
      workDir: work,
      homeDir: home,
      extraSources: async () => {
        throw new Error("boom");
      },
    });
    const r = await inj.inject();
    expect(r.appliedRules).toHaveLength(1);
  });
});
