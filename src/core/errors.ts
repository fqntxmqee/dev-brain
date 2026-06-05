import { redactMessage } from "./redact.js";

/**
 * 集中式错误类型。便于：
 * 1. 上游 instanceof 精确分支（不同 UI 文案 / 不同重试策略）
 * 2. 测试断言错误种类而非字符串匹配
 * 3. 错误脱敏：所有错误都带 sanitizedMessage，输出前自动脱敏
 */

export abstract class DevBrainError extends Error {
  abstract readonly code: string;
  /** 用户可安全看到的消息（已脱敏） */
  readonly safeMessage: string;
  /** 是否可重试 */
  readonly retryable: boolean;

  protected constructor(message: string, opts: { retryable?: boolean } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.safeMessage = redactMessage(message);
    this.retryable = opts.retryable ?? false;
  }
}

/** 配置缺失 / 解析失败 */
export class ConfigError extends DevBrainError {
  readonly code = "CONFIG_ERROR";
  constructor(message: string) {
    super(message, { retryable: false });
  }
}

/** 鉴权失败（allow_from 不匹配 / 凭证无效） */
export class AuthError extends DevBrainError {
  readonly code = "AUTH_ERROR";
  constructor(message: string) {
    super(message, { retryable: false });
  }
}

/** cc-connect HTTP / UDS 通信失败 */
export class AdapterError extends DevBrainError {
  readonly code = "ADAPTER_ERROR";
  constructor(
    message: string,
    opts: { retryable?: boolean } = { retryable: true },
  ) {
    super(message, opts);
  }
}

/** WebSocket 协议错误 / 解析失败 */
export class ProtocolError extends DevBrainError {
  readonly code = "PROTOCOL_ERROR";
  constructor(message: string) {
    super(message, { retryable: true });
  }
}

/** 飞书网关错误（lark-cli 退出非 0 / stdout 关闭） */
export class GatewayError extends DevBrainError {
  readonly code = "GATEWAY_ERROR";
  constructor(message: string, opts: { retryable?: boolean } = {}) {
    super(message, opts);
  }
}

/** 子任务计划 / 编排错误（依赖环、不存在等） */
export class PlanError extends DevBrainError {
  readonly code = "PLAN_ERROR";
  constructor(message: string) {
    super(message, { retryable: false });
  }
}

/** 文件锁冲突（沿用 governance 命名） */
export { LockConflictError } from "../governance/errors.js";
