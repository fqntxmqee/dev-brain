#!/usr/bin/env node
import { Command } from "commander";
import { dirname, join } from "node:path";
import { createDevBrainApp } from "../bootstrap.js";
import {
  InMemoryFeishuReporter,
  LarkCliFeishuReporter,
} from "../gateway/feishu-reporter.js";
import { runFeishuEventLoop } from "../gateway/feishu-gateway.js";
import { loadConfig } from "../config/env.js";
import { formatDoctorReport, runDoctorChecks } from "./doctor.js";
import { CcConnectClient } from "../adapters/cc-connect-client.js";
import {
  formatHeadlessCheckReport,
  checkHeadlessConfig,
  migrateToHeadless,
  applyHeadlessConfig,
} from "./migrate-headless.js";
import { toErrorMessage } from "../core/error-utils.js";

const program = new Command();

program
  .name("dev-brain")
  .description("飞书指挥的多 Agent 开发大脑")
  .version("0.4.0");

program
  .command("start")
  .description("启动飞书 Gateway（订阅 lark-cli event）")
  .option("--dry-run", "仅打印配置，不订阅事件")
  .action(async (opts: { dryRun?: boolean }) => {
    const config = loadConfig();
    if (opts.dryRun) {
      process.stdout.write(
        [
          "Dev Brain 配置：",
          `- workDir: ${config.workDir}`,
          `- adapterMode: ${config.adapterMode}`,
          `- ccSyncMode: ${config.ccSyncMode}`,
          `- ccConnectSocket: ${config.ccConnectSocket}`,
          `- allowFrom: ${config.allowFrom.size ? [...config.allowFrom].join(", ") : "(all)"}`,
          "",
          "去掉 --dry-run 后将运行 lark-cli event +subscribe",
        ].join("\n") + "\n",
      );
      return;
    }

    const reporter = new LarkCliFeishuReporter("chat_id");
    const app = createDevBrainApp(reporter);
    process.stdout.write("🧠 Dev Brain 已启动，等待飞书消息…\n");
    await runFeishuEventLoop(app.gateway, (line) => {
      if (process.env.DEV_BRAIN_DEBUG === "1") {
        process.stderr.write(`${line}\n`);
      }
    });
  });

program
  .command("plan")
  .description("本地模拟：输入需求 → 计划 → 批准 → 执行")
  .argument("<description>", "任务描述")
  .action(async (description: string) => {
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

    process.stdout.write(`${reporter.sent.at(-1)?.text ?? ""}\n\n`);

    await app.gateway.handleMessage({
      messageId: "m2",
      chatId,
      senderOpenId: "local-user",
      senderName: "local",
      text: "/approve",
    });

    process.stdout.write(`${reporter.sent.at(-1)?.text ?? ""}\n`);
  });

program
  .command("status")
  .description("打印 Brain 状态")
  .action(() => {
    const app = createDevBrainApp();
    process.stdout.write(`${app.brain.formatStatusText()}\n`);
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
  .option("--dry-run", "不写入文件")
  .option("-o, --output <path>", "输出路径", "")
  .action(
    async (opts: {
      check?: boolean;
      apply?: boolean;
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
    },
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`Error: ${toErrorMessage(err)}\n`);
  process.exit(1);
});
