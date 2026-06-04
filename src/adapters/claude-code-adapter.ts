import type { DevBrainConfig } from '../config/env.js';
import type { AgentAdapter, AdapterEvent, AdapterRequest, AdapterSessionStatus } from './types.js';
import { CcConnectClient } from './cc-connect-client.js';

abstract class CcConnectBackedAdapter implements AgentAdapter {
  protected constructor(
    readonly runtime: 'claude-code' | 'codex' | 'cursor',
    private readonly projectName: string,
    private readonly client: CcConnectClient,
  ) {}

  async *send(request: AdapterRequest): AsyncIterable<AdapterEvent> {
    const now = new Date().toISOString();
    yield { type: 'progress', content: `dispatching to ${this.runtime} via cc-connect`, timestamp: now };

    const result = await this.client.send({
      project: this.projectName,
      prompt: request.prompt,
      sessionKey: request.sessionKey,
    });

    if (!result.ok) {
      yield {
        type: 'error',
        content: result.error ?? 'cc-connect send failed',
        timestamp: new Date().toISOString(),
      };
      return;
    }

    yield {
      type: 'done',
      content: result.output ?? '(empty)',
      timestamp: new Date().toISOString(),
    };
  }

  async cancel(_sessionKey: string): Promise<void> {
    // cc-connect 暂无 cancel API
  }

  async status(sessionKey: string): Promise<AdapterSessionStatus> {
    const sessions = await this.client.listSessions();
    const match = sessions.find(
      (s) => s.project === this.projectName && s.session_key === sessionKey,
    );
    return {
      sessionKey,
      running: match !== undefined,
      lastActivityAt: new Date().toISOString(),
    };
  }
}

export class ClaudeCodeAdapter extends CcConnectBackedAdapter {
  constructor(config: DevBrainConfig, client: CcConnectClient) {
    super('claude-code', config.ccProjectClaude, client);
  }
}

export class CodexAdapter extends CcConnectBackedAdapter {
  constructor(config: DevBrainConfig, client: CcConnectClient) {
    super('codex', config.ccProjectCodex, client);
  }
}

export class CcConnectCursorAdapter extends CcConnectBackedAdapter {
  constructor(config: DevBrainConfig, client: CcConnectClient) {
    super('cursor', config.ccProjectCursor, client);
  }
}
