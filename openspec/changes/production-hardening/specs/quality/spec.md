---
demand-id: DM-20260605-002
change: production-hardening
status: developing
---

# Code Quality Spec (Delta)

## CAP-QUAL-01 TypeScript 严格模式 + CI 串行

**Given** `tsconfig.json` 开启 `noUncheckedIndexedAccess: true`  
**When** `pnpm typecheck` 执行  
**Then** 0 错误；CI `typecheck && lint && test && build` 任何一步失败则失败

**Given** `src/adapters/codex-adapter.ts` 当前是破损 re-export  
**When** 整改后  
**Then** 文件删除，调用方改为 `from './claude-code-adapter.js'`（如确需）或 `./cursor-adapter.js`

**Given** `src/brain/brain-engine.ts:116` 把 `ReadonlyArray` 当 mutable  
**When** 整改后  
**Then** 用 spread `[...arr, item]` 不可变更新

**Given** `src/cli/cli.ts:44` 用具体类作参数类型  
**When** 整改后  
**Then** 抽 `interface FeishuReporter { sendText(); sendCard?(); }`，两实现都满足

## CAP-QUAL-02 ESLint + Prettier + Pre-commit

**Given** 仓库无 lint / format 配置  
**When** 整改后  
**Then** `eslint.config.js` (flat config, `@typescript-eslint` 推荐集) + `.prettierrc.json` + `.husky/pre-commit` 串 `pnpm typecheck && pnpm lint --fix && pnpm test --run`；`pnpm format` 零 diff

## CAP-QUAL-03 覆盖率门槛 80%

**Given** 当前 63.19% 行覆盖  
**When** 整改后  
**Then** `vitest.config.ts` `coverage.thresholds: { lines: 80, branches: 80, statements: 80, functions: 80 }`；任何测试不达标则 CI 红

## CAP-QUAL-04 Live 模式关键路径测试

| 测试文件 | 覆盖目标 |
|---|---|
| `tests/integration/live-cc-connect.test.ts` | mock UDS，验证 `sendViaHttp` + Bridge WS 成功 + HTTP 轮询回退 + 超时 |
| `tests/integration/live-cursor.test.ts` | mock `@cursor/sdk`，验证 SDK 缺失 / 成功 / 失败 / 流式 |
| `tests/unit/lark-cli-reporter.test.ts` | mock child_process，验证 `spawn('lark-cli', args)` 参数与 stdin 写入 |
| `tests/unit/brain-engine-approval.test.ts` | 审批门控：找不到计划 / sender 不在 allowFrom / 重复 approve / 部分子任务失败 |
| `tests/unit/file-lock-cross-process.test.ts` | spawn child process，验证 flock 互斥 |

## CAP-QUAL-05 死代码与重复清理

| 项 | 处理 |
|---|---|
| `src/adapters/codex-adapter.ts` (1 行) | 删除 |
| `LockMode` 在 `core/types.ts:8` 与 `governance/types.ts:1` | 收敛到 `governance/types.ts` |
| `AGENT_RUNTIMES` / `TASK_PHASES` / `LOCK_MODES` 0 引用 | 删除 |
| `parseFeishuEventLine` deprecated 双导出 | 保留 `feishu-gateway.ts:163` 唯一处，移除 `feishu-events.ts:119` |
| `src/cli/cli.ts:43` `LarkCliFeishuReporter('chat_id')` 写死 | 改为读 `DEV_BRAIN_FEISHU_DEFAULT_CHAT_ID` 启动期声明，或运行时从 message 推断 |

## CAP-QUAL-06 tests 目录 typecheck

**Given** 当前 `tsconfig.json:26` 显式 `exclude: ['tests']`，测试代码不参与 typecheck  
**When** 整改后  
**Then**：
- 新增 `tsconfig.test.json`：`extends: ./tsconfig.json`，`include: ['src/**/*', 'tests/**/*']`
- `pnpm typecheck` 同时跑 `tsc -p tsconfig.test.json`；CI 红
- 测试代码也受 `noUncheckedIndexedAccess` 严格模式约束

## CAP-QUAL-07 依赖版本升级路径

**Given** 当前 `eslint@^8.57.0` EOL / `typescript@^6.0.2` 未 GA / `vitest@^4.1.4` 刚发布——**版本组合风险高**  
**When** 整改后  
**Then**：
- 文档化版本策略：
  - production：ESLint 9.x + TypeScript 5.6.x + Vitest 3.x（已 GA 半年）
  - 当前锁定到这三个稳定版
- `package.json` 锁版本（`eslint: ^9.10.0` 等）
- 加 renovate / dependabot 配置自动 PR 升级
- TS 6 / Vitest 4 / ESLint 10 等 breaking 升级独立 change 跟踪

## CAP-QUAL-08 toErrorMessage 统一公共函数

**Given** 当前 `catch (error)` 处理风格不一：5+ 处 inline `error instanceof Error ? error.message : String(error)`（详见 errors CAP-ERR-02）  
**When** 整改后  
**Then**：
- 抽 `src/utils/errors.ts` 公共 `toErrorMessage(error: unknown): string` 与 `toErrorStack(error: unknown): string | undefined`
- 全仓 catch 改用此函数；CI grep 兜底
- 配合 errors CAP-ERR-02 的 `cause` 链规范

## CAP-QUAL-09 魔法数字收口

**Given** 散落 `feishu-cards.ts:33/42/106/122/136/153/159`、`task-planner.ts:134/139`、`brain-engine.ts:275/281` 共 12+ 处的 `slice(0, 80/100/120/200/300/500)`  
**When** 整改后  
**Then**：
- 抽 `src/core/constants.ts`：`MAX_DESC_LEN = 300` / `MAX_OUTPUT_LEN = 200` / `MAX_CARD_FIELD_LEN = 80` / `MAX_SUBTASK_TITLE_LEN = 100`
- 全仓 import 使用，无 hardcode
- 加 ESLint `no-magic-numbers` rule（仅 string slice 触发）

## L5 锚点

- L5-HARDEN-01/02/03（CI + lint + coverage）
- L5-NEW-19（tests typecheck：`pnpm typecheck` 含 tests 后 0 错误）
- L5-NEW-20（toErrorMessage：grep `instanceof Error` 全仓只有 utils 命中）
