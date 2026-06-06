/**
 * InjectRules — Phase B.1 (CAP-INS-01)
 *
 * 把 home rules 目录、home CLAUDE.md、project CLAUDE.md 和 project rules
 * 目录下的所有 .md 文件拼成一个 system prompt 段,注入到 agent 调用前。
 *
 * 顺序(后写覆盖优先级):
 *   1. ~/.claude/CLAUDE.md              (global, 若存在)
 *   2. ~/.claude/rules 下所有 .md     (global rules, 字母序)
 *   3. <workDir>/CLAUDE.md              (project, 若存在)
 *   4. <workDir>/.claude/rules 下所有 .md (project rules, 字母序)
 *
 * 缓存:按 mtime 算 hash;md 文件未变更 → 复用上次内容。避免每次 agent
 * 调用都全盘 IO。
 *
 * 失败:目录不存在 / 权限错 -> 静默跳过(不阻塞 agent),记 warn。
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { defaultLogger, type Logger } from "../core/logger.js";

export interface InjectedRule {
  readonly path: string;
  /** 相对注入根目录的路径,便于日志/上报(e.g. "common/coding-style.md") */
  readonly relPath: string;
  readonly bytes: number;
  /** 估算 token 数:chars/4 近似 (英文场景误差 <15%) */
  readonly estTokens: number;
}

export interface RuleInjectionResult {
  /** 拼好的 system prompt 段;若无可注入规则则为空字符串 */
  readonly content: string;
  readonly appliedRules: ReadonlyArray<InjectedRule>;
  /** 触发截断时为 true */
  readonly truncated: boolean;
  /** 被截断后未注入的规则 */
  readonly dropped: ReadonlyArray<InjectedRule>;
  /** 总注入 token 估算 */
  readonly totalTokens: number;
}

export interface InjectRulesDeps {
  /** 注入根目录(默认 process.cwd()) */
  readonly workDir?: string;
  /** 全局 home 目录(默认 os.homedir()) */
  readonly homeDir?: string;
  /** token 预算上限,默认 8000(~32KB) */
  readonly tokenBudget?: number;
  readonly logger?: Logger;
  /** 注入根目录前缀,测试可覆盖 */
  readonly homeRulesPrefix?: string;
  readonly projectRulesPrefix?: string;
  readonly homeClaudeMd?: string;
  readonly projectClaudeMd?: string;
  /**
   * 额外 source provider:返回若干 { relPath, content } 段(例如 feedback memory
   * 渲染的修正条目),会被追加到常规 4-source 之后,参与 token 预算。
   * 失败时静默跳过(不阻塞注入)。
   */
  readonly extraSources?: () => Promise<
    ReadonlyArray<{ relPath: string; content: string }>
  >;
}

