/**
 * 路径脱敏（CAP-ERR-04 / T-55）。
 * - $HOME → ~
 * - /Users/<user>/... → /Users/<user>/...
 * - /home/<user>/... → /home/<user>/...
 * - 原始路径仅进 logger.error，不暴露给用户面
 */
const REDACT_PATH_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\$HOME/g, "~"],
  [/\/Users\/[^/]+/g, "/Users/<user>"],
  [/\/home\/[^/]+/g, "/home/<user>"],
];

export function redactPath(input: string): string {
  let out = input;
  for (const [re, replacement] of REDACT_PATH_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

export function redactPathInObject<T>(value: T): T {
  if (typeof value === "string") {
    return redactPath(value) as unknown as T;
  }
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => redactPathInObject(v)) as unknown as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactPathInObject(v);
    }
    return out as T;
  }
  return value;
}
