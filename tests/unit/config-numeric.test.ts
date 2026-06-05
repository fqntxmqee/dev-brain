import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";

describe("config numeric validation", () => {
  it("uses fallback when env is invalid", () => {
    const c = loadConfig({ DEV_BRAIN_CC_BRIDGE_POLL_MS: "not-a-number" });
    expect(c.ccBridgePollMs).toBe(2000);
  });

  it("rejects negative timeout", () => {
    const c = loadConfig({ DEV_BRAIN_CC_BRIDGE_TIMEOUT_MS: "-1" });
    expect(c.ccBridgeTimeoutMs).toBe(300000);
  });

  it("rejects timeout above 1h", () => {
    const c = loadConfig({ DEV_BRAIN_CC_RELAY_TIMEOUT_MS: "99999999" });
    expect(c.ccRelayTimeoutMs).toBe(300000);
  });

  it("rejects poll interval below 50ms", () => {
    const c = loadConfig({ DEV_BRAIN_CC_BRIDGE_POLL_MS: "10" });
    expect(c.ccBridgePollMs).toBe(2000);
  });

  it("accepts valid values", () => {
    const c = loadConfig({
      DEV_BRAIN_CC_BRIDGE_POLL_MS: "5000",
      DEV_BRAIN_CC_BRIDGE_TIMEOUT_MS: "60000",
      DEV_BRAIN_CC_RELAY_TIMEOUT_MS: "10000",
    });
    expect(c.ccBridgePollMs).toBe(5000);
    expect(c.ccBridgeTimeoutMs).toBe(60000);
    expect(c.ccRelayTimeoutMs).toBe(10000);
  });
});

describe("v0.7.0: metrics server config", () => {
  it("metrics_enabled_defaults_to_true", () => {
    expect(loadConfig({}).metricsEnabled).toBe(true);
  });
  it("metrics_enabled_can_be_disabled_with_0", () => {
    expect(loadConfig({ DEV_BRAIN_METRICS_ENABLED: "0" }).metricsEnabled).toBe(
      false,
    );
  });
  it("metrics_port_defaults_to_9090", () => {
    expect(loadConfig({}).metricsPort).toBe(9090);
  });
  it("metrics_port_accepts_valid", () => {
    expect(loadConfig({ DEV_BRAIN_METRICS_PORT: "8080" }).metricsPort).toBe(
      8080,
    );
  });
  it("metrics_port_rejects_zero", () => {
    expect(loadConfig({ DEV_BRAIN_METRICS_PORT: "0" }).metricsPort).toBe(9090);
  });
  it("metrics_port_rejects_99999", () => {
    expect(loadConfig({ DEV_BRAIN_METRICS_PORT: "99999" }).metricsPort).toBe(
      9090,
    );
  });
  it("metrics_host_defaults_to_empty", () => {
    expect(loadConfig({}).metricsHost).toBe("");
  });
  it("metrics_host_trims_whitespace", () => {
    expect(
      loadConfig({ DEV_BRAIN_METRICS_HOST: "  127.0.0.1  " }).metricsHost,
    ).toBe("127.0.0.1");
  });
});
