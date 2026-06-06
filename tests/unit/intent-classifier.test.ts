import { describe, expect, it, vi } from "vitest";
import {
  ClassifierOrchestrator,
  type ClassifierConfig,
} from "../../src/intent/classifier.js";
import { DeepSeekAdapter } from "../../src/intent/deepseek-adapter.js";
import { FallbackClassifier } from "../../src/intent/fallback-classifier.js";
import { IntentCache } from "../../src/intent/cache.js";
import {
  IntentClassifyError,
  type Intent,
  type IntentClassifier,
} from "../../src/intent/types.js";

const DEEPSEEK_CONFIG: ClassifierConfig["deepseek"] = {
  apiKey: "sk-test",
  model: "deepseek-chat",
  timeoutMs: 5000,
  maxRetries: 2,
};

const CACHE_CONFIG: ClassifierConfig["cache"] = {
  ttlMs: 60_000,
  maxEntries: 100,
};

const FULL_CONFIG: ClassifierConfig = {
  deepseek: DEEPSEEK_CONFIG,
  cache: CACHE_CONFIG,
  enableFallback: true,
  fallbackWarnThreshold: 3,
};

function makeContext(
  overrides: Partial<Parameters<IntentClassifier["classify"]>[1]> = {},
) {
  return { chatId: "oc-1", senderOpenId: "ou-1", ...overrides };
}

function okIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    type: "feature",
    entities: ["trade"],
    affected_modules: ["trade/**"],
    urgency: "normal",
    intent_score: 0.92,
    trace_id: "oc-1",
    source: "deepseek",
    ...overrides,
  };
}

describe("DeepSeekAdapter (CAP-INT-01)", () => {
  it("classifies_text_via_deepseek_http", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify(okIntent({ source: "deepseek" })),
            },
          },
        ],
      }),
      text: async () => "",
    });
    const adapter = new DeepSeekAdapter(DEEPSEEK_CONFIG, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await adapter.classify(
      "trade 加日期筛选",
      makeContext({ chatId: "trace-1" }),
    );
    expect(result.type).toBe("feature");
    expect(result.intent_score).toBe(0.92);
    expect(result.source).toBe("deepseek");
    expect(fetchImpl).toHaveBeenCalledOnce();
    // request body 校验
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("deepseek-chat");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].content).toBe("trade 加日期筛选");
  });

  it("retries_on_5xx_then_succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => "down",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(okIntent()) } }],
        }),
        text: async () => "",
      });
    const adapter = new DeepSeekAdapter(DEEPSEEK_CONFIG, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await adapter.classify("test", makeContext());
    expect(result.type).toBe("feature");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws_non_retryable_on_401", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "unauth",
    });
    const adapter = new DeepSeekAdapter(DEEPSEEK_CONFIG, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(adapter.classify("test", makeContext())).rejects.toMatchObject(
      {
        code: "INTENT_CLASSIFY_ERROR",
        retryable: false,
      },
    );
    expect(fetchImpl).toHaveBeenCalledOnce(); // 不重试
  });

  it("throws_on_429_but_retryable", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "rate",
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "rate",
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "rate",
      });
    const adapter = new DeepSeekAdapter(DEEPSEEK_CONFIG, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(adapter.classify("test", makeContext())).rejects.toMatchObject(
      {
        code: "INTENT_CLASSIFY_ERROR",
        retryable: true,
      },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2); // maxRetries=2
  });

  it("throws_non_retryable_when_api_key_missing", async () => {
    const adapter = new DeepSeekAdapter({ ...DEEPSEEK_CONFIG, apiKey: "" });
    await expect(adapter.classify("test", makeContext())).rejects.toMatchObject(
      {
        retryable: false,
      },
    );
  });

  it("truncates_text_to_8k_tokens", async () => {
    const longText = "x".repeat(50_000);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(okIntent()) } }],
      }),
      text: async () => "",
    });
    const adapter = new DeepSeekAdapter(DEEPSEEK_CONFIG, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await adapter.classify(longText, makeContext());
    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.messages[1].content.length).toBe(8000);
  });
});

