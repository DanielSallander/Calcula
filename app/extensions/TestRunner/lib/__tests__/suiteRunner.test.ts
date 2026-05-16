//! FILENAME: app/extensions/TestRunner/lib/__tests__/suiteRunner.test.ts
// PURPOSE: Tests for the suite runner logic - registration, execution, aggregation, formatting.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all heavy dependencies the runner imports
vi.mock("@api", () => ({
  getCell: vi.fn(),
  getViewportCells: vi.fn().mockResolvedValue([]),
  updateCellsBatch: vi.fn(),
  CommandRegistry: { execute: vi.fn() },
  undo: vi.fn(),
  dispatchGridAction: vi.fn(),
}));
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: vi.fn().mockReturnValue({ selection: null }),
  setSelection: vi.fn(),
}));
vi.mock("@api/types", () => ({}));

import {
  registerSuite,
  getRegisteredSuites,
  clearSuites,
  runAllSuites,
  runSuiteByName,
  runMacroByName,
  getResults,
  onResultsChange,
} from "../runner";
import type { TestSuite, TestContext } from "../types";

// Suppress console output during tests
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  clearSuites();
});

// ============================================================================
// Suite registration
// ============================================================================

describe("suite registration", () => {
  it("starts with no suites", () => {
    expect(getRegisteredSuites()).toEqual([]);
  });

  it("registers a suite", () => {
    const suite: TestSuite = { name: "A", tests: [] };
    registerSuite(suite);
    expect(getRegisteredSuites()).toHaveLength(1);
    expect(getRegisteredSuites()[0].name).toBe("A");
  });

  it("registers multiple suites in order", () => {
    registerSuite({ name: "First", tests: [] });
    registerSuite({ name: "Second", tests: [] });
    registerSuite({ name: "Third", tests: [] });
    const names = getRegisteredSuites().map((s) => s.name);
    expect(names).toEqual(["First", "Second", "Third"]);
  });

  it("clearSuites removes all suites", () => {
    registerSuite({ name: "A", tests: [] });
    registerSuite({ name: "B", tests: [] });
    clearSuites();
    expect(getRegisteredSuites()).toEqual([]);
  });

  it("getRegisteredSuites returns a copy (not the internal array)", () => {
    registerSuite({ name: "X", tests: [] });
    const copy = getRegisteredSuites();
    copy.push({ name: "Y", tests: [] });
    expect(getRegisteredSuites()).toHaveLength(1);
  });
});

// ============================================================================
// Running suites - pass/fail aggregation
// ============================================================================

