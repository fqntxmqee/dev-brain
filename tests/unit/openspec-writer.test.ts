import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpenSpecGenerator } from "../../src/openspec/generator.js";
import { OpenSpecWriter } from "../../src/openspec/writer.js";
import type { Consensus } from "../../src/debate/types.js";
import type { Intent } from "../../src/intent/types.js";

const fakeIntent = (overrides: Partial<Intent> = {}): Intent => ({
  type: "feature",
  entities: ["trade"],
  affected_modules: ["trade"],
  urgency: "normal",
  intent_score: 0.9,
  trace_id: "trace-w1",
  source: "fallback-haiku",
  ...overrides,
});

const fakeConsensus = (overrides: Partial<Consensus> = {}): Consensus => ({
  merged_understanding: "用户要在 trade 加日期筛选",
  merged_assumptions: ["支持区间 (共识)"],
  merged_risks: ["可能影响分页"],
  merged_missing_info: ["粒度?"],
  consensus_rate: 0.9,
  rounds: 2,
  disagreement_notes: [],
  ...overrides,
});

describe("OpenSpecWriter", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "openspec-writer-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes_proposal_tasks_and_specs", async () => {
    const gen = new OpenSpecGenerator();
    const artifact = gen.generate({
      intent: fakeIntent(),
      consensus: fakeConsensus(),
      demandId: "DM-20260315-001",
      originalText: "test",
    });
    const writer = new OpenSpecWriter({ rootDir: dir });
    const result = await writer.write(artifact);

    expect(result.changeId).toBe(artifact.changeId);
    expect(result.rootPath).toBe(join(dir, artifact.changeId));
    expect(result.files).toEqual(
      expect.arrayContaining([
        "proposal.md",
        "tasks.md",
        "specs/trade/spec.md",
      ]),
    );

    const proposal = await fs.readFile(
      join(dir, artifact.changeId, "proposal.md"),
      "utf-8",
    );
    expect(proposal).toContain("# ");
    expect(proposal).toContain("## Motivation");
  });

  it("backs_up_existing_change_before_overwrite", async () => {
    const gen = new OpenSpecGenerator();
    const writer = new OpenSpecWriter({ rootDir: dir });
    const a1 = gen.generate({
      intent: fakeIntent(),
      consensus: fakeConsensus(),
      demandId: "DM-1",
      originalText: "first",
    });
    const a2 = gen.generate({
      intent: fakeIntent(),
      consensus: fakeConsensus(),
      demandId: "DM-2",
      originalText: "second",
    });
    expect(a1.changeId).toBe(a2.changeId); // same date+module

    await writer.write(a1);
    await writer.write(a2);

    const entries = await fs.readdir(dir);
    // 一份 backup,一份主 change
    const backups = entries.filter((e) => e.includes(".bak."));
    const mains = entries.filter(
      (e) => !e.includes(".bak.") && !e.includes(".tmp."),
    );
    expect(backups).toHaveLength(1);
    expect(mains).toHaveLength(1);
  });

  it("creates_one_spec_file_per_module", async () => {
    const gen = new OpenSpecGenerator();
    const artifact = gen.generate({
      intent: fakeIntent({ affected_modules: ["trade", "ui", "billing"] }),
      consensus: fakeConsensus(),
      demandId: "DM-multi",
      originalText: "multi-module",
    });
    const writer = new OpenSpecWriter({ rootDir: dir });
    const result = await writer.write(artifact);
    expect(result.files.filter((f) => f.endsWith("spec.md"))).toHaveLength(3);
  });

  it("falls_back_to_general_when_no_modules", async () => {
    const gen = new OpenSpecGenerator();
    const artifact = gen.generate({
      intent: fakeIntent({ affected_modules: [] }),
      consensus: fakeConsensus(),
      demandId: "DM-gen",
      originalText: "no-modules",
    });
    const writer = new OpenSpecWriter({ rootDir: dir });
    const result = await writer.write(artifact);
    expect(result.files).toContain("specs/general/spec.md");
  });
});
