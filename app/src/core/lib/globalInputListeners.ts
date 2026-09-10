//! FILENAME: app/src/core/lib/globalInputListeners.ts
// PURPOSE: The CENSUS that goes with the pointer-claim rule: every listener in
//          this app that binds a key or pointer event on `window` or `document`,
//          and what each one does about a claim.
//
// WHY IT EXISTS
//   `pointerClaims.ts` next door states the rule, and Core honours it at three
//   doors — mousedown, double-click, and both key handlers. Twice now that was
//   believed to be the whole story, and twice a fourth door turned up in a layer
//   nobody had enumerated. The last one was `api/keybindings.ts`: a CAPTURE-phase
//   `window` keydown, which is the OUTERMOST position in the document. It ran
//   before every Core door and called preventDefault()+stopPropagation(), so
//   Core's careful guards were never consulted at all. Measured, with a card
//   carrying `data-pointer-claim` inside `[data-focus-container="spreadsheet"]`:
//   Delete with a `<select>` focused executed `core.edit.clearContents` — the
//   user's selected CELLS were cleared — and Ctrl+V inside a claimed plain
//   `<input>` executed `core.clipboard.paste` AND cancelled the native paste into
//   the field, so even the one widget type Core's tag list certifies as working
//   was broken.
//
//   A door nobody has listed is a door nobody has checked. So the list is here,
//   it is complete by construction, and `globalInputListeners.test.ts` fails the
//   build when a listener exists that is not in it.
//
// >>> ADDING A `window.` OR `document.` LISTENER FOR A KEY OR POINTER EVENT?  <<<
// >>> ADD A ROW HERE IN THE SAME COMMIT. The drift test will make you.        <<<
//
// HOW TO PICK A VERDICT
//   Ask ONE question first: does this listener ACT — change document or grid
//   state, run a command, or call preventDefault — or does it merely OBSERVE?
//   An observer needs no guard. An actor needs one of the four other verdicts,
//   and "session-scoped" is a claim about LIFETIME that has to be true.
//
//   claim-guarded      Acts on the grid or the document from a gesture that
//                      could land inside a claimed surface. Consults
//                      `isKeyClaimed` / `isPointerClaimed` (or, for the
//                      dispatcher, folds the claim into the questions it already
//                      asks). ENFORCED: the test requires the file to reference
//                      one of those predicates.
//   app-global         Acts, and deliberately does NOT consult the claim,
//                      because the user wants it to work from inside a form too.
//                      Ctrl+S is the archetype: a blanket "a claim swallows every
//                      shortcut" would break Save. Keep this list short and
//                      keep every entry's reason in its note.
//   right-press-exempt Acts on the SECONDARY button, which `isPointerClaimed`
//                      never claims by design — an object's own context menu has
//                      to keep opening, or a claimant could trap the user inside
//                      its own rectangle with no way out. See `isPointerClaimed`.
//   session-scoped     Acts, but is registered only for the life of a gesture or
//                      a surface this same code began: the mousemove/mouseup of a
//                      drag whose mousedown was already filtered, or the
//                      Escape/click-outside of a popup it opened, which it uses
//                      only to close that popup. The lifetime IS the guard.
//   observes           Reads only. No state change, no command, no
//                      preventDefault.
//
// SCOPE
//   `window.addEventListener` / `document.addEventListener` for: keydown, keyup,
//   keypress, mousedown, mouseup, mousemove, click, dblclick, auxclick,
//   contextmenu, wheel, pointer*, touch*, dragover, dragstart, drop, paste, copy,
//   cut. Element-level listeners and React props are NOT in scope — they cannot
//   pre-empt a door they do not sit above. One row per FILE + EVENT (line numbers
//   churn; a file that binds the same event from two handlers gets one row whose
//   note says so).

/** What a listener does about a pointer claim. See "HOW TO PICK A VERDICT". */
export type GlobalListenerVerdict =
  | "claim-guarded"
  | "app-global"
  | "right-press-exempt"
  | "session-scoped"
  | "observes";

