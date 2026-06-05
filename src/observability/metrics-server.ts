/**
 * HTTP metrics server（CAP-OBS-02 / v0.7.0）
 *
 * - GET /metrics → 200 Prometheus text (text/plain; version=0.0.4)
 * - GET /healthz → 200 JSON {status:"ok"} (liveness)
 * - GET /readyz  → 200/503 based on isReady() (readiness)
 * - 其它         → 404 + http.404.requests counter
 *
 * 仅依赖 node:http（不引入 express / fastify / prom-client）。
 * EADDRINUSE 时重试一次（间隔 250ms），仍冲突则抛错。
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { defaultLogger, type Logger } from "../core/logger.js";
import { safe } from "./metrics.js";
import type { MetricsRegistry } from "./metrics.js";

export interface MetricsServerOptions {
  readonly port: number;
  readonly host: string;
  readonly registry: MetricsRegistry;
  readonly isReady?: () => boolean;
  readonly logger?: Logger;
}

export interface MetricsServerHandle {
  readonly port: number;
  close(): Promise<void>;
}

const CONTENT_TYPE_PROM = "text/plain; version=0.0.4; charset=utf-8";
const CONTENT_TYPE_JSON = "application/json; charset=utf-8";

export class MetricsServer {
  private readonly options: Required<MetricsServerOptions>;
  private server: Server | null = null;
  private currentPort = 0;

  constructor(options: MetricsServerOptions) {
    this.options = {
      port: options.port,
      host: options.host,
      registry: options.registry,
      isReady: options.isReady ?? (() => true),
      logger: options.logger ?? defaultLogger,
    };
  }

  async start(): Promise<MetricsServerHandle> {
    if (this.server) {
      throw new Error("MetricsServer already started");
    }
    const { host } = this.options;
    const maxAttempts = 2;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.listenOnce(host, this.options.port);
        this.options.logger.info("metrics_server_listening", {
          host,
          port: this.currentPort,
          attempt,
        });
        return {
          port: this.currentPort,
          close: () => this.close(),
        };
      } catch (err) {
        lastErr = err;
        if (!isEaddrInUse(err) || attempt >= maxAttempts) break;
        // backoff 250ms before retry
        await new Promise<void>((r) => setTimeout(r, 250));
        // 强制回收旧 server（listenOnce 已 close，引用应已 null）
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`metrics server failed to bind ${host}:${this.options.port}`);
  }

  private listenOnce(host: string, port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res));
      server.once("error", (err) => {
        server.removeListener("listening", onListen);
        reject(err);
      });
      const onListen = (): void => {
        server.removeListener("error", onError);
        const addr = server.address() as AddressInfo | null;
        this.currentPort = addr?.port ?? port;
        this.server = server;
        resolve();
      };
      const onError = (err: Error): void => {
        server.removeListener("listening", onListen);
        reject(err);
      };
      server.once("listening", onListen);
      server.listen(port, host);
    });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    if (method !== "GET" && method !== "HEAD") {
      this.respondJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    // Strip query string
    const path = url.split("?", 1)[0] ?? "/";

    if (path === "/metrics") {
      safe(() => this.options.registry.inc("http.metrics.requests"), undefined);
      const body = safe(
        () => this.options.registry.getMetricsText(),
        "# metrics registry error\n",
      );
      this.respondText(res, 200, CONTENT_TYPE_PROM, body);
      return;
    }

    if (path === "/healthz") {
      safe(() => this.options.registry.inc("http.healthz.requests"), undefined);
      this.respondJson(res, 200, { status: "ok" });
      return;
    }

    if (path === "/readyz") {
      safe(() => this.options.registry.inc("http.readyz.requests"), undefined);
      const ready = safe(this.options.isReady, false);
      if (ready) {
        this.respondJson(res, 200, { status: "ready" });
      } else {
        this.respondJson(res, 503, { status: "not_ready" });
      }
      return;
    }

    safe(() => this.options.registry.inc("http.404.requests"), undefined);
    this.respondJson(res, 404, { error: "not_found", path });
  }

  private respondText(
    res: ServerResponse,
    status: number,
    contentType: string,
    body: string,
  ): void {
    res.statusCode = status;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", Buffer.byteLength(body));
    res.end(body);
  }

  private respondJson(
    res: ServerResponse,
    status: number,
    body: Record<string, unknown>,
  ): void {
    const text = JSON.stringify(body);
    res.statusCode = status;
    res.setHeader("Content-Type", CONTENT_TYPE_JSON);
    res.setHeader("Content-Length", Buffer.byteLength(text));
    res.end(text);
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    // 强制关闭所有 keep-alive 空闲连接，避免 close() 阻塞等待
    const closeAll = (
      server as unknown as {
        closeAllConnections?: () => void;
      }
    ).closeAllConnections;
    if (typeof closeAll === "function") {
      try {
        closeAll.call(server);
      } catch {
        // intentional swallow
      }
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // 兜底：3s 还没关就强制 resolve
      const timer = setTimeout(() => {
        try {
          closeAll?.call(server);
        } catch {
          // intentional swallow
        }
        resolve();
      }, 3_000);
      if (typeof timer.unref === "function") timer.unref();
    });
  }
}

function isEaddrInUse(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  return code === "EADDRINUSE";
}

/** 根据环境推导默认 host（dev = 0.0.0.0, CI = 127.0.0.1） */
export function deriveMetricsHost(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.CI === "true" || env.GITHUB_ACTIONS === "true") return "127.0.0.1";
  return "0.0.0.0";
}
