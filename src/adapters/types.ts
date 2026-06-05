import type { AgentRuntime } from "../core/types.js";

export interface AdapterRequest {
  readonly prompt: string;
  readonly workDir: string;
  readonly sessionKey?: string;
  readonly projectName?: string;
}

export interface AdapterEvent {
  readonly type: "progress" | "text" | "done" | "error";
  readonly content: string;
  readonly timestamp: string;
}

/** T-56: 状态机从 boolean 升级为枚举 */
export type AdapterSessionState =
  | "running"
  | "idle"
  | "not_found"
  | "cancelled"
  | "unknown";

export interface AdapterSessionStatus {
  readonly sessionKey: string;
  readonly state: AdapterSessionState;
  readonly lastActivityAt: string;
  /** 取消时携带的 reason（便于链路追踪） */
  readonly cancelledReason?: string;
}

export interface AgentAdapter {
  readonly runtime: AgentRuntime;
  send(request: AdapterRequest): AsyncIterable<AdapterEvent>;
  cancel(sessionKey: string, reason?: string): Promise<void>;
  status(sessionKey: string): Promise<AdapterSessionStatus>;
}

export async function collectAdapterOutput(
  adapter: AgentAdapter,
  request: AdapterRequest,
): Promise<string> {
  const chunks: string[] = [];
  for await (const event of adapter.send(request)) {
    if (event.type === "text" || event.type === "done") {
      chunks.push(event.content);
    }
    if (event.type === "error") {
      throw new Error(event.content);
    }
  }
  return chunks.join("\n").trim();
}
