import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FilePlanStore,
  InMemoryPlanStore,
} from "../../src/brain/plan-store.js";

describe("PlanStore", () => {
  it("FilePlanStore returns undefined when file missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plan-store-"));
    const store = new FilePlanStore(join(dir, "missing.json"));
    expect(await store.load()).toBeUndefined();
  });

  it("FilePlanStore roundtrips state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plan-store-"));
    const path = join(dir, "state.json");
    const store = new FilePlanStore(path);

    const state = {
      version: 1 as const,
      pendingByChat: {
        oc_x: {
          taskId: "t1",
          chatId: "oc_x",
          description: "test",
          subTasks: [],
          phase: "awaiting_approval" as const,
          createdAt: "2026-06-05T00:00:00Z",
          summary: "sum",
        },
      },
      completed: [],
    };

    await store.save(state);
    const loaded = await store.load();
    expect(loaded?.pendingByChat["oc_x"]?.taskId).toBe("t1");
  });

  it("FilePlanStore ignores version mismatch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plan-store-"));
    const path = join(dir, "state.json");
    await writeFile(path, JSON.stringify({ version: 99, foo: "bar" }), "utf8");

    const store = new FilePlanStore(path);
    expect(await store.load()).toBeUndefined();
  });

  it("InMemoryPlanStore roundtrips", async () => {
    const store = new InMemoryPlanStore();
    expect(await store.load()).toBeUndefined();
    await store.save({
      version: 1,
      pendingByChat: {},
      completed: [],
    });
    const loaded = await store.load();
    expect(loaded?.version).toBe(1);
  });

  it("FilePlanStore writes valid JSON file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plan-store-"));
    const path = join(dir, "state.json");
    const store = new FilePlanStore(path);
    await store.save({ version: 1, pendingByChat: {}, completed: [] });
    const raw = await readFile(path, "utf8");
    expect(JSON.parse(raw).version).toBe(1);
  });
});
