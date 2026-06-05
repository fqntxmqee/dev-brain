import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/index.ts",
        "src/**/__tests__/**",
        "src/cli/cli.ts",
        "src/cli/doctor.ts",
      ],
      thresholds: {
        // CAP-QUAL-01：覆盖率冲刺后基线（v0.6.0）。
        // 当前 85.22% stmt / 74.53% branch — 阈值留 5% 缓冲防抖。
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
