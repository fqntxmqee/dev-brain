import type { DevBrainConfig } from "../config/env.js";
import { isModuleNotFound } from "../core/error-utils.js";
import type {
  AgentAdapter,
  AdapterEvent,
  AdapterRequest,
  AdapterSessionStatus,
} from "./types.js";
import { CcConnectCursorAdapter } from "./claude-code-adapter.js";
import type { CcConnectClient } from "./cc-connect/index.js";

export class CursorAdapter implements AgentAdapter {
  readonly runtime = "cursor" as const;
  private readonly ccConnectFallback: CcConnectCursorAdapter;

  constructor(
    private readonly config: DevBrainConfig,
    client: CcConnectClient,
  ) {
    this.ccConnectFallback = new CcConnectCursorAdapter(config, client);
  }

  async *send(request: AdapterRequest): AsyncIterable<AdapterEvent> {
    const now = new Date().toISOString();

    if (this.config.adapterMode === "stub" || !this.config.cursorApiKey) {
      if (this.config.adapterMode === "live" && !this.config.cursorApiKey) {
        yield {
          type: "progress",
          content: "cursor: no CURSOR_API_KEY, falling back to cc-connect",
          timestamp: now,
        };
        yield* this.ccConnectFallback.send(request);
        return;
      }

      yield {
        type: "progress",
        content: "cursor adapter (stub)",
        timestamp: now,
      };
      yield {
        type: "done",
        content: `[cursor stub] workDir=${this.config.workDir} prompt=${request.prompt.slice(0, 80)}…`,
        timestamp: new Date().toISOString(),
      };
      return;
    }

    yield {
      type: "progress",
      content: "cursor: @cursor/sdk Agent.prompt",
      timestamp: now,
    };

    try {
      const { Agent } = await import("@cursor/sdk");
      const result = await Agent.prompt(request.prompt, {
        apiKey: this.config.cursorApiKey,
        model: { id: this.config.cursorModel },
        local: { cwd: request.workDir },
      });

      if (result.status === "error") {
        yield {
          type: "error",
          content: result.result ?? "Cursor agent returned error status",
          timestamp: new Date().toISOString(),
        };
        return;
      }

      yield {
        type: "done",
        content: result.result?.trim() || "(empty cursor response)",
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      if (isModuleNotFound(error, "@cursor/sdk")) {
        yield {
          type: "progress",
          content:
            "cursor: @cursor/sdk not installed, falling back to cc-connect",
          timestamp: new Date().toISOString(),
        };
        yield* this.ccConnectFallback.send(request);
        return;
      }
      yield {
        type: "error",
        content: `cursor sdk failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        timestamp: new Date().toISOString(),
      };
    }
  }

  async cancel(_sessionKey: string): Promise<void> {
    // Cursor SDK cancel in follow-up phase
  }

  async status(sessionKey: string): Promise<AdapterSessionStatus> {
    return this.ccConnectFallback.status(sessionKey);
  }
}
