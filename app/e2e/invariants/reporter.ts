//! FILENAME: app/e2e/invariants/reporter.ts
// PURPOSE: Formats invariant violation reports for debugging.

import type { InvariantViolation } from "./invariants";
import type { StateSnapshot } from "./stateSnapshot";

export interface RunResult {
  passed: boolean;
  seed: number;
  totalActions: number;
  /** Step number where the first violation occurred (1-based), or null if passed */
  failedAtStep: number | null;
  /** Ordered list of action IDs executed */
  actionHistory: string[];
  /** First violation found, or null if passed */
  violation: InvariantViolation | null;
  /** All violations found at the failing step */
  allViolations: InvariantViolation[];
  /** Snapshot at the time of failure */
  failingSnapshot: StateSnapshot | null;
}

/**
 * Format a RunResult into a human-readable report for test output.
 */
export function formatReport(result: RunResult): string {
  if (result.passed) {
    return (
      `[OK] Invariant test passed\n` +
      `  Seed: ${result.seed}\n` +
      `  Actions executed: ${result.totalActions}`
    );
  }

  const lines: string[] = [
    `[FAIL] Invariant violation detected`,
    ``,
    `  Seed: ${result.seed}  (use this seed to replay the exact sequence)`,
    `  Failed at step: ${result.failedAtStep} of ${result.totalActions}`,
    ``,
    `  --- Violation ---`,
    `  Invariant: ${result.violation!.invariantId}`,
    `  Message: ${result.violation!.message}`,
    ``,
  ];

  // Show relevant details
  if (result.violation!.details) {
    lines.push(`  --- Details ---`);
    for (const [key, value] of Object.entries(result.violation!.details)) {
      lines.push(`  ${key}: ${JSON.stringify(value)}`);
    }
    lines.push(``);
  }

  // Show additional violations at same step
  if (result.allViolations.length > 1) {
    lines.push(
      `  --- Additional violations at this step: ${result.allViolations.length - 1} ---`
    );
    for (const v of result.allViolations.slice(1)) {
      lines.push(`  [${v.invariantId}] ${v.message}`);
    }
    lines.push(``);
  }

  // Show action history leading to failure
  lines.push(`  --- Action History (last 20 actions) ---`);
  const history = result.actionHistory;
  const startIdx = Math.max(0, history.length - 20);
  for (let i = startIdx; i < history.length; i++) {
    const marker = i === history.length - 1 ? " <-- FAILED HERE" : "";
    lines.push(`  ${i + 1}. ${history[i]}${marker}`);
  }

  // Show snapshot state at failure
  if (result.failingSnapshot) {
    const snap = result.failingSnapshot;
    lines.push(``);
    lines.push(`  --- State at Failure ---`);
    lines.push(`  Slicers: ${snap.logical.slicers.length}`);
    lines.push(`  Charts: ${snap.logical.charts.length}`);
    lines.push(`  Tables: ${snap.logical.tables.length}`);
    lines.push(`  Pivots: ${snap.logical.pivots.length}`);
    lines.push(`  Timelines: ${snap.logical.timelines.length}`);
    lines.push(`  Sparklines: ${snap.logical.sparklineGroups.length}`);
    lines.push(
      `  Ribbon tabs: ${snap.visual.ribbonTabs.map((t) => `${t.label}${t.accentColor ? " [contextual]" : ""}`).join(", ")}`
    );
    if (snap.consoleErrors.length > 0) {
      lines.push(`  Console errors: ${snap.consoleErrors.length}`);
    }
    if (snap.jsExceptions.length > 0) {
      lines.push(`  JS exceptions: ${snap.jsExceptions.length}`);
    }
  }

  return lines.join("\n");
}
