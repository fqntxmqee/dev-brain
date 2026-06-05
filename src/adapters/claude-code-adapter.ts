import type { DevBrainConfig } from "../config/env.js";
import { defaultLogger, type Logger } from "../core/logger.js";
import { getMetrics, safe } from "../observability/metrics.js";
import type {
  AdapterEvent,
  AdapterRequest,
  AdapterSessionState,
  AdapterSessionStatus,
  AgentAdapter,
} from "./types.js";
import { CcConnectClient } from "./cc-connect/index.js";

/** T-57: 本地追踪已取消会话 — cc-connect 暂无 cancel API，但需保留 intent */
interface CancelledSession {
  readonly at: string;
  readonly reason: string;
}

abstract class CcConnectBackedAdapter implements AgentAdapter {
  private readonly cancelled = new Map<string, CancelledSession>();
  private readonly logger: Logger;
  private readonly metrics = getMetrics();

  protected constructor(
    readonly runtime: "claude-code" | "codex" | "cursor",
    private readonly projectName: string,
    private readonly client: CcConnectClient,
  ) {
    this.logger = defaultLogger.child({
      component: "adapter",
      runtime: this.runtime,
    });
  }

  async *send(request: AdapterRequest): AsyncIterable<AdapterEvent> {
    const sessionKey = request.sessionKey ?? "(no-session)";
    const cancelled = this.cancelled.get(sessionKey);
    if (cancelled) {
      yield {
        type: "error",
        content: `session already cancelled (${cancelled.reason}) at ${cancelled.at}`,
        timestamp: new Date().toISOString(),
      };
      return;
    }

    const now = new Date().toISOString();
    yield {
      type: "progress",
      content: `dispatching to ${this.runtime} via cc-connect`,
      timestamp: now,
    };

    const log = this.logger.child({
      session_key: sessionKey,
      project: this.projectName,
    });
    const endSendTimer = safe(
      () => this.metrics.histogram("cc.send.duration_seconds").startTimer(),
      () => 0,
    );
    let result;
    try {
      result = await this.client.send({
        project: this.projectName,
        prompt: request.prompt,
        sessionKey: request.sessionKey,
      });
    } catch (err) {
      endSendTimer();
      safe(() => this.metrics.inc("adapter.failed"), undefined);
      log.error("adapter send threw", {
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    if (!result.ok) {
      endSendTimer();
      safe(() => this.metrics.inc("adapter.failed"), undefined);
      log.warn("adapter send returned not-ok", { err: result.error });
      yield {
        type: "error",
        content: result.error ?? "cc-connect send failed",
        timestamp: new Date().toISOString(),
      };
      return;
    }

    endSendTimer();
    safe(() => this.metrics.inc("adapter.sent"), undefined);
    log.info("adapter send ok", {
      output_len: (result.output ?? "").length,
    });
    yield {
      type: "done",
      content: result.output ?? "(empty)",
      timestamp: new Date().toISOString(),
    };
  }

  /** T-57: 标记取消意图；cc-connect 端无对应 API 时仅本地记录 */
  async cancel(sessionKey: string, reason?: string): Promise<void> {
    this.cancelled.set(sessionKey, {
      at: new Date().toISOString(),
      reason: reason ?? "user requested",
    });
    safe(() => this.metrics.inc("adapter.cancelled"), undefined);
  }

  /** T-56: 多档状态机 — cancelled > running > idle > not_found */
  async status(sessionKey: string): Promise<AdapterSessionStatus> {
    const cancelled = this.cancelled.get(sessionKey);
    if (cancelled) {
      return {
        sessionKey,
        state: "cancelled",
        lastActivityAt: cancelled.at,
        cancelledReason: cancelled.reason,
      };
    }
    let state: AdapterSessionState = "unknown";
    try {
      const sessions = await this.client.listSessions();
      const match = sessions.find(
        (s) => s.project === this.projectName && s.session_key === sessionKey,
      );
      if (!match) {
        state = "not_found";
      } else if (match.platform && match.platform !== this.runtime) {
        state = "idle";
      } else {
        state = "running";
      }
    } catch {
      state = "unknown";
    }
    return {
      sessionKey,
      state,
      lastActivityAt: new Date().toISOString(),
    };
  }
}

export class ClaudeCodeAdapter extends CcConnectBackedAdapter {
  constructor(config: DevBrainConfig, client: CcConnectClient) {
    super("claude-code", config.ccProjectClaude, client);
  }
}

export class CodexAdapter extends CcConnectBackedAdapter {
  constructor(config: DevBrainConfig, client: CcConnectClient) {
    super("codex", config.ccProjectCodex, client);
  }
}

export class CcConnectCursorAdapter extends CcConnectBackedAdapter {
  constructor(config: DevBrainConfig, client: CcConnectClient) {
    super("cursor", config.ccProjectCursor, client);
  }
}
