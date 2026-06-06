/**
 * TraceContext — CAP-OBS-02 / Phase A.5
 *
 * 用 AsyncLocalStorage 把 trace_id / span_id 注入到所有 async 调用链里。
 * 这样:
 *   - logger.child({ trace_id }) 可以自动继承
 *   - 跨 setImmediate / setTimeout / 微任务都保持
 *   - 不污染业务函数签名(不传 trace_id 参数)
 *
 * 用法:
 *
 *   import { withTrace, withSpan, getCurrentSpan, setAttribute } from "./trace.js";
 *
 *   // 飞书收消息时,建立 root trace
 *   const traceId = generateTraceId();
 *   await withTrace(traceId, async () => {
 *     const intent = await classify(text);   // trace_id 自动可读
 *     await withSpan(async (span) => {       // 子 span
 *       span.attributes["subtask"] = "st-1";
 *       await dispatch(intent);
 *     });
 *   });
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface SpanContext {
  readonly trace_id: string;
  readonly span_id: string;
  readonly parent_span_id?: string;
  readonly started_at: string;
  /**
   * 子 span / 调用方可写:中途填入关键属性
   * (intent.type / debate.rounds / openspec.coverage 等)
   * 关闭 span 时聚合进 metric label 或日志。
   */
  readonly attributes: Record<string, unknown>;
}

const storage = new AsyncLocalStorage<SpanContext>();

/** 生成一个新的 trace_id。形如 `tr-mh3z9p-7f2a1c`(时间+随机,人类可读) */
export function generateTraceId(): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `tr-${ts}-${rnd}`;
}

/** 生成一个新的 span_id。 */
export function generateSpanId(): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `sp-${ts}-${rnd}`;
}

/**
 * 在新 trace 下运行 fn。fn 内(包括所有 await / setTimeout)
 * 都可被 getCurrentSpan() / getTraceId() 读到。
 *
 * 同一 trace 内调多次 withSpan() 会产生 child span(继承 trace_id,
 * 记录 parent_span_id),便于定位子阶段。
 */
export function withTrace<T>(traceId: string, fn: () => T): T {
  const ctx: SpanContext = {
    trace_id: traceId,
    span_id: generateSpanId(),
    started_at: new Date().toISOString(),
    attributes: {},
  };
  return storage.run(ctx, fn);
}

/**
 * 启动一个子 span(继承当前 trace_id)。
 * 父 span 不存在时自动开 root。
 */
export function withSpan<T>(fn: (span: SpanContext) => T): T {
  const parent = storage.getStore();
  const ctx: SpanContext = {
    trace_id: parent?.trace_id ?? generateTraceId(),
    span_id: generateSpanId(),
    parent_span_id: parent?.span_id,
    started_at: new Date().toISOString(),
    attributes: {},
  };
  return storage.run(ctx, () => fn(ctx));
}

/** 当前 span;无则为 undefined(在 ALS 之外运行)。 */
export function getCurrentSpan(): SpanContext | undefined {
  return storage.getStore();
}

/** 当前 trace_id;无则为 undefined。 */
export function getTraceId(): string | undefined {
  return storage.getStore()?.trace_id;
}

/** 把 key/value 写入当前 span.attributes。无当前 span 时静默忽略。 */
export function setAttribute(key: string, value: unknown): void {
  const span = storage.getStore();
  if (!span) return;
  span.attributes[key] = value;
}

/**
 * 便捷方法:把当前 trace_id 注入到 logger bindings。
 * 业务代码:
 *
 *   const log = traceLogger(defaultLogger);
 *   log.info("debate round", { round: 1 });  // 自动带 trace_id / span_id
 */
export function traceBindings(): Record<string, unknown> {
  const span = storage.getStore();
  if (!span) return {};
  return { trace_id: span.trace_id, span_id: span.span_id };
}
