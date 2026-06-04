import { connect } from 'node:net';
import { request as httpRequest } from 'node:http';

export interface UdsHttpResponse {
  readonly statusCode: number;
  readonly body: string;
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
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
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
        let data = '';
        res.on('data', (chunk: Buffer | string) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode ?? 0, body: data });
        });
      },
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`UDS request timeout: ${method} ${path}`));
    });

    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

export async function isSocketReachable(socketPath: string, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
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

export function parseSessionsBody(body: string): ReadonlyArray<CcConnectSessionInfo> {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item): item is CcConnectSessionInfo =>
        typeof item === 'object' &&
        item !== null &&
        'project' in item &&
        'session_key' in item &&
        typeof (item as CcConnectSessionInfo).project === 'string' &&
        typeof (item as CcConnectSessionInfo).session_key === 'string',
    );
  } catch {
    return [];
  }
}
