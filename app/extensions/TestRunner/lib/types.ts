//! FILENAME: app/extensions/TestRunner/lib/types.ts
// PURPOSE: Type definitions for the macro-based test runner.
// CONTEXT: Defines TestMacro, TestSuite, TestContext, and result types.

import type { CellData, Selection } from "../../../src/api/types";

// ============================================================================
// Test Context (passed to each test macro)
// ============================================================================

/**
 * Context object passed to each test macro function.
 * Provides access to the spreadsheet API for driving tests.
 */
export interface TestContext {
  /** Execute a registered command by ID */
  executeCommand: (id: string, args?: unknown) => Promise<void>;
  /** Get a cell's data from the backend */
  getCell: (row: number, col: number) => Promise<CellData | null>;
  /** Set cell values in bulk */
  setCells: (updates: Array<{ row: number; col: number; value: string }>) => Promise<void>;
  /** Get the current grid selection */
  getSelection: () => Selection | null;
  /** Set the active selection */
  setSelection: (sel: { startRow: number; startCol: number; endRow: number; endCol: number }) => void;
  /** Small delay to allow backend round-trips to settle */
  settle: () => Promise<void>;
  /** Log a message to the test output */
  log: (message: string) => void;
}

// ============================================================================
// Test Definitions
// ============================================================================

/**
 * A single test macro: a named async function that exercises the app
 * through the TestContext and throws on assertion failure.
 */
export interface TestMacro {
  /** Unique name for this test */
  name: string;
  /** Optional description */
  description?: string;
  /** Optional tags for filtering */
  tags?: string[];
  /** The test function. Throw to indicate failure. */
  run: (ctx: TestContext) => Promise<void>;
}

/**
 * A named group of related test macros with optional setup/teardown.
 */
export interface TestSuite {
  /** Suite name */
  name: string;
  /** Suite description */
  description?: string;
  /** Tests in this suite */
  tests: TestMacro[];
  /** Run before each test */
  beforeEach?: (ctx: TestContext) => Promise<void>;
  /** Run after each test */
  afterEach?: (ctx: TestContext) => Promise<void>;
}

// ============================================================================
// Test Results
// ============================================================================

export type TestStatus = "pass" | "fail" | "error" | "skipped";

export interface TestResult {
  name: string;
  suiteName: string;
  status: TestStatus;
  durationMs: number;
  error?: string;
  logs: string[];
}

export interface SuiteResult {
  suiteName: string;
  results: TestResult[];
  totalMs: number;
  passed: number;
  failed: number;
  errors: number;
}
