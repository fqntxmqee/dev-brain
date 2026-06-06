/**
 * FeedbackMemory — Phase B.3 (CAP-INS-03)
 *
 * 用户在聊天中纠正 agent 时,把"原 output → 正确 output"存为 feedback。
 * 下一轮 InjectRules 调用时,把近 N 天的 feedback 作为额外规则注入到
 * system prompt,让 agent 自我纠正。
 *
 * 落盘:每日轮转 JSONL,放 <auditDir>/feedback-YYYY-MM-DD.jsonl
 *   默认 ~/.dev-brain/feedback/。append-only。
 *
 * 三种 correction 来源:
 *   - user:      用户在聊天里直接纠正
 *   - reviewer:  人类 reviewer 在 PR 评论里纠正
 *   - judge:     LLM-as-judge 评估发现偏差
 *
 * 集成:InjectRules 的 deps.feedbackSource?: () => Promise<string[]>,
 * 返回若干段 markdown,会被追加到 <rule> 包装里。
 *
 * Metrics: instruction.feedback_recorded_total, instruction.feedback_injected_total
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { defaultLogger, type Logger } from "../core/logger.js";
import { getMetrics, safe } from "../observability/metrics.js";

export type FeedbackSource = "user" | "reviewer" | "judge";

export interface FeedbackEntry {
  readonly id: string;
  readonly trace_id?: string;
  readonly source: FeedbackSource;
  /** agent 原本输出的(可能有偏差的)内容摘要 */
  readonly original: string;
  /** 用户/reviewer 提供的正确版本 */
  readonly corrected: string;
  /** 关联的规则 rel path(可选) */
  readonly rule_rel?: string;
  /** 自由描述:为什么这样纠正 */
  readonly rationale?: string;
  readonly recorded_at: string;
}

export interface RecordCorrectionInput {
  readonly trace_id?: string;
  readonly source: FeedbackSource;
  readonly original: string;
  readonly corrected: string;
  readonly rule_rel?: string;
  readonly rationale?: string;
}

export interface FeedbackQuery {
  readonly sinceDays?: number;
  readonly traceId?: string;
  readonly source?: FeedbackSource;
  readonly limit?: number;
}

export interface FeedbackMemoryDeps {
  readonly auditDir?: string;
  readonly logger?: Logger;
  readonly now?: () => Date;
  /** id 工厂(测试可覆盖) */
  readonly idFactory?: () => string;
}

const DEFAULT_AUDIT_DIR = "~/.dev-brain/feedback";
const DEFAULT_SINCE_DAYS = 7;

export class FeedbackMemory {
  private readonly auditDir: string;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly metrics = getMetrics();

  constructor(deps: FeedbackMemoryDeps = {}) {
    this.auditDir = deps.auditDir ?? expandHome(DEFAULT_AUDIT_DIR);
    this.logger =
      deps.logger ?? defaultLogger.child({ component: "feedback-memory" });
    this.now = deps.now ?? (() => new Date());
    this.idFactory =
      deps.idFactory ??
      (() =>
        `${this.now().toISOString().replace(/[:.]/g, "-")}-${Math.random()
          .toString(36)
          .slice(2, 8)}`);
  }

  // ============================================================
  //  写入
  // ============================================================

  async recordCorrection(input: RecordCorrectionInput): Promise<FeedbackEntry> {
    const entry: FeedbackEntry = {
      id: this.idFactory(),
      trace_id: input.trace_id,
      source: input.source,
      original: input.original.slice(0, 1000),
      corrected: input.corrected.slice(0, 1000),
      rule_rel: input.rule_rel,
      rationale: input.rationale?.slice(0, 500),
      recorded_at: this.now().toISOString(),
    };
    await this.appendEntries([entry]);
    safe(
      () => this.metrics.inc("instruction.feedback_recorded_total"),
      undefined,
    );
    this.logger.info("feedback recorded", {
      id: entry.id,
      source: entry.source,
      rule_rel: entry.rule_rel,
    });
    return entry;
  }

  // ============================================================
  //  查询
  // ============================================================

  async listRecent(
    query: FeedbackQuery = {},
  ): Promise<ReadonlyArray<FeedbackEntry>> {
    const sinceMs = query.sinceDays
      ? this.now().getTime() - query.sinceDays * 24 * 3600 * 1000
      : 0;
    const files = await this.listLogFiles();
    const out: FeedbackEntry[] = [];
    for (const f of files) {
      let raw: string;
      try {
        raw = await fs.readFile(f, "utf-8");
      } catch (err) {
        if (isNotFound(err)) continue;
        throw err;
      }
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let entry: FeedbackEntry;
        try {
          entry = JSON.parse(line) as FeedbackEntry;
        } catch {
          continue;
        }
        if (query.traceId && entry.trace_id !== query.traceId) continue;
        if (query.source && entry.source !== query.source) continue;
        if (Date.parse(entry.recorded_at) < sinceMs) continue;
        out.push(entry);
      }
    }
    out.sort((a, b) => (a.recorded_at < b.recorded_at ? 1 : -1));
    return query.limit ? out.slice(0, query.limit) : out;
  }

  // ============================================================
  //  注入器
  // ============================================================

  /**
   * 把最近 N 条 feedback 渲染成可注入 system prompt 的 markdown。
   * 每条包成 <rule source="feedback/{id}">…</rule>。
   * 返回的 content 可直接喂给 InjectRules.assemble() 的额外 sources。
   */
  async renderAsRuleSections(
    query: FeedbackQuery = {},
  ): Promise<ReadonlyArray<{ relPath: string; content: string }>> {
    const items = await this.listRecent({
      sinceDays: DEFAULT_SINCE_DAYS,
      ...query,
    });
    if (items.length === 0) return [];
    const sections = items.map((e) => ({
      relPath: `feedback/${e.id}`,
      content: formatEntry(e),
    }));
    safe(() => {
      const m = getMetrics();
      // 累加:每渲染一条 +1
      for (let i = 0; i < sections.length; i += 1)
        m.inc("instruction.feedback_injected_total");
    }, undefined);
    return sections;
  }

  // ============================================================
  //  internal
  // ============================================================

  private async appendEntries(
    entries: ReadonlyArray<FeedbackEntry>,
  ): Promise<void> {
    if (entries.length === 0) return;
    await fs.mkdir(this.auditDir, { recursive: true });
    const file = this.fileFor(this.now());
    const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await fs.appendFile(file, lines, "utf-8");
  }

  private fileFor(d: Date): string {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return join(this.auditDir, `feedback-${y}-${m}-${day}.jsonl`);
  }

  private async listLogFiles(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.auditDir, { withFileTypes: true });
      return entries
        .filter(
          (e) =>
            e.isFile() &&
            e.name.startsWith("feedback-") &&
            e.name.endsWith(".jsonl"),
        )
        .map((e) => join(this.auditDir, e.name));
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }
}

// ============================================================
//  helpers
// ============================================================

function expandHome(p: string): string {
  if (!p.startsWith("~")) return p;
  const home = process.env.HOME ?? "/tmp";
  return join(home, p.slice(1).replace(/^[/\\]/, ""));
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "ENOENT"
  );
}

function formatEntry(e: FeedbackEntry): string {
  const parts: string[] = [];
  parts.push(`# Feedback (${e.source})`);
  if (e.rule_rel) parts.push(`- rule: \`${e.rule_rel}\``);
  parts.push(`- original: ${e.original}`);
  parts.push(`- corrected: ${e.corrected}`);
  if (e.rationale) parts.push(`- rationale: ${e.rationale}`);
  return parts.join("\n");
}
