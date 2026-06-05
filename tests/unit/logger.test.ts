import { describe, expect, it, vi } from "vitest";
import { JsonLogger } from "../../src/core/logger.js";

describe("JsonLogger", () => {
  it("emits_JSON_line_to_stderr_at_info_level", () => {
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });

    try {
      const logger = new JsonLogger(
        { component: "test" },
        { DEV_BRAIN_LOG_LEVEL: "info" },
      );
      logger.info("hello", { foo: 1 });
      expect(writes).toHaveLength(1);
      const line = writes[0]!.replace(/\n$/, "");
      const parsed = JSON.parse(line);
      expect(parsed.level).toBe("info");
      expect(parsed.msg).toBe("hello");
      expect(parsed.foo).toBe(1);
      expect(parsed.component).toBe("test");
      expect(parsed.time).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("respects_level_filter", () => {
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
    try {
      const logger = new JsonLogger({}, { DEV_BRAIN_LOG_LEVEL: "warn" });
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");
      const levels = writes.map((w) => JSON.parse(w.replace(/\n$/, "")).level);
      expect(levels).toEqual(["warn", "error"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("child_merges_bindings", () => {
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
    try {
      const logger = new JsonLogger({ component: "x" }, {});
      const child = logger.child({ requestId: "r1" });
      child.info("hi");
      const parsed = JSON.parse(writes[0]!.replace(/\n$/, ""));
      expect(parsed.component).toBe("x");
      expect(parsed.requestId).toBe("r1");
    } finally {
      spy.mockRestore();
    }
  });

  it("falls_back_to_info_for_invalid_level_env", () => {
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
    try {
      const logger = new JsonLogger({}, { DEV_BRAIN_LOG_LEVEL: "garbage" });
      logger.debug("d");
      logger.info("i");
      const levels = writes.map((w) => JSON.parse(w.replace(/\n$/, "")).level);
      expect(levels).toEqual(["info"]);
    } finally {
      spy.mockRestore();
    }
  });
});
