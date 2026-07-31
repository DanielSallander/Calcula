//! FILENAME: app/src/api/scriptHost/allowlist.ts
// PURPOSE: The tier/capability policy for every method object scripts can
//          call (design: docs/design/script-sandbox-architecture.md §5.1).
// CONTEXT: This ONE object is consumed by (1) broker dispatch, (2) the
//          transparency panel, (3) consent-dialog text — the policy users
//          see is the object the broker executes, so drift is impossible.

import {
  vAny, vNotify, vExpose, vUnexpose, vCall, vHook, vGetState, vSetState, vDecl, vNone,
  vHtml, vCellRef, vCellSet, vBatch, vIndex, vEvent, vCommand, vFetch, vBiQuery, vBiSql,
  vCubeValue, vCubeKpi, vCubeMembers, vBiModelInfo, vBiModelMutation,
  vBiModelValidate, vBiModelLineage, vBiModelBatch,
  vConnectorRegister, vConnectorRemove,
  vScheduleEvery, vScheduleAt, vScheduleCancel,
  vWritebackRegionId, vWritebackSaveDraft, vWritebackListSubmissions, vWritebackReview,
  vKey, vKV, vUdf, vRangeRef, vRangeWrite, MAX_RANGE_CELLS,
  vRangeFormat, vRowColOp, vDimension, vFreeze,
  vSheetName, vSheetRename, vSheetVisibility, vSortRange, vFind, vReplace,
  vObjectKind, vObjectId, vObjectAspect, vCreateChart, vCreateTable,
  vCreateNamedRange, vNamedRangeName, vCreatePivot, MAX_OBJECT_LIST,
  vDialogMessage, vDialogPrompt, vDialogForm,
  type Validator,
} from "./validators";
import { MAX_DIALOG_FIELDS, MAX_DIALOG_MESSAGE } from "./scriptDialogSpec";
import { AppEvents } from "../events";
import type { CapabilityId } from "./capabilityIds";

// CapabilityId now lives in the single-source-of-truth module (capabilityIds.ts);
// re-exported here so the many existing `import { CapabilityId } from "./allowlist"`
// consumers keep working unchanged.
export type { CapabilityId };

export type Tier = "restricted" | "unlocked";
/**
 * What a method DOES, for the transparency panel and the audit ring — and, for
 * "ui", for its deadline. "ui" is the one class whose completion is bounded by a
 * PERSON rather than by machine work: it blocks until the user answers a modal,
 * so protocol.ts gives it UI_DIALOG_DEADLINE_MS instead of the 30s that governs
 * everything else (CLASS_DEADLINES_MS).
 */
