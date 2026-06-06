import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClassifierOrchestrator } from "../../src/intent/classifier.js";
import { FallbackClassifier } from "../../src/intent/fallback-classifier.js";
import { OpenSpecGenerator } from "../../src/openspec/generator.js";
import { OpenSpecWriter } from "../../src/openspec/writer.js";
import { SpecWorkflow } from "../../src/gateway/spec-workflow.js";
import { StubDebateParticipant } from "../../src/gateway/spec-participants.js";
import type { IntentContext } from "../../src/intent/types.js";
import { getMetrics, resetMetrics } from "../../src/observability/metrics.js";

/**
 * E2E: 端到端 spec-workflow 流水线
 * 覆盖: classifier → debate → OpenSpec generate → write to disk
 * 验证产物文件落地,prometheus 指标累加,trace_id 贯通。
 */

const context: IntentContext = {
  chatId: "oc-e2e",
  senderOpenId: "ou-e2e",
};

describe("spec-workflow end-to-end", () => {
  let dir: string;
  let preMetrics: { counter: number; histogram: number };

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "spec-e2e-"));
    // capture metric baselines for "incremented" assertions
    const m = getMetrics();
    preMetrics = {
      counter: m.get("openspec.generated_total"),
      histogram: m.histogram("debate.consensus_score").count(),
    };
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    resetMetrics();
  });

  it("runs_full_pipeline_and_writes_files_to_disk", async () => {
    const classifier = new ClassifierOrchestrator(
      {
        deepseek: { apiKey: "", model: "x", timeoutMs: 1000, maxRetries: 0 },
        cache: { maxEntries: 10, ttlMs: 1000 },
        enableFallback: true,
        fallbackWarnThreshold: 100,
      },
      { fallbackOverride: new FallbackClassifier() },
    );

    const wf = new SpecWorkflow(
      {
        debate: {
          maxRounds: 3,
          roundTimeoutMs: 5000,
          consensusThreshold: 0.85,
          deltaConvergenceThreshold: 2,
          deltaThreshold: 0.05,
        },
      },
      {
        classifier,
        participantA: new StubDebateParticipant({ name: "claude" }),
        participantB: new StubDebateParticipant({ name: "codex" }),
        generator: new OpenSpecGenerator(),
        writer: new OpenSpecWriter({ rootDir: dir }),
        now: () => new Date("2026-06-06T00:00:00.000Z"),
      },
    );

    const out = await wf.run({
      text: "给 trade 模块加日期筛选",
      context,
    });

    // artifact shape
    expect(out.artifact.changeId).toMatch(/^feature-trade-20260606$/);
    expect(out.artifact.demandId).toMatch(/^DM-20260606-/);
    expect(Object.keys(out.artifact.specs)).toEqual(["trade/**"]);

    // on-disk files
    const changeDir = join(dir, out.artifact.changeId);
    const entries = await fs.readdir(changeDir);
    expect(entries).toEqual(
      expect.arrayContaining(["proposal.md", "tasks.md", "specs"]),
    );
    const proposal = await fs.readFile(join(changeDir, "proposal.md"), "utf-8");
    expect(proposal).toContain("## Motivation");
    expect(proposal).toContain("## Scope");
    expect(proposal).toContain("## Risks");
    expect(proposal).toContain("## Acceptance Criteria");
    const tasks = await fs.readFile(join(changeDir, "tasks.md"), "utf-8");
    expect(tasks).toContain("# Implementation Tasks");
    expect(tasks).toContain("pnpm typecheck");

    // metrics incremented
    const m = getMetrics();
    expect(m.get("openspec.generated_total")).toBe(preMetrics.counter + 1);
    expect(m.get("debate.converge_total")).toBeGreaterThan(0);
    expect(m.histogram("debate.consensus_score").count()).toBeGreaterThan(
      preMetrics.histogram,
    );
  });

  it("idempotent_re_writes_with_same_changeId_creates_backup", async () => {
    const classifier = new ClassifierOrchestrator(
      {
        deepseek: { apiKey: "", model: "x", timeoutMs: 1000, maxRetries: 0 },
        cache: { maxEntries: 10, ttlMs: 1000 },
        enableFallback: true,
        fallbackWarnThreshold: 100,
      },
      { fallbackOverride: new FallbackClassifier() },
    );

    const makeWf = () =>
      new SpecWorkflow(
        {
          debate: {
            maxRounds: 3,
            roundTimeoutMs: 5000,
            consensusThreshold: 0.85,
            deltaConvergenceThreshold: 2,
            deltaThreshold: 0.05,
          },
        },
        {
          classifier,
          participantA: new StubDebateParticipant({ name: "claude" }),
          participantB: new StubDebateParticipant({ name: "codex" }),
          writer: new OpenSpecWriter({ rootDir: dir }),
          now: () => new Date("2026-06-06T01:00:00.000Z"),
        },
      );

    const out1 = await makeWf().run({ text: "first", context });
    const out2 = await makeWf().run({ text: "second", context });

    expect(out1.artifact.changeId).toBe(out2.artifact.changeId);
    // First one got backed up
    const entries = await fs.readdir(dir);
    const backups = entries.filter((e) => e.includes(".bak."));
    expect(backups).toHaveLength(1);
  });
});
