/**
 * ProgressReporter — CAP-RT-06
 *
 * 周期性写进度文件到 ~/.dev-brain/runtime/{trace_id}.json
 * 给飞书 /status 命令读 / Grafana 看板用。
 *
 * 用法:
 *   const reporter = new ProgressReporter({ progressDir, intervalSec: 30 });
 *   await reporter.update({ trace_id, ..., progress_pct: 65 });
 *   const latest = await reporter.read(trace_id);
 *
 * 注意: 写盘频率受 intervalSec 限流(同一 trace 最多 N 秒一次)
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { defaultLogger, type Logger } from "../core/logger.js";
import type { ProgressSnapshot } from "./types.js";

export interface ProgressReporterDeps {
  readonly progressDir: string;
  readonly intervalSec: number;
  readonly logger?: Logger;
  readonly now?: () => Date;
}

export class ProgressReporter {
  private readonly progressDir: string;
  private readonly intervalMs: number;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly lastWrite = new Map<string, number>();

  constructor(deps: ProgressReporterDeps) {
    this.progressDir = deps.progressDir;
    this.intervalMs = Math.max(1, deps.intervalSec) * 1000;
    this.logger =
      deps.logger ?? defaultLogger.child({ component: "progress-reporter" });
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * 写进度(限流: 同一 trace 距上次 < intervalMs 时跳过,除非 force=true)
   */
  async update(snapshot: ProgressSnapshot, force = false): Promise<boolean> {
    const lastTs = this.lastWrite.get(snapshot.trace_id) ?? 0;
    const nowMs = this.now().getTime();
    if (!force && nowMs - lastTs < this.intervalMs) {
      return false;
    }
    await this.ensureDir();
    const path = this.pathFor(snapshot.trace_id);
    const tmp = `${path}.tmp.${nowMs}`;
    const payload = JSON.stringify(
      { ...snapshot, updated_at: this.now().toISOString() },
      null,
      2,
    );
    try {
      await fs.writeFile(tmp, payload, { encoding: "utf-8", mode: 0o644 });
      await fs.rename(tmp, path);
      this.lastWrite.set(snapshot.trace_id, nowMs);
      return true;
    } catch (err) {
      try {
        await fs.unlink(tmp);
      } catch {
        /* ignore */
      }
      this.logger.warn("progress write failed", {
        trace_id: snapshot.trace_id,
        err: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async read(traceId: string): Promise<ProgressSnapshot | null> {
    try {
      const buf = await fs.readFile(this.pathFor(traceId), "utf-8");
      return JSON.parse(buf) as ProgressSnapshot;
    } catch (err) {
      if (this.isNotFound(err)) return null;
      throw err;
    }
  }

  /** 列所有进度文件 (供 dashboard) */
  async listAll(): Promise<ReadonlyArray<ProgressSnapshot>> {
    await this.ensureDir();
    let entries: string[];
    try {
      entries = await fs.readdir(this.progressDir);
    } catch (err) {
      if (this.isNotFound(err)) return [];
      throw err;
    }
    const out: ProgressSnapshot[] = [];
    for (const name of entries.filter((n) => n.endsWith(".json"))) {
      try {
        const buf = await fs.readFile(join(this.progressDir, name), "utf-8");
        out.push(JSON.parse(buf) as ProgressSnapshot);
      } catch (err) {
        this.logger.warn("progress read failed; skipping", {
          name,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }

  async clear(traceId: string): Promise<void> {
    try {
      await fs.unlink(this.pathFor(traceId));
    } catch (err) {
      if (!this.isNotFound(err)) throw err;
    }
    this.lastWrite.delete(traceId);
  }

  private pathFor(traceId: string): string {
    const safe = traceId.replace(/[^A-Za-z0-9._-]/g, "_");
    return join(this.progressDir, `${safe}.json`);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.progressDir, { recursive: true });
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

/** 计算 ETA(基于已完成子任务平均耗时) */
export function computeEta(
  elapsedSec: number,
  completedCount: number,
  pendingCount: number,
): number {
  if (completedCount === 0) return 0; // 不可估
  const avg = elapsedSec / completedCount;
  return Math.round(avg * pendingCount);
}

/** 计算进度百分比 */
export function computeProgressPct(
  completedCount: number,
  totalCount: number,
): number {
  if (totalCount === 0) return 100;
  return Math.round((completedCount / totalCount) * 100);
}
