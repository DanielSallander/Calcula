// =============================================================================
// GENERATED FILE - DO NOT EDIT.
// =============================================================================
// Produced by:  npm run gen:script-typings
// Generator:    app/scripts/scriptTypings/generateObjectContexts.ts
// Prose source: app/scripts/scriptTypings/objectContexts.template.d.ts
// Shape source: app/src/api/scriptHost/worker/contextShims.ts   (probed at build)
// Policy source app/src/api/scriptHost/allowlist.ts             (desc/tier/caps)
//
// This is the ONLY extraLib Monaco loads for object scripts, so it is the whole
// of what IntelliSense knows. Editing it by hand is pointless: the next
// generation overwrites you, and objectContextsTypings.test.ts fails the build
// the moment this file stops matching the shim.
//
// Adding a method to contextShims.ts? Declare it in the TEMPLATE, then run
// `npm run gen:script-typings`. The generator refuses to emit while the shim
// and the typings disagree in either direction.
// =============================================================================

// ============================================================================
// Object types and capabilities (generated rosters)
// ============================================================================

// Object types the script host can mount, and the context interface each
// one receives (generated from contextShims.ts buildTyped).
//   workbook     -> WorkbookContext
//   sheet        -> SheetContext
//   cell         -> CellContext
//   row          -> RowContext
//   column       -> ColumnContext
//   slicer       -> SlicerContext
//   chart        -> ChartContext
//   pivot        -> PivotContext
//   shape        -> ShapeContext
//   panel        -> PanelContext
//   button       -> ButtonContext
//   table        -> TableContext
//   namedRange   -> NamedRangeContext
//   range        -> RangeContext
//   timeline     -> TimelineContext
//   chartMark    -> ChartMarkContext
//   textbox      -> BaseObjectContext

// Capabilities an object script can declare with `// @capability <id>`, and
// the broker methods each one unlocks (generated from allowlist.ts). A call
// without its grant rejects with CapabilityRequired; the user is asked with
// the exact sentence shown here.
//   bi.connector
//     - cap.connectorRegister: Register itself as a data connector feeding external data into this workbook's BI model (undoable; scheduled refresh only after consent)
//     - cap.connectorRemove: Remove its own data connector (and the model tables it feeds)
//   bi.model
//     - cap.biModelBatch: Group several BI model changes so they land — or roll back — together as one undo step
//     - cap.biModelDelete: Delete BI model definitions (measures, calc columns, relationships, hierarchies, KPIs, ...) — undoable; never security roles, connections or credentials
//     - cap.biModelInfo: Read this workbook's BI model definitions (tables, measures, relationships — never security roles or connection targets)
//     - cap.biModelLineage: Trace what a BI measure is built from and what would break if it were deleted (read-only; security roles are counted, never named)
//     - cap.biModelUpsert: Create or update BI model definitions (measures, calc columns, relationships, hierarchies, KPIs, ...) — undoable; never security roles, connections or credentials
//     - cap.biModelValidate: Check a BI measure, context or the whole model for errors before changing it (read-only; privileged details are stripped from the answer)
//   bi.query
//     - cap.biListConnections: List this workbook's BI connections (id + name only)
//     - cap.biQuery: Run read-only, model-scoped queries on this workbook's BI connections
//     - cap.cubeKpi: Resolve a KPI value/goal/status from a BI model
//     - cap.cubeMembers: List the distinct members of a BI model level (column)
//     - cap.cubeValue: Resolve a CUBE value (a measure sliced by member filters) from a BI model
//   bi.sql
//     - cap.biSql: Run read-only RAW SQL against a BI connection's database (any reachable table)
//   distribution.writeback
//     - cap.writebackGetLayer: Read the answers you have entered so far and whether each one is unsent, sent, approved or rejected
//     - cap.writebackListRegions: List the input areas a subscribed package asks you to fill in (where they are and what kind of value they expect)
//     - cap.writebackListSubmissions: Read what EVERY respondent submitted — their answers and their names — for an area you publish (only possible if this workbook can sign that package)
//     - cap.writebackPreview: See exactly which values would leave this machine, and to whom, before anything is sent
//     - cap.writebackReview: Approve or reject somebody else's submitted answer for an area you publish, changing what everyone downstream sees (only possible if this workbook can sign that package)
//     - cap.writebackSaveDraft: Fill in one input cell of a subscribed package (checked against the publisher's rules, and sent straight away if the package asks for that)
//     - cap.writebackSubmit: Send your filled-in answers for one input area to the publisher — they leave this machine and you cannot take them back
//   formula.udf
//     - formula.udf.invoke: Evaluate a registered user-defined formula function
//   net.fetch
//     - cap.fetch: Fetch from the granted web origins (https only, no cookies)
//   schedule
//     - cap.scheduleAt: Run one of its own methods at a set time each day, even after you reopen this workbook (only while Calcula is open at that time)
//     - cap.scheduleCancel: Cancel one of its own schedules
//     - cap.scheduleEvery: Run one of its own methods over and over on a timer, even after you reopen this workbook (never more often than every 30 seconds, and only while Calcula is open)
//     - cap.scheduleList: List the schedules it has set up in this workbook
//   storage
//     - cap.storageGet: Read script-private data stored in the workbook
//     - cap.storageSet: Store script-private data in the workbook (quota 256 KB)
//   ui.dialog
//     - cap.dialogAlert: Interrupt you with a message it wants you to read, and wait until you close it
//     - cap.dialogConfirm: Ask you a yes/no question and act on your answer
//     - cap.dialogForm: Ask you to fill in a small form (text, numbers, dates, choices, checkboxes) and read your answers
//     - cap.dialogPrompt: Ask you to type something in and read what you typed
//   ui.html
//     - render.setHtml: Render sandboxed HTML inside its shape

// ============================================================================
// Base
// ============================================================================

/**
 * A cell READ WITH ITS TYPE — what getData() / getCellData() return.
 *
 * A display string cannot tell the number 5 from the text "5", an error cell
 * from a cell containing "#DIV/0!", or a formula from its rendered result.
 * Reading display strings and writing them back REPLACES EVERY FORMULA WITH
 * ITS TEXT. When you round-trip cells, read with getData() and write back
 * `cell.formula ?? String(cell.value ?? "")`.
 */
declare interface ScriptCell {
  /** number | string | boolean | null (null = an empty cell). An error cell
   *  carries its Excel literal, e.g. "#DIV/0!". */
  value: string | number | boolean | null;
  /** The formatted text the grid shows. */
  display: string;
  /** The cell's formula ("=A1+B1"); absent when it has none (or a protected
   *  sheet hides it). */
  formula?: string;
  type: "number" | "text" | "boolean" | "empty" | "error";
}

// ============================================================================
// caps.dialog — ask the user something (the ui.dialog capability)
// ============================================================================

/** Presentation for `alert` and `confirm`. */
declare interface ScriptDialogTextOptions {
  /** Heading shown above the message (max 120 chars). */
  title?: string;
  /** Caption of the confirming button (max 40 chars). Default "OK". */
  okLabel?: string;
  /** Caption of the cancelling button — `confirm` only. Default "Cancel". */
  cancelLabel?: string;
  /** `confirm` only: style the confirming button as destructive. */
  danger?: boolean;
}

/** Presentation and seed value for `prompt`. */
declare interface ScriptDialogPromptOptions {
  title?: string;
  okLabel?: string;
  cancelLabel?: string;
  /** Pre-filled text. */
  defaultValue?: string;
  placeholder?: string;
  /** Render a multi-line box (Enter inserts a newline instead of submitting). */
  multiline?: boolean;
  maxLength?: number;
}

/** One choice in a `select` field. A bare string is shorthand for both. */
declare interface ScriptDialogOption {
  value: string;
  label?: string;
}

/**
 * One field of a declarative form. `name` is the key its answer lands under in
 * the object `form()` resolves with; the answer's TYPE follows `type`
 * (number -> number, checkbox -> boolean, everything else -> string). An
 * optional field left blank comes back as `null`.
 *
 * There is no regex `pattern` member on purpose: your regular expression would
 * run in the app's own thread against the user's keystrokes. Use
 * required/min/max/maxLength, and do richer checks in your script after the
 * dialog resolves.
 */
declare interface ScriptDialogField {
  /** Identifier (letters, digits, underscore) — the result key. */
  name: string;
  label: string;
  type: "text" | "number" | "date" | "select" | "checkbox";
  /** Blank (or, for a checkbox, unticked) blocks the OK button. */
  required?: boolean;
  /** Initial value, matching the field's own type. */
  default?: string | number | boolean;
  placeholder?: string;
  /** Secondary line under the control. */
  help?: string;
  /** `text` only: a multi-line box. */
  multiline?: boolean;
  /** `text` only. */
  maxLength?: number;
  /** `number` only. */
  min?: number;
  /** `number` only. */
  max?: number;
  /** `number` only. */
  step?: number;
  /** `select` only, and required for it: the choices (max 200). */
  options?: Array<string | ScriptDialogOption>;
}

/** The form `caps.dialog.form(spec)` renders (max 32 fields). */
declare interface ScriptDialogFormSpec {
  /** Heading shown above the fields. */
  title?: string;
  /** Paragraph above the fields. */
  description?: string;
  /** Caption of the submit button. Default "OK". */
  submitLabel?: string;
  /** Caption of the cancel button. Default "Cancel". */
  cancelLabel?: string;
  fields: ScriptDialogField[];
}

/**
 * Modal question + answer. Every method waits for the user — there is no
 * timeout you need to handle, and dismissing is never an error.
 *
 * Only one dialog can be open at a time (yours, or any script's): a second
 * concurrent call rejects rather than stacking modals on the user, and a script
 * whose dialogs are dismissed three times in a row stops being able to ask for
 * the rest of the session.
 */
declare interface ScriptDialogApi {
  /** Show a message and wait until the user closes it.
   *
   * Calcula policy (generated): Interrupt you with a message it wants you to read, and wait until you close it.
   * Reach: broker `cap.dialogAlert`, restricted tier, class ui, requires the `ui.dialog` capability. Limits: maxMessageChars 4,000.
   */
  alert(message: string, options?: ScriptDialogTextOptions): Promise<void>;
  /** Ask a yes/no question. Cancel, Escape and closing all resolve `false`.
   *
   * Calcula policy (generated): Ask you a yes/no question and act on your answer.
   * Reach: broker `cap.dialogConfirm`, restricted tier, class ui, requires the `ui.dialog` capability. Limits: maxMessageChars 4,000.
   */
  confirm(message: string, options?: ScriptDialogTextOptions): Promise<boolean>;
  /** Ask for one value. Resolves `null` if the user cancels.
   *
   * Calcula policy (generated): Ask you to type something in and read what you typed.
   * Reach: broker `cap.dialogPrompt`, restricted tier, class ui, requires the `ui.dialog` capability. Limits: maxMessageChars 4,000.
   */
  prompt(message: string, options?: ScriptDialogPromptOptions): Promise<string | null>;
  /**
   * Ask for several values at once. Resolves an object keyed by field name, or
   * `null` if the user cancels.
   *
   * ```js
   * const answers = await context.caps.dialog.form({
   *   title: "Monthly close",
   *   fields: [
   *     { name: "period", label: "Period", type: "date", required: true },
   *     { name: "rate", label: "FX rate", type: "number", min: 0, default: 1 },
   *     { name: "region", label: "Region", type: "select", options: ["EMEA", "APAC"] },
   *     { name: "lock", label: "Lock the sheet afterwards", type: "checkbox" },
   *   ],
   * });
   * if (!answers) return; // cancelled
   * ```
   *
   * Calcula policy (generated): Ask you to fill in a small form (text, numbers, dates, choices, checkboxes) and read your answers.
   * Reach: broker `cap.dialogForm`, restricted tier, class ui, requires the `ui.dialog` capability. Limits: maxFields 32.
   */
  form(spec: ScriptDialogFormSpec): Promise<Record<string, unknown> | null>;
}

// ============================================================================
// caps.schedule — persistent recurring jobs (the `schedule` capability).
// Declare it with `// @capability schedule`.
// ============================================================================

/** One scheduled job, as stored in the workbook. */
declare interface ScheduledJob {
  /** Stable id — pass it to `cancel()`. */
  id: string;
  /** The script that owns the job (always your own script's id). */
  scriptId: string;
  /** The exposed method the job invokes. */
  handler: string;
  /** "every" (fixed interval) or "dailyAt" (a local wall-clock time). */
  cadence: "every" | "dailyAt";
  /** For "every": seconds between runs (never below 30). */
  intervalSecs: number;
  /** For "dailyAt": minutes since local midnight. */
  minuteOfDay: number;
  /** When the next run is due (epoch milliseconds). */
  nextRunMs: number;
  /** False while the user has paused the job from the transparency panel. */
  enabled: boolean;
  /** The label you gave it, shown to the user. */
  label: string | null;
  /** When it last ran, and how that went. */
  lastRunMs: number;
  lastOk: boolean;
  lastError: string | null;
  runCount: number;
}

/**
 * Recurring work that survives reload. See `context.caps.schedule` for the
 * limits that matter (app-open only; user-visible and user-cancellable).
 */
declare interface ScriptScheduleApi {
  /**
   * Run `handlerName` every `intervalSecs` seconds. Minimum 30 seconds — this
   * is background automation, not an animation loop (use `setInterval` inside
   * your script for anything faster and session-scoped).
   *
   * Calling this again for the same handler UPDATES the existing job rather
   * than adding a second one, so it is safe to call unconditionally on mount.
   *
   * Calcula policy (generated): Run one of its own methods over and over on a timer, even after you reopen this workbook (never more often than every 30 seconds, and only while Calcula is open).
   * Reach: broker `cap.scheduleEvery`, restricted tier, class mutate, requires the `schedule` capability. Limits: perMinute 30.
   */
  every(
    intervalSecs: number,
    handlerName: string,
    options?: { label?: string },
  ): Promise<ScheduledJob>;
  /**
   * Run `handlerName` once a day at `timeOfDay`, a 24-hour **local** "HH:MM"
   * (e.g. `"06:30"`). Local time means the user's clock, so the job follows
   * them across daylight-saving changes.
   *
   * Calcula policy (generated): Run one of its own methods at a set time each day, even after you reopen this workbook (only while Calcula is open at that time).
   * Reach: broker `cap.scheduleAt`, restricted tier, class mutate, requires the `schedule` capability. Limits: perMinute 30.
   */
  at(
    timeOfDay: string,
    handlerName: string,
    options?: { label?: string },
  ): Promise<ScheduledJob>;
  /** Your script's own scheduled jobs in this workbook.
   *
   * Calcula policy (generated): List the schedules it has set up in this workbook.
   * Reach: broker `cap.scheduleList`, restricted tier, class read, requires the `schedule` capability. Limits: perMinute 60.
   */
  list(): Promise<ScheduledJob[]>;
  /** Cancel one of your own jobs. Resolves true if a job was removed.
   *
   * Calcula policy (generated): Cancel one of its own schedules.
   * Reach: broker `cap.scheduleCancel`, restricted tier, class mutate, requires the `schedule` capability. Limits: perMinute 60.
   */
  cancel(jobId: string): Promise<boolean>;
}

