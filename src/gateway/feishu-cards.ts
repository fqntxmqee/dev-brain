import type { BrainTaskPlan, BrainTaskResult, ExecutionProgress } from '../core/types.js';

export interface FeishuInteractiveCard {
  readonly config?: { readonly wide_screen_mode?: boolean };
  readonly header?: {
    readonly title: { readonly tag: 'plain_text'; readonly content: string };
    readonly template?: 'blue' | 'green' | 'red' | 'orange' | 'grey';
  };
  readonly elements: ReadonlyArray<Record<string, unknown>>;
}

function statusEmoji(status: ExecutionProgress['subTasks'][number]['status']): string {
  switch (status) {
    case 'pending':
      return '⏳';
    case 'assigned':
      return '📌';
    case 'executing':
      return '🔄';
    case 'completed':
      return '✅';
    case 'failed':
      return '❌';
    case 'blocked':
      return '🔒';
  }
}

export function buildPlanCard(plan: BrainTaskPlan, options?: { readonly withActions?: boolean }): FeishuInteractiveCard {
  const subTaskLines = plan.subTasks
    .map((st, i) => {
      const deps = st.dependsOn.length ? ` ← ${st.dependsOn.join(',')}` : '';
      return `${i + 1}. **${st.runtime}** ${st.description.slice(0, 80)}${deps}`;
    })
    .join('\n');

  const elements: Record<string, unknown>[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**需求**\n${plan.description.slice(0, 300)}`,
      },
    },
    { tag: 'hr' },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**子任务（${plan.subTasks.length}）**\n${subTaskLines}`,
      },
    },
  ];

  if (options?.withActions) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '✅ 批准执行' },
          type: 'primary',
          value: {
            action: 'approve',
            task_id: plan.taskId,
            chat_id: plan.chatId,
          },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '❌ 取消' },
          type: 'default',
          value: {
            action: 'cancel',
            task_id: plan.taskId,
            chat_id: plan.chatId,
          },
        },
      ],
    });
  } else {
    elements.push({
      tag: 'note',
      elements: [
        {
          tag: 'plain_text',
          content: '回复 /approve 开始执行，/cancel 取消。',
        },
      ],
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '📋 Dev Brain 任务计划' },
      template: 'blue',
    },
    elements,
  };
}

export function buildProgressCard(progress: ExecutionProgress): FeishuInteractiveCard {
  const lines = progress.subTasks
    .map((st) => {
      const detail = st.detail ? ` — ${st.detail.slice(0, 60)}` : '';
      return `${statusEmoji(st.status)} **${st.id}** [${st.runtime}] ${st.status}${detail}`;
    })
    .join('\n');

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🔄 执行进度' },
      template: 'orange',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**#${progress.taskId.slice(0, 8)}** ${progress.description.slice(0, 120)}`,
        },
      },
      { tag: 'hr' },
      {
        tag: 'div',
        text: { tag: 'lark_md', content: lines },
      },
    ],
  };
}

export function buildSummaryCard(result: BrainTaskResult, description: string): FeishuInteractiveCard {
  const lines = result.subTaskOutputs
    .map((o) => `- **${o.subTaskId}** [${o.runtime}]: ${o.output.slice(0, 120)}`)
    .join('\n');

  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: 'plain_text',
        content: result.success ? '✅ 任务完成' : '⚠️ 任务结束',
      },
      template: result.success ? 'green' : 'red',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**#${result.taskId.slice(0, 8)}**\n${description.slice(0, 200)}`,
        },
      },
      { tag: 'hr' },
      {
        tag: 'div',
        text: { tag: 'lark_md', content: lines || result.summary.slice(0, 500) },
      },
    ],
  };
}

export function serializeCard(card: FeishuInteractiveCard): string {
  return JSON.stringify(card);
}
