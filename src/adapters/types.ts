import type { AgentRuntime } from '../core/types.js';

export interface AdapterRequest {
  readonly prompt: string;
  readonly workDir: string;
  readonly sessionKey?: string;
  readonly projectName?: string;
}

export interface AdapterEvent {
  readonly type: 'progress' | 'text' | 'done' | 'error';
  readonly content: string;
  readonly timestamp: string;
}

export interface AdapterSessionStatus {
  readonly sessionKey: string;
  readonly running: boolean;
  readonly lastActivityAt: string;
}

export interface AgentAdapter {
  readonly runtime: AgentRuntime;
  send(request: AdapterRequest): AsyncIterable<AdapterEvent>;
  cancel(sessionKey: string): Promise<void>;
  status(sessionKey: string): Promise<AdapterSessionStatus>;
}

export async function collectAdapterOutput(adapter: AgentAdapter, request: AdapterRequest): Promise<string> {
  const chunks: string[] = [];
  for await (const event of adapter.send(request)) {
    if (event.type === 'text' || event.type === 'done') {
      chunks.push(event.content);
    }
    if (event.type === 'error') {
      throw new Error(event.content);
    }
  }
  return chunks.join('\n').trim();
}
