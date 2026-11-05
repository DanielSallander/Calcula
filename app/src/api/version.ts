//! FILENAME: app/src/api/version.ts
// PURPOSE: API version constant for extension compatibility checking.
// CONTEXT: Extensions declare which API version they target via manifest.apiVersion.
//          The ExtensionManager checks compatibility before activation.

/**
 * Current API version.
 * Uses semantic versioning (major.minor.patch):
 * - Major: Breaking changes to extension APIs
 * - Minor: New APIs added (backward compatible)
 * - Patch: Bug fixes to existing APIs
 *
 * An extension that USES an addition declares the version that added it
 * (`apiVersion: "^1.2.0"`), so a host without it refuses to load the extension
 * instead of handing it an `undefined` it never checks. Bump the minor version
 * whenever @api gains a member, and list it in API_CHANGELOG below
 * (src/api/__tests__/apiVersion.test.ts checks that every listed name exists).
 *
 * ONE ENTRY PER PROGRAMME, CLOSED WHEN IT IS COMMITTED. A programme's own
 * review rounds add to its entry while the programme is uncommitted (1.6.0's
 * rounds 10 and 11 did); once committed, a host built from that commit ANSWERS
 * to the version, so a later addition appended to it would make two hosts with
 * different @api surfaces claim the same version, and an extension's
 * `apiVersion` could not tell them apart. The next programme opens the next
 * minor entry instead.
 */
export const API_VERSION = "1.7.0";

/** One @api addition: a runtime export of `module` (a member of it when the
 *  name is dotted), or a TYPE-only member declared in `declaredIn`. */
export interface ApiAddition {
  name: string;
  /** The module that exports it at runtime ("@api", "@api/objectClipboard", ...). */
  module?: string;
  /** For a type-only member: the file that declares it (app-relative)... */
  declaredIn?: string;
  /** ...and a pattern its declaration matches there. */
  pattern?: string;
}

/** What one minor version added (and changed), newest first. */
export interface ApiChangelogEntry {
  version: string;
  added: readonly ApiAddition[];
  /** Existing members whose MEANING changed, compatibly. */
  changed: readonly string[];
}

/**
 * What each minor version added, newest first. 1.1.0 (context.keybindings,
 * context.settings, context.cellEditors, ...) is described in
 * docs/EXTENSION_GUIDE.md, "New in API v1.1.0". 1.3.0 is the Home tab
 * programme (2026-10-04): Excel's Home tab built through @api, so everything
 * the ribbon needed and did not have -- the command ids, the kit's submenus /
 * hero splits / registered menus / colour splits, the dialog launcher, the
 * state seams -- is now there for any extension. 1.4.0 is the canvas owner
 * findings programme (2026-10-15): ONE entry for the whole programme, each
 * work package adding its own block (WP-A's reference picks and canvas pivot
 * cells first); docs/EXTENSION_GUIDE.md "New in API v1.4.0" mirrors it.
 * 1.5.0 is canvas round 2 (2026-10-16): ONE entry for the round, each package
 * (P1, P3, P2, P4, in landing order) appending its own block -- P1's solid
 * background commit first, then P3's cell targets (@api/cellTarget, the
 * SelectionOwner.cellTarget / actsOn members, the wrappers' `{ target }`, the
 * styled cell box and the conditional-format paint seam), then P2's app locale
 * (@api/locale: the sync accessor, formatting and parsing in the app locale,
 * getCachedLocale removed; the { key, label } member shape and its readers),
 * then P4's report filters (@api/reportFilters replacing @api/pageFilters:
 * pages by sheet id, scoped publishers, cross-filter selections, Edit
 * interactions and the one target-aware resolver; @api/modelVisuals; the chart
 * mark's cross-filter capability);
 * docs/EXTENSION_GUIDE.md "New in API v1.5.0" mirrors it.
 * 1.6.0 is the model-visual drill-through (2026-10-23,
 * docs/design/model-drillthrough.md): the drill-through definition's one TS
 * shape (@api/drillThrough), the synchronous "is this sheet subscribed?"
 * answer (@api/collaboration), the right-clicked datum's member identity on
 * ChartRightClickTarget, the Charts seam that completes and checks a
 * design-query chart spec, the workbook-wide flag on a resolved report
 * filter, the temporary-sheet flag on SheetInfo and the sheet primitives that
 * keep or discard such a sheet by its stable id;
 * docs/EXTENSION_GUIDE.md "New in API v1.6.0" mirrors it.
 * 1.7.0 is the bug-ledger fix programme (2026-10-29), ONE entry for its rounds:
 * a copy names its source sheet by the stable id (Paste Link after a rename),
 * @api/sheetSwitch follows a sheet-list change the backend already made, and
 * the macro recorder's grid events say which sheet a clear, a format, a border
 * preset or a merge wrote, and a copy carries its cells' stored values so a
 * paste of a constant writes the value, never its display text; a grouped or
 * multi-area clear is one call (clearRangeOnSheets' options, ClearArea), and a
 * row/column edit off the sheet on screen has an event of its own
 * (STRUCTURAL_EDIT_ELSEWHERE, with its edits); a paste says it is one (CellUpdateInput.pasted)
 * and a typed read says when it withheld a formula
 * (TypedCellData.formulaWithheld); a switch can leave the keyboard where it is
 * (SheetFocusOptions) and a formatting wrapper can be held to the active sheet
 * (FormatPlacementOptions); the backend's announcement that it re-bound an
 * object script names the new binding (ObjectScriptsChangedDetail.instanceId).
 * Round 9 changed the scripting reach (BUG-0616): whole-line formats and
 * clears, a contents clear in an approved macro's run, and a sandboxed
 * extension's scheduled job calling a method published for its own jobs.
 * The open-ledger programme (2026-11-04/05) widened an approved macro's run
 * to formatting (owner decision) and bounded the restricted tier's non-line
 * format rectangles (BUG-0659); scripts gained Insert / Delete Cells and the
 * recorder records them (RecordedGridEvent.insertCells / .deleteCells); a
 * conditional format can hide a cell's value (IStyleOverride.hideValue), a
 * pivot field sorts by one group's values (SortPivotFieldRequest
 * .scopeGroupPath), Ctrl+click areas reach formatting (FormattingArea), the
 * audit log can include this computer's trail (MachineAuditTrail), a
 * control's container keys are one closed list per type
 * (CONTROL_PAINTED_CONTAINER_FIELDS) and a module run's queued cell styles
 * are applied in its own undo step (ScriptRunSuccess.formattingApplied).
 * Its rounds C-E added the BI format-culture seam (@api/locale), a move's
 * paste source (PasteSource.unshifted) and Paste Special's
 * (clipboardSourceStandsAt), a model measure's non-finite value
 * (PivotCellData.nonFinite, nonFiniteNumberText) and a table column's
 * remembered totals constant (TableColumn.totalsRowLabel), and changed
 * merges, table deletes and totals rows to Excel's rules.
 * Rounds 9-10 (BUG-0614) gave the stores whose cell coordinates the backend
 * never holds one way to follow every coordinate change (@api/structuralFollow):
 * an Undo / Redo hands them the changes it made as STRUCTURED DELTAS read from
 * the step itself (StructuralUndoPayload.deltas, UndoResult.structuralDeltas),
 * Insert / Delete Cells its band (CellShiftResult.delta), and a Cut + Paste
 * its move (AppEvents.CELLS_MOVED).
 * Every type it names can be imported from @api
 * (ClearArea from @api/lib, FormatPlacementOptions from @api/cellTarget);
 * docs/EXTENSION_GUIDE.md "New in API v1.7.0" mirrors it.
 */
