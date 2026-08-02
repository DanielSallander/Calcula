//! FILENAME: app/src/api/scriptHost/allowlist.ts
// PURPOSE: The tier/capability policy for every method object scripts can
//          call (design: docs/design/script-sandbox-architecture.md §5.1).
// CONTEXT: This ONE object is consumed by (1) broker dispatch, (2) the
//          transparency panel, (3) consent-dialog text — the policy users
//          see is the object the broker executes, so drift is impossible.

import {
  vAny, vNotify, vExpose, vUnexpose, vCall, vCallImport, vHook, vGetState, vSetState, vDecl, vNone,
  vHtml, vCellRef, vCellSet, vBatch, vIndex, vEvent, vCommand, vFetch, vBiQuery, vBiSql,
  vCubeValue, vCubeKpi, vCubeMembers, vBiModelInfo, vBiModelMutation,
  vBiModelValidate, vBiModelLineage, vBiModelBatch,
  vConnectorRegister, vConnectorRemove,
  vScheduleEvery, vScheduleAt, vScheduleCancel,
  vWritebackRegionId, vWritebackSaveDraft, vWritebackListSubmissions, vWritebackReview,
  vDistRegistry, vDistPackageRef, vDistNextVersion, vDistPublishPreview,
  vDistPublish, vDistPublishModel,
  vKey, vKV, vUdf, vRangeRef, vRangeWrite, MAX_RANGE_CELLS,
  vRangeFormat, vRowColOp, vDimension, vFreeze,
  vSheetName, vSheetRename, vSheetVisibility, vSortRange, vFind, vReplace,
  vObjectKind, vObjectId, vObjectAspect, vCreateChart, vCreateTable,
  vCreateNamedRange, vNamedRangeName, vCreatePivot, MAX_OBJECT_LIST,
  vDialogMessage, vDialogPrompt, vDialogForm,
  vFileExport, vFileImport, MAX_FILE_TEXT_CHARS, MAX_FILE_NAME,
  vShortcutBind, vShortcutUnbind,
  vEvaluate, MAX_EVAL_EXPRESSIONS, MAX_EVAL_EXPRESSION_CHARS,
  vFormulaRead, vFormulaWrite, vPasteRange, vPrintPdf,
  vMoveSheet, vCopySheet, vSplit,
  vAutoFilterRange, vAutoFilterColumn, vAutoFilterClear, vAutoFilterCriteria,
  MAX_AUTOFILTER_COLUMNS, MAX_AUTOFILTER_VALUES,
  type Validator,
} from "./validators";
import { MAX_DIALOG_FIELDS, MAX_DIALOG_MESSAGE } from "./scriptDialogSpec";
import { AppEvents } from "../events";
import { fileNameOf } from "../../core/lib/fileNames";
import type { CapabilityId } from "./capabilityIds";

// CapabilityId now lives in the single-source-of-truth module (capabilityIds.ts);
// re-exported here so the many existing `import { CapabilityId } from "./allowlist"`
// consumers keep working unchanged.
export type { CapabilityId };

export type Tier = "restricted" | "unlocked";
/**
 * What a method DOES, for the transparency panel and the audit ring — and, for
 * "ui" and "file", for its deadline. Those two are the classes whose completion
 * is bounded by a PERSON rather than by machine work: "ui" blocks until the user
 * answers a modal, "file" until the user picks a file in a native dialog. Both
 * get UI_DIALOG_DEADLINE_MS in protocol.ts instead of the 30s that governs
 * everything else (CLASS_DEADLINES_MS).
 *
 * "file" is its own class rather than a flavour of "ui" because the panel line a
 * user reads must not say "shows a dialog" about a method that also PUTS THEIR
 * DATA ON DISK. The picker is the mechanism; the file is the consequence.
 */
export type MethodClass = "read" | "mutate" | "emit" | "net" | "ui" | "file";

export interface MethodPolicy {
  /** Minimum tier ("restricted" = every script may call it). */
  tier: Tier;
  /** Additionally required capability grant. */
  capability?: CapabilityId;
  class: MethodClass;
  validate: Validator;
  limits?: Record<string, number>;
  /** Rendered verbatim in the transparency panel and consent UI. */
  desc: string;
}

