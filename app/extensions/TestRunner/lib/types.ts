//! FILENAME: app/extensions/TestRunner/lib/types.ts
// PURPOSE: Type definitions for the macro-based test runner.
// CONTEXT: Defines TestMacro, TestSuite, TestContext, and result types.

import type { CellData, Selection } from "@api/types";

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
  /** Batch-read all cells in a rectangular range, indexed by A1 address */
  getCells: (startRow: number, startCol: number, endRow: number, endCol: number) => Promise<Map<string, CellData>>;
  /** Set cell values in bulk */
  setCells: (updates: Array<{ row: number; col: number; value: string }>) => Promise<void>;
  /** Get the current grid selection */
  getSelection: () => Selection | null;
  /** Set the active selection */
  setSelection: (sel: { startRow: number; startCol: number; endRow: number; endCol: number }) => void;
  /** Undo the last action (calls Tauri backend directly) */
  undo: () => Promise<void>;
  /** Small delay (50ms) to allow frontend to process IPC responses */
  settle: () => Promise<void>;
  /** Custom delay in ms for cases needing longer settling */
  settleMs: (ms: number) => Promise<void>;
  /** Capture a cell range under a named label for later comparison */
  storeState: (label: string, startRow: number, startCol: number, endRow: number, endCol: number) => Promise<Map<string, CellData>>;
  /** Retrieve a previously stored state by label */
  getStoredState: (label: string) => Map<string, CellData>;
  /** Diff two stored states and return a human-readable change summary */
  diffStates: (labelA: string, labelB: string) => string;
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
  /** When true, the suite is registered but skipped during execution */
  disabled?: boolean;
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
  /** State diffs captured during the test (included in failure output) */
  stateDiffs?: string[];
}

export interface SuiteResult {
  suiteName: string;
  results: TestResult[];
  totalMs: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
}
