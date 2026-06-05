/**
 * 轻量结构化 JSON logger。
 * 输出到 stderr（与 stdout 业务输出分流）。
 * 字段：level / time / msg / ...extra
 *
 * 设计：避免引入 pino / winston 依赖。
 * 后续如需按 level 过滤或转写到 file，扩展 Logger interface 即可。
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function parseLevel(env: NodeJS.ProcessEnv): LogLevel {
  const raw = (env.DEV_BRAIN_LOG_LEVEL ?? "info").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

export class JsonLogger implements Logger {
  private readonly minRank: number;
  private readonly bindings: Record<string, unknown>;

  constructor(
    bindings: Record<string, unknown> = {},
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.minRank = LEVEL_RANK[parseLevel(env)];
    this.bindings = bindings;
  }

  debug(msg: string, extra?: Record<string, unknown>): void {
    this.log("debug", msg, extra);
  }
  info(msg: string, extra?: Record<string, unknown>): void {
    this.log("info", msg, extra);
  }
  warn(msg: string, extra?: Record<string, unknown>): void {
    this.log("warn", msg, extra);
  }
  error(msg: string, extra?: Record<string, unknown>): void {
    this.log("error", msg, extra);
  }

  child(bindings: Record<string, unknown>): Logger {
    return new JsonLogger({ ...this.bindings, ...bindings });
  }

  private log(
    level: LogLevel,
    msg: string,
    extra?: Record<string, unknown>,
  ): void {
    if (LEVEL_RANK[level] < this.minRank) return;
    const entry = {
      level,
      time: new Date().toISOString(),
      ...this.bindings,
      msg,
      ...(extra ?? {}),
    };
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  }
}

export const defaultLogger: Logger = new JsonLogger({ component: "dev-brain" });