export const ALLOWLIST: Record<string, MethodPolicy> = {
  // ---- base: every script ----
  "base.log":              { tier: "restricted", class: "emit",   validate: vAny,      desc: "Write to the script console" },
  "base.notify":           { tier: "restricted", class: "emit",   validate: vNotify,   desc: "Show a toast notification" },
  "base.expose":           { tier: "restricted", class: "emit",   validate: vExpose,   desc: "Expose a method to other scripts" },
  "base.unexpose":         { tier: "restricted", class: "emit",   validate: vUnexpose, desc: "Withdraw a method it had exposed to other scripts" },
  "base.callMethod":       { tier: "restricted", class: "emit",   validate: vCall,     desc: "Call a method exposed by another script (cross-tier requires the target to be public)" },
  // Shared libraries (design §5.3). NOT a second base.callMethod: the script
  // names an ALIAS, and the host resolves it against the import table it built
  // for THIS script from its own `// @uses` pragmas — so authority comes from
  // who the caller is, not from any value the caller holds. No capability row,
  // because the reach is exactly whatever the library realm was already granted;
  // the host additionally caps that per call by the CALLER's own grants (and
  // prompts the caller for anything it declared but was never granted).
  "base.callImport":       { tier: "restricted", class: "emit",   validate: vCallImport,
                             desc: "Call a function of a shared code library this script declared it uses" },
  "events.subscribe":      { tier: "restricted", class: "read",   validate: vHook,     desc: "Listen to its object's events" },
  // ---- own-object scope (instance pinned at mount; a script cannot name another instance) ----
  "object.getState":       { tier: "restricted", class: "read",   validate: vGetState, desc: "Read its own object's properties / selection / spec" },
  "object.setState":       { tier: "restricted", class: "mutate", validate: vSetState, desc: "Change its own object (slicer selection, shape properties, chart spec, panel badge, ...)" },
  "object.declareProperties": { tier: "restricted", class: "mutate", validate: vDecl,  desc: "Declare custom properties (shapes)" },
  "render.invalidate":     { tier: "restricted", class: "emit",   validate: vNone,     desc: "Request a re-render of its own visuals" },
  // ui.html is auto-granted for local scripts; consent-gated for distributed
  // ones (wired in Phase 4 — until then the gate is provenance-based).
  "render.setHtml":        { tier: "restricted", capability: "ui.html", class: "mutate", validate: vHtml, desc: "Render sandboxed HTML inside its shape" },
  // ---- restricted grid reach: THE SHEET CURRENTLY SHOWN ----
  //
  // WHAT "restricted" ACTUALLY CLAMPS TO, said plainly because it used to be said
  // wrongly. These rows used to advertise "its own sheet ... clamped to the bound
  // sheet". There is no bound sheet: `sheet` is a PRIMITIVE object type (one
  // script per workbook, instanceId always null — its own scaffold opens with
  // "Sheet Script (applies to ALL sheets)"), and every other object type reaches
  // this family too. The clamp the host implements — and the only one it CAN
  // implement — is the ACTIVE sheet: an omitted sheetIndex resolves to it, and
  // naming a different one is refused at the restricted tier.
  //
  // So the honest statement of the reach is "the sheet you are looking at", and
  // that is what the consent text must say. A restricted script does eventually
  // see every sheet the user visits; what it can never do is reach a sheet the
  // user is NOT looking at, which is the property the tier is actually buying.
  "sheet.getCellValue":    { tier: "restricted", class: "read",   validate: vCellRef,  desc: "Read cells on the sheet currently shown" },
  "sheet.setCellValue":    { tier: "restricted", class: "mutate", validate: vCellSet,  desc: "Write cells on the sheet currently shown" },
  // Bulk + typed I/O on the same sheet. Same reach as the single-cell rows above
  // — one call instead of one per cell, and the values keep their type + formula
  // so a read/write round-trip cannot turn a formula into text. The write also
  // lands as ONE undo step.
  "sheet.getCellData":     { tier: "restricted", class: "read",   validate: vCellRef,  desc: "Read one cell on the sheet currently shown, with its type and formula" },
  "sheet.getRangeValues":  { tier: "restricted", class: "read",   validate: vRangeRef, limits: { maxCells: MAX_RANGE_CELLS },
                             desc: "Read a block of cells on the sheet currently shown in one go (values, types and formulas)" },
  "sheet.setRangeValues":  { tier: "restricted", class: "mutate", validate: vRangeWrite, limits: { maxCells: MAX_RANGE_CELLS },
                             desc: "Write a block of cells on the sheet currently shown in one go (a single undo step)" },
  // Explicit formula read/write, clamped exactly like the two rows above. Same
  // reach as sheet.setCellValue (a formula IS cell content); what these add is
  // the R1C1 spelling, which is what makes "write this same relative formula
  // down the whole column" one line instead of a loop that rebuilds an address
  // per row.
  "sheet.getCellFormula":  { tier: "restricted", class: "read",   validate: vFormulaRead,
                             desc: "Read the formula in a cell on the sheet currently shown, in ordinary A1 form or in R1C1 form" },
  "sheet.setCellFormula":  { tier: "restricted", class: "mutate", validate: vFormulaWrite,
                             desc: "Put a formula into a cell on the sheet currently shown, written either in ordinary A1 form or in R1C1 form (pass nothing to clear it)" },
  // FORMATTING (B2). Same reach as sheet.setRangeValues — the sheet currently
  // shown — but it changes appearance instead of content, so it is strictly less
  // destructive than the write row above it.
  "sheet.setRangeFormat":  { tier: "restricted", class: "mutate", validate: vRangeFormat, limits: { maxCells: MAX_RANGE_CELLS },
                             desc: "Change how cells look on the sheet currently shown (font, colour, alignment, number format, borders)" },
  "sheet.clearRangeFormat":{ tier: "restricted", class: "mutate", validate: vRangeRef, limits: { maxCells: MAX_RANGE_CELLS },
                             desc: "Remove all formatting from a block of cells on the sheet currently shown (the values are kept)" },
  // ---- unlocked: whole-workbook reach ----
  "api.getCellValue":      { tier: "unlocked", class: "read",   validate: vCellRef,  desc: "Read any cell" },
  "api.getCellData":       { tier: "unlocked", class: "read",   validate: vCellRef,  desc: "Read any cell with its type and formula" },
  "api.getRangeValues":    { tier: "unlocked", class: "read",   validate: vRangeRef, limits: { maxCells: MAX_RANGE_CELLS },
                             desc: "Read a block of cells on any sheet in one go (values, types and formulas)" },
  "api.setCellValue":      { tier: "unlocked", class: "mutate", validate: vCellSet,  desc: "Write any cell" },
  "api.updateCellsBatch":  { tier: "unlocked", class: "mutate", validate: vBatch,    limits: { maxCells: 100_000 }, desc: "Write many cells at once" },
  "api.getSheetNames":     { tier: "unlocked", class: "read",   validate: vNone,     desc: "List sheets" },
  "api.getActiveSheet":    { tier: "unlocked", class: "read",   validate: vNone,     desc: "Read the active sheet" },
  "api.setActiveSheet":    { tier: "unlocked", class: "mutate", validate: vIndex,    desc: "Switch sheets" },
  "api.emitEvent":         { tier: "unlocked", class: "emit",   validate: vEvent,    desc: "Emit a custom app event (auto-namespaced userscript:*)" },
  "api.onEvent":           { tier: "unlocked", class: "read",   validate: vHook,     desc: "Listen for custom events (userscript:*) and a read-only set of app events" },
  "api.executeCommand":    { tier: "unlocked", class: "mutate", validate: vCommand,  desc: "Run commands flagged scriptSafe by their extension" },
  "api.beginBatch":        { tier: "unlocked", class: "mutate", validate: vAny,      desc: "Group changes for undo" },
  "api.commitBatch":       { tier: "unlocked", class: "mutate", validate: vNone,     desc: "Commit a grouped change" },
  "api.cancelBatch":       { tier: "unlocked", class: "mutate", validate: vNone,     desc: "Cancel a grouped change" },
  // ---- unlocked: formatting + structure (B2). Every row below reaches the
  //      WHOLE workbook, which is the same bar api.setCellValue already sets —
  //      no capability is involved, because none of this touches anything
  //      outside the document (no network, no disk, no other workbook). ----
  "api.setRangeFormat":    { tier: "unlocked", class: "mutate", validate: vRangeFormat, limits: { maxCells: MAX_RANGE_CELLS },
                             desc: "Change how cells look on any sheet (font, colour, alignment, number format, borders)" },
  "api.clearRangeFormat":  { tier: "unlocked", class: "mutate", validate: vRangeRef, limits: { maxCells: MAX_RANGE_CELLS },
                             desc: "Remove all formatting from a block of cells (the values are kept)" },
  "api.insertRows":        { tier: "unlocked", class: "mutate", validate: vRowColOp, desc: "Insert rows, shifting everything below them down" },
  "api.deleteRows":        { tier: "unlocked", class: "mutate", validate: vRowColOp, desc: "Delete rows, shifting everything below them up (their contents are lost)" },
  "api.insertColumns":     { tier: "unlocked", class: "mutate", validate: vRowColOp, desc: "Insert columns, shifting everything to their right" },
  "api.deleteColumns":     { tier: "unlocked", class: "mutate", validate: vRowColOp, desc: "Delete columns, shifting the rest left (their contents are lost)" },
  "api.mergeCells":        { tier: "unlocked", class: "mutate", validate: vRangeRef, desc: "Merge a block of cells into one (only the top-left value is kept)" },
  "api.unmergeCells":      { tier: "unlocked", class: "mutate", validate: vCellRef,  desc: "Split a merged block back into individual cells" },
  "api.setRowHeight":      { tier: "unlocked", class: "mutate", validate: vDimension, desc: "Change a row's height" },
  "api.setColumnWidth":    { tier: "unlocked", class: "mutate", validate: vDimension, desc: "Change a column's width" },
  "api.freezePanes":       { tier: "unlocked", class: "mutate", validate: vFreeze,   desc: "Freeze (or unfreeze) rows and columns so they stay on screen while scrolling" },
  // The other half of View ▸ Window, shipped one wave late (§6.6). Split is a
  // VIEW setting like freeze — it changes what is on screen, never a value —
  // and it is persisted per sheet by the same backend the View ribbon writes to,
  // so a script setting it and a person setting it are the same act.
  "api.splitPanes":        { tier: "unlocked", class: "mutate", validate: vSplit,
                             desc: "Split the window into scrollable panes at a row and/or column (pass nothing to remove the split)" },
  "api.addSheet":          { tier: "unlocked", class: "mutate", validate: vSheetName, desc: "Add a new sheet to the workbook" },
  "api.deleteSheet":       { tier: "unlocked", class: "mutate", validate: vIndex,    desc: "Delete a sheet and everything on it" },
  "api.renameSheet":       { tier: "unlocked", class: "mutate", validate: vSheetRename, desc: "Rename a sheet" },
  "api.setSheetVisibility":{ tier: "unlocked", class: "mutate", validate: vSheetVisibility, desc: "Show or hide a sheet" },
  // Move / copy (§2.4). Sheet CRUD shipped in B2 without them, which left the
  // commonest report-building move — "duplicate last month's sheet and rename
  // it" — impossible from a script. Same tier and no capability, for the same
  // reason as the four rows above: this is the shape of the document the script
  // already lives in, and it reaches nothing outside it.
  "api.moveSheet":         { tier: "unlocked", class: "mutate", validate: vMoveSheet,
                             desc: "Move a sheet to a different position in the tab bar" },
  "api.copySheet":         { tier: "unlocked", class: "mutate", validate: vCopySheet,
                             desc: "Duplicate a sheet — its cells, formatting and objects — as a new sheet next to it" },
  "api.sortRange":         { tier: "unlocked", class: "mutate", validate: vSortRange, desc: "Sort a block of cells by one or more columns" },
  "api.findAll":           { tier: "unlocked", class: "read",   validate: vFind,     desc: "Find every cell on the active sheet matching a search text" },
  "api.replaceAll":        { tier: "unlocked", class: "mutate", validate: vReplace,  desc: "Replace a search text everywhere on the active sheet (a single undo step)" },
  // ---- unlocked: COLUMN FILTERING / AutoFilter (§2.6). The feature has had a
  //      full UI since day one and NO script reach at all — so "filter to this
  //      month, export, clear" was a thing a person could do and a script could
  //      not. Same tier and no capability as sortRange, which is the closest
  //      relative: filtering only decides which rows are SHOWN, it changes no
  //      value, and everything it touches is inside the document.
  //
  //      TWO STRUCTURAL FACTS, both enforced elsewhere and neither re-stated as
  //      an argument here:
  //        - ACTIVE SHEET ONLY. Every backend AutoFilter command acts on the
  //          active sheet and there is no sheet parameter to pass, so these rows
  //          take none. Switch sheets first.
  //        - TABLE OWNERSHIP IS DERIVED. `Table.autoFilterId` is recomputed by
  //          Rust (relink_autofilter_owner) inside the same commands the ribbon
  //          calls. Nothing on this path sets or infers it, which is why a
  //          script cannot orphan a table's filter link.
  //
  //      The work is done through @api/autoFilterService — the feature-neutral
  //      seam the AutoFilter extension registers — so the extension's cached
  //      range, its chevron regions and the hidden-row set stay in step. With
  //      the extension disabled these REFUSE rather than filtering invisibly.
  "api.autoFilterGet":     { tier: "unlocked", class: "read",   validate: vNone,
                             desc: "Read the column filter on the sheet: which cells it covers, what each column is filtered by, and which rows it is currently hiding" },
  "api.autoFilterListValues": { tier: "unlocked", class: "read", validate: vAutoFilterColumn,
                             desc: "List the distinct values in one filtered column (with how often each occurs), so a filter can be built from them" },
  "api.autoFilterApply":   { tier: "unlocked", class: "mutate", validate: vAutoFilterRange,
                             limits: { maxColumns: MAX_AUTOFILTER_COLUMNS },
                             desc: "Turn column filtering on for a block of cells, putting filter buttons in its first row" },
  "api.autoFilterSetColumn": { tier: "unlocked", class: "mutate", validate: vAutoFilterCriteria,
                             limits: { maxValues: MAX_AUTOFILTER_VALUES },
                             desc: "Filter one column — by picking which values to keep, or by a rule like \">100\" — hiding the rows that do not match" },
  "api.autoFilterClear":   { tier: "unlocked", class: "mutate", validate: vAutoFilterClear,
                             desc: "Stop filtering one column (or all of them) and show those rows again — the filter buttons stay" },
  "api.autoFilterRemove":  { tier: "unlocked", class: "mutate", validate: vNone,
                             desc: "Turn column filtering off completely and show every row again" },
  // ---- unlocked: THE WORKSHEET-FUNCTION BRIDGE (G4). VBA's
  //      Application.WorksheetFunction: work out an answer with the 400+
  //      built-in formula functions instead of reimplementing VLOOKUP in
  //      JavaScript. It CHANGES NOTHING — the expression is evaluated against a
  //      throwaway evaluator over the live grid and the answer is handed back
  //      typed; nothing is stored, no cell is touched, and no undo entry is
  //      made. Its reach is therefore exactly api.getRangeValues' reach (read
  //      any cell), which is why it needs no capability and sits at the tier
  //      that already grants that.
  //
  //      TWO THINGS IT DELIBERATELY CANNOT REACH, both enforced in the Rust
  //      command (evaluate_formula_typed): user-defined functions are NOT
  //      resolved — a UDF body is another script's JavaScript, and resolving one
  //      here would re-enter that realm synchronously from inside a lock-held
  //      evaluation — and pivot/control sources are not wired, exactly as in the
  //      pre-existing evaluate_expressions.
  "api.evaluate":          { tier: "unlocked", class: "read",   validate: vEvaluate,
                             // Both numbers are ENFORCED by vEvaluate before the
                             // tier check. No perMinute is declared, because none
                             // is enforced — this row reaches no Rust gate, and a
                             // limit that only exists in the table is worse than
                             // no limit at all.
                             limits: { maxExpressions: MAX_EVAL_EXPRESSIONS, maxChars: MAX_EVAL_EXPRESSION_CHARS },
                             desc: "Work out the answer to a spreadsheet formula (for example a lookup or a total) without writing it into a cell — it reads cells, it never changes anything" },
  // ---- unlocked: EXPLICIT FORMULA read/write with a reference style (G4).
  //      Reading a formula was only possible as a by-product of a typed cell
  //      read, and writing one meant passing "=A1+B1" to setCellValue with no
  //      way to say which notation was meant. These two rows make both explicit
  //      and add R1C1 — VBA's FormulaR1C1 — which is how a macro writes the same
  //      relative formula into a thousand cells. Same reach as api.getCellData /
  //      api.setCellValue, which already sit at this tier: a formula is cell
  //      content, and R1C1 is a spelling of it, not a new authority.
  "api.getCellFormula":    { tier: "unlocked", class: "read",   validate: vFormulaRead,
                             desc: "Read the formula in a cell, in ordinary A1 form or in R1C1 form (empty when the cell holds a plain value)" },
  "api.setCellFormula":    { tier: "unlocked", class: "mutate", validate: vFormulaWrite,
                             desc: "Put a formula into a cell, written either in ordinary A1 form or in R1C1 form (pass nothing to clear it)" },
  // ---- unlocked: RANGE COPY / PASTE / PASTE SPECIAL (G4). VBA's Range.Copy +
  //      PasteSpecial, over ranges the script names explicitly.
  //
  //      WHAT IS NOT HERE, ON PURPOSE: any way to READ THE SYSTEM CLIPBOARD.
  //      What the user last copied may be a password or a message from another
  //      application; there is no honest scope for "let this script see it" and
  //      no consent string that would make it fair, so it is refused outright
  //      rather than sold as a capability. Copy fills a buffer belonging to the
  //      CALLING SCRIPT (host-side, per script, discarded at unmount); paste
  //      reads that buffer back. The OS clipboard and the clipboard the user's
  //      own Ctrl+V reads are never written either — a script cannot take away
  //      what somebody has in hand, and cannot use the clipboard as a way out of
  //      the app.
  "api.copyRange":         { tier: "unlocked", class: "read",   validate: vRangeRef, limits: { maxCells: MAX_RANGE_CELLS },
                             desc: "Copy a block of cells into this script's own private clipboard (nothing leaves Calcula, and what YOU copied is untouched)" },
  "api.pasteRange":        { tier: "unlocked", class: "mutate", validate: vPasteRange, limits: { maxCells: MAX_RANGE_CELLS },
                             desc: "Paste the block it copied earlier into another place on the sheet — everything, or only the values, or only the formulas (a single undo step)" },
  // ---- unlocked: WORKBOOK FILE LIFECYCLE (G1). No capability, deliberately:
  //      this is reach over the document the script already lives in and can
  //      already rewrite cell by cell — it reaches nothing ambient. What it DOES
  //      change is permanence, so the consent text says so in the words that
  //      matter ("making every change permanent"), because "close without
  //      saving" is the escape hatch a user reaches for when a script misbehaves
  //      and a script-initiated save is what takes it away.
  //
  //      WHAT IS DELIBERATELY ABSENT: open / close / new. Calcula holds ONE
  //      document, so each of those REPLACES or DISCARDS the workbook the user
  //      is looking at (fileOpen() does not even prompt on unsaved changes, and
  //      reloads the window afterwards). "Open" is worse still: a picker says
  //      "open this file" to the user, not "let this running script read this
  //      file", so the click would not be honest consent for what followed. A
  //      script may PERSIST the document it lives in; it may never replace or
  //      discard it. The legitimate need behind "open" — read a file the user
  //      chooses — is cap.fileImportText, whose consent text says exactly that.
  //
  //      Rate-limited host-side (one save per script per 5s) so a loop cannot
  //      thrash the disk, and refused while a Before-Save verdict is being
  //      collected so a script cannot save from inside its own onBeforeSave.
  "api.workbookSave":      { tier: "unlocked", class: "file", validate: vNone, limits: { minIntervalMs: 5_000 },
                             desc: "Save this workbook back to the file it came from, making every change permanent — including changes this script just made" },
  "api.workbookSaveAs":    { tier: "unlocked", class: "file", validate: vNone, limits: { minIntervalMs: 5_000 },
                             desc: "Ask you where to save a copy of this workbook (you choose the folder and the name)" },
  "api.workbookIsDirty":   { tier: "unlocked", class: "read",   validate: vNone, desc: "Check whether this workbook has unsaved changes" },
  "api.workbookFileName":  { tier: "unlocked", class: "read",   validate: vNone,
                             desc: "Read the file name of this workbook (just the name — never the folder it is in)" },
  // ---- unlocked: workbook OBJECTS (B3) — the "build a dashboard from code"
  //      surface. Same whole-workbook reach the rows above already have, so no
  //      capability is involved: charts, tables, pivots, named ranges, slicers
  //      and form controls all live INSIDE the document. (Calcula's own AI/MCP
  //      surface has had create_chart_from_spec / create_table / create_pivot /
  //      create_named_range and the matching list_* tools since C1 — these rows
  //      give a user's own script the same reach, through the frontend path.) ----
  "api.listObjects":       { tier: "unlocked", class: "read",   validate: vObjectKind, limits: { maxObjects: MAX_OBJECT_LIST },
                             desc: "List the charts, tables, pivot tables, named ranges, slicers or form controls in this workbook (names and positions, never their contents)" },
  "api.createChart":       { tier: "unlocked", class: "mutate", validate: vCreateChart,
                             desc: "Add a new chart to a sheet" },
  "api.deleteChart":       { tier: "unlocked", class: "mutate", validate: vObjectId,
                             desc: "Delete a chart" },
  "api.createTable":       { tier: "unlocked", class: "mutate", validate: vCreateTable,
                             desc: "Turn a block of cells into a table (with filter buttons and a header row)" },
  "api.deleteTable":       { tier: "unlocked", class: "mutate", validate: vObjectId,
                             desc: "Delete a table (the cells and their values are kept)" },
  "api.createNamedRange":  { tier: "unlocked", class: "mutate", validate: vCreateNamedRange,
                             desc: "Create a named range (a name that formulas can use for a block of cells)" },
  "api.deleteNamedRange":  { tier: "unlocked", class: "mutate", validate: vNamedRangeName,
                             desc: "Delete a named range (formulas using the name will break)" },
  "api.createPivot":       { tier: "unlocked", class: "mutate", validate: vCreatePivot,
                             desc: "Create a pivot table over a block of cells and lay out its fields" },
  "api.deletePivot":       { tier: "unlocked", class: "mutate", validate: vObjectId,
                             desc: "Delete a pivot table" },
  // Cross-instance object access: the same aspects a script may already use on
  // ITS OWN object (chart spec, slicer selection, pivot layout, shape
  // properties, ...), aimed at ANOTHER object by id. Restricted scripts stay
  // pinned to their own instance — only these unlocked rows can name a target.
  "api.objectGetState":    { tier: "unlocked", class: "read",   validate: vObjectAspect,
                             desc: "Read another object in this workbook (its chart spec, table cells, slicer selection, ...)" },
  "api.objectSetState":    { tier: "unlocked", class: "mutate", validate: vObjectAspect,
                             desc: "Change another object in this workbook (its chart spec, slicer selection, pivot layout, shape properties, ...)" },
  // ---- capabilities (grantable to restricted scripts via consent / JIT — Phase 4) ----
  "cap.fetch":             { tier: "restricted", capability: "net.fetch", class: "net",
                             validate: vFetch, limits: { maxResponseBytes: 5_242_880, perMinute: 10 },
                             desc: "Fetch from the granted web origins (https only, no cookies)" },
  "cap.biQuery":           { tier: "restricted", capability: "bi.query", class: "net",
                             validate: vBiQuery, limits: { maxRows: 100_000 },
                             desc: "Run read-only, model-scoped queries on this workbook's BI connections" },
  "cap.biListConnections": { tier: "restricted", capability: "bi.query", class: "read",
                             validate: vNone,
                             desc: "List this workbook's BI connections (id + name only)" },
  "cap.biSql":             { tier: "restricted", capability: "bi.sql", class: "net",
                             validate: vBiSql, limits: { maxRows: 100_000 },
                             desc: "Run read-only RAW SQL against a BI connection's database (any reachable table)" },
  // CUBE convenience over bi.query: member-expression ergonomics (same trust class).
  "cap.cubeValue":         { tier: "restricted", capability: "bi.query", class: "net",
                             validate: vCubeValue, limits: { maxRows: 100_000 },
                             desc: "Resolve a CUBE value (a measure sliced by member filters) from a BI model" },
  "cap.cubeKpi":           { tier: "restricted", capability: "bi.query", class: "net",
                             validate: vCubeKpi, limits: { maxRows: 100_000 },
                             desc: "Resolve a KPI value/goal/status from a BI model" },
  "cap.cubeMembers":       { tier: "restricted", capability: "bi.query", class: "net",
                             validate: vCubeMembers, limits: { maxRows: 100_000 },
                             desc: "List the distinct members of a BI model level (column)" },
  // ---- bi.model (model-extensibility Phase 2): governed model MUTATION.
  //      The desc strings ARE the consent text. The Rust gateway
  //      (script_bi_model) re-checks the grant, the kind set, the rate limit,
  //      and the read-only-subscribed rule authoritatively; every mutation
  //      lands on the user's model undo stack. ----
  "cap.biModelInfo":       { tier: "restricted", capability: "bi.model", class: "read",
                             validate: vBiModelInfo,
                             desc: "Read this workbook's BI model definitions (tables, measures, relationships — never security roles or connection targets)" },
  "cap.biModelUpsert":     { tier: "restricted", capability: "bi.model", class: "mutate",
                             validate: vBiModelMutation, limits: { perMinute: 30 },
                             desc: "Create or update BI model definitions (measures, calc columns, relationships, hierarchies, KPIs, ...) — undoable; never security roles, connections or credentials" },
  "cap.biModelDelete":     { tier: "restricted", capability: "bi.model", class: "mutate",
                             validate: vBiModelMutation, limits: { perMinute: 30 },
                             desc: "Delete BI model definitions (measures, calc columns, relationships, hierarchies, KPIs, ...) — undoable; never security roles, connections or credentials" },
  // The gateway's other two action families. READS go in their own Rust rate
  // bucket (120/min) so a spent mutation budget can never block the diagnostic
  // that explains why an edit failed; BATCH is the atomicity primitive — many
  // edits, one undo entry — and buys no extra budget (batchBegin itself costs
  // one mutation token, and every edit inside still costs one).
  "cap.biModelValidate":   { tier: "restricted", capability: "bi.model", class: "read",
                             validate: vBiModelValidate, limits: { perMinute: 120 },
                             desc: "Check a BI measure, context or the whole model for errors before changing it (read-only; privileged details are stripped from the answer)" },
  "cap.biModelLineage":    { tier: "restricted", capability: "bi.model", class: "read",
                             validate: vBiModelLineage, limits: { perMinute: 120 },
                             desc: "Trace what a BI measure is built from and what would break if it were deleted (read-only; security roles are counted, never named)" },
  "cap.biModelBatch":      { tier: "restricted", capability: "bi.model", class: "mutate",
                             validate: vBiModelBatch, limits: { perMinute: 30 },
                             desc: "Group several BI model changes so they land — or roll back — together as one undo step" },
  // ---- bi.connector (model-extensibility Phase 3): script-fed data sources.
  //      Register/remove go through here (consent names the reach: "feeds
  //      external data into your BI model"); the FEED cycle is host-driven
  //      (the trusted connector host calls the script's exposed fetchTable and
  //      hands rows to the Rust bi_script_source gate, which re-checks the
  //      grant + caps volume). Secrets are slot-named, injected server-side
  //      inside the net-fetch gate — never readable by the script. ----
  "cap.connectorRegister": { tier: "restricted", capability: "bi.connector", class: "mutate",
                             validate: vConnectorRegister,
                             desc: "Register itself as a data connector feeding external data into this workbook's BI model (undoable; scheduled refresh only after consent)" },
  "cap.connectorRemove":   { tier: "restricted", capability: "bi.connector", class: "mutate",
                             validate: vConnectorRemove,
                             desc: "Remove its own data connector (and the model tables it feeds)" },
  // ---- schedule: the Application.OnTime replacement. A job invokes a method
  //      the script itself EXPOSED (context.expose) — reusing the connector
  //      host's callExposedMethod path exactly, so there is no second way for
  //      a timer to enter a script realm.
  //
  //      WHAT MAKES THIS CAPABILITY DIFFERENT: its effects OUTLIVE the session
  //      that consented to them. Jobs are persisted in the workbook, so this is
  //      the one capability where "I allowed it once" can mean "it runs again
  //      next month". Rust therefore re-checks the grant at every firing, and
  //      the consent string names both the authority ("without you starting
  //      it") and its honest limit ("while Calcula is open" — there is no
  //      headless runtime, by design).
  //
  //      `list` and `cancel` are deliberately class "read"/"mutate" with NO
  //      elevated tier: a script must always be able to see and stop its own
  //      schedule, and the user can do the same from the transparency panel. ----
  "cap.scheduleEvery":     { tier: "restricted", capability: "schedule", class: "mutate",
                             validate: vScheduleEvery, limits: { perMinute: 30 },
                             desc: "Run one of its own methods over and over on a timer, even after you reopen this workbook (never more often than every 30 seconds, and only while Calcula is open)" },
  "cap.scheduleAt":        { tier: "restricted", capability: "schedule", class: "mutate",
                             validate: vScheduleAt, limits: { perMinute: 30 },
                             desc: "Run one of its own methods at a set time each day, even after you reopen this workbook (only while Calcula is open at that time)" },
  "cap.scheduleList":      { tier: "restricted", capability: "schedule", class: "read",
                             validate: vNone, limits: { perMinute: 60 },
                             desc: "List the schedules it has set up in this workbook" },
  "cap.scheduleCancel":    { tier: "restricted", capability: "schedule", class: "mutate",
                             validate: vScheduleCancel, limits: { perMinute: 60 },
                             desc: "Cancel one of its own schedules" },
  // ---- distribution.writeback: fill in and SEND the input cells of a
  //      subscribed .calp package — the automation half of the collection loop
  //      (bulk form-fill, validate-then-submit, a review bot). Every row
  //      dispatches into the Rust script_writeback gateway, which re-checks the
  //      grant and then calls the SAME calp_* command the interactive UI calls,
  //      so a script's draft is judged by the same schema, lifecycle and
  //      ownership rules as a person's keystroke.
  //
  //      THE SPLIT THAT MATTERS: the first five rows are the SUBSCRIBER side
  //      (your own answers). The last two are the PUBLISHER side — they read
  //      other people's submitted data and decide its fate — and Rust gates
  //      them on Ed25519 key possession over the signed package manifest, so
  //      holding the capability is NOT enough. Their desc says so plainly. ----
  "cap.writebackListRegions": { tier: "restricted", capability: "distribution.writeback", class: "read",
                             validate: vNone, limits: { perMinute: 60 },
                             desc: "List the input areas a subscribed package asks you to fill in (where they are and what kind of value they expect)" },
  "cap.writebackGetLayer": { tier: "restricted", capability: "distribution.writeback", class: "read",
                             validate: vNone, limits: { perMinute: 60 },
                             desc: "Read the answers you have entered so far and whether each one is unsent, sent, approved or rejected" },
  "cap.writebackSaveDraft":{ tier: "restricted", capability: "distribution.writeback", class: "mutate",
                             validate: vWritebackSaveDraft, limits: { perMinute: 240 },
                             desc: "Fill in one input cell of a subscribed package (checked against the publisher's rules, and sent straight away if the package asks for that)" },
  "cap.writebackSubmit":   { tier: "restricted", capability: "distribution.writeback", class: "net",
                             validate: vWritebackRegionId, limits: { perMinute: 12 },
                             desc: "Send your filled-in answers for one input area to the publisher — they leave this machine and you cannot take them back" },
  "cap.writebackPreview":  { tier: "restricted", capability: "distribution.writeback", class: "read",
                             validate: vWritebackRegionId, limits: { perMinute: 60 },
                             desc: "See exactly which values would leave this machine, and to whom, before anything is sent" },
  "cap.writebackListSubmissions": { tier: "restricted", capability: "distribution.writeback", class: "read",
                             validate: vWritebackListSubmissions, limits: { perMinute: 60 },
                             desc: "Read what EVERY respondent submitted — their answers and their names — for an area you publish (only possible if this workbook can sign that package)" },
  "cap.writebackReview":   { tier: "restricted", capability: "distribution.writeback", class: "net",
                             validate: vWritebackReview, limits: { perMinute: 12 },
                             desc: "Approve or reject somebody else's submitted answer for an area you publish, changing what everyone downstream sees (only possible if this workbook can sign that package)" },
  // ---- distribution.subscribe (INBOUND) + distribution.publish (OUTBOUND):
  //      the .calp package loop, automated. Every row dispatches into the Rust
  //      `script_distribution` gateway, which re-checks the ROW'S OWN capability
  //      grant, refuses any registry the user has not already configured,
  //      demands Ed25519 publisher-key possession before a registry write, and
  //      then calls the SAME calp_* command the interactive UI calls — so a
  //      scripted pull is verified identically to a human's (signature, TOFU
  //      pin, per-artifact SHA-256, min_app_version) and a scripted publish is
  //      signed with the same key.
  //
  //      TWO CAPABILITIES, NOT ONE, because they are different risk classes:
  //      publishing puts the USER'S NAME on content OTHER PEOPLE will run;
  //      pulling puts OTHER PEOPLE'S CODE in front of the user. Consent text
  //      that had to cover both would describe neither honestly.
  //
  //      WHY EVERY ROW IS "unlocked" TIER — this is a security property, not a
  //      classification detail. A DISTRIBUTED script is forced to the restricted
  //      tier at pull (calp::pull stamps Restricted + Distributed), so the tier
  //      gate makes this whole family unreachable from code that arrived in a
  //      package. That is deliberate: a package whose scripts could pull further
  //      packages is a self-propagating code channel, and no consent prompt can
  //      make that safe. A distributed report that wants fresh content asks the
  //      user to press Refresh. Beyond that, `pull` appends sheets to the
  //      WORKBOOK and `publish` reads EVERY sheet and sends it off the machine,
  //      which is whole-workbook reach by the same standard api.setCellValue is
  //      held to.
  //
  //      THE ONE THING NONE OF THESE ROWS CAN DO: consent. A pulled object
  //      script lands unmounted and consent-gated; module scripts and notebooks
  //      land inert. These methods move DATA, never permission — including when
  //      a refresh replaces the CALLING script's own package (its consent is
  //      keyed by source hash, so a changed script re-prompts and does not run).
  "cap.pkgListRegistries": { tier: "unlocked", capability: "distribution.subscribe", class: "read",
                             validate: vNone, limits: { perMinute: 60 },
                             desc: "See which package registries you have set up on this machine" },
  "cap.pkgListSubscriptions": { tier: "unlocked", capability: "distribution.subscribe", class: "read",
                             validate: vNone, limits: { perMinute: 60 },
                             desc: "See which packages this workbook is subscribed to, and which version of each" },
  "cap.pkgBrowse":         { tier: "unlocked", capability: "distribution.subscribe", class: "net",
                             validate: vDistRegistry, limits: { perMinute: 20 },
                             desc: "List the packages available in one of the registries you have set up" },
  "cap.pkgInspect":        { tier: "unlocked", capability: "distribution.subscribe", class: "net",
                             validate: vDistPackageRef, limits: { perMinute: 20 },
                             desc: "Look inside a published package before taking it — its sheets, its data sources and every script it carries — without bringing anything in" },
  "cap.pkgPull":           { tier: "unlocked", capability: "distribution.subscribe", class: "net",
                             validate: vDistPackageRef, limits: { perMinute: 6 },
                             desc: "Bring somebody else's published package into this workbook — its sheets, data and any code it carries (the code stays switched off until you say yes, and only registries you already added can be used)" },
  "cap.pkgRefreshPreview": { tier: "unlocked", capability: "distribution.subscribe", class: "net",
                             validate: vNone, limits: { perMinute: 20 },
                             desc: "Check whether newer versions of the packages you subscribe to are available, and what would change" },
  "cap.pkgRefreshApply":   { tier: "unlocked", capability: "distribution.subscribe", class: "net",
                             validate: vNone, limits: { perMinute: 6 },
                             desc: "Update every package this workbook subscribes to, bringing in the publishers' newest content (any script whose code changed is switched off again until you re-approve it)" },
  "cap.pkgPublishPreview": { tier: "unlocked", capability: "distribution.publish", class: "read",
                             validate: vDistPublishPreview, limits: { perMinute: 60 },
                             desc: "Work out what publishing this workbook would ship, and what it would leave behind, without sending anything" },
  "cap.pkgNextVersion":    { tier: "unlocked", capability: "distribution.publish", class: "net",
                             validate: vDistNextVersion, limits: { perMinute: 20 },
                             desc: "Ask a registry what the next version number of one of your packages would be" },
  "cap.pkgPublish":        { tier: "unlocked", capability: "distribution.publish", class: "net",
                             validate: vDistPublish, limits: { perMinute: 3 },
                             desc: "Publish this workbook to one of your registries as a new version, signed with YOUR publisher key, where everyone subscribed to it will receive it — this leaves the machine and cannot be taken back (only possible if you have published something yourself before)" },
  "cap.pkgPublishModel":   { tier: "unlocked", capability: "distribution.publish", class: "net",
                             validate: vDistPublishModel, limits: { perMinute: 3 },
                             desc: "Publish one of your BI models to one of your registries as a new version, signed with YOUR publisher key (schema only — no data and no credentials travel)" },
  // ---- ui.dialog (B4): ask the user a question and branch on the answer —
  //      the VBA MsgBox / InputBox / UserForm shape, which until now no script
  //      surface had (base.notify is one-way; render.setHtml only paints inside
  //      a shape, so workbook/sheet/button/table scripts had nothing at all).
  //      Restricted tier + a capability, because a modal is AMBIENT reach: it
  //      seizes the user's attention and collects their keystrokes, which is
  //      outside the document no matter which sheet the script lives on.
  //      The dialog is painted by TRUSTED host code from a declarative spec —
  //      no markup crosses, so there is no phishing surface and no second
  //      sandbox; the header always names the asking script. ----
  "cap.dialogAlert":       { tier: "restricted", capability: "ui.dialog", class: "ui",
                             validate: vDialogMessage, limits: { maxMessageChars: MAX_DIALOG_MESSAGE },
                             desc: "Interrupt you with a message it wants you to read, and wait until you close it" },
  "cap.dialogConfirm":     { tier: "restricted", capability: "ui.dialog", class: "ui",
                             validate: vDialogMessage, limits: { maxMessageChars: MAX_DIALOG_MESSAGE },
                             desc: "Ask you a yes/no question and act on your answer" },
  "cap.dialogPrompt":      { tier: "restricted", capability: "ui.dialog", class: "ui",
                             validate: vDialogPrompt, limits: { maxMessageChars: MAX_DIALOG_MESSAGE },
                             desc: "Ask you to type something in and read what you typed" },
  "cap.dialogForm":        { tier: "restricted", capability: "ui.dialog", class: "ui",
                             validate: vDialogForm, limits: { maxFields: MAX_DIALOG_FIELDS },
                             desc: "Ask you to fill in a small form (text, numbers, dates, choices, checkboxes) and read your answers" },
  // ---- file.picker (G1): the sanctioned tail of "export a CSV" / "read the
  //      config the user picks". Excel's answer was FileSystemObject — a path
  //      string and unbounded reach. This is the opposite construction: the
  //      script names a FILE NAME and hands over CONTENT, the HOST opens a
  //      native picker, the HUMAN chooses the file, and the host does the I/O.
  //      A path never travels in either direction, so there is nothing for a
  //      hostile script to aim: no fixed target, no traversal, no enumeration,
  //      and no way to touch a file the user did not just select by hand.
  //      Class "file" (person-bounded deadline; see MethodClass above). ----
  "cap.fileExportText":    { tier: "restricted", capability: "file.picker", class: "file",
                             validate: vFileExport,
                             limits: { maxChars: MAX_FILE_TEXT_CHARS, maxNameChars: MAX_FILE_NAME },
                             desc: "Ask you where to save a text file it has produced (you choose the folder and the name; it is never told where anything on your computer is)" },
  "cap.fileImportText":    { tier: "restricted", capability: "file.picker", class: "file",
                             validate: vFileImport,
                             limits: { maxChars: MAX_FILE_TEXT_CHARS },
                             desc: "Ask you to pick a text file and read what is inside it (only the one file you pick, and only its contents and its name)" },
  // PRINTING (G4), and the only shape of it that can be honest. The script
  // supplies a FILE NAME and NOTHING ELSE — no bytes, no page setup, no range —
  // and the HOST renders the PDF from the workbook's own print settings through
  // the same generatePdf(getPrintData()) path File > Export to PDF uses, then
  // opens the same picker cap.fileExportText opens. So this adds no reach at all
  // beyond that row: it is "save a file the user chooses", where the file's
  // CONTENTS are produced by trusted code rather than by the caller.
  //
  // Sending to a real PRINTER is deliberately absent, not deferred: the only
  // implementation opens a pop-up window and calls window.print(), which needs a
  // window, can be silently blocked, and reports nothing back — a call that may
  // do nothing and can never say so is exactly the kind of API this program has
  // twice shipped by accident. See app/src/api/printService.ts.
  "cap.filePrintPdf":      { tier: "restricted", capability: "file.picker", class: "file",
                             // No perMinute: every call opens a picker the user
                             // has to drive, which is a firmer rate limit than any
                             // number here, and an unenforced one would be a lie.
                             validate: vPrintPdf, limits: { maxNameChars: MAX_FILE_NAME },
                             desc: "Turn the sheet you would print into a PDF and ask you where to save it (you choose the folder and the name; it is never told where anything on your computer is)" },
  // ---- ui.shortcut (G2): the Application.OnKey replacement. A script binds
  //      ONE combination to a method it already published with context.expose,
  //      and pressing those keys calls it — through callExposedMethod, the same
  //      door a scheduled job and a cross-script call use, so a keystroke can
  //      never reach anything an ordinary call could not.
  //
  //      WHY A CAPABILITY AND NOT JUST A TIER. Every other row on this table
  //      answers "what may it touch?". This one answers something different: it
  //      INTERCEPTS the user. Binding a key is not workbook reach — nothing in
  //      the document changes — but it puts a script between a person and their
  //      keyboard, which is outside the document by any reading, and it is the
  //      primitive VBA handed out for free (`Application.OnKey "^s"` silently
  //      takes Ctrl+S, with no record that it happened). So it is gated exactly
  //      like ui.dialog, which seizes the user's ATTENTION: restricted tier plus
  //      a consented capability, because a script that merely wants to be
  //      triggered by a button should not be paying for a key hook, and a script
  //      that does want one should have had to say so out loud.
  //
  //      Everything that makes it safe is structural and lives in
  //      app/src/api/keybindings.ts, not in this row: the combination must be
  //      Ctrl+Shift+<letter> (so typing, Escape, Tab, arrows, F1-F12 and the
  //      Ctrl+<key> space the grid owns are unreachable BY SHAPE), a taken
  //      combination is refused rather than overridden, the app wins any later
  //      tie, the binding appears in the shortcut list, and unmount takes it
  //      back. The handler is told `{ combo }` and nothing else — there is no
  //      key stream, so this can never become a keylogger.
  //
  //      Class "mutate": it changes host state (the shortcut list) and returns
  //      immediately. NOT class "ui" — that class carries the five-minute
  //      person-length deadline for a modal a human is reading, and nothing
  //      here waits on a human. ----
  "cap.shortcutBind":      { tier: "restricted", capability: "ui.shortcut", class: "mutate",
                             validate: vShortcutBind,
                             // maxShortcuts mirrors MAX_SCRIPT_KEYBINDINGS_PER_SCRIPT in
                             // ../keybindings, which ENFORCES it. Written as a literal
                             // rather than imported because this table is bundled by the
                             // typings generator, and keybindings.ts drags the command
                             // registry (and the grid) in with it; a test pins the two
                             // numbers together instead.
                             limits: { perMinute: 30, maxShortcuts: 8 },
                             desc: "Take over one Ctrl+Shift+letter keyboard shortcut, so pressing it runs one of its own methods (it cannot take a shortcut anything else uses, it cannot take the keys Calcula needs, and it never sees anything else you type)" },
  "cap.shortcutUnbind":    { tier: "restricted", capability: "ui.shortcut", class: "mutate",
                             validate: vShortcutUnbind, limits: { perMinute: 60 },
                             desc: "Give back one of the keyboard shortcuts it took" },
  "cap.shortcutList":      { tier: "restricted", capability: "ui.shortcut", class: "read",
                             validate: vNone, limits: { perMinute: 60 },
                             desc: "List the keyboard shortcuts it has taken" },
  "cap.storageGet":        { tier: "restricted", capability: "storage", class: "read",
                             validate: vKey, desc: "Read script-private data stored in the workbook" },
  "cap.storageSet":        { tier: "restricted", capability: "storage", class: "mutate",
                             validate: vKV, limits: { maxBytes: 262_144 },
                             desc: "Store script-private data in the workbook (quota 256 KB)" },
  // ---- formula UDF (Wave 3 / C1): a registered user-defined function invoked
  //      from a worksheet formula. Restricted-tier + the formula.udf capability,
  //      so a distributed script's UDFs cannot run without package consent; the
  //      JS impl executes in its owning script's realm through this one method,
  //      giving the same audit + R19 ceiling every other privileged call gets. ----
  "formula.udf.invoke":    { tier: "restricted", capability: "formula.udf", class: "read",
                             validate: vUdf, limits: { maxArgs: 255 },
                             desc: "Evaluate a registered user-defined formula function" },
  // ---- worker-realm extensions (Wave 3 / S8-C7 Phase B): a distributed
  //      extension running sandboxed in a worker reaches the host ONLY through
  //      these restricted-tier methods, audited like every other broker call.
  //      (Capability-bearing reach — net/storage — uses the cap.* rows above.) ----
  "ext.notify":            { tier: "restricted", class: "emit",   validate: vNotify,  desc: "Show a toast notification" },
  "ext.log":               { tier: "restricted", class: "emit",   validate: vAny,     desc: "Write to the extension console" },
  "ext.executeCommand":    { tier: "restricted", class: "mutate", validate: vCommand, desc: "Run a command flagged scriptSafe by its extension" },
  "ext.emitEvent":         { tier: "restricted", class: "emit",   validate: vEvent,   desc: "Emit a custom app event (auto-namespaced userscript:*)" },
  // Upkeep for the cell-styling contribution: throw away the styles this
  // extension's own contributor produced so the next paint asks it again. It
  // names no target — the host scopes it to the caches that extension created —
  // so it buys refresh, never reach.
  "ext.invalidateCellStyles": { tier: "restricted", class: "emit", validate: vNone,
                             desc: "Re-ask its own cell-styling contributor for the colours of the cells on screen" },
};

