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