// ============================================================================
// caps.writeback — the .calp collection loop (the distribution.writeback
// capability). Declare it with `// @capability distribution.writeback`.
// ============================================================================

/** One value you fill into a subscribed package's input cell. Pick the member
 *  that matches the region's declared `valueType`; the backend re-checks it. */
declare type WritebackValue =
  | { type: "number"; value: number }
  | { type: "text"; value: string }
  | { type: "boolean"; value: boolean }
  | { type: "empty" };

/** One input area a subscribed package asks you to fill in. */
declare interface WritebackRegion {
  regionId: string;
  /** Stable sheet id — pass it back to `saveDraft`. */
  sheetId: string;
  /** Index of that sheet in this workbook. */
  sheetIndex: number;
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
  /** What the publisher expects here. Absent = unschematized. */
  valueType?: "number" | "integer" | "text" | "date" | "boolean" | "enum";
  required?: boolean;
  /** ISO 8601 cut-off for an until-deadline region. */
  deadline?: string;
}

/** One answer of yours, and where it is in its life. */
declare interface WritebackDraft {
  id: string;
  regionId: string;
  cellRow: number;
  cellCol: number;
  value: WritebackValue;
  state: "draft" | "submitted" | "approved" | "rejected";
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  /** The publisher's reason, once they have decided. */
  reviewReason?: string | null;
}

/** Everything you have entered but not necessarily sent. */
declare interface WritebackLayerView {
  formatVersion: number;
  drafts: WritebackDraft[];
}

/** One value that WOULD leave the machine on submit. */
declare interface WritebackOutboundValue {
  cellRow: number;
  cellCol: number;
  valueDisplay: string;
  valueKind: "number" | "text" | "boolean" | "empty";
}

/** Exactly what `submitRegion` would send, and to whom. */
declare interface WritebackSubmissionPreview {
  regionId: string;
  packageName: string;
  resolvedVersion: string;
  registryPath: string;
  submitterId: string;
  submitterName: string;
  values: WritebackOutboundValue[];
}

/** One row of the publisher's "everybody's answers" view. */
declare interface WritebackSubmissionRow {
  submissionId: string;
  regionId: string;
  cellRow: number;
  cellCol: number;
  submitterId: string;
  submitterName: string;
  valueDisplay: string;
  valueKind: "number" | "text" | "boolean" | "empty";
  state: "draft" | "submitted" | "approved" | "rejected";
  submittedAt: string | null;
  updatedAt: string;
  reviewReason?: string | null;
  reviewedBy?: string | null;
}

/** Which publisher-side store an action addresses: a GRID writeback region, or
 *  a BI MODEL writeback column. Exactly one key — never both. */
declare type WritebackTarget = { regionId: string } | { writebackId: string };

/** A publisher's approve / reject / reset decision. */
declare type WritebackReview =
  | {
      regionId: string;
      submitterId: string;
      cellRow: number;
      cellCol: number;
      newState: "approved" | "rejected" | "submitted";
      reason?: string;
      /** The submissionId you were shown. Pass it: if a newer submission
       *  arrived meanwhile the backend refuses rather than deciding blind. */
      submissionId?: string;
    }
  | {
      writebackId: string;
      submissionId: string;
      newState: "approved" | "rejected" | "submitted";
      reason?: string;
    };

/**
 * Fill in and send the input cells of a subscribed .calp package.
 *
 * You do NOT need this to type into a writeback cell from a script —
 * `context.api.setCellValue` on a writeback cell is captured as a validated
 * draft automatically, exactly like a person's keystroke. Use this API when you
 * want the loop itself: enumerate the regions, review what would be sent, and
 * submit.
 *
 * The last two methods are the PUBLISHER side. They read other people's
 * submitted answers and change what everyone downstream sees, so Calcula also
 * requires that this workbook can SIGN the package — holding the capability is
 * not enough, and a subscriber's script can never approve its own submissions.
 */
declare interface ScriptWritebackApi {
  /** The input areas this workbook is asked to fill in.
   *
   * Calcula policy (generated): List the input areas a subscribed package asks you to fill in (where they are and what kind of value they expect).
   * Reach: broker `cap.writebackListRegions`, restricted tier, class read, requires the `distribution.writeback` capability. Limits: perMinute 60.
   */
  listRegions(): Promise<WritebackRegion[]>;
  /** Your answers so far, with the state of each.
   *
   * Calcula policy (generated): Read the answers you have entered so far and whether each one is unsent, sent, approved or rejected.
   * Reach: broker `cap.writebackGetLayer`, restricted tier, class read, requires the `distribution.writeback` capability. Limits: perMinute 60.
   */
  getLayer(): Promise<WritebackLayerView>;
  /**
   * Fill in one cell. Validated against the publisher's schema and lifecycle
   * rules; rejected values throw with the real reason. A region whose policy is
   * `immediate` sends the value as soon as it is drafted.
   *
   * Calcula policy (generated): Fill in one input cell of a subscribed package (checked against the publisher's rules, and sent straight away if the package asks for that).
   * Reach: broker `cap.writebackSaveDraft`, restricted tier, class mutate, requires the `distribution.writeback` capability. Limits: perMinute 240.
   */
  saveDraft(
    regionId: string,
    sheetId: string,
    row: number,
    col: number,
    value: WritebackValue,
  ): Promise<unknown>;
  /** Send every unsent answer for one area. Returns how many went.
   *
   * Calcula policy (generated): Send your filled-in answers for one input area to the publisher — they leave this machine and you cannot take them back.
   * Reach: broker `cap.writebackSubmit`, restricted tier, class net, requires the `distribution.writeback` capability. Limits: perMinute 12.
   */
  submitRegion(regionId: string): Promise<number>;
  /** See exactly what `submitRegion` would send, before sending it.
   *
   * Calcula policy (generated): See exactly which values would leave this machine, and to whom, before anything is sent.
   * Reach: broker `cap.writebackPreview`, restricted tier, class read, requires the `distribution.writeback` capability. Limits: perMinute 60.
   */
  previewSubmission(regionId: string): Promise<WritebackSubmissionPreview>;
  /** PUBLISHER ONLY: every respondent's answers for an area you publish.
   *
   * Calcula policy (generated): Read what EVERY respondent submitted — their answers and their names — for an area you publish (only possible if this workbook can sign that package).
   * Reach: broker `cap.writebackListSubmissions`, restricted tier, class read, requires the `distribution.writeback` capability. Limits: perMinute 60.
   */
  listSubmissions(target: WritebackTarget): Promise<WritebackSubmissionRow[]>;
  /** PUBLISHER ONLY: approve, reject, or reopen somebody's answer.
   *
   * Calcula policy (generated): Approve or reject somebody else's submitted answer for an area you publish, changing what everyone downstream sees (only possible if this workbook can sign that package).
   * Reach: broker `cap.writebackReview`, restricted tier, class net, requires the `distribution.writeback` capability. Limits: perMinute 12.
   */
  setSubmissionState(decision: WritebackReview): Promise<void>;
}

/**
 * Read and change this workbook's BI model DEFINITIONS (the bi.model
 * capability; declare it with `// @capability bi.model`).
 *
 * Every mutation lands on the user's model undo stack and is audited. Security
 * roles, data sources, connections and credentials are NOT reachable — not as
 * an argument and not in an answer: even a mutation's return value is projected
 * down to the same whitelist `info` returns.
 */
declare interface ScriptBiModelApi {
  /** Sanitized snapshot: tables, measures, relationships, writeback columns.
   *
   * Calcula policy (generated): Read this workbook's BI model definitions (tables, measures, relationships — never security roles or connection targets).
   * Reach: broker `cap.biModelInfo`, restricted tier, class read, requires the `bi.model` capability.
   */
  info(connectionId: string): Promise<unknown>;
  /** Create or replace one definition. `kind` is "measure" | "calcColumn" |
   *  "relationship" | "hierarchy" | "kpi" | "calcGroup" | "perspective" |
   *  "culture" | "scriptFunction" | "calculatedTable" | "tableVariable" |
   *  "context" | "contextColumn" | "writebackColumn" | "metadata" |
   *  "dateTable" | "extensionData".
   *
   * Calcula policy (generated): Create or update BI model definitions (measures, calc columns, relationships, hierarchies, KPIs, ...) — undoable; never security roles, connections or credentials.
   * Reach: broker `cap.biModelUpsert`, restricted tier, class mutate, requires the `bi.model` capability. Limits: perMinute 30.
   */
  upsert(connectionId: string, kind: string, payload: Record<string, unknown>): Promise<unknown>;
  /** Delete one definition (same `kind` vocabulary as `upsert`).
   *
   * Calcula policy (generated): Delete BI model definitions (measures, calc columns, relationships, hierarchies, KPIs, ...) — undoable; never security roles, connections or credentials.
   * Reach: broker `cap.biModelDelete`, restricted tier, class mutate, requires the `bi.model` capability. Limits: perMinute 30.
   */
  delete(connectionId: string, kind: string, payload: Record<string, unknown>): Promise<unknown>;
  /** Check a measure formula WITHOUT saving it.
   *
   * Calcula policy (generated): Check a BI measure, context or the whole model for errors before changing it (read-only; privileged details are stripped from the answer).
   * Reach: broker `cap.biModelValidate`, restricted tier, class read, requires the `bi.model` capability. Limits: perMinute 120.
   */
  validateMeasure(connectionId: string, name: string, formula: string, originalName?: string): Promise<unknown>;
  /** Check a context expression WITHOUT saving it.
   *
   * Calcula policy (generated): Check a BI measure, context or the whole model for errors before changing it (read-only; privileged details are stripped from the answer).
   * Reach: broker `cap.biModelValidate`, restricted tier, class read, requires the `bi.model` capability. Limits: perMinute 120.
   */
  validateContext(connectionId: string, name: string, expression: string, originalName?: string): Promise<unknown>;
  /** Every outstanding issue in the whole model.
   *
   * Calcula policy (generated): Check a BI measure, context or the whole model for errors before changing it (read-only; privileged details are stripped from the answer).
   * Reach: broker `cap.biModelValidate`, restricted tier, class read, requires the `bi.model` capability. Limits: perMinute 120.
   */
  validateModel(connectionId: string): Promise<unknown>;
  /** The model's dependency graph (nodes + edges).
   *
   * Calcula policy (generated): Trace what a BI measure is built from and what would break if it were deleted (read-only; security roles are counted, never named).
   * Reach: broker `cap.biModelLineage`, restricted tier, class read, requires the `bi.model` capability. Limits: perMinute 120.
   */
  dependencyGraph(connectionId: string): Promise<unknown>;
  /** What one measure is built from, all the way down.
   *
   * Calcula policy (generated): Trace what a BI measure is built from and what would break if it were deleted (read-only; security roles are counted, never named).
   * Reach: broker `cap.biModelLineage`, restricted tier, class read, requires the `bi.model` capability. Limits: perMinute 120.
   */
  measureLineage(connectionId: string, name: string): Promise<unknown>;
  /**
   * What would BREAK if you deleted this object — the impact check to run
   * before a delete. `kind` is "measure" | "calcColumn" | "contextColumn" |
   * "calculatedTable" | "table"; `table` is required for the two column kinds.
   * Security roles that depend on it are reported as a COUNT
   * (`privilegedDependents`), never by name.
   *
   * Calcula policy (generated): Trace what a BI measure is built from and what would break if it were deleted (read-only; security roles are counted, never named).
   * Reach: broker `cap.biModelLineage`, restricted tier, class read, requires the `bi.model` capability. Limits: perMinute 120.
   */
  dependents(connectionId: string, kind: string, name: string, table?: string): Promise<unknown>;
  /**
   * Start an atomic run: every edit until `batchEnd` lands as ONE undo entry.
   * Only this script may end or cancel it, and an abandoned batch is rolled
   * back (never committed) after ~30 seconds. Batching buys atomicity, not
   * budget — each edit inside still costs a rate-limit token.
   *
   * Calcula policy (generated): Group several BI model changes so they land — or roll back — together as one undo step.
   * Reach: broker `cap.biModelBatch`, restricted tier, class mutate, requires the `bi.model` capability. Limits: perMinute 30.
   */
  batchBegin(connectionId: string): Promise<unknown>;
  /** Commit the open batch as one undo entry.
   *
   * Calcula policy (generated): Group several BI model changes so they land — or roll back — together as one undo step.
   * Reach: broker `cap.biModelBatch`, restricted tier, class mutate, requires the `bi.model` capability. Limits: perMinute 30.
   */
  batchEnd(connectionId: string): Promise<unknown>;
  /** Roll the open batch back as if none of it had happened.
   *
   * Calcula policy (generated): Group several BI model changes so they land — or roll back — together as one undo step.
   * Reach: broker `cap.biModelBatch`, restricted tier, class mutate, requires the `bi.model` capability. Limits: perMinute 30.
   */
  batchCancel(connectionId: string): Promise<unknown>;
}

// ============================================================================
// caps.fetch — the granted web origins (the net.fetch capability)
// ============================================================================

/** The answer `caps.fetch` resolves with. The body has already crossed the
 *  broker as text; `json()` parses it in your own realm. */
declare interface ScriptFetchResponse {
  status: number;
  headers: Record<string, string>;
  /** The response body as text. */
  text(): string;
  /** The response body parsed as JSON (throws on malformed JSON). */
  json(): unknown;
}

/**
 * A stored secret to inject as a request header, named by SLOT rather than by
 * value. Calcula resolves it inside the Rust net gate, after your script has
 * handed over the request — so a connector can authenticate against an API
 * whose key your script is never allowed to read.
 */
declare interface ScriptSecretHeader {
  /** The connector source that owns the secret. */
  sourceId: string;
  /** The slot name the user filled in ("apiKey"). */
  slot: string;
  /** The header to set ("Authorization"). */
  header: string;
  /** A template for the value, `{secret}` marking where it goes
   *  ("Bearer {secret}"). Default: the bare secret. */
  format?: string;
}

