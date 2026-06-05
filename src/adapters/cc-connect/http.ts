import { connect } from "node:net";
import { request as httpRequest } from "node:http";

export interface UdsHttpResponse {
  readonly statusCode: number;
  readonly body: string;
}

/**
 * 把低级 UDS / HTTP 错误翻译成对运维友好的中文提示。
 * 错误码：ENOENT(2) / ECONNREFUSED(61)
 */
export function translateUdsError(
  err: unknown,
  method: string,
  path: string,
): Error {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return new Error(
        `cc-connect UDS socket 不存在（${path}）。请确认 cc-connect daemon 已启动。`,
      );
    }
    if (code === "ECONNREFUSED") {
      return new Error(
        `cc-connect daemon 拒绝连接（${path}）。请检查 cc-connect 进程是否在运行。`,
      );
    }
    if (code === "ETIMEDOUT" || code === "EAI_AGAIN") {
      return new Error(`cc-connect UDS 通信超时（${method} ${path}）。`);
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(`cc-connect UDS 错误（${method} ${path}）：${msg}`);
}

export function udsHttpRequest(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<UdsHttpResponse> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string | number> = {};
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }

    const req = httpRequest(
      {
        socketPath,
        path,
        method,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer | string) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode ?? 0, body: data });
        });
      },
    );

    req.on("error", (err) => reject(translateUdsError(err, method, path)));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`UDS request timeout: ${method} ${path}`));
    });

    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

export async function isSocketReachable(
  socketPath: string,
  timeoutMs = 2_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export interface CcConnectSessionInfo {
  readonly project: string;
  readonly session_key: string;
  readonly platform?: string;
}

export function parseSessionsBody(
  body: string,
): ReadonlyArray<CcConnectSessionInfo> {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item): item is CcConnectSessionInfo =>
        typeof item === "object" &&
        item !== null &&
        "project" in item &&
        "session_key" in item &&
        typeof (item as CcConnectSessionInfo).project === "string" &&
        typeof (item as CcConnectSessionInfo).session_key === "string",
    );
  } catch {
    return [];
  }
}
