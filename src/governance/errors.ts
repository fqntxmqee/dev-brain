export class LockConflictError extends Error {
  readonly filePath: string;
  readonly holderAgentId: string;
  readonly requesterAgentId: string;

  constructor(filePath: string, holderAgentId: string, requesterAgentId: string) {
    super(
      `File lock conflict on ${filePath}: held by ${holderAgentId}, requested by ${requesterAgentId}`,
    );
    this.name = 'LockConflictError';
    this.filePath = filePath;
    this.holderAgentId = holderAgentId;
    this.requesterAgentId = requesterAgentId;
  }
}
