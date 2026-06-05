#!/usr/bin/env node
import { Command } from "commander";
import { dirname, join } from "node:path";
import { createDevBrainApp } from "../bootstrap.js";
import {
  InMemoryFeishuReporter,
  LarkCliFeishuReporter,
} from "../gateway/feishu-reporter.js";
import { runFeishuEventLoop } from "../gateway/feishu-gateway.js";
import { loadConfig, detectPlaceholders } from "../config/env.js";
import { formatDoctorReport, runDoctorChecks } from "./doctor.js";
import { CcConnectClient } from "../adapters/cc-connect/index.js";
import {
  formatHeadlessCheckReport,
  checkHeadlessConfig,
  migrateToHeadless,
  applyHeadlessConfig,
  undoHeadlessConfig,
} from "./migrate-headless.js";
import { toErrorMessage } from "../core/error-utils.js";
import { defaultLogger } from "../core/logger.js";
import { GracefulShutdown } from "../core/shutdown.js";
import {
  deriveMetricsHost,
  MetricsServer,
} from "../observability/metrics-server.js";
import { getMetrics, startProcessCollector } from "../observability/metrics.js";

const program = new Command();

program
  .name("dev-brain")
  .description("飞书指挥的多 Agent 开发大脑")
  .version("0.4.0");

program
  .command("start")
  .description("启动飞书 Gateway（订阅 lark-cli event）")
  .option("--dry-run", "仅打印配置，不订阅事件")
  .option("--strict", "占位值检测命中则退出码 2")
  .action(async (opts: { dryRun?: boolean; strict?: boolean }) => {
    const config = loadConfig();
    const placeholders = detectPlaceholders(config);
    if (placeholders.length > 0) {
      for (const field of placeholders) {
        process.stderr.write(`[WARN] ${field} looks like a placeholder\n`);
      }
      if (opts.strict) {
        process.exit(2);
      }
    }
    if (opts.dryRun) {
      const nativeLine =
        config.agentBackend === "native"
          ? [
              `- agentBackend: ${config.agentBackend} (v0.8.0 — 直接 spawn 本地 CLI)`,
              `- claude: ${config.claudeBin} (model=${config.claudeModel}, base=${config.claudeBaseUrl})`,
              `- codex: ${config.codexBin} (model=${config.codexModel}, profile=${config.codexProfile})`,
            ].join("\n")
          : `- agentBackend: ${config.agentBackend} (v0.7.0 兼容 — UDS 派发)`;
      process.stdout.write(
        [
          "Dev Brain 配置：",
          `- workDir: ${config.workDir}`,
          `- adapterMode: ${config.adapterMode}`,
          nativeLine,
          `- ccSyncMode: ${config.ccSyncMode}`,
          `- ccConnectSocket: ${config.ccConnectSocket}`,
          `- allowFrom: ${config.allowFrom.size ? [...config.allowFrom].join(", ") : "(all)"}`,
          `- metrics: ${config.metricsEnabled ? `${config.metricsHost || deriveMetricsHost()}:${config.metricsPort}` : "disabled"}`,
          "",
          "去掉 --dry-run 后将运行 lark-cli event +subscribe",
        ].join("\n") + "\n",
      );
      return;
    }

    const reporter = new LarkCliFeishuReporter("dev-brain");
    const app = createDevBrainApp(reporter);

    // 启动前预检：必过项失败立即退出 2
    // v0.8.0: native backend 下 cc-connect 仅作 cursor fallback 可选，
    // cc_connect_headless 不再阻塞启动（用户保留三 Bot 配置不影响派发）
    const checks = await runDoctorChecks(config);
    const skipOnNative = new Set(["cursor_api_key", "cc_connect_headless"]);
    const fatal = checks.filter(
      (c) =>
        !c.ok &&
        !(config.agentBackend === "native" && skipOnNative.has(c.name)),
    );
    if (fatal.length > 0) {
      process.stderr.write(`${formatDoctorReport(checks)}\n`);
      process.stderr.write(
        "\n❌ 预检未通过：上述 ❌ 项需先修复。运行 `dev-brain doctor` 查看详情。\n",
      );
      process.exit(2);
    }
    process.stdout.write(`${formatDoctorReport(checks)}\n\n`);

    // v0.7.0: 启动 metrics server + process collector，挂在 GracefulShutdown
    const shutdown = new GracefulShutdown({
      timeoutMs: 10_000,
      logger: (m) => process.stderr.write(`[shutdown] ${m}\n`),
    });

    let metricsServer: MetricsServer | undefined;
    if (config.metricsEnabled) {
      const registry = getMetrics();
      const host = config.metricsHost || deriveMetricsHost();
      metricsServer = new MetricsServer({
        port: config.metricsPort,
        host,
        registry,
        isReady: () => !shutdown["shuttingDown"],
        logger: defaultLogger.child({ component: "metrics-server" }),
      });
      const handle = await metricsServer.start();
      process.stdout.write(
        `📊 metrics server listening on http://${host}:${handle.port}\n`,
      );
      shutdown.register("metrics-server", () => handle.close());
      const procCollector = startProcessCollector({
        registry,
        intervalMs: 15_000,
        logger: defaultLogger.child({ component: "process-collector" }),
      });
      shutdown.register("process-collector", () => procCollector.stop());
    }
    shutdown.onSignal();

    process.stdout.write("🧠 Dev Brain 已启动，等待飞书消息…\n");
    await runFeishuEventLoop(app.gateway, (line) => {
      if (config.debug) {
        process.stderr.write(`${line}\n`);
      }
    });
  });