export interface GlobalInputListener {
  /** Path relative to `app/`. */
  file: string;
  /** The DOM event type bound. */
  event: string;
  verdict: GlobalListenerVerdict;
  /** What it does, and why that verdict. */
  note: string;
}

/** The predicates a `claim-guarded` row must reference. */
export const CLAIM_PREDICATES = ["isKeyClaimed", "isPointerClaimed", "findPointerClaim"] as const;

export const GLOBAL_INPUT_LISTENERS: readonly GlobalInputListener[] = [
  { file: "extensions/_shared/cli/components/CliPanel.tsx", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "extensions/_shared/cli/components/CliPanel.tsx", event: "mouseup", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live." },
  { file: "extensions/_shared/components/AggregationMenu.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/_shared/components/AggregationMenu.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/_shared/components/DropZone.tsx", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "extensions/_shared/components/FieldPillMenu.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/_shared/components/FieldPillMenu.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/_shared/components/FilterDropdown.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/_shared/components/FilterDropdown.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/_shared/components/TableFieldList.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/_shared/components/TableFieldList.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/_shared/components/useDragDrop.ts", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "extensions/_shared/components/useDragDrop.ts", event: "mouseup", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live." },
  { file: "extensions/_shared/components/ValueFieldContextMenu.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/_shared/components/ValueFieldContextMenu.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/_standard/conditional-formatting/components/ColorPicker.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/AutoFilter/components/FilterDropdownOverlay.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/AutoFilter/components/FilterDropdownOverlay.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/AutoFilter/index.ts", event: "keydown", verdict: "claim-guarded",
    note: "Ctrl+Shift+L toggles the filter — a document mutation." },
  { file: "extensions/BuiltIn/CellBookmarks/index.ts", event: "keydown", verdict: "claim-guarded",
    note: "Ctrl+[ / Ctrl+] move the grid selection; Ctrl+Shift+V opens the save-view overlay and must stay native inside a field." },
  { file: "extensions/BuiltIn/FormatCellsDialog/components/ColorPicker.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/BuiltIn/FormatPainter/formatPainterLogic.ts", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "extensions/BuiltIn/FormatPainter/formatPainterLogic.ts", event: "mouseup", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live." },
  { file: "extensions/BuiltIn/FormatPainter/index.ts", event: "keydown", verdict: "app-global",
    note: "Ctrl+Shift+C activates the painter; Escape deactivates it and only acts when it is already active — a mode the user entered on purpose and must be able to leave from anywhere." },
  { file: "extensions/BuiltIn/FormulaAutocomplete/FormulaAutocompleteOverlay.tsx", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "extensions/BuiltIn/FormulaAutocomplete/FormulaAutocompleteOverlay.tsx", event: "mouseup", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live." },
  { file: "extensions/BuiltIn/HomeTab/components/HomeTabCustomizeDialog.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/BuiltIn/StatusBarAggregation/AggregationContextMenu.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/BuiltIn/StatusBarAggregation/AggregationContextMenu.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/BuiltIn/ZoomSlider/ZoomPresetMenu.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/BuiltIn/ZoomSlider/ZoomPresetMenu.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/CalculationOptions/components/CalculationStatusItem.tsx", event: "keydown", verdict: "app-global",
    note: "Escape / Ctrl+Break cancels a RUNNING recalculation; installed only while one is in flight. Cancelling from inside a form is the point." },
  { file: "extensions/Charts/components/AxisContextMenu.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/Charts/components/AxisContextMenu.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/Charts/components/ChartContextMenu.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/Charts/components/ChartContextMenu.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/Charts/components/ChartFilterDropdown.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/Charts/components/ChartFilterDropdown.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/Charts/components/ChartSpecEditorApp.tsx", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "extensions/Charts/components/ChartSpecEditorApp.tsx", event: "mouseup", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live." },
  { file: "extensions/Charts/components/QuickAccessPopup.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/Charts/components/QuickAccessPopup.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/Charts/components/tabs/SpecTab.tsx", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "extensions/Charts/components/tabs/SpecTab.tsx", event: "mouseup", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live." },
  { file: "extensions/Charts/index.ts", event: "contextmenu", verdict: "right-press-exempt",
    note: "Opens the chart's own menu. `isPointerClaimed` deliberately never claims SECONDARY_MOUSE_BUTTON so an object's context menu still opens; guarding this would be the trap the exemption exists to prevent." },
  { file: "extensions/Charts/index.ts", event: "keydown", verdict: "claim-guarded",
    note: "Delete/Backspace deletes the selected chart. Had only the INPUT/TEXTAREA/contenteditable tag list." },
  { file: "extensions/Charts/index.ts", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "extensions/Charts/index.ts", event: "mouseup", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live." },
  { file: "extensions/Checkbox/index.ts", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "extensions/Consolidate/components/ConsolidateDialog.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/Controls/components/ControlContextMenu.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/Controls/components/ControlContextMenu.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/Controls/index.ts", event: "keydown", verdict: "claim-guarded",
    note: "Two handlers: Delete removes the selected floating controls, and Ctrl+C/V/D/G copy, paste, duplicate and group them. Both had only the tag list." },
  { file: "extensions/Controls/index.ts", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "extensions/Controls/lib/controlObjectMenu.ts", event: "contextmenu", verdict: "right-press-exempt",
    note: "The M3a control object menu. Same exemption." },
  { file: "extensions/ControlsPane/components/AddItemMenu.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/ControlsPane/components/AddItemMenu.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/ControlsPane/components/ControlCard.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/ControlsPane/components/ControlCard.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/ControlsPane/components/DropdownControl.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/ControlsPane/components/DropdownControl.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/ControlsPane/components/FilterDropdown.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/ControlsPane/components/FilterDropdown.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/CustomFillLists/components/CustomFillListsDialog.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/DataForm/components/DataFormDialog.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/DataTables/components/DataTableDialog.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/DataValidation/components/ListDropdownOverlay.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/DataValidation/handlers/keyboardHandler.ts", event: "keydown", verdict: "claim-guarded",
    note: "Alt+Down opens the ACTIVE CELL's in-cell list — a grid gesture aimed at a cell the user is not looking at." },
  { file: "extensions/DefinedNames/components/NameManagerDialog.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/DefinedNames/components/NameManagerDialog.tsx", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "extensions/DefinedNames/components/NameManagerDialog.tsx", event: "mouseup", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live." },
  { file: "extensions/DefinedNames/components/NewFunctionDialog.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/DefinedNames/components/NewNameDialog.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/EvaluateFormula/components/EvaluateFormulaDialog.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/ExtensionsManager/index.ts", event: "keydown", verdict: "app-global",
    note: "Ctrl+Shift+X toggles the Extensions panel." },
  { file: "extensions/FileExplorer/FileExplorerView.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/FileExplorer/FileExplorerView.tsx", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "extensions/FileExplorer/FileExplorerView.tsx", event: "mouseup", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live." },
  { file: "extensions/FileExplorer/index.ts", event: "keydown", verdict: "app-global",
    note: "Ctrl+Shift+E toggles the File Explorer panel." },
  { file: "extensions/FlashFill/index.ts", event: "keydown", verdict: "claim-guarded",
    note: "Ctrl+E writes cells." },
  { file: "extensions/FloatingRange/components/FloatingRangeContextMenu.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/FloatingRange/components/FloatingRangeContextMenu.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/FloatingRange/index.ts", event: "contextmenu", verdict: "right-press-exempt",
    note: "The Floating Range menu. Same exemption." },
  { file: "extensions/FloatingRange/index.ts", event: "keydown", verdict: "claim-guarded",
    note: "Arrows move the floating range's local selection, Delete clears its cells or deletes the object, a printable key opens its editor." },
  { file: "extensions/FloatingRange/index.ts", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "extensions/FloatingRange/index.ts", event: "mouseup", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live." },
  { file: "extensions/FormulaVisualizer/components/FormulaVisualizer.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/GoalSeek/components/GoalSeekDialog.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/Grouping/components/GroupSettingsDialog.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/Grouping/index.ts", event: "keydown", verdict: "claim-guarded",
    note: "Alt+Shift+Arrow groups/ungroups rows or columns — a document mutation, and it had no focus guard of any kind." },
  { file: "extensions/Grouping/index.ts", event: "mousedown", verdict: "claim-guarded",
    note: "Outline-bar press, hit-tested by CLIENT POINT against the canvas; +/- collapse mutates the document." },
  { file: "extensions/Hyperlinks/index.ts", event: "keydown", verdict: "claim-guarded",
    note: "Ctrl+K opens the insert/edit dialog for the ACTIVE CELL." },
  { file: "extensions/Hyperlinks/InsertHyperlinkDialog.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/MacroRecorder/components/MacroLibraryDialog.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/MacroRecorder/components/RecordedMacroDialog.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/MacroRecorder/components/StartRecordingDialog.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/MacroRecorder/index.ts", event: "keydown", verdict: "app-global",
    note: "Ctrl+Shift+R starts/stops recording. Stopping a recording from inside a form is exactly right." },
  { file: "extensions/ModelEditor/components/CliReferencePane.tsx", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "extensions/ModelEditor/components/CliReferencePane.tsx", event: "mouseup", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live." },
  { file: "extensions/ModelEditor/components/ModelEditorApp.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/ModelEditor/components/TopBarMenu.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a menu this surface itself opened; registered only while it is open." },
  { file: "extensions/ModelEditor/components/TopBarMenu.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape for a menu this surface itself opened; registered only while it is open, and it stops propagation so an outer dialog does not close with it." },
  { file: "extensions/ModelEditor/components/sections/CalcGroupsSection.tsx", event: "click", verdict: "session-scoped",
    note: "Click-outside dismissal for a menu this surface itself opened." },
  { file: "extensions/ModelEditor/components/sections/CalcGroupsSection.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/ModelEditor/components/sections/ExpressionWorkspace.tsx", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "extensions/ModelEditor/components/sections/ExpressionWorkspace.tsx", event: "mouseup", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live." },
  { file: "extensions/ModelEditor/components/sections/MeasuresSection.tsx", event: "click", verdict: "session-scoped",
    note: "Click-outside dismissal for a menu this surface itself opened." },
  { file: "extensions/ModelEditor/components/sections/MeasuresSection.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/Pivot/components/PivotHeaderFilterDropdown.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/Pivot/components/PivotHeaderFilterDropdown.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/Pivot/components/PivotTableStylesGallery.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/Pivot/components/SortDropdown.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/Pivot/components/SortDropdown.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/Pivot/index.ts", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "extensions/Print/index.ts", event: "keydown", verdict: "app-global",
    note: "Ctrl+P. The Ctrl+S class: a user typing into an on-grid form still expects Print." },
  { file: "extensions/RemoveDuplicates/components/RemoveDuplicatesDialog.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/Review/components/CommentPanelOverlay.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/Review/components/NoteEditorOverlay.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/Review/components/NoteEditorOverlay.tsx", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "extensions/Review/components/NoteEditorOverlay.tsx", event: "mouseup", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live." },
  { file: "extensions/Review/handlers/hoverHandler.ts", event: "mousemove", verdict: "observes",
    note: "Comment-indicator hover state. Never preventDefaults." },
  { file: "extensions/Review/handlers/hoverHandler.ts", event: "wheel", verdict: "observes",
    note: "Passive listener that only clears hover state." },
  { file: "extensions/Review/handlers/keyboardHandler.ts", event: "keydown", verdict: "claim-guarded",
    note: "Ctrl+Alt+M and Shift+F2 add a comment/note to the ACTIVE CELL — a document mutation." },
  { file: "extensions/ScenarioManager/components/ScenarioManagerDialog.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/ScenarioManager/components/ScenarioSummaryDialog.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/ScriptableObjects/components/CodeEditorDialog.tsx", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "extensions/ScriptableObjects/components/CodeEditorDialog.tsx", event: "mouseup", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live." },
  { file: "extensions/ScriptableObjects/components/ObjectScriptEditorApp.tsx", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "extensions/ScriptableObjects/components/ObjectScriptEditorApp.tsx", event: "mouseup", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live." },
  { file: "extensions/ScriptNotebook/index.ts", event: "keydown", verdict: "app-global",
    note: "Ctrl+Shift+N toggles the Notebook panel." },
  { file: "extensions/Search/index.ts", event: "keydown", verdict: "app-global",
    note: "Ctrl+Shift+H toggles the Search panel." },
  { file: "extensions/SelectVisibleCells/index.ts", event: "keydown", verdict: "claim-guarded",
    note: "Alt+; replaces the grid selection." },
  { file: "extensions/Slicer/components/SlicerStylesGallery.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/Slicer/handlers/slicerContextMenu.ts", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/Slicer/handlers/slicerContextMenu.ts", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/Slicer/index.ts", event: "contextmenu", verdict: "right-press-exempt",
    note: "Slicer menu. Same exemption." },
  { file: "extensions/Slicer/index.ts", event: "mousedown", verdict: "observes",
    note: "Records e.ctrlKey for the mouseup that follows. No action, no preventDefault." },
  { file: "extensions/Slicer/index.ts", event: "mouseup", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live." },
  { file: "extensions/Slicer/index.ts", event: "wheel", verdict: "claim-guarded",
    note: "Scrolls a slicer's item list, chosen by client-point hit test over the canvas; preventDefault." },
  { file: "extensions/Solver/components/SolverDialog.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/Solver/components/SolverResultDialog.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/Sorting/components/SortDialog.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/Sorting/components/SortOptionsPopup.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/Sparklines/components/CreateSparklineDialog.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/Sparklines/components/SparklineColorPicker.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/Table/components/TableStylesGallery.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/TextToColumns/components/TextToColumnsDialog.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "extensions/TimelineSlicer/handlers/timelineSlicerContextMenu.ts", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "extensions/TimelineSlicer/index.ts", event: "contextmenu", verdict: "right-press-exempt",
    note: "Timeline slicer menu. Same exemption." },
  { file: "extensions/TimelineSlicer/index.ts", event: "mousedown", verdict: "observes",
    note: "As Slicer: records the modifier." },
  { file: "extensions/TimelineSlicer/index.ts", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "extensions/TimelineSlicer/index.ts", event: "mouseup", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live." },
  { file: "extensions/TimelineSlicer/index.ts", event: "wheel", verdict: "claim-guarded",
    note: "Same as Slicer: client-point hit test, preventDefault." },
  { file: "extensions/WatchWindow/components/WatchWindowDialog.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "src/api/dialogWindow.tsx", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "src/api/dialogWindow.tsx", event: "mouseup", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live." },
  { file: "src/api/keybindings.ts", event: "keydown", verdict: "claim-guarded",
    note: "THE dispatcher. Window-CAPTURE, so it pre-empts all three Core doors. A claim makes it (a) not-grid-focused, so GRID_SCOPED_COMMANDS are refused, and (b) editing-equivalent, so context:'not-editing' is refused. Truly global bindings (Ctrl+S) still fire." },
  { file: "src/api/layout/primitives/Launcher.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "src/api/layout/primitives/Launcher.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "src/api/layout/primitives/Popover.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "src/api/layout/primitives/Popover.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "src/core/components/Scrollbar/Scrollbar.tsx", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "src/core/components/Scrollbar/Scrollbar.tsx", event: "mouseup", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live." },
  { file: "src/core/components/Spreadsheet/useSpreadsheetLayout.ts", event: "keydown", verdict: "observes",
    note: "Schedules a repaint of the status-bar mode readout on the next frame. Reads nothing, changes nothing, never preventDefaults." },
  { file: "src/core/components/Spreadsheet/useSpreadsheetSelection.ts", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "src/core/components/Spreadsheet/useSpreadsheetSelection.ts", event: "mouseup", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live." },
  { file: "src/core/hooks/useMouseSelection/useMouseSelection.ts", event: "keydown", verdict: "session-scoped",
    note: "Ctrl toggles move/copy and Escape cancels, for a SELECTION DRAG already in flight; registered only while isSelectionDragging, and that drag began at a mousedown gridPointerEntry had already filtered." },
  { file: "src/core/hooks/useMouseSelection/useMouseSelection.ts", event: "keyup", verdict: "observes",
    note: "Clears the Ctrl copy-mode flag; only installed while a selection drag is live." },
  { file: "src/core/hooks/useMouseSelection/useMouseSelection.ts", event: "mousedown", verdict: "observes",
    note: "Clears a latched-mouseup boolean so a finished gesture cannot end the next one." },
  { file: "src/core/hooks/useMouseSelection/useMouseSelection.ts", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "src/core/hooks/useMouseSelection/useMouseSelection.ts", event: "mouseup", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live." },
  { file: "src/core/lib/dialogs.ts", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "src/modelEditorMain.tsx", event: "dragover", verdict: "app-global",
    note: "Separate Model Editor window; preventDefault stops the browser navigating away when a file is dropped. No grid, no claim." },
  { file: "src/modelEditorMain.tsx", event: "drop", verdict: "app-global",
    note: "As dragover: the Model Editor window swallows a stray file drop so the WebView does not navigate to it. No grid, no claim." },
  { file: "src/shell/ActivityBar/SidePanel.tsx", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "src/shell/ActivityBar/SidePanel.tsx", event: "mouseup", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live." },
  { file: "src/shell/DialogContainer.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "src/shell/FormulaBar/FormulaBar.tsx", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "src/shell/FormulaBar/FormulaBar.tsx", event: "mouseup", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live." },
  { file: "src/shell/FormulaBar/InsertFunctionDialog.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "src/shell/FormulaBar/NameBox.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "src/shell/FormulaBar/NameBoxDropdown.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "src/shell/FormulaBar/NameBoxDropdown.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "src/shell/MenuBar/MenuBar.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "src/shell/MenuBar/MenuBar.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "src/shell/Overlays/ContextMenu/ContextMenu.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "src/shell/Overlays/ContextMenu/ContextMenu.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "src/shell/Overlays/MiniFormatToolbar/MiniFormatToolbar.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "src/shell/Ribbon/PanelContextMenu.tsx", event: "keydown", verdict: "session-scoped",
    note: "Escape / arrow keys for a popup or dialog this surface itself opened; it acts only on its own surface." },
  { file: "src/shell/Ribbon/PanelContextMenu.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "src/shell/Ribbon/RibbonContainer.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "src/shell/SheetTabs/SheetTabs.tsx", event: "mousedown", verdict: "session-scoped",
    note: "Click-outside dismissal for a popup this surface itself opened; it closes only its own surface." },
  { file: "src/shell/SheetTabs/SheetTabs.tsx", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "src/shell/SheetTabs/SheetTabs.tsx", event: "mouseup", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live." },
  { file: "src/shell/TaskPane/TaskPaneContainer.tsx", event: "mousemove", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live, so the press that started it was already filtered." },
  { file: "src/shell/TaskPane/TaskPaneContainer.tsx", event: "mouseup", verdict: "session-scoped",
    note: "Drag session: registered only while a drag this surface itself began is live." },
];

/** Every listener that ACTS on a gesture that could land inside a claimed
 *  surface and therefore has to consult the claim. */
export function claimGuardedFiles(): string[] {
  return [
    ...new Set(
      GLOBAL_INPUT_LISTENERS.filter((l) => l.verdict === "claim-guarded").map((l) => l.file),
    ),
  ].sort();
}

/** Every verdict, in the order the header explains them. */
export const ALL_VERDICTS: readonly GlobalListenerVerdict[] = [
  "claim-guarded",
  "app-global",
  "right-press-exempt",
  "session-scoped",
  "observes",
];

/** Count by verdict — what the census says about itself, for the test's report. */
export function verdictCounts(): Record<GlobalListenerVerdict, number> {
  const out = {} as Record<GlobalListenerVerdict, number>;
  for (const v of ALL_VERDICTS) out[v] = 0;
  for (const l of GLOBAL_INPUT_LISTENERS) out[l.verdict] += 1;
  return out;
}
