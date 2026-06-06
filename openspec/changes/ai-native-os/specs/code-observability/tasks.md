---
demand-id: DM-20260606-003
change: ai-native-os
module: code-observability
status: developing
---

# Code Observability — Tasks

> **v0.11.0 修订**: 经行业调研 (knip / CodeScene / SonarQube / fallow / repo-entropy), 原始设计增强为: KnipAdapter 入口驱动死代码检测 + 可插拔分析后端 + 热点评分 + AI 代码气味检测 + SnapshoDelta 增量比较。详见 `design.md`。

## 1. 类型骨架

- [ ] `src/observability/code-health/types.ts` — 定义 `AstSnapshot` / `DeadcodeReport` / `ComplexityResult` / `DuplicationResult` / `ZombieReport` / `HotspotScore` / `AICodeSmell` / `DeltaReport` / `CodeHealthSnapshot` / `CodeHealthForEvolution` / `DeadcodeAdapter` / `ComplexityBackend` / `DuplicationBackend`
- [ ] `src/observability/metrics.ts` 注册新增 metric: delta 系列 (4 个) / hotspot 系列 (2 个) / ai_smell_total (1 个) / deadcode.knip_failed_total (1 个) / snapshot.delta_failed_total (1 个)

## 2. AstAnalyzer + worker_thread 隔离 (CAP-CODE-01)

- [ ] `src/observability/code-health/ast-analyzer.ts` — `class AstAnalyzer { parse(sources): Promise<AstSnapshot> }`
- [ ] 用 `ts-morph` 解析 .ts,产出 `files[]` / `functions[]` / `exports[]` / `callGraph`
- [ ] **worker_thread 隔离**: spawn 在独立子进程,不阻塞 daemon 事件循环
- [ ] mtime 缓存提升为函数级: `~/.dev-brain/code-health/ast-cache-<hash>.json`,基于文件级 mtime 失效
- [ ] 失败兜底:语法错文件单独 catch,产出 `{ path, error }` + 写 `code.ast.parse_failed_total`
- [ ] 性能: 单文件 < 500ms (P95), 全 src/ < 30s
- [ ] 单测 `tests/unit/code-health/ast-analyzer.test.ts`: 5 个 case (含语法错文件、缓存命中、调用图正确性、worker 通信、函数级缓存)

## 3. DeadcodeDetector — KnipAdapter + 降级路径 (CAP-CODE-02)

### 3.a DeadcodeAdapter 接口 + DeadcodeDetector 编排

- [ ] `src/observability/code-health/deadcode-detector.ts` — `class DeadcodeDetector { find(root, ast): Promise<DeadcodeReport> }`
- [ ] 编排双路径: 首选 KnipAdapter → 降级 DeadcodeFinder
- [ ] 降级触发: knip 未安装 / `npx knip` 非 0 / 超时 > 60s
- [ ] 写 `code.deadcode.knip_failed_total` (counter) for 降级事件

### 3.b KnipAdapter (主路径)

- [ ] `src/observability/code-health/knip-adapter.ts` — `class KnipAdapter implements DeadcodeAdapter { find(root): Promise<DeadcodeReport> }`
- [ ] 调 `npx knip --reporter json`,解析 JSON → DeadcodeReport
- [ ] 自动处理 re-export 链 / 动态 import / monorepo
- [ ] 超时 60s

### 3.c DeadcodeFinder (降级路径)

- [ ] `src/observability/code-health/deadcode-finder.ts` — 保留原始引用计数实现
- [ ] 找 0 references 的 export + class public methods
- [ ] 豁免: 测试文件 + 入口文件 + 最近 7 天新增
- [ ] 准确率 ≥ 90% (人工 spot-check 20 样本)
- [ ] 动态 import 误报: 写 `code.deadcode.dynamic_import_missed_total` + `// @keepalive` 提示

### 3.d 测试

- [ ] 单测 `tests/unit/code-health/knip-adapter.test.ts`: 3 场景 (正常输出/knip 不可用/超时)
- [ ] 单测 `tests/unit/code-health/deadcode-detector.test.ts`: 3 场景 (knip 路径/降级路径/knip 超时降级)
- [ ] 单测 `tests/unit/code-health/deadcode-finder.test.ts`: 保持现有,更新 assertion