program
  .command("plan")
  .description(
    "本地模拟：输入需求 → 计划 → 批准 → 执行（--no-execute 跳过 /approve 步骤）",
  )
  .argument("<description>", "任务描述")
  .option("--no-execute", "只生成计划不执行（测试 /approve 之前的链路）")
  .action(async (description: string, opts: { execute: boolean }) => {
    const reporter = new InMemoryFeishuReporter();
    const app = createDevBrainApp(reporter);

    const chatId = "local:demo";
    await app.gateway.handleMessage({
      messageId: "m1",
      chatId,
      senderOpenId: "local-user",
      senderName: "local",
      text: description,
    });

    process.stdout.write(`[text]   ${reporter.sent.at(-1)?.text ?? ""}\n\n`);

    if (!opts.execute) {
      return;
    }

    await app.gateway.handleMessage({
      messageId: "m2",
      chatId,
      senderOpenId: "local-user",
      senderName: "local",
      text: "/approve",
    });

    process.stdout.write(`[approve] ${reporter.sent.at(-1)?.text ?? ""}\n`);
  });

program
  .command("status")
  .description("打印 Brain 状态")
  .action(() => {
    const app = createDevBrainApp();
    process.stdout.write(`${app.brain.formatStatusText()}\n`);
  });

program
  .command("show")
  .description("渲染已完成任务的 postmortem 摘要 (T-67)")
  .argument("<taskId>", "任务 ID（短 12 字符即可）")
  .option("--subtask <id>", "输出指定子任务全量文本")
  .action((taskId: string, opts: { subtask?: string }) => {
    const app = createDevBrainApp();
    const result = app.brain.findCompleted(taskId);
    if (!result) {
      process.stderr.write(`❌ 任务不存在或未完成：${taskId}\n`);
      process.exit(1);
      return;
    }
    if (opts.subtask) {
      const sub = result.subTaskOutputs.find(
        (o) => o.subTaskId === opts.subtask,
      );
      if (!sub) {
        process.stderr.write(`❌ 子任务不存在：${opts.subtask}\n`);
        process.exit(1);
        return;
      }
      process.stdout.write(`${sub.output}\n`);
      return;
    }
    process.stdout.write(`${result.summary}\n`);
  });

program
  .command("list")
  .description("列出最近 N 条已完成任务 (T-67)")
  .option("--limit <n>", "条数", "10")
  .action((opts: { limit: string }) => {
    const app = createDevBrainApp();
    const limit = Number.parseInt(opts.limit, 10) || 10;
    const items = app.brain.listRecent(limit);
    if (items.length === 0) {
      process.stdout.write("（无已完成任务）\n");
      return;
    }
    const lines = items.map((r) => {
      const short = r.taskId.slice(0, 12);
      return `${r.success ? "✅" : "❌"} ${short}  ${r.summary.slice(0, 80).replace(/\n/g, " ")}`;
    });
    process.stdout.write(`${lines.join("\n")}\n`);
  });

program
  .command("doctor")
  .description("环境自检：cc-connect / Cursor / 飞书凭证")
  .action(async () => {
    const config = loadConfig();
    const checks = await runDoctorChecks(config);
    process.stdout.write(`${formatDoctorReport(checks)}\n`);
  });

program
  .command("probe")
  .description("向 cc-connect 发送探测消息（需 DEV_BRAIN_ADAPTER_MODE=live）")
  .requiredOption("-p, --project <name>", "cc-connect project 名")
  .argument("<message>", "探测消息")
  .action(async (message: string, opts: { project: string }) => {
    const config = loadConfig();
    const client = CcConnectClient.fromConfig(config);
    const result = await client.send({
      project: opts.project,
      prompt: message,
      sessionKey: `dev-brain:probe:${Date.now()}`,
    });
    if (!result.ok) {
      process.stderr.write(`probe failed: ${result.error ?? "unknown"}\n`);
      process.exit(1);
    }
    process.stdout.write(`${result.output ?? "(ok)"}\n`);
  });

