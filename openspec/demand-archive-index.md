# 需求归档索引

| 需求 ID | 标题 | L1 领域 | L2 场景 | 交付日期 | 归档路径 | 关键决策摘要 |
|---------|------|---------|---------|---------|---------|-------------|
| DM-20260601-001 | Dev Brain — 飞书指挥的多 Agent 开发大脑 | agent | L2-AGENT-02 | 2026-06-01 | `archive/2026-06-01-dev-brain-mvp/` | Brain 独立 Orchestrator；cc-connect 降级 Worker；飞书单一入口 + 卡片审批；DAG 并行 + 文件锁 |
| DM-20260605-002 | Dev Brain 生产加固（P0~P5 78 任务） | reliability | L2-HARDEN | 2026-06-05 | `archive/2026-06-05-production-hardening/` | 平台无关抽象 + 状态机 + cancel 意图 + Bridge 错误前缀 + WS 指数退避 + postmortem 落盘 + 子任务重试 + prompt 4KB + 凭证诊断 + cc-connect schema_version + metrics + systemd/Dockerfile |
