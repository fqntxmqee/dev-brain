export type LockMode = 'none' | 'read' | 'write';

export interface FileLock {
  readonly id: string;
  readonly filePath: string;
  readonly agentId: string;
  readonly mode: 'read' | 'write';
  readonly acquiredAt: string;
  readonly expiresAt: string;
}
