---
demand-id: DM-20260606-003
change: ai-native-os
status: developing
---

# Code Observability Spec (Delta — v0.11.0)

本文为 AI Native OS 引入"代码态"可观测能力,产出 4 项指标喂给 Phase E 自我进化。
v0.10.0 已有"运行时"可观测(trace + 53 metric),本 spec 补"代码侧"的另一半。

> **v0.11.0 修订**: 经行业调研 (knip / CodeScene / SonarQube / fallow / repo-entropy), 增强为: KnipAdapter 入口驱动死代码检测 + 可插拔分析后端 + 热点评分 + AI 代码气味检测 + SnapshoDelta 增量比较。详见 `design.md`。

## CAP-CODE-01 (REVISED) AST 静态分析

> **v0.11.0 修订**: 保留 ts-morph (类型推断不可替代), 增加 worker_thread 隔离 + 函数级 mtime 缓存。

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
- **worker_thread 隔离**: spawn 在独立子进程,不阻塞 daemon 事件循环 (解决 ts-morph 初始化 3-5s 的核心矛盾)
- 与 v0.10.0 metrics.ts 联动:启动时注册 4 个新 gauge
- tsconfig.json 同步:用 `tsconfig.json` 的 paths/baseUrl 让 ts-morph 解析别名
- 失败兜底:语法错文件单独 catch,产出"该文件 skip,原因: e.message"
- mtime 缓存提升为函数级:缓存命中时仅重解析修改过的文件 (而非全量重解析)

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

## CAP-CODE-02 (REVISED) 死代码检测 — KnipAdapter 主路径 + 引用计数降级

> **v0.11.0 修订**: knip 入口驱动图算法明显优于简单引用计数 (9.4K stars, 工业验证)。增加 KnipAdapter 作为主路径,原 DeadcodeFinder 引用计数作为降级路径。

**Given** AstAnalyzer 已产出 `exports[]` + `references[]`
**When** DeadcodeDetector.find(projectRoot, astSnapshot)
**Then** 首选路径: KnipAdapter — 调 `npx knip --reporter json` 获取入口驱动的死代码结果
**And** 降级路径: knip 不可用时 (未安装/超时/版本不兼容),退到 DeadcodeFinder 引用计数扫描
**And** 输出 `DeadcodeReport { deadExports: Symbol[], deadMethods: Method[], unreachableFiles: string[], total: number, source: "knip" | "fallback" }`
**And** 写 `code.dead_exports` (gauge) = deadExports.length
**And** knip 不可用时写 `code.deadcode.knip_failed_total` +1
**And** 测试文件(`*.test.ts` / `__tests__/`)和入口文件(`src/index.ts`)豁免

**KnipAdapter 的优势**:
- 入口驱动图:从 entry points 递归构建可达模块图,不在图内 = 死代码
- 自动处理 re-export 链 (`export * from './foo'`)
- ~150 插件自动识别框架入口 (vitest/vite/next.js 等)
- 动态 import 有 `@public` 标记策略

**降级路径 DeadcodeFinder** (保留原始实现):
- 找出所有"被定义但从未被引用"的符号:顶层 export + class public methods
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

**Scenario: KnipAdapter 主路径成功**
- GIVEN dev-brain 项目已安装 knip (`npx knip` 可用)
- WHEN DeadcodeDetector.find()
- THEN KnipAdapter 调 `npx knip --reporter json`,解析输出
- AND 产出 DeadcodeReport with source="knip"
- AND 结果包含 unreachableFiles (knip 特有: 不在模块图中的文件)

**Scenario: Knip 不可用降级**
- GIVEN 环境无 knip 或版本不兼容
- WHEN DeadcodeDetector.find()
- THEN KnipAdapter 失败,记 `code.deadcode.knip_failed_total` +1
- AND 自动降级到 DeadcodeFinder 引用计数扫描
- AND 产出 DeadcodeReport with source="fallback"

