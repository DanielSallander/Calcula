//! FILENAME: app/src/core/lib/gridRenderer/styles/cellFormatting.test.ts
// PURPOSE: Tests for cell value type detection (numeric, error)

import { describe, it, expect } from "vitest";
import { isNumericValue, isErrorValue } from "./cellFormatting";

// ============================================================================
// isNumericValue
// ============================================================================

describe("isNumericValue", () => {
  it("returns false for empty string", () => {
    expect(isNumericValue("")).toBe(false);
  });

  it("detects plain integers", () => {
    expect(isNumericValue("42")).toBe(true);
    expect(isNumericValue("-7")).toBe(true);
    expect(isNumericValue("0")).toBe(true);
  });

  it("detects decimals", () => {
    expect(isNumericValue("3.14")).toBe(true);
    expect(isNumericValue("-0.5")).toBe(true);
  });

  it("detects currency-formatted values", () => {
    expect(isNumericValue("$100")).toBe(true);
    expect(isNumericValue("$1,000.50")).toBe(true);
  });

  it("detects percentage-formatted values", () => {
    expect(isNumericValue("50%")).toBe(true);
    expect(isNumericValue("12.5%")).toBe(true);
  });

  it("detects numbers with thousands separator", () => {
    expect(isNumericValue("1,000")).toBe(true);
    expect(isNumericValue("1,000,000")).toBe(true);
  });

  it("detects accounting-style negatives in parentheses", () => {
    expect(isNumericValue("(100)")).toBe(true);
    expect(isNumericValue("(1,500.75)")).toBe(true);
  });

  it("returns false for text", () => {
    expect(isNumericValue("hello")).toBe(false);
    expect(isNumericValue("abc123")).toBe(false);
  });

  it("returns false for Infinity", () => {
    expect(isNumericValue("Infinity")).toBe(false);
  });

  it("handles whitespace-padded numbers", () => {
    expect(isNumericValue("  42  ")).toBe(true);
  });
});

// ============================================================================
// isErrorValue
// ============================================================================

describe("isErrorValue", () => {
  it("detects #VALUE! error", () => {
    expect(isErrorValue("#VALUE!")).toBe(true);
  });

  it("detects #REF! error", () => {
    expect(isErrorValue("#REF!")).toBe(true);
  });

  it("detects #NAME? error", () => {
    expect(isErrorValue("#NAME?")).toBe(true);
  });

  it("detects #DIV/0! error", () => {
    expect(isErrorValue("#DIV/0!")).toBe(true);
  });

  it("detects #NULL! error", () => {
    expect(isErrorValue("#NULL!")).toBe(true);
  });

  it("detects #N/A error", () => {
    expect(isErrorValue("#N/A")).toBe(true);
  });

  it("detects #NUM! error", () => {
    expect(isErrorValue("#NUM!")).toBe(true);
  });

  it("detects #ERROR", () => {
    expect(isErrorValue("#ERROR")).toBe(true);
  });

  it("is case insensitive", () => {
    expect(isErrorValue("#value!")).toBe(true);
    expect(isErrorValue("#div/0!")).toBe(true);
  });

  it("returns false for normal text", () => {
    expect(isErrorValue("hello")).toBe(false);
    expect(isErrorValue("#hashtag")).toBe(false);
    expect(isErrorValue("100")).toBe(false);
  });
});
