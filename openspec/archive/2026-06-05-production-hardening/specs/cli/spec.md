---
demand-id: DM-20260605-002
change: production-hardening
status: archived
---

# CLI Spec (Delta)

## CAP-CLI-01 子命令预检与退出码

| 子命令 | 预检项 | 退出码 |
|---|---|---|
| `start` | `feishu_credentials` 非空 + `cc_connect_socket` 可达（live 模式） | 缺凭证 2；socket 不可达 3；订阅失败 4 |
| `plan` | stub 模式无要求；live 模式需 `cc_connect_socket` 可达 | 0 成功 / 1 业务失败 / 2 配置错 |
| `migrate-headless --check` | 当前为 headless 返 0；否则返 1 | **dry-run 成功返 0**（修当前反掉） |
| `migrate-headless --apply` | 备份路径可写 + workDir 不含非法字符 | 0 应用 / 1 备份失败 / 2 workDir 非法 / 3 写盘失败 |
| `migrate-headless --undo <backup>` | backup 文件存在 | 0 回滚 / 1 备份不存在 / 2 写盘失败 |
| `doctor` | 全部检查项 | 0 全绿 / 1 有非关键失败 / 2 有 critical 失败 |
| `probe` | project 名存在 | 0 成功 / 1 通信失败 / 2 project 不存在 |

## CAP-CLI-02 `--help` / `--version` 完善

**Given** 当前 `--help` 输出简陋  
**When** 整改后  
**Then**：
- `dev-brain --help` 顶部列出所有子命令 + 一行说明
- `dev-brain <sub> --help` 含完整 option 说明、environment 列表、示例 1-2 条
- `dev-brain --version` 输出 `dev-brain 0.5.0 (production-hardening)`
- 引用 `.env.example` 中关键变量名

## CAP-CLI-03 `migrate-headless --undo`

**Given** `migrate-headless --apply` 已应用过 headless 配置  
**When** 用户执行 `pnpm cli -- migrate-headless --undo <backup-path>`  
**Then**：
- 验证 backup 存在（不存在则退出码 1）
- 原子写入回原位置（`writeFile(tmp) + rename`）
- 打印「`Restored config from <backup-path>`」
- 退出码 0

## CAP-CLI-04 Cursor SDK 缺失优雅降级

**Given** `@cursor/sdk` 未安装（`optionalDependencies` 安装失败）  
**When** 启动 `CursorAdapter`  
**Then**：
- 捕获错误码 `ERR_MODULE_NOT_FOUND`（替代字符串嗅探 `err.message.includes('Cannot find module')`）
- stderr 写「`@cursor/sdk not installed; cursor runtime will use cc-connect workspace-cursor fallback`」
- 走 `CcConnectCursorAdapter` 路径
- 飞书 / CLI UX 不破坏

## CAP-CLI-05 doctor 失败 next-step 提示

**Given** 当前 `doctor` 失败项只给 `issues.join('; ')`（`cli/doctor.ts:61-64`），用户得自己知道下一步  
**When** 整改后  
**Then**：
- 失败项附 `next_step` 字段（用 map 维护）
- 飞书/CLI 输出格式：`❌ <check>: <detail>\n   💡 修复：<next_step>`
- 常见映射：

| 失败项 | next_step |
|---|---|
| `cc_connect_socket` | `pnpm cli -- start` 前先启动 cc-connect daemon |
| `cc_connect_headless` | `pnpm cli -- migrate-headless --check` 看详情，`--apply` 切换 |
| `feishu_credentials` | 复制 `.env.example` → `.env` 填入 Brain 飞书应用凭证 |
| `cursor_api_key` | 设置 `CURSOR_API_KEY` 或忽略（cursor 走 cc-connect fallback） |
| `sender_unauthorized` | 设置 `DEV_BRAIN_ALLOW_FROM=<你的 open_id>`（测试期可设 `=*`） |

## CAP-CLI-06 plan 输出 DAG 可视化

**Given** 当前 `pnpm cli -- plan` 输出无颜色、无 DAG 图，子任务并行关系不可见  
**When** 整改后  
**Then**：
- 终端输出形如：
  ```
  📋 任务计划 #taskId-12
  给 trade 模块加日期筛选

  [st-1] claude-code  探索 trade 模块
           ↓
    ┌──────┴──────┐
  [st-2] codex  [st-3] cursor
  后端实现    前端联调
  ```
- 同层并行用 `┬`/`┴`/`┤`/`├` 连接；`--no-ascii` 切换纯文本模式
- 计划阶段 / 进度阶段 / 汇总阶段共用同一渲染器
- 飞书卡片同步用同一数据结构生成

## CAP-CLI-07 show / retry 子命令

**Given** 当前 CLI 无 `show` / `retry` 子命令，任务提交后只能看飞书流式卡片，回看靠 grep  
**When** 整改后  
**Then**：
- `pnpm cli -- show <taskId>`：渲染 postmortem 摘要（详见 brain CAP-BRAIN-07）
- `pnpm cli -- show <taskId> --subtask <subTaskId>`：输出该子任务全量文本（来自 `~/.dev-brain/tasks/<taskId>/<subTaskId>.txt`）
- `pnpm cli -- retry <taskId> [--force]`：重试 `failed`/`blocked` 子任务
- `pnpm cli -- list [--limit N]`：列出最近 N 条任务（读 `state.json`）
- 退出码：0 成功 / 1 taskId 不存在 / 2 postmortem 文件缺失

