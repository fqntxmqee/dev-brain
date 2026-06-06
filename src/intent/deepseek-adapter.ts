/**
 * DeepSeek HTTPS client — 5 档意图分类
 * 对应 OpenSpec: CAP-INT-01
 *
 * 使用 DeepSeek Chat Completions API:
 *   POST https://api.deepseek.com/v1/chat/completions
 *   model: deepseek-chat (默认,环境变量可改)
 *   response_format: { type: "json_object" } 强制 JSON
 */

import { defaultLogger, type Logger } from "../core/logger.js";
import {
  IntentClassifyError,
  type Intent,
  type IntentContext,
  type IntentType,
  type IntentUrgency,
} from "./types.js";

const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";

const SYSTEM_PROMPT = `你是 dev-brain 的意图分类器。输入是飞书用户的一条业务需求文本,输出严格 JSON。

输出 schema:
{
  "type": "feature" | "bug" | "refactor" | "query" | "config" 五选一,
  "entities": ["<从文本抽取的命名实体,首字母小写下划线>"],
  "affected_modules": ["<推测的代码模块 glob pattern,例如 trade/**>"],
  "urgency": "low" | "normal" | "high" | "critical",
  "intent_score": <0-1 之间的浮点>
}

分类规则:
- feature: 用户要新增功能/接口/页面
- bug: 用户报告错误/异常/不符合预期
- refactor: 用户要重构/优化/清理(不改外部行为)
- query: 用户问问题/查状态/请求信息
- config: 用户要修改配置/部署/权限

只输出 JSON,不要任何额外文字。`;

const VALID_TYPES: ReadonlySet<IntentType> = new Set([
  "feature",
  "bug",
  "refactor",
  "query",
  "config",
]);

const VALID_URGENCIES: ReadonlySet<IntentUrgency> = new Set([
  "low",
  "normal",
  "high",
  "critical",
]);

export interface DeepSeekConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
}

export interface DeepSeekDeps {
  /** 自定义 fetch (测试可注入) */
  readonly fetchImpl?: typeof fetch;
  readonly logger?: Logger;
  readonly now?: () => Date;
}

interface DeepSeekResponse {
  readonly choices: ReadonlyArray<{
    readonly message: { readonly content: string };
  }>;
}

export class DeepSeekAdapter {
  readonly name = "deepseek";
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(
    private readonly config: DeepSeekConfig,
    private readonly deps: DeepSeekDeps = {},
  ) {
    this.logger =
      deps.logger ?? defaultLogger.child({ component: "deepseek-adapter" });
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * 调 DeepSeek 分类,返 Intent。
   * 失败抛 IntentClassifyError(可重试由调用方决定)。
   */
  async classify(text: string, context: IntentContext): Promise<Intent> {
    const traceId = context.chatId;
    if (!this.config.apiKey) {
      throw new IntentClassifyError("DEEPSEEK_API_KEY not set", {
        retryable: false,
      });
    }

    const body = {
      model: this.config.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text.slice(0, 8000) }, // CAP-INT-01: 截断到 8K
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    };

    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const startMs = this.now().getTime();
    let lastErr: unknown = undefined;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        const res = await fetchImpl(DEEPSEEK_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });

        if (res.status === 429) {
          throw new IntentClassifyError(`rate limited (HTTP 429)`, {
            retryable: true,
          });
        }
        if (res.status === 401 || res.status === 403) {
          throw new IntentClassifyError(`auth failed (HTTP ${res.status})`, {
            retryable: false,
          });
        }
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new IntentClassifyError(
            `DeepSeek HTTP ${res.status}: ${errText.slice(0, 200)}`,
            { retryable: res.status >= 500 },
          );
        }

        const data = (await res.json()) as DeepSeekResponse;
        const content = data.choices?.[0]?.message?.content;
        if (!content) {
          throw new IntentClassifyError("DeepSeek returned empty content", {
            retryable: true,
          });
        }
        const elapsedMs = this.now().getTime() - startMs;
        this.logger.info("deepseek classify ok", {
          trace_id: traceId,
          elapsed_ms: elapsedMs,
          attempt,
        });
        return this.parseIntent(content, traceId);
      } catch (err) {
        lastErr = err;
        if (err instanceof IntentClassifyError && !err.retryable) {
          throw err;
        }
        if (attempt < this.config.maxRetries) {
          // 指数退避: 500ms, 1s, 2s
          const backoffMs = 500 * 2 ** (attempt - 1);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
      }
    }

    const message =
      lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new IntentClassifyError(
      `DeepSeek classify failed after ${this.config.maxRetries} attempts: ${message}`,
      {
        retryable: true,
      },
    );
  }

  private parseIntent(rawJson: string, traceId: string): Intent {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch (err) {
      throw new IntentClassifyError(
        `DeepSeek returned invalid JSON: ${rawJson.slice(0, 200)}`,
        { retryable: false },
      );
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new IntentClassifyError("DeepSeek JSON is not an object", {
        retryable: false,
      });
    }
    const obj = parsed as Record<string, unknown>;
    const type = obj.type;
    if (typeof type !== "string" || !VALID_TYPES.has(type as IntentType)) {
      throw new IntentClassifyError(`Invalid intent type: ${String(type)}`, {
        retryable: false,
      });
    }
    const urgency = obj.urgency;
    const urgencyVal: IntentUrgency =
      typeof urgency === "string" &&
      VALID_URGENCIES.has(urgency as IntentUrgency)
        ? (urgency as IntentUrgency)
        : "normal";
    const entities = Array.isArray(obj.entities)
      ? obj.entities.filter((e): e is string => typeof e === "string")
      : [];
    const affected_modules = Array.isArray(obj.affected_modules)
      ? obj.affected_modules.filter((m): m is string => typeof m === "string")
      : [];
    const scoreRaw = obj.intent_score;
    const intent_score =
      typeof scoreRaw === "number" && scoreRaw >= 0 && scoreRaw <= 1
        ? scoreRaw
        : 0.5;

    return {
      type: type as IntentType,
      entities,
      affected_modules,
      urgency: urgencyVal,
      intent_score,
      trace_id: traceId,
      source: "deepseek",
    };
  }
}