/**
 * App events that unlocked scripts may subscribe to RAW (read-only
 * notifications). Anything else passed to api.onEvent is treated as a custom
 * name and force-namespaced to userscript:* — symmetric with api.emitEvent,
 * so scripts can never observe (or forge) internal control events.
 */
export const SCRIPT_SUBSCRIBABLE_APP_EVENTS: ReadonlySet<string> = new Set([
  AppEvents.SHEET_CHANGED,
  AppEvents.CELL_VALUES_CHANGED,
  AppEvents.SELECTION_CHANGED,
  AppEvents.AFTER_OPEN,
  AppEvents.AFTER_SAVE,
  AppEvents.AFTER_NEW,
  AppEvents.THEME_CHANGED,
  AppEvents.EDIT_STARTED,
  AppEvents.EDIT_ENDED,
  AppEvents.ROWS_INSERTED,
  AppEvents.ROWS_DELETED,
  AppEvents.COLUMNS_INSERTED,
  AppEvents.COLUMNS_DELETED,
  AppEvents.ROW_RESIZED,
  AppEvents.COLUMN_RESIZED,
  AppEvents.BI_MODEL_CHANGED,
  AppEvents.BI_REFRESH_COMPLETED,
  // Sheet COLLECTION changes (B5). A script that maintains an index sheet, or
  // rebinds when a report sheet is renamed, previously had no way to notice.
  AppEvents.SHEET_ADDED,
  AppEvents.SHEET_DELETED,
  AppEvents.SHEET_RENAMED,
  // "The workbook is settled" — the point at which derived values are safe to
  // read in bulk.
  AppEvents.RECALCULATION_COMPLETED,
  // Report-distribution lifecycle. Payload is THINNED for sandboxed
  // subscribers (see thinAppEventForScripts).
  AppEvents.PACKAGE_UPDATED,
  // A writeback submission arrived for a region THIS workbook publishes (§5.5).
  //
  // Two things are true at once here and both matter. It is SAFE TO SUBSCRIBE:
  // the thinned payload is { regionId, count } and nothing else, so a sandboxed
  // script learns that answers arrived and never learns whose or what — the
  // answers stay behind cap.writebackListSubmissions, which Rust gates on
  // Ed25519 key possession per call. And it is NOT FREE: subscribing is what
  // STARTS the publisher-inbox poll in @api/distribution.ts (nothing pushes into
  // this process when somebody else's machine appends to a registry). The poll
  // is demand-driven, one pass a minute, bounded to regions this machine can
  // prove it publishes, and disclosed by getSubmissionWatchStatus().
  AppEvents.WRITEBACK_SUBMISSION_RECEIVED,
]);

