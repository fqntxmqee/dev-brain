import { v4 as uuid } from 'uuid';
import type { AgentRuntime, LockMode, PlannedSubTask } from '../core/types.js';

const EXPLORE_KEYWORDS = ['探索', '分析', '架构', '审查', 'review', 'explore', 'architect'];
const CODE_KEYWORDS = ['实现', '编码', '修改', '开发', 'implement', 'code', 'refactor'];
const DEBUG_KEYWORDS = ['调试', '联调', 'debug', 'fix bug', 'cursor'];

function containsAny(text: string, keywords: ReadonlyArray<string>): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

function pickRuntime(description: string, index: number): AgentRuntime {
  if (containsAny(description, EXPLORE_KEYWORDS)) {
    return 'claude-code';
  }
  if (containsAny(description, DEBUG_KEYWORDS)) {
    return 'cursor';
  }
  if (containsAny(description, CODE_KEYWORDS)) {
    return index % 2 === 0 ? 'codex' : 'codex';
  }
  if (index === 0) return 'claude-code';
  if (index === 1) return 'codex';
  return 'cursor';
}

/** 从需求描述推断可能冲突的文件范围 */
export function inferFileScope(description: string): string {
  const moduleMatch = description.match(/([\w-]+)\s*模块/);
  if (moduleMatch) {
    return `src/${moduleMatch[1]}/**`;
  }
  const pathMatch = description.match(/(src\/[\w./-]+)/);
  if (pathMatch) {
    return pathMatch[1];
  }
  return 'src/**';
}

export function buildDefaultSubTasks(description: string): ReadonlyArray<PlannedSubTask> {
  const trimmed = description.trim();
  const scope = inferFileScope(trimmed);
  const testScope = `${scope.replace(/\*\*$/, '')}-tests/**`;

  const templates: ReadonlyArray<{
    suffix: string;
    hint: string;
    runtimeIndex: number;
    dependsOn: ReadonlyArray<string>;
    requiredFiles: ReadonlyArray<string>;
    lockMode: LockMode;
  }> = [
    {
      suffix: '探索与方案',
      hint: '探索代码库结构并输出修改方案',
      runtimeIndex: 0,
      dependsOn: [],
      requiredFiles: [],
      lockMode: 'none',
    },
    {
      suffix: '后端实现',
      hint: '按方案实现后端代码变更',
      runtimeIndex: 1,
      dependsOn: ['st-1'],
      requiredFiles: [scope],
      lockMode: 'write',
    },
    {
      suffix: '前端联调',
      hint: '实现前端变更并联调验证',
      runtimeIndex: 2,
      dependsOn: ['st-1'],
      requiredFiles: [testScope],
      lockMode: 'write',
    },
  ];

  return templates.map((tpl, index) => ({
    id: `st-${index + 1}`,
    description: `${trimmed} — ${tpl.hint}`,
    runtime: pickRuntime(`${trimmed} ${tpl.suffix}`, tpl.runtimeIndex),
    requiredFiles: tpl.requiredFiles,
    dependsOn: tpl.dependsOn,
    lockMode: tpl.lockMode,
  }));
}

/** 用于 L5-BRAIN-04：同层并行子任务争抢同一文件写锁 */
export function buildLockConflictSubTasks(description: string): ReadonlyArray<PlannedSubTask> {
  const trimmed = description.trim();
  const scope = inferFileScope(trimmed);
  return [
    {
      id: 'st-1',
      description: `${trimmed} — 探索`,
      runtime: 'claude-code',
      requiredFiles: [],
      dependsOn: [],
      lockMode: 'none',
    },
    {
      id: 'st-2a',
      description: `${trimmed} — codex 实现`,
      runtime: 'codex',
      requiredFiles: [scope],
      dependsOn: ['st-1'],
      lockMode: 'write',
    },
    {
      id: 'st-2b',
      description: `${trimmed} — cursor 实现（同文件）`,
      runtime: 'cursor',
      requiredFiles: [scope],
      dependsOn: ['st-1'],
      lockMode: 'write',
    },
    {
      id: 'st-3',
      description: `${trimmed} — 汇总验证`,
      runtime: 'claude-code',
      requiredFiles: [],
      dependsOn: ['st-2a', 'st-2b'],
      lockMode: 'none',
    },
  ];
}

export function formatPlanSummary(description: string, subTasks: ReadonlyArray<PlannedSubTask>): string {
  const lines = subTasks.map((st, i) => {
    const deps = st.dependsOn.length ? ` ← ${st.dependsOn.join(',')}` : '';
    const files = st.requiredFiles.length ? ` 🔒${st.requiredFiles.join(',')}` : '';
    return `${i + 1}. [${st.runtime}] ${st.description.slice(0, 100)}${deps}${files}`;
  });
  return [
    `📋 任务计划`,
    ``,
    `需求：${description.slice(0, 200)}`,
    ``,
    `子任务（${subTasks.length}，同层可并行）：`,
    ...lines,
    ``,
    `回复 /approve 开始执行，/cancel 取消。`,
  ].join('\n');
}

export function newTaskId(): string {
  return uuid();
}
