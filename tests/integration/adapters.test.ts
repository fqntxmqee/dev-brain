import { describe, expect, it } from 'vitest';
import { AdapterRegistry } from '../../src/adapters/adapter-registry.js';
import { collectAdapterOutput } from '../../src/adapters/types.js';
import { loadConfig } from '../../src/config/env.js';

/** Covers: L5-BRAIN-03 (stub mode — 三 Runtime 各完成一次) */
describe('Adapter registry integration', () => {
  it('should_run_all_three_runtimes_in_stub_mode', async () => {
    const config = loadConfig({ DEV_BRAIN_ADAPTER_MODE: 'stub' });
    const registry = new AdapterRegistry(config);

    const outputs: string[] = [];
    for (const runtime of ['claude-code', 'codex', 'cursor'] as const) {
      const adapter = registry.get(runtime);
      const output = await collectAdapterOutput(adapter, {
        prompt: `phase2 smoke ${runtime}`,
        workDir: config.workDir,
        sessionKey: `test:${runtime}`,
      });
      outputs.push(output);
    }

    expect(outputs[0]).toContain('[bridge stub/workspace-claude]');
    expect(outputs[1]).toContain('[bridge stub/workspace-codex]');
    expect(outputs[2]).toContain('[cursor stub]');
  });
});