**实现要点:**
- `src/observability/code-health/deadcode-detector.ts` — `class DeadcodeDetector { find(root, ast): Promise<DeadcodeReport> }` (编排双路径)
- `src/observability/code-health/knip-adapter.ts` — `class KnipAdapter implements DeadcodeAdapter { find(root): Promise<DeadcodeReport> }` (NEW)
- `src/observability/code-health/deadcode-finder.ts` — 保留作为降级路径: `class DeadcodeFinder implements DeadcodeAdapter { find(snap, root): DeadcodeReport }`
- knip 调 `npx knip --reporter json`,解析 JSON 转 DeadcodeReport
- 降级触发条件: knip 未安装 / `npx knip` 非 0 / 超时 > 60s
- 写 `code.deadcode.knip_failed_total` (counter) for 降级事件

## CAP-CODE-03 (REVISED) 复杂度与重复率 — 可插拔后端

> **v0.11.0 修订**: escomplex 和 jscpd 保留为默认后端,增加 Backend 接口支持 cccc/fallow 可选升级。新增 CRAP 评分 + 认知复杂度。

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

### 新增指标

**And** 增加 **CRAP 评分** (Change Risk Analysis and Prevention):
  - `CRAP(函数) = complexity² × (1 - coverage_pct/100)³ + complexity`
  - CRAP > 30 的函数标记为"高风险",优先推荐重构
**And** 增加 **认知复杂度** (Cognitive Complexity): SonarQube 标准,比圈复杂度更准确反映"人类理解难度"
**And** 增加 **变更频率** (Churn): 从 git log 获取近 90 天修改次数,高频+高复杂=最危险

### 可插拔后端

**And** 分析后端接口化,支持未来升级:

```typescript
interface ComplexityBackend {
  analyze(functions: FunctionRecord[]): Promise<ComplexityResult>;
}
interface DuplicationBackend {
  scan(projectRoot: string): Promise<DuplicationResult>;
}
```

**And** 默认后端: `EscomplexBackend` + `JscpdBackend` (npm 可安装,零额外依赖)
**And** 可选后端: `CcccBackend` (Rust, 117x faster) / `FallowBackend` (Rust, semantic duplication) — 需额外安装

**实现要点:**
- `src/observability/code-health/complexity-reporter.ts` — `class ComplexityReporter { run(ast, backend?): Promise<ComplexityResult> }` (backend 可注入)
- `src/observability/code-health/duplication-scanner.ts` — `class DuplicationScanner { run(root, backend?): Promise<DuplicationResult> }` (backend 可注入)
- 默认后端: `escomplex` (prod dep) + `jscpd` 子进程
- CRAP 评分: 需测试覆盖率数据 (从 `pnpm test:coverage` JSON 报告获取)
- 认知复杂度: 通过 `escomplex` 的 cognitive 字段 (已内置支持)
- 变更频率: `git log --since="90 days ago" --oneline <file> | wc -l`
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

## CAP-CODE-04 (REVISED) 僵尸代码检测 + 热点评分 + AI 代码气味

> **v0.11.0 修订**: 原始 4 条件 AND 判定升级为加权评分 + CodeScene 风格热点评分 + AI 专属代码气味检测。从"是/否"标签升级为"优先级排序",对 Evolution Pipeline 更有价值。

**Given** git 历史 + AstAnalyzer 产出 + 测试覆盖数据 + DeadcodeReport
**When** ZombieDetector.find(projectRoot, astSnapshot, deadcodeReport)
**Then** 产出加权僵尸评分 (替代原来的 AND 判定):

```
zombie_score = 0.35 × age_factor       // 距上次修改天数 (0-1 归一化, > 90d → 0.7+)
             + 0.25 × test_gap         // 无测试覆盖 = 1, 有测试 = 0
             + 0.20 × dead_refs        // 死引用比例 (0-1)
             + 0.15 × loc_factor       // LOC 归一化 (> 50 → 0.5+, > 200 → 0.8+)
             + 0.05 × churn_factor     // 变更频率 (低 churn = 高 zombie)
```

**And** `zombie_score ≥ 0.6` → 标记为僵尸文件
**And** 产出 `ZombieReport { zombies: { path, score, factors, lastTouchedAt, loc }[] }` (按 score 降序)
**And** 写 `code.zombie_files` (gauge) = zombies.length
**And** 阈值 env 可调: `DEV_BRAIN_ZOMBIE_DAYS=90` / `DEV_BRAIN_ZOMBIE_SCORE_THRESHOLD=0.6`

### HotspotScorer (NEW)