/** Request options for `caps.fetch`. */
declare interface ScriptFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Authenticate with a stored secret you cannot read (see
   *  {@link ScriptSecretHeader}). */
  secretHeader?: ScriptSecretHeader;
}

// ============================================================================
// caps.storage — script-private workbook data (the storage capability)
// ============================================================================

/**
 * A key/value store private to THIS script and saved in THIS workbook. Another
 * script cannot read it, and it travels with the file. Values are strings —
 * `JSON.stringify` what you need.
 */
declare interface ScriptStorageApi {
  /** Read a key. Resolves `null` when it has never been set.
   *
   * Calcula policy (generated): Read script-private data stored in the workbook.
   * Reach: broker `cap.storageGet`, restricted tier, class read, requires the `storage` capability.
   */
  get(key: string): Promise<string | null>;
  /** Write a key. The whole store is capped at 256 KB per script.
   *
   * Calcula policy (generated): Store script-private data in the workbook (quota 256 KB).
   * Reach: broker `cap.storageSet`, restricted tier, class mutate, requires the `storage` capability. Limits: maxBytes 262,144.
   */
  set(key: string, value: string): Promise<void>;
}

// ============================================================================
// caps.biQuery / caps.biSql / caps.cube — reading BI models
// (the bi.query and bi.sql capabilities)
// ============================================================================

/** A table+column pair naming one model column. */
declare interface ScriptBiColumnRef {
  table: string;
  column: string;
}

/** One filter applied to a model query. */
declare interface ScriptBiFilter {
  table: string;
  column: string;
  /** "=", "<>", ">", ">=", "<", "<=", "in", "contains", ... */
  operator: string;
  value: string;
}

/**
 * A STRUCTURED model query: measures, the columns to group them by, and the
 * filters to apply. It is not SQL — the engine resolves it against the model's
 * relationships, so you name business objects rather than joins.
 */
declare interface ScriptBiQueryRequest {
  /** Measure names to evaluate. */
  measures: string[];
  /** Columns to group by (the query's grain). */
  groupBy: ScriptBiColumnRef[];
  /** Filters applied before aggregation. */
  filters: ScriptBiFilter[];
}

/** A model query's answer: column headers plus rows of stringified cells. */
declare interface ScriptBiQueryResult {
  columns: string[];
  rows: (string | null)[][];
  rowCount: number;
}

/** One BI connection in this workbook. Identity only — never a host, a
 *  database name or a credential. */
declare interface ScriptBiConnectionSummary {
  id: string;
  name: string;
  connectionType?: string;
  isConnected?: boolean;
  tableCount?: number;
  measureCount?: number;
}

/**
 * The CUBE functions, as script calls: the same member-expression ergonomics
 * `CUBEVALUE` / `CUBEKPIMEMBER` / `CUBESET` give a formula author. Backed by
 * the `bi.query` capability — no extra reach, better ergonomics.
 */
declare interface ScriptCubeApi {
  /**
   * Resolve a measure sliced by member filters.
   * e.g. `await caps.cube.value(conn, "[Measures].[Sales]", "[Date].[2026]")`
   *
   * Calcula policy (generated): Resolve a CUBE value (a measure sliced by member filters) from a BI model.
   * Reach: broker `cap.cubeValue`, restricted tier, class net, requires the `bi.query` capability. Limits: maxRows 100,000.
   */
  value(connection: string, ...members: string[]): Promise<number | null>;
  /** Resolve a KPI's value/goal/status. `property` is 1 = value, 2 = goal,
   *  3 = status, 4 = trend.
   *
   * Calcula policy (generated): Resolve a KPI value/goal/status from a BI model.
   * Reach: broker `cap.cubeKpi`, restricted tier, class net, requires the `bi.query` capability. Limits: maxRows 100,000.
   */
  kpi(connection: string, kpi: string, property: number): Promise<number | null>;
  /** List the distinct members of a level (a model column).
   *
   * Calcula policy (generated): List the distinct members of a BI model level (column).
   * Reach: broker `cap.cubeMembers`, restricted tier, class net, requires the `bi.query` capability. Limits: maxRows 100,000.
   */
  members(connection: string, level: string): Promise<string[]>;
}

// ============================================================================
// caps.connector — feeding external data into the model
// (the bi.connector capability)
// ============================================================================

/**
 * Register your script as a DATA SOURCE for this workbook's BI model.
 *
 * The feed cycle is host-driven, not script-driven: you also `context.expose`
 * a `fetchTable(tableName)` method, and Calcula's trusted connector host calls
 * it per declared table and hands the rows to a volume-capped Rust gate. That
 * is deliberate — a connector cannot push unbounded data into the model on its
 * own schedule, and the rows it does supply are audited like every other
 * privileged write.
 *
 * ```js
 * context.expose("fetchTable", async (table) => {
 *   const res = await context.caps.fetch(`https://api.example.com/${table}`);
 *   return res.json();
 * });
 * await context.caps.connector.register(connectionId, {
 *   sourceId: "example-api",
 *   tables: [{ name: "orders", columns: [{ name: "id", type: "text" }] }],
 *   refreshEverySecs: 900,
 * });
 * ```
 */
declare interface ScriptConnectorApi {
  /** Declare (or redeclare) this script's connector and its tables.
   *
   * Calcula policy (generated): Register itself as a data connector feeding external data into this workbook's BI model (undoable; scheduled refresh only after consent).
   * Reach: broker `cap.connectorRegister`, restricted tier, class mutate, requires the `bi.connector` capability.
   */
  register(connectionId: string, definition: Record<string, unknown>): Promise<unknown>;
  /** Remove your own connector, and the model tables it feeds.
   *
   * Calcula policy (generated): Remove its own data connector (and the model tables it feeds).
   * Reach: broker `cap.connectorRemove`, restricted tier, class mutate, requires the `bi.connector` capability.
   */
  remove(connectionId: string, sourceId: string): Promise<void>;
}

// ============================================================================
// context.caps — the whole capability surface
// ============================================================================

/**
 * Everything a script can reach OUTSIDE the document, gathered in one place.
 *
 * Capabilities are orthogonal to tier: a `restricted` script can hold every one
 * of these, and an `unlocked` script holds none of them until they are granted.
 * Declare what you need at the top of your script —
 *
 * ```js
 * // @capability net.fetch
 * // @capability bi.query
 * ```
 *
 * — and the user is asked once, in the words printed on each member below.
 * A call without its grant rejects with `CapabilityRequired`; it never silently
 * returns nothing. Locally authored scripts get a just-in-time prompt on first
 * use; a distributed script's capabilities are consented when the package is
 * subscribed, and revoking one takes effect on the next call.
 */
declare interface ScriptCapabilities {
  /**
   * Fetch from the web origins the user granted. HTTPS only, no cookies, no
   * redirects to an ungranted origin, and the response body is capped.
   *
   * ```js
   * const res = await context.caps.fetch("https://api.example.com/rates");
   * context.log(res.json().usd);
   * ```
   *
   * Calcula policy (generated): Fetch from the granted web origins (https only, no cookies).
   * Reach: broker `cap.fetch`, restricted tier, class net, requires the `net.fetch` capability. Limits: maxResponseBytes 5,242,880, perMinute 10.
   */
  fetch(url: string, init?: ScriptFetchInit): Promise<ScriptFetchResponse>;
  /** Script-private, workbook-local key/value storage. */
  storage: ScriptStorageApi;
  /**
   * Run a STRUCTURED, model-scoped query against one of this workbook's BI
   * connections. Read-only, and scoped to the model — a query can only name
   * measures and columns the model defines, so it cannot reach a table the
   * model does not expose.
   *
   * ```js
   * const result = await context.caps.biQuery(connectionId, {
   *   measures: ["Total Sales"],
   *   groupBy: [{ table: "dim_date", column: "Year" }],
   *   filters: [{ table: "dim_region", column: "Region", operator: "=", value: "EMEA" }],
   * });
   * ```
   *
   * Calcula policy (generated): Run read-only, model-scoped queries on this workbook's BI connections.
   * Reach: broker `cap.biQuery`, restricted tier, class net, requires the `bi.query` capability. Limits: maxRows 100,000.
   */
  biQuery(connectionId: string, request: ScriptBiQueryRequest): Promise<ScriptBiQueryResult>;
  /**
   * Run RAW SQL against a connection's underlying database.
   *
   * This is a STRICTLY larger reach than `biQuery` and has its own capability
   * (`bi.sql`) for that reason: the model's scoping does not apply, so any
   * table the connection can see is reachable. Statements are read-only.
   *
   * Calcula policy (generated): Run read-only RAW SQL against a BI connection's database (any reachable table).
   * Reach: broker `cap.biSql`, restricted tier, class net, requires the `bi.sql` capability. Limits: maxRows 100,000.
   */
  biSql(connectionId: string, sql: string): Promise<ScriptBiQueryResult>;
  /** The BI connections in this workbook (id and name only).
   *
   * Calcula policy (generated): List this workbook's BI connections (id + name only).
   * Reach: broker `cap.biListConnections`, restricted tier, class read, requires the `bi.query` capability.
   */
  listBiConnections(): Promise<ScriptBiConnectionSummary[]>;
  /** CUBE-style value / KPI / member lookups over a BI model. */
  cube: ScriptCubeApi;
  /**
   * Read and change this workbook's BI model definitions. Requires the
   * `bi.model` capability (`// @capability bi.model`). Security roles, data
   * sources and credentials are unreachable — in arguments AND in answers.
   */
  biModel: ScriptBiModelApi;
  /** Register this script as a data source feeding the BI model. */
  connector: ScriptConnectorApi;
  /**
   * Ask the user something and branch on the answer — the MsgBox / InputBox /
   * UserForm shape, awaitable. Requires the `ui.dialog` capability (declare it
   * with `// @capability ui.dialog`; the user grants it on first use, or via
   * package consent for a distributed script).
   *
   * The dialog is drawn by Calcula itself from what you pass — you supply data,
   * never markup — and its title bar always names your script, so a dialog can
   * never be mistaken for the app. A dismissal is never an error: confirm
   * resolves `false`, prompt and form resolve `null`.
   *
   * ```js
   * const ok = await context.caps.dialog.confirm(
   *   `Delete ${rows} rows? This cannot be undone.`,
   *   { title: "Delete rows", okLabel: "Delete", danger: true },
   * );
   * if (!ok) return;
   * ```
   */
  dialog: ScriptDialogApi;
  /**
   * Fill in and send the input cells of a subscribed .calp package — the
   * data-collection loop, automated. Requires the `distribution.writeback`
   * capability (`// @capability distribution.writeback`).
   *
   * Typing into a writeback cell with `context.api.setCellValue` already
   * routes through the same validated draft path a person's keystroke takes,
   * so you only need this API for the loop itself:
   *
   * ```js
   * const [region] = await context.caps.writeback.listRegions();
   * await context.caps.writeback.saveDraft(
   *   region.regionId, region.sheetId, region.rowStart, region.colStart,
   *   { type: "number", value: 42 },
   * );
   * const preview = await context.caps.writeback.previewSubmission(region.regionId);
   * context.log(`sending ${preview.values.length} values to ${preview.packageName}`);
   * await context.caps.writeback.submitRegion(region.regionId);
   * ```
   */
  writeback: ScriptWritebackApi;
  /**
   * Run one of your own methods on a recurring schedule — the replacement for
   * VBA's `Application.OnTime`. Requires the `schedule` capability
   * (`// @capability schedule`).
   *
   * Two things make this different from `setTimeout`, and both are the point:
   * the schedule is SAVED IN THE WORKBOOK, so it resumes the next time the
   * file is opened; and it starts itself, with nobody clicking anything.
   *
   * Two things bound it, and you should design around them rather than hope:
   *  - It only runs **while Calcula is open**. There is no background service
   *    and no headless runtime. A job set for 03:00 runs at 03:00 if the app
   *    is open then, and otherwise runs shortly after the workbook is next
   *    opened — once, not once per missed slot.
   *  - The user can see every job in the transparency panel and cancel it,
   *    and revoking the `schedule` capability stops jobs already saved in the
   *    file at their next tick. Treat a schedule as a standing request, not a
   *    guarantee.
   *
   * `handlerName` names a method you published with `context.expose(...)` —
   * a schedule stores the NAME, never a function, which is what lets the user
   * still see what it will run after a reload.
   *
   * ```js
   * context.expose("refreshFromApi", async () => {
   *   const res = await context.caps.fetch("https://api.example.com/daily");
   *   context.api.setCellValue(0, 0, String(res.json().total));
   * });
   *
   * // Every 15 minutes, and again after every reopen (min interval: 30s).
   * await context.caps.schedule.every(900, "refreshFromApi", { label: "Daily totals" });
   *
   * // ...or once a day at 06:30 local time.
   * await context.caps.schedule.at("06:30", "refreshFromApi");
   * ```
   */
  schedule: ScriptScheduleApi;
}

/** One border edge of a cell format. */
declare interface ScriptBorderSide {
  style: "none" | "thin" | "medium" | "thick" | "dashed" | "dotted" | "double";
  /** "#RRGGBB" or "#RRGGBBAA". */
  color: string;
}

/**
 * A PARTIAL cell format — what range.format() / setRangeFormat() take.
 *
 * Only the properties you SET change; everything else is left alone, so
 * format({ bold: true }) never resets the number format or the fill. An unknown
 * property is REJECTED (with the accepted list) rather than silently ignored,
 * so a typo fails loudly instead of doing nothing.
 *
 * Protection attributes (locked / formulaHidden) and the checkbox/button cell
 * controls are deliberately NOT here — they are separate surfaces.
 */
declare interface ScriptFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: "none" | "single" | "double" | "singleAccounting" | "doubleAccounting";
  strikethrough?: boolean;
  /** Font size in POINTS (1-409). */
  fontSize?: number;
  fontFamily?: string;
  /** "#RRGGBB" or "#RRGGBBAA". */
  textColor?: string;
  backgroundColor?: string;
  textAlign?: "left" | "center" | "right" | "general";
  verticalAlign?: "top" | "middle" | "bottom";
  /** An Excel number-format code, e.g. "#,##0.00", "0.0%", "General". */
  numberFormat?: string;
  wrapText?: boolean;
  textRotation?: "none" | "rotate90" | "rotate270";
  /** Indent steps (0-250). */
  indent?: number;
  shrinkToFit?: boolean;
  borderTop?: ScriptBorderSide;
  borderRight?: ScriptBorderSide;
  borderBottom?: ScriptBorderSide;
  borderLeft?: ScriptBorderSide;
  borderDiagonalDown?: ScriptBorderSide;
  borderDiagonalUp?: ScriptBorderSide;
}

