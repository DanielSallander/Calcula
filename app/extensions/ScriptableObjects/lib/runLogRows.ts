//! FILENAME: app/extensions/ScriptableObjects/lib/runLogRows.ts
// PURPOSE: Turn one `AuthoringRun` into log rows, in ONE place.
// CONTEXT: 2026-08-26. Two surfaces in this window render a run — the diff the
//          author is deciding about, and the history panel they open to read
//          what happened. They must not be able to describe the same run two
//          different ways, which is exactly what two copies of this mapping
//          would eventually do.
//
//          A LIB, NOT A COMPONENT EXPORT. `AiEditDiff.tsx` could have exported
//          it, but then the history panel would import a component module for a
//          mapper — the layering mistake `_shared/formatElapsed.ts` was carved
//          out to stop.
//
//          THE MODEL'S OWN PROSE IS A ROW. `note` is everything it said outside
//          the code fence, which `extractScript` used to discard at the instant
//          it arrived. That one line is why "I could not see the reasoning or
//          the results from the chat" was true of every surface downstream:
//          nothing could show it, because nothing ever had it.

import type { AuthoringRun, RunDryRun } from "@api/scriptHost/authoringRun";
import type { RunLogRow } from "../../_shared/components/RunLog";

/** One sentence about what the preview did with an attempt. */
export function dryRunLine(d: RunDryRun): string {
  // `applicable === false` FIRST. A declined report is not a verdict on the
  // script — the preview realm could not host it at all — and reading one as a
  // failure is the mistake that sent a correct script round after round of
  // "repair".
  if (d.applicable === false) {
    return d.declinedReason
      ? `it could not be run against a copy of the workbook (${d.declinedReason})`
      : "it could not be run against a copy of the workbook";
  }
  if (!d.ok) return `it failed when run: ${d.error ?? "unknown error"}`;
  return `it ran and changed ${d.changedCells} cell${d.changedCells === 1 ? "" : "s"}`;
}

/**
 * The run as log rows, oldest attempt first.
 *
 * Up to three rows per attempt: the verdict on it, what the dry run made of it,
 * and what the model said about it in its own words.
 */
export function runLogRows(run: AuthoringRun | null): RunLogRow[] {
  if (!run) return [];
  const who = run.model || "model";
  const rows: RunLogRow[] = [];
  for (const a of run.attempts) {
    const errors = a.findings.filter((f) => f.severity === "error").map((f) => f.message);
    rows.push({
      at: a.at,
      kind: a.ok ? "ok" : "bad",
      text: `attempt ${a.attempt} — ${a.ok ? "passed every check" : "rejected"}`,
      detail: errors.length > 0 ? errors.join("; ") : undefined,
    });
    if (a.dryRun) {
      rows.push({
        at: a.at + a.durationMs,
        kind: a.dryRun.applicable === false ? "info" : a.dryRun.ok ? "ok" : "bad",
        text: `attempt ${a.attempt} — ${dryRunLine(a.dryRun)}`,
      });
    }
    const note = a.note.trim();
    if (note) rows.push({ at: a.at + a.durationMs, kind: "info", text: `[${who}] ${note}` });
  }
  return rows;
}
