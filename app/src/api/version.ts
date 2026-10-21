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
 */
export const API_VERSION = "1.5.0";

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
 */
export const API_CHANGELOG: readonly ApiChangelogEntry[] = [
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
