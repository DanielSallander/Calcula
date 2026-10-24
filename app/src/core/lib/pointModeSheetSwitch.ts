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
//          widths. It only hands this module every sheet context it renders
//          (`followShownSheetForExternalSession`), so a live session follows
//          the sheets by identity when a door it never heard of moves the grid.

import { getSheets, setActiveSheet as setActiveSheetApi, type SheetInfo, type SheetsResult } from "./tauri-api";
import { setActiveSheet, type GridAction } from "../state/gridActions";
// The grid's own sheet context: an un-parked session's host IS the sheet the
// grid shows, which is how the host's NAME is learned (pointModeView.ts reads
// the same snapshot).
import { getGridStateSnapshot } from "../state/GridContext";
// Precedent for this Core -> api/gridDispatch reach: GridContext.tsx and
// overlayTextEditor.ts. It is the module-level dispatch bridge, not a facade.
import { dispatchGridAction } from "../../api/gridDispatch";
// The same leaf module Core's own editor reads the preference from
// (useSpreadsheetEditing.ts): localStorage getters, no further imports.
import { getMoveAfterReturn, getMoveDirection } from "../../api/editingPreferences";
import {
  getExternalEditSession,
  getExternalSessionHostIndex,
  getExternalSessionHostName,
  getExternalSessionHostSheetId,
  isExternalSessionHostSheet,
  isExternalSessionParked,
  noteExternalSessionHost,
  sameSheetName,
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
 *     already reads it. "Is this the host" is decided by the host's IDENTITY
 *     -- its stable id, else its name (learned from the grid on the first trip
 *     away, re-found in every result) -- never by the index the session
 *     opened with: the sheets are renumbered, and renamed, under an open edit
 *  4. dispatch(setActiveSheet(...)), with the sheet's stable id
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
  options: { refreshDimensions?: boolean } = {},
): Promise<SheetsResult> {
  learnHostFromShownSheet();
  const result = await setActiveSheetApi(index);
  const sheet = result.sheets.find((s) => s.index === result.activeIndex);
  const name = sheet?.name ?? "";
  const surface = sheet ? (sheet.kind === "canvas" ? "canvas" : "grid") : undefined;

  const live = getExternalEditSession() !== null;
  if (live) {
    // Parked or not is decided by the host's IDENTITY (formulaEditTarget
    // `setExternalSessionParked`), with its index re-found in this fresh list.
    followHostIn(result.sheets);
    setExternalSessionParked(result.activeIndex, name, sheet?.sheetId);
  }

  dispatch(setActiveSheet(result.activeIndex, name, surface, sheet?.sheetId));

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("sheet:formulaModeSwitch", {
        detail: { newSheetIndex: result.activeIndex, newSheetName: name },
      }),
    );
    if (live || options.refreshDimensions === true) {
      window.dispatchEvent(new CustomEvent("dimensions:refresh"));
    }
  }
  return result;
}

// ----------------------------------------------------------------------------
// The live session's HOST, by identity (reviews TSHELL4-DISCARD-LANDS-UNDER-OPEN-EDIT,
// F1-rename-refuses-entry)
// ----------------------------------------------------------------------------
// The owner's `hostSheetIndex` is the host's index when the edit OPENED. A
// temporary sheet's discard, a delete, a move or a copy -- the strip's, an MCP
// tool's or a script's -- renumbers the sheets while the edit is open: a trip
// to the sheet that slid into that index then UN-parked the edit on a foreign
// sheet, and Enter "returned" to it. So the host is followed by IDENTITY: its
// stable id -- the owner's own (`session.hostSheetId`), else the one the grid's
// context carried -- so a rename of the host is followed too, else its name.
// The VIEWED sheet of a parked edit is followed the same way (review
// FR-RESYNC-COMMITS-ON-RENUMBER): it is renumbered by the same operations.

/**
 * Learn the live session's host NAME on its first trip away: an un-parked
 * session's host is the sheet the grid shows, so Core's own sheet context names
 * it (and holds its index, and its stable id, now). Only while the name is
 * unknown -- after that the fresh list of every switch keeps it
 * (`followHostIn`): the context can lag a dispatch until the next
 * render, and right after a return to the host it may still name the sheet
 * just left. A host its owner named by id is never re-learned as another
 * sheet: a context naming another id is ignored (`noteExternalSessionHost`).
 */
