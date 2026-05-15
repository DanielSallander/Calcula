//! FILENAME: app/extensions/TestRunner/lib/__tests__/formatter.test.ts
// PURPOSE: Tests for the test results clipboard formatter.

import { describe, it, expect } from "vitest";
import { formatResultsForClipboard } from "../formatter";
import type { SuiteResult } from "../types";

function makeSuiteResult(overrides: Partial<SuiteResult> = {}): SuiteResult {
  return {
    suiteName: "TestSuite",
    results: [],
    totalMs: 100,
    passed: 0,
    failed: 0,
    errors: 0,
    skipped: 0,
    ...overrides,
  };
}

describe("formatResultsForClipboard", () => {
  it("shows overall summary line", () => {
    const result = formatResultsForClipboard([
      makeSuiteResult({ passed: 3, failed: 1, errors: 0, totalMs: 250, results: [
        { name: "t1", suiteName: "S", status: "pass", durationMs: 50, logs: [] },
        { name: "t2", suiteName: "S", status: "pass", durationMs: 50, logs: [] },
        { name: "t3", suiteName: "S", status: "pass", durationMs: 50, logs: [] },
        { name: "t4", suiteName: "S", status: "fail", durationMs: 100, error: "bad", logs: [] },
      ]}),
    ]);
    expect(result).toContain("**3/4 passed**");
    expect(result).toContain("1 failed");
    expect(result).toContain("0 errors");
  });

  it("includes suite header with pass count", () => {
    const result = formatResultsForClipboard([
      makeSuiteResult({
        suiteName: "MySuite",
        passed: 2,
        results: [
          { name: "a", suiteName: "MySuite", status: "pass", durationMs: 10, logs: [] },
          { name: "b", suiteName: "MySuite", status: "pass", durationMs: 10, logs: [] },
        ],
      }),
    ]);
    expect(result).toContain("### MySuite (2/2)");
  });

  it("shows [PASS] tag for passing tests", () => {
    const result = formatResultsForClipboard([
      makeSuiteResult({
        passed: 1,
        results: [
          { name: "good test", suiteName: "S", status: "pass", durationMs: 5, logs: [] },
        ],
      }),
    ]);
    expect(result).toContain("[PASS] good test");
  });

  it("shows [FAIL] tag with error for failing tests", () => {
    const result = formatResultsForClipboard([
      makeSuiteResult({
        failed: 1,
        results: [
          { name: "bad test", suiteName: "S", status: "fail", durationMs: 15, error: "expected 1 got 2", logs: [] },
        ],
      }),
    ]);
    expect(result).toContain("[FAIL] bad test");
    expect(result).toContain("> expected 1 got 2");
  });

  it("shows [ERROR] tag for errored tests", () => {
    const result = formatResultsForClipboard([
      makeSuiteResult({
        errors: 1,
        results: [
          { name: "crash", suiteName: "S", status: "error", durationMs: 5, error: "TypeError", logs: [] },
        ],
      }),
    ]);
    expect(result).toContain("[ERROR] crash");
  });

  it("includes logs for failed tests", () => {
    const result = formatResultsForClipboard([
      makeSuiteResult({
        failed: 1,
        results: [
          { name: "t", suiteName: "S", status: "fail", durationMs: 5, logs: ["step 1", "step 2"] },
        ],
      }),
    ]);
    expect(result).toContain("> log: step 1");
    expect(result).toContain("> log: step 2");
  });

  it("includes state diffs for failed tests", () => {
    const result = formatResultsForClipboard([
      makeSuiteResult({
        failed: 1,
        results: [
          {
            name: "t",
            suiteName: "S",
            status: "fail",
            durationMs: 5,
            logs: [],
            stateDiffs: ["line1\nline2"],
          },
        ],
      }),
    ]);
    expect(result).toContain("> State diffs:");
    expect(result).toContain("line1");
    expect(result).toContain("line2");
  });

  it("handles empty results array", () => {
    const result = formatResultsForClipboard([]);
    expect(result).toContain("## Test Results");
    expect(result).toContain("**0/0 passed**");
  });

  it("aggregates totals across multiple suites", () => {
    const result = formatResultsForClipboard([
      makeSuiteResult({ suiteName: "A", passed: 2, failed: 0, errors: 0, totalMs: 50, results: [
        { name: "a1", suiteName: "A", status: "pass", durationMs: 25, logs: [] },
        { name: "a2", suiteName: "A", status: "pass", durationMs: 25, logs: [] },
      ]}),
      makeSuiteResult({ suiteName: "B", passed: 1, failed: 1, errors: 0, totalMs: 100, results: [
        { name: "b1", suiteName: "B", status: "pass", durationMs: 50, logs: [] },
        { name: "b2", suiteName: "B", status: "fail", durationMs: 50, error: "x", logs: [] },
      ]}),
    ]);
    expect(result).toContain("**3/4 passed**");
    expect(result).toContain("1 failed");
  });
});
