//! FILENAME: app/src/api/sheetSwitch.ts
// PURPOSE: ONE door for "make sheet N the active sheet" from an extension --
//          the same switch a tab click makes, step for step -- and ONE door for
//          FOLLOWING a sheet-list change the backend already made (an add, a
//          delete, a hide that moved the active sheet): `announceSheetsChanged`
//          / `changeSheetsAndFollow`, the same switch the tab strip makes after
//          its own add, delete and hide.
// CONTEXT: Extensions hand-rolled the switch, and it drifted:
//            - Cell Bookmarks' Next/Previous and the view-bookmark restore did
//              NOT await the backend switch before announcing it. SheetTabs
//              re-reads the sheet list on SHEET_CHANGED, and that read could be
//              answered BEFORE the switch landed: it reported the old sheet as
//              active and dispatched it back, so a jump from a canvas left the
//              backend on Sheet1 and the grid on the canvas (found live
//              2026-09-29, e2e fixall-edit X16).
//            - the Application Explorer, Go To (Tracing), the CSV import and a
//              notebook's Send to grid switched the BACKEND only, so the grid
//              and the tab strip never followed.
//            - none of them fired `sheet:beforeSwitch` / `sheet:normalSwitch`,
//              which are what save the sheet being left, refetch the new
//              sheet's cells (GridCanvas), refresh its dimensions and restore
//              its selection (Spreadsheet), and check its styles.
//          The sequence is SheetTabs' normal tab click (and the Name Box's
//          switchToSheet, which copies it): beforeSwitch, the backend switch,
//          `primeSheetSwitch` (BUG-0052: the canvas repaints the new sheet in
//          the same flush as the strip), Core's sheet context with the sheet's
//          own surface, normalSwitch, SHEET_CHANGED. This is a seam (Seam Rule):
//          callers say WHICH sheet; how a switch is made lives here.

import { setActiveSheet as setActiveSheetBackend } from "../core/lib/tauri-api";
import type { SheetRecordingOptions, SheetsResult } from "../core/lib/tauri-api";
import { primeSheetSwitch } from "../core/lib/sheetSwitchPrefetch";
import { setActiveSheet } from "../core/state/gridActions";
import { getGridStateSnapshot } from "../core/state/GridContext";
import { BEYOND_EVERY_SHEET } from "../core/state/sheetRenumbering";
import { dispatchGridAction } from "./gridDispatch";
import { AppEvents, emitAppEvent } from "./events";

/**
 * How a switch treats the keyboard focus. By default the grid takes it once
 * the switch landed (a tab click leaves focus on the tab), so typing works at
 * once. `keepFocus: true` leaves it where it is: the command line's prompt,
 * whose next typed line must never land in a cell (review rev3C#3). Carried
 * on `sheet:normalSwitch` as `keepFocus`, which Core honours.
 */
export interface SheetFocusOptions {
  keepFocus?: boolean;
}

/** `sheet:normalSwitch`'s detail, with `keepFocus` only when it is asked for. */
function normalSwitchDetail(
  index: number,
  name: string,
  focus: SheetFocusOptions | undefined,
): { newSheetIndex: number; newSheetName: string; keepFocus?: true } {
  return focus?.keepFocus === true
    ? { newSheetIndex: index, newSheetName: name, keepFocus: true }
    : { newSheetIndex: index, newSheetName: name };
}

/**
 * Make `index` the active sheet, exactly as a tab click does. Everything the
 * switch moves has moved when the promise resolves -- a caller that then
 * selects a cell (a bookmark, Go To) has the last word over the sheet's
 * restored selection. Returns the backend's answer; the sheet it reports
 * active is the one switched to.
 */
