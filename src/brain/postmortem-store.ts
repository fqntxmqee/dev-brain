import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { redactPathInObject } from "../core/redact-path.js";
import type { BrainTaskResult } from "../core/types.js";
import { redactMessage } from "../core/redact.js";

export interface PostmortemEntry {
  readonly taskId: string;
  readonly shortId: string;
  readonly success: boolean;
  readonly description: string;
  readonly createdAt: string;
  readonly completedAt: string;
  readonly subTaskOutputs: ReadonlyArray<{
    readonly subTaskId: string;
    readonly runtime: string;
    readonly output: string;
  }>;
  readonly summary: string;
}

export interface PostmortemStoreOptions {
  readonly dataDir: string;
  readonly now?: () => Date;
}

const FILE_EXT = ".json";

function isoForFilename(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * 任务结束落盘（CAP-BRAIN-08 / T-62 / T-65）。
 * 路径：{dataDir}/postmortem/{shortId}-{isoTs}.json
 * 写入：writeFile(.tmp) → rename，原子。
 * 内容：子任务输出 + summary；路径/凭据自动脱敏。
 */
export class PostmortemStore {
  private readonly dataDir: string;
  private readonly now: () => Date;

  constructor(options: PostmortemStoreOptions) {
    this.dataDir = options.dataDir;
    this.now = options.now ?? (() => new Date());
  }

  postmortemDir(): string {
    return join(this.dataDir, "postmortem");
  }

  async write(result: BrainTaskResult): Promise<string> {
    const dir = this.postmortemDir();
    await mkdir(dir, { recursive: true });
    const shortId = result.taskId.slice(0, 12);
    const ts = isoForFilename(this.now());
    const file = join(dir, `${shortId}-${ts}${FILE_EXT}`);
    const entry: PostmortemEntry = {
      taskId: result.taskId,
      shortId,
      success: result.success,
      description: "", // 视调用方补充；brain 调用处已合并
      createdAt: new Date(0).toISOString(),
      completedAt: this.now().toISOString(),
      subTaskOutputs: result.subTaskOutputs.map((o) => ({
        subTaskId: o.subTaskId,
        runtime: o.runtime,
        output: redactMessage(o.output),
      })),
      summary: redactMessage(result.summary),
    };
    const redacted = redactPathInObject(entry) as PostmortemEntry;
    const tmp = `${file}.tmp.new`;
    await writeFile(tmp, JSON.stringify(redacted, null, 2), "utf8");
    await rename(tmp, file);
    return file;
  }

  async read(shortIdOrPath: string): Promise<PostmortemEntry | undefined> {
    const file = shortIdOrPath.endsWith(FILE_EXT)
      ? shortIdOrPath
      : join(this.postmortemDir(), `${shortIdOrPath}${FILE_EXT}`);
    try {
      const raw = await readFile(file, "utf8");
      return JSON.parse(raw) as PostmortemEntry;
    } catch {
      return undefined;
    }
  }
}

/** @internal 测试导出 */
export const _internals = { isoForFilename };
