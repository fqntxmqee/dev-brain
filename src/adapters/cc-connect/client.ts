import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AdapterMode,
  CcSyncMode,
  DevBrainConfig,
} from "../../config/env.js";
import { getMetrics, safe } from "../../observability/metrics.js";
import { CcConnectBridge } from "./bridge.js";
import {
  isSocketReachable,
  parseSessionsBody,
  udsHttpRequest,
  type CcConnectSessionInfo,
} from "./http.js";

const execFileAsync = promisify(execFile);

export interface CcConnectSendRequest {
  readonly project: string;
  readonly prompt: string;
  readonly sessionKey?: string;
}

export interface CcConnectSendResponse {
  readonly ok: boolean;
  readonly output?: string;
  readonly error?: string;
  readonly dispatched?: boolean;
  readonly replySource?: string;
}

export interface CcConnectClientOptions {
  readonly socketPath: string;
  readonly mode: AdapterMode;
  readonly syncMode: CcSyncMode;
  readonly bin: string;
  readonly dataDir: string;
  readonly relayTimeoutMs: number;
  readonly bridge?: CcConnectBridge;
}

function defaultSessionKey(project: string, sessionKey?: string): string {
  return sessionKey ?? `dev-brain:${project}:default`;
}

/**
 * cc-connect 客户端：HTTP-over-UDS（/send、/sessions）+ Bridge 异步回复 + 可选 relay CLI。
 */
export class CcConnectClient {
  private readonly options: CcConnectClientOptions;
  private readonly bridge: CcConnectBridge;
  private readonly metrics = getMetrics();

  constructor(options: CcConnectClientOptions) {
    this.options = options;
    this.bridge =
      options.bridge ??
      new CcConnectBridge({
        apiSocketPath: options.socketPath,
        bridgeSocketPath: options.socketPath,
        mode: options.mode,
        enabled: false,
        pollMs: 2000,
        timeoutMs: 300000,
        replyPath: "/bridge/reply",
      });
  }

  static fromConfig(config: DevBrainConfig): CcConnectClient {
    return new CcConnectClient({
      socketPath: config.ccConnectSocket,
      mode: config.adapterMode,
      syncMode: config.ccSyncMode,
      bin: config.ccConnectBin,
      dataDir: config.ccDataDir,
      relayTimeoutMs: config.ccRelayTimeoutMs,
      bridge: CcConnectBridge.fromConfig(config),
    });
  }

  async ping(): Promise<boolean> {
    const reachable = await isSocketReachable(this.options.socketPath);
    safe(
      () => this.metrics.gauge("cc.socket.reachable").set(reachable ? 1 : 0),
      undefined,
    );
    return reachable;
  }

  async listSessions(): Promise<ReadonlyArray<CcConnectSessionInfo>> {
    if (this.options.mode === "stub") {
      return [];
    }
    const res = await udsHttpRequest(
      this.options.socketPath,
      "GET",
      "/sessions",
    );
    if (res.statusCode !== 200) {
      return [];
    }
    return parseSessionsBody(res.body);
  }

  async send(request: CcConnectSendRequest): Promise<CcConnectSendResponse> {
    const endTimer = safe(
      () => this.metrics.histogram("cc.send.duration_seconds").startTimer(),
      () => 0,
    );
    try {
      return await this.sendInner(request);
    } finally {
      endTimer();
    }
  }

  private async sendInner(
    request: CcConnectSendRequest,
  ): Promise<CcConnectSendResponse> {
    if (this.options.mode === "stub") {
      const bridge = await this.bridge.collectReply({
        project: request.project,
        sessionKey: defaultSessionKey(request.project, request.sessionKey),
        prompt: request.prompt,
      });
      return {
        ok: true,
        output:
          bridge.text ??
          `[stub/${request.project}] ${request.prompt.slice(0, 120)}`,
        replySource: bridge.source,
      };
    }

    const reachable = await this.ping();
    if (!reachable) {
      return {
        ok: false,
        error: `cc-connect socket unreachable: ${this.options.socketPath}`,
      };
    }

    if (this.options.syncMode === "relay") {
      const relay = await this.sendViaRelay(request);
      if (relay.ok) {
        return relay;
      }
    }

    return this.sendViaHttp(request);
  }

  private async sendViaHttp(
    request: CcConnectSendRequest,
  ): Promise<CcConnectSendResponse> {
    const sessionKey = defaultSessionKey(request.project, request.sessionKey);
    const res = await udsHttpRequest(this.options.socketPath, "POST", "/send", {
      project: request.project,
      session_key: sessionKey,
      message: request.prompt,
    });

    if (res.statusCode !== 200) {
      return {
        ok: false,
        error: res.body.trim() || `cc-connect /send HTTP ${res.statusCode}`,
      };
    }

    let parsed: { status?: string } = {};
    try {
      parsed = JSON.parse(res.body) as { status?: string };
    } catch {
      parsed = {};
    }

    if (parsed.status !== "ok") {
      return {
        ok: false,
        error: res.body.trim() || "cc-connect /send unexpected response",
      };
    }

    if (this.bridge.shouldCollectAfterDispatch()) {
      const bridge = await this.bridge.collectReply({
        project: request.project,
        sessionKey,
        prompt: request.prompt,
      });
      if (bridge.ok && bridge.text) {
        return {
          ok: true,
          dispatched: true,
          output: bridge.text,
          replySource: bridge.source,
        };
      }
      return {
        ok: true,
        dispatched: true,
        output: `[cc-connect/${request.project}] dispatched; bridge: ${bridge.error ?? "no reply"}`,
        replySource: bridge.source,
      };
    }

    return {
      ok: true,
      dispatched: true,
      output: `[cc-connect/${request.project}] dispatched to session ${sessionKey}. Agent reply is async (enable DEV_BRAIN_CC_BRIDGE=1 or DEV_BRAIN_CC_SYNC=relay).`,
    };
  }

  private async sendViaRelay(
    request: CcConnectSendRequest,
  ): Promise<CcConnectSendResponse> {
    const sessionKey = defaultSessionKey(request.project, request.sessionKey);
    try {
      const { stdout, stderr } = await execFileAsync(
        this.options.bin,
        [
          "relay",
          "send",
          "-t",
          request.project,
          "-s",
          sessionKey,
          request.prompt,
        ],
        {
          timeout: this.options.relayTimeoutMs,
          env: {
            CC_DATA_DIR: this.options.dataDir,
            PATH: process.env.PATH ?? "",
          },
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      const output = stdout.trim() || stderr.trim();
      if (!output) {
        return {
          ok: true,
          output: `[cc-connect relay/${request.project}] (empty response)`,
          replySource: "relay",
        };
      }
      return { ok: true, output, replySource: "relay" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: `cc-connect relay failed: ${message}`,
      };
    }
  }
}