export async function activateSheet(
  index: number,
  options?: SheetRecordingOptions & SheetFocusOptions,
): Promise<SheetsResult> {
  window.dispatchEvent(
    new CustomEvent("sheet:beforeSwitch", {
      detail: {
        oldSheetIndex: getGridStateSnapshot()?.sheetContext.activeSheetIndex ?? 0,
        newSheetIndex: index,
      },
    }),
  );
  // `{ record: false }` reaches the wrapper, which is where the macro recorder
  // is told about an `activateSheet` step: a drill-through's landing on its
  // temporary sheet is a consequence of the drill, not a step of the user's
  // macro (model-drillthrough.md 2.7). The default call is the one it always was.
  const result =
    options?.record === false
      ? await setActiveSheetBackend(index, { record: false })
      : await setActiveSheetBackend(index);
  await primeSheetSwitch(result.activeIndex);
  // By the index FIELD, never list position: object-backed sheets are absent
  // from the list while indices stay true.
  const active = result.sheets.find((s) => s.index === result.activeIndex);
  const name = active?.name ?? "";
  // No await from here on: the context, the grid's refetch and the tab strip
  // move in one flush.
  // With the sheet's STABLE id: an open edit follows its sheet by it.
  dispatchGridAction(
    setActiveSheet(result.activeIndex, name, active?.kind === "canvas" ? "canvas" : "grid", active?.sheetId),
  );
  window.dispatchEvent(
    new CustomEvent("sheet:normalSwitch", {
      detail: normalSwitchDetail(result.activeIndex, name, options),
    }),
  );
  emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: result.activeIndex, sheetName: name });
  return result;
}

/** A backend answer with a sheet list: `SheetsResult` and the script host's own reads. */
export interface FollowableSheetsResult {
  sheets: Array<{ index: number; name: string; kind?: string; sheetId?: string }>;
  activeIndex: number;
}

/**
 * What a sheet-list change did to the NUMBERING, told by the caller that made
 * it (only it knows): Core keeps each sheet's selection and scroll by TRUE
 * index, and re-keys that memory on `sheet:reorder` (Spreadsheet.tsx).
 */
export interface SheetsRenumbering {
  /** The sheet at this TRUE index was DELETED: every later sheet moved down one. */
  removedIndex?: number;
  /**
   * A sheet was INSERTED at this TRUE index (an add, a copy, wherever it
   * landed): it and every later sheet moved up one.
   */
  insertedIndex?: number;
  /**
   * One sheet was MOVED, `move_sheet`'s rotate: the sheet at `fromIndex` now
   * stands at `toIndex`, and every sheet between shifted one place toward
   * `fromIndex`.
   */
  moved?: { fromIndex: number; toIndex: number };
}

/*
 * Core's `sheet:reorder` is a ROTATE (`{ fromIndex, toIndex }`); a removal is
 * told as a rotate from the removed index to beyond every sheet, which drops
 * the deleted sheet's memory and moves every later key down one, and an
 * insertion as a rotate from beyond every sheet to the new index, which moves
 * every key at or past it up one and leaves the new index empty
 * (core/state/sheetRenumbering.ts). The same far index the tab strip uses for
 * its own adds, copies and deletes (shell/SheetTabs/sheetPlacement.ts
 * `insertionReorderDetail` / `removalReorderDetail`).
 */

/** Tell Core's per-sheet view memory what the change did to the numbering. */
function announceRenumbering(renumbering: SheetsRenumbering | undefined): void {
  if (renumbering === undefined) return;
  const reorder = (fromIndex: number, toIndex: number): void => {
    window.dispatchEvent(new CustomEvent("sheet:reorder", { detail: { fromIndex, toIndex } }));
  };
  if (renumbering.removedIndex !== undefined) reorder(renumbering.removedIndex, BEYOND_EVERY_SHEET);
  if (renumbering.insertedIndex !== undefined) reorder(BEYOND_EVERY_SHEET, renumbering.insertedIndex);
  if (renumbering.moved !== undefined && renumbering.moved.fromIndex !== renumbering.moved.toIndex) {
    reorder(renumbering.moved.fromIndex, renumbering.moved.toIndex);
  }
}

/**
 * Whether the backend's active sheet is no longer the sheet Core shows: a
 * different index, a different sheet (by stable id, when both sides know
 * one), the shown sheet itself deleted -- its neighbour then slides into the
 * same index, so an index comparison alone calls it unmoved -- or a sheet
 * inserted at or before it, which pushes it up one and leaves another sheet at
 * its index.
 */
function activeSheetMoved(
  shown: { activeSheetIndex: number; activeSheetId?: string },
  active: { index: number; sheetId?: string },
  renumbering: SheetsRenumbering | undefined,
): boolean {
  if (active.index !== shown.activeSheetIndex) return true;
  if (renumbering?.removedIndex === shown.activeSheetIndex) return true;
  if (renumbering?.insertedIndex !== undefined && renumbering.insertedIndex <= shown.activeSheetIndex) return true;
  const shownId = shown.activeSheetId;
  return typeof shownId === "string" && shownId !== "" && typeof active.sheetId === "string" &&
    active.sheetId !== "" && active.sheetId !== shownId;
}

