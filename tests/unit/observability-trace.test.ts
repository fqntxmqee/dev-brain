import { describe, expect, it } from "vitest";
import {
  generateSpanId,
  generateTraceId,
  getCurrentSpan,
  getTraceId,
  setAttribute,
  traceBindings,
  withSpan,
  withTrace,
} from "../../src/observability/trace.js";

describe("trace — generate (CAP-OBS-02)", () => {
  it("generateTraceId_returns_non_empty_string", () => {
    const id = generateTraceId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(5);
    expect(id).toMatch(/^tr-/);
  });

  it("generateTraceId_produces_unique_values", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i += 1) ids.add(generateTraceId());
    expect(ids.size).toBe(50);
  });

  it("generateSpanId_returns_non_empty_string", () => {
    const id = generateSpanId();
    expect(id).toMatch(/^sp-/);
  });
});

describe("trace — withTrace (CAP-OBS-02)", () => {
  it("getTraceId_undefined_outside_context", () => {
    expect(getTraceId()).toBeUndefined();
    expect(getCurrentSpan()).toBeUndefined();
  });

  it("withTrace_injects_trace_id_into_context", () => {
    const result = withTrace("tr-abc", () => {
      const span = getCurrentSpan();
      expect(span).toBeDefined();
      expect(span?.trace_id).toBe("tr-abc");
      expect(span?.span_id).toMatch(/^sp-/);
      expect(span?.parent_span_id).toBeUndefined();
      expect(typeof span?.started_at).toBe("string");
      return span?.trace_id;
    });
    expect(result).toBe("tr-abc");
  });

  it("trace_id_does_not_leak_after_withTrace_returns", () => {
    withTrace("tr-leaked", () => {
      expect(getTraceId()).toBe("tr-leaked");
    });
    expect(getTraceId()).toBeUndefined();
  });

  it("withTrace_propagates_across_await_microtask", async () => {
    const captured = await withTrace("tr-await", async () => {
      await Promise.resolve();
      await new Promise((r) => setImmediate(r));
      return getTraceId();
    });
    expect(captured).toBe("tr-await");
  });

  it("withTrace_supports_return_value", () => {
    const v = withTrace("tr-rv", () => 42);
    expect(v).toBe(42);
  });

  it("withTrace_supports_promise_return", async () => {
    const v = await withTrace("tr-promise", () => Promise.resolve("ok"));
    expect(v).toBe("ok");
  });
});

describe("trace — withSpan (CAP-OBS-02)", () => {
  it("withSpan_inherits_parent_trace_id", () => {
    withTrace("tr-parent", () => {
      withSpan((span) => {
        expect(span.trace_id).toBe("tr-parent");
        expect(span.parent_span_id).toBeDefined();
        expect(span.parent_span_id).toMatch(/^sp-/);
        expect(span.span_id).toMatch(/^sp-/);
      });
    });
  });

  it("nested_withSpan_chains_parent_span_id", () => {
    withTrace("tr-nested", () => {
      withSpan((outer) => {
        withSpan((inner) => {
          expect(inner.trace_id).toBe("tr-nested");
          expect(inner.parent_span_id).toBe(outer.span_id);
        });
      });
    });
  });

  it("withSpan_outside_parent_creates_root", () => {
    let captured: string | undefined;
    withSpan((span) => {
      expect(span.parent_span_id).toBeUndefined();
      captured = span.trace_id;
    });
    expect(captured).toMatch(/^tr-/);
  });

  it("withSpan_passes_span_to_callback", () => {
    withSpan((span) => {
      expect(span.trace_id).toBeDefined();
      expect(span.span_id).toBeDefined();
      expect(span.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
});

describe("trace — setAttribute (CAP-OBS-02)", () => {
  it("setAttribute_writes_to_current_span", () => {
    withTrace("tr-attr", () => {
      setAttribute("intent.type", "feature");
      setAttribute("debate.rounds", 2);
      const span = getCurrentSpan();
      expect(span?.attributes["intent.type"]).toBe("feature");
      expect(span?.attributes["debate.rounds"]).toBe(2);
    });
  });

  it("setAttribute_is_silent_outside_context", () => {
    expect(() => setAttribute("k", "v")).not.toThrow();
    expect(getCurrentSpan()).toBeUndefined();
  });
});

describe("trace — traceBindings (CAP-OBS-02)", () => {
  it("returns_empty_outside_context", () => {
    expect(traceBindings()).toEqual({});
  });

  it("returns_trace_id_and_span_id_inside_context", () => {
    withTrace("tr-bindings", () => {
      const b = traceBindings();
      expect(b.trace_id).toBe("tr-bindings");
      expect(typeof b.span_id).toBe("string");
    });
  });
});
