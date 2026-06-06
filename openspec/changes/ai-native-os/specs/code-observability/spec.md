---
demand-id: DM-20260606-003
change: ai-native-os
status: developing
---

# Code Observability Spec (Delta — v0.11.0)

本文为 AI Native OS 引入"代码态"可观测能力,产出 4 项指标喂给 Phase E 自我进化。
v0.10.0 已有"运行时"可观测(trace + 53 metric),本 spec 补"代码侧"的另一半。

## CAP-CODE-01 (NEW) AST 静态分析

**Given** 给定一个 TypeScript 源码目录(默认 `src/`)
**When** AstAnalyzer.parse(sources) 被调用
**Then** 用 `ts-morph` 解析每个 .ts 文件,产出结构化数据:
  - `files: { path, loc, exports, classes, functions }[]`
  - 每个 function:`{ name, file, startLine, endLine, complexity?, callers[], callees[] }`
  - 每个 export symbol:`{ name, kind: "function"|"class"|"const"|"type", exportedFrom, references[] }`
**And** 单文件解析 < 500ms (P95),全 src/ < 30s
**And** 解析失败(语法错)写 `code.ast.parse_failed_total{file}` +1,该文件跳过不影响其他
**And** 解析结果缓存到 `~/.dev-brain/code-health/ast-cache-<hash>.json`,基于 mtime 失效

**实现要点:**
- `src/observability/code-health/ast-analyzer.ts` — `class AstAnalyzer { parse(sources): Promise<AstSnapshot>; }`
- 依赖 `ts-morph` (prod dep)
- 与 v0.10.0 metrics.ts 联动:启动时注册 4 个新 gauge
- tsconfig.json 同步:用 `tsconfig.json` 的 paths/baseUrl 让 ts-morph 解析别名
- 失败兜底:语法错文件单独 catch,产出"该文件 skip,原因: e.message"

**Scenario: 解析 100 个 TS 文件**
- GIVEN dev-brain 自己的 src/,~50 个 .ts 文件
- WHEN `AstAnalyzer.parse(["src/"])`
- THEN 产出 ~50 个 file records,~200 个 function records,~50 个 export records
- AND 总耗时 < 10s

**Scenario: 语法错文件 skip**
- GIVEN 某文件 `src/broken.ts` 有未闭合的 brace
- WHEN AstAnalyzer 解析
- THEN 该文件 catch 异常,产出 `{ path, error: "Unterminated template literal" }`
- AND 写 `code.ast.parse_failed_total{file="src/broken.ts"}` +1
- AND 其他文件正常解析

**Scenario: mtime 缓存命中**
- GIVEN 上次解析后无文件改动
- WHEN 再次调 `AstAnalyzer.parse`
- THEN 直接读 cache,不重跑 ts-morph(< 100ms 完成)

## CAP-CODE-02 (NEW) 死代码检测

**Given** AstAnalyzer 已产出 `exports[]` + `references[]`
**When** DeadcodeFinder.find(astSnapshot, projectRoot)
**Then** 找出所有"被定义但从未被引用"的符号:
  - 顶层 export 函数:在项目内(`src/` 排除 test) 0 references
  - 顶层 export const/class/type:同上
  - class 的 public methods(非构造):外部 0 调用
**And** 输出 `DeadcodeReport { deadExports: Symbol[], deadMethods: Method[], total: number }`
**And** 写 `code.dead_exports` (gauge) = deadExports.length
**And** 测试文件(`*.test.ts` / `__tests__/`)和入口文件(`src/index.ts`)豁免

**实现要点:**
- `src/observability/code-health/deadcode-finder.ts` — `class DeadcodeFinder { find(snap, root): DeadcodeReport }`
- 准确率 ≥ 90%(人工 spot-check 20 个样本,容许误判 2 个)
- 误报来源:动态 `import()` / 字符串反射 / 外部 CLI 入口 — v0.11.0 不处理,记 `code.deadcode.false_positive_*` 留 follow-up
- 与 git 关联:死代码判定时排除最近 1 周新增(可能是新 API,引用还没铺开)

**Scenario: 找出一个未引用的 helper**
- GIVEN src/utils/legacy-helper.ts 有 `export function oldFormat() {}` 但全项目 0 references
- WHEN DeadcodeFinder.find
- THEN deadExports 含 `{ name: "oldFormat", file: "src/utils/legacy-helper.ts", line: 5 }`
- AND 报告产出,标"可删"标记

**Scenario: 动态 import 误报**
- GIVEN src/foo.ts `export async function lazyLoad() {}`,被 `await import("./foo.js")` 引用
- WHEN DeadcodeFinder 静态扫描
- THEN 误判为 dead (动态 import 静态看不到)
- AND 记 `code.deadcode.dynamic_import_missed_total` +1
- AND 提示"如确认有用,加 ignore 注释 `// @keepalive`"

## CAP-CODE-03 (NEW) 复杂度与重复率

**Given** AstAnalyzer 已产出 function records
**When** ComplexityReporter.run(astSnapshot) + DuplicationScanner.run(projectRoot)
**Then** 产出:
  - **圈复杂度**:每个 function 的 cyclomatic complexity(via `escomplex`)
  - 标 `complexity > 15` 为"危险函数",写入 `dangerFunctions: { name, file, line, complexity }[]`
  - 写 `code.complexity_p95` (gauge) = 全项目函数复杂度 p95
  - 写 `code.danger_functions` (gauge) = 危险函数个数
  - **重复率**:调 `jscpd` 子进程扫 `src/`,解析 JSON 输出
  - 写 `code.duplication_pct` (gauge) = 重复行数 / 总行数 × 100
  - 写 `code.duplication_scan_failed_total` (counter) for jscpd 异常