/**
 * THE BACKSTOP for a caller that renumbered the sheets and told nothing (review
 * rev3C#2): the backend's active sheet IS the sheet Core shows -- the same
 * stable id on both sides -- only at another index. Nothing switched, so
 * nothing is saved or restored (a "switch" would save the sheet's view under
 * its old index and restore whatever another sheet left under the new one,
 * onto this sheet); the sheet's own memory is carried to its new index.
 */
function sameSheetRenumbered(
  shown: { activeSheetIndex: number; activeSheetId?: string },
  active: { index: number; sheetId?: string },
  renumbering: SheetsRenumbering | undefined,
): boolean {
  if (renumbering !== undefined) return false;
  if (active.index === shown.activeSheetIndex) return false;
  const shownId = shown.activeSheetId;
  return typeof shownId === "string" && shownId !== "" && active.sheetId === shownId;
}

/**
 * The sheet LIST changed in the backend -- a sheet added, deleted, renamed,
 * hidden or unhidden by a caller that is not the tab strip -- and the answer
 * may name a different active sheet: make Core and every listener FOLLOW it.
 *
 * WHEN THE ACTIVE SHEET MOVED (an add, a delete of or before the active sheet,
 * a hide of the active sheet, a move that renumbered it) this is the tab
 * strip's own switch for a change
 * the backend already made (SheetTabs `applySheetsResult` /
 * `executeDeleteSheet`), step for step: `sheet:beforeSwitch` for the sheet
 * Core still shows (Spreadsheet saves ITS selection and scroll), the
 * renumbering, `primeSheetSwitch`, Core's sheet context (with the sheet's own
 * surface and stable id, so a canvas opens as a canvas and an open edit
 * follows its sheet), `sheet:normalSwitch` (the canvas refetches the new
 * sheet's cells, Spreadsheet re-reads its dimensions and restores ITS
 * selection and scroll) and SHEET_CHANGED (SheetTabs reloads its list).
 *
 * OTHERWISE (a rename, a tab colour, a hide of another sheet, a delete after
 * the active one) the context is re-dispatched (a rename's new name), the
 * renumbering told, SHEET_CHANGED announced and the grid re-read -- no switch,
 * so nobody's selection memory is touched.
 *
 * Why this exists (BUG-0464): Core's `hideSheet` moves the backend's active
 * sheet off a sheet it hides and DELIBERATELY announces nothing then -- the
 * caller that applies the switch announces it, after the switch. The command
 * line's `set sheet <active> visibility=hidden` applied nothing, so the grid
 * went on painting the hidden sheet while the backend's active sheet was its
 * neighbour -- the BUG-0046 shape, where edits land on a sheet other than the
 * one on screen -- and its `add sheet` and `delete sheet` did the same. A
 * first version of this announced the context and SHEET_CHANGED only, never
 * the two switch events, so a command-line hide opened the neighbour with the
 * hidden sheet's selection and scroll and keyed the next save on the wrong
 * sheet (review revG#3). The script host and the command line both call this,
 * each passing the renumbering its change made (`SheetsRenumbering`): a
 * renumbering left untold re-keys every later sheet's remembered selection and
 * scroll onto its neighbour.
 *
 * A caller that renumbered and told NOTHING, while the sheet on screen is
 * still the backend's active sheet (the same stable id at another index), is
 * not switched at all: its view stays, and its memory is carried to the new
 * index (`sameSheetRenumbered`, review rev3C#2). Before that backstop, such a
 * call saved the sheet's view under its old index and restored, onto it, the
 * view another sheet had left under the new one.
 *
 * "Moved" is judged against Core's context READ ON ENTRY, before anything is
 * awaited, so call this right after the backend answered -- with no await in
 * between (`changeSheetsAndFollow` guarantees that): a sheet-list reload the
 * wrapper's own announcement started could otherwise land first, move the
 * context alone, and make the switch look already made.
 *
 * `focus`: `{ keepFocus: true }` leaves the keyboard focus where it is when
 * the switch lands (the command line), instead of giving it to the grid.
 *
 * Nothing here talks to the backend: the switch is ALREADY made (an
 * `activateSheet` would switch again). To make a sheet active, call
 * `activateSheet`.
 */