/**
 * The app events whose payload carries CELL CONTENTS rather than only
 * coordinates — i.e. the events that are a DELIVERY of workbook data, not a
 * notification about it.
 *
 * This set exists because the reach of a subscription is invisible from its
 * name: "cell-values-changed" sounds like a coordinate ping, and it actually
 * carries `oldValue`, `newValue` and `formula` for every cell in a paste, a
 * fill or a whole-column edit. A subscriber to that has been shown the
 * workbook's contents just as surely as a cell-style contributor has — which
 * is why the grid.read gate covers both and not only the one that was easy to
 * see. Exported so a test can pin it against the payload shapes in events.ts.
 */
export const APP_EVENTS_CARRYING_CELL_CONTENTS: ReadonlySet<string> = new Set([
  // { changes: [{ row, col, sheetIndex?, oldValue?, newValue, formula? }], source }
  AppEvents.CELL_VALUES_CHANGED,
  // { row, col, sheetIndex, value, committed } — `value` is what the user typed.
  AppEvents.EDIT_ENDED,
]);

/**
 * Strip the CONTENTS out of a cell-content-carrying payload, keeping WHERE and
 * WHEN. A subscriber without grid.read still learns that A1:C40 changed and can
 * invalidate whatever it caches; it does not learn what the cells say.
 *
 * Rebuilt field-by-field rather than deleted key-by-key, so a field added to the
 * payload later is absent here by default instead of leaking by default.
 */
