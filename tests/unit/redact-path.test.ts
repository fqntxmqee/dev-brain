import { describe, expect, it } from "vitest";
import { redactPath, redactPathInObject } from "../../src/core/redact-path.js";

describe("redactPath (CAP-ERR-04 / T-55)", () => {
  it("replaces_HOME_with_tilde", () => {
    expect(redactPath("$HOME/.cc-connect/run/api.sock")).toBe(
      "~/.cc-connect/run/api.sock",
    );
  });

  it("replaces_macos_user_dir", () => {
    expect(redactPath("/Users/alice/dev/proj/src/main.ts")).toBe(
      "/Users/<user>/dev/proj/src/main.ts",
    );
  });

  it("replaces_linux_user_dir", () => {
    expect(redactPath("/home/bob/dev/proj/src/main.ts")).toBe(
      "/home/<user>/dev/proj/src/main.ts",
    );
  });

  it("preserves_non_path_text", () => {
    expect(redactPath("no path here")).toBe("no path here");
  });

  it("redactPathInObject_handles_nested", () => {
    const input = {
      socket: "/Users/alice/api.sock",
      inner: { home: "$HOME/x" },
    };
    const out = redactPathInObject(input);
    expect(out.socket).toBe("/Users/<user>/api.sock");
    expect(out.inner.home).toBe("~/x");
  });
});
