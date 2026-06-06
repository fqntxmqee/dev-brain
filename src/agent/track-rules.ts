/**
 * TrackRules — Phase B.2 (CAP-INS-02)
 *
 * 记录两类事件:
 *   - applied  : 哪条规则被注入到哪次 agent 调用
 *   - violated : 用户/LLM 检测到该规则的输出违反
 *
 * 落盘:每日轮转 JSONL,放在 <auditDir>/rules-YYYY-MM-DD.jsonl
 *   默认 ~/.dev-brain/rules-audit/。append-only,文件锁由 fs.appendFile
 *   单写者语义保证;并发多写者会交错(可接受,审计用)。
 *
 * 查询:listEvents({ traceId, since, event, limit }) 读回事件
 *   用于 Phase B.3 feedback-memory 拉近 7 天内的违规。
 *
 * 检测:detectViolations 抽取规则正文里形如:
 *   - NEVER: <pattern>
 *   - MUST NOT: <pattern>
 *   - 禁止: <pattern>
 *   - 不要: <pattern>
 *   的行,把 <pattern> 当字面量子串,在 agent 输出里搜。
 * 命中即算违规(粗筛,真违规判定留给 LLM 二次复核)。
 *
 * Metrics: instruction.rules_applied_total, instruction.rules_violated_total
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { defaultLogger, type Logger } from "../core/logger.js";
import { getMetrics, safe } from "../observability/metrics.js";
import type { InjectedRule } from "./inject-rules.js";

export type RuleEventType = "applied" | "violated" | "ignored";

export interface RuleEvent {
  readonly trace_id: string;
  readonly session_key?: string;
  readonly rule_path: string;
  readonly rule_rel: string;
  readonly event: RuleEventType;
  /** 违规时的证据(agent 输出的相关片段) */
  readonly evidence?: string;
  /** 违规检测器:heuristic | user_flag | llm_judge */
  readonly detector?: string;
  readonly recorded_at: string;
}

export interface RuleEventQuery {
  readonly traceId?: string;
  readonly since?: Date;
  readonly event?: RuleEventType;
  readonly limit?: number;
}

export interface ViolationMatch {
  readonly rule: InjectedRule;
  /** 命中的禁令原文(规则里那一行) */
  readonly pattern: string;
  /** 在 agent 输出里出现的子串 */
  readonly snippet: string;
}

export interface TrackRulesDeps {
  /** 落盘根目录,默认 ~/.dev-brain/rules-audit */
  readonly auditDir?: string;
  readonly logger?: Logger;
  readonly now?: () => Date;
}

const DEFAULT_AUDIT_DIR = "~/.dev-brain/rules-audit";

const FORBIDDEN_PATTERNS: ReadonlyArray<{
  re: RegExp;
  detector: string;
}> = [
  // 英文: NEVER <something>, MUST NOT <something>
  { re: /^\s*[-*]?\s*NEVER\s*[:：]\s*(.+)$/gim, detector: "heuristic:NEVER" },
  {
    re: /^\s*[-*]?\s*MUST\s+NOT\s*[:：]\s*(.+)$/gim,
    detector: "heuristic:MUST_NOT",
  },
  {
    re: /^\s*[-*]?\s*DO\s+NOT\s*[:：]\s*(.+)$/gim,
    detector: "heuristic:DO_NOT",
  },
  // 中文: 禁止/不要/不得/不允许
  { re: /^\s*[-*]?\s*禁止\s*[:：]?\s*(.+)$/gm, detector: "heuristic:禁止" },
  { re: /^\s*[-*]?\s*不要\s*[:：]?\s*(.+)$/gm, detector: "heuristic:不要" },
  { re: /^\s*[-*]?\s*不得\s*[:：]?\s*(.+)$/gm, detector: "heuristic:不得" },
  { re: /^\s*[-*]?\s*不允许\s*[:：]?\s*(.+)$/gm, detector: "heuristic:不允许" },
];

export class TrackRules {
  private readonly auditDir: string;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly metrics = getMetrics();

  constructor(deps: TrackRulesDeps = {}) {
    this.auditDir = deps.auditDir ?? expandHome(DEFAULT_AUDIT_DIR);
    this.logger =
      deps.logger ?? defaultLogger.child({ component: "track-rules" });
    this.now = deps.now ?? (() => new Date());
  }

  // ============================================================
  //  写入
  // ============================================================

