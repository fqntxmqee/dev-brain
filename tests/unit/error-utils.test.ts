import { describe, expect, it } from "vitest";
import { toErrorMessage, toErrorName } from "../../src/core/error-utils.js";
import {
  AdapterError,
  AuthError,
  DevBrainError,
} from "../../src/core/errors.js";

describe("toErrorMessage", () => {
  it("should_return_message_for_normal_error", () => {
    expect(toErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("should_use_safeMessage_for_DevBrainError_subclass", () => {
    const e = new AdapterError("adapter down");
    expect(toErrorMessage(e)).toBe("adapter down");
  });

  it("should_handle_string_throw", () => {
    expect(toErrorMessage("oops")).toBe("oops");
  });

  it("should_handle_null_and_undefined", () => {
    expect(toErrorMessage(null)).toBe("Unknown error");
    expect(toErrorMessage(undefined)).toBe("Unknown error");
  });

  it("should_handle_primitive_numbers", () => {
    expect(toErrorMessage(42)).toBe("42");
  });

  it("should_handle_error_with_empty_message", () => {
    const e = new Error("");
    expect(toErrorMessage(e)).toBe("Error");
  });

  it("should_return_class_name_for_known_subclasses", () => {
    expect(toErrorName(new AuthError("x"))).toBe("AuthError");
    expect(toErrorName(new AdapterError("x"))).toBe("AdapterError");
    expect(toErrorName(new Error("x"))).toBe("Error");
  });

  it("should_return_marker_for_string_throw", () => {
    expect(toErrorName("oops")).toBe("StringThrown");
    expect(toErrorName(null)).toBe("UnknownError");
  });

  it("should_keep_DevBrainError_marker", () => {
    class CustomErr extends DevBrainError {
      readonly code = "CUSTOM";
      constructor() {
        super("custom", { retryable: true });
      }
    }
    const e = new CustomErr();
    expect(toErrorMessage(e)).toBe("custom");
    expect(e.retryable).toBe(true);
  });
});