## 4. ComplexityReporter + DuplicationScanner (CAP-CODE-03)

### 4.a 可插拔后端接口

- [ ] `src/observability/code-health/backends/types.ts` — 定义 `ComplexityBackend` / `DuplicationBackend` 接口

### 4.b ComplexityReporter

- [ ] `src/observability/code-health/complexity-reporter.ts` — `class ComplexityReporter { run(ast, backend?): Promise<ComplexityResult> }`
- [ ] 默认后端 `EscomplexBackend`: 圈复杂度 + 认知复杂度 (via escomplex cognitive 字段)
- [ ] **CRAP 评分**: `complexity² × (1 - coverage/100)³ + complexity`,覆盖率从 `pnpm test:coverage` JSON 获取
- [ ] **变更频率**: `git log --since="90 days ago" --oneline <file> | wc -l`
- [ ] 危险函数阈值默认 15,env `DEV_BRAIN_COMPLEXITY_DANGER=15` 可调
- [ ] 写 `code.complexity_p95` / `code.danger_functions`
- [ ] 单测 `tests/unit/code-health/complexity-reporter.test.ts`: 4 场景 (正常/CRAP 计算/认知复杂度/backend 切换)

### 4.c DuplicationScanner

- [ ] `src/observability/code-health/duplication-scanner.ts` — `class DuplicationScanner { run(root, backend?): Promise<DuplicationResult> }`
- [ ] 默认后端 `JscpdBackend`: spawn `jscpd` 子进程,解析 JSON
- [ ] jscpd 路径探测: `node_modules/.bin/jscpd` → 全局 `jscpd` → fallback
- [ ] 写 `code.duplication_pct` / `code.duplication_scan_failed_total`
- [ ] 单测 `tests/unit/code-health/duplication-scanner.test.ts`: 3 场景 (正常/jscpd 未装/backend 切换)

## 5. ZombieDetector + HotspotScorer + AICodeSmellDetector (CAP-CODE-04)

### 5.a ZombieDetector (加权评分)

- [ ] `src/observability/code-health/zombie-detector.ts` — `class ZombieDetector { find(root, ast, deadcode): Promise<ZombieReport> }`
- [ ] 加权评分公式: `0.35×age + 0.25×test_gap + 0.20×dead_refs + 0.15×loc + 0.05×churn`
- [ ] score ≥ 0.6 → 标记为僵尸,按 score 降序输出
- [ ] 阈值 env 可调: `DEV_BRAIN_ZOMBIE_DAYS=90` / `DEV_BRAIN_ZOMBIE_SCORE_THRESHOLD=0.6`
- [ ] 调 `git log -1 --format=%ct <file>` 拿 age
- [ ] 测试覆盖判定: 反向扫描 `tests/**/*.test.ts` 找 import
- [ ] 写 `code.zombie_files` (gauge)
- [ ] 单测 `tests/unit/code-health/zombie-detector.test.ts`: 5 场景 (高僵尸/活跃/边界 score/AI bonus/churn 影响)

### 5.b HotspotScorer (NEW)

- [ ] `src/observability/code-health/hotspot-scorer.ts` — `class HotspotScorer { score(file, gitHistory, ast): HotspotScore }`
- [ ] 公式: `0.3×age + 0.3×churn + 0.2×complexity + 0.1×deadRefs + 0.1×testGap`
- [ ] score > 70 → danger hotspot
- [ ] 写 `code.hotspot_avg_score` / `code.hotspot_danger_count`
- [ ] 单测 `tests/unit/code-health/hotspot-scorer.test.ts`: 3 场景 (高热点/正常/全 0)

### 5.c AICodeSmellDetector (NEW)

- [ ] `src/observability/code-health/ai-smell-detector.ts` — `class AICodeSmellDetector { detect(ast, deadcode): AICodeSmell[] }`
- [ ] 4 种气味检测: wrapper_only / hallucinated_import / unused_abstraction / deep_nesting
- [ ] 写 `code.ai_smell_total` (gauge)
- [ ] AI 气味文件在 zombie_score 中 +10 bonus
- [ ] 单测 `tests/unit/code-health/ai-smell-detector.test.ts`: 4 场景 (各气味/混合/空项目/与 zombie 联动)