/** A sort criterion for api.sortRange. */
declare interface ScriptSortField {
  /** 0-based offset of the sort column FROM THE RANGE START (not an absolute
   *  column index): sorting A1:C10 by column B uses key 1. */
  key: number;
  /** Default true. */
  ascending?: boolean;
  sortOn?: "value" | "cellColor" | "fontColor" | "icon";
  /** The colour to sort on when sortOn is cellColor / fontColor. */
  color?: string;
  dataOption?: "normal" | "textAsNumber";
  subField?: string;
  /** A built-in list name ("weekdays", "months", ...) or a comma-separated
   *  custom order. */
  customOrder?: string;
}

/** A cell matched by api.findAll. */
declare interface ScriptFindMatch {
  row: number;
  col: number;
}

// ============================================================================
// Workbook objects (B3)
// ============================================================================

/**
 * One object found by api.charts() / api.tables() / api.pivots() /
 * api.namedRanges() / api.slicers() / api.shapes().
 *
 * `id` is the handle every other object method takes — pass it to
 * `api.chart(id)`, `api.deleteTable(id)`, and so on. It is an EntityId for
 * charts/tables/pivots/slicers, the NAME for a named range, and the anchor-
 * derived control id ("control-0-5-10") for a form control.
 *
 * Enumeration answers "what is in this workbook", never "what is inside this
 * object": there is no spec body, no cell data and no connection detail here.
 */
declare interface ScriptObjectRef {
  kind: "chart" | "table" | "pivot" | "namedRange" | "slicer" | "shape";
  /** Stable handle. */
  id: string;
  name: string;
  /** null for a workbook-scoped object (a workbook-scoped name, a pivot). */
  sheetIndex: number | null;
  /** A1 address the object occupies / its data range. */
  range?: string;
  /** Pivot: the source data range it aggregates. */
  sourceRange?: string;
  /** Named range: the formula it refers to. */
  refersTo?: string;
  /** Chart: its mark ("bar", "line", ...). Shape: its control type. */
  kindDetail?: string;
  /** Slicer: the field it filters on. */
  fieldName?: string;
  /** Table: data-row count. */
  rowCount?: number;
  /** Table: column count. */
  columnCount?: number;
}

/** A pivot layout area, named as the Pivot Layout DSL names it. */
declare type ScriptPivotArea = "rows" | "columns" | "values" | "filters";

/**
 * An aggregation, in the Pivot Layout DSL's spelling — the same words the
 * VALUES clause accepts (`VALUES sum(Revenue)`).
 */
declare type ScriptAggregation =
  | "sum" | "count" | "average" | "min" | "max"
  | "countnumbers" | "stddev" | "stddevp" | "var" | "varp" | "product";

/**
 * A LAYOUT directive, in the Pivot Layout DSL's spelling — the same words the
 * LAYOUT clause accepts (`LAYOUT tabular, values-on-rows`).
 */
declare type ScriptPivotLayoutDirective =
  | "compact" | "outline" | "tabular"
  | "repeat-labels" | "no-repeat-labels"
  | "grand-totals" | "no-grand-totals"
  | "row-totals" | "no-row-totals"
  | "column-totals" | "no-column-totals"
  | "show-empty-rows" | "show-empty-cols"
  | "values-on-rows" | "values-on-columns"
  | "auto-fit"
  | "subtotals-top" | "subtotals-bottom" | "subtotals-off";

/** A handle on ANOTHER chart in the workbook (api.chart(id)). */
declare interface ScriptChartHandle {
  readonly id: string;
  /** The chart's ChartSpec. Async — only your OWN object has a live mirror.
   *
   * Calcula policy (generated): Read another object in this workbook (its chart spec, table cells, slicer selection, ...).
   * Reach: broker `api.objectGetState`, unlocked tier, class read.
   */
  getSpec(): Promise<Record<string, unknown>>;
  /** Merge a partial patch into the spec (schema-validated; rejects if invalid).
   *
   * Calcula policy (generated): Change another object in this workbook (its chart spec, slicer selection, pivot layout, shape properties, ...).
   * Reach: broker `api.objectSetState`, unlocked tier, class mutate.
   */
  updateSpec(patch: Record<string, unknown>): Promise<void>;
  /** Replace the whole spec (schema-validated; rejects if invalid).
   *
   * Calcula policy (generated): Change another object in this workbook (its chart spec, slicer selection, pivot layout, shape properties, ...).
   * Reach: broker `api.objectSetState`, unlocked tier, class mutate.
   */
  replaceSpec(fullSpec: Record<string, unknown>): Promise<void>;
  /**
   * Calcula policy (generated): Change another object in this workbook (its chart spec, slicer selection, pivot layout, shape properties, ...).
   * Reach: broker `api.objectSetState`, unlocked tier, class mutate.
   */
  setStyleProperty(name: string, value: string): Promise<void>;
  /** Delete this chart.
   *
   * Calcula policy (generated): Delete a chart.
   * Reach: broker `api.deleteChart`, unlocked tier, class mutate.
   */
  delete(): Promise<void>;
}

/** A handle on ANOTHER table (api.table(id)). Coordinates are TABLE-RELATIVE
 *  (row 0 = first data row, col 0 = first table column) and clamped to the
 *  table body, exactly as inside that table's own script. */
declare interface ScriptTableHandle {
  readonly id: string;
  /**
   * Calcula policy (generated): Read another object in this workbook (its chart spec, table cells, slicer selection, ...).
   * Reach: broker `api.objectGetState`, unlocked tier, class read.
   */
  getCellValue(row: number, colIndex: number): Promise<string>;
  /**
   * Calcula policy (generated): Change another object in this workbook (its chart spec, slicer selection, pivot layout, shape properties, ...).
   * Reach: broker `api.objectSetState`, unlocked tier, class mutate.
   */
  setCellValue(row: number, colIndex: number, value: string): Promise<void>;
  /**
   * Calcula policy (generated): Change another object in this workbook (its chart spec, slicer selection, pivot layout, shape properties, ...).
   * Reach: broker `api.objectSetState`, unlocked tier, class mutate.
   */
  addRow(): Promise<void>;
  range(address: string): ScriptRange;
  cell(row: number, colIndex: number): ScriptRange;
  /** Delete this table (the cells and their values are kept).
   *
   * Calcula policy (generated): Delete a table (the cells and their values are kept).
   * Reach: broker `api.deleteTable`, unlocked tier, class mutate.
   */
  delete(): Promise<void>;
}

/** A handle on ANOTHER pivot table (api.pivot(id)). */
declare interface ScriptPivotHandle {
  readonly id: string;
  /**
   * Calcula policy (generated): Read another object in this workbook (its chart spec, table cells, slicer selection, ...).
   * Reach: broker `api.objectGetState`, unlocked tier, class read.
   */
  getFields(): Promise<{ rows: string[]; columns: string[]; values: string[]; filters: string[] }>;
  /**
   * Calcula policy (generated): Change another object in this workbook (its chart spec, slicer selection, pivot layout, shape properties, ...).
   * Reach: broker `api.objectSetState`, unlocked tier, class mutate.
   */
  refresh(): Promise<void>;
  /** Place a source field in an area. `position` inserts at an index (default:
   *  append); `aggregation` applies when the area is "values".
   *
   * Calcula policy (generated): Change another object in this workbook (its chart spec, slicer selection, pivot layout, shape properties, ...).
   * Reach: broker `api.objectSetState`, unlocked tier, class mutate.
   */
  addField(field: string, area: ScriptPivotArea, position?: number, aggregation?: ScriptAggregation): Promise<void>;
  /** Move an already-placed field to another area.
   *
   * Calcula policy (generated): Change another object in this workbook (its chart spec, slicer selection, pivot layout, shape properties, ...).
   * Reach: broker `api.objectSetState`, unlocked tier, class mutate.
   */
  moveField(field: string, area: ScriptPivotArea, position?: number): Promise<void>;
  /** Remove a placed field. Omit `area` to remove it from wherever it sits.
   *
   * Calcula policy (generated): Change another object in this workbook (its chart spec, slicer selection, pivot layout, shape properties, ...).
   * Reach: broker `api.objectSetState`, unlocked tier, class mutate.
   */
  removeField(field: string, area?: ScriptPivotArea): Promise<void>;
  /** Change how a VALUE field is summarized.
   *
   * Calcula policy (generated): Change another object in this workbook (its chart spec, slicer selection, pivot layout, shape properties, ...).
   * Reach: broker `api.objectSetState`, unlocked tier, class mutate.
   */
  setAggregation(field: string, aggregation: ScriptAggregation): Promise<void>;
  /** Apply LAYOUT directives (applied left to right, later wins).
   *
   * Calcula policy (generated): Change another object in this workbook (its chart spec, slicer selection, pivot layout, shape properties, ...).
   * Reach: broker `api.objectSetState`, unlocked tier, class mutate.
   */
  setLayout(directives: ScriptPivotLayoutDirective[]): Promise<void>;
  /** Delete this pivot table.
   *
   * Calcula policy (generated): Delete a pivot table.
   * Reach: broker `api.deletePivot`, unlocked tier, class mutate.
   */
  delete(): Promise<void>;
}

/** A handle on ANOTHER slicer (api.slicer(id)). */
declare interface ScriptSlicerHandle {
  readonly id: string;
  /**
   * Calcula policy (generated): Read another object in this workbook (its chart spec, table cells, slicer selection, ...).
   * Reach: broker `api.objectGetState`, unlocked tier, class read.
   */
  getSelectedItems(): Promise<string[]>;
  /** null selects ALL items; [] clears the selection.
   *
   * Calcula policy (generated): Change another object in this workbook (its chart spec, slicer selection, pivot layout, shape properties, ...).
   * Reach: broker `api.objectSetState`, unlocked tier, class mutate.
   */
  setSelectedItems(items: string[] | null): Promise<void>;
  /**
   * Calcula policy (generated): Change another object in this workbook (its chart spec, slicer selection, pivot layout, shape properties, ...).
   * Reach: broker `api.objectSetState`, unlocked tier, class mutate.
   */
  clearSelection(): Promise<void>;
  /**
   * Calcula policy (generated): Change another object in this workbook (its chart spec, slicer selection, pivot layout, shape properties, ...).
   * Reach: broker `api.objectSetState`, unlocked tier, class mutate.
   */
  selectAll(): Promise<void>;
  /**
   * Calcula policy (generated): Change another object in this workbook (its chart spec, slicer selection, pivot layout, shape properties, ...).
   * Reach: broker `api.objectSetState`, unlocked tier, class mutate.
   */
  setStyleProperty(name: string, value: string): Promise<void>;
}

/** A handle on ANOTHER form control / shape (api.shape(id)). */
declare interface ScriptShapeHandle {
  readonly id: string;
  /**
   * Calcula policy (generated): Change another object in this workbook (its chart spec, slicer selection, pivot layout, shape properties, ...).
   * Reach: broker `api.objectSetState`, unlocked tier, class mutate.
   */
  setProperty(key: string, value: string): Promise<void>;
  /**
   * Calcula policy (generated): Read another object in this workbook (its chart spec, table cells, slicer selection, ...).
   * Reach: broker `api.objectGetState`, unlocked tier, class read.
   */
  getCellValue(cellRef: string): Promise<string>;
  /**
   * Calcula policy (generated): Change another object in this workbook (its chart spec, slicer selection, pivot layout, shape properties, ...).
   * Reach: broker `api.objectSetState`, unlocked tier, class mutate.
   */
  sendMessage(type: string, data?: unknown): Promise<void>;
}

/** A handle on ANOTHER named range (api.namedRange(name)). */
declare interface ScriptNamedRangeHandle {
  readonly name: string;
  /**
   * Calcula policy (generated): Read another object in this workbook (its chart spec, table cells, slicer selection, ...).
   * Reach: broker `api.objectGetState`, unlocked tier, class read.
   */
  getValues(): Promise<string[][]>;
  /**
   * Calcula policy (generated): Change another object in this workbook (its chart spec, slicer selection, pivot layout, shape properties, ...).
   * Reach: broker `api.objectSetState`, unlocked tier, class mutate.
   */
  setValues(values: string[][]): Promise<void>;
  /** Delete this name (formulas using it will break).
   *
   * Calcula policy (generated): Delete a named range (formulas using the name will break).
   * Reach: broker `api.deleteNamedRange`, unlocked tier, class mutate.
   */
  delete(): Promise<void>;
}

/** A worksheet facet of the canonical model (C3). Reached via api.workbook. */
declare interface ScriptSheet {
  readonly index: number;
  readonly name: string;
  /** A range on THIS sheet by A1 address ("A1", "A1:B5"). */
  range(address: string): ScriptRange;
  /** A single cell on this sheet (0-based), as a single-cell range. */
  cell(row: number, col: number): ScriptRange;
  /** Make this the active sheet. */
  activate(): Promise<void>;
}

/** The workbook facet of the canonical model (C3): Workbook -> Sheet -> Range. */
declare interface ScriptWorkbook {
  /** All sheets, in tab order.
   *
   * Calcula policy (generated): List sheets.
   * Reach: broker `api.getSheetNames`, unlocked tier, class read.
   */
  sheets(): Promise<ScriptSheet[]>;
  /** The active sheet.
   *
   * Calcula policy (generated): List sheets.
   * Reach: broker `api.getSheetNames`, unlocked tier, class read.
   */
  activeSheet(): Promise<ScriptSheet>;
  /** A sheet by exact name or 0-based index; null if not found.
   *
   * Calcula policy (generated): List sheets.
   * Reach: broker `api.getSheetNames`, unlocked tier, class read.
   */
  sheet(nameOrIndex: string | number): Promise<ScriptSheet | null>;
}