describe("runAllSuites", () => {
  it("returns empty array when no suites registered", async () => {
    const results = await runAllSuites();
    expect(results).toEqual([]);
  });

  it("runs a suite with all passing tests", async () => {
    registerSuite({
      name: "AllPass",
      tests: [
        { name: "test1", run: async () => {} },
        { name: "test2", run: async () => {} },
      ],
    });
    const results = await runAllSuites();
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(2);
    expect(results[0].failed).toBe(0);
    expect(results[0].errors).toBe(0);
  });

  it("counts assertion failures as 'fail'", async () => {
    registerSuite({
      name: "WithFail",
      tests: [
        {
          name: "assertion fail",
          run: async () => {
            throw new Error("Cell A1: expected 5, got 3");
          },
        },
      ],
    });
    const results = await runAllSuites();
    expect(results[0].failed).toBe(1);
    expect(results[0].errors).toBe(0);
    expect(results[0].results[0].status).toBe("fail");
  });

  it("counts unexpected errors as 'error'", async () => {
    registerSuite({
      name: "WithError",
      tests: [
        {
          name: "crash",
          run: async () => {
            throw new TypeError("Cannot read properties of null");
          },
        },
      ],
    });
    const results = await runAllSuites();
    expect(results[0].errors).toBe(1);
    expect(results[0].failed).toBe(0);
    expect(results[0].results[0].status).toBe("error");
  });

  it("runs multiple suites sequentially and aggregates", async () => {
    registerSuite({
      name: "Suite1",
      tests: [{ name: "s1t1", run: async () => {} }],
    });
    registerSuite({
      name: "Suite2",
      tests: [
        { name: "s2t1", run: async () => {} },
        {
          name: "s2t2",
          run: async () => {
            throw new Error("Expected value mismatch");
          },
        },
      ],
    });
    const results = await runAllSuites();
    expect(results).toHaveLength(2);
    // Overall: 2 passed, 1 failed
    const totalPassed = results.reduce((s, r) => s + r.passed, 0);
    const totalFailed = results.reduce((s, r) => s + r.failed, 0);
    expect(totalPassed).toBe(2);
    expect(totalFailed).toBe(1);
  });

  it("skips disabled suites", async () => {
    registerSuite({
      name: "Disabled",
      disabled: true,
      tests: [
        { name: "never runs", run: async () => { throw new Error("should not run"); } },
      ],
    });
    const results = await runAllSuites();
    expect(results[0].skipped).toBe(1);
    expect(results[0].passed).toBe(0);
    expect(results[0].results[0].status).toBe("skipped");
  });

  it("records duration for each test", async () => {
    registerSuite({
      name: "Timed",
      tests: [{ name: "t1", run: async () => {} }],
    });
    const results = await runAllSuites();
    expect(results[0].results[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(results[0].totalMs).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// Execution order and isolation
// ============================================================================

describe("execution order and isolation", () => {
  it("runs tests in definition order", async () => {
    const order: string[] = [];
    registerSuite({
      name: "Order",
      tests: [
        { name: "first", run: async () => { order.push("first"); } },
        { name: "second", run: async () => { order.push("second"); } },
        { name: "third", run: async () => { order.push("third"); } },
      ],
    });
    await runAllSuites();
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("runs beforeEach before each test", async () => {
    const log: string[] = [];
    registerSuite({
      name: "Hooks",
      beforeEach: async () => { log.push("before"); },
      tests: [
        { name: "t1", run: async () => { log.push("t1"); } },
        { name: "t2", run: async () => { log.push("t2"); } },
      ],
    });
    await runAllSuites();
    expect(log).toEqual(["before", "t1", "before", "t2"]);
  });

  it("runs afterEach even when test throws", async () => {
    const log: string[] = [];
    registerSuite({
      name: "AfterEach",
      afterEach: async () => { log.push("after"); },
      tests: [
        {
          name: "fails",
          run: async () => { throw new Error("Expected boom"); },
        },
        { name: "passes", run: async () => {} },
      ],
    });
    await runAllSuites();
    expect(log).toEqual(["after", "after"]);
  });

  it("a failing test does not prevent subsequent tests from running", async () => {
    const ran: string[] = [];
    registerSuite({
      name: "Continue",
      tests: [
        { name: "fail", run: async () => { ran.push("fail"); throw new Error("Cell X"); } },
        { name: "pass", run: async () => { ran.push("pass"); } },
      ],
    });
    await runAllSuites();
    expect(ran).toEqual(["fail", "pass"]);
  });

  it("each test gets its own context (log isolation)", async () => {
    registerSuite({
      name: "Isolation",
      tests: [
        {
          name: "logger1",
          run: async (ctx: TestContext) => { ctx.log("from test 1"); },
        },
        {
          name: "logger2",
          run: async (ctx: TestContext) => { ctx.log("from test 2"); },
        },
      ],
    });
    const results = await runAllSuites();
    expect(results[0].results[0].logs).toEqual(["from test 1"]);
    expect(results[0].results[1].logs).toEqual(["from test 2"]);
  });
});

// ============================================================================
// Error handling
// ============================================================================

describe("error handling in tests", () => {
  it("captures error message from Error objects", async () => {
    registerSuite({
      name: "Err",
      tests: [
        { name: "t", run: async () => { throw new Error("specific message"); } },
      ],
    });
    const results = await runAllSuites();
    expect(results[0].results[0].error).toBe("specific message");
  });

  it("stringifies non-Error throws", async () => {
    registerSuite({
      name: "NonErr",
      tests: [
        { name: "t", run: async () => { throw "raw string error"; } },
      ],
    });
    const results = await runAllSuites();
    expect(results[0].results[0].error).toBe("raw string error");
    expect(results[0].results[0].status).toBe("error");
  });

  it("afterEach error does not change test status", async () => {
    registerSuite({
      name: "AfterErr",
      afterEach: async () => { throw new Error("cleanup failed"); },
      tests: [
        { name: "ok", run: async () => {} },
      ],
    });
    const results = await runAllSuites();
    // The test itself passed; afterEach error is logged but does not fail the test
    expect(results[0].results[0].status).toBe("pass");
  });

  it("classifies 'Selection mismatch' as fail, not error", async () => {
    registerSuite({
      name: "SelFail",
      tests: [
        { name: "t", run: async () => { throw new Error("Selection mismatch: ..."); } },
      ],
    });
    const results = await runAllSuites();
    expect(results[0].results[0].status).toBe("fail");
  });

  it("classifies 'Assertion failed' as fail", async () => {
    registerSuite({
      name: "AssertFail",
      tests: [
        { name: "t", run: async () => { throw new Error("Assertion failed: x > 0"); } },
      ],
    });
    const results = await runAllSuites();
    expect(results[0].results[0].status).toBe("fail");
  });
});

// ============================================================================
// runSuiteByName and runMacroByName
// ============================================================================

describe("runSuiteByName", () => {
  it("runs only the named suite", async () => {
    registerSuite({ name: "A", tests: [{ name: "a1", run: async () => {} }] });
    registerSuite({ name: "B", tests: [{ name: "b1", run: async () => {} }] });
    const result = await runSuiteByName("B");
    expect(result).not.toBeNull();
    expect(result!.suiteName).toBe("B");
  });

  it("returns null for unknown suite name", async () => {
    const result = await runSuiteByName("NonExistent");
    expect(result).toBeNull();
  });
});

describe("runMacroByName", () => {
  it("finds and runs a single test across suites", async () => {
    registerSuite({
      name: "S1",
      tests: [{ name: "target", run: async () => {} }],
    });
    const result = await runMacroByName("target");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("target");
    expect(result!.status).toBe("pass");
  });

  it("returns null for unknown test name", async () => {
    const result = await runMacroByName("ghost");
    expect(result).toBeNull();
  });
});

// ============================================================================
// Result store and listeners
// ============================================================================

describe("result store", () => {
  it("getResults returns latest results after runAllSuites", async () => {
    registerSuite({
      name: "Store",
      tests: [{ name: "t", run: async () => {} }],
    });
    await runAllSuites();
    const results = getResults();
    expect(results).toHaveLength(1);
    expect(results[0].suiteName).toBe("Store");
  });

  it("onResultsChange listener is called on completion", async () => {
    const listener = vi.fn();
    const unsub = onResultsChange(listener);
    registerSuite({ name: "Notify", tests: [{ name: "t", run: async () => {} }] });
    await runAllSuites();
    expect(listener).toHaveBeenCalled();
    unsub();
  });

  it("unsubscribed listener is not called", async () => {
    const listener = vi.fn();
    const unsub = onResultsChange(listener);
    unsub();
    registerSuite({ name: "X", tests: [{ name: "t", run: async () => {} }] });
    await runAllSuites();
    expect(listener).not.toHaveBeenCalled();
  });
});
