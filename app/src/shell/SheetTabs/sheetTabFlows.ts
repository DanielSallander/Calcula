//! FILENAME: app/src/shell/SheetTabs/sheetTabFlows.ts
// PURPOSE: The backend call SEQUENCES behind two Excel placements the backend
//          has no single command for:
//            - Insert Sheet (Shift+F11, Home > Insert > Insert Sheet): a new
//              worksheet immediately BEFORE the active sheet;
//            - Move or Copy Sheet...: a sheet (or a copy of it) before any
//              sheet, or at the end.
// CONTEXT: Each is `add_sheet` / `copy_sheet` followed by one `move_sheet`
//          (sheetPlacement.ts has the rotate arithmetic). The sequence lives
//          here, with the backend PASSED IN, so it can be run against a model
//          of the backend in a unit test; the sheet tab strip calls it with
//          the real wrappers and then applies the result through its own
//          commit-before-switch steps (SheetTabs.tsx `applySheetsResult`).
//
//          A landed first step is never thrown away: when the move after an
//          add or a copy fails (a structure lock, say), the sheet still EXISTS
//          and is active in the backend, so the flow returns that result
//          together with the error -- the strip must show the sheet the user
//          now has, and say why it is not where they asked.
//
//          Core's per-sheet view cache is told about every renumbering AFTER
//          the step that caused it lands (`reorder`), so a failed step never
//          re-keys the cache for a change that did not happen.

import {
  insertionReorderDetail,
  moveTargetFor,
  type PlacedSheet,
} from "./sheetPlacement";

/** What the backend answers: the sheet list and the active TRUE index. */
export interface SheetFlowResult {
  sheets: PlacedSheet[];
  activeIndex: number;
}

/** The three backend placements the flows compose. */
export interface SheetFlowBackend<R extends SheetFlowResult = SheetFlowResult> {
  addSheet(): Promise<R>;
  copySheet(index: number): Promise<R>;
  moveSheet(fromIndex: number, toIndex: number): Promise<R>;
}

/** Tells Core's per-sheet view cache about a renumbering (`sheet:reorder`). */
export type SheetReorderAnnouncer = (detail: { fromIndex: number; toIndex: number }) => void;

/** A flow's outcome: the result to apply, and the error of a step that failed after one landed. */
export interface SheetFlowOutcome<R> {
  result: R;
  error?: unknown;
}

/**
 * Rotate the sheet at `from` to `to` (when that changes anything), telling the
 * cache once it landed. A failure answers `landed` -- the result of the step
 * that DID land -- with the error.
 */
async function rotateLanded<R extends SheetFlowResult>(
  backend: SheetFlowBackend<R>,
  reorder: SheetReorderAnnouncer,
  from: number,
  to: number,
  landed: R,
): Promise<SheetFlowOutcome<R>> {
  if (to === from) return { result: landed };
  try {
    const moved = await backend.moveSheet(from, to);
    reorder({ fromIndex: from, toIndex: to });
    return { result: moved };
  } catch (error) {
    return { result: landed, error };
  }
}

/**
 * Excel's Insert Sheet: add a worksheet, then rotate it to immediately before
 * `anchor` (the sheet that was active). With no anchor it is a plain add. The
 * new sheet is active either way (`add_sheet` activates it and the active
 * sheet follows its sheet through a move).
 *
 * Throws only when the ADD fails (nothing landed).
 */
export async function insertSheetBefore<R extends SheetFlowResult>(
  backend: SheetFlowBackend<R>,
  reorder: SheetReorderAnnouncer,
  anchor: PlacedSheet | undefined,
): Promise<SheetFlowOutcome<R>> {
  const added = await backend.addSheet();
  // `add_sheet` appends at the end of the USER prefix, which is not the end of
  // the list once an object sheet sits in the tail: the cache is told the
  // insertion wherever it landed.
  reorder(insertionReorderDetail(added.activeIndex));
  if (!anchor) return { result: added };
  const to = moveTargetFor(added.activeIndex, anchor, added.sheets);
  return rotateLanded(backend, reorder, added.activeIndex, to, added);
}

/**
 * Excel's Move or Copy: the sheet at `sourceIndex` -- or, with `copy`, a copy
 * of it -- immediately before the sheet at `beforeIndex` (a TRUE index in
 * `sheets`, the listing the choice was made from), or at the end when
 * `beforeIndex` is null.
 *
 * A move answers `result: null` when it would change nothing (before itself,
 * or before the sheet already after it). A copy is active afterwards (Excel);
 * a move leaves the active sheet where it was (the backend's active index
 * follows its sheet).
 *
 * Throws only when the FIRST step fails (nothing landed), or when
 * `beforeIndex` names a sheet `sheets` does not carry -- which would otherwise
 * read as "(move to end)".
 */
export async function moveOrCopySheet<R extends SheetFlowResult>(
  backend: SheetFlowBackend<R>,
  reorder: SheetReorderAnnouncer,
  sheets: readonly PlacedSheet[],
  sourceIndex: number,
  beforeIndex: number | null,
  copy: boolean,
): Promise<SheetFlowOutcome<R | null>> {
  const anchor =
    beforeIndex === null ? null : sheets.find((s) => s.index === beforeIndex) ?? null;
  if (beforeIndex !== null && anchor === null) {
    throw new Error(`No sheet at index ${beforeIndex} to place it before.`);
  }

  if (copy) {
    const copied = await backend.copySheet(sourceIndex);
    // `copy_sheet` inserts right after its source: every sheet past it moved.
    reorder(insertionReorderDetail(copied.activeIndex));
    const to = moveTargetFor(copied.activeIndex, anchor, copied.sheets);
    return rotateLanded(backend, reorder, copied.activeIndex, to, copied);
  }

  const to = moveTargetFor(sourceIndex, anchor, sheets);
  if (to === sourceIndex) return { result: null };
  const moved = await backend.moveSheet(sourceIndex, to);
  reorder({ fromIndex: sourceIndex, toIndex: to });
  return { result: moved };
}