  /** 一次"应用 N 条规则"批量落盘 */
  async recordAppliedBatch(input: {
    readonly trace_id: string;
    readonly session_key?: string;
    readonly rules: ReadonlyArray<InjectedRule>;
  }): Promise<void> {
    const recorded_at = this.now().toISOString();
    const lines: string[] = [];
    for (const r of input.rules) {
      lines.push(
        JSON.stringify({
          trace_id: input.trace_id,
          session_key: input.session_key,
          rule_path: r.path,
          rule_rel: r.relPath,
          event: "applied" as const,
          recorded_at,
        }),
      );
    }
    await this.appendLines(lines);
    for (let i = 0; i < input.rules.length; i += 1) {
      safe(
        () => this.metrics.inc("instruction.rules_applied_total"),
        undefined,
      );
    }
    this.logger.debug("recorded applied batch", {
      trace_id: input.trace_id,
      count: input.rules.length,
    });
  }

  /** 单条违规记录(用户标记 / LLM 复核) */
  async recordViolation(input: {
    readonly trace_id: string;
    readonly session_key?: string;
    readonly rule_path: string;
    readonly rule_rel: string;
    readonly evidence: string;
    readonly detector: string;
  }): Promise<void> {
    const event: RuleEvent = {
      trace_id: input.trace_id,
      session_key: input.session_key,
      rule_path: input.rule_path,
      rule_rel: input.rule_rel,
      event: "violated",
      evidence: input.evidence.slice(0, 500),
      detector: input.detector,
      recorded_at: this.now().toISOString(),
    };
    await this.appendLines([JSON.stringify(event)]);
    safe(() => this.metrics.inc("instruction.rules_violated_total"), undefined);
    this.logger.info("rule violation recorded", {
      trace_id: input.trace_id,
      rule_rel: input.rule_rel,
      detector: input.detector,
    });
  }

  // ============================================================
  //  查询
  // ============================================================

  async listEvents(
    query: RuleEventQuery = {},
  ): Promise<ReadonlyArray<RuleEvent>> {
    const files = await this.listLogFiles();
    const sinceMs = query.since ? query.since.getTime() : 0;
    const out: RuleEvent[] = [];
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
        let evt: RuleEvent;
        try {
          evt = JSON.parse(line) as RuleEvent;
        } catch {
          continue; // 跳过损坏行
        }
        if (query.traceId && evt.trace_id !== query.traceId) continue;
        if (query.event && evt.event !== query.event) continue;
        if (Date.parse(evt.recorded_at) < sinceMs) continue;
        out.push(evt);
      }
    }
    out.sort((a, b) => (a.recorded_at < b.recorded_at ? 1 : -1));
    return query.limit ? out.slice(0, query.limit) : out;
  }

  // ============================================================
  //  启发式违规检测
  // ============================================================

  /**
   * 从 rules 各自的正文中抽禁令模式,在 agentOutput 里搜。
   * 命中任一即视为疑似违规;evidence 取首个匹配前后 80 字。
   */
  async detectViolations(
    agentOutput: string,
    rules: ReadonlyArray<InjectedRule>,
  ): Promise<ReadonlyArray<ViolationMatch>> {
    if (!agentOutput || rules.length === 0) return [];
    const out: ViolationMatch[] = [];
    for (const r of rules) {
      const patterns = await extractForbidden(r.path); // 规则正文从 disk 读
      for (const p of patterns) {
        const idx = agentOutput.indexOf(p);
        if (idx >= 0) {
          const start = Math.max(0, idx - 40);
          const end = Math.min(agentOutput.length, idx + p.length + 40);
          out.push({
            rule: r,
            pattern: p,
            snippet: agentOutput.slice(start, end),
          });
        }
      }
    }
    return out;
  }

  // ============================================================
  //  internal
  // ============================================================

  private async appendLines(lines: ReadonlyArray<string>): Promise<void> {
    if (lines.length === 0) return;
    await fs.mkdir(this.auditDir, { recursive: true });
    const file = this.fileFor(this.now());
    await fs.appendFile(file, lines.join("\n") + "\n", "utf-8");
  }

  private fileFor(d: Date): string {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return join(this.auditDir, `rules-${y}-${m}-${day}.jsonl`);
  }

  private async listLogFiles(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.auditDir, { withFileTypes: true });
      return entries
        .filter(
          (e) =>
            e.isFile() &&
            e.name.startsWith("rules-") &&
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
  // Node 20+ 提供 os.homedir();这里走 dynamic import 避免循环
  // 简单做法:用 process.env.HOME 兜底
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

/**
 * 从规则文件正文抽所有禁止模式。规则正文不在 InjectedRule 里(只存了
 * bytes/estTokens),需要时按 path 现读。
 */
async function extractForbidden(rulePath: string): Promise<string[]> {
  let body: string;
  try {
    body = await fs.readFile(rulePath, "utf-8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const { re } of FORBIDDEN_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const pat = (m[1] ?? "").trim();
      if (pat.length >= 2) out.push(pat);
    }
  }
  return out;
}