function learnHostFromShownSheet(): void {
  if (getExternalEditSession() === null || isExternalSessionParked()) return;
  if (getExternalSessionHostName() !== null) return;
  const shown = getGridStateSnapshot()?.sheetContext;
  if (!shown || !shown.activeSheetName) return;
  noteExternalSessionHost(shown.activeSheetIndex, shown.activeSheetName, shown.activeSheetId);
}

/** The live session's host identity as Core knows it NOW (captured before an await: an owner's teardown clears it). */
interface HostIdentity {
  name: string | null;
  sheetId: string | null;
}

function hostIdentityNow(): HostIdentity {
  return { name: getExternalSessionHostName(), sheetId: getExternalSessionHostSheetId() };
}

/**
 * The sheet `identity` names in `sheets`: by its stable id when it has one and
 * the list carries ids, else by its name. Null when the list has no such sheet
 * (deleted -- or, for a sheet known only by name, renamed -- under the edit);
 * UNDEFINED when nothing in `identity` can be compared in this list (an
 * id-only identity and a list without ids, or no identity at all), which is a
 * "cannot tell", never a "gone".
 */
function sheetIn(sheets: readonly SheetInfo[], identity: HostIdentity): SheetInfo | null | undefined {
  if (identity.sheetId !== null && sheets.some((s) => typeof s.sheetId === "string" && s.sheetId !== "")) {
    return sheets.find((s) => s.sheetId === identity.sheetId) ?? null;
  }
  const { name } = identity;
  if (name === null) return undefined;
  return sheets.find((s) => sameSheetName(s.name, name)) ?? null;
}

/**
 * Re-find the live session's HOST by identity in a fresh sheet list: its index
 * -- and name -- NOW. A host in no list keeps its last index (and stays
 * not-the-view). The VIEWED sheet needs no re-finding here: the switch that
 * reads this list parks on the sheet it lands on; between switches the view is
 * followed through the sheet the grid is moved to
 * (`followShownSheetForExternalSession`).
 */
function followHostIn(sheets: readonly SheetInfo[]): void {
  const found = sheetIn(sheets, hostIdentityNow());
  if (found) noteExternalSessionHost(found.index, found.name, found.sheetId);
}

/**
 * The host's TRUE index NOW, for a return to it: found by `identity` -- its
 * stable id, else its name -- in a fresh list (null when no sheet is it any
 * more: deleted, or for a host known only by name, renamed under the edit).
 * The index the session holds when Core knows nothing to look it up by (no id
 * from the owner, no trip away yet: the old rule, and no extra read) or when
 * the answer cannot be checked (no list, or an id-only identity against a list
 * without ids).
 */
async function hostIndexNow(identity: HostIdentity, knownIndex: number): Promise<number | null> {
  if (identity.name === null && identity.sheetId === null) return knownIndex;
  const answer = await getSheets();
  if (!answer || !Array.isArray(answer.sheets)) return knownIndex;
  const found = sheetIn(answer.sheets, identity);
  if (found === undefined) return knownIndex;
  return found?.index ?? null;
}

/** The sheet the grid shows, as Core's sheet context names it. */
export interface ShownSheetContext {
  activeSheetIndex: number;
  activeSheetName?: string;
  activeSheetId?: string;
}

/**
 * The grid now SHOWS `shown` -- its sheet context as rendered -- moved there by
 * a door the live session never heard of: a temporary sheet's discard, a
 * script's or an MCP tool's delete, move, copy or rename (each renumbers or
 * renames the sheets under the edit), or a script's activateSheet. Core keeps
 * following the session's sheets BY IDENTITY (review
 * FR-RESYNC-COMMITS-ON-RENUMBER); useEditing.ts calls this after every render
 * that changed the context:
 *
 *  - PARKED: the parked state is "the grid shows a sheet that is not the
 *    host", so it is re-decided for the shown sheet -- by identity
 *    (`setExternalSessionParked`): the host again -> un-parked (the owner
 *    re-shows its in-place view); the viewed sheet renumbered -> the view at
 *    its index NOW; another sheet -> the view re-pointed there. A parked edit
 *    is a formula picking a reference: it survives the move, and it is never
 *    ended from here (its owner must never commit it while parked).
 *  - NOT PARKED: an un-parked session's host IS the sheet the grid shows, so a
 *    shown sheet that is the host by identity is followed -- its index and
 *    name NOW (the eager half of learning the host). A shown sheet that is NOT
 *    the host is left alone: that is a switch away the OWNER decides about (a
 *    floating grid commits its edit), and it is never parked from here.
 *
 * Idempotent: the render after a point-mode switch shows exactly what the
 * switch already decided, and several hook instances may call it per render.
 * A context that names neither a sheet name nor an id says nothing about
 * identity, and changes nothing.
 */