**And** 热点评分基于 CodeScene 启发:

```typescript
interface HotspotScore {
  file: string;
  score: number;           // 0-100, 越高越需要关注
  factors: {
    age: number;           // 距上次修改天数
    churn: number;         // 近 90 天修改次数
    complexity: number;    // 文件复杂度 p95
    deadRefs: number;      // 死引用数
    testGap: boolean;      // 无测试覆盖
  };
}
```

**And** 公式: `hotspot_score = 0.3 × age_norm + 0.3 × churn_norm + 0.2 × complexity_norm + 0.1 × deadRefs_norm + 0.1 × testGap_bonus`
**And** hotspot_score > 70 → 写 `code.hotspot_danger_count` +1
**And** 所有文件平均 hotspot_score → 写 `code.hotspot_avg_score` (gauge)

### AICodeSmellDetector (NEW)

**And** 检测 AI 生成代码的专属气味:

| 气味类型 | 检测规则 | 来源 |
|---------|---------|------|
| `wrapper_only` | 函数体只有一行调用 (过度抽象) | repo-entropy |
| `hallucinated_import` | import 了但从未真正使用的包 | The Janitor |
| `unused_abstraction` | 高度泛化的 interface/class 只有一个实现 | repo-entropy |
| `deep_nesting` | 嵌套 > 5 层 (AI 生成的常见问题) | repo-entropy |

**And** 写 `code.ai_smell_total` (gauge) = AI 气味总数
**And** AI 气味文件自动在僵尸评分中 +10 bonus points

**实现要点:**
- `src/observability/code-health/zombie-detector.ts` — `class ZombieDetector { find(root, ast, deadcode): Promise<ZombieReport> }`
- `src/observability/code-health/hotspot-scorer.ts` — `class HotspotScorer { score(file, gitHistory, ast): HotspotScore }` (NEW)
- `src/observability/code-health/ai-smell-detector.ts` — `class AICodeSmellDetector { detect(ast, deadcode): AICodeSmell[] }` (NEW)
- 调 `git log` 子进程获取 age + churn 数据,无需新 dep
- 复用 DeadcodeDetector 输出 (只对 deadExports 关联的文件计算)
- 测试覆盖判定:反向扫描 `tests/**/*.test.ts` 找 import 语句
- 与 evolution 联动:zombie_files > 5 时,insight-engine 优先产"清理建议",并按 hotspot_score 排序推荐

**Scenario: 高热点僵尸文件优先**
- GIVEN src/utils/legacy-formatter.ts 最后改动 2025-01-01 (high age), 近 90 天被改了 15 次 (high churn), 复杂度 p95=18 (high), 无测试
- WHEN ZombieDetector.find + HotspotScorer.score
- THEN zombie_score = 0.85 (高度僵尸) + hotspot_score = 82 (高热点)
- AND 排在清理建议列表第 1 位
- AND 报告提示"高频修改的僵尸代码 — 最值得清理"

**Scenario: 活跃文件不被误判**
- GIVEN src/runtime/checkpoint.ts 每周都改 (churn=high), 有测试, 有引用
- WHEN ZombieDetector
- THEN zombie_score < 0.4 (churn 高 + test_gap=0 = 非僵尸), 不在 zombies 列表

**Scenario: AI 气味检测**
- GIVEN Agent 产出 `src/utils/wrapper.ts` — 5 个函数每个只有一行调用 + 一个 interface 只有一个实现
- WHEN AICodeSmellDetector.detect
- THEN 报告: wrapper_only × 5 + unused_abstraction × 1
- AND 写 `code.ai_smell_total` = 6
- AND 这些文件在 zombie_score 中获得 +10 bonus

## 集成: 每日 Snapshot 打包 + Delta 比较 + Evolution 数据契约

> **v0.11.0 修订**: 增加 SnapshoDelta 增量比较 + 显式 CodeHealthForEvolution 数据契约。

**Given** 5 项分析器各自产出
**When** CodeHealthSnapshot.build(projectRoot) 被 cron 触发(每日 02:00)
**Then** 顺序跑:
  1. `AstAnalyzer.parse` → ast-cache (worker_thread 隔离)
  2. `DeadcodeDetector.find` (KnipAdapter 主路径 → DeadcodeFinder 降级)
  3. `ComplexityReporter.run` (依赖 ast,含 CRAP + 认知复杂度)
  4. `DuplicationScanner.run` (独立,慢,放最后)
  5. `ZombieDetector.find` + `HotspotScorer.score` (依赖 ast + deadcode + git)
  6. `AICodeSmellDetector.detect` (NEW, 依赖 ast + deadcode)