program
  .command("migrate-headless")
  .description(
    "检查或生成 cc-connect headless 配置（去掉 platforms，仅 Worker）",
  )
  .option("--check", "仅检查当前配置")
  .option("--apply", "备份并原地应用 headless 配置（生产切换）")
  .option("--undo <backup>", "从备份回滚")
  .option("--dry-run", "不写入文件")
  .option("-o, --output <path>", "输出路径", "")
  .action(
    async (opts: {
      check?: boolean;
      apply?: boolean;
      undo?: string;
      dryRun?: boolean;
      output: string;
    }) => {
      const config = loadConfig();
      const sourcePath = config.ccConfigPath;

      if (opts.check) {
        const check = await checkHeadlessConfig(sourcePath);
        process.stdout.write(`${formatHeadlessCheckReport(check)}\n`);
        process.exit(check.ok ? 0 : 1);
        return;
      }

      if (opts.undo) {
        const result = await undoHeadlessConfig({
          backupPath: opts.undo,
          targetPath: sourcePath,
        });
        process.stdout.write(`${result.message}\n`);
        process.exit(result.restored ? 0 : 1);
        return;
      }

      if (opts.apply) {
        const result = await applyHeadlessConfig({
          sourcePath,
          workDir: config.workDir,
          dryRun: opts.dryRun,
        });
        process.stdout.write(`${result.message}\n`);
        process.exit(result.applied || !opts.dryRun ? 0 : 1);
        return;
      }

      const outputPath =
        opts.output.trim() || join(dirname(sourcePath), "config.headless.toml");

      const result = await migrateToHeadless({
        sourcePath,
        outputPath,
        workDir: config.workDir,
        dryRun: opts.dryRun,
      });
      process.stdout.write(`${result.message}\n`);
      // 退出码：dry-run → 0；非 dry-run 写入失败 → 1
      process.exit(result.written || opts.dryRun ? 0 : 1);
    },
  );

/**
 * 退出码矩阵（CAP-CLI-13 / T-75）：
 *   0  成功 / 已是目标状态 / dry-run
 *   1  运行时错误 / 检查项不通过 / 写入失败
 *   2  预检未通过（start 必过项）
 */
program
  .command("help-exit-codes")
  .description("打印 6 个子命令的退出码矩阵（无副作用）")
  .action(() => {
    const matrix: ReadonlyArray<{
      command: string;
      readonly 0: string;
      readonly 1: string;
      readonly 2: string;
    }> = [
      {
        command: "start",
        "0": "成功进入事件循环（罕见：会一直运行）",
        "1": "未捕获异常（不期望出现）",
        "2": "预检未通过（feishu/cc-connect 必过项）",
      },
      {
        command: "doctor",
        "0": "全部检查通过 / 仅 cursor_api_key 缺失",
        "1": "feishu/cc-connect/cursor 必过项中至少 1 项失败",
        "2": "（无）",
      },
      {
        command: "probe",
        "0": "cc-connect 返回 ok 且有 output",
        "1": "cc-connect 调用失败 / HTTP 非 200",
        "2": "（无）",
      },
      {
        command: "migrate-headless --check",
        "0": "已是 headless 状态",
        "1": "存在 platforms 或 project 不足",
        "2": "（无）",
      },
      {
        command: "migrate-headless (default/--apply/--undo)",
        "0": "写入成功 / 已是目标 / dry-run / 备份不存在（undo 已处理）",
        "1": "写入失败 / undo 源备份缺失",
        "2": "（无）",
      },
      {
        command: "show / list / status / plan",
        "0": "成功渲染",
        "1": "任务不存在 / 解析失败",
        "2": "（无）",
      },
    ];

    const lines = [
      "📖 dev-brain 退出码矩阵（CAP-CLI-13 / T-75）",
      "",
      "全命令共用的 3 档退出码：",
      "  0  成功 / 已是目标状态 / dry-run",
      "  1  运行时错误 / 检查项不通过 / 写入失败",
      "  2  预检未通过（仅 start 必过项使用）",
      "",
      "—  按子命令 —",
      ...matrix.flatMap((row) => [
        `▸ ${row.command}`,
        `    0  ${row["0"]}`,
        `    1  ${row["1"]}`,
        `    2  ${row["2"]}`,
        "",
      ]),
      "使用建议：CI 中如需在 doctor 失败时阻断，请用 `doctor || exit 1`；",
      "start 阻塞请用 `start || exit 2`（脚本/编排层判定）。",
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
  });

// 退出码契约（运维/CI 可依赖）：
//   0  成功 / 已是目标状态 / dry-run
//   1  运行时错误 / 检查项不通过 / 写入失败
//   2  预检未通过（start 必过项）
program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`Error: ${toErrorMessage(err)}\n`);
  process.exit(1);
});
