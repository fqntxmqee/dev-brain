/**
 * 简单的 JSON 状态持久化。
 * 写入：~/.cc-connect/dev-brain-state.json
 * 字段：pendingByChat（待审批计划）、completed（已完成结果，最近 50 条）
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { BrainTaskPlan, BrainTaskResult } from "../core/types.js";

export interface PersistedState {
  readonly version: 1;
  readonly pendingByChat: Readonly<Record<string, BrainTaskPlan>>;
  readonly completed: ReadonlyArray<BrainTaskResult>;
}

export interface PlanStore {
  load(): Promise<PersistedState | undefined>;
  save(state: PersistedState): Promise<void>;
}

const DEFAULT_PATH = join(homedir(), ".cc-connect", "dev-brain-state.json");

export class FilePlanStore implements PlanStore {
  constructor(private readonly path: string = DEFAULT_PATH) {}

  async load(): Promise<PersistedState | undefined> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed.version !== 1) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  async save(state: PersistedState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await writeFile(this.path, JSON.stringify(state, null, 2), "utf8");
  }
}

export class InMemoryPlanStore implements PlanStore {
  private current: PersistedState | undefined;
  async load(): Promise<PersistedState | undefined> {
    return this.current;
  }
  async save(state: PersistedState): Promise<void> {
    this.current = state;
  }
}
