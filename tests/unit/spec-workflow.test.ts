import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpecWorkflow } from "../../src/gateway/spec-workflow.js";
import type {
  ClarifyLoopConfig,
  CrossCritique,
  DebateParticipant,
  IndependentAnalysis,
} from "../../src/debate/types.js";
import type { Intent, IntentContext } from "../../src/intent/types.js";
import { OpenSpecGenerator } from "../../src/openspec/generator.js";
import { OpenSpecWriter } from "../../src/openspec/writer.js";

const baseIntent = (overrides: Partial<Intent> = {}): Intent => ({
  type: "feature",
  entities: ["trade"],
  affected_modules: ["trade"],
  urgency: "normal",
  intent_score: 0.9,
  trace_id: "test-trace",
  source: "fallback-haiku",
  ...overrides,
});

const baseAnalysis = (
  overrides: Partial<IndependentAnalysis> = {},
): IndependentAnalysis => ({
  understanding: "用户要加日期筛选",
  assumptions: ["支持区间 (共识)"],
  risks: ["影响分页"],
  missing_info: ["粒度?"],
  evidence: ["原文"],
  ...overrides,
});

const baseCritique = (
  overrides: Partial<CrossCritique> = {},
): CrossCritique => ({
  accepted: [{ key: "支持区间", reason: "已包含" }],
  rejected: [],
  added: { assumptions: [], risks: [], missing_info: [] },
  concession_score: 0.5,
  ...overrides,
});

const baseConfig: ClarifyLoopConfig = {
  maxRounds: 3,
  roundTimeoutMs: 5000,
  consensusThreshold: 0.85,
  deltaConvergenceThreshold: 2,
  deltaThreshold: 0.05,
};

const baseContext: IntentContext = {
  chatId: "oc-test",
  senderOpenId: "ou-test",
};

const makeParticipant = (
  name: string,
  a: IndependentAnalysis,
  c: CrossCritique,
): DebateParticipant => ({
  name,
  analyze: vi.fn(async () => a),
  critique: vi.fn(async () => c),
});

describe("SpecWorkflow", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "spec-wf-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("runs_classify_debate_generate_write", async () => {
    const classifier = {
      name: "mock-classifier",
      classify: vi.fn(async () => baseIntent()),
    };
    const participantA = makeParticipant(
      "claude",
      baseAnalysis(),
      baseCritique(),
    );
    const participantB = makeParticipant(
      "codex",
      baseAnalysis(),
      baseCritique(),
    );
    const writer = new OpenSpecWriter({ rootDir: dir });

    const wf = new SpecWorkflow(
      { debate: baseConfig },
      {
        classifier,
        participantA,
        participantB,
        generator: new OpenSpecGenerator(),
        writer,
        now: () => new Date("2026-03-15T10:00:00.000Z"),
      },
    );

    const out = await wf.run({
      text: "给 trade 加日期筛选",
      context: baseContext,
    });
    expect(out.traceId).toMatch(/^tr-/);
    expect(out.demandId).toMatch(/^DM-20260315-/);
    expect(out.artifact.changeId).toMatch(/^feature-trade-20260315$/);
    expect(out.writeResult.files.length).toBeGreaterThan(0);
    expect(out.rounds).toBe(1); // R1 直接共识
    expect(classifier.classify).toHaveBeenCalledWith(
      "给 trade 加日期筛选",
      baseContext,
    );
  });

  it("returns_empty_files_when_no_writer_injected", async () => {
    const classifier = {
      name: "mock",
      classify: vi.fn(async () => baseIntent()),
    };
    const pA = makeParticipant("a", baseAnalysis(), baseCritique());
    const pB = makeParticipant("b", baseAnalysis(), baseCritique());

    const wf = new SpecWorkflow(
      { debate: baseConfig },
      {
        classifier,
        participantA: pA,
        participantB: pB,
        now: () => new Date("2026-04-01T00:00:00.000Z"),
      },
    );

    const out = await wf.run({ text: "test", context: baseContext });
    expect(out.writeResult.files).toHaveLength(0);
    expect(out.writeResult.rootPath).toBe("");
  });

  it("wraps_classify_error_in_SpecWorkflowError_stage_classify", async () => {
    const classifier = {
      name: "fail",
      classify: vi.fn(async () => {
        throw new Error("deepseek down");
      }),
    };
    const pA = makeParticipant("a", baseAnalysis(), baseCritique());
    const pB = makeParticipant("b", baseAnalysis(), baseCritique());

    const wf = new SpecWorkflow(
      { debate: baseConfig },
      { classifier, participantA: pA, participantB: pB },
    );
    await expect(
      wf.run({ text: "x", context: baseContext }),
    ).rejects.toMatchObject({
      stage: "classify",
    });
    await expect(wf.run({ text: "x", context: baseContext })).rejects.toThrow(
      /deepseek down/,
    );
  });

  it("wraps_debate_error_in_SpecWorkflowError_stage_debate", async () => {
    const classifier = {
      name: "ok",
      classify: vi.fn(async () => baseIntent()),
    };
    const pA: DebateParticipant = {
      name: "fail",
      analyze: vi.fn(async () => {
        throw new Error("analyze boom");
      }),
      critique: vi.fn(async () => baseCritique()),
    };
    const pB = makeParticipant("b", baseAnalysis(), baseCritique());

    const wf = new SpecWorkflow(
      { debate: baseConfig },
      { classifier, participantA: pA, participantB: pB },
    );
    await expect(
      wf.run({ text: "x", context: baseContext }),
    ).rejects.toMatchObject({ stage: "debate" });
  });

  it("demandId_uses_provided_prefix", async () => {
    const classifier = {
      name: "mock",
      classify: vi.fn(async () => baseIntent()),
    };
    const pA = makeParticipant("a", baseAnalysis(), baseCritique());
    const pB = makeParticipant("b", baseAnalysis(), baseCritique());

    const wf = new SpecWorkflow(
      { debate: baseConfig, demandIdPrefix: "FEISHU" },
      {
        classifier,
        participantA: pA,
        participantB: pB,
        now: () => new Date("2026-05-20T00:00:00.000Z"),
      },
    );
    const out = await wf.run({ text: "x", context: baseContext });
    expect(out.demandId).toMatch(/^FEISHU-20260520-/);
  });

  it("writes_real_files_to_disk_when_writer_present", async () => {
    const classifier = {
      name: "mock",
      classify: vi.fn(async () => baseIntent()),
    };
    const pA = makeParticipant("a", baseAnalysis(), baseCritique());
    const pB = makeParticipant("b", baseAnalysis(), baseCritique());
    const writer = new OpenSpecWriter({ rootDir: dir });

    const wf = new SpecWorkflow(
      { debate: baseConfig },
      {
        classifier,
        participantA: pA,
        participantB: pB,
        writer,
        now: () => new Date("2026-06-06T00:00:00.000Z"),
      },
    );
    const out = await wf.run({ text: "test", context: baseContext });
    const written = await fs.readdir(join(dir, out.artifact.changeId));
    expect(written).toEqual(
      expect.arrayContaining(["proposal.md", "tasks.md", "specs"]),
    );
  });
});