/** Extended API surface available only in "unlocked" access mode. */
declare interface UnlockedAPI {
  /**
   * Canonical Workbook -> Sheet -> Range navigation (C3): the same model
   * extensions use. e.g. `const s = await api.workbook.sheet("Data"); await
   * s.range("A1:B5").setValues(...)`. Cross-sheet reach (unlocked tier only).
   */
  readonly workbook: ScriptWorkbook;
  /** Read a cell value by row/col (active sheet) as a DISPLAY STRING.
   *
   * Calcula policy (generated): Read any cell.
   * Reach: broker `api.getCellValue`, unlocked tier, class read.
   */
  getCellValue(row: number, col: number): Promise<string>;
  /** Write a cell value by row/col (active sheet).
   *
   * Calcula policy (generated): Write any cell.
   * Reach: broker `api.setCellValue`, unlocked tier, class mutate.
   */
  setCellValue(row: number, col: number, value: string): Promise<void>;
  /** Batch-update multiple cells (one undo step).
   *
   * Calcula policy (generated): Write many cells at once.
   * Reach: broker `api.updateCellsBatch`, unlocked tier, class mutate. Limits: maxCells 100,000.
   */
  updateCellsBatch(updates: Array<{ row: number; col: number; value: string }>): Promise<void>;
  /** Read one cell WITH its type and formula (any sheet; defaults to active).
   *
   * Calcula policy (generated): Read any cell with its type and formula.
   * Reach: broker `api.getCellData`, unlocked tier, class read.
   */
  getCellData(row: number, col: number, sheetIndex?: number): Promise<ScriptCell>;
  /**
   * Read a whole rectangle in ONE call as typed cells (max 100 000 cells).
   * Prefer this over looping getCellValue: a 100x100 block is one round trip
   * instead of 10 000, and the cells keep their types + formulas.
   *
   * Calcula policy (generated): Read a block of cells on any sheet in one go (values, types and formulas).
   * Reach: broker `api.getRangeValues`, unlocked tier, class read. Limits: maxCells 100,000.
   */
  getRangeValues(startRow: number, startCol: number, endRow: number, endCol: number, sheetIndex?: number): Promise<ScriptCell[][]>;
  /** Get all sheet names.
   *
   * Calcula policy (generated): List sheets.
   * Reach: broker `api.getSheetNames`, unlocked tier, class read.
   */
  getSheetNames(): Promise<string[]>;
  /** Get the active sheet index.
   *
   * Calcula policy (generated): Read the active sheet.
   * Reach: broker `api.getActiveSheet`, unlocked tier, class read.
   */
  getActiveSheet(): Promise<number>;
  /** Set the active sheet.
   *
   * Calcula policy (generated): Switch sheets.
   * Reach: broker `api.setActiveSheet`, unlocked tier, class mutate.
   */
  setActiveSheet(index: number): Promise<void>;
  /** Emit a custom event on the global event bus. Any name you invent is
   *  namespaced to `userscript:*`, so it can never collide with an app event.
   *
   * Calcula policy (generated): Emit a custom app event (auto-namespaced userscript:*).
   * Reach: broker `api.emitEvent`, unlocked tier, class emit.
   */
  emitEvent(name: string, detail?: unknown): void;
  /**
   * Listen for an event. Returns an unsubscribe function.
   *
   * Your own custom names work (they are namespaced to `userscript:*` on both
   * sides). In addition, this read-only set of APP events can be named directly:
   *
   * | Event | Payload |
   * |---|---|
   * | `app:sheet-changed` | `{ sheetIndex, sheetName }` — the ACTIVE sheet changed |
   * | `app:sheet-added` | `{ sheetIndex, sheetName, source }` — `source` is `"new"` or `"copy"` |
   * | `app:sheet-deleted` | `{ sheetIndex, sheetName }` — the index it HAD |
   * | `app:sheet-renamed` | `{ sheetIndex, oldName, newName }` |
   * | `app:recalculation-completed` | `{ scope, cellsUpdated, durationMs }` — an explicit recalc pass (F9) finished |
   * | `app:cell-values-changed` | `{ changes, source }` |
   * | `app:selection-changed` | the current selection |
   * | `app:after-open` / `app:after-save` / `app:after-new` | workbook lifecycle |
   * | `app:edit-started` / `app:edit-ended` | cell editing |
   * | `app:rows-inserted` / `app:rows-deleted` / `app:columns-inserted` / `app:columns-deleted` | `{ startRow \| startCol, count }` |
   * | `app:row-resized` / `app:column-resized` | dimension changes |
   * | `app:theme-changed` | document theme |
   * | `app:bi-model-changed` / `app:bi-refresh-completed` | BI model lifecycle |
   * | `app:package-updated` | `{ packageName, version }` — a .calp subscribe or refresh landed |
   *
   * Anything else is treated as one of your own custom names.
   *
   * ```js
   * context.api.onEvent("app:sheet-renamed", ({ oldName, newName }) => {
   *   context.log(`${oldName} is now ${newName}`);
   * });
   * ```
   *
   * Calcula policy (generated): Listen to its object's events.
   * Reach: broker `events.subscribe`, restricted tier, class read.
   */
  onEvent(name: string, handler: (detail: any) => void): () => void;
  /** Execute a registered command by ID. Args are forwarded to the handler unchanged.
   *
   * Calcula policy (generated): Run commands flagged scriptSafe by their extension.
   * Reach: broker `api.executeCommand`, unlocked tier, class mutate.
   */
  executeCommand(commandId: string, args?: unknown): void;
  /**
   * Begin an undo transaction. All cell changes until commitBatch() are
   * grouped as a single undo entry.
   * @param description Human-readable description shown in the Undo menu.
   *
   * Calcula policy (generated): Group changes for undo.
   * Reach: broker `api.beginBatch`, unlocked tier, class mutate.
   */
  beginBatch(description: string): Promise<void>;
  /** Commit the current batch, finalizing it as a single undo entry.
   *
   * Calcula policy (generated): Commit a grouped change.
   * Reach: broker `api.commitBatch`, unlocked tier, class mutate.
   */
  commitBatch(): Promise<void>;
  /** Cancel the current batch, discarding all changes since beginBatch().
   *
   * Calcula policy (generated): Cancel a grouped change.
   * Reach: broker `api.cancelBatch`, unlocked tier, class mutate.
   */
  cancelBatch(): Promise<void>;

  // -- Formatting --

  /**
   * Apply a PARTIAL format to a rectangle (max 100 000 cells) — one call, one
   * undo step. Only the properties you set change. Works on ANY sheet.
   * e.g. `await api.setRangeFormat(0, 0, 0, 4, { bold: true, backgroundColor: "#EEEEEE" })`
   *
   * Calcula policy (generated): Change how cells look on any sheet (font, colour, alignment, number format, borders).
   * Reach: broker `api.setRangeFormat`, unlocked tier, class mutate. Limits: maxCells 100,000.
   */
  setRangeFormat(startRow: number, startCol: number, endRow: number, endCol: number, format: ScriptFormat, sheetIndex?: number): Promise<void>;
  /** Remove ALL formatting from a rectangle, keeping the values. ACTIVE SHEET
   *  only — call setActiveSheet() first for another sheet.
   *
   * Calcula policy (generated): Remove all formatting from a block of cells (the values are kept).
   * Reach: broker `api.clearRangeFormat`, unlocked tier, class mutate. Limits: maxCells 100,000.
   */
  clearRangeFormat(startRow: number, startCol: number, endRow: number, endCol: number, sheetIndex?: number): Promise<void>;

  // -- Structure --
  // Every method in this block acts on the ACTIVE sheet. Passing a sheetIndex
  // that names another sheet REJECTS (it never silently retargets) — call
  // setActiveSheet() first. Only formatting is genuinely sheet-scoped.

  /** Insert `count` rows at `startRow`, shifting everything below down.
   *
   * Calcula policy (generated): Insert rows, shifting everything below them down.
   * Reach: broker `api.insertRows`, unlocked tier, class mutate.
   */
  insertRows(startRow: number, count: number, sheetIndex?: number): Promise<void>;
  /** Delete `count` rows from `startRow` (their contents are lost).
   *
   * Calcula policy (generated): Delete rows, shifting everything below them up (their contents are lost).
   * Reach: broker `api.deleteRows`, unlocked tier, class mutate.
   */
  deleteRows(startRow: number, count: number, sheetIndex?: number): Promise<void>;
  /** Insert `count` columns at `startCol`, shifting everything right.
   *
   * Calcula policy (generated): Insert columns, shifting everything to their right.
   * Reach: broker `api.insertColumns`, unlocked tier, class mutate.
   */
  insertColumns(startCol: number, count: number, sheetIndex?: number): Promise<void>;
  /** Delete `count` columns from `startCol` (their contents are lost).
   *
   * Calcula policy (generated): Delete columns, shifting the rest left (their contents are lost).
   * Reach: broker `api.deleteColumns`, unlocked tier, class mutate.
   */
  deleteColumns(startCol: number, count: number, sheetIndex?: number): Promise<void>;
  /** Merge a rectangle into one cell (only the top-left value survives).
   *
   * Calcula policy (generated): Merge a block of cells into one (only the top-left value is kept).
   * Reach: broker `api.mergeCells`, unlocked tier, class mutate.
   */
  mergeCells(startRow: number, startCol: number, endRow: number, endCol: number, sheetIndex?: number): Promise<void>;
  /** Split the merged region containing (row, col) back into single cells.
   *
   * Calcula policy (generated): Split a merged block back into individual cells.
   * Reach: broker `api.unmergeCells`, unlocked tier, class mutate.
   */
  unmergeCells(row: number, col: number, sheetIndex?: number): Promise<void>;
  /** Set a row's height in pixels (0 restores the sheet default).
   *
   * Calcula policy (generated): Change a row's height.
   * Reach: broker `api.setRowHeight`, unlocked tier, class mutate.
   */
  setRowHeight(row: number, height: number, sheetIndex?: number): Promise<void>;
  /** Set a column's width in pixels (0 restores the sheet default).
   *
   * Calcula policy (generated): Change a column's width.
   * Reach: broker `api.setColumnWidth`, unlocked tier, class mutate.
   */
  setColumnWidth(col: number, width: number, sheetIndex?: number): Promise<void>;
  /** Freeze rows/columns so they stay on screen while scrolling. `freezeRow` is
   *  how many rows to freeze from the top; null unfreezes that axis.
   *
   * Calcula policy (generated): Freeze (or unfreeze) rows and columns so they stay on screen while scrolling.
   * Reach: broker `api.freezePanes`, unlocked tier, class mutate.
   */
  freezePanes(freezeRow: number | null, freezeCol: number | null): Promise<void>;

  // -- Sheets --

  /** Add a sheet (and make it active). Rejects a name that already exists.
   *
   * Calcula policy (generated): Add a new sheet to the workbook.
   * Reach: broker `api.addSheet`, unlocked tier, class mutate.
   */
  addSheet(name?: string): Promise<{ index: number; name: string }>;
  /** Delete a sheet and everything on it. Rejects on the last remaining sheet.
   *
   * Calcula policy (generated): Delete a sheet and everything on it.
   * Reach: broker `api.deleteSheet`, unlocked tier, class mutate.
   */
  deleteSheet(index: number): Promise<void>;
  /** Rename a sheet. Rejects a name that already exists.
   *
   * Calcula policy (generated): Rename a sheet.
   * Reach: broker `api.renameSheet`, unlocked tier, class mutate.
   */
  renameSheet(index: number, newName: string): Promise<void>;
  /** Show or hide a sheet. Rejects hiding the last visible one.
   *
   * Calcula policy (generated): Show or hide a sheet.
   * Reach: broker `api.setSheetVisibility`, unlocked tier, class mutate.
   */
  setSheetVisibility(index: number, visibility: "visible" | "hidden" | "veryHidden"): Promise<void>;

  // -- Sort + find/replace --

  /**
   * Sort a rectangle by one or more criteria (ACTIVE SHEET). Resolves to the
   * number of rows (or columns) moved.
   *
   * Calcula policy (generated): Sort a block of cells by one or more columns.
   * Reach: broker `api.sortRange`, unlocked tier, class mutate.
   */
  sortRange(startRow: number, startCol: number, endRow: number, endCol: number, fields: ScriptSortField[], options?: { matchCase?: boolean; hasHeaders?: boolean; orientation?: "rows" | "columns" }, sheetIndex?: number): Promise<number>;
  /** Find every matching cell on the active sheet, in reading order.
   *
   * Calcula policy (generated): Find every cell on the active sheet matching a search text.
   * Reach: broker `api.findAll`, unlocked tier, class read.
   */
  findAll(query: string, options?: { caseSensitive?: boolean; matchEntireCell?: boolean; searchFormulas?: boolean }): Promise<{ matches: ScriptFindMatch[]; totalCount: number }>;
  /** Replace everywhere on the active sheet (one undo step).
   *
   * Calcula policy (generated): Replace a search text everywhere on the active sheet (a single undo step).
   * Reach: broker `api.replaceAll`, unlocked tier, class mutate.
   */
  replaceAll(search: string, replacement: string, options?: { caseSensitive?: boolean; matchEntireCell?: boolean }): Promise<{ replacementCount: number }>;

  // -- Workbook objects: enumerate --
  // Identity and position only — never an object's contents.

  /** Every chart in the workbook.
   *
   * Calcula policy (generated): List the charts, tables, pivot tables, named ranges, slicers or form controls in this workbook (names and positions, never their contents).
   * Reach: broker `api.listObjects`, unlocked tier, class read. Limits: maxObjects 5,000.
   */
  charts(): Promise<ScriptObjectRef[]>;
  /** Every structured table in the workbook.
   *
   * Calcula policy (generated): List the charts, tables, pivot tables, named ranges, slicers or form controls in this workbook (names and positions, never their contents).
   * Reach: broker `api.listObjects`, unlocked tier, class read. Limits: maxObjects 5,000.
   */
  tables(): Promise<ScriptObjectRef[]>;
  /** Every pivot table in the workbook.
   *
   * Calcula policy (generated): List the charts, tables, pivot tables, named ranges, slicers or form controls in this workbook (names and positions, never their contents).
   * Reach: broker `api.listObjects`, unlocked tier, class read. Limits: maxObjects 5,000.
   */
  pivots(): Promise<ScriptObjectRef[]>;
  /** Every named range in the workbook.
   *
   * Calcula policy (generated): List the charts, tables, pivot tables, named ranges, slicers or form controls in this workbook (names and positions, never their contents).
   * Reach: broker `api.listObjects`, unlocked tier, class read. Limits: maxObjects 5,000.
   */
  namedRanges(): Promise<ScriptObjectRef[]>;
  /** Every slicer in the workbook.
   *
   * Calcula policy (generated): List the charts, tables, pivot tables, named ranges, slicers or form controls in this workbook (names and positions, never their contents).
   * Reach: broker `api.listObjects`, unlocked tier, class read. Limits: maxObjects 5,000.
   */
  slicers(): Promise<ScriptObjectRef[]>;
  /** Every cell-anchored form control / shape in the workbook.
   *
   * Calcula policy (generated): List the charts, tables, pivot tables, named ranges, slicers or form controls in this workbook (names and positions, never their contents).
   * Reach: broker `api.listObjects`, unlocked tier, class read. Limits: maxObjects 5,000.
   */
  shapes(): Promise<ScriptObjectRef[]>;