## 6. Snapshot 打包 + Delta 比较 (集成)

### 6.a Snapshot 打包

- [ ] `src/observability/code-health/snapshot.ts` — `CodeHealthSnapshot.build(projectRoot)`
- [ ] 顺序跑 6 步 (含 AICodeSmellDetector),异常隔离 (单步失败不影响其他)
- [ ] 落 `~/.dev-brain/code-health/<YYYY-MM-DD>.json`
- [ ] cron 每日 02:00 触发
- [ ] 写 `code.snapshot.taken_total` / `code.snapshot.failed_total` / `code.snapshot.partial_total`
- [ ] 单测 `tests/unit/code-health/snapshot.test.ts`: 4 场景 (完整/knip 降级/jscpd 失败 partial/AI smell 独立失败)

### 6.b SnapshoDelta (NEW)

- [ ] `src/observability/code-health/snapshot-comparator.ts` — `class SnapshotComparator { compare(today, yesterday): DeltaReport }`
- [ ] diff 每个维度: deadExports / dangerFunctions / duplications / zombies
- [ ] 标记 trend: improving (netChange < -2) / stable (-2..2) / degrading (> 2)
- [ ] 写 4 delta metric (gauge)
- [ ] 连续 3 天 degrading → alert
- [ ] 昨日 snapshot 不存在 → 写 `code.snapshot.delta_failed_total` +1, skip
- [ ] 单测 `tests/unit/code-health/snapshot-comparator.test.ts`: 4 场景 (improving/stable/degrading/missing yesterday)

### 6.c CodeHealthForEvolution 数据契约

- [ ] `src/observability/code-health/evolution-contract.ts` — `function toEvolutionInput(snapshot, delta): CodeHealthForEvolution`
- [ ] 产出 current (6 指标) + trend (4 delta) + topIssues (3 × Top 5)
- [ ] 单测 `tests/unit/code-health/evolution-contract.test.ts`: 2 场景 (正常转换/partial 数据)

## 7. Grafana + 文档

- [ ] `ops/grafana/dev-brain-dashboard.json` 更新 panel "Code Health (v0.11.0)": 增加 hotspot_avg_score / ai_smell_total / delta 趋势
- [ ] `docs/code-health.md` (新) — 7 项观测含义 + 6 个 Playbook (含 delta degrading / hotspot danger / AI smell 处置)
- [ ] `docs/observability.md` (扩) — 加新增 metric 含义
- [ ] `tests/unit/ops-files.test.ts` panel 数量断言更新

## 集成

### 与 brain-engine 集成

- [ ] `src/brain/brain-engine.ts` — 接入 CodeHealthSnapshot cron 触发 (每日 02:00),失败写 metric 不阻塞主流程

### 与 evolution 集成

- [ ] `src/evolution/insight-engine.ts` — 接收 `CodeHealthForEvolution` 作为第 1 类输入 (codeHealth)
- [ ] topIssues 直接映射为 insight 候选 (dead_exports ↑ → "清理死代码" / complexity ↑ → "重构危险函数" / zombies ↑ → "清理僵尸文件")

### 与 Grafana 集成

- [ ] 4 gauge + 4 delta + 3 新 metric (hotspot_avg / hotspot_danger / ai_smell) 全部在 Grafana panel 渲染

## 验证

- [ ] `pnpm typecheck` 绿
- [ ] `pnpm test` 绿 (code-observability 模块新增 ~28 测试场景)
- [ ] `pnpm test:coverage` 维持 85%/74%
- [ ] 实跑 `CodeHealthSnapshot.build(dev-brain/)` 验证 6 步产出 + delta 比较 + metric 上报
- [ ] knip 未装时 graceful 降级,partial_total 写入
- [ ] jscpd 未装时 graceful skip,duplication_pct=-1
- [ ] Delta 连续 3 天 degrading 验证 alert 触发