**And** 打包为 `CodeHealthSnapshot`:
  ```
  {
    taken_at: "2026-06-06T02:00:00.000Z",
    git_sha: "abc123",
    metrics: {
      dead_exports, complexity_p95, duplication_pct, zombie_files,
      hotspot_avg_score, hotspot_danger_count, ai_smell_total  // NEW
    },
    details: {
      deadcode: [...], dangerFunctions: [...], zombies: [...],
      hotspots: [...], aiSmells: [...]  // NEW
    }
  }
  ```
**And** 写盘 `~/.dev-brain/code-health/<YYYY-MM-DD>.json`
**And** 上报所有 gauge metric(取最新 snapshot 的 metrics 字段)
**And** 写 `code.snapshot.taken_total` +1,`code.snapshot.failed_total` for 异常

### SnapshoDelta (NEW) — 增量比较

**And** snapshot 成功后,自动与昨日 snapshot 比较:

```typescript
interface DeltaReport {
  date: string;
  comparedTo: string;
  summary: {
    improved: number;      // 修复的问题数
    worsened: number;      // 新增的问题数
    netChange: number;     // 净变化
    trend: 'improving' | 'stable' | 'degrading';
  };
  details: {
    newDeadExports: Symbol[];
    resolvedDeadExports: Symbol[];
    newDangerFunctions: FunctionRecord[];
    resolvedDangerFunctions: FunctionRecord[];
    newDuplications: Duplication[];
    resolvedDuplications: Duplication[];
    newZombies: FileInfo[];
    resolvedZombies: FileInfo[];
  };
}
```

**And** 写 4 delta metric: `code.dead_exports_delta` / `code.complexity_p95_delta` / `code.duplication_pct_delta` / `code.zombie_files_delta` (正=恶化)
**And** delta 比较失败 (昨日 snapshot 不存在或损坏) → 写 `code.snapshot.delta_failed_total` +1, skip delta
**And** trend = "degrading" 连续 3 天 → 触发 alert,通知 Evolution Pipeline

### CodeHealthForEvolution 数据契约

**And** 为 Phase E InsightEngine 提供结构化输入:

```typescript
interface CodeHealthForEvolution {
  current: {
    deadExports: number;
    complexityP95: number;
    duplicationPct: number;
    zombieFiles: number;
    aiSmellCount: number;      // NEW
    avgHotspotScore: number;    // NEW
  };
  trend: {
    deadExportsDelta: number;
    complexityDelta: number;
    duplicationDelta: number;
    zombieDelta: number;
  };
  topIssues: {
    deadExports: { file: string; count: number }[];      // Top 5
    dangerFunctions: { file: string; name: string; complexity: number; crap: number }[]; // Top 5
    zombies: { file: string; zombieScore: number; hotspotScore: number }[];   // Top 5
  };
}
```

**Scenario: 每日 snapshot 成功 + delta 比较**
- GIVEN cron 02:00 触发 build()
- WHEN 6 步顺序跑完
- THEN ~10s 内完成,产出 snapshot.json + delta.json,所有 gauge 更新
- AND delta 报告: "今日 dead_exports: 12 (昨日: 10, ↑2 恶化)"
- AND 写 `code.snapshot.taken_total` +1

**Scenario: 连续 3 天退化触发 alert**
- GIVEN delta trend = "degrading" 连续 3 天 (dead_exports ↑ + complexity ↑)
- WHEN 第 3 天 snapshot 完成
- THEN 触发 `code_health_degrading` alert
- AND Evolution Pipeline 收到"代码质量持续恶化"信号,优先分析原因

**Scenario: jscpd 失败但 snapshot 仍出**
- GIVEN jscpd 不可用,其它 5 步成功
- WHEN build()
- THEN duplication_pct = -1,其他所有指标正常,仍出 snapshot.json + delta.json
- AND 日志 warn,metric `code.snapshot.partial_total` +1
