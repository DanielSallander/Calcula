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
//
// DRAGS ARE NOT DECIDED HERE (review RESOLVETABCLICK-DRAGGING-DEAD). A tab
// drag's click is the STRIP's to refuse, in the two early returns that open
// SheetTabs.tsx `handleSheetClick`: a FINISHED drag (`dropJustEndedRef`, the
// click the browser dispatches after the release) and a drag still ARMED (a
// keyboard-driven click on a tab while the mouse holds a drag). Both must be
// decided BEFORE the strip's group step (a "normal" switch ends the group
// unless SHEET GROUP CLICKS below keeps it, a Shift click replaces it) -- a
// drag's click resolves "normal" here and would otherwise end a group the user
// made on purpose. A `dragging` input here
// was dead: the strip had always returned already, so its rule never fired
// and its unit test could not fail. The strip-level tests own that behaviour:
// sheetTabsTemporarySheets.test.tsx, "a finished drag is not a click", "a
// drag's click never clears an existing sheet group" and "a click while a drag
// is still ARMED".

export type TabClickAction = "ignore" | "group" | "groupRange" | "prefix3d" | "pointMode" | "normal";

export interface TabClickInput {
  /** TRUE workbook index of the clicked tab. */
  index: number;
  /** TRUE workbook index of the sheet the grid shows. */
  activeIndex: number;
  targetIsCanvas: boolean;
  activeIsCanvas: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  /** Core's own editor expects a reference (render value OR isGlobalFormulaMode() at event time). */
  coreFormulaMode: boolean;
  /**
   * The live external session, or null. `targetIsSessionHost`: the CLICKED tab
   * IS the session's host -- decided by the caller at event time by the tab's
   * IDENTITY (`isExternalSessionHostSheet`), never by the owner's opening
   * `hostSheetIndex`, which a renumbering under a parked edit leaves naming
   * another sheet (review F3-strip-uses-owner-host-index).
   */
  session: { targetIsSessionHost: boolean; parked: boolean; expecting: boolean } | null;
}

/**
 * Rules, in order, for a click the strip has ALREADY told from a drag's (see
 * the header -- a drag's click never reaches this function):
 *  1. formula mode = Core's editor expects a reference, OR a live session that
 *     expects one or is PARKED (while parked, every tab click -- the one back to
 *     the host included -- is navigation, never an ordinary switch);
 *  2. Ctrl outside formula mode groups sheets, except that a canvas never joins
 *     a group from either end;
 *  2b. Shift outside formula mode selects the sheets from the active one to the
 *     clicked one (`groupRange`, {@link shiftClickGroup}), again never from or
 *     to a canvas -- on the active tab too, where the range is that sheet
 *     alone and so ends a group (Excel [LIVE], see SHEET GROUP CLICKS below);
 *  3. the active tab does nothing, except Shift in formula mode (a 3D prefix
 *     that starts and ends on this sheet);
 *  4. Shift in formula mode inserts a 3D prefix -- refused when either end is a
 *     canvas (a canvas has no cells to span; on a canvas HOST the "start" would
 *     have been the canvas itself);
 *  5. in formula mode a canvas tab is refused, EXCEPT the live session's own
 *     host (by identity: `session.targetIsSessionHost`): that is how a parked
 *     edit is brought back;
 *  6. formula mode switches without ending the edit;
 *  7. anything else is an ordinary switch.
 */
export function resolveTabClick(i: TabClickInput): TabClickAction {
  const formulaMode =
    i.coreFormulaMode || (i.session !== null && (i.session.expecting || i.session.parked));
  if (i.ctrlKey && !formulaMode) {
    return i.targetIsCanvas || i.activeIsCanvas ? "ignore" : "group";
  }
  if (i.shiftKey && !formulaMode) {
    return i.targetIsCanvas || i.activeIsCanvas ? "ignore" : "groupRange";
  }
  if (i.index === i.activeIndex && !(i.shiftKey && formulaMode)) return "ignore";
  if (formulaMode && i.shiftKey) {
    return i.activeIsCanvas || i.targetIsCanvas ? "ignore" : "prefix3d";
  }
  if (formulaMode && i.targetIsCanvas) {
    return i.session !== null && i.session.targetIsSessionHost ? "pointMode" : "ignore";
  }
  if (formulaMode) return "pointMode";
  return "normal";
}

// ============================================================================
// SHEET GROUP CLICKS -- what a tab click does to a group of selected sheets
// ============================================================================
//
// Excel 16 [LIVE, 2026-10-30, real mouse clicks on the tabs of a fresh visible
// instance, ActiveWindow.SelectedSheets read after each; clipexcel/probe-ui*.ps1
// in the fix programme's scratchpad]:
//   - a plain click on the ACTIVE tab changes nothing, the group included --
//     whether some or all sheets are grouped;
//   - a plain click on ANOTHER member of the group makes it the active sheet
//     and KEEPS the group (Sheet1+Sheet3, click Sheet3 -> Sheet1+Sheet3, Sheet3
//     active; typing then reaches both) -- UNLESS every visible tab is in the
//     group: then there is no tab outside it to click, and the click ends the
//     group (all four grouped, click Sheet3 -> Sheet3 alone; three of four with
//     the fourth hidden behave the same);
//   - a plain click on a tab OUTSIDE the group ends it and selects that sheet;
//   - Ctrl+click adds a sheet or takes a member out, never the active one, and
//     leaves the active sheet where it is (`toggleSheetInGroup`);
//   - Shift+click selects every visible sheet from the active one to the
//     clicked one, REPLACING the group, the active sheet unchanged (Sheet1 with
//     Sheet2 hidden, Shift+click Sheet3 -> Sheet1+Sheet3; Sheet2+Sheet4 grouped,
//     Sheet2 active, Shift+click Sheet1 -> Sheet1+Sheet2); Shift+click on the
//     active tab leaves that sheet alone selected.
// The strip used to end the group on EVERY plain click, the active tab and a
// member's included (BUG-0616 item 6), and took Shift+click for a plain one.

/** A tab as the group rules read it. */
export interface GroupTab {
  /** TRUE workbook index. */
  index: number;
  /** Hidden and very hidden sheets have no tab: never selected, never counted. */
  visible: boolean;
  /** A canvas never joins a group. */
  isCanvas: boolean;
}

/**
 * Whether a PLAIN click on tab `index` (not the active one: that click does
 * nothing) keeps the sheet group `group` -- see SHEET GROUP CLICKS. True only
 * for a member of a group that leaves some visible tab out.
 */
export function plainClickKeepsGroup(group: readonly number[], index: number, tabs: readonly GroupTab[]): boolean {
  if (group.length < 2 || !group.includes(index)) return false;
  const visible = tabs.filter((t) => t.visible);
  return visible.some((t) => !group.includes(t.index));
}

/**
 * The group a Shift+click on tab `index` selects: every visible WORKSHEET from
 * the active sheet to the clicked one, both included, in index order -- the
 * active sheet alone when the two are the same (see SHEET GROUP CLICKS). A
 * canvas between the two is passed over, as a hidden sheet is: a canvas never
 * joins a group (the clicked or active one being a canvas is refused before
 * this, `resolveTabClick`).
 */
export function shiftClickGroup(activeIndex: number, index: number, tabs: readonly GroupTab[]): number[] {
  const lo = Math.min(activeIndex, index);
  const hi = Math.max(activeIndex, index);
  const range = tabs
    .filter((t) => t.index >= lo && t.index <= hi && t.visible && !t.isCanvas)
    .map((t) => t.index);
  if (!range.includes(activeIndex)) range.push(activeIndex);
  return range.sort((a, b) => a - b);
}
