/**
 * SpecWorkflow — Phase A.6
 *
 * 端到端流水线: text → intent classify → debate loop → OpenSpec generate → write
 *
 * 设计目标:
 *   1. 给 CLI 和 Feishu Gateway 共用,避免两条独立实现
 *   2. 注入式 (classifier/participant/writer 可替换,便于测试)
 *   3. 不绑死具体 LLM;用 DebateParticipant 接口,claude/codex adapter 实现各自注入
 *   4. 返回完整结果集(artifact + writeResult + intent + consensus),调用方
 *      可以挑着展示给用户
 */

import { defaultLogger, type Logger } from "../core/logger.js";
import { getMetrics, safe } from "../observability/metrics.js";
import { withTrace, setAttribute } from "../observability/trace.js";
import { generateTraceId } from "../observability/trace.js";
import { ClarifyLoop } from "../debate/clarify-loop.js";
import type {
  ClarifyLoopConfig,
  Consensus,
  DebateParticipant,
} from "../debate/types.js";
import type {
  Intent,
  IntentClassifier,
  IntentContext,
} from "../intent/types.js";
import {
  OpenSpecGenerator,
  type OpenSpecArtifact,
} from "../openspec/generator.js";
import {
  OpenSpecWriter,
  type OpenSpecWriteResult,
} from "../openspec/writer.js";

export interface SpecWorkflowConfig {
  readonly debate: ClarifyLoopConfig;
  /** 用于生成 demandId;默认 traceId */
  readonly demandIdPrefix?: string;
}

export interface SpecWorkflowDeps {
  readonly classifier: IntentClassifier;
  readonly participantA: DebateParticipant;
  readonly participantB: DebateParticipant;
  readonly generator?: OpenSpecGenerator;
  readonly writer?: OpenSpecWriter;
  readonly logger?: Logger;
  readonly now?: () => Date;
}

export interface SpecWorkflowResult {
  readonly traceId: string;
  readonly demandId: string;
  readonly intent: Intent;
  readonly consensus: Consensus;
  readonly artifact: OpenSpecArtifact;
  readonly writeResult: OpenSpecWriteResult;
  /** debate 收敛用了几轮(1-3) */
  readonly rounds: number;
}

export class SpecWorkflowError extends Error {
  readonly code = "SPEC_WORKFLOW_ERROR";
  readonly stage: "classify" | "debate" | "generate" | "write";
  constructor(
    stage: "classify" | "debate" | "generate" | "write",
    message: string,
  ) {
    super(`[${stage}] ${message}`);
    this.name = "SpecWorkflowError";
    this.stage = stage;
  }
}

export class SpecWorkflow {
  private readonly logger: Logger;
  private readonly metrics = getMetrics();
  private readonly now: () => Date;
  private readonly demandIdPrefix: string;
  private readonly debateConfig: ClarifyLoopConfig;
  private readonly classifier: IntentClassifier;
  private readonly participantA: DebateParticipant;
  private readonly participantB: DebateParticipant;
  private readonly generator: OpenSpecGenerator;
  private readonly writer: OpenSpecWriter | undefined;

  constructor(config: SpecWorkflowConfig, deps: SpecWorkflowDeps) {
    this.logger = deps.logger ?? defaultLogger.child({ component: "spec" });
    this.now = deps.now ?? (() => new Date());
    this.debateConfig = config.debate;
    this.demandIdPrefix = config.demandIdPrefix ?? "DM";
    this.classifier = deps.classifier;
    this.participantA = deps.participantA;
    this.participantB = deps.participantB;
    this.generator = deps.generator ?? new OpenSpecGenerator();
    this.writer = deps.writer;
  }

  /**
   * 跑端到端流水线。
   * 若 deps.writer 未注入,则只 generate 不写盘(返回的 writeResult.files 为空)。
   */
  async run(input: {
    text: string;
    context: IntentContext;
  }): Promise<SpecWorkflowResult> {
    const traceId = generateTraceId();
    return withTrace(traceId, async () => {
      this.logger.info("spec_workflow started", {
        text_len: input.text.length,
        chat_id: input.context.chatId,
      });
      setAttribute("spec.chat_id", input.context.chatId);

      // 1. classify
      const intent = await this.classifyStage(input);
      setAttribute("spec.intent_type", intent.type);
      setAttribute("spec.intent_source", intent.source);

      // 2. debate
      const consensus = await this.debateStage(input, intent);
      setAttribute("spec.debate_rounds", consensus.rounds);
      setAttribute("spec.consensus_rate", consensus.consensus_rate);
      safe(
        () =>
          this.metrics
            .histogram("debate.consensus_score")
            .observe(consensus.consensus_rate),
        undefined,
      );
      safe(() => this.metrics.inc("debate.converge_total"), undefined);

      // 3. generate
      const artifact = this.generateStage(input, intent, consensus);
      safe(() => this.metrics.inc("openspec.generated_total"), undefined);

      // 4. write (optional)
      const writeResult = await this.writeStage(artifact);

      this.logger.info("spec_workflow completed", {
        change_id: artifact.changeId,
        consensus_rate: consensus.consensus_rate,
        files: writeResult.files.length,
      });

      return {
        traceId,
        demandId: artifact.demandId,
        intent,
        consensus,
        artifact,
        writeResult,
        rounds: consensus.rounds,
      };
    });
  }

  private async classifyStage(input: {
    text: string;
    context: IntentContext;
  }): Promise<Intent> {
    const endTimer = safe(
      () =>
        this.metrics.histogram("intent.classify.duration_seconds").startTimer(),
      () => 0,
    );
    try {
      return await this.classifier.classify(input.text, input.context);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SpecWorkflowError("classify", msg);
    } finally {
      endTimer();
    }
  }

  private async debateStage(
    input: { text: string; context: IntentContext },
    intent: Intent,
  ): Promise<Consensus> {
    safe(() => this.metrics.inc("debate.rounds.total"), undefined);
    const loop = new ClarifyLoop(
      this.debateConfig,
      this.participantA,
      this.participantB,
      { logger: this.logger },
    );
    try {
      const result = await loop.run({
        text: input.text,
        intent,
        context: input.context,
      });
      return result.consensus;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SpecWorkflowError("debate", msg);
    }
  }

  private generateStage(
    input: { text: string },
    intent: Intent,
    consensus: Consensus,
  ): OpenSpecArtifact {
    const demandId = this.makeDemandId();
    try {
      return this.generator.generate({
        intent,
        consensus,
        demandId,
        originalText: input.text,
        now: this.now,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SpecWorkflowError("generate", msg);
    }
  }

  private async writeStage(
    artifact: OpenSpecArtifact,
  ): Promise<OpenSpecWriteResult> {
    if (!this.writer) {
      // 不写盘 — 至少返回一个 in-memory 摘要,让调用方知道 files 会是 0
      return { changeId: artifact.changeId, rootPath: "", files: [] };
    }
    try {
      return await this.writer.write(artifact);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SpecWorkflowError("write", msg);
    }
  }

  private makeDemandId(): string {
    const d = this.now();
    const yyyymmdd = d.toISOString().slice(0, 10).replace(/-/g, "");
    const seq = Math.floor(Math.random() * 1000)
      .toString()
      .padStart(3, "0");
    return `${this.demandIdPrefix}-${yyyymmdd}-${seq}`;
  }
}
