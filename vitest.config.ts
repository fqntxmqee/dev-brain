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
        // 基线（CAP-QUAL-01 目标 80%）：
        // 当前 55.7% lines / 51.7% branches，逐步提升。
        lines: 50,
        functions: 60,
        branches: 50,
        statements: 50,
      },
    },
  },
});