export type MethodClass = "read" | "mutate" | "emit" | "net" | "ui";

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
  "events.subscribe":      { tier: "restricted", class: "read",   validate: vHook,     desc: "Listen to its object's events" },
  // ---- own-object scope (instance pinned at mount; a script cannot name another instance) ----
  "object.getState":       { tier: "restricted", class: "read",   validate: vGetState, desc: "Read its own object's properties / selection / spec" },
  "object.setState":       { tier: "restricted", class: "mutate", validate: vSetState, desc: "Change its own object (slicer selection, shape properties, chart spec, panel badge, ...)" },
  "object.declareProperties": { tier: "restricted", class: "mutate", validate: vDecl,  desc: "Declare custom properties (shapes)" },
  "render.invalidate":     { tier: "restricted", class: "emit",   validate: vNone,     desc: "Request a re-render of its own visuals" },
  // ui.html is auto-granted for local scripts; consent-gated for distributed
  // ones (wired in Phase 4 — until then the gate is provenance-based).
  "render.setHtml":        { tier: "restricted", capability: "ui.html", class: "mutate", validate: vHtml, desc: "Render sandboxed HTML inside its shape" },
  "sheet.getCellValue":    { tier: "restricted", class: "read",   validate: vCellRef,  desc: "Read cells on its own sheet (sheet scripts; clamped to the bound sheet)" },
  "sheet.setCellValue":    { tier: "restricted", class: "mutate", validate: vCellSet,  desc: "Write cells on its own sheet (sheet scripts; clamped to the bound sheet)" },
  // Bulk + typed own-sheet I/O. Same reach as the single-cell rows above (own
  // sheet, clamped) — one call instead of one per cell, and the values keep
  // their type + formula so a read/write round-trip cannot turn a formula into
  // text. The write also lands as ONE undo step.
  "sheet.getCellData":     { tier: "restricted", class: "read",   validate: vCellRef,  desc: "Read one cell on its own sheet with its type and formula" },
  "sheet.getRangeValues":  { tier: "restricted", class: "read",   validate: vRangeRef, limits: { maxCells: MAX_RANGE_CELLS },
                             desc: "Read a block of cells on its own sheet in one go (values, types and formulas)" },
  "sheet.setRangeValues":  { tier: "restricted", class: "mutate", validate: vRangeWrite, limits: { maxCells: MAX_RANGE_CELLS },
                             desc: "Write a block of cells on its own sheet in one go (a single undo step)" },
  // Own-sheet FORMATTING (B2). Same reach as sheet.setRangeValues — the script's
  // own sheet, clamped — but it changes appearance instead of content, so it is
  // strictly less destructive than the write row above it.
  "sheet.setRangeFormat":  { tier: "restricted", class: "mutate", validate: vRangeFormat, limits: { maxCells: MAX_RANGE_CELLS },
                             desc: "Change how cells look on its own sheet (font, colour, alignment, number format, borders)" },
  "sheet.clearRangeFormat":{ tier: "restricted", class: "mutate", validate: vRangeRef, limits: { maxCells: MAX_RANGE_CELLS },
                             desc: "Remove all formatting from a block of cells on its own sheet (the values are kept)" },
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
  "api.addSheet":          { tier: "unlocked", class: "mutate", validate: vSheetName, desc: "Add a new sheet to the workbook" },
  "api.deleteSheet":       { tier: "unlocked", class: "mutate", validate: vIndex,    desc: "Delete a sheet and everything on it" },
  "api.renameSheet":       { tier: "unlocked", class: "mutate", validate: vSheetRename, desc: "Rename a sheet" },
  "api.setSheetVisibility":{ tier: "unlocked", class: "mutate", validate: vSheetVisibility, desc: "Show or hide a sheet" },
  "api.sortRange":         { tier: "unlocked", class: "mutate", validate: vSortRange, desc: "Sort a block of cells by one or more columns" },
  "api.findAll":           { tier: "unlocked", class: "read",   validate: vFind,     desc: "Find every cell on the active sheet matching a search text" },
  "api.replaceAll":        { tier: "unlocked", class: "mutate", validate: vReplace,  desc: "Replace a search text everywhere on the active sheet (a single undo step)" },
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
]);

/**
 * Thin an app-event payload before it crosses into a SANDBOXED subscriber
 * (worker realm). The BI model events' full payloads carry object names —
 * model metadata that otherwise requires the `bi.query` capability to
 * enumerate — so sandboxed scripts get only what lets them know to re-read
 * through their own sanctioned (capability-gated) path. Trusted main-thread
 * subscribers keep the full payload. Every other event passes through
 * unchanged.
 */
export function thinAppEventForScripts(eventName: string, payload: unknown): unknown {
  if (eventName === AppEvents.PACKAGE_UPDATED) {
    // A distribution update tells a script "your package moved — re-read".
    // WHAT it moved (how many sheets landed, how many scripts were replaced,
    // whether this was a subscribe or a refresh) describes the SUBSCRIBER's
    // workbook, not the package, and a distributed script has no sanctioned way
    // to enumerate that otherwise — so only the identity crosses.
    const p = (payload ?? {}) as { packageName?: string; version?: string | null };
    return { packageName: p.packageName, version: p.version ?? null };
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
