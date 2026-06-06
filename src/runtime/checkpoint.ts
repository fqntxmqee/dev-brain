/**
 * CheckpointManager — CAP-RT-01
 *
 * 责任:
 *  - 把任务执行状态原子写到 ~/.dev-brain/checkpoints/{trace_id}.json
 *  - 滚动保留最近 N 个 ({trace_id}.{n}.json,n=0 是最新)
 *  - 读最新 checkpoint 用于续跑
 *  - 列出所有 in_progress 的 checkpoint (供 ResumeManager)
 *
 * 写盘策略: writeFile(tmp) → rename(tmp, real) (原子,POSIX 保证)
 * 失败策略: 抛 CheckpointWriteError,调用方降级
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { defaultLogger, type Logger } from "../core/logger.js";
import { CheckpointWriteError, type CheckpointSnapshot } from "./types.js";

export interface CheckpointManagerDeps {
  readonly checkpointDir: string;
  readonly maxKeep: number;
  readonly logger?: Logger;
  readonly now?: () => Date;
}

export class CheckpointManager {
  private readonly checkpointDir: string;
  private readonly maxKeep: number;
  private readonly logger: Logger;

  constructor(deps: CheckpointManagerDeps) {
    this.checkpointDir = deps.checkpointDir;
    this.maxKeep = Math.max(1, deps.maxKeep);
    this.logger =
      deps.logger ?? defaultLogger.child({ component: "checkpoint" });
  }

  /** 写 checkpoint。原子:先 tmp 再 rename。 */
  async write(snapshot: CheckpointSnapshot): Promise<void> {
    await this.ensureDir();
    const realPath = this.pathFor(snapshot.trace_id, 0);
    const tmpPath = `${realPath}.tmp.${Date.now()}`;
    const payload = JSON.stringify(snapshot, null, 2);
    try {
      await fs.writeFile(tmpPath, payload, { encoding: "utf-8", mode: 0o644 });
      await fs.rename(tmpPath, realPath);
      await this.rotate(snapshot.trace_id);
      this.logger.debug("checkpoint written", {
        trace_id: snapshot.trace_id,
        step: snapshot.current_step,
        completed: snapshot.completed_subtasks.length,
        pending: snapshot.pending_subtasks.length,
      });
    } catch (err) {
      // 清理 tmp(best effort)
      try {
        await fs.unlink(tmpPath);
      } catch {
        /* ignore */
      }
      throw new CheckpointWriteError(snapshot.trace_id, err);
    }
  }

  /** 读最新 checkpoint。返回 null 表示无。 */
  async readLatest(traceId: string): Promise<CheckpointSnapshot | null> {
    try {
      const buf = await fs.readFile(this.pathFor(traceId, 0), "utf-8");
      return JSON.parse(buf) as CheckpointSnapshot;
    } catch (err) {
      if (this.isNotFound(err)) return null;
      throw err;
    }
  }

  /** 列所有 in_progress 的 trace_id (扫 dir,只读最新一份) */
  async listInProgress(): Promise<ReadonlyArray<CheckpointSnapshot>> {
    await this.ensureDir();
    let entries: string[];
    try {
      entries = await fs.readdir(this.checkpointDir);
    } catch (err) {
      if (this.isNotFound(err)) return [];
      throw err;
    }
    // 只看 *.0.json (最新)
    const candidates = entries.filter((n) => n.endsWith(".0.json"));
    const out: CheckpointSnapshot[] = [];
    for (const name of candidates) {
      try {
        const buf = await fs.readFile(join(this.checkpointDir, name), "utf-8");
        const snap = JSON.parse(buf) as CheckpointSnapshot;
        if (snap.state === "in_progress") out.push(snap);
      } catch (err) {
        this.logger.warn("checkpoint read failed; skipping", {
          name,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }

  /** 删除某 trace 的所有 checkpoint(用户取消时清理) */
  async clear(traceId: string): Promise<void> {
    await this.ensureDir();
    const entries = await fs.readdir(this.checkpointDir);
    const prefix = `${traceId}.`;
    for (const name of entries) {
      if (name.startsWith(prefix)) {
        await fs.unlink(join(this.checkpointDir, name)).catch(() => {});
      }
    }
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.checkpointDir, { recursive: true });
  }

  private pathFor(traceId: string, idx: number): string {
    // 避免 trace_id 含 path 字符
    const safe = traceId.replace(/[^A-Za-z0-9._-]/g, "_");
    return join(this.checkpointDir, `${safe}.${idx}.json`);
  }

  /**
   * 旋转: {trace}.0 (刚写) → 老的 (n-1) → n,超过 maxKeep 删除
   * 实现: 倒着扫,每个 i → i+1,最早的删除
   */
  private async rotate(traceId: string): Promise<void> {
    // {trace}.0 是刚写入的;之前还有 {trace}.0_prev(rename 来的),需要先移走
    // 实际更简单:每次 write 都把当前 .0 → .1, .1 → .2 ... 但 .0 已被新文件占
    // 用临时方案: rename 顺序: .{n-1} → .{n}, ..., .0 → .1
    // 但 .0 已被新写,所以需要先在 write 前 rotate
    // 这里 rotate 在 write 之后调用,需要不同策略:
    // 把刚写的 .0 改名到 .new,然后 shift 旧的,再把 .new → .0
    const newRealPath = this.pathFor(traceId, 0);
    const stash = `${newRealPath}.new`;
    try {
      // 把刚写的 .0 临时藏到 .new
      await fs.rename(newRealPath, stash);
      // shift 旧文件
      for (let i = this.maxKeep - 1; i >= 1; i--) {
        const src = this.pathFor(traceId, i - 1);
        const dst = this.pathFor(traceId, i);
        try {
          await fs.rename(src, dst);
        } catch (err) {
          if (!this.isNotFound(err)) throw err;
        }
      }
      // 删除超过 maxKeep 的
      try {
        await fs.unlink(this.pathFor(traceId, this.maxKeep));
      } catch (err) {
        if (!this.isNotFound(err)) throw err;
      }
      // 把刚写的 .new 还原成 .0
      await fs.rename(stash, newRealPath);
    } catch (err) {
      // rotate 失败不抛(checkpoint 已写),但日志告警
      this.logger.warn("checkpoint rotate failed; keep latest", {
        trace_id: traceId,
        err: err instanceof Error ? err.message : String(err),
      });
      // 尝试恢复 .new → .0
      try {
        await fs.rename(stash, newRealPath);
      } catch {
        /* ignore */
      }
    }
  }

  private isNotFound(err: unknown): boolean {
    return (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    );
  }
}
