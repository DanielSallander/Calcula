//! FILENAME: app/extensions/TestRunner/lib/runner.ts
// PURPOSE: Core test execution engine for macro-based integration tests.
// CONTEXT: Runs test suites through the API facade, collecting results.

import {
  getCell,
  updateCellsBatch,
  CommandRegistry,
} from "../../../src/api";
import { getGridStateSnapshot } from "../../../src/api/grid";
import { setSelection } from "../../../src/api/grid";
import type { TestSuite, TestContext, TestResult, SuiteResult } from "./types";

// ============================================================================
// Result Store (module-level state for the task pane to read)
// ============================================================================

let latestResults: SuiteResult[] = [];
const listeners: Array<() => void> = [];

export function getResults(): SuiteResult[] {
  return latestResults;
}

export function onResultsChange(fn: () => void): () => void {
  listeners.push(fn);
  return () => {
    const idx = listeners.indexOf(fn);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

function notifyListeners(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // ignore listener errors
    }
  }
}

// ============================================================================
// Suite Registry
// ============================================================================

const registeredSuites: TestSuite[] = [];

export function registerSuite(suite: TestSuite): void {
  registeredSuites.push(suite);
}

export function getRegisteredSuites(): TestSuite[] {
  return [...registeredSuites];
}

export function clearSuites(): void {
  registeredSuites.length = 0;
}

// ============================================================================
// Test Context Factory
// ============================================================================

function createTestContext(logs: string[]): TestContext {
  return {
    async executeCommand(id: string, args?: unknown): Promise<void> {
      await CommandRegistry.execute(id, args);
    },

    async getCell(row: number, col: number) {
      return getCell(row, col);
    },

    async setCells(updates: Array<{ row: number; col: number; value: string }>) {
      await updateCellsBatch(updates);
    },

    getSelection() {
      const snapshot = getGridStateSnapshot();
      return snapshot?.selection ?? null;
    },

    setSelection(sel: { startRow: number; startCol: number; endRow: number; endCol: number }) {
      setSelection(sel);
    },

    async settle() {
      // Small delay to let Tauri IPC round-trips complete
      await new Promise((resolve) => setTimeout(resolve, 50));
    },

    log(message: string) {
      logs.push(message);
      console.log(`  [LOG] ${message}`);
    },
  };
}

// ============================================================================
// Runner
// ============================================================================

/**
 * Run a single test suite and return results.
 */
async function runSuite(suite: TestSuite): Promise<SuiteResult> {
  const results: TestResult[] = [];
  const suiteStart = performance.now();

  console.log(`\n[TestRunner] Suite: ${suite.name}`);
  if (suite.description) console.log(`  ${suite.description}`);
  console.log(`  ${suite.tests.length} test(s)\n`);

  for (const test of suite.tests) {
    const logs: string[] = [];
    const ctx = createTestContext(logs);
    const testStart = performance.now();
    let status: "pass" | "fail" | "error" = "pass";
    let error: string | undefined;

    try {
      // beforeEach
      if (suite.beforeEach) {
        await suite.beforeEach(ctx);
      }

      // Run the test
      await test.run(ctx);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      // Distinguish assertion failures from unexpected errors
      if (e instanceof Error && e.message.startsWith("Cell ") || e instanceof Error && e.message.startsWith("Expected ") || e instanceof Error && e.message.startsWith("Selection ") || e instanceof Error && e.message.startsWith("Assertion ")) {
        status = "fail";
      } else {
        status = "error";
      }
      error = errMsg;
    }

    // afterEach (always runs)
    try {
      if (suite.afterEach) {
        await suite.afterEach(ctx);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  [afterEach error] ${msg}`);
    }

    const durationMs = performance.now() - testStart;

    results.push({
      name: test.name,
      suiteName: suite.name,
      status,
      durationMs,
      error,
      logs,
    });

    const statusTag = status === "pass" ? "[PASS]" : status === "fail" ? "[FAIL]" : "[ERROR]";
    console.log(`  ${statusTag} ${test.name} (${durationMs.toFixed(1)}ms)`);
    if (error) {
      console.log(`         ${error}`);
    }
  }

  const totalMs = performance.now() - suiteStart;
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const errors = results.filter((r) => r.status === "error").length;

  console.log(`\n  Summary: ${passed} passed, ${failed} failed, ${errors} errors (${totalMs.toFixed(0)}ms)\n`);

  return { suiteName: suite.name, results, totalMs, passed, failed, errors };
}

/**
 * Run all registered test suites.
 */
export async function runAllSuites(): Promise<SuiteResult[]> {
  console.log("\n========================================");
  console.log("[TestRunner] Running all test suites...");
  console.log("========================================");

  const allResults: SuiteResult[] = [];

  for (const suite of registeredSuites) {
    const result = await runSuite(suite);
    allResults.push(result);
  }

  // Print overall summary
  const totalPassed = allResults.reduce((s, r) => s + r.passed, 0);
  const totalFailed = allResults.reduce((s, r) => s + r.failed, 0);
  const totalErrors = allResults.reduce((s, r) => s + r.errors, 0);
  const totalMs = allResults.reduce((s, r) => s + r.totalMs, 0);

  console.log("========================================");
  console.log(`[TestRunner] Overall: ${totalPassed} passed, ${totalFailed} failed, ${totalErrors} errors (${totalMs.toFixed(0)}ms)`);
  console.log("========================================\n");

  latestResults = allResults;
  notifyListeners();

  return allResults;
}

/**
 * Run a specific suite by name.
 */
export async function runSuiteByName(name: string): Promise<SuiteResult | null> {
  const suite = registeredSuites.find((s) => s.name === name);
  if (!suite) {
    console.warn(`[TestRunner] Suite not found: "${name}"`);
    return null;
  }

  const result = await runSuite(suite);
  latestResults = [result];
  notifyListeners();
  return result;
}

/**
 * Run a single test by name (searches all suites).
 */
export async function runMacroByName(testName: string): Promise<TestResult | null> {
  for (const suite of registeredSuites) {
    const test = suite.tests.find((t) => t.name === testName);
    if (test) {
      const singleSuite: TestSuite = {
        name: suite.name,
        tests: [test],
        beforeEach: suite.beforeEach,
        afterEach: suite.afterEach,
      };
      const result = await runSuite(singleSuite);
      latestResults = [result];
      notifyListeners();
      return result.results[0] ?? null;
    }
  }
  console.warn(`[TestRunner] Test not found: "${testName}"`);
  return null;
}
