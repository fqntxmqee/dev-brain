export const HELP_TEXT = [
  '🧠 Dev Brain 指令',
  '',
  '直接发消息 — 创建任务计划（卡片按钮或 /approve 后执行）',
  '计划卡片 — 点击「批准执行」或发送 /approve',
  '/status  — 查看 Brain 状态',
  '/cancel  — 取消待审批任务',
  '/help    — 显示本帮助',
].join('\n');

export type IntentType = 'help' | 'status' | 'approve' | 'cancel' | 'create_task';

export interface ParsedIntent {
  readonly type: IntentType;
  readonly rawText: string;
}

export function parseIntent(text: string): ParsedIntent {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  if (lower === '/help' || lower === 'help') {
    return { type: 'help', rawText: trimmed };
  }
  if (lower === '/status' || lower === 'status') {
    return { type: 'status', rawText: trimmed };
  }
  if (lower === '/approve' || lower === 'approve') {
    return { type: 'approve', rawText: trimmed };
  }
  if (lower === '/cancel' || lower === 'cancel') {
    return { type: 'cancel', rawText: trimmed };
  }

  return { type: 'create_task', rawText: trimmed };
}
