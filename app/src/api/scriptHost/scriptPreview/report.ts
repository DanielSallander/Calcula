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
import type { FormSpec } from "../scriptFormSpec";
import { unexercisedHookNote } from "./unexercisedHooks";

/**
 * The Worker-realm preview's report: the wire `DryRunReport` plus what ONLY
 * this realm can capture.
 *
 * `formLayout` is deliberately NOT on `DryRunReport`. That interface is pinned
 * field-for-field to the Rust struct (`dryRunReportDrift.test.ts`), and the
 * interpreter realm has no `form.define` to capture — for it, "no layout" is
 * the true answer, not a padded field that is always empty. A form script is
 * an OBJECT script, so it never reaches that realm anyway (it declines).
 */
export interface WorkerPreviewReport extends DryRunReport {
  /**
   * A FORM script's layout, captured from its `form.define` call during setup.
   * The editor paints it in a preview-mode dialog; absent for every other
   * object type and when the script never declared a layout during setup.
   */
  formLayout?: FormSpec;
}

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
  /**
   * Handlers the script registered that this run did NOT fire.
   *
   * REQUIRED, because the caller always knows: the realm reports the list, and
   * an omitted field would silently mean "everything ran" — the one reading a
   * caveat exists to prevent. `[]` is the honest answer for a run that fired
   * everything it was offered.
   */
  unexercisedHooks: string[];
  /** Appended to the output when the workbook copy was capped. */
  note?: string;
  /** A form script's captured `form.define` layout (see backend.ts). */
  formLayout?: FormSpec;
}): WorkerPreviewReport {
  const changes = [...input.changes].sort((a, b) => a.row - b.row || a.col - b.col);
  const totalChanges = changes.length;
  const truncated = totalChanges > MAX_REPORTED_CHANGES;
  return {
    ...(input.formLayout !== undefined ? { formLayout: input.formLayout } : {}),
    ok: input.ok,
    error: input.error ?? null,
    durationMs: input.durationMs,
    changes: truncated ? changes.slice(0, MAX_REPORTED_CHANGES) : changes,
    truncated,
    // Reported UNCLIPPED, so the count is never a lie even when the list is.
    totalChanges,
    output: input.note ? [...input.output, `[preview] ${input.note}`] : input.output,
    readBack: input.readBack,
    // COPIED, not aliased: the realm's own array keeps being pushed to while a
    // run is in flight, and a report is a statement about a moment.
    // `?? []` because a hand-built double omitting the field must produce "no
    // caveat" rather than a TypeError in a render — see unexercisedHooks.ts.
    unexercisedHooks: [...(input.unexercisedHooks ?? [])],
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
    // Nothing was fired because nothing was RUN. An empty list here is not a
    // claim that every handler ran — `applicable: false` is the claim, and it
    // says nothing in this report is evidence about the script.
    unexercisedHooks: [],
    applicable: false,
    declinedReason: reason,
  };
}

/**
 * One line for a reviewer or a repair prompt. Mirrors `DryRunReport::summary`.
 *
 * THE ZERO IS QUALIFIED, never bare. "The script ran without error but changed
 * no cells" is read as a finding about the SCRIPT, and when the handler holding
 * the work was never fired it is a fact about the PREVIEW instead — so the
 * caveat is appended rather than the sentence rewritten, and the uncaveated
 * strings stay byte-identical to what every existing consumer already reads.
 */
export function summarize(report: DryRunReport): string {
  if (!report.applicable) {
    return `No preview: ${report.declinedReason ?? "this script cannot be previewed"}.`;
  }
  if (!report.ok) {
    return `The script failed when run against a copy of the workbook: ${report.error ?? "unknown error"}`;
  }
  const caveat = unexercisedHookNote(report.unexercisedHooks);
  if (report.totalChanges === 0) {
    return caveat
      ? `The script ran without error but changed no cells. ${caveat}`
      : "The script ran without error but changed no cells.";
  }
  const changed =
    `The script would change ${report.totalChanges} cell${report.totalChanges === 1 ? "" : "s"}` +
    `${report.truncated ? ` (showing the first ${MAX_REPORTED_CHANGES})` : ""}.`;
  return caveat ? `${changed} ${caveat}` : changed;
}