  // -- Workbook objects: create / delete --

  /**
   * Add a chart from a full ChartSpec. The spec is schema-validated — the
   * promise REJECTS (with the violations) rather than creating a broken chart.
   * Resolves to the new chart's id.
   * e.g. `const id = await api.createChart({ mark: "bar", data: "Sheet1!A1:B10", series: [...] })`
   *
   * Calcula policy (generated): Add a new chart to a sheet.
   * Reach: broker `api.createChart`, unlocked tier, class mutate.
   */
  createChart(spec: Record<string, unknown>, options?: { name?: string; sheetIndex?: number; x?: number; y?: number; width?: number; height?: number }): Promise<string>;
  /** Delete a chart by id.
   *
   * Calcula policy (generated): Delete a chart.
   * Reach: broker `api.deleteChart`, unlocked tier, class mutate.
   */
  deleteChart(chartId: string): Promise<void>;
  /**
   * Turn a block of cells into a table. Always on the ACTIVE SHEET (the header
   * names are read from the live grid) — call setActiveSheet() first for
   * another sheet. Resolves to the new table's descriptor.
   *
   * Calcula policy (generated): Turn a block of cells into a table (with filter buttons and a header row).
   * Reach: broker `api.createTable`, unlocked tier, class mutate.
   */
  createTable(startRow: number, startCol: number, endRow: number, endCol: number, options?: { name?: string; hasHeaders?: boolean }): Promise<ScriptObjectRef>;
  /** Delete a table (its cells and values are kept). ACTIVE SHEET only.
   *
   * Calcula policy (generated): Delete a table (the cells and their values are kept).
   * Reach: broker `api.deleteTable`, unlocked tier, class mutate.
   */
  deleteTable(tableId: string): Promise<void>;
  /**
   * Create a named range. Omit `sheetIndex` (or pass null) for a
   * workbook-scoped name. `refersTo` is a formula: "=Sheet1!$A$1:$B$10".
   *
   * Calcula policy (generated): Create a named range (a name that formulas can use for a block of cells).
   * Reach: broker `api.createNamedRange`, unlocked tier, class mutate.
   */
  createNamedRange(name: string, refersTo: string, options?: { sheetIndex?: number | null; comment?: string }): Promise<void>;
  /** Delete a named range (formulas using the name will break).
   *
   * Calcula policy (generated): Delete a named range (formulas using the name will break).
   * Reach: broker `api.deleteNamedRange`, unlocked tier, class mutate.
   */
  deleteNamedRange(name: string): Promise<void>;
  /**
   * Create a pivot table and lay out its fields in one call. Field names are
   * the SOURCE COLUMN names; areas use the Pivot Layout DSL's vocabulary.
   * e.g. `await api.createPivot("A1:D100", "F1", { rows: ["Region"], values: [{ field: "Sales", aggregation: "sum" }] })`
   *
   * Calcula policy (generated): Create a pivot table over a block of cells and lay out its fields.
   * Reach: broker `api.createPivot`, unlocked tier, class mutate.
   */
  createPivot(
    sourceRange: string,
    destinationCell: string,
    fields: {
      rows?: string[];
      columns?: string[];
      filters?: string[];
      values: Array<string | { field: string; aggregation?: ScriptAggregation }>;
    },
    options?: { name?: string; sourceSheet?: number; destinationSheet?: number; hasHeaders?: boolean },
  ): Promise<ScriptObjectRef>;
  /** Delete a pivot table.
   *
   * Calcula policy (generated): Delete a pivot table.
   * Reach: broker `api.deletePivot`, unlocked tier, class mutate.
   */
  deletePivot(pivotId: string): Promise<void>;

  // -- Workbook objects: address ANOTHER instance --
  // A script is pinned to ONE object at mount. These handles reach any OTHER
  // object in the workbook by id, using the same operations that object's own
  // script has. Unlocked scripts only.

  /** A handle on any chart: `await api.chart(id).updateSpec({ title: "Q4" })`. */
  chart(chartId: string): ScriptChartHandle;
  /** A handle on any table (table-relative coordinates, clamped to its body). */
  table(tableId: string): ScriptTableHandle;
  /** A handle on any pivot table, including its field layout. */
  pivot(pivotId: string): ScriptPivotHandle;
  /** A handle on any slicer's selection and style. */
  slicer(slicerId: string): ScriptSlicerHandle;
  /** A handle on any form control / shape. */
  shape(shapeId: string): ScriptShapeHandle;
  /** A handle on any named range. */
  namedRange(name: string): ScriptNamedRangeHandle;
}

/**
 * Which .calp package a DISTRIBUTED script shipped in. Supplied by Calcula at
 * mount time from the package it actually came from — a script cannot set or
 * change it, so a value you read here (or receive from another script) is true.
 */
declare interface ScriptPackageInfo {
  /** The package name, as published. */
  readonly name: string;
  /** The exact version this script's source came from ("2.4.1"), or `null` for
   *  a package pulled before versions were stamped onto scripts. */
  readonly version: string | null;
  readonly provenance: "distributed";
}

/** Base context available to all scriptable objects. */
declare interface BaseObjectContext {
  /** The object type. */
  readonly objectType: string;
  /** The script access level: "restricted" or "unlocked". */
  readonly accessLevel: string;
  /** The current script API version (semver). */
  readonly apiVersion: string;
  /**
   * The package this script was distributed in, or `null` when it was written
   * locally in this workbook.
   *
   * ```js
   * if (context.package) {
   *   context.log(`shipped in ${context.package.name} v${context.package.version}`);
   * }
   * ```
   */
  readonly package: ScriptPackageInfo | null;
  /**
   * Expose a custom method that other scripts or extensions can call.
   * The method becomes callable from other scripts via callMethod().
   * Pass { public: true } to allow calls from scripts of a different
   * tier or package; otherwise only same-trust scripts can call it.
   * @returns Cleanup function that withdraws the method immediately. Calling it
   *          is optional — every exposed method is withdrawn automatically when
   *          the script is unmounted or the workbook closes.
   *
   * Calcula policy (generated): Expose a method to other scripts.
   * Reach: broker `base.expose`, restricted tier, class emit.
   */
  expose(name: string, handler: (...args: any[]) => any, options?: { public?: boolean }): () => void;
  /**
   * Call a method exposed by another object's script. Asynchronous: await
   * the result. Cross-tier or cross-package calls require the target to
   * have been exposed with { public: true }.
   * @param targetType The object type (e.g., "slicer", "workbook").
   * @param targetInstanceId The instance ID (null for primitives).
   * @param methodName The method name registered via expose().
   * @param args Arguments to pass.
   * @returns Promise of the return value, or undefined if the method is not found.
   *
   * Calcula policy (generated): Call a method exposed by another script (cross-tier requires the target to be public).
   * Reach: broker `base.callMethod`, restricted tier, class emit.
   */
  callMethod(targetType: string, targetInstanceId: string | null, methodName: string, ...args: any[]): Promise<any>;
  /** Log to the script console (visible in the Code tab output panel).
   *
   * Calcula policy (generated): Write to the script console.
   * Reach: broker `base.log`, restricted tier, class emit.
   */
  log(...args: any[]): void;
  /** Show a toast notification to the user.
   *
   * Calcula policy (generated): Show a toast notification.
   * Reach: broker `base.notify`, restricted tier, class emit.
   */
  notify(message: string, type?: "info" | "success" | "warning" | "error"): void;
  /** Sandboxed capability surface (see {@link ScriptCapabilities}). */
  caps: ScriptCapabilities;
  /**
   * Full extension API access (only available in "unlocked" mode).
   * In "restricted" mode, this is null.
   */
  readonly api: UnlockedAPI | null;
}

// ============================================================================
// Primitive Contexts (workbook-scoped)
// ============================================================================

/** Context for Workbook-level scripts. */
declare interface WorkbookContext extends BaseObjectContext {
  /** Called when the workbook is opened. */
  onOpen(handler: () => void): () => void;
  /**
   * Called before the workbook is saved — and it can STOP the save.
   *
   * Return `false`, `"cancel"`, or `{ cancel: true, reason }` to cancel;
   * returning nothing (the usual case) lets the save proceed. A cancellation is
   * shown to the user with your script's name and your `reason`, so it never
   * looks like Ctrl+S simply broke.
   *
   * You may `await` inside the handler — write a timestamp, validate a block of
   * inputs, ask the user with `caps.dialog.confirm`. But answer QUICKLY: Calcula
   * gives each script a few seconds, and a verdict that arrives after that is
   * ignored and the save goes ahead. That is deliberate — a hung script must
   * never be able to make a workbook unsaveable.
   *
   * ```js
   * workbook.onBeforeSave(async ({ path }) => {
   *   const total = await context.api.getCellValue(20, 3);
   *   if (!total) return { cancel: true, reason: "Fill in the total in D21 first" };
   *   await context.api.setCellValue(0, 5, new Date().toISOString());
   * });
   * ```
   */
  onBeforeSave(
    handler: (detail: { path?: string }) =>
      | void
      | false
      | "cancel"
      | { cancel: true; reason?: string }
      | Promise<void | false | "cancel" | { cancel: true; reason?: string }>,
  ): () => void;
  /** Called after the workbook is saved. */
  onAfterSave(handler: () => void): () => void;
  /**
   * Called before the workbook is closed — and it can STOP the close, with the
   * same verdict shapes and the same deadline as
   * {@link WorkbookContext.onBeforeSave}. Use it to flush state or to warn about
   * work in progress; do NOT use it to trap the user in the app.
   */
  onBeforeClose(
    handler: () =>
      | void
      | false
      | "cancel"
      | { cancel: true; reason?: string }
      | Promise<void | false | "cancel" | { cancel: true; reason?: string }>,
  ): () => void;
  /** Called when the active sheet changes. */
  onSheetChange(handler: (detail: { sheetIndex: number; sheetName: string }) => void): () => void;
  /** Called when the theme changes. */
  onThemeChange(handler: () => void): () => void;
  /** Access workbook properties. */
  readonly properties: {
    readonly title: string;
    readonly author: string;
    readonly sheetCount: number;
    getSheetNames(): string[];
  };
}

/**
 * The object-script Range facet of the canonical shared object model (C3) — the
 * same Workbook -> Sheet -> Range -> Cell shape extensions use, bound to the
 * script's own sheet and async over the broker. Values are display strings.
 */
declare interface ScriptRange {
  readonly startRow: number;
  readonly startCol: number;
  readonly endRow: number;
  readonly endCol: number;
  readonly rowCount: number;
  readonly colCount: number;
  readonly isSingleCell: boolean;
  /** A1 address ("A1" or "A1:B5"). */
  readonly address: string;
  /** A new range shifted by (rowOffset, colOffset), same size. */
  offset(rowOffset: number, colOffset: number): ScriptRange;
  /** A new range, same top-left, resized to rows x cols. */
  resize(rows: number, cols: number): ScriptRange;
  /** A single-cell range at the given offset within this range. */
  getCell(rowOffset: number, colOffset: number): ScriptRange;
  /** The top-left cell's display value.
   *
   * Calcula policy (generated): Read another object in this workbook (its chart spec, table cells, slicer selection, ...).
   * Reach: broker `api.objectGetState`, unlocked tier, class read.
   */
  getValue(): Promise<string>;
  /**
   * All values as a rows x cols grid of display strings — ONE round trip.
   * These are FORMATTED strings: do NOT write them back (every formula would
   * become its rendered text). Use getData() when you need types or formulas.
   *
   * Calcula policy (generated): Read another object in this workbook (its chart spec, table cells, slicer selection, ...).
   * Reach: broker `api.objectGetState`, unlocked tier, class read.
   */
  getValues(): Promise<string[][]>;
  /** All cells with value, type and formula — ONE round trip. The safe read
   *  for a read/modify/write round-trip.
   *
   * Calcula policy (generated): Read another object in this workbook (its chart spec, table cells, slicer selection, ...).
   * Reach: broker `api.objectGetState`, unlocked tier, class read.
   */
  getData(): Promise<ScriptCell[][]>;
  /** All formulas as a rows x cols grid ("" where a cell has none).
   *
   * Calcula policy (generated): Read another object in this workbook (its chart spec, table cells, slicer selection, ...).
   * Reach: broker `api.objectGetState`, unlocked tier, class read.
   */
  getFormulas(): Promise<string[][]>;
  /** Set the top-left cell's value.
   *
   * Calcula policy (generated): Change another object in this workbook (its chart spec, slicer selection, pivot layout, shape properties, ...).
   * Reach: broker `api.objectSetState`, unlocked tier, class mutate.
   */
  setValue(value: string): Promise<void>;
  /** Set values from a 2D array (clamped to the range's dimensions) — ONE call,
   *  one undo step.
   *
   * Calcula policy (generated): Change another object in this workbook (its chart spec, slicer selection, pivot layout, shape properties, ...).
   * Reach: broker `api.objectSetState`, unlocked tier, class mutate.
   */
  setValues(values: string[][]): Promise<void>;
  /** Apply a PARTIAL format to every cell in the range — ONE call, one undo
   *  step. Absent properties are left alone:
   *  `await sheet.range("A1:C1").format({ bold: true })`.
   *
   * Calcula policy (generated): Change another object in this workbook (its chart spec, slicer selection, pivot layout, shape properties, ...).
   * Reach: broker `api.objectSetState`, unlocked tier, class mutate.
   */
  format(format: ScriptFormat): Promise<void>;
  /** Remove ALL formatting from the range, keeping the values.
   *
   * Calcula policy (generated): Change another object in this workbook (its chart spec, slicer selection, pivot layout, shape properties, ...).
   * Reach: broker `api.objectSetState`, unlocked tier, class mutate.
   */
  clearFormat(): Promise<void>;
}

