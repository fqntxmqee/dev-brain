import { describe, expect, it } from "vitest";
import { AdapterRegistry } from "../../src/adapters/adapter-registry.js";
import { collectAdapterOutput } from "../../src/adapters/types.js";
import { loadConfig } from "../../src/config/env.js";

/** Covers: L5-BRAIN-03 (stub mode — 三 Runtime 各完成一次) */
describe("Adapter registry integration", () => {
  it("should_run_all_three_runtimes_in_stub_mode", async () => {
    const config = loadConfig({ DEV_BRAIN_ADAPTER_MODE: "stub" });
    const registry = AdapterRegistry.create(config);

    const outputs: string[] = [];
    for (const runtime of ["claude-code", "codex", "cursor"] as const) {
      const adapter = registry.get(runtime);
      const output = await collectAdapterOutput(adapter, {
        prompt: `phase2 smoke ${runtime}`,
        workDir: config.workDir,
        sessionKey: `test:${runtime}`,
      });
      outputs.push(output);
    }

    // v0.8.1: native backend stub message format (cursor 也走 LocalCursorAdapter)
    expect(outputs[0]).toContain("[claude-code native stub]");
    expect(outputs[1]).toContain("[codex native stub]");
    expect(outputs[2]).toContain("[cursor native stub]");
  });
});