export const API_CHANGELOG: readonly ApiChangelogEntry[] = [
  {
    version: "1.7.0",
    added: [
      // ---- A copy names its source sheet by the STABLE id, so Paste Link
      // after a rename spells the new name (BUG-0348). Was appended to the
      // already-committed 1.6.0 entry in round 1; moved here (revE#6).
      { name: "ClipboardData.sourceSheetId", declaredIn: "src/core/hooks/useClipboard.ts", pattern: "sourceSheetId\\?: string;" },
      // ---- FOLLOW a sheet-list change the backend already made (an add, a
      // delete, a hide that moved the active sheet): the tab strip's own switch
      // (BUG-0464; the script host's private copy moved here). The renumbering
      // a caller tells is removedIndex, insertedIndex (round 4: an insertion
      // at or before the sheet on screen counts as a switch) or moved; a
      // caller that tells none while the sheet on screen keeps its stable id
      // at another index is not switched at all (round 5, rev3C#2).
      { name: "announceSheetsChanged", module: "@api/sheetSwitch" },
      { name: "changeSheetsAndFollow", module: "@api/sheetSwitch" },
      { name: "FollowableSheetsResult", declaredIn: "src/api/sheetSwitch.ts", pattern: "export interface FollowableSheetsResult \\{" },
      { name: "SheetsRenumbering", declaredIn: "src/api/sheetSwitch.ts", pattern: "export interface SheetsRenumbering \\{" },
      // ---- A recorded grid event says which sheet it WROTE when that was not
      // the active sheet, so a recorded grouped or off-sheet gesture replays
      // there (each arm's own member; "kind:" never crossed by the pattern).
      // ---- The macro recorder hears Excel's Insert / Delete Cells (BUG-0358,
      // 2026-11-05): the block, the shift and the answer to unmerging.
      {
        name: "RecordedGridEvent.insertCells",
        declaredIn: "src/core/lib/tauri-api.ts",
        pattern: 'kind: "insertCells";(?:(?!kind:)[\\s\\S])*?unmergeCutMerges: boolean;',
      },
      {
        name: "RecordedGridEvent.deleteCells",
        declaredIn: "src/core/lib/tauri-api.ts",
        pattern: 'kind: "deleteCells";(?:(?!kind:)[\\s\\S])*?unmergeCutMerges: boolean;',
      },
      {
        name: "RecordedGridEvent.clearRange.sheetIndex",
        declaredIn: "src/core/lib/tauri-api.ts",
        pattern: 'kind: "clearRange";(?:(?!kind:)[\\s\\S])*?sheetIndex\\?: number;',
      },
      {
        name: "RecordedGridEvent.formatting.sheetIndices",
        declaredIn: "src/core/lib/tauri-api.ts",
        pattern: 'kind: "formatting";(?:(?!kind:)[\\s\\S])*?sheetIndices\\?: number\\[\\];',
      },
      {
        name: "RecordedGridEvent.borderPreset.sheetIndices",
        declaredIn: "src/core/lib/tauri-api.ts",
        pattern: 'kind: "borderPreset";(?:(?!kind:)[\\s\\S])*?sheetIndices\\?: number\\[\\];',
      },
      {
        name: "RecordedGridEvent.mergeCells.sheetIndex",
        declaredIn: "src/core/lib/tauri-api.ts",
        pattern: 'kind: "mergeCells";(?:(?!kind:)[\\s\\S])*?sheetIndex\\?: number;',
      },
      {
        name: "RecordedGridEvent.unmergeCells.sheetIndex",
        declaredIn: "src/core/lib/tauri-api.ts",
        pattern: 'kind: "unmergeCells";(?:(?!kind:)[\\s\\S])*?sheetIndex\\?: number;',
      },
      // ---- A copy carries its cells' STORED values, and a paste of a
      // constant writes them through one rule -- never by re-typing the
      // display text (round 4, NEW-paste-by-display-text).
      {
        name: "ClipboardData.values",
        declaredIn: "src/core/hooks/useClipboard.ts",
        pattern: "values\\?: \\(ClipboardCellValue \\| null\\)\\[\\]\\[\\];",
      },
      { name: "pastedConstantInput", module: "@api/lib" },
      { name: "ClipboardCellValue", declaredIn: "src/core/lib/clipboardValues.ts", pattern: "export interface ClipboardCellValue \\{" },
      { name: "PastedConstant", declaredIn: "src/core/lib/clipboardValues.ts", pattern: "export interface PastedConstant \\{" },
      // ---- A grouped or multi-area clear is ONE call (round 3, revG#9 /
      // rev3A#8): each further Ctrl+click block of `clearRangeOnSheets`'
      // `options.moreAreas` has this shape (the wire type of
      // `clear_range_on_sheets`' moreAreas, mirroring api_types::ClearArea).
      // Imported from @api/lib (round 6: it was listed while only Core
      // exported it).
      { name: "ClearArea", declaredIn: "src/core/types/types.ts", pattern: "export interface ClearArea \\{" },
      // ---- A row/column edit OFF the sheet on screen has an event of its
      // own, so nothing on the sheet on screen is disturbed (round 4, review
      // FU#5).
      { name: "AppEvents.STRUCTURAL_EDIT_ELSEWHERE", module: "@api/events" },
      {
        name: "StructuralEditElsewherePayload",
        declaredIn: "src/api/events.ts",
        pattern: "export interface StructuralEditElsewherePayload \\{",
      },
      // ---- ...and that event carries its EDITS, every one in the order made
      // (round 7, NEW-offsheet-structural-frontend-only-state): a store whose
      // coordinates the backend never holds -- an embedded form's anchor, an
      // anchor-derived control id -- replays them on the sheet named.
      {
        name: "StructuralEditElsewherePayload.edits",
        declaredIn: "src/api/events.ts",
        pattern:
          "export interface StructuralEditElsewherePayload \\{(?:(?!\\n\\})[\\s\\S])*?edits: StructuralEditElsewhereEdit\\[\\];",
      },
      {
        name: "StructuralEditElsewhereEdit",
        declaredIn: "src/api/events.ts",
        pattern: "export interface StructuralEditElsewhereEdit \\{",
      },
      // ---- A paste is a PASTE, not an entry: one flag keeps a pasted formula,
      // number, boolean or error what it is in a Text-formatted (@) cell, in
      // the same write (round 5, revE#2 / rev3B#1); PastedConstant carries it.
      {
        name: "CellUpdateInput.pasted",
        declaredIn: "src/core/lib/tauri-api.ts",
        pattern: "export interface CellUpdateInput \\{(?:(?!\\n\\})[\\s\\S])*?pasted\\?: boolean;",
      },
      // ---- A typed read says when it WITHHELD a formula (a protected sheet
      // hides it), so a read-modify-write never takes the value for the whole
      // cell (round 5, revE#1 / rev3B#2 / rev3B#3).
      {
        name: "TypedCellData.formulaWithheld",
        declaredIn: "src/core/types/types.ts",
        pattern: "export interface TypedCellData \\{(?:(?!\\n\\})[\\s\\S])*?formulaWithheld\\?: boolean;",
      },
      // ---- A switch can leave the keyboard where it is: the command line's
      // prompt (round 5, rev3C#3).
      { name: "SheetFocusOptions", declaredIn: "src/api/sheetSwitch.ts", pattern: "export interface SheetFocusOptions \\{" },
      // ---- A formatting wrapper held to the ACTIVE sheet, never the user's
      // sheet group: a script's format (round 5,
      // NEW-script-format-follows-ui-group). Imported from @api/cellTarget.
      {
        name: "FormatPlacementOptions",
        declaredIn: "src/core/lib/tauri-api.ts",
        pattern: "export interface FormatPlacementOptions extends CellTargetOptions \\{\\s*activeSheetOnly\\?: boolean;",
      },
      // ---- A backend re-bind NAMES the binding the script has now, so a
      // listener re-keys at once instead of reading it back (round 8, rev6B#6).
      {
        name: "ObjectScriptsChangedDetail.instanceId",
        declaredIn: "src/api/objectScriptBackend.ts",
        pattern:
          "export interface ObjectScriptsChangedDetail \\{(?:(?!\\n\\})[\\s\\S])*?instanceId\\?: string \\| null;",
      },
      // ---- ONE way for a store whose cell coordinates the backend never
      // holds (a watch, a bookmark, an overlay's range, a driver cell) to
      // follow row / column edits, Insert / Delete Cells and moved cells on
      // any sheet, and their Undo / Redo (rounds 9-10, BUG-0614).
      { name: "followStructuralEdits", module: "@api/structuralFollow" },
      { name: "shiftCellByEdit", module: "@api/structuralFollow" },
      { name: "shiftRangeByEdit", module: "@api/structuralFollow" },
      { name: "followCell", module: "@api/structuralFollow" },
      { name: "followRange", module: "@api/structuralFollow" },
      { name: "inverseStructuralEdit", module: "@api/structuralFollow" },
      { name: "sameStructuralEdit", module: "@api/structuralFollow" },
      { name: "followSheetRenumbering", module: "@api/structuralFollow" },
      { name: "StructuralLineEdit", declaredIn: "src/api/structuralFollow.ts", pattern: "export interface StructuralLineEdit \\{" },
      { name: "StructuralCellMove", declaredIn: "src/api/structuralFollow.ts", pattern: "export type StructuralCellMove = StructuralMoveDelta;" },
      { name: "StructuralFollowEdit", declaredIn: "src/api/structuralFollow.ts", pattern: "export type StructuralFollowEdit = " },
      { name: "StructuralFollowStep", declaredIn: "src/api/structuralFollow.ts", pattern: "export interface StructuralFollowStep<" },
      { name: "StructuralFollowCause", declaredIn: "src/api/structuralFollow.ts", pattern: "export type StructuralFollowCause = " },
      { name: "StructuralRange", declaredIn: "src/api/structuralFollow.ts", pattern: "export interface StructuralRange \\{" },
      { name: "FollowStructuralEditsOptions", declaredIn: "src/api/structuralFollow.ts", pattern: "export interface FollowStructuralEditsOptions \\{" },
      {
        name: "FollowStructuralEditsWithMovesOptions",
        declaredIn: "src/api/structuralFollow.ts",
        pattern: "export interface FollowStructuralEditsWithMovesOptions extends FollowStructuralEditsOptions \\{",
      },
      { name: "StructuralFollowSubscribe", declaredIn: "src/api/structuralFollow.ts", pattern: "export type StructuralFollowSubscribe = " },
      // ---- The coordinate change a step made, as the backend reports it
      // (api_types::StructuralDelta): what an Undo / Redo reversed or replayed,
      // read from the step itself -- never parsed from its description, which
      // could not name a grouped step or a cell shift (round 10).
      { name: "StructuralDelta", declaredIn: "src/core/types/types.ts", pattern: "export type StructuralDelta = StructuralLineDelta \\| StructuralMoveDelta;" },
      { name: "StructuralLineDelta", declaredIn: "src/core/types/types.ts", pattern: "export interface StructuralLineDelta \\{" },
      { name: "StructuralMoveDelta", declaredIn: "src/core/types/types.ts", pattern: "export interface StructuralMoveDelta \\{" },
      { name: "DeltaBand", declaredIn: "src/core/types/types.ts", pattern: "export interface DeltaBand \\{" },
      { name: "StructuralUndoPayload", declaredIn: "src/api/events.ts", pattern: "export interface StructuralUndoPayload \\{" },
      { name: "AppEvents.CELLS_MOVED", module: "@api/events" },
      { name: "CellsMovedPayload", declaredIn: "src/api/events.ts", pattern: "export interface CellsMovedPayload \\{" },
      // ---- A data command that rewrote cells in place (Sort, Remove
      // Duplicates, Text to Columns) ends the clipboard mode as Excel's does
      // [LIVE], and a paste door that is not plain Paste waits for a stale
      // snapshot's re-read (round 11, lane clip3).
      { name: "AppEvents.DATA_COMMAND_APPLIED", module: "@api/events" },
      { name: "DataCommandAppliedPayload", declaredIn: "src/api/events.ts", pattern: "export interface DataCommandAppliedPayload \\{" },
      { name: "settledInternalClipboard", module: "@api/lib" },
      // ---- Excel's Insert Copied Cells (round 12, lane clip4 [LIVE]): with a
      // COPY pending, Insert makes room for the copied block and pastes it
      // there as ONE undo step; the menus then say "Insert Copied Cells...".
      { name: "insertCopiedCells", module: "@api/lib" },
      { name: "insertCopiedCellsLabel", module: "@api/lib" },
      { name: "pendingCopyOfSheetCells", module: "@api/lib" },
      { name: "InsertCopiedCellsRequest", declaredIn: "src/core/hooks/useClipboard.ts", pattern: "export type InsertCopiedCellsRequest =" },
      { name: "InsertCopiedCellsResult", declaredIn: "src/core/hooks/useClipboard.ts", pattern: "export type InsertCopiedCellsResult =" },
      // ---- Excel TILES a copy into a selection that is an exact multiple of
      // it (round 13, lane clip5 [LIVE]): ONE rule for Paste, Paste Special and
      // Insert Copied Cells.
      { name: "pasteTiles", module: "@api/lib" },
      { name: "pasteMayTile", module: "@api/lib" },
      { name: "PASTE_ONCE", module: "@api/lib" },
      { name: "PasteTiles", declaredIn: "src/core/lib/pasteTiling.ts", pattern: "export interface PasteTiles \\{" },
      { name: "PasteTilingSelection", declaredIn: "src/core/lib/pasteTiling.ts", pattern: "export interface PasteTilingSelection \\{" },
      {
        name: "UndoResult.structuralDeltas",
        declaredIn: "src/core/lib/tauri-api.ts",
        pattern: "export interface UndoResult \\{(?:(?!\\n\\})[\\s\\S])*?structuralDeltas\\?: StructuralDelta\\[\\];",
      },
      {
        name: "CellShiftResult.delta",
        declaredIn: "src/core/types/types.ts",
        pattern: "export interface CellShiftResult \\{(?:(?!\\n\\})[\\s\\S])*?delta\\?: StructuralDelta \\| null;",
      },
      // ---- A grid menu item can STAND IN for others while it shows (round
      // 16, rev14A): Insert Copied Cells replaces Core's header Insert Row /
      // Insert Column, and Core no longer guesses from the clipboard.
      {
        name: "GridContextMenuItem.replaces",
        declaredIn: "src/api/extensions.ts",
        pattern: "export interface GridContextMenuItem \\{(?:(?!\\n\\})[\\s\\S])*?replaces\\?: readonly string\\[\\];",
      },
      // ---- A MOVED write names its SOURCE cell (round 18, rev16A): the
      // backend carries a moved cell's format onto a protected sheet without
      // Format Cells only when that source shows the style written.
      {
        name: "CellUpdateInput.moved",
        declaredIn: "src/core/lib/tauri-api.ts",
        pattern: "export interface CellUpdateInput \\{(?:(?!\\n\\})[\\s\\S])*?moved\\?: MovedFrom;",
      },
      { name: "MovedFrom", declaredIn: "src/core/lib/tauri-api.ts", pattern: "export interface MovedFrom \\{" },
      // ---- File > Open's picker and its load, apart (round 18, misc17): so
      // something can be asked between them (unsaved changes made meanwhile).
      { name: "workbook.pickFileToOpen", declaredIn: "src/api/system.ts", pattern: "\\n  pickFileToOpen,\\n" },
      { name: "workbook.openAtPath", declaredIn: "src/api/system.ts", pattern: "\\n  openAtPath: openFileAtPath,\\n" },
      // ---- The open-ledger programme, rounds A and B (2026-11-04/05), lane by
      // lane (each lane's report "API:" lines).
      // render: a conditional format's Show Bar Only / Show Icon Only, and a
      // data bar's axis and negative direction.
      {
        name: "IStyleOverride.hideValue",
        declaredIn: "src/api/styleInterceptors.ts",
        pattern: "export interface IStyleOverride \\{(?:(?!\\n\\})[\\s\\S])*?hideValue\\?: boolean;",
      },
      {
        name: "CellConditionalFormat.dataBarAxis",
        declaredIn: "src/api/backend.ts",
        pattern: "export interface CellConditionalFormat \\{(?:(?!\\n\\})[\\s\\S])*?dataBarAxis\\?: number;",
      },
      {
        name: "CellConditionalFormat.dataBarNegative",
        declaredIn: "src/api/backend.ts",
        pattern: "export interface CellConditionalFormat \\{(?:(?!\\n\\})[\\s\\S])*?dataBarNegative\\?: boolean;",
      },
      {
        name: "CellConditionalFormat.hideValue",
        declaredIn: "src/api/backend.ts",
        pattern: "export interface CellConditionalFormat \\{(?:(?!\\n\\})[\\s\\S])*?hideValue\\?: boolean;",
      },
      // bi: sort a pivot field by the values of ONE row / column group.
      {
        name: "SortPivotFieldRequest.scopeGroupPath",
        declaredIn: "src/api/pivotTypes.ts",
        pattern: "export interface SortPivotFieldRequest \\{(?:(?!\\n\\})[\\s\\S])*?scopeGroupPath\\?: Array<\\[number, number\\]>;",
      },
      // multiarea: Ctrl+click areas everywhere, and the shown text of a cell.
      { name: "FormattingArea", declaredIn: "src/core/types/types.ts", pattern: "export interface FormattingArea \\{" },
      { name: "shownGeneralTextAt", module: "@api/shownCellText" },
      { name: "AutoFitRowSpan", declaredIn: "src/api/autoFitContributors.ts", pattern: "export interface AutoFitRowSpan \\{" },
      {
        name: "FormulaShiftInput.sourceRow",
        declaredIn: "src/core/lib/tauri-api.ts",
        pattern: "export interface FormulaShiftInput \\{(?:(?!\\n\\})[\\s\\S])*?sourceRow\\?: number;",
      },
      {
        name: "FormulaShiftInput.sourceCol",
        declaredIn: "src/core/lib/tauri-api.ts",
        pattern: "export interface FormulaShiftInput \\{(?:(?!\\n\\})[\\s\\S])*?sourceCol\\?: number;",
      },
      // calpdec: this computer's audit trail of rows no open workbook holds.
      { name: "MachineAuditTrail", declaredIn: "src/api/collaboration.ts", pattern: "export interface MachineAuditTrail \\{" },
      { name: "MachineAuditEntry", declaredIn: "src/api/collaboration.ts", pattern: "export interface MachineAuditEntry extends AuditEntry \\{" },
      {
        name: "AuditLog.machine",
        declaredIn: "src/api/collaboration.ts",
        pattern: "machine\\?: MachineAuditTrail;",
      },
      // scriptb: the container keys each control type paints (BUG-0491), and a
      // module run's queued cell styles applied in its own undo step.
      // miscb: a paste write names its SOURCE cell; the backend writes what it
      // holds at write time.
      {
        name: "CellUpdateInput.source",
        declaredIn: "src/core/lib/tauri-api.ts",
        pattern: "export interface CellUpdateInput \\{(?:(?!\\n\\})[\\s\\S])*?source\\?: PasteSource;",
      },
      { name: "PasteSource", declaredIn: "src/core/lib/tauri-api.ts", pattern: "export interface PasteSource \\{" },
      // uic: Excel's Worksheet.FilterMode for the active sheet (AutoSum, Ctrl+Enter).
      { name: "isActiveSheetFilterMode", module: "@api/autoFilterService" },
      { name: "CONTROL_PAINTED_CONTAINER_FIELDS", module: "@api/visualContainer" },
      { name: "controlPaintsContainerField", module: "@api/visualContainer" },
      { name: "controlPaintsContainerKey", module: "@api/visualContainer" },
      {
        name: "ScriptRunSuccess.formattingApplied",
        declaredIn: "src/api/workbookScripts.ts",
        pattern: "export interface ScriptRunSuccess \\{(?:(?!\\n\\})[\\s\\S])*?formattingApplied\\?: boolean;",
      },
      {
        name: "ScriptSideEffects.formattingApplied",
        declaredIn: "src/api/workbookScripts.ts",
        pattern: "export interface ScriptSideEffects \\{(?:(?!\\n\\})[\\s\\S])*?formattingApplied\\?: boolean;",
      },
      // bic (round C): the ONE seam for "every BI model engine now writes DAX
      // FORMAT in the app locale" -- a model re-query after a locale switch
      // waits for it, since LOCALE_CHANGED fires before Rust's walk ends.
      { name: "onBiFormatCultureApplied", module: "@api/locale" },
      { name: "getBiFormatCultureGeneration", module: "@api/locale" },
      { name: "BI_FORMAT_CULTURE_APPLIED_EVENT", module: "@api/locale" },
      { name: "AppEvents.BI_FORMAT_CULTURE_APPLIED", module: "@api/events" },
      // clipc (round C): a paste write that MOVES its source (Cut + Paste, a
      // drag move) lands the source's formula unshifted.
      {
        name: "PasteSource.unshifted",
        declaredIn: "src/core/lib/tauri-api.ts",
        pattern: "export interface PasteSource \\{(?:(?!\\n\\})[\\s\\S])*?unshifted\\?: boolean;",
      },
      // pastec (round D): whether a pending copy's recorded positions still
      // name its source cells, so a Paste Special write may name them.
      { name: "clipboardSourceStandsAt", module: "@api/lib" },
      // dfcase (round D): a model measure's non-finite value (1/0, -1/0, 0/0)
      // on the pivot wire, and Power BI's words for it on a canvas visual.
      {
        name: "PivotCellData.nonFinite",
        declaredIn: "src/api/pivotTypes.ts",
        pattern: "export interface PivotCellData \\{(?:(?!\\n\\})[\\s\\S])*?nonFinite\\?: NonFiniteNumber;",
      },
      { name: "NonFiniteNumber", declaredIn: "src/api/locale.ts", pattern: "export type NonFiniteNumber = " },
      { name: "nonFiniteNumberText", module: "@api/locale" },
      // cfdv (round D): a table column's remembered totals-row constant.
      {
        name: "TableColumn.totalsRowLabel",
        declaredIn: "src/api/backend.ts",
        pattern: "export interface TableColumn \\{(?:(?!\\n\\})[\\s\\S])*?totalsRowLabel\\?: string;",
      },
    ],
    changed: [
      "STRUCTURAL_UNDO's payload is StructuralUndoPayload (rounds 9-10, BUG-0614): an Undo or Redo of a structural step carries source \"undo\" | \"redo\" and deltas, the coordinate changes it made in the order made, as the backend read them from the step (UndoResult.structuralDeltas: an undo reports the INVERSE of each change, newest first; a redo each change again, oldest first; a grouped step every edit; Insert / Delete Cells its band), and Insert / Delete Cells announces it with source \"edit\" and its band (CellShiftResult.delta) -- never parse the description; an Undo / Redo of a step that moved cells but restored no structure (a Cut + Paste) announces CELLS_MOVED instead",
      "a pending COPY's source follows the row and column edits Excel makes it follow, and keeps its address where Excel keeps it (round 10, BUG-0614 [LIVE 2026-10-30]): an Undo or Redo of an insert, a delete or an Insert Cells keeps a copy AND a cut and their ADDRESS (getInternalClipboard() returns the snapshot read again there -- Excel pastes what stands at the copied address now); an Insert Cells band and a script's row or column INSERT end a cut but MOVE a copy's source (ClipboardData.sourceSelection, sourceRows and the marching ants) with its cells, while a DELETE -- Delete Cells, or a script's row, column or cell delete on any sheet -- ends a copy as well as a cut (round 11 [LIVE]); an insert that cuts into the copied block leaves the copy pasting the snapshot it has; a sheet inserted or removed renumbers ClipboardData.sourceSheetIndex",
      "the clipboard mode -- a copy's and a cut's -- ENDS on a Sort (sortRange: the ribbon, the Sort dialog, an AutoFilter dropdown, a script), a removeDuplicates and a Text to Columns that succeeded, as Excel's does from the ribbon and COM alike (round 11 [LIVE]); each announces AppEvents.DATA_COMMAND_APPLIED once it has landed, a refused one nothing",
      "where Excel keeps the clipboard mode, a paste takes what the source holds NOW whatever its size (round 11): a stale snapshot (an undo, a rename, a write onto the source) is read again -- sparse and banded, in the background up to 100,000 cells and when a paste asks above that (a whole column) -- and with it ClipboardData.text (and the system clipboard, while it still holds this copy's text), comments, validations and collectionTexts; a snapshot whose re-read FAILED is never pasted: plain Paste refuses it (a copy's as well as a cut's) and ends the mode, and settledInternalClipboard() answers null; every Paste Special door reads the clipboard through settledInternalClipboard(); getInternalClipboard() still answers at once",
      "a drag of whole rows or columns (Core's row / column move) is recorded and announced as a moved block like a Cut + Paste (round 11 [LIVE]: it overwrites the lines it lands on, and the lines it passes over stay): AppEvents.CELLS_MOVED after it commits, and UndoResult.structuralDeltas carries the move for its Undo / Redo",
      "with a COPY pending, core.grid.insert / core.grid.insertCells (Home > Insert, Ctrl+Plus, the new cell right-click \"Insert...\" item) are Excel's Insert Copied Cells (round 12 [LIVE]): the room is the copy's size at the selection's top-left, a block asks the two-choice Insert dialog (Shift cells right / down) unless { shift } names one, whole copied rows (columns) go in over whole selected rows (columns) with no dialog, a mismatch is refused (\"This selection isn't valid...\"), and the copy stays pending with its source moved along; a ROWS_INSERTED / COLUMNS_INSERTED that is not Insert Copied Cells' own still ends the clipboard mode. The grid paste command (core.clipboard.paste) takes { at: { row, col } } to paste with that cell as the top-left",
      "the clipboard mode -- a copy's and a cut's -- also ENDS, as Excel's does (round 13 [LIVE]), on Calculate Now / Calculate Sheet (calculateNow / calculateSheet, every route: F9, Shift+F9, the Formulas menu, a script, the command line; recalcWithCube, Excel's CalculateFull, keeps it), on turning an AutoFilter on or applying or clearing its criteria (applyAutoFilter, setColumnFilterValues / CustomFilter / TopBottomFilter / DynamicFilter, clearColumnCriteria, clearAutoFilterCriteria; reapplyAutoFilter and removeAutoFilter keep it), on a Merge or Unmerge (mergeCells / unmergeCells, never a probe) -- each announces AppEvents.DATA_COMMAND_APPLIED once it landed, DataCommandAppliedPayload.command gaining \"autoFilter\", \"merge\" and \"calculate\" -- and on Group / Ungroup rows or columns and Clear Outline (OUTLINE_CHANGED with those commands; collapse, expand and show-level keep it)",
      "the clipboard mode -- a copy's and a cut's -- also ENDS (round 14 [LIVE]), on setCalculationMode (Formulas > Calculation Options, a script, the release of a script's manual mode), either way and even to the mode already in effect, once the switch landed: AppEvents.DATA_COMMAND_APPLIED with DataCommandAppliedPayload.command \"calculationMode\"; a refused switch ends nothing",
      "a gesture TAKEN BACK to its undo savepoint is shown the way Ctrl+Z shows a restore (round 14): Insert Copied Cells whose paste did not land, and a refused Cut + Paste or drag-move, re-read the dimensions and cells and announce MUTATION_REFRESH, and the changes the followers were told about come back to them as their Undo with nothing to Redo -- STRUCTURAL_UNDO with StructuralUndoPayload.source \"rollback\" (the inverse line deltas; a pending copy's source follows them back and the copy stays pending) and, for a move announced from a step that JOINED an outer one (a granted run's Merge & Center), CELLS_MOVED with CellsMovedPayload.source \"rollback\"; @api/structuralFollow hands a follower such a change with cause \"undo\" and the edit's own seq; a move that was never announced is never handed back",
      "the clipboard mode -- a copy's and a cut's -- also ENDS on a refresh of the data underneath the grid (round 15 [LIVE]: Excel's Data > Refresh All ends it even with nothing to refresh, and so does a PivotTable's Refresh; Excel's CalculateFull and ribbon commands such as Zoom keep it): @api/dataAftermath's announceUnderlyingDataChanged -- Collaboration's refresh of subscribed content, a BI view-as role switch -- announces AppEvents.DATA_COMMAND_APPLIED with DataCommandAppliedPayload.command \"refresh\" after its recalculation, whichever recalculation it ran",
      "a granted application macro run that is TAKEN BACK (owner decision B, all or nothing) is shown through the same take-back announcement as a gesture's (round 15): the line edits the run made come back to their followers as STRUCTURAL_UNDO source \"rollback\", and a move announced from a step that joined the run (its Merge & Center) as CELLS_MOVED source \"rollback\", so a pending copy's source, bookmarks and Watch Window entries go back where they were; it used to announce MUTATION_REFRESH alone",
      "plain Paste never writes a snapshot its source has moved on from (round 15): a write onto the copied cells that lands while the paste is being prepared (its clipboard, merge or formula-shift reads), or marks that keep landing past the bounded settle, start the paste again from the top before anything is written -- a bounded number of times, after which it pastes the snapshot of the last re-read that paste made (round 19: Excel pastes what the source holds at the paste [LIVE]); only a snapshot no re-read of that paste reached is refused (\"kept changing\"), the copy kept pending",
      "a TILED Paste Special (a selection that is a multiple of the copy) writes every cell's content in ONE updateCellsBatch, the source's style riding each update (CellUpdateInput.styleIndex), every tile's formulas from ONE shiftFormulasBatch, and a number format once per copied cell over its tiles' rows x columns (round 15): a one-cell copy over a column was one awaited write per cell; Paste Formatting's style-only writes, No Borders' sides, comments and validation are still one call per cell",
      "CellUpdateInput.styleIndex on a PROTECTED sheet is a format like any other (round 14, as Excel [LIVE]): dropped when the sheet does not allow Format Cells (the cell keeps its own style), and every written cell keeps its Locked flag whatever the index says -- a paste or a fill can never unlock a cell",
      "with a COPY pending, the row and column header right-click menu offers \"Insert Copied Cells\" in place of Insert Row / Insert Column, and the cell right-click item reads \"Insert Copied Cells\" (no dots, no dialog) for copied whole rows or columns, as Excel's menus do [LIVE] (round 14); the header item runs core.grid.insert, which inserts the copied lines (a copied block onto whole lines is refused, as Excel refuses it)",
      "a copied formula whose VALUE changes while the copy is pending (a script's or a scheduled job's write it depends on) is pasted with its CURRENT value by Paste Values and every value-pasting door, and ClipboardData.text and the system clipboard follow it, as Excel's do [LIVE] (round 13): a CELL_VALUES_CHANGED change on a copied cell marks the snapshot stale -- any change, even one whose formula and shown text are as copied (round 15: a number format can show the same text for a new stored value, and Paste Values pastes the stored value); a snapshot is refused as unreadable only when a read of it FAILED, never because a write landed while the paste was waiting; and when the system clipboard cannot be written, ClipboardData.text keeps the text the system clipboard still holds",
      "Paste and every Paste Special door TILE a copy into a selection that is an exact multiple of it, rows AND columns, as Excel does [LIVE] (round 13): the block is repeated over the selection, each tile's formulas shifted to where that tile lands; any other size, a selection holding a merged cell, a cut and a floating grid's cells paste once (pasteTiles, @api/lib). Insert Copied Cells sizes its room the same way (the whole selection when it is a multiple of the copy, rows and columns alike; round 15: asked over the area the copy's own paste then fills, so a room the paste would fill only once -- past its 5,000,000-cell tiling cap -- is made only once), and the grid paste command's { at } also takes endRow / endCol, the room to fill",
      "Merge & Center / Merge Cells / Merge Across that MOVE a value into the top-left cell (its top-left was empty) announce AppEvents.CELLS_MOVED for each moved value once the step is kept, as Excel's Watch Window follows it [LIVE] (round 12): the step already recorded the move for its Undo / Redo, so the followers now move forward too instead of only on the Undo",
      "the Undo of a moved block (a Cut + Paste, a drag, a merge's moved value) overwrites nothing: a cell bookmark or a Watch Window entry on a cell the block returns to stays, as Excel's watch does [LIVE] (round 12); the Redo moves the block again and overwrites again",
      "a drag-move of cells is all or nothing (round 12): a refused destination write, source clear or relocation takes the whole move back to a savepoint, commits nothing and announces nothing; and a drag, a Cut + Paste or a Copy + Paste of sheet cells that would run past the sheet's last row or column is refused whole with Excel's words [LIVE] -- it used to write the part that fit, clear the whole source and announce the whole block as moved (a floating grid's own extent still clamps)",
      "a sandboxed (worker) extension's context.capabilities.schedule gains expose(name, fn) (round 9, BUG-0616 #3; not an @api export -- the worker realm's own context): it publishes fn under name for the extension's OWN scheduled jobs, so schedule.every / schedule.at have something to run (Excel's Application.OnTime calls a named procedure; before it every such job failed at every firing); nothing else can call it, it needs the schedule capability, a firing runs at most 30 s, and it resolves to a function that withdraws the name",
      "a script's format and clear take WHOLE rows, WHOLE columns and the whole sheet in one call (round 9, BUG-0616 #1), as VBA's Columns(\"C\").ClearFormats / Rows(5).Font.Bold = True / Cells.ClearFormats do: api.setRangeFormat, api.clearRangeFormat, api.clearRange and their sheet.* twins accept a rectangle that is whole lines or almost-whole lines (A2:D1048576) at any size -- the backend writes them as row / column formats -- and any other rectangle up to 4,000,000 cells (was 100,000 for every rectangle) for the user's own code -- the RESTRICTED tier (the sheet.* format rows, and an application macro's granted run whatever row it reaches) keeps 100,000 for a rectangle that is not whole lines (BUG-0659, 2026-11-05: every such position is a stored cell and an undo entry); reads, value writes, api.applyNamedStyle and every other range call keep 100,000, and a recorded whole-column format or Clear Formats now replays as that one call",
      "an approved application macro that you run (owner decision B) may call api.clearRange with { applyTo: \"contents\" } on any sheet -- Range.ClearContents, cell access like a write: Rust's grant, every cell it changed on the run's trail, the run undone whole if it fails (round 9, BUG-0616 #2); \"formats\" and \"all\" join with the formatting grant below (they were refused until 2026-11-04). clearRangeWithOptions on a sheet other than the active one now answers the cells it changed (updatedCells, each with its sheetIndex) where it answered none",
      "an approved application macro that you run (owner decision B) may also change FORMATTING on any sheet (owner, 2026-11-04): api.setRangeFormat (font, colour, fill, alignment, number format, borders incl. the range edges -- never locked / formulaHidden, which are protection), api.clearRangeFormat, api.clearRange \"formats\" / \"all\", api.applyNamedStyle, the row-height / column-width rows and the AutoFit rows (never on a HIDDEN line: a resize would show it), the format reads, and the restricted sheet.setRangeFormat / sheet.clearRangeFormat while the grant lasts; Rust co-decides it (the mount gate's formatAccess), every formatting change is on the run's trail per sheet, and a run that fails part-way takes its formatting back with its cells. Hiding, conditional formats, validation, creating or deleting a named style, merges and every sheet-level setting stay outside it; a run a script starts never has it. The pre-flight names a setRangeFormat that sets locked or formulaHidden before anything runs",
      "a script's api.mergeCells of a block with nothing to merge -- one cell, or a block that is already exactly that merge -- returns quietly, as Excel's Range(\"A1\").Merge does [LIVE] (BUG-0283); it used to throw \"the range overlaps an existing merge\". A real overlap is refused in the backend's own words",
      "scripts gain Excel's Insert / Delete Cells (BUG-0358; VBA Range.Insert Shift / Range.Delete Shift): api.insertCells(startRow, startCol, endRow, endCol, \"right\" | \"down\", { unmergeCutMerges? }) and api.deleteCells(..., \"left\" | \"up\", ...) on the active sheet, over the same wrappers as Home > Insert Cells... (a block spanning every column / row is an entire-row / -column edit); a shift that would cut a merged block is refused with Excel's question, nothing changed, unless unmergeCutMerges says to go on. insertCellsRange / deleteCellsRange record an applied shift for the macro recorder (RecordedGridEvent.insertCells / .deleteCells), which replays it as that call",
      "on the sheet on screen, insertRows / insertColumns / deleteRows / deleteColumns ask the grid to re-read its row heights and column widths (window \"dimensions:refresh\") themselves (BUG-0360), so every caller -- a script's table row insert, Insert Copied Cells' whole rows, an extension -- repaints the shifted sizes; insertCellsRange / deleteCellsRange's whole-line route no longer asks a second time",
      "BINDABLE_PATHS (@api/objectBindings) drops the slicer / timeline slicer / floating grid container rows of fields those families never paint (title.wrap, subtitle.*, divider.*, spacing.belowSubtitle / belowDivider; spacing.custom / belowTitle on a floating grid) (BUG-0491)",
      "resolveVisualContainer (@api/visualContainer): a BOUND valid solid background.color paints as a solid background -- over a stored gradient, and shown unless background.show is bound too (BUG-0510)",
      "a control's background and border have ONE spelling (BUG-0491): set_control_property, set_control_appearance and an objectBindings set / setLiteral refuse a non-empty containerBackground{Show,Color} / containerBorder{Show,Color,Width} on a shape, text box, button or picture, naming the real key (fill, stroke / borderColor, strokeWidth); a page navigator's containerBackgroundColor, written or bound, also shows its background (containerBackgroundShow \"true\", BUG-0510)",
      "handleGlobalKeyDown: prevents the default of every F5 and BrowserRefresh (with or without Ctrl or Shift) and every Ctrl+R / Ctrl+Shift+R (by character or virtual key 82, so on any layout) -- never with Alt -- that no binding took -- during a cell edit, in a text field, with the keyboard on a ribbon button or a pane -- so WebView2 never reloads the page (BUG-0393); the key still propagates",
      "updateCellsBatch / updateCellOnSheets: a written CUBE formula shows its value instead of #N/A (BUG-0476): the write first asks the backend for exactly the cube data it evaluates (one cube_prefetch call more), which the backend serves to the cells it evaluates, and it latches the session's cube flag, so a later Calculate Now prefetches too; once the session has latched, EVERY updateCellsBatch on the sheet prefetches -- a paste, a fill or a setValue into a cube ARGUMENT cell re-evaluates the cube cell that reads it -- while a session that has written no CUBE formula keeps each batch ONE IPC call, and a batch on a floating grid's cells (target) never prefetches; updateCellOnSheets prefetches, one call per target sheet, only for a written CUBE formula -- any other value is one IPC call, latched or not",
      "insertRows / insertColumns / deleteRows / deleteColumns on a sheet other than the active one, or on a floating grid's cells, announce STRUCTURAL_EDIT_ELSEWHERE (once per burst: the first call at once, the calls of the following 50 ms in one trailing announcement), TABLE_DEFINITIONS_UPDATED and a cell refetch (\"grid:refresh\"), plus MUTATION_REFRESH { domains: ['slicer', 'pivot', 'ribbonFilter'] } after a delete on another sheet -- never STRUCTURAL_UNDO or the objects domain, so nothing on the sheet on screen is disturbed -- and the stores that cache what the backend moved there re-read it on STRUCTURAL_EDIT_ELSEWHERE: the chart and sparkline ranges (BUG-0357) and @api/cellBehaviors' workbook-wide index (rev4A#1); its payload lists every edit of the burst in the order made (StructuralEditElsewherePayload.edits: sheetIndex, null for a floating grid's own lines, kind, at, count -- never folded), an on-screen insert or delete delivers the edits still waiting in the window before its own ROWS_ event, and the stores whose coordinates the backend never holds replay them on the sheet named: forms embedded on that sheet move with their anchor cells, and Controls re-keys the side state of the shapes there (html frame, canvas renderer, declared properties, container, script badge) as the backend re-keyed the controls",
      "clearRangeOnSheets takes an optional options argument { applyTo: 'contents' | 'formats' | 'all' (default 'contents'), moreAreas: ClearArea[] (the other Ctrl+click blocks) } and returns the sheets it wrote (number[]: every listed sheet but the active one); the backend gates every listed sheet -- the active one included -- for every area before it writes anything and refuses the whole call if one refuses (one undo step, one recalculation), and the macro recorder hears one clearRange per written sheet per area",
      "the @api pivot doors that change a pivot's output (pivot.create, updateFields, applyFilter, clearFilter, sortField, refreshCache, refreshAll, updateLayout, createFromBiModel, updateBiFields, ... -- every door the Pivot extension registers as an output door) announce \"pivot:refresh\" themselves, so a caller no longer has to (BUG-0594): ONE event a macrotask after the door resolves, none when the caller dispatched \"pivot:refresh\" itself meanwhile, one for a chain of awaited doors (held at most 1 s), with detail { pivotId, pivotIds } -- pivotId only when exactly one pivot changed, and a script's pivot.onRefresh hears an event naming another pivot no longer; pivot.refreshCache and pivot.refreshAll now cache the views they return",
      "applyFormatting / applyBorderPreset / adjustNumberFormatDecimals send the selected sheet group only when the sheet on screen (Core's sheet context) belongs to it, and no group when that sheet is unknown, and take FormatPlacementOptions (CellTargetOptions plus activeSheetOnly): { activeSheetOnly: true } formats the active sheet alone whatever sheets the user has grouped -- Excel's ActiveSheet.Range, which a script's format passes -- and records no group",
      "getGroupedSheetIndices / isSheetGroupingActive / getSelectedSheetIndices: getGroupedSheetIndices(active) answers [] when that sheet is not one of the group, and the group itself ENDS on an ordinary switch to a sheet outside it (sheet:normalSwitch: the Name Box, Go To, a link, the command line, a script, an undo that lands elsewhere -- formula point mode keeps it) and follows each renumbering announced on sheet:reorder, a deleted member leaving it -- Excel keeps the active sheet one of the selected sheets",
      "updateCellsBatch's CellUpdateInput.styleIndex and setCellStyle's styleIndex name the LOOK the cell must show: 0 (Normal) under a row or column format is written as an explicit Normal, so the line's format does not show through, and with an empty value and a styleIndex the position keeps that look as an empty cell instead of being cleared (a pasted, filled or cut empty formatted cell carries its format, as in Excel); an omitted styleIndex changes nothing",
      "clearRangeWithOptions records the sheetIndex its caller named on the recorded clearRange event (RecordedGridEvent.clearRange.sheetIndex), and the macro recorder replays the clear on that sheet",
      "applyFormatting / applyBorderPreset / adjustNumberFormatDecimals record the sheet group they formatted (RecordedGridEvent.formatting / borderPreset .sheetIndices); applyFormattingToSheets now records its format with the sheets it named; mergeCells / unmergeCells record the sheetIndex their caller named -- and the macro recorder replays each on those sheets through the script API's sheet-addressed calls",
      "CellRange.applyFormatting sends the range's distinct rows and columns once each, so a range of any size is formatted (it was refused from 2,000 cells up) and each cell is recorded once in undo (BUG-0354)",
      "Paste, Cut + Paste, a drag move or Ctrl+drag copy and every Paste Special variant (core.clipboard.pasteSpecial and the quick-paste commands, on a sheet or a floating grid) write a copied CONSTANT -- and, under a values attribute, a formula's result -- from the stored value the copy read (ClipboardData.values), invariant, instead of re-typing its display text; they, Paste Link and a script's pasteRange flag every pasted formula or stored value CellUpdateInput.pasted, so a number, boolean, error or formula keeps its kind in a Text-formatted (@) cell in that one write (no General/@ detour; the cell's own style and protection stay as they are); text pasted from another program still goes through the entry ladder; and Paste Special's operations (Add, Subtract, Multiply, Divide) refuse exactly the cells whose formula the typed read withheld (TypedCellData.formulaWithheld) and compute over hidden blanks and constants",
      "activateSheet: also takes keepFocus (SheetFocusOptions) -- { keepFocus: true } leaves the keyboard focus where it is instead of giving it to the grid once the switch lands (the command line's prompt); the sheet:normalSwitch window event then carries keepFocus: true, which Core honours",
      "applyFormatting / applyFormattingToSheets: whole rows, whole columns, Select All and an almost-whole rectangle (A2:D1048576) are written as ONE row or column format per line plus only the cells whose look must differ or that hold a value -- what Excel stores, so a value typed there later takes the format -- and applyFormatting's FormattingResult.cells can then be empty while its styles carry the new style (refresh the grid rather than patching from cells); any other selection of more than 4,000,000 cells is refused before anything is written (BUG-0354)",
      "adjustNumberFormatDecimals: its FormattingResult.styles lists every style carrying the new number format first, ahead of the old style an almost-whole range's left-out cells keep, so styles[0] carries the format the step wrote",
      "clearRangeWithOptions / clearRangeOnSheets with applyTo 'formats' or 'all' leave every cleared position showing Normal, as Excel does: a whole row's or column's own format is removed (or replaced by an explicit Normal where another line's format would show through; an almost-whole range's left-out cells keep their look) instead of only the stored cells being reset, so a value typed there later is plain; a formats clear that would have to write more than 2,000,000 separate cells is refused before anything is written",
      "onObjectScriptsChanged / ObjectScriptsChangedDetail.change / ObjectScriptsChangedDetail.instanceId: the BACKEND now announces OBJECT_SCRIPTS_CHANGED_EVENT itself when it moves or removes an object script, and change gains \"rebound\": the script moved to another object instance with its id, source and provenance unchanged, and instanceId names the binding it has now (null when it has none: its control went with a deleted row, column or sheet). Every re-bind is announced -- a named-range rename (by any route), a control moving with its cells (Insert / Delete Rows, Columns or Cells, on any sheet), a control moved to another cell, a sheet added, moved, deleted or copied (or an application pull's or refresh's sheet-order repair) renumbering its controls, and the undo or redo of each; the scripts a name delete prunes are announced \"deleted\"; the undo or redo of a name delete, a table delete or a Convert to Range announces each script it puts back \"saved\" and each it removes \"deleted\" (rev4B#2, rev6B#2, rev6B#5)",
      "a PivotTable's Refresh by the USER -- its right-click Refresh and PivotTable Analyze > Refresh -- ends the clipboard mode, a copy's and a cut's, once the refresh landed (round 16 [LIVE]: Excel's PivotTable.RefreshTable sets CutCopyMode to 0): AppEvents.DATA_COMMAND_APPLIED with DataCommandAppliedPayload.command \"refresh\"; a refused refresh ends nothing, and @api pivot.refreshCache / pivot.refreshAll (Excel's PivotCache.Refresh and Workbook.RefreshAll over COM, which keep it) announce nothing",
      "settledInternalClipboard() also answers null -- with the copy KEPT pending and the user told once to paste again -- when the copied cells kept changing past its bounded settle (round 16), instead of handing back a snapshot its source no longer holds; a caller tells that refusal from \"nothing is copied\" by getInternalClipboard(), which still answers the pending copy. Plain Paste checks the snapshot again right before its write, after its undo step opened. The settle itself is bounded too (round 17): a writer that writes the copied cells on every re-read (an animation, a scheduled job) no longer keeps it -- and every paste door awaiting it -- waiting for as long as it runs; it answers after a bounded number of reads -- since round 19 with the snapshot of the last re-read it made (what the source held then, as Excel pastes what the source holds at the paste [LIVE]), and null with the refusal only when no re-read of that call landed",
      "Data > Refresh Data (Collaboration, externalData:refreshData) ends the clipboard mode, a copy's and a cut's, once the refresh ran, whatever it found to refresh (round 17 [LIVE]: Excel's Data > Refresh All sets CutCopyMode to 0 even with nothing to refresh): AppEvents.DATA_COMMAND_APPLIED with DataCommandAppliedPayload.command \"refresh\"; a refresh that failed ends nothing",
      "an expand of a row or column group and showOutlineLevel also SHOW the lines hidden by hand inside the detail of every group they leave expanded, as Excel's ShowDetail / ShowLevels clear the one hidden flag a line has (round 16 [LIVE]); the lines shown are in GroupResult.hiddenRowsChanged / hiddenColsChanged, and one Ctrl+Z collapses the group and hides them again",
      "a form embedded on a sheet follows the Undo / Redo of a row or column insert or delete, an Insert / Delete Cells band and a gesture's take-back (STRUCTURAL_UNDO source \"rollback\") through @api/structuralFollow; the Undo of a delete that took its anchor puts it back on its cell (round 16)",
      "Collaboration > Open Application for Editing (AFTER_OPEN with source \"checkout\") PAYS a script's manual-calculation debt -- calculation goes back to automatic as the script's realm goes -- while File > Open still forgets it under the mode the opened file set (round 16)",
      "CellUpdateInput.moved is no longer a flag but the SOURCE cell of the move (MovedFrom: sheetIndex, row, col, or target for a floating grid's own cell), and on a sheet it is BOUND, not asserted (round 18): on a protected sheet without Format Cells the backend writes a moved cell's styleIndex only when that source cell -- read before any write of the batch, an object source on its backing sheet -- shows exactly that style; otherwise the write is a copy and its format is dropped. Core's Cut + Paste sets it for sheet and floating-grid sources",
      "GridContextMenuItem.replaces has one deterministic rule (round 18): only a SHOWING item leaves out the items it stands in for (in a chain A replaces B replaces C, A and C show), and items that replace each other in a cycle are decided by registration order -- the earliest registered shows; two items that replaced each other used to hide both",
      "canEditCells answers off the main thread and refuses a list longer than four whole columns (4 x 1,048,576 cells) with \"Too many cells to check at once...\" before it reads anything (round 18)",
      "Paste Special > Formats on a protected sheet goes silent only when the sheet's Format Cells option is what refused (Excel [LIVE]: nothing raised over unlocked cells and over locked cells inside an Allow Edit Range); any other failure of its whole-area check (a canvas sheet, an IPC error) is shown and nothing is pasted (round 18)",
      "File > Open asks about unsaved changes before the picker AND again after it when the workbook turned dirty while the picker was open (a push recording its version, a scheduled job, a script) -- workbook.open() is now workbook.pickFileToOpen() then workbook.openAtPath(path) (round 18)",
      "conditionalResultsToOverride folds a rule's hideValue (Show Bar Only / Show Icon Only) into IStyleOverride.hideValue, which every cell painter honours (the grid, its frozen and split panes, a floating grid's styled cell box): the cell's fill, borders and glyph still paint, its value does not; a data bar runs from CellConditionalFormat.dataBarAxis (when set) and, for dataBarNegative, toward the start edge in the negative colours",
      "SplitMenuButton / ColorSwatch: closing a split button's or a colour swatch's dropdown hands the keyboard focus back to the grid when the focus would otherwise be lost (on the page body), instead of leaving the keyboard nowhere",
      "canEditCells / canPerformAction: honour opts.target (CellTargetOptions) -- the protection question is asked of the OBJECT's cells (a floating grid's backing cells, gated by its host), and the can_edit_cell / can_perform_action wire carries target for the commands that act on such cells",
      "the built-in keybinding core.pasteSpecial stays Ctrl+Alt+V, and core.pasteValues (Ctrl+Shift+V, command core.clipboard.pasteValues) is new: Paste Values from the keyboard",
      "SortPivotFieldRequest / the slicer wire: a TABLE slicer's item key is the item's INVARIANT value (never its display text in the app locale), so a selection survives a locale change; an AutoFilter reads the display text from it",
      "clearRangeWithOptions takes opts.moreAreas (the other Ctrl+click blocks, cleared in the same step), and so do clearCommentsInRange / clearNotesInRange / clearHyperlinksInRange as a fifth argument; Delete over several areas is Clear Contents (formats stay)",
      "applyFormatting takes opts.moreAreas (FormattingArea[]: each block's rows and columns, one step for every area) and adjustNumberFormatDecimals opts.shownText (the text the cell SHOWS, which Excel's Increase / Decrease Decimal reads its decimals from)",
      "AutoFitContributor.measureColumn receives rows (AutoFitRowSpan[]): the rows being fitted -- AutoFit Column Width fits only the selected cells, as Excel does; absent, the whole column",
      "getAuditLog({ includeMachine: true }) (@api/collaboration) also answers this computer's trail (AuditLog.machine) -- rows no open workbook holds, such as a push whose workbook was replaced before it finished; the calp_get_audit_log wire takes includeMachine",
      "the run_design_query wire takes forReport: true for the query a REPORT runs (its FILTERS kept as the report's filter rows, never baked), so a report and its dry run read the same rows",
      "a control's container keys are a CLOSED list per control type (BUG-0491): set_control_property, set_control_metadata (the create door: paste, duplicate, insert), set_control_appearance and an objectBindings set / setLiteral refuse a non-empty container* key the type does not paint -- CONTROL_PAINTED_CONTAINER_FIELDS (@api/visualContainer) is the list, decided from the painters (a button's title, subtitle, padding and spacing; a shape's corner radius; a picture's and a navigator's subtitle and divider; a navigator's containerPadding*, whose padding is `padding`; every container key on a type with no container) -- naming the real key where one exists; a \"\" write of such a key stores nothing, and load, every .calp pull and the control's next write drop one a document still carries (a binding of one is not loaded); the Controls painters read only the listed keys",
      "applyNamedStyle / applyNamedStyleRange keep a cell's PROTECTION the way Excel's IncludeProtection does [LIVE] (rev-sec-1): every built-in style but Normal keeps each cell's Locked AND Hidden flags on any sheet; Normal and a style the user created write their own; on a protected sheet every style keeps both -- the Cell Styles gallery, a script's api.applyNamedStyle and a module macro's Calcula.applyNamedStyle alike",
      "a MODULE run's queued Calcula.applyNamedStyle (run_script, a button's code) is applied by the backend WITH the run's cells, in the run's ONE undo step, on the sheet the run had switched to -- a style that cannot be applied (a protected sheet) ends the run with every change taken back -- and it is on the audit trail only once applied; the run's deferred actions no longer carry it, and ScriptRunSuccess.formattingApplied says it happened (dispatchScriptSideEffects then re-reads the styles and repaints)",
      "validateScriptSource reads each call's policy row for the DOOR the script's own context reaches it through (rowsForDoor): a chain whose doors disagree carries one row per door (SurfaceMember.via, generated/scriptSurfacePolicy.ts), so a panel script's close() no longer needs ui.dialog (a form's does), and a sheet script's range.setValues is sheet.setRangeValues where a table script's is object.setState",
      "an approved application macro's run (owner decision B): a call its realm posts after its setup has finished is refused at once (RUN_ONLY_CALL_AFTER_THE_RUN), never admitted on the expiring grant, and a formatting call that fails part-way is still on the run's report, so a rollback counts its cells as the run's own",
      "pivot.createFieldConfig carries only the options it is given (lane miscb), so an update built from it keeps a field's own sort, subtotals, collapse state and item filter instead of resetting them to defaults",
      "clearThemeCache (@api/theme) is no longer needed after opening a file: the theme cache is dropped for every consumer on AFTER_OPEN, AFTER_NEW and THEME_CHANGED (lane miscb)",
      "mergeCells / MergeOptions.absorb: a range that partly overlaps or contains merges now merges their UNION, as Excel's Range.Merge does [LIVE] (lane miscb); the \"selection overlaps\" refusal is gone, and MergeOptions.absorb no longer changed anything (a script's api.mergeCells alike) -- round C removed it (below)",
      "createNamedRange / updateNamedRange (and every name door): an R1C1-shaped name (R, C, RC, R1C1, ...), a Lotus-style A1.B1 name and a name over 255 characters are refused, as Excel refuses them; NULL is accepted (lane miscb)",
      "the core.pasteSpecial keybinding is the ONLY source of Paste Special's key: the grid keyboard no longer hard-codes Ctrl+Alt+V, so rebinding core.pasteSpecial moves it (lane miscb)",
      "RecordedGridEvent.clearRange: clearRange (the backend clear that removes every stored cell of the rectangle, its value AND its own format -- what a row move or copy uses) is recorded as applyTo \"all\" (was \"contents\"), so a replayed recording wipes the destination formats the gesture wiped (lane miscb)",
      "a BI model's measure values follow DAX's BLANK rules (lane bic, round C): COUNT / DISTINCTCOUNT / COUNTROWS of nothing are BLANK (null), never 0; BLANK reads as 0 in + and - (SUM(x) + 1 over no rows is 1), stays BLANK in * and as a / numerator; / always answers a decimal and never fails (x / 0 is +/-Infinity, 0 / 0 NaN, where the whole query used to fail); a table transformation keeps SQL's null + 5 = null",
      "mergeCells / MergeOptions: MergeOptions.absorb and MergeOptions.keepFirstValue are REMOVED (lane tablec, round C): every merge applies Excel's value rule [LIVE] -- an empty top-left takes the first value, moved, and the backend re-points the formulas that read it -- so no caller asks for it, and Core's merge gestures no longer move the value themselves; MergeOptions is across and probe",
      "deleteTable is Excel's ListObject.Delete (lane tablec, round C [LIVE]): the table's cells go too, contents and formats, nothing around them moves, and every reference to the table -- in any cell, in another table's stored formulas, in a defined name -- becomes #REF!, as ONE undo step with its AutoFilter, object scripts and slicers; it used to keep the cells and turn the references into ranges. Table Design > Delete Table does the same, undoable, with no confirmation",
      "convertToRange (Excel's Unlist, lane tablec, round C [LIVE]): every reference to the table -- in any cell, in another table's stored formulas, in a defined name, and only ITS references in a formula that also names another table -- becomes the sheet-qualified absolute rectangle it named; the cells, their formats and the other references stay",
      "addTableRow is Excel's ListRows.Add (lane tablec, round C [LIVE]): on the active sheet the row is INSERTED -- the cells under the table, across its columns only, shift down one row, and a totals row moves down with its formulas, the new data row opening above it; it used to swallow the row under the table, or turn the old totals row into a data row still holding its SUBTOTALs. A table on another sheet is grown in place, and one with a totals row there is refused (\"Switch to the table's sheet...\")",
      "toggleTotalsRow (lanes tablefix / tablec / cfdv, rounds B-D [LIVE]): turning the totals row on lands it on the first row below the table whose cells across its columns hold nothing -- no value, formula or format -- and the occupied rows before it become data rows (it used to write over the row below); a landing on another table is refused. While no column has a totals function, Excel's defaults go in: the label \"Total\" under the first column and Sum (109) or Count (103) under the last (a one-column table gets only the function); a column's remembered constant (TableColumn.totalsRowLabel) comes back when the row is shown again",
      "setTotalsRowFunction records an undo step (lane tablec, round C); it recorded none",
      "checkTableAutoExpand (lanes tablec / cfdv / cfeval, rounds C-D [LIVE]): a cell TYPED into a totals row sets that column's totals function as Excel's does -- a constant (or a cleared cell) sets None and becomes the column's totalsRowLabel, =SUBTOTAL(n,[Col]) of that column with a totals-menu code sets that function, any other formula Custom -- in the cell edit's own undo step, and it returns the table when that changed; a value typed below a table that has a totals row no longer grows the table over it",
      "copySheet (lanes tablec / cfdv, rounds C-D [LIVE]): the copy gets a copy of every table on the source under a new name (Excel's name-plus-number rule), the copy's references to those tables re-pointed at the copies (the source's formulas untouched), and every conditional format, data validation, comment and note of the source, each with a fresh id; it copied none of them. Sheet-scoped defined names are not copied yet",
      "addConditionalFormat / updateConditionalFormat / setDataValidation refuse a rule formula or a custom validation formula that names a structured reference (Table1[Col], [@Col], Table1[#All]) with Excel's sentence, as Excel refuses them [LIVE] (lane cfdv, round D); a table's bare name stays an ordinary name there, and a list source reaches the backend only as the range the dialog resolved",
      "api.fillRange (a script's fill) refuses, before anything is written, a destination holding merged cells that are not the source band's own repeated pattern, as Excel does [LIVE] (lane pastec, round D): type \"series\" throws \"To do this, all the merged cells need to be the same size.\" (Excel's AutoFill), type \"copy\" answers { count: 0 } and changes nothing (Excel's FillDown); a drag of the fill handle refuses the same way (round C), and Ctrl+D / Ctrl+R and the module runtime's Calcula.fillDown / fillRight change nothing (round E)",
      "Paste Special names its source too (lane pastec, round D; BUG-0657): with no operation, no Transpose and Skip Blanks off, each content write carries CellUpdateInput.source (valuesOnly for the values attributes) while the copy still stands where it was copied (clipboardSourceStandsAt), so the backend writes what the source holds AT THE WRITE -- plain Paste, Cut + Paste (PasteSource.unshifted), Insert Copied Cells and drag moves have named it since round C; anything else pastes the snapshot",
      "PivotCellData.value (lanes dfcase / bie, rounds D-E [LIVE]): a value cell holding an error carries the error's canonical Excel literal (\"#DIV/0!\", \"#N/A\"; a source error showed its variant name, \"#Div0\"), and the pivot writes it into the grid as an error VALUE (ISERROR is TRUE), never text; a model measure's 1/0, -1/0 or 0/0 is \"#NUM!\", as Excel's data-model PivotTable shows it, with PivotCellData.nonFinite saying which",
    ],
  },
  {
    version: "1.6.0",
    added: [
      // ---- The drill-through definition: ONE TS shape for a chart's
      // ChartSpec.drillThrough and a BI pivot's DrillThroughBehavior.designQuery,
      // and the drill_through command's wire.
      { name: "drillKeepsFilters", module: "@api/drillThrough" },
      { name: "drillThroughDisplayName", module: "@api/drillThrough" },
      { name: "drillThroughSheetName", module: "@api/drillThrough" },
      { name: "DRILL_THROUGH_DEFAULT_SHEET_NAME", module: "@api/drillThrough" },
      { name: "DrillThroughDefinition", declaredIn: "src/api/drillThrough.ts", pattern: "export interface DrillThroughDefinition \\{" },
      { name: "DrillPresentation", declaredIn: "src/api/drillThrough.ts", pattern: "export type DrillPresentation =" },
      { name: "DrillFilterSpec", declaredIn: "src/api/drillThrough.ts", pattern: "export interface DrillFilterSpec \\{" },
      { name: "DrillThroughRequest", declaredIn: "src/api/drillThrough.ts", pattern: "export type DrillThroughRequest =" },
      { name: "DrillThroughResponse", declaredIn: "src/api/drillThrough.ts", pattern: "export type DrillThroughResponse =" },
      {
        name: "DrillThroughBehavior.designQuery",
        declaredIn: "src/api/pivotTypes.ts",
        pattern: "designQuery\\?: DrillThroughDefinition;",
      },
      // ---- Read-only on a subscribed sheet: one synchronous answer every
      // family asks (Collaboration publishes it over its provenance cache).
      { name: "registerSubscribedSheetsProvider", module: "@api/collaboration" },
      { name: "isSheetSubscribed", module: "@api/collaboration" },
      { name: "resetSubscribedSheetsProvider", module: "@api/collaboration" },
      { name: "SubscribedSheetsProvider", declaredIn: "src/api/collaboration.ts", pattern: "export interface SubscribedSheetsProvider \\{" },
      // ---- The right-clicked datum's MODEL identity (member keys, not labels).
      { name: "ChartRightClickTarget.memberPath", declaredIn: "src/api/chartData.ts", pattern: "memberPath\\?: MemberPath \\| null;" },
      {
        name: "ChartRightClickTarget.drillIdentity",
        declaredIn: "src/api/chartData.ts",
        pattern: "drillIdentity\\?: ChartDrillIdentityKind;",
      },
      { name: "ChartDrillIdentityKind", declaredIn: "src/api/chartData.ts", pattern: "export type ChartDrillIdentityKind =" },
      // ---- The Charts seam: Charts completes and checks a design-query chart
      // spec, so no caller copies its defaults.
      {
        name: "IChartStoreService.buildDesignQueryChartSpec",
        declaredIn: "src/api/componentStoreRegistry.ts",
        pattern: "buildDesignQueryChartSpec\\(req: \\{",
      },
      {
        name: "IChartStoreService.validateChartSpec",
        declaredIn: "src/api/componentStoreRegistry.ts",
        pattern: "validateChartSpec\\(fullSpec: Record<string, unknown>\\): string\\[\\];",
      },
      // ---- A resolved report filter says whether it is workbook-wide.
      { name: "ResolvedFieldFilter.workbookWide", declaredIn: "src/api/reportFilters/types.ts", pattern: "workbookWide: boolean;" },
      // ---- The temporary (drill-through result) sheet.
      { name: "SheetInfo.ephemeral", declaredIn: "src/core/lib/tauri-api.ts", pattern: "ephemeral\\?: boolean;" },
      { name: "PivotRegionData.hasDesignQueryDrill", declaredIn: "src/api/pivotTypes.ts", pattern: "hasDesignQueryDrill: boolean;" },
      { name: "keepEphemeralSheet", module: "@api/lib" },
      { name: "discardEphemeralSheet", module: "@api/lib" },
      // ---- deleteSheet names the sheet it means (a background discard renumbers sheets).
      { name: "SheetDeleteOptions.expectedSheetId", declaredIn: "src/core/lib/tauri-api.ts", pattern: "expectedSheetId\\?: string;" },
      // ---- An open edit follows its sheet by the STABLE id (a background discard renumbers sheets).
      { name: "SheetContext.activeSheetId", declaredIn: "src/core/types/types.ts", pattern: "activeSheetId\\?: string;" },
      { name: "EditingCell.sourceSheetId", declaredIn: "src/core/types/types.ts", pattern: "sourceSheetId\\?: string;" },
      { name: "findEditSheet", module: "@api/editing" },
      { name: "isExternalSessionHostSheet", module: "@api/externalEdit" },
      { name: "getExternalSessionHostName", module: "@api/externalEdit" },
      { name: "getExternalSessionHostIndex", module: "@api/externalEdit" },
      { name: "ExternalEditSession.hostSheetId", declaredIn: "src/core/lib/formulaEditTarget.ts", pattern: "readonly hostSheetId\\?: string;" },
      // ---- A save or publish refused because the sheets kept changing while it read them.
      { name: "WORKBOOK_CHANGED_WHILE_SAVING", module: "@api/backendRefusal" },
      { name: "isWorkbookChangedWhileSaving", module: "@api/backendRefusal" },
      { name: "describeBackendRefusal", module: "@api/backendRefusal" },
      { name: "CALP_PUSH_SHEET_GONE", module: "@api/backendRefusal" },
      { name: "isSheetGoneRefusal", module: "@api/backendRefusal" },
      // ---- A request by POSITION past the end of the sheet list: refused, never retried.
      { name: "CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE", module: "@api/backendRefusal" },
      { name: "isSheetIndexOutOfRangeRefusal", module: "@api/backendRefusal" },
      // ---- A toast can be taken back when what it says stops being true.
      { name: "ToastHandle", declaredIn: "src/api/notifications.ts", pattern: "export interface ToastHandle \{" },
      // ---- The publish doors take the ticked sheets by STABLE id.
      { name: "PublishSheetSelection", declaredIn: "src/api/collaboration.ts", pattern: "export interface PublishSheetSelection" },
      { name: "PublishParams.sheetIds", declaredIn: "src/api/collaboration.ts", pattern: "sheetIds\\?: string\\[\\];" },
      // ---- Which sheets a push CARRIES is Rust's answer, never the ticked rows
      // (review round 11, RV11-TS-1): a floating grid's backing sheet travels
      // with its host, and a chart's source joins the push.
      { name: "WorkingCopyDiff.carriedSheetIds", declaredIn: "src/api/collaboration.ts", pattern: "carriedSheetIds: string\\[\\];" },
    ],
    changed: [
      "activateSheet: takes an optional { record } -- record: false switches without a macro-recorder step",
      "deleteSheet: takes an optional { record, expectedSheetId } -- record: false deletes without a macro-recorder step; expectedSheetId deletes only while the sheet at that index still carries that id",
      "setActiveSheet: takes an optional { record } -- record: false switches without a macro-recorder step",
      "setSheetContext / setActiveSheet (the grid actions): take an optional trailing sheetId, stored as SheetContext.activeSheetId and cleared by a dispatch that carries none",
      "registerExternalFormulaTarget: seeds the session host's identity from session.hostSheetId, so the host helpers decide by that id from the start",
      "reportPagesFrom: leaves a temporary (ephemeral) canvas out of the report's page list",
      "showToast: returns a ToastHandle whose dismiss() takes the toast down (a no-op once it is gone, or with no renderer); a caller that ignores it behaves as before",
      "registerToastSink: takes an optional dismisser beside the sink, and a sink returns the id it gave the toast so a handle can take it back",
      "describeBackendRefusal: also strips CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE to its plain sentence; every other error is unchanged",
      "holdBackCells: takes the push's own kind and sheet selection (sheetIndices / sheetIds, as PublishParams) beside the cells, holds back only the cells on sheets that push carries, and reports the rest as cellsSkipped -- skipped, never refused; a selection naming a gone sheet is refused before anything is written, as the push would refuse it",
    ],
  },
  {
    version: "1.5.0",
    added: [
      // ---- P1: a solid background commit (owner finding G1) -----------------
      // Picking ONE colour for a visual's background clears a stored or
      // resolved gradient and switches a hidden background on, so the pick is
      // never a write that shows nothing. The Format-pane doors and chart
      // presets build their patch here; Rust's container-literal door applies
      // the same rule to script, MCP and binding writes.
      { name: "solidBackgroundPatch", module: "@api/visualContainer" },
      { name: "solidBackgroundIsNoop", module: "@api/visualContainer" },
      {
        name: "SolidBackgroundBase",
        declaredIn: "src/api/visualContainer.ts",
        pattern: "export interface SolidBackgroundBase \\{",
      },
      // ---- P3: floating grids take every Home command (owner finding G3) -----
      // A selection owner may answer the cells it holds and the KINDS of cell
      // act it admits; a door asks resolveCellTarget and acts on those cells
      // through the wrappers' explicit `{ target }` option.
      { name: "resolveCellTarget", module: "@api/cellTarget" },
      { name: "cellTargetFor", module: "@api/cellTarget" },
      { name: "CELL_TARGET_CAPABILITIES", module: "@api/cellTarget" },
      { name: "WHOLE_OBJECT_CAPABILITIES", module: "@api/cellTarget" },
      { name: "targetRefOf", module: "@api/cellTarget" },
      { name: "getCellTargetCells", module: "@api/cellTarget" },
      { name: "readTargetCell", module: "@api/cellTarget" },
      { name: "onCellTargetChanged", module: "@api/cellTarget" },
      { name: "notifyCellTargetChanged", module: "@api/cellTarget" },
      { name: "selectTargetCells", module: "@api/cellTarget" },
      { name: "editTargetCell", module: "@api/cellTarget" },
      { name: "CELL_TARGET_READ_BAND", module: "@api/cellTarget" },
      // P3 S10: the object's own line state (AutoFit, Row Height, Unhide on a
      // floating grid) and the announcement after a write changed the object.
      { name: "getCellTargetLines", module: "@api/cellTarget" },
      { name: "announceCellTargetObjectChanged", module: "@api/cellTarget" },
      // P3 S11: values, not display text, for doors that compute (Fill Series,
      // AutoSum, Flash Fill on a floating grid).
      { name: "getCellTargetCellsTyped", module: "@api/cellTarget" },
      { name: "TARGET_COMMANDS", module: "@api/cellTargetCommands" },
      {
        name: "CellTargetRef",
        declaredIn: "src/core/types/types.ts",
        pattern: "export type CellTargetRef = \\{ kind: \"floatingRange\"; id: string \\};",
      },
      {
        name: "CellTargetCells",
        declaredIn: "src/core/types/types.ts",
        pattern: "export interface CellTargetCells \\{",
      },
      {
        name: "TargetCellData",
        declaredIn: "src/core/types/types.ts",
        pattern: "export interface TargetCellData extends CellData \\{",
      },
      {
        name: "CellTargetCapability",
        declaredIn: "src/core/lib/selectionOwner.ts",
        pattern: "export type CellTargetCapability =",
      },
      {
        name: "OwnedCellTarget",
        declaredIn: "src/core/lib/selectionOwner.ts",
        pattern: "export interface OwnedCellTarget \\{",
      },
      {
        name: "CellTarget",
        declaredIn: "src/core/lib/selectionOwner.ts",
        pattern: "export type CellTarget =",
      },
      {
        name: "SelectionOwner.cellTarget",
        declaredIn: "src/core/lib/selectionOwner.ts",
        pattern: "cellTarget\\?: \\(\\) => OwnedCellTarget \\| null;",
      },
      {
        name: "SelectionOwner.actsOn",
        declaredIn: "src/core/lib/selectionOwner.ts",
        pattern: "actsOn\\?: readonly CellTargetCapability\\[\\];",
      },
      {
        name: "SelectionOwner.selectCells",
        declaredIn: "src/core/lib/selectionOwner.ts",
        pattern: "selectCells\\?: \\(selection: Selection\\) => void;",
      },
      {
        name: "SelectionOwner.editActiveCell",
        declaredIn: "src/core/lib/selectionOwner.ts",
        pattern: "editActiveCell\\?: \\(text: string\\) => boolean;",
      },
      {
        name: "CellTargetOptions",
        declaredIn: "src/core/lib/tauri-api.ts",
        pattern: "export interface CellTargetOptions \\{",
      },
      {
        name: "GridCommandContext",
        declaredIn: "src/core/lib/gridCommands.ts",
        pattern: "export interface GridCommandContext \\{",
      },
      { name: "GRID_COMMAND_CAPABILITY", module: "@api/extensions" },
      // The styled cell box and the conditional-format paint seam (P3 S7).
      { name: "paintStyledCellBox", module: "@api/cellPaint" },
      { name: "registerConditionalFormatPainter", module: "@api/conditionalFormatPaint" },
      { name: "paintConditionalFormat", module: "@api/conditionalFormatPaint" },
      // ---- P2: the app locale everywhere (owner rule G0) ----------------------
      // Rust owns the app locale; every window awaits it before its first
      // render and follows locale:changed. Display and input text go through
      // these helpers, which a shared corpus keeps identical to the engine.
      { name: "initAppLocale", module: "@api/locale" },
      { name: "getAppLocale", module: "@api/locale" },
      { name: "decimalSeparator", module: "@api/locale" },
      { name: "listSeparator", module: "@api/locale" },
      { name: "formatNumber", module: "@api/locale" },
      { name: "formatNumberWithCode", module: "@api/locale" },
      { name: "formatDate", module: "@api/locale" },
      { name: "formatDateTime", module: "@api/locale" },
      { name: "monthName", module: "@api/locale" },
      { name: "dayName", module: "@api/locale" },
      { name: "quarterLabel", module: "@api/locale" },
      { name: "parseNumber", module: "@api/locale" },
      { name: "parseDate", module: "@api/locale" },
      { name: "LOCALE_CHANGED_EVENT", module: "@api/locale" },
      { name: "INVARIANT_LOCALE", module: "@api/locale" },
      {
        name: "DateStyle",
        declaredIn: "src/core/lib/locale/localeText.ts",
        pattern: "export type DateStyle = \"short\" \\| \"long\" \\| \"time\" \\| \"dateTime\";",
      },
      {
        name: "FormatNumberOptions",
        declaredIn: "src/core/lib/locale/localeText.ts",
        pattern: "export interface FormatNumberOptions \\{",
      },
      {
        name: "LocaleSettings.overrideId",
        declaredIn: "src/core/lib/locale/localeText.ts",
        pattern: "overrideId: string \\| null;",
      },
      {
        name: "LocaleSettings.monthNamesLong",
        declaredIn: "src/core/lib/locale/localeText.ts",
        pattern: "monthNamesLong: string\\[\\];",
      },
      {
        name: "LocaleSettings.quarterLabels",
        declaredIn: "src/core/lib/locale/localeText.ts",
        pattern: "quarterLabels: string\\[\\];",
      },
      // P2 S7: ONE member shape, { key, label }. Identity from the KEY
      // (invariant: selections, filters, page filters, GETPIVOTDATA), display
      // from the LABEL (app locale). A label is never parsed into a key.
      { name: "pivotCellItemKey", module: "@api" },
      { name: "pivotCellDisplayText", module: "@api" },
      { name: "memberKeyNumber", module: "@api" },
      { name: "memberKeyDate", module: "@api" },
      { name: "memberKeys", module: "@api" },
      { name: "memberLabelOf", module: "@api" },
      {
        name: "MemberRef",
        declaredIn: "src/api/types.ts",
        pattern: "export interface MemberRef \\{",
      },
      {
        name: "PivotCellData.member",
        declaredIn: "src/api/pivotTypes.ts",
        pattern: "member\\?: MemberRef;",
      },
      {
        name: "FilterRowData.members",
        declaredIn: "src/api/pivotTypes.ts",
        pattern: "members: MemberRef\\[\\];",
      },
      {
        name: "BiColumnKind",
        declaredIn: "src/api/backend.ts",
        pattern: "export type BiColumnKind = \"number\" \\| \"date\" \\| \"dateTime\" \\| \"boolean\" \\| \"text\" \\| \"unknown\";",
      },
      {
        name: "BiQueryResult.columnKinds",
        declaredIn: "src/api/backend.ts",
        pattern: "columnKinds: BiColumnKind\\[\\];",
      },
      {
        name: "SlicerItemRenderer.item.key",
        declaredIn: "src/api/componentStoreRegistry.ts",
        pattern: "item: \\{ text: string; key: string; selected: boolean; hasData: boolean; index: number \\}",
      },
      // P2 S9: typed numbers are read in the APP locale. NumberInput is the
      // bare <input> behind NumberField (draft, strict app-locale parse,
      // ArrowUp/ArrowDown step, clamp on blur) for a caller with its own box.
      { name: "NumberInput", module: "@api/layout" },
      {
        name: "NumberInputProps",
        declaredIn: "src/api/layout/primitives/fields.tsx",
        pattern: "export interface NumberInputProps",
      },
      // ---- P4: one target-aware report-filter resolver (G2-B, G4) -----------
      // @api/reportFilters replaces @api/pageFilters. Pages are SHEET IDS; a
      // publisher's filter carries a scope (page, pages, all, visuals) and,
      // for a model slicer, its object; visuals hold cross-filter selections;
      // a page's interactions say which visual filters which; every querying
      // visual asks resolveFiltersFor(page, target, connection).
      { name: "publishReportFilters", module: "@api/reportFilters" },
      { name: "getReportFilters", module: "@api/reportFilters" },
      { name: "setCrossFilter", module: "@api/reportFilters" },
      { name: "addToCrossFilter", module: "@api/reportFilters" },
      { name: "clearCrossFilter", module: "@api/reportFilters" },
      { name: "clearCrossFilters", module: "@api/reportFilters" },
      { name: "getCrossFilters", module: "@api/reportFilters" },
      { name: "pruneCrossFilter", module: "@api/reportFilters" },
      // A family's store reload clears the selections of visuals that vanished
      // by any route (undo, script/MCP/AI removal), not only by Delete.
      { name: "pruneMissingCrossFilterSources", module: "@api/reportFilters" },
      { name: "isCrossFilterSource", module: "@api/reportFilters" },
      { name: "publishPageInteractions", module: "@api/reportFilters" },
      { name: "interactionFor", module: "@api/reportFilters" },
      { name: "resolvePageBase", module: "@api/reportFilters" },
      { name: "resolveFiltersFor", module: "@api/reportFilters" },
      { name: "isRectangular", module: "@api/reportFilters" },
      { name: "onReportFiltersChange", module: "@api/reportFilters" },
      { name: "startReportFilters", module: "@api/reportFilters" },
      {
        name: "VisualRef",
        declaredIn: "src/api/reportFilters/types.ts",
        pattern: "export type VisualRef = \\{ kind: \"chart\" \\| \"pivot\" \\| \"slicer\"; id: string \\};",
      },
      {
        name: "InteractionMode",
        declaredIn: "src/api/reportFilters/types.ts",
        pattern: "export type InteractionMode = \"filter\" \\| \"highlight\" \\| \"none\";",
      },
      { name: "MemberCoord", declaredIn: "src/api/reportFilters/types.ts", pattern: "export interface MemberCoord \\{" },
      { name: "MemberPath", declaredIn: "src/api/reportFilters/types.ts", pattern: "export type MemberPath = readonly MemberCoord\\[\\];" },
      { name: "ReportFilterScope", declaredIn: "src/api/reportFilters/types.ts", pattern: "export type ReportFilterScope =" },
      { name: "ReportFilterInput", declaredIn: "src/api/reportFilters/types.ts", pattern: "export interface ReportFilterInput \\{" },
      { name: "ReportFilter", declaredIn: "src/api/reportFilters/types.ts", pattern: "export interface ReportFilter extends" },
      { name: "CrossFilterSelection", declaredIn: "src/api/reportFilters/types.ts", pattern: "export interface CrossFilterSelection \\{" },
      { name: "ResolvedFieldFilter", declaredIn: "src/api/reportFilters/types.ts", pattern: "export interface ResolvedFieldFilter \\{" },
      { name: "ResolvedTupleFilter", declaredIn: "src/api/reportFilters/types.ts", pattern: "export interface ResolvedTupleFilter \\{" },
      { name: "ResolvedFilters", declaredIn: "src/api/reportFilters/types.ts", pattern: "export interface ResolvedFilters \\{" },
      { name: "ResolveTarget", declaredIn: "src/api/reportFilters/types.ts", pattern: "export interface ResolveTarget \\{" },
      { name: "ResolveOptions", declaredIn: "src/api/reportFilters/types.ts", pattern: "export interface ResolveOptions \\{" },
      { name: "ReportFiltersChange", declaredIn: "src/api/reportFilters/types.ts", pattern: "export interface ReportFiltersChange \\{" },
      { name: "PageInteractions", declaredIn: "src/api/reportFilters/types.ts", pattern: "export interface PageInteractions \\{" },
      // P4: which visuals read a model, and their cross-filter roles.
      { name: "registerModelVisualProvider", module: "@api/modelVisuals" },
      { name: "listModelVisuals", module: "@api/modelVisuals" },
      { name: "modelVisualOf", module: "@api/modelVisuals" },
      { name: "ModelVisualInfo", declaredIn: "src/api/modelVisuals.ts", pattern: "export interface ModelVisualInfo \\{" },
      { name: "ModelVisualProvider", declaredIn: "src/api/modelVisuals.ts", pattern: "export interface ModelVisualProvider \\{" },
      // P4: a chart mark DECLARES its part in cross-filtering (fail closed).
      { name: "chartMarkCrossFilter", module: "@api/chartMarks" },
      {
        name: "ChartMarkMeta.crossFilter",
        declaredIn: "src/api/chartMarks.ts",
        pattern: "crossFilter\\?: \\{ source: boolean; canHighlight: boolean \\};",
      },
      // P4: the canvas layout's interactions and their mirrors of Rust.
      { name: "CANVAS_INTERACTION_KINDS", module: "@api/canvasSheet" },
      { name: "CANVAS_MAX_OBJECT_REFS", module: "@api/canvasSheet" },
      {
        name: "CanvasLayout.interactions",
        declaredIn: "src/core/lib/tauri-api.ts",
        pattern: "interactions\\?: \\{",
      },
      {
        name: "PivotViewResponse.groupMembers",
        declaredIn: "src/api/pivotTypes.ts",
        pattern: "groupMembers\\?: PivotGroupMembers\\[\\];",
      },
      { name: "PivotGroupMembers", declaredIn: "src/api/pivotTypes.ts", pattern: "export interface PivotGroupMembers \\{" },
    ],
    changed: [
      // P3: the cell wrappers take a trailing `opts?: { target }` naming an
      // OBJECT's cells (fail-closed until the backend accepts it), a target is
      // never recorded by the macro recorder and drops the sheet group; and
      // SelectionOwner.refusal is asked with the capability a target-aware
      // door wanted.
      "applyFormatting",
      "adjustNumberFormatDecimals",
      "applyBorderPreset",
      "setCellRichText",
      "applyNamedStyleRange",
      "clearRangeWithOptions",
      "sortRange",
      "fillRange",
      "updateCellsBatch",
      "mergeCells",
      "unmergeCells",
      "insertRows",
      "insertColumns",
      "deleteRows",
      "deleteColumns",
      "setRowHeights",
      "setColumnWidths",
      "setRowsHidden",
      "setColsHidden",
      "goToSpecial",
      "findAll",
      "countMatches",
      "replaceAll",
      "replaceSingle",
      "addConditionalFormat",
      "updateConditionalFormat",
      "deleteConditionalFormat",
      "reorderConditionalFormats",
      "getAllConditionalFormats",
      "clearConditionalFormatsInRange",
      "announceFormattingResult",
      "SelectionOwner.refusal",
      "FloatingRangeInfo",
      "FloatingRangePatch",
      // P2: getCachedLocale is REMOVED (getAppLocale is never null);
      // getLocaleSettings returns the app locale Rust owns (no localStorage);
      // setLocale is persisted by Rust and announced to every window; the
      // LocaleSettings type gained overrideId and the calendar names.
      "getCachedLocale",
      "getLocaleSettings",
      "setLocale",
      "LocaleSettings",
      // P2 S7: the member wire. biGetColumnValues returns MemberRef[] (was
      // string[]); FilterRowData / FieldUniqueValuesResponse carry `members`
      // in place of `uniqueValues`; a slicer item renderer's `text` is the
      // display label and it gains `key`; getSlicerItemBitmap keys its cache
      // on key + text; pageFilters' includedItems are member KEYS.
      "biGetColumnValues",
      "FilterRowData",
      "FieldUniqueValuesResponse",
      "ISlicerStoreService.getCachedItems",
      "getSlicerItemBitmap",
      "PageFilterInput.includedItems",
      // P2 S9: NumberField is a TEXT box (role spinbutton) that reads and
      // shows its number in the app locale ("1,5" under de-DE; the foreign
      // "1.5" there is not reported); the Slider readout is in the app locale.
      "NumberField",
      "Slider",
      // P4: @api/pageFilters is REMOVED (not aliased) -- @api/reportFilters
      // replaces it, with pages by sheet id: publishPageFilters ->
      // publishReportFilters (a scope and a sourceRef, includedKeys),
      // getPageFilters / listPageFilterPages -> resolveFiltersFor /
      // resolvePageBase / getReportFilters, onPageFiltersChange ->
      // onReportFiltersChange.
      "@api/pageFilters",
      "publishPageFilters",
      "getPageFilters",
      "listPageFilterPages",
      "onPageFiltersChange",
      "PageFilterInput",
      "PageFilter",
    ],
  },
  {
    version: "1.4.0",
    added: [
      // ---- WP-A: reference picks on floating objects (D-PICK) ----------------
      // A floating family names the CELL a formula's reference pick takes at a
      // point of its object; Core decides the press once, before anything
      // selects, and every family without an answer is inert during a pick.
      {
        name: "OverlayRegistration.referenceAt",
        declaredIn: "src/api/gridOverlays.ts",
        pattern: "referenceAt\\?: OverlayReferenceAtFn;",
      },
      {
        name: "OverlayReferencePick",
        declaredIn: "src/api/gridOverlays.ts",
        pattern: "export type OverlayReferencePick =",
      },
      {
        name: "OverlayReferenceAtFn",
        declaredIn: "src/api/gridOverlays.ts",
        pattern: "export type OverlayReferenceAtFn = \\(context: OverlayHitTestContext\\) => OverlayReferencePick \\| null;",
      },
      { name: "referenceAtPoint", module: "@api/gridOverlays" },
      // The live pick drag's dashed preview, for the owning family to paint.
      { name: "getFloatingReferencePickPreview", module: "@api/gridOverlays" },
      { name: "onFloatingReferencePickPreviewChanged", module: "@api/gridOverlays" },
      {
        name: "FloatingReferencePickRange",
        declaredIn: "src/api/gridOverlays.ts",
        pattern: "export type FloatingReferencePickRange =",
      },
      {
        name: "FloatingReferencePickPreview",
        declaredIn: "src/api/gridOverlays.ts",
        pattern: "export interface FloatingReferencePickPreview \\{",
      },
      // THE one "is a formula picking a reference right now?" predicate.
      { name: "isFormulaReferencePickActive", module: "@api/editing" },
      // ---- WP-A: canvas pivot cells as content (D-CELLS) ---------------------
      // Copy a rectangle of the active sheet's grid (an object's inner
      // selection) exactly as Core's Copy does, and say why when it does not.
      { name: "copyCellRange", module: "@api/cellClipboard" },
      {
        name: "CellRangeCopyRequest",
        declaredIn: "src/core/hooks/useClipboard.ts",
        pattern: "export interface CellRangeCopyRequest \\{",
      },
      {
        name: "CellRangeCopyResult",
        declaredIn: "src/core/hooks/useClipboard.ts",
        pattern: "export type CellRangeCopyResult =",
      },
      // An object's INNER selection answers the Copy / Paste doors itself.
      {
        name: "ObjectSelectionProvider.innerClipboardCommand",
        declaredIn: "src/api/objectSelection.ts",
        pattern: 'innerClipboardCommand\\?\\(action: "copy" \\| "paste"\\): string \\| null;',
      },
      { name: "innerSelectionClipboardCommand", module: "@api/objectSelection" },
      // The cells the status bar aggregates instead of Core's selection.
      { name: "publishStatusBarRange", module: "@api/statusBarRange" },
      { name: "getStatusBarRange", module: "@api/statusBarRange" },
      { name: "subscribeStatusBarRange", module: "@api/statusBarRange" },
      {
        name: "StatusBarRange",
        declaredIn: "src/api/statusBarRange.ts",
        pattern: "export interface StatusBarRange \\{",
      },
      // The keybinding dispatcher's own "the browser holds a text selection" rule.
      { name: "hasDomTextSelection", module: "@api/keybindings" },
      // Why a greyed grid context-menu item is greyed (title + aria-description).
      {
        name: "GridContextMenuItem.disabledReason",
        declaredIn: "src/api/extensions.ts",
        pattern: "disabledReason\\?: string \\| \\(\\(context: GridMenuContext\\) => string \\| null\\);",
      },
    ],
    changed: [
      "Core's floating-object press: while a formula picks a reference (isFormulaReferencePickActive), a press on ANY " +
        "floating object is decided by Core before anything selects -- where the family's referenceAt answers, the press " +
        "(or a drag) inserts the reference; everywhere else, and on every family without referenceAt, it is INERT. A pick " +
        "press never calls noteObjectPress and never dispatches floatingObject:selected / floatingObject:bodyDragStart, " +
        "and the second press and the dblclick of a double-click that started as a pick are swallowed too, so a family " +
        "no longer sees presses during a pick at all",
      "clipboardDoorCommand (Home > Copy / Paste, Edit > Copy / Paste) answers an INNER selection's own command first: " +
        "the innerClipboardCommand of a provider that owns \"Clipboard\" right now, when that command is registered; " +
        "otherwise the rule is unchanged",
      "A grid context-menu item's disabledReason is resolved only while the item resolves as disabled, and shown as the " +
        "row's title and aria-description (sub-menu triggers too); the shell's GridContextMenuItem is the @api type",
    ],
  },
  {
    version: "1.3.0",
    added: [
      // ---- Excel's Home tab (2026-10-04) -------------------------------------
      // The ids the Home ribbon runs: the extension-owned ones (not core.*), and
      // the new core.* ones. Run them by id; the owner decides HOW (Seam Rule).
      { name: "ExtensionCommands", module: "@api" },
      { name: "ExtensionCommands.PROTECT_SHEET_TOGGLE", module: "@api" },
      { name: "ExtensionCommands.LOCK_CELL_TOGGLE", module: "@api" },
      { name: "ExtensionCommands.AUTOSUM", module: "@api" },
      { name: "ExtensionCommands.FILL_SERIES", module: "@api" },
      { name: "ExtensionCommands.FLASH_FILL", module: "@api" },
      { name: "ExtensionCommands.SORT_ASCENDING", module: "@api" },
      { name: "ExtensionCommands.SORT_DESCENDING", module: "@api" },
      { name: "ExtensionCommands.SORT_CUSTOM", module: "@api" },
      { name: "ExtensionCommands.FILTER_TOGGLE", module: "@api" },
      { name: "ExtensionCommands.FILTER_CLEAR", module: "@api" },
      { name: "ExtensionCommands.FILTER_REAPPLY", module: "@api" },
      { name: "ExtensionCommands.GO_TO", module: "@api" },
      { name: "ExtensionCommands.GO_TO_SPECIAL", module: "@api" },
      { name: "ExtensionCommands.GO_TO_SPECIAL_SELECT", module: "@api" },
      { name: "ExtensionCommands.FORMAT_AS_TABLE", module: "@api" },
      { name: "CoreCommands.PASTE_FORMULAS_AND_NUMBER_FORMATS", module: "@api" },
      { name: "CoreCommands.PASTE_NO_BORDERS", module: "@api" },
      { name: "CoreCommands.PASTE_KEEP_SOURCE_COLUMN_WIDTHS", module: "@api" },
      { name: "CoreCommands.PASTE_TRANSPOSE", module: "@api" },
      { name: "CoreCommands.PASTE_VALUES_AND_NUMBER_FORMATS", module: "@api" },
      { name: "CoreCommands.PASTE_VALUES_AND_SOURCE_FORMATTING", module: "@api" },
      { name: "CoreCommands.REMOVE_HYPERLINKS", module: "@api" },
      { name: "CoreCommands.INSERT", module: "@api" },
      { name: "CoreCommands.DELETE", module: "@api" },
      { name: "CoreCommands.INSERT_CELLS", module: "@api" },
      { name: "CoreCommands.DELETE_CELLS", module: "@api" },
      { name: "CoreCommands.ROW_HEIGHT", module: "@api" },
      { name: "CoreCommands.COLUMN_WIDTH", module: "@api" },
      { name: "CoreCommands.DEFAULT_WIDTH", module: "@api" },
      { name: "CoreCommands.AUTOFIT_ROW_HEIGHT", module: "@api" },
      { name: "CoreCommands.AUTOFIT_COLUMN_WIDTH", module: "@api" },
      { name: "CoreCommands.HIDE_ROWS", module: "@api" },
      { name: "CoreCommands.HIDE_COLUMNS", module: "@api" },
      { name: "CoreCommands.UNHIDE_ROWS", module: "@api" },
      { name: "CoreCommands.UNHIDE_COLUMNS", module: "@api" },
      { name: "CoreCommands.SHEET_INSERT", module: "@api" },
      { name: "CoreCommands.SHEET_DELETE", module: "@api" },
      { name: "CoreCommands.SHEET_RENAME", module: "@api" },
      { name: "CoreCommands.SHEET_HIDE", module: "@api" },
      { name: "CoreCommands.SHEET_UNHIDE", module: "@api" },
      { name: "CoreCommands.SHEET_TAB_COLOR", module: "@api" },
      { name: "CoreCommands.SHEET_MOVE_OR_COPY", module: "@api" },
      { name: "CoreCommands.INSERT_FUNCTION", module: "@api" },
      // Format Painter's state, for a button drawn pressed / locked (written by
      // the FormatPainter extension only).
      { name: "getFormatPainterState", module: "@api/formatPainterState" },
      { name: "subscribeToFormatPainterState", module: "@api/formatPainterState" },
      { name: "useFormatPainterState", module: "@api/formatPainterState" },
      { name: "publishFormatPainterState", module: "@api/formatPainterState" },
      {
        name: "FormatPainterState",
        declaredIn: "src/api/formatPainterState.ts",
        pattern: "export interface FormatPainterState \\{",
      },
      // Whether the copied cells are still what the system clipboard holds (the
      // rule plain Paste uses, for the paste variants).
      { name: "internalClipboardIsCurrent", module: "@api/cellClipboard" },
      { name: "internalClipboardMatchesSystemText", module: "@api/cellClipboard" },
      // ...and where a copy came from (Paste Link names the source sheet).
      {
        name: "ClipboardData.sourceSheetIndex",
        declaredIn: "src/core/hooks/useClipboard.ts",
        pattern: "sourceSheetIndex: number;",
      },
      {
        name: "ClipboardData.sourceSheetName",
        declaredIn: "src/core/hooks/useClipboard.ts",
        pattern: "sourceSheetName: string;",
      },
      // The fill handle's own engine (pattern detection + pending fills), so a
      // Series dialog's AutoFill is not a second implementation.
      { name: "detectPattern", module: "@api/fillPatterns" },
      { name: "generateFillValue", module: "@api/fillPatterns" },
      { name: "processPendingFills", module: "@api/fillPatterns" },
      // Navigate by reference exactly as the Name Box does (the Go To dialog).
      { name: "registerReferenceNavigator", module: "@api/referenceNavigation" },
      { name: "hasReferenceNavigator", module: "@api/referenceNavigation" },
      { name: "navigateToReference", module: "@api/referenceNavigation" },
      // The AutoFilter's state, for a Filter row drawn checked and Clear /
      // Reapply drawn enabled -- and Excel's Reapply.
      { name: "onChange", module: "@api/autoFilterService" },
      { name: "getAutoFilterStatus", module: "@api/autoFilterService" },
      { name: "publishAutoFilterStatus", module: "@api/autoFilterService" },
      {
        name: "AutoFilterStatus",
        declaredIn: "src/api/autoFilterService.ts",
        pattern: "export interface AutoFilterStatus \\{",
      },
      {
        name: "AutoFilterController.reapply",
        declaredIn: "src/api/autoFilterService.ts",
        pattern: "reapply\\(\\): Promise<AutoFilterSnapshot>;",
      },
      // The command ids a worksheet Copy / Paste door runs with a control selected.
      { name: "WORKSHEET_CONTROL_COPY_COMMAND", module: "@api/objectClipboard" },
      { name: "WORKSHEET_CONTROL_PASTE_COMMAND", module: "@api/objectClipboard" },
      // The layout kit: submenus, Excel's large and labelled splits, two-line
      // hero labels, menus hosted from the menu-bar registry, colour splits and
      // the palette body.
      { name: "MenuSub", module: "@api/layout" },
      { name: "MENU_ICON_BLANK", module: "@api/layout" },
      { name: "useMenuClose", module: "@api/layout" },
      { name: "RegisteredMenuButton", module: "@api/layout" },
      { name: "useRegisteredMenuItem", module: "@api/layout" },
      { name: "ColorPalette", module: "@api/layout" },
      { name: "SUBMENU_HOVER_DELAY_MS", module: "@api/layout" },
      { name: "HERO_LABEL_LINE_HEIGHT", module: "@api/layout" },
      { name: "HERO_PAD_Y", module: "@api/layout" },
      { name: "HERO_LABEL_GAP", module: "@api/layout" },
      { name: "HERO_TWO_LINE_GAP", module: "@api/layout" },
      { name: "HERO_TWO_LINE_PAD_Y", module: "@api/layout" },
      { name: "HERO_SPLIT_TOP_HEIGHT", module: "@api/layout" },
      { name: "HERO_SPLIT_TOP_HEIGHT_TWO_LINE", module: "@api/layout" },
      {
        name: "SplitFace",
        declaredIn: "src/api/layout/primitives/Button.tsx",
        pattern: 'export type SplitFace = "icon" \\| "labelled" \\| "hero";',
      },
      {
        name: "SplitMenuButtonProps.face",
        declaredIn: "src/api/layout/primitives/Menu.tsx",
        pattern: "face\\?: SplitFace;",
      },
      {
        name: "SplitMenuButtonProps.labelLines",
        declaredIn: "src/api/layout/primitives/Menu.tsx",
        pattern: "labelLines\\?: 1 \\| 2;",
      },
      {
        name: "CommandButtonProps.labelLines",
        declaredIn: "src/api/layout/primitives/Button.tsx",
        pattern: "labelLines\\?: 1 \\| 2;",
      },
      {
        name: "MenuSubProps",
        declaredIn: "src/api/layout/primitives/Menu.tsx",
        pattern: "export interface MenuSubProps \\{",
      },
      {
        name: "RegisteredMenuButtonProps",
        declaredIn: "src/api/layout/primitives/MenuTree.tsx",
        pattern: "export interface RegisteredMenuButtonProps \\{",
      },
      {
        name: "ColorSwatchProps.split",
        declaredIn: "src/api/layout/primitives/Color.tsx",
        pattern: "split\\?: boolean;",
      },
      {
        name: "ColorSwatchProps.onApply",
        declaredIn: "src/api/layout/primitives/Color.tsx",
        pattern: "onApply\\?: \\(\\) => void;",
      },
      {
        name: "ColorSwatchProps.chevronTestId",
        declaredIn: "src/api/layout/primitives/Color.tsx",
        pattern: "chevronTestId\\?: string;",
      },
      {
        name: "ColorSwatchProps.chevronLabel",
        declaredIn: "src/api/layout/primitives/Color.tsx",
        pattern: "chevronLabel\\?: string;",
      },
      {
        name: "ColorPopoverProps.automaticPlacement",
        declaredIn: "src/api/layout/primitives/Color.tsx",
        pattern: 'automaticPlacement\\?: "first" \\| "afterColors";',
      },
      {
        name: "ColorPopoverProps.returnFocusTo",
        declaredIn: "src/api/layout/primitives/Color.tsx",
        pattern: "returnFocusTo\\?: HTMLElement \\| null;",
      },
      // Excel's dialog launcher: the corner arrow under a ribbon group.
      {
        name: "PanelSection.dialogLauncher",
        declaredIn: "src/api/uiTypes.ts",
        pattern: "dialogLauncher\\?: PanelSectionDialogLauncher;",
      },
      {
        name: "PanelSectionDialogLauncher",
        declaredIn: "src/api/uiTypes.ts",
        pattern: "export interface PanelSectionDialogLauncher \\{",
      },
      // Backend wrappers: Increase / Decrease Decimal, border presets on grouped
      // sheets, Excel's Insert / Delete Cells.
      { name: "adjustNumberFormatDecimals", module: "@api" },
      { name: "applyBorderPresetToSheets", module: "@api" },
      { name: "insertCellsRange", module: "@api" },
      { name: "deleteCellsRange", module: "@api" },
      // Delete Sheet asks the backend whether EVERY sheet-keyed store is empty.
      { name: "isSheetBlank", module: "@api" },
      {
        name: "CellShiftResult",
        declaredIn: "src/core/types/types.ts",
        pattern: "export interface CellShiftResult \\{",
      },
      {
        name: "CellShiftOptions",
        declaredIn: "src/core/lib/tauri-api.ts",
        pattern: "export interface CellShiftOptions \\{",
      },
      {
        name: "InsertCellsShift",
        declaredIn: "src/core/types/types.ts",
        pattern: 'export type InsertCellsShift = "right" \\| "down";',
      },
      {
        name: "DeleteCellsShift",
        declaredIn: "src/core/types/types.ts",
        pattern: 'export type DeleteCellsShift = "left" \\| "up";',
      },
      // Style types now exported through @api.
      {
        name: "TextRotation",
        declaredIn: "src/core/types/types.ts",
        pattern: "export type TextRotation =",
      },
      {
        name: "AccountingLayout",
        declaredIn: "src/core/types/types.ts",
        pattern: "export interface AccountingLayout \\{",
      },
    ],
    changed: [
      "clipboardDoorCommand answers Controls' Copy / Paste (WORKSHEET_CONTROL_COPY_COMMAND / WORKSHEET_CONTROL_PASTE_COMMAND) " +
        "on a WORKSHEET with a floating control among the selected objects (Paste only while the object clipboard holds " +
        "something), the way Controls' own Ctrl+C / Ctrl+V do; a worksheet chart or slicer still gets the cell command",
      "CoreCommands.FORMAT_PAINTER_LOCK (double-click) arms the painter locked, or UPGRADES an armed one to locked -- it no " +
        "longer turns the painter off (FORMAT_PAINTER, the click, does); a lock while the painter is still reading its source " +
        "makes it arm locked",
      "CoreCommands.INSERT_ROW / INSERT_COLUMN / DELETE_ROW / DELETE_COLUMN act on the rows (columns) EVERY block of ANY " +
        "selection spans -- one cell, a range, several Ctrl+click blocks -- like Excel's Insert / Delete Sheet Rows / Columns; " +
        "they acted only on whole-row (column) selections and silently did nothing otherwise. Blocks that share a row " +
        "(column) are refused (\"Cannot use that command on overlapping selections.\"); several blocks are ONE undo step. " +
        "A gridCommands guard on them receives the whole selection, additionalRanges included, and must judge every block",
      "CoreCommands.CLEAR_COMMENTS clears notes too (Excel's Clear Comments and Notes), and CLEAR_ALL clears notes; every " +
        "clear (CLEAR_CONTENTS, CLEAR_FORMATTING, CLEAR_COMMENTS, CLEAR_HYPERLINKS, CLEAR_ALL) acts on EVERY Ctrl+click block, " +
        "not only the main range, and a range clear of comments, notes or hyperlinks records undo",
      "F5 and Ctrl+G run ExtensionCommands.GO_TO (Excel's Go To dialog). F5 used to focus the Name Box (the grid handled it) " +
        "and Ctrl+G ran Go To Special, which now has no shortcut (its dialog's Special... button and Find & Select reach " +
        "it). New built-in bindings: Ctrl+Plus / Ctrl+- run INSERT_CELLS / DELETE_CELLS (the Insert / Delete dialog, or " +
        "rows / columns straight away for whole-row / whole-column selections), Shift+F11 SHEET_INSERT, Alt+= " +
        "ExtensionCommands.AUTOSUM, Shift+F3 INSERT_FUNCTION",
      "CommandRegistry.execute forwards its args to a grid command (gridCommands.execute(name, args)), e.g. " +
        "AUTOFIT_ROW_HEIGHT { growOnly: true }; grid command handlers receive them",
      "applyFormatting: textRotation also takes \"vertical\" (stacked text) and REFUSES an unknown value (it used to clear " +
        "the rotation silently); fontSize takes half points (twips, in fact) from 1 to 409, so StyleData.fontSize may be " +
        "fractional. The script gate and the script ScriptFormat types accept the same rotations",
      "applyBorderPreset replicates to grouped sheets (as applyFormatting does) and returns only the cells it wrote; whole " +
        "rows / columns go through row / column tiers, so dispatch a grid refresh after one",
      "AccountingLayout's strings carry the sign and the padding: a minus-style negative's minus rides in `symbol` " +
        "(symbol before) or leads `value` (symbol after, drawn at the left edge); zero is \"-\" plus a digit-width space per " +
        "decimal",
      "ColorPopover speaks Excel's words (\"Theme Colors\", \"Standard Colors\", \"More Colors...\"; default accessible name " +
        "\"Colors\"), and Escape in its hex field CANCELS (it used to apply the half-typed colour)",
      "clearConditionalFormatsInRange cuts the selection out of every rule (Excel's Clear Rules from Selected Cells) and " +
        "returns the number of rules CHANGED, cut or removed; it removed nothing for a partial selection",
    ],
  },
  {
    version: "1.2.0",
    added: [
      // Taking back what an extension added (every deactivate must).
      { name: "unregisterMenu", module: "@api" },
      {
        name: "IMenuAPI.unregister",
        declaredIn: "src/api/contract.ts",
        pattern: "unregister\\(menuId: string, options\\?: \\{ keepWhileShared\\?: boolean \\}\\): void;",
      },
      { name: "ExtensionRegistry.unregisterCommand", module: "@api" },
      // Selection owners: an object that holds the selection (a floating grid's cell).
      { name: "onSelectionOwnershipChanged", module: "@api/selectionOwner" },
      { name: "notifySelectionOwnershipChanged", module: "@api/selectionOwner" },
      {
        name: "SelectionOwner.receivesTyping",
        declaredIn: "src/core/lib/selectionOwner.ts",
        pattern: "receivesTyping\\?: \\(\\) => boolean;",
      },
      // ...and a GENERIC claim that stands behind every specific one (BUG-0270).
      {
        name: "SelectionOwner.fallback",
        declaredIn: "src/core/lib/selectionOwner.ts",
        pattern: "fallback\\?: boolean;",
      },
      // ...which says each refusal ONCE while the same object stays selected (BUG-0270 review).
      {
        name: "SelectionOwner.shouldAnnounce",
        declaredIn: "src/core/lib/selectionOwner.ts",
        pattern: "shouldAnnounce\\?: \\(sentence: string\\) => boolean;",
      },
      // ...and may let one KIND of door through: Insert Shape / Button / Image while an object is selected (owner call 25).
      {
        name: "SelectionOwner.admits",
        declaredIn: "src/core/lib/selectionOwner.ts",
        pattern: "admits\\?: readonly SelectionDoorKind\\[\\];",
      },
      {
        name: "SelectionDoorKind",
        declaredIn: "src/core/lib/selectionOwner.ts",
        pattern: 'export type SelectionDoorKind = "objectInsert";',
      },
      // A user shortcut on a BARE printable key is refused, with this sentence (owner call 23).
      { name: "bareKeyShortcutRefusal", module: "@api/keybindings" },
      // The object clipboard: Copy / Paste / Duplicate of floating objects across families.
      { name: "copySelectedObjects", module: "@api/objectClipboard" },
      { name: "copyObjectsToClipboard", module: "@api/objectClipboard" },
      { name: "pasteObjectClipboard", module: "@api/objectClipboard" },
      { name: "duplicateSelectedObjects", module: "@api/objectClipboard" },
      { name: "putOnObjectClipboard", module: "@api/objectClipboard" },
      { name: "hasObjectClipboard", module: "@api/objectClipboard" },
      { name: "canvasOwnsObjectClipboard", module: "@api/objectClipboard" },
      // ...and the ONE rule every Copy / Paste door asks (wave E).
      { name: "clipboardDoorCommand", module: "@api/objectClipboard" },
      { name: "objectClipboardHasClipboardKeys", module: "@api/objectClipboard" },
      { name: "OBJECT_COPY_COMMAND", module: "@api/objectClipboard" },
      { name: "OBJECT_PASTE_COMMAND", module: "@api/objectClipboard" },
      // Undo-transaction tickets: close ONLY what your own begin opened.
      { name: "readUndoBeginAnswer", module: "@api/undoTicket" },
      { name: "ownUndoTransaction", module: "@api/undoTicket" },
      // Run a command from whichever registry holds it (not a script door).
      { name: "executeCommandAnywhere", module: "@api/commandDispatch" },
      { name: "buildCommandContext", module: "@api/commandDispatch" },
      // Release claims: a cell click acts on RELEASE over the same target, sliding off cancels (BUG-0258 phase 4).
      { name: "actOnRelease", module: "@api/cellClickInterceptors" },
      { name: "actOnCellRelease", module: "@api/cellClickInterceptors" },
      { name: "isCellReleaseClaim", module: "@api/cellClickInterceptors" },
      { name: "isCellPressed", module: "@api/cellClickInterceptors" },
      {
        name: "CellReleaseClaim",
        declaredIn: "src/core/lib/cellClickInterceptors.ts",
        pattern: "export interface CellReleaseClaim \\{",
      },
    ],
    changed: [
      "unregisterMenuItem / IMenuAPI.unregisterItem remove an item at ANY depth, and a parent left empty goes with its last child",
      "ExtensionRegistry.unregisterCommand takes the registered OBJECT, never another extension's command of the same id",
      "beginUndoTransaction resolves a ticket when it OPENED the transaction and null when it joined one; " +
        "commitUndoTransaction / cancelUndoTransaction accept that ticket and then close only that transaction",
      "ObjectSelectionKey gains \"Delete\" (bare Delete / Backspace): a provider answers ownsKey(\"Delete\") true while its OWN " +
        "door or an inner keyboard takes those keys, and the generic Delete of a selected object stands down (BUG-0270); " +
        "deleteSelectedObjects refuses on a read-only (subscribed) page",
      "shouldActOnWholeObjectSelection answers on a WORKSHEET too (a selection spanning families is deleted whole): a plain " +
        "press on a worksheet object now deselects every other family (Core calls noteWorksheetObjectPress), so such a " +
        "selection is a deliberate Ctrl/Shift one (BUG-0270 review)",
      "A cell click interceptor (registerClickInterceptor, CellTypeDefinition.onClick) may answer a press with a RELEASE " +
        "CLAIM instead of true/false: it then acts only when the press is released over the same target, and sliding off " +
        "cancels; the built-in buttons, checkbox cells and a worksheet pivot's +/-, filter buttons and loading Cancel now act on release " +
        "(BUG-0258 design phase 4)",
      "refuseIfSelectionOwned / selectionRefusalFor / getSelectionOwner take an optional door KIND (SelectionDoorKind): an owner " +
        "that admits it (SelectionOwner.admits) is skipped, every other owner still answers; the generic \"an object is " +
        "selected\" claim admits \"objectInsert\", so Insert Shape / Button / Image work while an object is selected (owner call 25)",
      "setUserKeybinding and addCustomKeybinding THROW, storing nothing, for a bare Space, Enter or printable character " +
        "(no Ctrl, Alt, Shift or Meta): the sentence is bareKeyShortcutRefusal's (owner call 23); such a binding STORED " +
        "before the rule is dropped when initKeybindings loads the bindings, said on the console",
    ],
  },
];
