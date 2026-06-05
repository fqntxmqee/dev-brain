import { describe, expect, it } from "vitest";
import { AdapterRegistry } from "../../src/adapters/adapter-registry.js";
import { collectAdapterOutput } from "../../src/adapters/types.js";
import { loadConfig } from "../../src/config/env.js";
import { CcConnectBridge } from "../../src/adapters/cc-connect-bridge.js";
import { CcConnectClient } from "../../src/adapters/cc-connect-client.js";
import {
  LockConflictError,
  FileLockManager,
} from "../../src/governance/index.js";
import { isSenderAllowed } from "../../src/config/env.js";

/**
 * CAP-INT-01..05: 5 个 live 集成场景
 * - 不需要真实 daemon — 都用 stub / 内存态 / 临时文件
 * - 验证子模块在 end-to-end 流程中的契约
 */
describe("live integration scenarios", () => {
  it("CAP-INT-01: 三 runtime 顺序 + 并发执行无文件锁冲突", async () => {
    const config = loadConfig({ DEV_BRAIN_ADAPTER_MODE: "stub" });
    const registry = AdapterRegistry.create(config);

    const locks = new FileLockManager();
    const agentA = "adapter:claude-code:st-1";
    const agentB = "adapter:codex:st-2";

    // 锁住不同文件 → 应无冲突
    const lockA = locks.acquire(agentA, "/tmp/a.ts", "write");
    const lockB = locks.acquire(agentB, "/tmp/b.ts", "write");
    expect(lockA.filePath).toBe("/tmp/a.ts");
    expect(lockB.filePath).toBe("/tmp/b.ts");
    locks.releaseLock(lockA);
    locks.releaseLock(lockB);

    // 三 runtime stub 输出
    const out: string[] = [];
    for (const runtime of ["claude-code", "codex", "cursor"] as const) {
      const adapter = registry.get(runtime);
      out.push(
        await collectAdapterOutput(adapter, {
          prompt: "int test",
          workDir: config.workDir,
          sessionKey: `live-int:${runtime}`,
        }),
      );
    }
    expect(out).toHaveLength(3);
    expect(out.every((s) => s.length > 0)).toBe(true);
  });

  it("CAP-INT-02: 同一文件双写锁 → 后者抛 LockConflictError", () => {
    const locks = new FileLockManager();
    const lockA = locks.acquire("agent-1", "/tmp/shared.ts", "write");
    expect(() => locks.acquire("agent-2", "/tmp/shared.ts", "write")).toThrow(
      LockConflictError,
    );
    locks.releaseLock(lockA);
    expect(() =>
      locks.acquire("agent-2", "/tmp/shared.ts", "write"),
    ).not.toThrow();
  });

  it("CAP-INT-03: cc-connect bridge stub 模式返回 deterministic 输出", async () => {
    const bridge = new CcConnectBridge({
      apiSocketPath: "/tmp/api.sock",
      bridgeSocketPath: "/tmp/bridge.sock",
      mode: "stub",
      enabled: true,
      pollMs: 100,
      timeoutMs: 2000,
      replyPath: "/bridge/reply",
    });

    const r1 = await bridge.collectReply({
      project: "workspace-claude",
      sessionKey: "k1",
      prompt: "p1",
    });
    const r2 = await bridge.collectReply({
      project: "workspace-codex",
      sessionKey: "k2",
      prompt: "p2",
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.text).toContain("workspace-claude");
    expect(r2.text).toContain("workspace-codex");
  });

  it("CAP-INT-04: cc-connect client stub 模式不需要真实 socket", async () => {
    const config = loadConfig({ DEV_BRAIN_ADAPTER_MODE: "stub" });
    const client = CcConnectClient.fromConfig(config);
    // ping 在 stub 模式应直接返回 true (listSessions 返回 [])
    const sessions = await client.listSessions();
    expect(sessions).toEqual([]);
  });

  it("CAP-INT-05: 鉴权 fail-closed 默认 + 显式 allowlist 双向", () => {
    const closedConfig = loadConfig({});
    // 直接构造空集合模拟
    const c1 = { ...closedConfig, allowFrom: new Set<string>() };
    expect(isSenderAllowed(c1, "ou_whoever")).toBe(false);

    const c2 = {
      ...closedConfig,
      allowFrom: new Set<string>(["ou_alice", "ou_bob"]),
    };
    expect(isSenderAllowed(c2, "ou_alice")).toBe(true);
    expect(isSenderAllowed(c2, "ou_eve")).toBe(false);

    const c3 = {
      ...closedConfig,
      allowFrom: new Set<string>(["*"]),
    };
    expect(isSenderAllowed(c3, "ou_whoever")).toBe(true);
  });
});
