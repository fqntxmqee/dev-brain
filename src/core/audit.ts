/**
 * 审计日志：append-only JSONL 文件，~/.cc-connect/dev-brain-audit.log
 * 记录敏感操作：鉴权拒绝 / 计划创建 / 批准 / 取消 / 任务完成
 *
 * 设计：append-only、不可改、含时间戳 + 事件名 + 上下文
 * 不输出 message 内容（避免敏感数据落入审计文件）
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type AuditEventType =
  | "auth.deny"
  | "auth.allow"
  | "plan.create"
  | "plan.approve"
  | "plan.cancel"
  | "task.complete"
  | "task.fail"
  | "shutdown"
  | "doctor.fail";

export interface AuditEvent {
  readonly type: AuditEventType;
  readonly actor?: string;
  readonly chatId?: string;
  readonly taskId?: string;
  readonly reason?: string;
  readonly [k: string]: unknown;
}

export interface AuditLogger {
  emit(event: AuditEvent): Promise<void> | void;
}

const DEFAULT_PATH = join(homedir(), ".cc-connect", "dev-brain-audit.log");

export class FileAuditLogger implements AuditLogger {
  constructor(
    private readonly path: string = DEFAULT_PATH,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async emit(event: AuditEvent): Promise<void> {
    const line = JSON.stringify({
      time: new Date(this.now()).toISOString(),
      ...event,
    });
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${line}\n`, "utf8");
  }
}

export class InMemoryAuditLogger implements AuditLogger {
  readonly events: AuditEvent[] = [];
  emit(event: AuditEvent): void {
    this.events.push(event);
  }
}
