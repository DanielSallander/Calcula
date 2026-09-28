//! FILENAME: app/src/core/lib/pointModeSheetSwitch.ts
// PURPOSE: The ONE point-mode sheet switch, and ending an external edit
//          session (switching back to its host sheet first).
// CONTEXT: While a formula expects a reference, a sheet-tab click switches the
//          VIEWED sheet without ending the edit: no SHEET_CHANGED, no reload.
//          The grid's own editor has always done that (SheetTabs' formula-mode
//          branch, useEditing's return-to-source); an external session (a
//          floating grid's cell edit) now does it through here, so its
//          `parked` state, the dispatch, the refetch and the return are one
//          sequence in one place.
//
//          `useEditing.ts`'s own return path is deliberately NOT routed here:
//          it is the densest code in the app, and moving a dimension refresh
//          into Core's commit could run `moveActiveCell` on the other sheet's
//          widths.

import { setActiveSheet as setActiveSheetApi, type SheetsResult } from "./tauri-api";
import { setActiveSheet, type GridAction } from "../state/gridActions";
// Precedent for this Core -> api/gridDispatch reach: GridContext.tsx and
// overlayTextEditor.ts. It is the module-level dispatch bridge, not a facade.
import { dispatchGridAction } from "../../api/gridDispatch";
import {
  getExternalEditSession,
  isExternalSessionParked,
  setExternalSessionParked,
  type ExternalEditMove,
} from "./formulaEditTarget";

export type GridDispatch = (action: GridAction) => void;

/**
 * Switch the VIEWED sheet without ending any edit. Order is normative:
 *  1. result = await setActiveSheetApi(index)
 *  2. the sheet by its index FIELD (never list position); name and surface
 *     from the RESULT (surface omitted when the sheet is not listed: the
 *     reducer then resolves it from `sheetSurfaces`)
 *  3. if a session is live: park BEFORE the dispatch, so the render the
 *     dispatch causes (paint, and every hit test until the next render)
 *     already reads it
 *  4. dispatch(setActiveSheet(...))
 *  5. window "sheet:formulaModeSwitch" (GridCanvas refetches)
 *  6. ONLY when a session is live: window "dimensions:refresh". Session-only
 *     ON PURPOSE: useEditing's own return path does not refresh dimensions,
 *     so refreshing on the Core edit's way OUT would leave the source sheet on
 *     the target's widths after the return. The session's return goes through
 *     this helper, so it gets both directions.
 * Returns the SheetsResult (SheetTabs keeps its list/index from it).
 */
export async function switchSheetForPointMode(
  index: number,
  dispatch: GridDispatch = dispatchGridAction,
): Promise<SheetsResult> {
  const result = await setActiveSheetApi(index);
  const sheet = result.sheets.find((s) => s.index === result.activeIndex);
  const name = sheet?.name ?? "";
  const surface = sheet ? (sheet.kind === "canvas" ? "canvas" : "grid") : undefined;

  const live = getExternalEditSession() !== null;
  if (live) setExternalSessionParked(result.activeIndex);

  dispatch(setActiveSheet(result.activeIndex, name, surface));

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("sheet:formulaModeSwitch", {
        detail: { newSheetIndex: result.activeIndex, newSheetName: name },
      }),
    );
    if (live) window.dispatchEvent(new CustomEvent("dimensions:refresh"));
  }
  return result;
}

let ending = false;

/**
 * End the live session: switch back to its host first when parked, then
 * commit or cancel through the OWNER's own path.
 *
 * In-flight guarded (a second call while one runs returns false). If the host
 * cannot be switched back to (deleted underneath), the session still ends:
 * `parked` is cleared and the commit/cancel runs. Resolves what the owner's
 * commit resolves (false = refused), true for a cancel, false when there was
 * no session (or it went away during the switch).
 */
export async function endExternalFormulaSession(
  kind: "commit" | "cancel",
  move: ExternalEditMove = null,
  dispatch: GridDispatch = dispatchGridAction,
): Promise<boolean> {
  if (ending) return false;
  const session = getExternalEditSession();
  if (!session) return false;
  ending = true;
  try {
    if (isExternalSessionParked()) {
      try {
        await switchSheetForPointMode(session.hostSheetIndex, dispatch);
      } catch (err) {
        console.error("[pointModeSheetSwitch] could not return to the edit's sheet:", err);
        setExternalSessionParked(null);
      }
    }
    if (getExternalEditSession() !== session) return false;
    if (kind === "commit") return await session.commit(move);
    session.cancel();
    return true;
  } finally {
    ending = false;
  }
}

/** Focus the formula bar and place the caret (clamped). false when there is no bar. */
export function focusFormulaBar(caret: number | null): boolean {
  if (typeof document === "undefined") return false;
  const bar = document.querySelector('[data-formula-bar="true"]') as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;
  if (!bar) return false;
  bar.focus();
  const length = bar.value.length;
  const position = Math.max(0, Math.min(caret ?? length, length));
  try {
    bar.setSelectionRange(position, position);
  } catch {
    // An element type without a selection API: focus alone is the answer.
  }
  return true;
}

/**
 * The grid's keyboard container -- the element whose React key handler is the
 * FALLBACK door for a live session (useSpreadsheetEditing's
 * handleContainerKeyDown). Not the canvas: it has no tabIndex, so focusing it
 * would drop the keyboard on the body.
 */
function focusGridKeyboardContainer(): boolean {
  if (typeof document === "undefined") return false;
  const container = document.querySelector('[data-focus-container="spreadsheet"]') as HTMLElement | null;
  if (!container) return false;
  container.focus();
  return true;
}

/**
 * The ONE focus decision after a point-mode switch while a session is live:
 * parked -> the formula bar (at the session's caret); on the host -> the
 * owner's in-place view. Never both.
 *
 * PARKED WITH NO FORMULA BAR (View > Formula Bar off): the owner's in-place
 * view is hidden while parked, so without a fallback nothing held the keyboard
 * -- Enter, Tab and Escape could not end the edit and typed characters were
 * dropped. The grid's keyboard container takes it instead, and its fallback
 * door routes every key to the session (Enter/Tab commit with the return to
 * the host, Escape cancels, a printable key goes into the formula) -- the same
 * as Core's own point mode with the bar hidden: the keyboard works, the text is
 * not visible.
 */
export function focusExternalSessionView(): void {
  const session = getExternalEditSession();
  if (!session) return;
  if (isExternalSessionParked()) {
    if (!focusFormulaBar(session.getCursor())) focusGridKeyboardContainer();
  } else {
    session.focusCellView();
  }
}