export async function announceSheetsChanged(
  result: FollowableSheetsResult,
  renumbering?: SheetsRenumbering,
  focus?: SheetFocusOptions,
): Promise<void> {
  // FIRST, before any await (see above).
  const shown = getGridStateSnapshot()?.sheetContext ?? null;
  const active = result.sheets.find((s) => s.index === result.activeIndex) ?? result.sheets[0];
  // Loaded on use, as the script host always loaded them: `./grid` reaches
  // most of Core, and a module that only imports this seam must not pay for it.
  const gridApi = await import("./grid");
  // The surface rides the same dispatch as the context (a canvas never tears),
  // and so does the sheet's STABLE id when the list carries one: an open
  // edit follows its sheet by it (a dispatch without one clears it).
  const dispatchContext = (): void => {
    if (!active) return;
    const surface = active.kind === "canvas" ? "canvas" : "grid";
    dispatchGridAction(
      typeof active.sheetId === "string" && active.sheetId !== ""
        ? gridApi.setActiveSheet(active.index, active.name, surface, active.sheetId)
        : gridApi.setActiveSheet(active.index, active.name, surface),
    );
  };
  // The backstop (see above): the same sheet, renumbered untold.
  const renumberedOnly = shown !== null && active !== undefined && sameSheetRenumbered(shown, active, renumbering);
  // No grid state (nothing mounted): nothing shows a sheet, so nothing switches.
  if (shown !== null && active && !renumberedOnly && activeSheetMoved(shown, active, renumbering)) {
    window.dispatchEvent(
      new CustomEvent("sheet:beforeSwitch", {
        detail: { oldSheetIndex: shown.activeSheetIndex, newSheetIndex: active.index },
      }),
    );
    // After the save above (it is keyed by the OLD index) and before the
    // restore below (keyed by the new numbering).
    announceRenumbering(renumbering);
    await primeSheetSwitch(active.index);
    // No await from here on: the context, the grid's refetch and the tab strip
    // move in one flush (BUG-0052).
    dispatchContext();
    window.dispatchEvent(
      new CustomEvent("sheet:normalSwitch", {
        detail: normalSwitchDetail(active.index, active.name, focus),
      }),
    );
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: active.index, sheetName: active.name });
    return;
  }

  // The backstop: the sheet's memory follows it, as one rotate from where Core
  // shows it to where it now stands (the only renumbering this side can see).
  announceRenumbering(
    renumberedOnly && shown !== null && active
      ? { moved: { fromIndex: shown.activeSheetIndex, toIndex: active.index } }
      : renumbering,
  );
  dispatchContext();
  emitAppEvent(AppEvents.SHEET_CHANGED, {
    sheetIndex: active?.index ?? result.activeIndex,
    sheetName: active?.name ?? "",
  });
  gridApi.refreshGridDimensions();
  gridApi.refreshGridData();
}

/**
 * Make a sheet-list change in the backend and FOLLOW its answer: `change` runs
 * one wrapper (`addSheet`, `deleteSheet`, `hideSheet`, ...), and its answer
 * goes straight to `announceSheetsChanged` with nothing awaited in between, so
 * the grid shows the sheet the backend made active. A change that throws
 * (a refused delete, the last visible sheet) announces nothing and rethrows.
 * `renumbering`: what the change did to the indices (a delete's index, an
 * add's or a copy's landing index, a move's two ends) -- or a function that
 * reads it from the change's own ANSWER, for a change whose landing index only
 * the backend knows (an add lands at the end of the user sheets, before any
 * object sheet: `(r) => ({ insertedIndex: r.activeIndex })`). `focus`: as for
 * `announceSheetsChanged`.
 */
export async function changeSheetsAndFollow<R extends FollowableSheetsResult>(
  change: () => Promise<R>,
  renumbering?: SheetsRenumbering | ((result: R) => SheetsRenumbering | undefined),
  focus?: SheetFocusOptions,
): Promise<R> {
  const result = await change();
  const told = typeof renumbering === "function" ? renumbering(result) : renumbering;
  await announceSheetsChanged(result, told, focus);
  return result;
}
