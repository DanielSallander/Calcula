//! FILENAME: app/extensions/FormulaAssist/lib/insert.ts
// PURPOSE: The ONE place in this extension that writes a cell.
// CONTEXT: Everything else here reads, asks, verifies or renders. Insertion is
//          the single moment the feature touches the document, so it is one
//          file, one function, and a source-scan test
//          (`__tests__/insertIsTheOnlyWriter.test.ts`) fails the build if
//          `updateCell` ever appears anywhere else in the folder. That guard is
//          not paranoia: "the write happens in exactly one reviewed place" is
//          the property that makes the rest of the feature safe to change.
//
// THE LOCALIZED STRING GOES IN, NOT THE INVARIANT ONE.
// -----------------------------------------------------
// `updateCell` is the ordinary cell-input path, and it DELOCALIZES whatever it
// is handed using the workbook locale — exactly as if a person had typed it.
// Hand it the invariant `=SUM(A1,B1)` in a sv-SE workbook and the comma is read
// as a decimal point: the cell ends up holding `SUM(A1.B1)`, which is not a
// formula and not an error either, just a wrong string sitting in the sheet.
// The proposal carries both forms precisely so this call site can pick the
// right one. `formulaInvariant` is for storage and comparison, never for this.
//
// FILL-DOWN IS ONE BATCH, THEREFORE ONE UNDO STEP.
// ------------------------------------------------
// `updateCellsBatch` writes the target AND every filled row in a single call.
// A loop of `updateCell` would leave the user pressing Ctrl+Z once per row to
// undo one gesture, which is the behaviour Excel users report as "it ate my
// undo history".
//
// THE PROPOSAL IS BOUND TO THE CELL IT WAS ASKED FOR.
// ---------------------------------------------------
// A local model takes ~15 seconds; a person clicks elsewhere while it thinks.
// The write goes to the cell captured when the request was made — the one the
// preview was computed for and the one the badge vouched for — and the return
// value reports whether the selection has since moved so the UI can SAY which
// cell it wrote. Silently following the selection would insert a formula that
// was verified against different data.
//
// AUDIT: every accepted proposal is recorded. See `recordInsertAudit`.

import {
  AppEvents,
  emitAppEvent,
  updateCell,
  updateCellsBatch,
} from "@api";
import type { CellUpdateInput } from "@api";
import type { FormulaProposal } from "@api/formulaAssistService";
import { getGridStateSnapshot } from "@api/grid";
import { fetchFormulaContext, formulaAssistBackend } from "./backend";

export interface InsertOptions {
  /**
   * How many rows BELOW the target to fill. Omit and the row count is derived
   * from a fresh `formula_context` read, so the fill matches the data as it is
   * at the moment of writing rather than as it was when the model answered.
   */
  fillDownRows?: number;
}

export interface InsertOutcome {
  /** The cell that was written, always the one the request captured. */
  a1: string;
  cellsWritten: number;
  /** True when the user's selection had moved away before they clicked. */
  selectionMoved: boolean;
  /** True when a fill-down was asked for but no data rows could be found. */
  fillDownEmpty: boolean;
  /** Present when insertion could not happen at all. */
  refusal?: string;
}

/**
 * Write an accepted proposal into the grid.
 *
 * Rejects only when the backend refuses the write; a refusal is re-thrown with
 * its own message intact so the caller can show the backend's sentence (sheet
 * protection, a writeback region) rather than a generic failure.
 */
