---
demand-id: DM-20260606-003
change: ai-native-os
module: code-observability
status: developing
---

# Code Observability 深度设计：Grill with Docs 3 轮

**日期**: 2026-06-06
**关联**: `docs/philosophy.md`

---

## 目标锚定

### L1 — 用户说想要什么？

> "4 项代码态观测: AST 分析 + 死代码检测 + 复杂度/重复率 + 僵尸代码检测,每日产出 CodeHealthSnapshot,上报 4 个 metric。"

原始 spec (CAP-CODE-01..04) 的描述:
- CAP-CODE-01: ts-morph AST 解析 → 函数列表 + 调用图
- CAP-CODE-02: 基于 AST 的导出引用计数 → 死代码列表
- CAP-CODE-03: escomplex 圈复杂度 + jscpd 重复率
- CAP-CODE-04: git log + 测试覆盖 + 引用计数 → 僵尸文件

### L2 — 本质上用户想达成什么？

**用户不是在要"4 个代码扫描器"，用户在要一个数据基础:**

> 让自我进化系统能看到代码侧的质量信号——不只是"任务成功还是失败"(运行时信号)，还要能看到"代码本身是变好还是变坏了"(代码态信号)。换句话说，给 Evolution Pipeline 装上"代码眼睛"。

翻译成系统目标:
1. **量化代码质量**: 把"代码好坏"从主观感受变成可追踪的数字 (dead_exports / complexity_p95 / duplication_pct / zombie_files)
2. **趋势可比较**: 每天产出 snapshot,今天的代码和昨天的比,是变好了还是变差了
3. **精准定位**: 不只看整体分数,还要能指出"哪个文件的哪个函数是问题"
4. **喂给进化引擎**: Phase E 的 InsightEngine 需要结构化数据来生成"代码侧建议"(比如"p95 复杂度上升了 20%,建议重构最复杂的 3 个函数")

### L3 — 约束条件是什么？

| 约束 | 来源 | 严苛度 |
|------|------|--------|
| 不能阻塞 daemon 主进程 (解析慢会拖死整个系统) | 架构约束 | 硬约束 |
| 必须产出确定性结果 (同一份代码跑两次,结果必须一致) | 可重复性 | 硬约束 |
| 分析工具必须可安装 (不能依赖系统级二进制,如 Rust toolchain) | 部署约束 | 软约束 |
| 每日 snapshot 总耗时 < 60s (dev-brain ~50 文件) | 性能约束 | 软约束 |
| 新工具引入不能破坏现有 CI (pnpm test / pnpm typecheck) | 工程约束 | 硬约束 |
| 分析结果必须能映射到具体文件和行号 (Evolution Pipeline 需要精确位置来生成 diff) | 数据质量 | 硬约束 |

### 核心矛盾

```
代码态观测需要"深度分析"(类型信息 + 调用图 + 复杂度)
    ↕
深度分析需要"编译级工具"(ts-morph = 包装 TypeScript compiler API)
    ↕
编译级工具启动慢 (ts-morph 初始化 3-5s), 阻塞 daemon
    ↕
关键问题: 怎样在不阻塞主流程的前提下,获得足够深的代码分析数据?
```

**这就是 code-observability 要解决的本质问题。**

次要矛盾:

```
当前 spec 的 DeadcodeFinder 使用简单引用计数
    ↕
业界标准 (knip) 使用入口驱动的模块图
    ↕
引用计数有已知盲区 (动态 import / 字符串反射 / re-export 链)
    ↕
怎样在"自己实现"和"包装现有工具"之间做最优选择?
```

---

## 第 1 轮: 问题空间探索 — "业界怎么解决代码态观测问题的？"

### 信息来源

