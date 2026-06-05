import { udsHttpRequest } from "./http.js";
import type { AdapterMode, DevBrainConfig } from "../../config/env.js";

export interface BridgeReplyRequest {
  readonly project: string;
  readonly sessionKey: string;
  readonly prompt: string;
}

export interface BridgeReplyResult {
  readonly ok: boolean;
  readonly text?: string;
  readonly error?: string;
  readonly source: "stub" | "bridge-http" | "bridge-ws" | "skipped";
}

export interface CcConnectBridgeOptions {
  readonly apiSocketPath: string;
  readonly bridgeSocketPath: string;
  readonly mode: AdapterMode;
  readonly enabled: boolean;
  readonly pollMs: number;
  readonly timeoutMs: number;
  readonly replyPath: string;
  /** T-59: WS 重试最大次数（默认 3） */
  readonly wsMaxRetries?: number;
  /** T-59: WS 重试基础退避 ms（默认 500，指数退避 base*2^n） */
  readonly wsRetryBackoffMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildReplyQuery(
  path: string,
  project: string,
  sessionKey: string,
): string {
  const params = new URLSearchParams({
    project,
    session_key: sessionKey,
  });
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}${params.toString()}`;
}

function parseBridgeBody(body: string): {
  text?: string;
  done?: boolean;
  pending?: boolean;
} {
  try {
    return JSON.parse(body) as {
      text?: string;
      done?: boolean;
      pending?: boolean;
    };
  } catch {
    const trimmed = body.trim();
    return trimmed ? { text: trimmed, done: true } : {};
  }
}

/** T-58: 错误前缀（运维/CI grep 用） */
const BRIDGE_STATE_PREFIX = "[bridge:state]";

/**
 * 收集 cc-connect 异步 agent 回复。
 * live + send 模式下轮询 Bridge HTTP；stub 模式返回模拟回复。
 */
export class CcConnectBridge {
  private readonly options: CcConnectBridgeOptions;
  private readonly wsMaxRetries: number;
  private readonly wsRetryBackoffMs: number;

  constructor(options: CcConnectBridgeOptions) {
    this.options = options;
    this.wsMaxRetries = options.wsMaxRetries ?? 3;
    this.wsRetryBackoffMs = options.wsRetryBackoffMs ?? 500;
  }

  static fromConfig(config: DevBrainConfig): CcConnectBridge {
    return new CcConnectBridge({
      apiSocketPath: config.ccConnectSocket,
      bridgeSocketPath: config.ccBridgeSocket,
      mode: config.adapterMode,
      enabled:
        config.ccBridgeEnabled &&
        config.adapterMode === "live" &&
        config.ccSyncMode === "send",
      pollMs: config.ccBridgePollMs,
      timeoutMs: config.ccBridgeTimeoutMs,
      replyPath: config.ccBridgeReplyPath,
    });
  }

  shouldCollectAfterDispatch(): boolean {
    return this.options.enabled;
  }

  async collectReply(request: BridgeReplyRequest): Promise<BridgeReplyResult> {
    if (this.options.mode === "stub") {
      return {
        ok: true,
        source: "stub",
        text: `[bridge stub/${request.project}] ${request.prompt.slice(0, 120)}`,
      };
    }

    if (!this.options.enabled) {
      return {
        ok: false,
        source: "skipped",
        error: `${BRIDGE_STATE_PREFIX} bridge disabled`,
      };
    }

    const wsResult = await this.tryWebSocketReplyWithRetry(request);
    if (wsResult.ok && wsResult.text) {
      return wsResult;
    }
    // WS 失败 → HTTP 兜底，附 WS 失败原因便于诊断
    const http = await this.pollHttpReply(request);
    if (!http.ok && http.error && !wsResult.text) {
      return {
        ...http,
        error: `${http.error}; ws=${wsResult.error ?? "empty"}`,
      };
    }
    return http;
  }

  /** T-59: WS 重连指数退避（默认 3 次：500ms / 1s / 2s） */
  private async tryWebSocketReplyWithRetry(
    request: BridgeReplyRequest,
  ): Promise<BridgeReplyResult> {
    let lastError = "ws not attempted";
    for (let attempt = 0; attempt < this.wsMaxRetries; attempt += 1) {
      const result = await this.tryWebSocketReplyOnce(request);
      if (result.ok && result.text) {
        return result;
      }
      lastError = result.error ?? "empty ws reply";
      if (attempt < this.wsMaxRetries - 1) {
        const backoff = this.wsRetryBackoffMs * 2 ** attempt;
        await sleep(backoff);
      }
    }
    return {
      ok: false,
      source: "bridge-ws",
      error: `${BRIDGE_STATE_PREFIX} ${lastError} after ${this.wsMaxRetries} attempts`,
    };
  }

  private async tryWebSocketReplyOnce(
    request: BridgeReplyRequest,
  ): Promise<BridgeReplyResult> {
    try {
      const { connectBridgeWebSocket } = await import("./ws.js");
      const text = await connectBridgeWebSocket({
        socketPath: this.options.bridgeSocketPath,
        project: request.project,
        sessionKey: request.sessionKey,
        timeoutMs: Math.min(this.options.timeoutMs, 30_000),
      });
      if (text) {
        return { ok: true, source: "bridge-ws", text };
      }
      return { ok: false, source: "bridge-ws", error: "empty ws reply" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, source: "bridge-ws", error: `ws error: ${message}` };
    }
  }

  private async pollHttpReply(
    request: BridgeReplyRequest,
  ): Promise<BridgeReplyResult> {
    const deadline = Date.now() + this.options.timeoutMs;
    const path = buildReplyQuery(
      this.options.replyPath,
      request.project,
      request.sessionKey,
    );
    const socketPath = this.options.apiSocketPath;

    while (Date.now() < deadline) {
      try {
        const res = await udsHttpRequest(
          socketPath,
          "GET",
          path,
          undefined,
          this.options.pollMs + 1000,
        );
        if (res.statusCode === 404) {
          return {
            ok: false,
            source: "bridge-http",
            error: `${BRIDGE_STATE_PREFIX} endpoint not found: ${path}`,
          };
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const parsed = parseBridgeBody(res.body);
          if (parsed.text && (parsed.done ?? true)) {
            return { ok: true, source: "bridge-http", text: parsed.text };
          }
        }
      } catch {
        // keep polling until timeout
      }
      await sleep(this.options.pollMs);
    }

    return {
      ok: false,
      source: "bridge-http",
      error: `${BRIDGE_STATE_PREFIX} reply timeout after ${this.options.timeoutMs}ms`,
    };
  }
}
