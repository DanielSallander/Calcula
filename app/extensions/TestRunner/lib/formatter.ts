//! FILENAME: app/extensions/TestRunner/lib/formatter.ts
// PURPOSE: Format test results for clipboard copy.
// CONTEXT: Produces concise, structured text optimized for pasting into an AI prompt.

import type { SuiteResult } from "./types";

/**
 * Format test results as structured text optimized for AI prompt context.
 * Keeps it concise: only shows errors for failed tests, skips details for passing ones.
 */
export function formatResultsForClipboard(results: SuiteResult[]): string {
  const totalPassed = results.reduce((s, r) => s + r.passed, 0);
  const totalFailed = results.reduce((s, r) => s + r.failed, 0);
  const totalErrors = results.reduce((s, r) => s + r.errors, 0);
  const totalTests = totalPassed + totalFailed + totalErrors;
  const totalMs = results.reduce((s, r) => s + r.totalMs, 0);

  const lines: string[] = [];

  lines.push("## Test Results");
  lines.push("");
  lines.push(`**${totalPassed}/${totalTests} passed** | ${totalFailed} failed | ${totalErrors} errors | ${totalMs.toFixed(0)}ms`);
  lines.push("");

  for (const suite of results) {
    lines.push(`### ${suite.suiteName} (${suite.passed}/${suite.results.length})`);
    lines.push("");

    for (const test of suite.results) {
      const tag = test.status === "pass" ? "PASS" : test.status === "fail" ? "FAIL" : "ERROR";
      const duration = `${test.durationMs.toFixed(0)}ms`;

      if (test.status === "pass") {
        lines.push(`- [${tag}] ${test.name} (${duration})`);
      } else {
        lines.push(`- [${tag}] ${test.name} (${duration})`);
        if (test.error) {
          lines.push(`  > ${test.error}`);
        }
        if (test.logs.length > 0) {
          for (const log of test.logs) {
            lines.push(`  > log: ${log}`);
          }
        }
      }
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
