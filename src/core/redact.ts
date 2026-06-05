/**
 * 错误脱敏：去除消息中潜在的密钥 / 凭证。
 *
 * 场景：DevBrainError.safeMessage 用于飞书回包 / 审计日志 / 用户面。
 * 若错误链路上含 token / API key，落到第三方前需先脱敏。
 *
 * 规则：
 * - 形如 sk-***、gho_***、xoxb-***、***.***.*** 的 token 替为 [REDACTED]
 * - Bearer <token> 替为 Bearer [REDACTED]
 * - env=value 中的 value 包含敏感前缀时整段替
 *
 * 仅做粗粒度遮盖，**不**保证 100% 安全（无法识别所有变种）。
 * 真正敏感场景应避免把原始 message 暴露到外部。
 */
const TOKEN_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgho_[A-Za-z0-9]{16,}\b/g,
  /\bxoxb-[A-Za-z0-9-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
];

const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._\-+/=]{16,}/gi;

const SENSITIVE_KEY_PATTERN =
  /(api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*([^\s,;}"']+)/gi;

function redactSingle(s: string): string {
  let out = s;
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  out = out.replace(BEARER_PATTERN, "Bearer [REDACTED]");
  out = out.replace(SENSITIVE_KEY_PATTERN, (_m, key) => `${key}=[REDACTED]`);
  return out;
}

export function redactMessage(input: string): string {
  return redactSingle(input);
}

export function redactError(err: unknown): string {
  const base =
    err === null || err === undefined
      ? "Unknown error"
      : typeof err === "string"
        ? err
        : err instanceof Error
          ? err.message || err.name
          : String(err);
  return redactSingle(base);
}
