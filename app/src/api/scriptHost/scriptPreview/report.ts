//! FILENAME: app/src/api/scriptHost/scriptPreview/report.ts
// PURPOSE: Turn what a preview run observed into the report every consumer
//          already knows how to read.
// CONTEXT: docs/design/local-model-script-authoring.md §5c.
//
//          PURE ON PURPOSE. The realm half of this rung needs a real Worker and
//          therefore cannot be unit-tested at all (jsdom has no `Worker`), so
//          everything that can be decided without one lives here instead — the
//          diff, the cap, and the difference between "no objection" and "no
//          verdict". That is the half where a mistake is silent: a truncated
//          count, or a decline that reads as a pass.
//
//          THE REPORT SHAPE IS `ai_dry_run_script`'s, deliberately. Both rungs
//          answer the same question about different realms, and every consumer
//          — the draft gate, the authoring loop's repair prompt, the transcript
//          note — already branches on `applicable` before drawing a conclusion.
//          A second shape would have meant teaching all of them a second time.

import type { PreviewGrid } from "./grid";
import type { DryRunReport } from "../scriptAuthoring";

/** How many changed cells a report carries. Mirrors MAX_REPORTED_CHANGES (Rust). */
export const MAX_REPORTED_CHANGES = 200;

export interface CellChange {
  row: number;
  col: number;
  before: string;
  after: string;
}

/**
 * Cells whose input string differs between the two states, row-major.
 *
 * The comparison is over INPUT STRINGS, never displays: a formatted cell's
 * display changes with its number format, and a diff that watched the display
 * would report a "change" for a cell nothing wrote.
 */
export function diffGrid(before: ReadonlyMap<string, string>, after: PreviewGrid): CellChange[] {
  const changes: CellChange[] = [];
  const seen = new Set<string>();
  for (const { row, col, cell } of after.entries()) {
    const k = `${row},${col}`;
    seen.add(k);
    const was = before.get(k) ?? "";
    if (was !== cell.input) changes.push({ row, col, before: was, after: cell.input });
  }
  // A cell the run REMOVED from the map entirely still changed. The preview grid
  // keeps cleared cells as husks so this is defensive rather than load-bearing —
  // but a diff that can only see additions stays correct right up until the day
  // some backend method starts deleting keys.
  for (const [k, was] of before) {
    if (seen.has(k) || was === "") continue;
    const [row, col] = k.split(",").map(Number);
    changes.push({ row, col, before: was, after: "" });
  }
  return changes.sort((a, b) => a.row - b.row || a.col - b.col);
}

export function buildReport(input: {
  ok: boolean;
  error?: string;
  durationMs: number;
  changes: CellChange[];
  output: string[];
  readBack: Array<{ row: number; col: number; value: string }>;
  /** Appended to the output when the workbook copy was capped. */
  note?: string;
}): DryRunReport {
  const changes = [...input.changes].sort((a, b) => a.row - b.row || a.col - b.col);
  const totalChanges = changes.length;
  const truncated = totalChanges > MAX_REPORTED_CHANGES;
  return {
    ok: input.ok,
    error: input.error ?? null,
    durationMs: input.durationMs,
    changes: truncated ? changes.slice(0, MAX_REPORTED_CHANGES) : changes,
    truncated,
    // Reported UNCLIPPED, so the count is never a lie even when the list is.
    totalChanges,
    output: input.note ? [...input.output, `[preview] ${input.note}`] : input.output,
    readBack: input.readBack,
    applicable: true,
    declinedReason: null,
  };
}

/**
 * The report for a run this rung cannot draw a conclusion from.
 *
 * `ok` stays TRUE while `applicable` is false, matching `ai_dry_run_script`: a
 * caller that reads only `ok` sees "no objection", which is the safe direction.
 * This rung never invents a rejection — the whole reason it exists is that the
 * previous one did, rejecting every valid draft with "it FAILS when run".
 */
export function declined(reason: string, output: string[] = []): DryRunReport {
  return {
    ok: true,
    error: null,
    durationMs: 0,
    changes: [],
    truncated: false,
    totalChanges: 0,
    output,
    readBack: [],
    applicable: false,
    declinedReason: reason,
  };
}

/** One line for a reviewer or a repair prompt. Mirrors `DryRunReport::summary`. */
export function summarize(report: DryRunReport): string {
  if (!report.applicable) {
    return `No preview: ${report.declinedReason ?? "this script cannot be previewed"}.`;
  }
  if (!report.ok) {
    return `The script failed when run against a copy of the workbook: ${report.error ?? "unknown error"}`;
  }
  if (report.totalChanges === 0) {
    return "The script ran without error but changed no cells.";
  }
  return (
    `The script would change ${report.totalChanges} cell${report.totalChanges === 1 ? "" : "s"}` +
    `${report.truncated ? ` (showing the first ${MAX_REPORTED_CHANGES})` : ""}.`
  );
}
