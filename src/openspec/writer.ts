/**
 * OpenSpecWriter — 把 OpenSpecArtifact 写到磁盘 (Phase A.6)
 *
 * 目录结构:
 *   {rootDir}/{changeId}/
 *     ├── proposal.md
 *     ├── tasks.md
 *     └── specs/{component}/spec.md
 *
 * 写盘策略: 与 CheckpointManager 一致 — writeFile(tmp) + rename(tmp, real)
 * (POSIX 原子保证,防止写到一半进程崩溃留下半个文件)
 *
 * 失败: 抛 OpenSpecWriteError,完整路径和原因。调用方降级。
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { defaultLogger, type Logger } from "../core/logger.js";
import type { OpenSpecArtifact } from "./generator.js";

export interface OpenSpecWriterDeps {
  readonly rootDir: string;
  readonly logger?: Logger;
  readonly now?: () => Date;
}

export interface OpenSpecWriteResult {
  readonly changeId: string;
  readonly rootPath: string;
  /** 写入的文件列表(相对 rootPath) */
  readonly files: ReadonlyArray<string>;
}

export class OpenSpecWriteError extends Error {
  readonly code = "OPENSPEC_WRITE_ERROR";
  readonly path: string;
  constructor(path: string, cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`OpenSpec write failed at ${path}: ${msg}`);
    this.name = "OpenSpecWriteError";
    this.path = path;
  }
}

export class OpenSpecWriter {
  private readonly rootDir: string;
  private readonly logger: Logger;

  constructor(deps: OpenSpecWriterDeps) {
    this.rootDir = deps.rootDir;
    this.logger = deps.logger ?? defaultLogger.child({ component: "openspec" });
  }

  /**
   * 把 artifact 写到 {rootDir}/{changeId}/ 下。
   * 已存在的目录会先备份到 {rootDir}/{changeId}.bak.{ts} 再覆盖。
   */
  async write(artifact: OpenSpecArtifact): Promise<OpenSpecWriteResult> {
    const changeDir = join(this.rootDir, artifact.changeId);
    await this.safeMkdir(this.rootDir);
    await this.backupIfExists(changeDir);

    const files: string[] = [];
    try {
      await this.safeMkdir(changeDir);
      await this.writeFile(
        join(changeDir, "proposal.md"),
        artifact.proposal,
        files,
        "proposal.md",
      );
      await this.writeFile(
        join(changeDir, "tasks.md"),
        artifact.tasks,
        files,
        "tasks.md",
      );

      const specsDir = join(changeDir, "specs");
      for (const [component, content] of Object.entries(artifact.specs)) {
        const compDir = join(specsDir, component);
        await this.safeMkdir(compDir);
        await this.writeFile(
          join(compDir, "spec.md"),
          content,
          files,
          `specs/${component}/spec.md`,
        );
      }
    } catch (err) {
      throw err instanceof OpenSpecWriteError
        ? err
        : new OpenSpecWriteError(changeDir, err);
    }

    this.logger.info("openspec written", {
      change_id: artifact.changeId,
      files: files.length,
      root: changeDir,
    });
    return {
      changeId: artifact.changeId,
      rootPath: changeDir,
      files,
    };
  }

  /**
   * 原子写单个文件:tmp → rename。
   * 失败时清理 tmp(尽力)。
   * relPath 必传,记录在 accumulator 中,供 result.files 暴露。
   */
  private async writeFile(
    absPath: string,
    content: string,
    accumulator: string[],
    relPath: string,
  ): Promise<void> {
    const tmpPath = `${absPath}.tmp.${Date.now()}`;
    try {
      await fs.writeFile(tmpPath, content, {
        encoding: "utf-8",
        mode: 0o644,
      });
      await fs.rename(tmpPath, absPath);
      accumulator.push(relPath);
    } catch (err) {
      try {
        await fs.unlink(tmpPath);
      } catch {
        /* ignore */
      }
      throw new OpenSpecWriteError(absPath, err);
    }
  }

  private async safeMkdir(p: string): Promise<void> {
    await fs.mkdir(p, { recursive: true });
  }

  private async backupIfExists(changeDir: string): Promise<void> {
    try {
      await fs.stat(changeDir);
    } catch {
      return; // 不存在,不需备份
    }
    const ts = Date.now();
    const backup = `${changeDir}.bak.${ts}`;
    try {
      await fs.rename(changeDir, backup);
      this.logger.warn("openspec: previous change backed up", {
        from: changeDir,
        to: backup,
      });
    } catch (err) {
      // 备份失败不阻塞 — 写到原地会覆盖
      this.logger.warn("openspec: backup rename failed; will overwrite", {
        dir: changeDir,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