**And** 复杂度单文件 < 1s,jscpd 扫 src/ < 30s
**And** 危险函数超过 10 个时,evolution-service 优先把"减少复杂度"作为 insight 候选

**实现要点:**
- `src/observability/code-health/complexity-reporter.ts` — 依赖 `escomplex` (prod dep,小,无 native)
- `src/observability/code-health/duplication-scanner.ts` — spawn `jscpd` 子进程(需系统装 `npm i -g jscpd` 或 local node_modules 跑)
- 复杂度阈值默认 15,env `DEV_BRAIN_COMPLEXITY_DANGER=15` 可调
- jscpd 路径探测:优先 `node_modules/.bin/jscpd`,fallback 全局 `jscpd`,再 fallback 跳过 + 写 failed_total

**Scenario: 找到嵌套深的危险函数**
- GIVEN src/orchestrator/dag-scheduler.ts 有一个 `run()` 函数,cyclomatic complexity = 22
- WHEN ComplexityReporter
- THEN dangerFunctions 含 `{ name: "run", file: "src/orchestrator/dag-scheduler.ts", line: 45, complexity: 22 }`
- AND `code.danger_functions` gauge = N (含这个)

**Scenario: jscpd 重复率扫描**
- GIVEN dev-brain 自身代码,~5% 重复(主要在测试 fixture)
- WHEN DuplicationScanner.run
- THEN `code.duplication_pct` gauge = 5.2 (近似)
- AND 报告 detail 在 `~/.dev-brain/code-health/jscpd-<date>.json`

**Scenario: jscpd 未装跳过**
- GIVEN 环境无 jscpd 二进制
- WHEN DuplicationScanner
- THEN 写 `code.duplication_scan_failed_total` +1
- AND 写 `code.duplication_pct` = -1(标记为"未知")
- AND 不阻塞其他观测

## CAP-CODE-04 (NEW) 僵尸代码检测

**Given** git 历史 + AstAnalyzer 产出 + 测试覆盖数据
**When** ZombieDetector.find(projectRoot, astSnapshot)
**Then** 找出"僵尸文件":满足**全部**条件:
  - `git log -1 --format=%ct <file>` 得最后改动时间 > 90 天
  - 该文件**无单元测试覆盖** (没被任何 `*.test.ts` import)
  - 该文件**无外部引用** (即 deadExports 含其导出)
  - 文件 LOC > 50(过滤掉 trivial 文件)
**And** 产出 `ZombieReport { zombies: { path, lastTouchedAt, loc, reasons[] }[] }`
**And** 写 `code.zombie_files` (gauge) = zombies.length
**And** 阈值 env 可调: `DEV_BRAIN_ZOMBIE_DAYS=90`

**实现要点:**
- `src/observability/code-health/zombie-detector.ts` — 调 `git log` 子进程,无需新 dep
- 复用 DeadcodeFinder 输出(只对 deadExports 关联的文件计算)
- 测试覆盖判定:反向扫描 `tests/**/*.test.ts` 找 import 语句
- 与 evolution 联动:zombie_files > 5 时,insight-engine 优先产"清理建议"

**Scenario: 找到老旧工具模块**
- GIVEN src/utils/legacy-formatter.ts 最后改动 2025-01-01,无测试,无外部引用,LOC=120
- WHEN ZombieDetector.find
- THEN zombies 含该文件
- AND 写 `code.zombie_files` +1
- AND 报告提示"建议删除或加测试"

**Scenario: 活跃文件不被误判**
- GIVEN src/runtime/checkpoint.ts 每周都改,有测试,有引用
- WHEN ZombieDetector
- THEN 不在 zombies 列表(最后改动 < 90 天)

**Scenario: LOC 过滤**
- GIVEN src/index.ts 100 天没动,但 LOC = 5 (一行 export)
- WHEN ZombieDetector
- THEN 排除(LOC < 50 阈值)

## 集成: 每日 Snapshot 打包

**Given** 4 项分析器各自产出
**When** CodeHealthSnapshot.build(projectRoot) 被 cron 触发(每日 02:00)
**Then** 顺序跑:
  1. `AstAnalyzer.parse` → ast-cache
  2. `DeadcodeFinder.find` (依赖 ast)
  3. `ComplexityReporter.run` (依赖 ast)
  4. `DuplicationScanner.run` (独立,慢,放最后)
  5. `ZombieDetector.find` (依赖 ast + deadcode + git)
**And** 打包为 `CodeHealthSnapshot`:
  ```
  {
    taken_at: "2026-06-06T02:00:00.000Z",
    git_sha: "abc123",
    metrics: { dead_exports, complexity_p95, duplication_pct, zombie_files },
    details: { deadcode: [...], dangerFunctions: [...], zombies: [...] }
  }
  ```
**And** 写盘 `~/.dev-brain/code-health/<YYYY-MM-DD>.json`
**And** 上报 4 gauge metric(取最新 snapshot 的 metrics 字段)
**And** 写 `code.snapshot.taken_total` +1,`code.snapshot.failed_total` for 异常

**Scenario: 每日 snapshot 成功**
- GIVEN cron 02:00 触发 build()
- WHEN 5 步顺序跑完
- THEN 6s 内完成,产出 snapshot.json,4 gauge 更新
- AND 写 `code.snapshot.taken_total` +1

**Scenario: jscpd 失败但 snapshot 仍出**
- GIVEN jscpd 不可用,其它 4 步成功
- WHEN build()
- THEN duplication_pct = -1,其他 3 项正常,仍出 snapshot.json
- AND 日志 warn,metric `code.snapshot.partial_total` +1