function redactCellContents(eventName: string, payload: unknown): unknown {
  if (eventName === AppEvents.CELL_VALUES_CHANGED) {
    const p = (payload ?? {}) as { changes?: unknown; source?: unknown };
    const changes = Array.isArray(p.changes) ? p.changes : [];
    return {
      changes: changes.map((c) => {
        const change = (c ?? {}) as { row?: unknown; col?: unknown; sheetIndex?: unknown };
        return { row: change.row, col: change.col, sheetIndex: change.sheetIndex };
      }),
      source: p.source,
      /** Told plainly, so an author debugging "where did newValue go?" is not
       *  left guessing, and so the absence can never be mistaken for "nothing
       *  changed". */
      redacted: "grid.read",
    };
  }
  // EDIT_ENDED: everything except `value`.
  const p = (payload ?? {}) as {
    row?: unknown;
    col?: unknown;
    sheetIndex?: unknown;
    committed?: unknown;
  };
  return {
    row: p.row,
    col: p.col,
    sheetIndex: p.sheetIndex,
    committed: p.committed,
    redacted: "grid.read",
  };
}

/**
 * The workbook-lifecycle events whose raw payload is `{ path }` — the FULL
 * filesystem path of the file that was opened or saved.
 *
 * These are subscribable by sandboxed code (they are in
 * SCRIPT_SUBSCRIBABLE_APP_EVENTS above, and workbook.onOpen / onAfterSave wire
 * them for every mounted object script and worker add-in), and the path was
 * crossing untouched — with NO capability behind it. That is the exact leak
 * `api.workbookFileName` refuses by hand: "C:\Users\<real name>\Consulting\
 * ClientX" handed to a script that also holds net.fetch is an exfiltration the
 * fetch consent never covered, and a sandboxed caller has no path-taking API to
 * feed it to anyway. So the reduction happens HERE, at the one choke point every
 * sandboxed delivery passes through, rather than at each of the four call sites
 * that could forget it.
 */
