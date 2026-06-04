import type { FeishuInboundMessage } from '../core/types.js';
import type { FeishuInteractiveCard } from './feishu-cards.js';

export interface FeishuReply {
  readonly chatId: string;
  readonly text: string;
  readonly replyToMessageId?: string;
}

export interface FeishuCardReply {
  readonly chatId: string;
  readonly card: FeishuInteractiveCard;
  readonly replyToMessageId?: string;
}

export interface FeishuReporter {
  sendText(reply: FeishuReply): Promise<void>;
  sendCard?(reply: FeishuCardReply): Promise<void>;
}

/** CLI / 测试用的内存 Reporter */
export class InMemoryFeishuReporter implements FeishuReporter {
  readonly sent: FeishuReply[] = [];
  readonly cards: FeishuCardReply[] = [];

  async sendText(reply: FeishuReply): Promise<void> {
    this.sent.push(reply);
  }

  async sendCard(reply: FeishuCardReply): Promise<void> {
    this.cards.push(reply);
  }
}

async function spawnLarkCli(args: ReadonlyArray<string>): Promise<void> {
  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('lark-cli', args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`lark-cli exited with code ${code}`));
    });
  });
}

/** Phase 2+: 通过 lark-cli im 发送消息 */
export class LarkCliFeishuReporter implements FeishuReporter {
  constructor(private readonly receiveIdType: 'chat_id' | 'open_id' = 'chat_id') {}

  async sendText(reply: FeishuReply): Promise<void> {
    await spawnLarkCli([
      'im',
      '+messages-send',
      '--receive-id',
      reply.chatId,
      '--receive-id-type',
      this.receiveIdType,
      '--msg-type',
      'text',
      '--content',
      JSON.stringify({ text: reply.text }),
    ]);
  }

  async sendCard(reply: FeishuCardReply): Promise<void> {
    await spawnLarkCli([
      'im',
      '+messages-send',
      '--receive-id',
      reply.chatId,
      '--receive-id-type',
      this.receiveIdType,
      '--msg-type',
      'interactive',
      '--content',
      JSON.stringify(reply.card),
    ]);
  }
}

export function formatInboundLog(message: FeishuInboundMessage): string {
  return `[feishu] ${message.senderName}@${message.chatId}: ${message.text.slice(0, 80)}`;
}

export function supportsCards(reporter: FeishuReporter): reporter is Required<Pick<FeishuReporter, 'sendCard'>> & FeishuReporter {
  return typeof reporter.sendCard === 'function';
}