/** Context for Sheet-level scripts (applies to all sheets). */
declare interface SheetContext extends BaseObjectContext {
  /** Called when any sheet is activated (switched to). */
  onActivate(handler: (detail: { sheetIndex: number; sheetName: string }) => void): () => void;
  /** Called when any sheet is deactivated (switched away from). */
  onDeactivate(handler: (detail: { sheetIndex: number; sheetName: string }) => void): () => void;
  /** Called when the selection changes on any sheet. */
  onSelectionChange(handler: (detail: { sheetIndex: number; row: number; col: number; endRow: number; endCol: number }) => void): () => void;
  /** Called when data changes on any sheet. */
  onDataChange(handler: (detail: { sheetIndex: number; changes: Array<{ row: number; col: number; oldValue?: string; newValue: string }> }) => void): () => void;
  /** Read a cell's DISPLAY STRING from the specified (or active) sheet.
   *
   * Calcula policy (generated): Read cells on its own sheet (sheet scripts; clamped to the bound sheet).
   * Reach: broker `sheet.getCellValue`, restricted tier, class read.
   */
  getCellValue(row: number, col: number, sheetIndex?: number): Promise<string>;
  /** Write a cell value.
   *
   * Calcula policy (generated): Write cells on its own sheet (sheet scripts; clamped to the bound sheet).
   * Reach: broker `sheet.setCellValue`, restricted tier, class mutate.
   */
  setCellValue(row: number, col: number, value: string, sheetIndex?: number): Promise<void>;
  /** Read one cell WITH its type and formula. Restricted scripts may only name
   *  their own (active) sheet.
   *
   * Calcula policy (generated): Read one cell on its own sheet with its type and formula.
   * Reach: broker `sheet.getCellData`, restricted tier, class read.
   */
  getCellData(row: number, col: number, sheetIndex?: number): Promise<ScriptCell>;
  /** Apply a PARTIAL format to a rectangle on this sheet — one call, one undo
   *  step. Only the properties you set change. Restricted scripts may only name
   *  their own (active) sheet.
   *
   * Calcula policy (generated): Change how cells look on its own sheet (font, colour, alignment, number format, borders).
   * Reach: broker `sheet.setRangeFormat`, restricted tier, class mutate. Limits: maxCells 100,000.
   */
  setRangeFormat(startRow: number, startCol: number, endRow: number, endCol: number, format: ScriptFormat, sheetIndex?: number): Promise<void>;
  /** Remove ALL formatting from a rectangle on this sheet, keeping the values.
   *
   * Calcula policy (generated): Remove all formatting from a block of cells on its own sheet (the values are kept).
   * Reach: broker `sheet.clearRangeFormat`, restricted tier, class mutate. Limits: maxCells 100,000.
   */
  clearRangeFormat(startRow: number, startCol: number, endRow: number, endCol: number, sheetIndex?: number): Promise<void>;
  /**
   * A range on THIS sheet by A1 address ("A1", "A1:B5") — the canonical model
   * facet (C3). Reads/writes are clamped to this sheet. Prefer this over the
   * flat getCellValue/setCellValue: `sheet.range("A1:B5").setValues(...)`.
   */
  range(address: string): ScriptRange;
  /** A single cell on this sheet (0-based), as a single-cell range. */
  cell(row: number, col: number): ScriptRange;
}

/** Context for Cell-level scripts (applies to all cells). */
declare interface CellContext extends BaseObjectContext {
  /** Called when any cell is edited (value committed). */
  onEdit(handler: (detail: { row: number; col: number; sheetIndex: number; oldValue?: string; newValue: string; formula?: string | null }) => void): () => void;
  /** Called when a cell is selected. */
  onSelect(handler: (detail: { row: number; col: number; sheetIndex: number }) => void): () => void;
  /** Called when editing starts on a cell. */
  onEditStart(handler: (detail: { row: number; col: number; sheetIndex: number }) => void): () => void;
  /** Called when editing ends (commit or cancel). */
  onEditEnd(handler: (detail: { row: number; col: number; sheetIndex: number; committed: boolean }) => void): () => void;
  /**
   * Register a custom cell renderer that runs for every visible cell.
   * Return a style override object to modify appearance, or null to use default.
   *
   * MUST be a pure function of its cell argument (value + coordinates):
   * results are cached and re-evaluated only when the cell changes. A
   * renderer reading outside state degrades to stale styling — call
   * render.invalidate() after changing such state to force re-evaluation.
   */
  onRender(handler: (cell: { row: number; col: number; sheetIndex: number; value: string; formula?: string | null }) => { textColor?: string; backgroundColor?: string; bold?: boolean; italic?: boolean } | null): () => void;
  /** Cache controls for onRender. */
  render: {
    /** Clear this script's cached render results and repaint.
     *
     * Calcula policy (generated): Request a re-render of its own visuals.
     * Reach: broker `render.invalidate`, restricted tier, class emit.
     */
    invalidate(): void;
  };
}

/** Context for Row-level scripts (applies to all rows). */
declare interface RowContext extends BaseObjectContext {
  /** Called when rows are inserted. */
  onInsert(handler: (detail: { sheetIndex: number; startRow: number; count: number }) => void): () => void;
  /** Called when rows are deleted. */
  onDelete(handler: (detail: { sheetIndex: number; startRow: number; count: number }) => void): () => void;
  /** Called when a row height changes. */
  onResize(handler: (detail: { sheetIndex: number; row: number; height: number }) => void): () => void;
}

/** Context for Column-level scripts (applies to all columns). */
declare interface ColumnContext extends BaseObjectContext {
  /** Called when columns are inserted. */
  onInsert(handler: (detail: { sheetIndex: number; startCol: number; count: number }) => void): () => void;
  /** Called when columns are deleted. */
  onDelete(handler: (detail: { sheetIndex: number; startCol: number; count: number }) => void): () => void;
  /** Called when a column width changes. */
  onResize(handler: (detail: { sheetIndex: number; col: number; width: number }) => void): () => void;
}

// ============================================================================
// Component Contexts (per-instance)
// ============================================================================

/** Context for Slicer instances. */
declare interface SlicerContext extends BaseObjectContext {
  /** The slicer instance ID. */
  readonly instanceId: string;
  /** The slicer name. */
  readonly name: string;
  /** Called when slicer selection changes (items are selected/deselected). */
  onSelectionChange(handler: (detail: { selectedItems: string[] }) => void): () => void;
  /** Get the currently selected items. */
  getSelectedItems(): string[];
  /** Set the selected items programmatically.
   *
   * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
   * Reach: broker `object.setState`, aspect `slicer.setSelectedItems`, restricted tier, class mutate.
   */
  setSelectedItems(items: string[]): Promise<void>;
  /** Clear all selections.
   *
   * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
   * Reach: broker `object.setState`, aspect `slicer.setSelectedItems`, restricted tier, class mutate.
   */
  clearSelection(): Promise<void>;
  /** Select all items.
   *
   * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
   * Reach: broker `object.setState`, aspect `slicer.setSelectedItems`, restricted tier, class mutate.
   */
  selectAll(): Promise<void>;
  /** Style customization namespace. */
  style: {
    /** Override the item renderer for custom appearance. */
    itemRenderer(renderer: (
      item: { text: string; selected: boolean; hasData: boolean; index: number },
      ctx: CanvasRenderingContext2D,
      bounds: { x: number; y: number; width: number; height: number },
    ) => void): () => void;
    /**
     * Set a canvas-style property on the slicer.
     * Supported: backgroundColor, headerBackgroundColor, headerTextColor,
     *            itemBackgroundColor, itemTextColor, selectedBackgroundColor,
     *            selectedTextColor, borderColor, borderRadius, opacity.
     *
     * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
     * Reach: broker `object.setState`, aspect `slicer.setStyleProperty`, restricted tier, class mutate.
     */
    setProperty(name: string, value: string): void;
    /** Discard this slicer's cached item painting and repaint it. Call it after
     *  changing state your `itemRenderer` reads but Calcula cannot see.
     *
     * Calcula policy (generated): Request a re-render of its own visuals.
     * Reach: broker `render.invalidate`, restricted tier, class emit.
     */
    invalidate(): void;
  };
  /** Slicer properties (read-only). */
  readonly properties: {
    readonly fieldName: string;
    readonly sourceType: string;
    readonly columns: number;
  };
}

/** Context for Timeline (date-range slicer) instances. */
declare interface TimelineContext extends BaseObjectContext {
  /** The timeline instance ID. */
  readonly instanceId: string;
  /** The timeline name. */
  readonly name: string;
  /** Called when the selected date range changes. start/end are ISO
   *  "YYYY-MM-DD" strings, or null for an open bound. */
  onChange(handler: (detail: { start: string | null; end: string | null }) => void): () => void;
  /** Get the currently selected date range (null bound = open-ended). */
  getRange(): { start: string | null; end: string | null };
  /** Set the selected date range (ISO "YYYY-MM-DD"; null leaves a bound open).
   *
   * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
   * Reach: broker `object.setState`, aspect `timeline.setSelection`, restricted tier, class mutate.
   */
  setRange(start: string | null, end: string | null): Promise<void>;
  /** Clear the selection so every date is shown.
   *
   * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
   * Reach: broker `object.setState`, aspect `timeline.setSelection`, restricted tier, class mutate.
   */
  clearSelection(): Promise<void>;
  /** Timeline properties (read-only). */
  readonly properties: {
    /** The date field the timeline filters on. */
    readonly fieldName: string;
    /** Current granularity: "years" | "quarters" | "months" | "days". */
    readonly level: string;
    /** Source type (currently always "pivot"). */
    readonly sourceType: string;
  };
}

/** Context for Chart instances. */
declare interface ChartContext extends BaseObjectContext {
  /** The chart instance ID. */
  readonly instanceId: string;
  /** Called when the chart's source data changes. */
  onDataChange(handler: () => void): () => void;
  /** Get the chart specification (JSON object). */
  getSpec(): Record<string, unknown>;
  /** Update the chart specification (merge patch). Schema-validated — the promise
   *  rejects if the merged spec would be invalid.
   *
   * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
   * Reach: broker `object.setState`, aspect `chart.updateSpec`, restricted tier, class mutate.
   */
  updateSpec(patch: Record<string, unknown>): Promise<void>;
  /** Replace the entire chart specification (full re-author). Schema-validated —
   *  the promise rejects on an invalid spec.
   *
   * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
   * Reach: broker `object.setState`, aspect `chart.replaceSpec`, restricted tier, class mutate.
   */
  replaceSpec(fullSpec: Record<string, unknown>): Promise<void>;
  /** Style customization. */
  style: {
    /** Set a canvas-style property override (stored in chart spec).
     *
     * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
     * Reach: broker `object.setState`, aspect `chart.setStyleProperty`, restricted tier, class mutate.
     */
    setProperty(name: string, value: string): void;
  };
}

/** The drilled cell delivered to a pivot `onDrillThrough` handler. */
declare interface PivotDrillContext {
  /** The pivot instance ID. */
  readonly pivotId: string;
  /** The drilled cell as resolved dimension coordinates (empty for a grand total). */
  readonly cell: ReadonlyArray<{ table: string; column: string; value: string }>;
}

/** Context for Pivot Table instances. */
declare interface PivotContext extends BaseObjectContext {
  /** The pivot instance ID. */
  readonly instanceId: string;
  /** Called when the pivot is refreshed (recalculated). */
  onRefresh(handler: () => void): () => void;
  /**
   * Called when the user double-clicks a data/total cell and the pivot's
   * drill-through behavior is set to "script". The handler receives the drilled
   * cell as resolved (table, column, value) pairs; produce the drill via your
   * granted capabilities (e.g. bi.query, then write a sheet).
   */
  onDrillThrough(handler: (ctx: PivotDrillContext) => void): () => void;
  /** Get current pivot field configuration (sync, seeded from the mount
   *  snapshot and refreshed after every layout change below). */
  getFields(): { rows: string[]; columns: string[]; values: string[]; filters: string[] };
  /** Refresh the pivot table data.
   *
   * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
   * Reach: broker `object.setState`, aspect `pivot.refresh`, restricted tier, class mutate.
   */
  refresh(): Promise<void>;

  // -- Layout --
  // The vocabulary is the Pivot Layout DSL's, so a script and the DSL editor
  // describe the same pivot with the same words: areas are rows/columns/values/
  // filters, aggregations are sum/count/average/..., and setLayout takes the
  // LAYOUT clause's directives. `field` is the SOURCE COLUMN name; naming a
  // column that does not exist rejects with the list of the ones that do.

  /**
   * Place a source field in an area.
   * e.g. `await pivot.addField("Revenue", "values", undefined, "average")`
   * @param position insert index within the area (default: append).
   * @param aggregation only meaningful for the "values" area (default: sum).
   *
   * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
   * Reach: broker `object.setState`, aspect `pivot.addField`, restricted tier, class mutate.
   */
  addField(field: string, area: ScriptPivotArea, position?: number, aggregation?: ScriptAggregation): Promise<void>;
  /** Move an already-placed field to another area (or another position).
   *
   * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
   * Reach: broker `object.setState`, aspect `pivot.moveField`, restricted tier, class mutate.
   */
  moveField(field: string, area: ScriptPivotArea, position?: number): Promise<void>;
  /** Remove a placed field. Omit `area` to remove it from wherever it sits.
   *
   * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
   * Reach: broker `object.setState`, aspect `pivot.removeField`, restricted tier, class mutate.
   */
  removeField(field: string, area?: ScriptPivotArea): Promise<void>;
  /** Change how a VALUE field is summarized.
   *
   * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
   * Reach: broker `object.setState`, aspect `pivot.setAggregation`, restricted tier, class mutate.
   */
  setAggregation(field: string, aggregation: ScriptAggregation): Promise<void>;
  /** Apply LAYOUT directives, left to right (a later directive wins).
   *  e.g. `await pivot.setLayout(["tabular", "values-on-rows", "no-grand-totals"])`
   *
   * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
   * Reach: broker `object.setState`, aspect `pivot.setLayout`, restricted tier, class mutate.
   */
  setLayout(directives: ScriptPivotLayoutDirective[]): Promise<void>;
}

// ============================================================================
// Panel Context (ribbon tabs & sidebar views)
// ============================================================================

/** Context for Panel instances (ribbon tabs and sidebar views). */
declare interface PanelContext extends BaseObjectContext {
  /** The panel ID (matches the PanelDefinition.id used during registration). */
  readonly instanceId: string;
  /** The panel title. */
  readonly title: string;

  // -- Events --

  /** Called when the panel tab/icon is clicked by the user. */
  onClick(handler: (detail: { placement: string }) => void): () => void;
  /** Called when the panel becomes the active tab or view. */
  onActivate(handler: (detail: { placement: string }) => void): () => void;
  /** Called when the panel loses active state (another tab/view selected). */
  onDeactivate(handler: (detail: { placement: string }) => void): () => void;
  /** Called when the panel is moved between ribbon and sidebar. */
  onPlacementChange(handler: (detail: { oldPlacement: string; newPlacement: string }) => void): () => void;
  /** Called when the panel becomes visible (opened/expanded). */
  onShow(handler: () => void): () => void;
  /** Called when the panel is hidden (closed/collapsed). */
  onHide(handler: () => void): () => void;