## CAP-CLI-08 .env 占位值检测

**Given** `.env` 占位值（`cli_xxx`/`xxx`/`your_*`）启动不 fail，`pnpm cli -- start` 跑得欢，**首条消息 lark-cli 返回 401** 才发现  
**When** 整改后  
**Then**：
- `loadConfig` 检测 `DEV_BRAIN_FEISHU_APP_ID` / `_SECRET` / `CURSOR_API_KEY` 是否命中占位 pattern
- 命中 stderr 写 `[WARN] <field> looks like a placeholder: <value>`
- 启动不阻断（保留 stub 模式调试路径）
- `pnpm cli -- start --strict` 加 flag → 命中占位则退出码 2
- 详见 config CAP-CONF-02

## CAP-CLI-09 .env 模式分块

**Given** `.env.example` 当前 20+ 变量未分块，新手复制后改 `ADAPTER_MODE=live` 但 cc-connect socket 不存在，启动时全不校验  
**When** 整改后  
**Then**：
- `.env.example` 顶部声明 4 个分块：`Required` / `Stub` / `Live` / `Optional`（详见 config CAP-CONF-01）
- `loadConfig` 启动期检查：`adapterMode==='live'` 时必填项缺失 → `ConfigError` 退出码 2
- 缺失项 stderr 列名 + 占位值给 1 行说明

## CAP-CLI-10 CcConnectBridge 三条件 AND 告警

**Given** 当前 `enabled = ccBridgeEnabled && mode==='live' && syncMode==='send'` 三条件 AND 静默吞配置  
**When** 整改后  
**Then**：
- 条件不满足时启动期显式日志（详见 config CAP-CONF-05）：
  - `bridge disabled by config` / `bridge has no effect in stub mode` / `bridge has no effect in relay sync mode`
- `pnpm cli -- doctor` 列出当前生效的 bridge 状态
- `pnpm cli -- probe` 也展示该状态

## CAP-CLI-11 migrate --apply 原子化

**Given** 当前 `migrate-headless --apply` 先 `copyFile` 备份再 `writeFile`——**非原子**，备份已落盘但写入失败会留半生不熟状态  
**When** 整改后  
**Then**：
- 写入流程：`writeFile(realPath + '.tmp.new', content)` → `rename(.tmp.new, realPath)`
- 备份流程独立：`copyFile(realPath, realPath + '.bak.<ts>')` 在写**前**执行
- 任何中间步骤失败：清理 `.tmp.new`、保留 `.bak.<ts>`
- 验证：模拟写失败 → 真文件未变，备份存在，`.tmp.new` 不残留

## CAP-CLI-12 凭证过期诊断提示

**Given** 飞书凭证过期：lark-cli 退出非零（`feishu-reporter.ts:42`），错误冒泡到 `feishu-gateway.ts:194` 写成 `gateway error: lark-cli exited with code 1`——**未告诉用户去后台轮换**  
**When** 整改后  
**Then**：
- lark-cli exit code 401 / token 相关 stderr → 识别为 `CredentialExpiredError`
- 飞书报错卡片含：「🔑 飞书凭证过期或无效，步骤：1) 登录 https://open.feishu.cn/app 2) 在 Brain 应用「事件订阅」/「权限管理」检查 3) 轮换 App Secret 后更新 `.env`」
- 凭证占位值（CAP-CLI-08）失败时附同样文案
- 文档链接：openspec URL / wiki 链接

## CAP-CLI-13 --help 引用退出码表

**Given** 当前 `--help` 无示例；退出码未文档化  
**When** 整改后  
**Then**：
- `dev-brain --help` 顶部列出所有子命令 + 一行说明
- `dev-brain <sub> --help` 含：
  - 完整 option 说明
  - environment 列表（关键 `DEV_BRAIN_*` 变量）
  - examples（2 条典型用法）
  - 「退出码：`dev-brain help-exit-codes`」引用
- 新增 `dev-brain help-exit-codes` 子命令（无副作用，仅打印 6 个子命令退出码矩阵）
- `dev-brain --version` 输出 `dev-brain 0.5.0 (production-hardening)`

## CAP-CLI-14 migrate 成功消息附回滚命令

**Given** `migrate-headless --apply` 成功消息只说"请重启 cc-connect daemon"，**未告知回滚命令**  
**When** 整改后  
**Then**：
- 成功消息格式：「`Applied headless config to <path>. Backup: <backup-path>. To rollback: pnpm cli -- migrate-headless --undo <backup-path>`」
- `--dry-run` 同样附预演回滚命令

## L5 锚点

- L5-HARDEN-04 / L5-HARDEN-10
- L5-NEW-12（doctor 失败 next-step：6 个常见 check 全部命中提示）
- L5-NEW-13（show：postmortem 渲染）
- L5-NEW-14（migrate --apply 原子：模拟写失败不污染原文件）
- L5-NEW-15（凭证过期：stderr / 飞书卡片含修复步骤）
