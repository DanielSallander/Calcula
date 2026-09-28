//! FILENAME: app/src/shell/SheetTabs/resolveTabClick.ts
// PURPOSE: What a sheet-tab click MEANS, decided in one pure function.
// CONTEXT: The tab strip used to decide "is this a formula point-mode switch"
//          by looking only at the grid's OWN cell editor. A floating grid's cell
//          edit (an external session, core/lib/formulaEditTarget.ts) was
//          invisible to that check, so typing "=" in a floating grid and clicking
//          the Sheet1 tab took the ORDINARY switch -- which committed the bare "="
//          on blur and cancelled the edit on SHEET_CHANGED, whichever won. And
//          the one tab that could have brought the edit back (its host, usually a
//          canvas) was refused outright, because a canvas can never be a
//          reference target.
//
//          Extracted so every rule below is unit-tested without mounting the
//          strip (shell/SheetTabs/__tests__/resolveTabClick.test.ts).

export type TabClickAction = "ignore" | "group" | "prefix3d" | "pointMode" | "normal";

export interface TabClickInput {
  /** TRUE workbook index of the clicked tab. */
  index: number;
  /** TRUE workbook index of the sheet the grid shows. */
  activeIndex: number;
  targetIsCanvas: boolean;
  activeIsCanvas: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  /** A tab drag just finished (the click is its mouseup). */
  dragging: boolean;
  /** Core's own editor expects a reference (render value OR isGlobalFormulaMode() at event time). */
  coreFormulaMode: boolean;
  /** The live external session, or null. */
  session: { hostSheetIndex: number; parked: boolean; expecting: boolean } | null;
}

/**
 * Rules, in order:
 *  1. a finished drag is not a click;
 *  2. formula mode = Core's editor expects a reference, OR a live session that
 *     expects one or is PARKED (while parked, every tab click -- the one back to
 *     the host included -- is navigation, never an ordinary switch);
 *  3. Ctrl outside formula mode groups sheets, except that a canvas never joins
 *     a group from either end;
 *  4. the active tab does nothing, except Shift in formula mode (a 3D prefix
 *     that starts and ends on this sheet);
 *  5. Shift in formula mode inserts a 3D prefix -- refused when either end is a
 *     canvas (a canvas has no cells to span; on a canvas HOST the "start" would
 *     have been the canvas itself);
 *  6. in formula mode a canvas tab is refused, EXCEPT the live session's own
 *     host: that is how a parked edit is brought back;
 *  7. formula mode switches without ending the edit;
 *  8. anything else is an ordinary switch.
 */
export function resolveTabClick(i: TabClickInput): TabClickAction {
  if (i.dragging) return "ignore";
  const formulaMode =
    i.coreFormulaMode || (i.session !== null && (i.session.expecting || i.session.parked));
  if (i.ctrlKey && !formulaMode) {
    return i.targetIsCanvas || i.activeIsCanvas ? "ignore" : "group";
  }
  if (i.index === i.activeIndex && !(i.shiftKey && formulaMode)) return "ignore";
  if (formulaMode && i.shiftKey) {
    return i.activeIsCanvas || i.targetIsCanvas ? "ignore" : "prefix3d";
  }
  if (formulaMode && i.targetIsCanvas) {
    return i.session !== null && i.index === i.session.hostSheetIndex ? "pointMode" : "ignore";
  }
  if (formulaMode) return "pointMode";
  return "normal";
}