  // -- Actions --

  /** Open (activate) this panel programmatically.
   *
   * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
   * Reach: broker `object.setState`, aspect `panel.open`, restricted tier, class mutate.
   */
  open(): void;
  /** Close (hide) this panel. For sidebar panels, collapses the side panel.
   *
   * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
   * Reach: broker `object.setState`, aspect `panel.close`, restricted tier, class mutate.
   */
  close(): void;
  /** Set a badge on the panel's tab/icon (e.g., notification count). Pass null to clear.
   *
   * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
   * Reach: broker `object.setState`, aspect `panel.setBadge`, restricted tier, class mutate.
   */
  setBadge(text: string | null): void;
  /** Move this panel to a different location ("ribbon" or "sidebar").
   *
   * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
   * Reach: broker `object.setState`, aspect `panel.moveTo`, restricted tier, class mutate.
   */
  moveTo(placement: "ribbon" | "sidebar"): void;

  /** Panel properties (read-only). */
  readonly properties: {
    /** Panel ID. */
    readonly panelId: string;
    /** Panel title. */
    readonly title: string;
    /** Current placement: "ribbon" or "sidebar". */
    readonly placement: string;
    /** Whether the panel can be moved between locations. */
    readonly movable: boolean;
  };
}

// ============================================================================
// Shape Context
// ============================================================================

/** A custom property declared by a shape script. */
declare interface DeclaredProperty {
  key: string;
  label: string;
  type: "text" | "color" | "number" | "boolean";
  defaultValue?: string;
}

/** Rendering bounds passed to custom canvas renderers. */
declare interface ShapeRenderBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Context for Shape control instances. */
/** Context for Button instances — the canonical "click a button, run your
 *  code" surface (the #1 VBA entry point). Unlocked scripts can touch the grid
 *  via `api`; all scripts can `notify`, `log`, and `expose` methods. */
declare interface ButtonContext extends BaseObjectContext {
  /** Unique instance ID (e.g., "control-0-5-10"). */
  readonly instanceId: string;
  /** Called when the button is clicked (run mode). */
  onClick(handler: (detail: { x: number; y: number }) => void): () => void;
}

/** Context for Table (ListObject) instances — the most-automated VBA object.
 *  The instanceId is the table's EntityId. Cell reads/writes resolve through
 *  the table's grid coordinates so they recalc and are undoable. */
declare interface TableContext extends BaseObjectContext {
  /** The table instance ID (the table's EntityId string). */
  readonly instanceId: string;
  /** The table name. */
  readonly name: string;
  /** Called when any cell inside the table's range changes. */
  onDataChange(handler: (detail: { changes: Array<{ row: number; col: number; newValue: string }> }) => void): () => void;
  /** Get the table's column header names (sync, seeded from the mount snapshot). */
  getHeaders(): string[];
  /** Get the number of data rows in the table (sync, seeded). */
  getRowCount(): number;
  /** Read a table cell by 0-based data row + 0-based column index (async).
   *
   * Calcula policy (generated): Read its own object's properties / selection / spec.
   * Reach: broker `object.getState`, aspect `table.getCellValue`, restricted tier, class read.
   */
  getCellValue(row: number, colIndex: number): Promise<string>;
  /** Write a table cell by 0-based data row + 0-based column index (async, undoable).
   *
   * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
   * Reach: broker `object.setState`, aspect `table.setCellValue`, restricted tier, class mutate.
   */
  setCellValue(row: number, colIndex: number, value: string): Promise<void>;
  /** Append a new data row to the table (async, undoable).
   *
   * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
   * Reach: broker `object.setState`, aspect `table.addRow`, restricted tier, class mutate.
   */
  addRow(): Promise<void>;
  /**
   * A canonical-model Range over the table's data body, in TABLE-RELATIVE
   * coordinates (row 0 = first data row, col 0 = first table column). The same
   * ScriptRange the sheet context exposes: `table.range("A1:C5").getValues()`.
   */
  range(address: string): ScriptRange;
  /** A single table cell (0-based data row + column index) as a ScriptRange. */
  cell(row: number, colIndex: number): ScriptRange;
  /** Table properties (read-only). */
  readonly properties: {
    readonly name: string;
    readonly sheetIndex: number;
    readonly rowCount: number;
  };
}

/** Context for Named Range instances — the Excel `Name` object. The instanceId
 *  is the name string. Reads are seeded/refreshed from the resolved range;
 *  writes resolve to grid coordinates (recalc + undoable). */
declare interface NamedRangeContext extends BaseObjectContext {
  /** The named range instance ID (the name string). */
  readonly instanceId: string;
  /** The name. */
  readonly name: string;
  /** Called when any cell inside the resolved range changes. */
  onChange(handler: (detail: { changes: Array<{ row: number; col: number; newValue: string }> }) => void): () => void;
  /** Get the resolved A1 address (e.g., "Sheet1!A1:B10"). Sync, seeded. */
  getAddress(): string;
  /** Get the range's values as a 2D array of display strings. Sync, seeded. */
  getValues(): string[][];
  /** Write a 2D array of values into the range (async, undoable).
   *
   * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
   * Reach: broker `object.setState`, aspect `namedRange.setValues`, restricted tier, class mutate.
   */
  setValues(values: string[][]): Promise<void>;
  /** Named range properties (read-only). */
  readonly properties: {
    readonly refersTo: string;
    readonly scope: string;
  };
}

declare interface ShapeContext extends BaseObjectContext {
  /** Unique instance ID (e.g., "control-0-195-2"). */
  readonly instanceId: string;
  /** Shape type identifier (e.g., "rectangle", "snipSingleCorner"). */
  readonly shapeType: string;

  /** Called when the shape is clicked. */
  onClick(handler: (detail: { x: number; y: number }) => void): () => void;
  /** Called when the shape is resized. */
  onResize(handler: (detail: { width: number; height: number }) => void): () => void;
  /** Called when a property value changes. */
  onPropertyChange(handler: (detail: { key: string; oldValue: string; newValue: string }) => void): () => void;

  /** Get the current resolved value of a shape property. */
  getProperty(key: string): string;
  /** Set a shape property value.
   *
   * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
   * Reach: broker `object.setState`, aspect `shape.setProperty`, restricted tier, class mutate.
   */
  setProperty(key: string, value: string): Promise<void>;

  /** Read a cell value by reference (e.g., "A1", "B5"). Returns the display value.
   *
   * Calcula policy (generated): Read its own object's properties / selection / spec.
   * Reach: broker `object.getState`, aspect `shape.cellValue`, restricted tier, class read.
   */
  getCellValue(cellRef: string): Promise<string>;
  /** Called when any cell value changes. Use to re-render when source data updates. */
  onCellChange(handler: (detail: { changes: Array<{ row: number; col: number; newValue: string }> }) => void): () => void;

  /**
   * Declare custom properties that appear in the shape's Properties pane, so a
   * user can configure your script without editing it. Sits on the context
   * itself (NOT under `render`) — declaring a property is a change to the
   * object's model, not to how it is painted.
   *
   * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
   * Reach: broker `object.setState`, aspect `shape.declareProperties`, restricted tier, class mutate.
   */
  declareProperties(props: DeclaredProperty[]): void;

  /** Rendering methods. */
  render: {
    /** Replace canvas rendering with an interactive HTML iframe overlay.
     *
     * Calcula policy (generated): Render sandboxed HTML inside its shape.
     * Reach: broker `render.setHtml`, restricted tier, class mutate, requires the `ui.html` capability.
     */
    setHtmlContent(html: string): void;
    /** Send a message to the shape's HTML iframe. Inside the iframe, listen via `window.addEventListener('shape-message', (e) => { e.detail.type, e.detail.data })`.
     *
     * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
     * Reach: broker `object.setState`, aspect `shape.sendMessage`, restricted tier, class mutate.
     */
    sendMessage(type: string, data?: unknown): void;
    /** Listen for messages sent from the shape's HTML iframe via `calcula.sendMessage(type, data)`. */
    onMessage(handler: (detail: { type: string; data: unknown }) => void): () => void;
    /** Provide a custom canvas render function (replaces default shape path rendering). */
    canvasRenderer(renderer: (ctx: CanvasRenderingContext2D, bounds: ShapeRenderBounds) => void): () => void;
    /** Discard this shape's cached painting and repaint it. Needed when your
     *  renderer reads state Calcula cannot observe.
     *
     * Calcula policy (generated): Request a re-render of its own visuals.
     * Reach: broker `render.invalidate`, restricted tier, class emit.
     */
    invalidate(): void;
  };
}

// ============================================================================
// Range Context (cell-behavior bindings / granular bricks)
// ============================================================================

/** The commit a range `onBeforeCommit` handler is asked to rule on. */
declare interface RangeCommitContext {
  row: number;
  col: number;
  sheetIndex: number;
  /** What the cell holds now. */
  oldValue?: string;
  /** What the user just typed. */
  newValue: string;
}

/**
 * Context for a RANGE binding — a script attached to a block of cells rather
 * than to a floating object (granular bricks). This is the surface behind a
 * custom cell type: the binding sees clicks and edits on its own cells, and
 * every write it makes is clamped to them.
 */
declare interface RangeContext extends BaseObjectContext {
  /** The binding instance ID. */
  readonly instanceId: string;
  /** Called when a cell in the bound range is clicked. */
  onClick(handler: (detail: { row: number; col: number }) => void): () => void;
  /** Called when a cell in the bound range is double-clicked. */
  onDoubleClick(handler: (detail: { row: number; col: number }) => void): () => void;
  /** Called after a cell in the bound range changes. */
  onChange(handler: (detail: { changes: Array<{ row: number; col: number; newValue: string }> }) => void): () => void;
  /**
   * Called BEFORE a cell in the bound range commits — and it can stop or
   * rewrite the edit. Return nothing to accept it, `false` / `"cancel"` /
   * `{ cancel: true, reason }` to reject it, or `{ value }` to substitute a
   * different value.
   *
   * Calcula awaits your verdict under a hard deadline; a late answer is ignored
   * and the edit proceeds, so a hung handler can never make cells uneditable.
   *
   * ```js
   * range.onBeforeCommit(({ newValue }) => {
   *   if (Number(newValue) < 0) return { cancel: true, reason: "Must be positive" };
   * });
   * ```
   */
  onBeforeCommit(
    handler: (detail: RangeCommitContext) =>
      | void
      | false
      | "cancel"
      | { cancel: true; reason?: string }
      | { value: string }
      | Promise<void | false | "cancel" | { cancel: true; reason?: string } | { value: string }>,
  ): () => void;
  /** The bound range's A1 address ("Sheet1!A1:B10"). Sync, seeded at mount. */
  getAddress(): string;
  /** The bound range's values as display strings. Sync, seeded at mount. */
  getValues(): string[][];
  /** Write a 2D array into the bound range (clamped to it; one undo step).
   *
   * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
   * Reach: broker `object.setState`, aspect `range.setValues`, restricted tier, class mutate.
   */
  setValues(values: string[][]): Promise<void>;
  /**
   * Apply a registered CELL TYPE to the bound range — the declarative half of
   * granular bricks (a rating widget, a status pill, a progress bar). `typeId`
   * names a cell type some extension registered; `params` configures it.
   *
   * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
   * Reach: broker `object.setState`, aspect `range.setCellType`, restricted tier, class mutate.
   */
  setCellType(typeId: string, params?: Record<string, unknown>): Promise<void>;
  /** Remove the cell type from the bound range, restoring plain cells.
   *
   * Calcula policy (generated): Change its own object (slicer selection, shape properties, chart spec, panel badge, ...).
   * Reach: broker `object.setState`, aspect `range.clearCellType`, restricted tier, class mutate.
   */
  clearCellType(): Promise<void>;
}

// ============================================================================
// Chart Mark Context (custom chart marks)
// ============================================================================

/** The plot rectangle and scales handed to a custom mark renderer. */
declare interface ChartMarkRenderContext {
  /** The offscreen canvas context to paint into. */
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  /** The resolved data rows for the mark's series. */
  data: ReadonlyArray<Record<string, unknown>>;
  /** The chart's ChartSpec, as resolved. */
  spec: Record<string, unknown>;
}

/**
 * Context for a CUSTOM CHART MARK — a script that paints a chart's plot area
 * itself when the built-in marks (bar, line, area, ...) cannot express what you
 * need.
 *
 * It is paint-only, and needs NO capability: your renderer runs in the worker
 * against an OffscreenCanvas, and Calcula blits the bitmap into the chart's
 * clipped plot rectangle. The mark never touches the real canvas or the DOM,
 * so a slow or broken renderer costs you a frame, never the app.
 */
declare interface ChartMarkContext extends BaseObjectContext {
  /** The chart instance this mark paints into. */
  readonly instanceId: string;
  render: {
    /**
     * Paint the plot area. Called on every frame the chart needs.
     *
     * ```js
     * chartMark.render.markRenderer(({ ctx, width, height, data }) => {
     *   ctx.fillStyle = "#4FC1FF";
     *   data.forEach((row, i) => ctx.fillRect(i * 10, height - row.value, 8, row.value));
     * });
     * ```
     */
    markRenderer(renderer: (context: ChartMarkRenderContext) => void): () => void;
    /** Request a repaint (your renderer reads state Calcula cannot observe).
     *
     * Calcula policy (generated): Request a re-render of its own visuals.
     * Reach: broker `render.invalidate`, restricted tier, class emit.
     */
    invalidate(): void;
  };
}

// ============================================================================
// The objectType -> context map (generated)
// ============================================================================

/**
 * Every objectType a script can be attached to, mapped to the context
 * interface `setup(context)` receives for it (generated from
 * contextShims.ts).
 *
 * The editor narrows this to the script you have open and publishes the
 * result as `ObjectScriptContext`. Annotate your setup function with
 * `@param {ObjectScriptContext} context` in a JSDoc block and the whole
 * surface below becomes typed: completions, parameter hints, and the
 * generated broker-policy text on hover.
 */
declare interface ObjectScriptContextByType {
  workbook: WorkbookContext;
  sheet: SheetContext;
  cell: CellContext;
  row: RowContext;
  column: ColumnContext;
  slicer: SlicerContext;
  chart: ChartContext;
  pivot: PivotContext;
  shape: ShapeContext;
  panel: PanelContext;
  button: ButtonContext;
  table: TableContext;
  namedRange: NamedRangeContext;
  range: RangeContext;
  timeline: TimelineContext;
  chartMark: ChartMarkContext;
  textbox: BaseObjectContext;
}