export function followShownSheetForExternalSession(shown: ShownSheetContext): void {
  if (getExternalEditSession() === null) return;
  const name = shown.activeSheetName ?? "";
  const sheetId = shown.activeSheetId !== undefined && shown.activeSheetId !== "" ? shown.activeSheetId : undefined;
  if (name === "" && sheetId === undefined) return;
  if (isExternalSessionParked()) {
    setExternalSessionParked(shown.activeSheetIndex, name, sheetId);
    return;
  }
  if (name !== "" && isExternalSessionHostSheet({ index: shown.activeSheetIndex, name, sheetId })) {
    noteExternalSessionHost(shown.activeSheetIndex, name, sheetId);
  }
}

/**
 * Return the grid from a PARKED session's viewed sheet to its HOST -- the
 * switch, the refetch and the dimension refresh a live session's return gets
 * -- whether or not the session survives until the switch lands. Resolves
 * false when nothing is parked (nothing to return from).
 *
 * For an owner going away while its edit is parked (E6: the FloatingRange
 * extension deactivated mid-pick). Its teardown unregisters the session, and
 * unregistering clears `parked` WITHOUT a return: the grid stayed on the
 * viewed sheet with nothing parked, so every family's published objects --
 * still the HOST's -- painted over it, on the viewed sheet's column widths,
 * until the next genuine switch. Call it BEFORE the teardown: the host is
 * captured synchronously, and the refresh no longer depends on the session
 * being live when the backend answers.
 */
export async function returnParkedViewToHost(dispatch: GridDispatch = dispatchGridAction): Promise<boolean> {
  const session = getExternalEditSession();
  if (!session || !isExternalSessionParked()) return false;
  // Captured NOW: the owner's teardown runs right after this call returns.
  const identity = hostIdentityNow();
  const hostIndex = getExternalSessionHostIndex() ?? session.hostSheetIndex;
  const target = await hostIndexNow(identity, hostIndex);
  if (target === null) {
    // The host is in no list any more: there is nothing to return to, and its
    // objects went with it. A session still live stays parked -- the grid does
    // show a sheet that is not its host.
    console.warn("[pointModeSheetSwitch] the edit's sheet is gone; there is no sheet to return to.");
    return false;
  }
  await switchSheetForPointMode(target, dispatch, { refreshDimensions: true });
  return true;
}

let ending = false;

/**
 * End the live session: switch back to its host first when parked, then
 * commit or cancel through the OWNER's own path.
 *
 * In-flight guarded (a second call while one runs returns false). The host is
 * found by IDENTITY (its stable id, else its name) at its index now
 * (`hostIndexNow`). If the host cannot be switched back to (deleted underneath
 * -- or, known only by name, renamed -- or the switch refused), the session
 * still ends: `parked` is cleared and the commit/cancel runs -- never a
 * switch to the index it opened with. Resolves what the owner's
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
        // The host by IDENTITY, at its index NOW -- never the index the
        // session opened with, which names whichever sheet slid into it.
        const target = await hostIndexNow(
          hostIdentityNow(),
          getExternalSessionHostIndex() ?? session.hostSheetIndex,
        );
        if (target === null) {
          console.warn("[pointModeSheetSwitch] the edit's sheet is gone; ending the edit where it is.");
          setExternalSessionParked(null);
        } else {
          await switchSheetForPointMode(target, dispatch);
        }
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

/**
 * The move ENTER makes when it commits an external session, from the user's
 * Move-after-Return preference (File > Options > Editing;
 * api/editingPreferences.ts) -- the rule Core's own in-cell editor follows
 * (useSpreadsheetEditing `handleInlineEnter`). Null when the preference is off
 * or its direction is "none"; Shift reverses the direction.
 *
 * Why (E4): every door that commits a floating grid's cell on Enter -- its
 * in-place editor, the formula bar, the grid container while the edit is
 * parked -- passed a hard-coded "down" / "up", so a user who had turned
 * Move-after-Return off, or pointed it right, got Excel's behaviour on the
 * sheet and a different one in every floating grid. One function, so the
 * doors cannot disagree.
 */
export function enterCommitMove(shiftKey: boolean): ExternalEditMove {
  if (!getMoveAfterReturn()) return null;
  const direction = getMoveDirection();
  if (direction === "none") return null;
  if (!shiftKey) return direction;
  switch (direction) {
    case "down":
      return "up";
    case "up":
      return "down";
    case "right":
      return "left";
    case "left":
      return "right";
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