export const APP_EVENTS_CARRYING_WORKBOOK_PATH: ReadonlySet<string> = new Set([
  AppEvents.AFTER_OPEN,
  AppEvents.AFTER_SAVE,
]);

/**
 * Reduce a `{ path }` lifecycle payload to `{ fileName }`, using the same
 * single implementation `api.workbookFileName` uses. Rebuilt field-by-field, so
 * a field added to the payload later is absent here by default instead of
 * leaking by default.
 */
function thinWorkbookPathPayload(payload: unknown): { fileName: string | null } {
  const p = (payload ?? {}) as { path?: unknown };
  return { fileName: typeof p.path === "string" && p.path ? fileNameOf(p.path) : null };
}

/**
 * The public form of the same reduction, for the lifecycle-guard relay — the
 * cancellable onBeforeSave / onBeforeClose detail, which is pulled through the
 * guard registry rather than delivered as an app event and therefore never
 * reaches `thinAppEventForScripts`.
 */
export function thinWorkbookPathDetail(detail: unknown): { fileName: string | null } {
  return thinWorkbookPathPayload(detail);
}

/** Options for `thinAppEventForScripts`. */
export interface ThinAppEventOptions {
  /**
   * True when the subscriber may NOT be shown cell contents — i.e. a sandboxed
   * extension that did not declare `grid.read`. Decided by the CALLER at
   * DELIVERY time (never cached at subscribe time), so a ceiling that changes
   * between mounts, or a grant that is revoked, bites the very next event.
   *
   * Deliberately opt-IN: object scripts pass nothing and keep the full payload,
   * because their grid reach is governed by the tier model (own sheet at
   * restricted, any sheet at unlocked) and not by grid.read — see the SCOPE note
   * in capabilityIds.ts.
   */
  redactCellContents?: boolean;
}