export async function insertProposal(
  proposal: FormulaProposal,
  options: InsertOptions = {},
): Promise<InsertOutcome> {
  const { row, col, a1 } = proposal.target;
  const localized = proposal.formulaLocalized;

  if (!localized) {
    return {
      a1,
      cellsWritten: 0,
      selectionMoved: false,
      fillDownEmpty: false,
      refusal: "There is no formula to insert.",
    };
  }

  const selectionMoved = hasSelectionMoved(proposal);

  if (!proposal.fillDown) {
    // THE localized string. See the header.
    await updateCell(row, col, localized);
    emitAppEvent(AppEvents.GRID_REFRESH);
    await recordInsertAudit(proposal, 1);
    return { a1, cellsWritten: 1, selectionMoved, fillDownEmpty: false };
  }

  const rows = options.fillDownRows ?? (await deriveFillDownRows(proposal));
  if (rows <= 0) {
    // The model wanted a fill-down and there is nothing to fill. Writing the
    // one cell is right; pretending a fill happened is not.
    await updateCell(row, col, localized);
    emitAppEvent(AppEvents.GRID_REFRESH);
    await recordInsertAudit(proposal, 1);
    return { a1, cellsWritten: 1, selectionMoved, fillDownEmpty: true };
  }

  const updates: CellUpdateInput[] = [];
  for (let r = row; r <= row + rows; r++) {
    // `invariant` is deliberately NOT set: every row goes through the same
    // delocalization the single-cell path uses, so the two cannot diverge.
    updates.push({ row: r, col, value: localized });
  }
  await updateCellsBatch(updates);
  emitAppEvent(AppEvents.GRID_REFRESH);
  await recordInsertAudit(proposal, updates.length);
  return {
    a1,
    cellsWritten: updates.length,
    selectionMoved,
    fillDownEmpty: false,
  };
}

/**
 * How many rows below the target the data region runs.
 *
 * Read fresh rather than remembered: the proposal may be seconds old and the
 * sheet may have grown. A failure here means "fill the one cell", never
 * "guess a row count".
 */
async function deriveFillDownRows(proposal: FormulaProposal): Promise<number> {
  try {
    const ctx = await fetchFormulaContext(
      proposal.target.sheetIndex,
      proposal.target.row,
      proposal.target.col,
    );
    // `dataRowCount` counts the target's own row, so the number of rows BELOW
    // it is one less. Clamped at 0 so a one-row region cannot ask for -1.
    return Math.max(0, ctx.dataRowCount - 1);
  } catch {
    return 0;
  }
}

/** Has the user selected a different cell since the request was made? */
function hasSelectionMoved(proposal: FormulaProposal): boolean {
  const state = getGridStateSnapshot();
  if (!state || !state.selection) return false;
  return (
    state.selection.startRow !== proposal.target.row ||
    state.selection.startCol !== proposal.target.col
  );
}

/**
 * Record that an AI-proposed formula was written.
 *
 * The workbook's other audit writers did not fit: `audit_record_capability` is
 * the SCRIPT capability trail and wants a script id and a capability from
 * `ALL_CAPABILITY_IDS`, and the QuickJS surfaces record their own mutations.
 * Neither describes "a person accepted a model's formula", so
 * `ai_record_accepted_edit` was added for it, with `AuditEvent::AiAssistedEdit`
 * as an ALWAYS-recorded event.
 *
 * `verified` is the field that earns the row. Six months from now the question
 * is not "did a model touch this workbook" but "was this particular formula
 * checked before it went in", and the cell itself cannot answer that.
 *
 * A failure here must never fail the insert. The formula is already in the
 * document; refusing to report the write afterwards would leave the user with a
 * scary error about an edit that succeeded.
 */
async function recordInsertAudit(
  proposal: FormulaProposal,
  cellsWritten: number,
): Promise<void> {
  // `status === "verified"` is the ladder's verdict; `verification.verified` is
  // the engine's. They agree today, and the AND is what keeps them agreeing:
  // a future ladder change that relaxed the status must not quietly turn an
  // unchecked formula into an audit row that says it was checked.
  const verified = proposal.status === "verified" && proposal.verification?.verified === true;
  try {
    await formulaAssistBackend.invoke("ai_record_accepted_edit", {
      edit: {
        surface: "formulaAssist",
        action: cellsWritten > 1 ? "insertFillDown" : "insert",
        model: proposal.model,
        // The sheet is left to the backend, which knows which one is active;
        // sending a name from here would be a second source of truth for it.
        sheet: "",
        target: proposal.target.a1,
        content: proposal.formulaLocalized,
        verified,
        unverifiedReason: verified
          ? undefined
          : proposal.verification?.declineReason || proposal.summary || proposal.status,
      },
    });
  } catch (error) {
    // Reported, not raised. See the doc comment above.
    console.warn("[FormulaAssist] Could not record the audit entry:", error);
  }
}