describe("FallbackClassifier", () => {
  const fb = new FallbackClassifier();

  it("classifies_bug_keyword", async () => {
    const r = await fb.classify("trade 模块报错了", makeContext());
    expect(r.type).toBe("bug");
    expect(r.source).toBe("fallback-haiku");
  });

  it("classifies_refactor_keyword", async () => {
    const r = await fb.classify("重构一下 user 模块", makeContext());
    expect(r.type).toBe("refactor");
  });

  it("classifies_query_by_question_mark", async () => {
    const r = await fb.classify("今天部署成功了吗?", makeContext());
    expect(r.type).toBe("query");
  });

  it("classifies_feature_by_default", async () => {
    const r = await fb.classify("trade 加日期筛选", makeContext());
    expect(r.type).toBe("feature");
    expect(r.entities).toContain("trade");
    expect(r.affected_modules).toContain("trade/**");
  });

  it("detects_critical_urgency", async () => {
    const r = await fb.classify("生产线上紧急 crash", makeContext());
    expect(r.urgency).toBe("critical");
  });
});

describe("IntentCache (CAP-INT-03)", () => {
  it("returns_cached_intent_within_ttl", () => {
    const cache = new IntentCache({ ttlMs: 60_000, maxEntries: 10 });
    const ctx = makeContext();
    const intent = okIntent();
    cache.set("trade 加日期", ctx, intent);
    const cached = cache.get("trade 加日期", ctx);
    expect(cached).toBeDefined();
    expect(cached?.source).toBe("cache"); // override source
  });

  it("miss_returns_undefined", () => {
    const cache = new IntentCache({ ttlMs: 60_000, maxEntries: 10 });
    expect(cache.get("nope", makeContext())).toBeUndefined();
  });

  it("expires_after_ttl", () => {
    let now = 1000;
    const cache = new IntentCache({ ttlMs: 100, maxEntries: 10 }, () => now);
    const ctx = makeContext();
    cache.set("k", ctx, okIntent());
    expect(cache.get("k", ctx)).toBeDefined();
    now += 200;
    expect(cache.get("k", ctx)).toBeUndefined();
  });

  it("lru_evicts_oldest_when_full", () => {
    const cache = new IntentCache({ ttlMs: 60_000, maxEntries: 2 });
    const ctx = makeContext();
    cache.set("a", ctx, okIntent());
    cache.set("b", ctx, okIntent());
    cache.set("c", ctx, okIntent()); // 触发淘汰
    expect(cache.size()).toBe(2);
    expect(cache.get("a", ctx)).toBeUndefined();
  });

  it("cache_key_different_chatId_different_key", () => {
    const cache = new IntentCache({ ttlMs: 60_000, maxEntries: 10 });
    cache.set("text", makeContext({ chatId: "A" }), okIntent());
    expect(cache.get("text", makeContext({ chatId: "B" }))).toBeUndefined();
  });
});

describe("ClassifierOrchestrator", () => {
  it("happy_path_uses_deepseek_and_caches", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(okIntent()) } }],
      }),
      text: async () => "",
    });
    const orch = new ClassifierOrchestrator(FULL_CONFIG, {
      deepseekOverride: new DeepSeekAdapter(DEEPSEEK_CONFIG, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    });
    const ctx = makeContext();
    const r1 = await orch.classify("trade 加日期", ctx);
    expect(r1.source).toBe("deepseek");
    const r2 = await orch.classify("trade 加日期", ctx);
    expect(r2.source).toBe("cache");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("falls_back_when_deepseek_throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const orch = new ClassifierOrchestrator(FULL_CONFIG, {
      deepseekOverride: new DeepSeekAdapter(DEEPSEEK_CONFIG, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    });
    const r = await orch.classify("trade 加日期", makeContext());
    expect(r.source).toBe("fallback-haiku");
    expect(r.type).toBe("feature"); // fallback 关键词命中
  });

  it("throws_when_fallback_disabled_and_deepseek_fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("net"));
    const orch = new ClassifierOrchestrator(
      { ...FULL_CONFIG, enableFallback: false },
      {
        deepseekOverride: new DeepSeekAdapter(DEEPSEEK_CONFIG, {
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
      },
    );
    await expect(orch.classify("test", makeContext())).rejects.toBeInstanceOf(
      IntentClassifyError,
    );
  });

  it("logs_warn_after_consecutive_fallbacks", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("net"));
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const orch = new ClassifierOrchestrator(
      { ...FULL_CONFIG, fallbackWarnThreshold: 2 },
      {
        deepseekOverride: new DeepSeekAdapter(DEEPSEEK_CONFIG, {
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
        logger: logger as never,
      },
    );
    await orch.classify("a", makeContext());
    await orch.classify("b", makeContext());
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