/**
 * Thin an app-event payload before it crosses into a SANDBOXED subscriber
 * (worker realm). Four families:
 *
 *  - the workbook-lifecycle events (APP_EVENTS_CARRYING_WORKBOOK_PATH) carry the
 *    full filesystem path and are reduced to the file NAME, always;
 *  - the BI model events' full payloads carry object names — model metadata that
 *    otherwise requires the `bi.query` capability to enumerate — so sandboxed
 *    scripts get only what lets them know to re-read through their own
 *    sanctioned (capability-gated) path;
 *  - the distribution/writeback events are notifications, not deliveries;
 *  - the CELL-CONTENT events (APP_EVENTS_CARRYING_CELL_CONTENTS) are redacted
 *    to coordinates when the caller says the subscriber lacks `grid.read`.
 *
 * Trusted main-thread subscribers keep the full payload. Every other event
 * passes through unchanged.
 */
export function thinAppEventForScripts(
  eventName: string,
  payload: unknown,
  options?: ThinAppEventOptions,
): unknown {
  // FIRST, so the capability question is answered before any per-event shaping
  // and cannot be skipped by a branch added above it later.
  if (options?.redactCellContents && APP_EVENTS_CARRYING_CELL_CONTENTS.has(eventName)) {
    return redactCellContents(eventName, payload);
  }
  // UNCONDITIONAL — not behind an option. There is no capability that buys a
  // sandboxed subscriber the user's folder layout, so there is no caller who
  // should be able to ask for the raw payload.
  if (APP_EVENTS_CARRYING_WORKBOOK_PATH.has(eventName)) {
    return thinWorkbookPathPayload(payload);
  }
  if (eventName === AppEvents.PACKAGE_UPDATED) {
    // A distribution update tells a script "your package moved — re-read".
    // WHAT it moved (how many sheets landed, how many scripts were replaced,
    // whether this was a subscribe or a refresh) describes the SUBSCRIBER's
    // workbook, not the package, and a distributed script has no sanctioned way
    // to enumerate that otherwise — so only the identity crosses.
    const p = (payload ?? {}) as { packageName?: string; version?: string | null };
    return { packageName: p.packageName, version: p.version ?? null };
  }
  if (eventName === AppEvents.WRITEBACK_SUBMISSION_RECEIVED) {
    // A NOTIFICATION, not a delivery. The full payload names WHO submitted and
    // WHERE — and in a per-subscriber writeback region the cell coordinates ARE
    // the identity, so "row 7" and "Alice" are the same disclosure. A sandboxed
    // script has no sanctioned way to enumerate other respondents (that is
    // cap.writebackListSubmissions, which Rust gates on the publisher's signing
    // key), so neither identity nor location may cross here just because the
    // script happened to be listening. What survives is exactly what makes the
    // event useful: which region, and how many arrived.
    const p = (payload ?? {}) as { regionId?: string; count?: number };
    return { regionId: p.regionId, count: p.count ?? 0 };
  }
  if (eventName === AppEvents.BI_MODEL_CHANGED) {
    const p = (payload ?? {}) as { connectionId?: string; domain?: string; revision?: number };
    return { connectionId: p.connectionId, domain: p.domain, revision: p.revision };
  }
  if (eventName === AppEvents.BI_REFRESH_COMPLETED) {
    const p = (payload ?? {}) as {
      connectionId?: string;
      durationMs?: number;
      tables?: Array<{ ok?: boolean }>;
    };
    return {
      connectionId: p.connectionId,
      durationMs: p.durationMs,
      ok: (p.tables ?? []).every((t) => t?.ok !== false),
    };
  }
  return payload;
}