const DEFAULT_TOKEN_BUDGET = 8_000;
/** 简单 token 估算:平均 4 字符 1 token */
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export class InjectRules {
  private readonly workDir: string;
  private readonly homeDir: string;
  private readonly tokenBudget: number;
  private readonly logger: Logger;
  private readonly homeRulesPrefix: string;
  private readonly projectRulesPrefix: string;
  private readonly homeClaudeMd: string;
  private readonly projectClaudeMd: string;
  /** 缓存: key = "global|project" → { content, appliedRules, mtimes, computedAt } */
  private cache: RuleInjectionResult | undefined;
  /** 用于 mtime 比对 */
  private cacheSignature: string | undefined;

  constructor(deps: InjectRulesDeps = {}) {
    this.workDir = deps.workDir ?? process.cwd();
    this.homeDir = deps.homeDir ?? homedir();
    this.tokenBudget = deps.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    this.logger = deps.logger ?? defaultLogger.child({ component: "rules" });
    this.homeRulesPrefix =
      deps.homeRulesPrefix ?? join(this.homeDir, ".claude", "rules");
    this.projectRulesPrefix =
      deps.projectRulesPrefix ?? join(this.workDir, ".claude", "rules");
    this.homeClaudeMd =
      deps.homeClaudeMd ?? join(this.homeDir, ".claude", "CLAUDE.md");
    this.projectClaudeMd =
      deps.projectClaudeMd ?? join(this.workDir, "CLAUDE.md");
    this.extraSources = deps.extraSources;
  }

  private readonly extraSources?: () => Promise<
    ReadonlyArray<{ relPath: string; content: string }>
  >;

  /**
   * 拉取最新规则并组装。命中缓存 → 直接返回。
   * 强制刷新可传 force=true(用户刚加新规则时有用)。
   */
  async inject(opts: { force?: boolean } = {}): Promise<RuleInjectionResult> {
    const sources = await this.collectSources();
    const signature = sources.map((s) => `${s.path}:${s.mtimeMs}`).join("|");
    if (!opts.force && this.cache && this.cacheSignature === signature) {
      return this.cache;
    }

    const result = this.assemble(sources);
    this.cache = result;
    this.cacheSignature = signature;
    this.logger.info("rules injected", {
      applied: result.appliedRules.length,
      dropped: result.dropped.length,
      tokens: result.totalTokens,
      truncated: result.truncated,
    });
    return result;
  }

  /** 清缓存(测试 / 显式刷新用) */
  invalidate(): void {
    this.cache = undefined;
    this.cacheSignature = undefined;
  }

  // ============================================================
  //  internal
  // ============================================================

  private async collectSources(): Promise<
    ReadonlyArray<{ path: string; content: string; mtimeMs: number }>
  > {
    const out: { path: string; content: string; mtimeMs: number }[] = [];

    // 1. ~/.claude/CLAUDE.md
    const homeClaude = await this.tryRead(this.homeClaudeMd);
    if (homeClaude) out.push(homeClaude);

    // 2. ~/.claude/rules/**/*.md
    const homeRules = await this.listRules(this.homeRulesPrefix);
    out.push(...homeRules);

    // 3. <workDir>/CLAUDE.md
    const projectClaude = await this.tryRead(this.projectClaudeMd);
    if (projectClaude) out.push(projectClaude);

    // 4. <workDir>/.claude/rules 下所有 .md
    const projectRules = await this.listRules(this.projectRulesPrefix);
    out.push(...projectRules);

    // 5. extra sources (e.g. feedback memory) — mtime 设为 now 强制重新评估
    if (this.extraSources) {
      try {
        const extras = await this.extraSources();
        const nowMs = Date.now();
        for (const e of extras) {
          out.push({
            path: `<extra>:${e.relPath}`,
            content: e.content,
            mtimeMs: nowMs,
          });
        }
      } catch (err) {
        this.logger.warn("extra sources failed; skipping", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return out;
  }

  private async tryRead(
    absPath: string,
  ): Promise<{ path: string; content: string; mtimeMs: number } | null> {
    try {
      const [content, stat] = await Promise.all([
        fs.readFile(absPath, "utf-8"),
        fs.stat(absPath),
      ]);
      return { path: absPath, content, mtimeMs: stat.mtimeMs };
    } catch (err) {
      if (this.isNotFound(err)) return null;
      this.logger.warn("rule file read failed; skipping", {
        path: absPath,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * 递归列出 prefix 下的 .md 文件,字母序返回。
   * prefix 不存在 → 静默返 []。
   */
  private async listRules(
    prefix: string,
  ): Promise<
    ReadonlyArray<{ path: string; content: string; mtimeMs: number }>
  > {
    let entries: string[];
    try {
      entries = await this.walk(prefix);
    } catch (err) {
      if (this.isNotFound(err)) return [];
      this.logger.warn("rules dir walk failed; skipping", {
        prefix,
        err: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
    const mdFiles = entries.filter((p) => p.endsWith(".md")).sort();
    const out: { path: string; content: string; mtimeMs: number }[] = [];
    for (const p of mdFiles) {
      const r = await this.tryRead(p);
      if (r) out.push(r);
    }
    return out;
  }

  private async walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    const stack: string[] = [dir];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      let entries;
      try {
        entries = await fs.readdir(cur, { withFileTypes: true });
      } catch (err) {
        if (this.isNotFound(err)) continue;
        throw err;
      }
      for (const e of entries) {
        const p = join(cur, e.name);
        if (e.isDirectory()) {
          stack.push(p);
        } else if (e.isFile()) {
          out.push(p);
        }
      }
    }
    return out;
  }

  private assemble(
    sources: ReadonlyArray<{ path: string; content: string; mtimeMs: number }>,
  ): RuleInjectionResult {
    const applied: InjectedRule[] = [];
    const dropped: InjectedRule[] = [];
    const sections: string[] = [];
    let totalTokens = 0;
    let truncated = false;

    for (const s of sources) {
      const rel = this.relPathOf(s.path);
      const estTokens = estimateTokens(s.content);
      const rule: InjectedRule = {
        path: s.path,
        relPath: rel,
        bytes: Buffer.byteLength(s.content, "utf-8"),
        estTokens,
      };

      if (totalTokens + estTokens > this.tokenBudget) {
        dropped.push(rule);
        truncated = true;
        continue;
      }

      sections.push(
        ['<rule source="' + rel + '">', s.content.trim(), "</rule>"].join("\n"),
      );
      applied.push(rule);
      totalTokens += estTokens;
    }

    const content =
      applied.length === 0
        ? ""
        : `## 注入规则 (${applied.length} files, ~${totalTokens} tokens)\n\n${sections.join("\n\n")}`;

    return { content, appliedRules: applied, dropped, truncated, totalTokens };
  }

  private relPathOf(absPath: string): string {
    if (absPath.startsWith(this.homeRulesPrefix)) {
      return relative(this.homeRulesPrefix, absPath);
    }
    if (absPath.startsWith(this.projectRulesPrefix)) {
      return relative(this.projectRulesPrefix, absPath);
    }
    if (absPath === this.homeClaudeMd) return "~/.claude/CLAUDE.md";
    if (absPath === this.projectClaudeMd) return "./CLAUDE.md";
    if (absPath.startsWith("<extra>:")) return absPath.slice("<extra>:".length);
    return isAbsolute(absPath) ? absPath : absPath;
  }

  private isNotFound(err: unknown): boolean {
    return (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    );
  }
}
