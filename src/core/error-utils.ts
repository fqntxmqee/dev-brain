/**
 * 统一的 error → string 工具。
 * 解决以下问题：
 * 1. 现有 6+ 处手写 `err instanceof Error ? err.message : String(err)`
 * 2. 未知错误（throw "literal" / throw 123）需安全降级
 * 3. DevBrainError 子类用 safeMessage 字段
 */

export function toErrorMessage(err: unknown): string {
  if (err === null || err === undefined) return "Unknown error";
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    if ("safeMessage" in err && typeof err.safeMessage === "string") {
      return err.safeMessage;
    }
    return err.message || err.name || "Unknown error";
  }
  try {
    return String(err);
  } catch {
    return "Unstringifiable error";
  }
}

/** 仅返回错误名（用于日志） */
export function toErrorName(err: unknown): string {
  if (err === null || err === undefined) return "UnknownError";
  if (typeof err === "string") return "StringThrown";
  if (err instanceof Error) return err.name || "Error";
  return typeof err;
}

/**
 * 判断是否为模块找不到错误：
 * - Node 18+: code === 'ERR_MODULE_NOT_FOUND'
 * - 旧版 / ESM 内部: message 含 "Cannot find package"
 */
export function isModuleNotFound(err: unknown, moduleName?: string): boolean {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: string }).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      if (!moduleName) return true;
      const msg = err instanceof Error ? err.message : String(err);
      return msg.includes(moduleName);
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("Cannot find package")) {
    if (!moduleName) return true;
    return msg.includes(moduleName);
  }
  return false;
}