| 来源 | 类型 | 关键内容 |
|------|------|---------|
| [ts-morph](https://github.com/dsherret/ts-morph) (2025) | GitHub 7.5K stars | TypeScript Compiler API 包装器,完整的类型信息 + AST 操作,初始化 3-5s |
| [oxc](https://github.com/oxc-project/oxc) (2025-2026) | GitHub 15K stars | Rust 写的 JS/TS 解析器,100x 快于 tsc,但无类型推断 (type-checking 是 hard problem) |
| [knip](https://github.com/webpro-nl/knip) (2025-2026) | GitHub 9.4K stars | 入口驱动的模块图,~150 插件,已成为 TS dead code 检测的事实标准 |
| [fallow](https://github.com/fallow-rs/fallow) (2025-2026) | GitHub new | Rust-native 全能工具: 死代码 + 重复 + 复杂度 + 循环依赖 + 架构边界,34-46x 快于 knip |
| [cccc](https://lib.rs/crates/cccc-core) (Jun 2026) | Rust crate | 认知+圈复杂度计算器,117x 快于 ESLint+SonarJS,48x 少内存 (604MB→12.5MB) |
| [SonarQube Snapshot Model](https://docs.sonarsource.com/sonarqube-server/10.5/user-guide/concepts) (2025) | 行业标准 | 每次分析产出一个 Snapshot (measures at a point in time),数据库持久化,delta 比较 |
| [CodeScene Behavioral Code Analysis](https://codescene.com/product/behavioral-code-analysis) (2025) | 行业实践 | git 历史 × 复杂度 = 热点评分,CodeHealth 1-10 分,15x 更少缺陷 |
| [repo-entropy](https://www.npmjs.com/package/repo-entropy) (2025) | npm 包 | AI 生成代码质量检测: 死代码 + 重复 + 深层嵌套 + 超长文件 |
| [The Janitor](https://devops-actions.github.io/github-actions-marketplace-news/blog/2026/03/10/the-janitor-stop-the-slop/) (Mar 2026) | GitHub Action | 僵尸依赖检测 + 死符号移除 + 重复逻辑检测,AI 代码时代的结构防火墙 |
| [Veracode 2025 State of Software Security](https://www.veracode.com/) (2025) | 行业报告 | AI 生成代码含 36% 更多高危漏洞,强调代码态观测的必要性 |

### 关键发现

#### 发现 1: AST 分析 — ts-morph 的类型信息是不可替代的

原始 spec 用 `ts-morph` 做 AST 分析。业界有两个方向:
- **oxc/fallow** (Rust): 超快解析 (20K 文件 1.48s),但只有语法 AST,没有类型推断
- **ts-morph** (TypeScript Compiler API): 有完整类型信息,能追踪 `foo.bar()` 的 `bar` 定义,但初始化慢 3-5s

对于 dev-brain 的需求 (函数列表 + 调用图 + 导出引用),**调用图依赖类型推断**:
```typescript
const result = service.doSomething(); // oxc 知道 "doSomething()" 被调用,但不知道它属于哪个类
// ts-morph 可以通过类型推断定位到 Service 类的 doSomething 方法
```

**对 dev-brain 的影响**: ts-morph 是正确的选择。速度问题通过"独立子进程 + mtime 缓存"解决 (原始 spec 已经做了)。

#### 发现 2: 死代码检测 — 入口驱动图 > 简单引用计数

原始 spec 的 DeadcodeFinder 使用"扫描所有 export → 查全项目 references → 0 references = 死代码"的方法。knip 证明了更好的方式:

**入口驱动图算法** (knip):
1. 从配置的 entry points (如 `src/index.ts`) 出发
2. 沿 `import` 链递归构建可达模块图
3. 不在图内的 export/file = 死代码

优势:
- 自动处理 re-export 链 (`export * from './foo'`)
- 测试文件不作为可达性判定依据 (避免"只有测试用"的假活性)
- 动态 import 有明确的处理策略

**对 dev-brain 的影响**: 原始引用计数方法有已知盲区 (动态 import 误报 / re-export 链断裂)。knip 的入口驱动图算法更准确。但 knip 也是 npm 包,可以直接调 `npx knip --reporter json` 获取结果而非自己实现。

#### 发现 3: 复杂度和重复率 — Rust 工具正在取代 Node 工具

| 维度 | 当前 spec | 业界最优 | 差距 |
|------|----------|---------|------|
| 圈复杂度 | escomplex (JS) | cccc (Rust, 117x 快) | 对小型项目差距不大 |
| 重复率 | jscpd (JS, token-based) | fallow (Rust, semantic, 8-29x 快) | semantic mode 能发现改名克隆 |
| 整体速度 | ~30s | ~2s (fallow 全功能) | 对小型项目差距不大 |

**对 dev-brain 的影响**: dev-brain 只有 ~50 文件,性能差距不显著。但 **semantic duplication** (fallow) 和 **hotspot 评分** (CodeScene) 提供了原始 spec 没有的价值: 不只告诉你"有重复",还告诉你"哪段重复最值得修"(因为它被改得最多)。

#### 发现 4: 僵尸代码 — 二值判定不如热点评分

原始 spec 的 ZombieDetector 是二值判定: 满足 4 条件 → 僵尸,否则不是。CodeScene 的做法更好:

```
Hotspot Score = 修改频率 × 复杂度 × 代码年龄 × 作者集中度
```

这产生了一个可排序的优先级列表,而不是一个"是/否"的标签。Evolution Pipeline 可以优先处理高热点文件。

**对 dev-brain 的影响**: ZombieDetector 应该产出优先级评分而不仅是"是/否"。可以在原始 4 条件基础上增加 git churn 权重,让"被频繁修改的僵尸文件"排在前面。

#### 发现 5: AI 代码时代的特殊信号

repo-entropy 和 The Janitor 专门检测 AI 生成代码的常见问题:
- **过度抽象**: 只有一层调用的 wrapper 函数
- **幻觉 import**: import 了但从未真正使用的包
- **未用抽象**: 高度泛化但实际只用到一种情况的代码

这些是传统死代码检测不覆盖的模式,但对于 dev-brain (一个自我进化的 AI 系统) 特别有价值: 它可以检测到自己的进化是否产生了"AI 式代码腐烂"。

---

## 第 2 轮: 方案对比 — "在 dev-brain 约束下哪个最优？"

### 候选方案

| 方案 | 核心思路 | 工具链 |
|------|---------|--------|
| **A: 原始 spec** | ts-morph + 引用计数 + escomplex + jscpd, 全部 Node.js | ts-morph + escomplex + jscpd |
| **B: Rust 全家桶** | 全 Rust 工具链, 追求极致性能 | oxc + fallow + cccc (替代 ts-morph + escomplex + jscpd) |
| **C: 混合方案 A (推荐)** | 保留 ts-morph + 引入 knip 入口驱动算法 + 增加热点评分 + SnapshoDelta | ts-morph + escomplex + jscpd + knip (可选) |
| **D: 混合方案 B** | ts-morph + fallow 全功能 | ts-morph + fallow |

### 方案对比矩阵

| 维度 | A (原 spec) | B (Rust 全家桶) | C (混合 A, 推荐) | D (混合 B) |
|------|-----------|---------------|-----------------|-----------|
| 类型信息 (调用图) | ⭐⭐⭐⭐⭐ (ts-morph) | ⭐⭐ (oxc 无类型推断) | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ (ts-morph) |
| 死代码准确率 | ⭐⭐⭐ (引用计数) | ⭐⭐⭐⭐ (入口图) | ⭐⭐⭐⭐⭐ (入口图 via knip) | ⭐⭐⭐⭐ |
| 重复检测质量 | ⭐⭐⭐ (token only) | ⭐⭐⭐⭐⭐ (semantic) | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| 安装复杂度 | ⭐⭐ (npm install 3 包) | ⭐⭐⭐ (需 Rust 工具链或下载 binary) | ⭐⭐ | ⭐⭐⭐ |
| dev-brain 适配 | ⭐⭐⭐⭐ | ⭐⭐ (oxc 无类型推断=调用图不可用) | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| 长期演进性 | ⭐⭐ (escomplex 不再维护) | ⭐⭐⭐⭐ (Rust 生态活跃) | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| 热点评分 | ❌ | ❌ | ✅ (CodeScene 风格) | ❌ |
| SnapshoDelta | ❌ | ❌ | ✅ (SonarQube 风格) | ❌ |

### 推荐: 方案 C — 混合方案 A

**核心理由**:

1. **ts-morph 不可替代**: 调用图需要类型推断,oxc/fallow 都不提供。这是硬需求。
2. **knip 入口驱动算法**: 明显优于引用计数,且 knip 已经是 npm 包,引入成本极低 (`npx knip --reporter json`)。
3. **热点评分增值大**: CodeScene 风格的 `churn × complexity × age` 评分让 ZombieDetector 从"是/否"升级为"优先级排序",对 Evolution Pipeline 更有价值。
4. **SnapshoDelta 是自然延伸**: 每日 snapshot 已经有了,加一个 delta 比较 (今天 vs 昨天) 成本极低但价值高。
5. **不引入 Rust 工具链**: dev-brain 运行环境不一定有 Rust,而 npm 包是确定可用的。
6. **Rust 工具作为可插拔后端**: 架构设计上预留接口,未来可切换。

---

## 第 3 轮: 详细设计

### 3.1 架构概览

```
CodeHealthSnapshot.build(projectRoot)
│
├── Phase 1: AST 解析 (ts-morph, 独立子进程)
│   └── AstAnalyzer.parse()
│       产出: AstSnapshot { files[], functions[], exports[], callGraph }
│
├── Phase 2: 死代码检测
│   ├── 主路径: KnipAdapter.run() → 调 npx knip --reporter json
│   ├── 降级路径: DeadcodeFinder.find() → 基于 AstSnapshot 引用计数
│   └── 产出: DeadcodeReport { deadExports[], unreachableFiles[] }
│
├── Phase 3: 复杂度 + 重复率
│   ├── ComplexityReporter.run() → escomplex (保留) / cccc (可选后端)
│   └── DuplicationScanner.run() → jscpd (保留) / fallow (可选后端)
│
├── Phase 4: 僵尸检测 + 热点评分 (NEW)
│   └── ZombieDetector.find() + HotspotScorer.score()
│       产出: ZombieReport { zombies[], hotspots[] }
│
├── Phase 5: SnapshoDelta (NEW)
│   └── SnapshotComparator.compare(today, yesterday)
│       产出: DeltaReport { improved[], worsened[], newIssues[], resolvedIssues[] }
│
└── 打包: CodeHealthSnapshot + DeltaReport
    落盘: ~/.dev-brain/code-health/<YYYY-MM-DD>.json
    上报: 4 gauge metric (dead_exports / complexity_p95 / duplication_pct / zombie_files)
          + 4 delta metric (新增)
```

### 3.2 核心改动 vs 原始 spec

| 原始 spec | 混合增强版 | 改动理由 |
|-----------|----------|---------|
| DeadcodeFinder 引用计数 | KnipAdapter (入口驱动图) + DeadcodeFinder 降级兜底 | knip 准确率更高 (re-export 链/动态 import),降级路径保证可用性 |
| ZombieDetector 二值判定 | ZombieDetector + HotspotScorer (churn × complexity × age) | CodeScene: 优先级排序 > 是/否标签 |
| 无 delta 比较 | SnapshoDelta (今日 vs 昨日) | SonarQube: 趋势 > 单点值,"代码在变好吗?" |
| 工具硬编码 | PluggableBackend 接口 (escomplex/cccc, jscpd/fallow) | 未来可切换更快后端 |
| 无 AI 代码信号 | AICodeSmellDetector (过度抽象/幻觉 import/未用抽象) | repo-entropy/The Janitor: AI 时代的专属信号 |

### 3.3 CAP-CODE-01 增强: 保留 ts-morph + mtime 缓存

> 原始 spec 的 ts-morph 选择是正确的。增强点: 独立子进程 + 预热策略。

**保留**:
- `ts-morph` 解析,产出函数列表 + 调用图
- mtime 缓存 (`~/.dev-brain/code-health/ast-cache-<hash>.json`)
- 单文件 < 500ms (P95)

**增强**:
- **独立子进程**: `AstAnalyzer` spawn 在 worker_thread 中,不阻塞 daemon 事件循环
- **mtime 粒度从文件级提升到函数级**: 缓存命中时,只重解析修改过的文件

**为什么不用 oxc**: oxc 只有语法 AST,没有类型推断。以下场景 oxc 无法处理:
```typescript
// oxc 知道 foo() 被调用了,但不知道 foo 是 MyService.foo
const service = new MyService();
service.foo(); // ts-morph 可以通过类型推断定位到 MyService.foo()
```

### 3.4 CAP-CODE-02 增强: KnipAdapter + DeadcodeFinder 双路径

> knip 入口驱动图算法明显优于简单引用计数。但 knip 可能不可用 (未安装/版本不兼容),需要降级路径。

```typescript
interface DeadcodeAdapter {
  find(projectRoot: string, opts?: DeadcodeOptions): Promise<DeadcodeReport>;
}

class KnipAdapter implements DeadcodeAdapter {
  async find(projectRoot: string): Promise<DeadcodeReport> {
    // 调 npx knip --reporter json --exclude tests
    // 解析 knip JSON 输出 → DeadcodeReport
  }
}

class DeadcodeFinder implements DeadcodeAdapter {
  // 原始引用计数实现 (降级路径)
  async find(snapshot: AstSnapshot): Promise<DeadcodeReport> {
    // 扫描所有 export → 查全项目 references → 0 = dead
  }
}

class DeadcodeDetector {
  // 主路径 → 降级路径
  async find(projectRoot: string): Promise<DeadcodeReport> {
    try {
      return await this.knipAdapter.find(projectRoot);
    } catch (knipError) {
      this.metrics.knipFailed.inc();
      return await this.fallbackFinder.find(await this.astSnapshot);
    }
  }
}
```

**knip 的优势**:
- 自动处理 re-export 链 (`export * from`)
- 通过 plugins 自动识别测试文件框架
- 动态 import 有处理策略 (标记为 `@public` 即可)
- MCP server 集成 (`@knip/mcp`)

**降级路径触发条件**:
- knip 未安装 (`npx knip` 返回非 0)
- knip 版本不兼容
- knip 运行超时 (> 60s)

### 3.5 CAP-CODE-03 增强: 可插拔后端 + 新版复杂度指标

```typescript
interface ComplexityBackend {
  analyze(functions: FunctionRecord[]): Promise<ComplexityResult>;
}

interface DuplicationBackend {
  scan(projectRoot: string): Promise<DuplicationResult>;
}

// 默认后端 (npm 可安装)
class EscomplexBackend implements ComplexityBackend { /* ... */ }
class JscpdBackend implements DuplicationBackend { /* ... */ }

// 可选后端 (更快,需额外安装)
class CcccBackend implements ComplexityBackend { /* ... */ }  // Rust, 117x faster
class FallowBackend implements DuplicationBackend { /* ... */ } // Rust, semantic mode
```

**新增 CRAP 评分** (Change Risk Analysis and Prevention):
```
CRAP(函数) = complexity² × (1 - coverage_pct/100)³ + complexity
```

CRAP 评分 > 30 的函数自动标记为"高风险",优先推荐重构。

**增补信号**: 除圈复杂度外,增加:
- **认知复杂度** (Cognitive Complexity): SonarQube 标准,比圈复杂度更准确反映"人类理解难度"
- **变更频率** (Churn): 从 git log 获取,高频修改 + 高复杂度的函数最危险

### 3.6 CAP-CODE-04 增强: 热点评分 + AI 代码气味

#### HotspotScorer (NEW)

```typescript
interface HotspotScore {
  file: string;
  score: number;           // 0-100, 越高越需要关注
  factors: {
    age: number;           // 距上次修改天数 (0-1 归一化)
    churn: number;         // 近 90 天修改次数 (0-1 归一化)
    complexity: number;    // 文件复杂度 p95 (0-1 归一化)
    deadRefs: number;      // 死引用数 (0-1 归一化)
    testGap: boolean;      // 无测试覆盖
  };
}

class HotspotScorer {
  score(file: FileInfo, gitHistory: GitHistory, ast: AstSnapshot): HotspotScore {
    // 公式: 0.3 × age + 0.3 × churn + 0.2 × complexity + 0.1 × deadRefs + 0.1 × testGap
    // CodeScene 启发: churn 权重最高,因为"被频繁修改的烂代码"危害最大
  }
}
```

#### AICodeSmellDetector (NEW)

针对 AI 生成代码的专属检测:

```typescript
interface AICodeSmell {
  type: 'wrapper_only' | 'hallucinated_import' | 'unused_abstraction' | 'deep_nesting';
  file: string;
  line: number;
  description: string;
}

class AICodeSmellDetector {
  detect(ast: AstSnapshot, deadcode: DeadcodeReport): AICodeSmell[] {
    // wrapper_only: 函数体只有一行调用 (过度抽象)
    // hallucinated_import: import 了但没有使用的包 (AI 幻觉)
    // unused_abstraction: 高度泛化的 interface/class 只有一个实现
    // deep_nesting: 嵌套 > 5 层 (AI 生成的常见问题)
  }
}
```

#### 增强的 ZombieDetector

```
原始 4 条件 (AND):
  age > 90d AND no test AND no refs AND LOC > 50
         ↓
增强版 (加权评分):
  zombie_score = 0.35 × age_factor + 0.25 × test_gap + 0.20 × dead_refs + 0.15 × loc_factor + 0.05 × churn_factor
  + AI signal bonus: +10 points if detected as AI smell
  + hotspot bonus: if hotspot_score > 70, elevate zombie priority
```

### 3.7 SnapshoDelta (NEW) — SonarQube 风格的增量比较

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

class SnapshotComparator {
  compare(today: CodeHealthSnapshot, yesterday: CodeHealthSnapshot): DeltaReport {
    // diff 每个维度的变化
    // 标记趋势: improving / stable / degrading
  }
}
```

**价值**: Evolution Pipeline 不仅知道"当前代码质量",还能知道"昨天的改动让代码变好了还是变坏了",从而精准定位"哪些 prompt/spec 产生了坏代码"。

### 3.8 与 Phase E Evolution Pipeline 的数据契约

CodeHealthSnapshot 是 Phase E 的 **4 类输入之一**:

```
InsightEngine 输入:
  ├── codeHealth (来自 code-observability) — 代码态信号
  ├── failures (来自 runtime) — 运行时失败 trace
  ├── attribution (来自 CAP-MAR-04) — 失败归因
  └── feedback (来自 CAP-EVO-06) — 用户反馈
```

**数据契约**:
```typescript
interface CodeHealthForEvolution {
  // 当前值
  current: {
    deadExports: number;
    complexityP95: number;
    duplicationPct: number;
    zombieFiles: number;
    aiSmellCount: number;      // NEW
    avgHotspotScore: number;    // NEW
  };
  // 7 天趋势
  trend: {
    deadExportsDelta: number;   // 正=恶化, 负=改善
    complexityDelta: number;
    duplicationDelta: number;
    zombieDelta: number;
  };
  // Top-N 问题文件 (供 Evolution 精准定位)
  topIssues: {
    deadExports: { file: string; count: number }[];      // Top 5
    dangerFunctions: { file: string; name: string; complexity: number }[]; // Top 5
    zombies: { file: string; hotspotScore: number }[];   // Top 5
  };
}
```

### 3.9 与原始 spec 的一致性检查

| 原始 spec 需求 | 增强版如何满足 | 变化 |
|--------------|-------------|------|
| ts-morph AST 解析 | 保留,增加 worker_thread 隔离 | 增强 |
| mtime 缓存 | 保留,函数级粒度 | 增强 |
| DeadcodeFinder 引用计数 | 保留作为降级路径,新增 KnipAdapter 主路径 | 架构变更 |
| escomplex 圈复杂度 | 保留默认后端,接口化支持 cccc | 架构增强 |
| jscpd 重复率 | 保留默认后端,接口化支持 fallow | 架构增强 |
| ZombieDetector 4 条件 | 保留,增加加权评分为主判定 | 增强 |
| 4 gauge metric | 保留,增加 4 delta metric + AI smell metric | 增强 |
| 每日 snapshot | 保留,增加 SnapshoDelta 比较 | 增强 |
| 单文件 < 500ms | 保留 | 不变 |
| 准确率 ≥ 90% | 保留,knip 入口图预期提升准确率 | 增强 |

### 3.10 Metric 新增

```
# 原始 metric (保留)
code.dead_exports (gauge)
code.complexity_p95 (gauge)
code.duplication_pct (gauge)
code.zombie_files (gauge)
code.ast.parse_failed_total (counter)
code.duplication_scan_failed_total (counter)

# 新增 delta metric
code.dead_exports_delta (gauge)          — 较昨日变化,正=恶化
code.complexity_p95_delta (gauge)        — 较昨日变化
code.duplication_pct_delta (gauge)       — 较昨日变化
code.zombie_files_delta (gauge)          — 较昨日变化

# 新增 hotspot metric
code.hotspot_avg_score (gauge)           — 平均热点评分
code.hotspot_danger_count (gauge)        — score > 70 的文件数

# 新增 AI smell metric
code.ai_smell_total (gauge)              — AI 代码气味总数

# 新增 backend metric
code.deadcode.knip_failed_total (counter) — knip 不可用次数
code.snapshot.delta_failed_total (counter) — delta 比较失败次数
```

---

## 设计总结

### 与原始 spec 的差异

| 维度 | 原始 spec | 混合增强版 |
|------|----------|----------|
| **AST 分析** | ts-morph (主进程) | ts-morph (worker_thread 隔离) |
| **死代码** | 引用计数 (单一实现) | KnipAdapter 主路径 + DeadcodeFinder 降级 |
| **复杂度** | escomplex (硬编码) | Backend 接口 + escomplex (默认) + cccc (可选) |
| **重复率** | jscpd (硬编码) | Backend 接口 + jscpd (默认) + fallow (可选) |
| **僵尸检测** | 4 条件 AND (二值) | 加权评分 + HotspotScorer + AI 气味 |
| **增量比较** | 无 | SnapshoDelta (今日 vs 昨日) |
| **AI 信号** | 无 | AICodeSmellDetector (4 种 AI 气味) |
| **数据契约** | 隐式 | 显式 CodeHealthForEvolution 接口 |

### 行业对标

| 特性 | 来源 |
|------|------|
| ts-morph 类型推断 (保留) | TypeScript Compiler API |
| 入口驱动死代码图 | knip (2025-2026) |
| 热点评分 (churn × complexity) | CodeScene Behavioral Code Analysis |
| SnapshoDelta 比较 | SonarQube Snapshot Model |
| 可插拔分析后端 | fallow / cccc Rust 生态 |
| AI 代码气味检测 | repo-entropy / The Janitor (2025-2026) |
| Veracode AI 代码 36% 更高风险 | Veracode 2025 State of Software Security |
