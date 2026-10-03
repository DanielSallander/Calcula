//! FILENAME: app/src/api/codeWarnings.ts
// PURPOSE: "What is worth a look" in a workbook's code, decided ONCE -- the
//          rule Code in This File paints its warning chips from and the status
//          bar's code-and-scripts indicator lights its dot from.
// CONTEXT: Split out of codeInventory.ts so it has NO runtime imports: a
//          surface's test that doubles the inventory module wholesale can still
//          import this real rule, instead of re-typing a copy of it (a copied
//          rule is the drift this one list exists to end). Re-exported from
//          @api/codeInventory, which is where callers import it from.

import type {
  CodeInventorySummary,
  ScheduledJobSummary,
  ScriptHeldStateSummary,
} from "./codeInventory";

/** Which warning. Stable: surfaces key data attributes and tests on it. */
export type CodeInventoryWarningId =
  | "beyond-grid"
  | "jobs"
  | "shortcuts"
  | "clipboards"
  | "watches"
  | "panes"
  | "form";

/** One thing in the file worth a look. */
export interface CodeInventoryWarning {
  id: CodeInventoryWarningId;
  /** The words, the same on every surface ("2 scheduled jobs"). */
  text: string;
  /** A short qualifier a one-line chip appends in brackets ("1 paused"). */
  note?: string;
  /** Why it is worth a look, for a surface with room for a second line. */
  why: string;
}

/**
 * Everything worth a look, from the three roll-ups -- the ONE rule Code in
 * This File paints its warning chips from and the status bar's
 * code-and-scripts indicator lights its dot from. It used to be two
 * hand-written copies of the same conditions; a chip added to one would have
 * left the other quiet while the panel it opens said otherwise.
 *
 * Each is something that happens WITHOUT the user asking at that moment, or
 * that reaches past what a spreadsheet does: code that can leave the grid, a
 * schedule (paused or not -- a paused job revives on resume), and anything a
 * script is holding. A `null` roll-up was not read; it contributes nothing
 * here, and the caller says "could not read" for it.
 */
export function codeInventoryWarnings(
  inventory: Pick<CodeInventorySummary, "beyondGrid"> | null,
  jobs: ScheduledJobSummary | null,
  held: ScriptHeldStateSummary | null,
): CodeInventoryWarning[] {
  const s = (n: number): string => (n === 1 ? "" : "s");
  const out: CodeInventoryWarning[] = [];
  if (inventory && inventory.beyondGrid > 0) {
    out.push({
      id: "beyond-grid",
      text: `${inventory.beyondGrid} can reach beyond the grid`,
      why: "Network, BI, storage or host HTML, up to what each one declares",
    });
  }
  if (jobs && jobs.total > 0) {
    out.push({
      id: "jobs",
      text: `${jobs.total} scheduled job${s(jobs.total)}`,
      note: jobs.disabled > 0 ? `${jobs.disabled} paused` : undefined,
      why: "Runs without you starting it",
    });
  }
  if (held) {
    if (held.shortcuts > 0) {
      out.push({
        id: "shortcuts",
        text: `${held.shortcuts} keyboard shortcut${s(held.shortcuts)} held by scripts`,
        why: "A key you press runs a script",
      });
    }
    if (held.clipboardCells > 0) {
      out.push({
        id: "clipboards",
        text: `${held.clipboardCells} cell${s(held.clipboardCells)} in script clipboards`,
        why: "Copies of your cells a script is keeping",
      });
    }
    if (held.runningWatches > 0) {
      out.push({
        id: "watches",
        text: `${held.runningWatches} background check${s(held.runningWatches)} running`,
        why: "Calcula is polling on a script's behalf",
      });
    }
    if (held.panes > 0) {
      out.push({
        id: "panes",
        text: `${held.panes} script pane${s(held.panes)} open`,
        note: held.embeddedForms > 0 ? `${held.embeddedForms} on a sheet` : undefined,
        why: "A script is showing you something",
      });
    }
    if (held.forms > 0) {
      out.push({ id: "form", text: "A script's dialog is open", why: "A script is asking you something" });
    }
  }
  return out;
}
