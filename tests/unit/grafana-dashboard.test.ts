import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 保证 Grafana dashboard JSON 始终:
 *   1) 语法合法
 *   2) 所有 panel 引用的 metric 在 dev-brain 注册表中存在
 *   3) panel id / title 唯一
 *
 * 失败 = PR 红,提醒 panel 与代码同步。
 */

const DASHBOARD_PATH = join(
  process.cwd(),
  "ops/grafana/dev-brain-dashboard.json",
);
const METRICS_TS = join(process.cwd(), "src/observability/metrics.ts");

interface Panel {
  readonly id: number;
  readonly title: string;
  readonly targets: ReadonlyArray<{ readonly expr: string }>;
}

interface Dashboard {
  readonly title: string;
  readonly panels: ReadonlyArray<Panel>;
}

describe("Grafana dashboard integrity", () => {
  it("is_valid_json_with_unique_panel_ids", async () => {
    const raw = await fs.readFile(DASHBOARD_PATH, "utf-8");
    const json = JSON.parse(raw) as Dashboard;
    expect(json.title).toMatch(/Dev Brain/);
    const ids = json.panels.map((p) => p.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
    const titles = json.panels.map((p) => p.title);
    const uniqueTitles = new Set(titles);
    expect(uniqueTitles.size).toBe(titles.length);
  });

  it("panel_exprs_reference_registered_metrics", async () => {
    const [raw, src] = await Promise.all([
      fs.readFile(DASHBOARD_PATH, "utf-8"),
      fs.readFile(METRICS_TS, "utf-8"),
    ]);
    const json = JSON.parse(raw) as Dashboard;
    // 抽 metrics.ts 里声明的 metric 名(接受 . 和 _ 两种形式)
    const counterRe = /"([a-z][a-z0-9._]+[a-z0-9])":\s*"[^"]*"/g;
    const declared = new Set<string>();
    for (const m of src.matchAll(counterRe)) {
      const name = m[1];
      if (!name) continue;
      declared.add(name);
      declared.add(name.replace(/\./g, "_"));
    }
    const referenced = new Set<string>();
    for (const p of json.panels) {
      for (const t of p.targets) {
        for (const m of t.expr.matchAll(/\b([a-z][a-z0-9_]+)\b/g)) {
          const token = m[1];
          if (!token) continue;
          if (
            [
              "sum",
              "rate",
              "histogram_quantile",
              "by",
              "le",
              "min",
              "max",
              "avg",
            ].includes(token)
          )
            continue;
          // histogram 在 prom 里是 <name>_bucket,对应 metrics.ts 的 histogram 名
          const stripped = token.replace(/_bucket$/, "");
          referenced.add(stripped);
        }
      }
    }
    const missing = [...referenced].filter((m) => !declared.has(m));
    if (missing.length > 0) {
      throw new Error(
        `panels reference metrics not registered in metrics.ts:\n  ${missing.join("\n  ")}`,
      );
    }
  });
});
