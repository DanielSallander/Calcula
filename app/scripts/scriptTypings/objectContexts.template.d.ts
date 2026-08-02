// PROSE TEMPLATE for the Object Script context typings.
//
// THIS is the file you edit. `npm run gen:script-typings` reads it, verifies
// every declaration below against the LIVE worker context shim
// (app/src/api/scriptHost/worker/contextShims.ts) by building a real context for
// every objectType and both tiers, splices each method's broker policy in from
// app/src/api/scriptHost/allowlist.ts, and writes
// app/extensions/ScriptableObjects/objectContexts.d.ts — the single extraLib
// Monaco loads for object scripts.
//
// The generator REFUSES to emit if a member exists on the shim and not here
// (an author could never discover it) or here and not on the shim (IntelliSense
// would advertise a method that always fails). Signatures, parameter names and
// every word of prose are yours; membership is not negotiable.
//
// The file has a .d.ts extension so editors type-check it as declarations, and
// lives outside `extensions/` + `src/` so tsc does not load it as a second set
// of ambient globals alongside the generated output.

// @generated:template-header-end

// ============================================================================
// Object types and capabilities (generated rosters)
// ============================================================================

// @generated:object-type-table

// @generated:capability-table

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

/**
 * The answer to `api.evaluate(...)` — the same value/display/type triple a
 * {@link ScriptCell} carries, minus the coordinates and the formula (an
 * expression that was never stored anywhere has neither).
 */
declare interface ScriptEvaluatedValue {
  /** number | string | boolean | null. An error carries its Excel literal
   *  ("#DIV/0!", "#NAME?", "#SYNTAX!"); an array or list result carries its
   *  rendered text. */
  value: string | number | boolean | null;
  /** The formatted text this answer would show in a cell. */
  display: string;
  type: "number" | "text" | "boolean" | "empty" | "error";
}

/** Options for `getCellFormula` / `setCellFormula`. */
declare interface ScriptFormulaOptions {
  /**
   * The notation YOU are reading or writing. `"A1"` (the default) is ordinary
   * `=A1+B1`; `"R1C1"` is relative-offset notation resolved against the target
   * cell, so `"=RC[-1]*2"` means "twice the cell to my left" wherever you put
   * it. This is your claim about your own string — it is never taken from the
   * user's View ▸ R1C1 setting.
   */
  style?: "A1" | "R1C1";
  /** The sheet to act on. Defaults to the active sheet. */
  sheetIndex?: number;
}

/** The size of a block that was copied or pasted. */
declare interface ScriptClipboardSize {
  rows: number;
  cols: number;
}

/** Options for `paste` / `pasteSpecial`. */
declare interface ScriptPasteOptions {
  /**
   * What travels. `"all"` (the default) carries values, formulas AND
   * formatting; `"values"` carries only the computed values; `"formulas"`
   * carries values and formulas but no formatting.
   */
  mode?: "all" | "values" | "formulas";
  /** Turn rows into columns. Relative references are shifted per cell, so each
   *  formula lands correctly rather than sharing one block-wide offset. */
  transpose?: boolean;
  /** Leave the destination untouched wherever the source cell was empty. */
  skipBlanks?: boolean;
  /** Must be the active sheet (or omitted) — paste carries formatting, and the
   *  only write that can carry it has no sheet parameter. */
  sheetIndex?: number;
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
  /** Show a message and wait until the user closes it. */
  alert(message: string, options?: ScriptDialogTextOptions): Promise<void>;
  /** Ask a yes/no question. Cancel, Escape and closing all resolve `false`. */
  confirm(message: string, options?: ScriptDialogTextOptions): Promise<boolean>;
  /** Ask for one value. Resolves `null` if the user cancels. */
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
   */
  form(spec: ScriptDialogFormSpec): Promise<Record<string, unknown> | null>;
}

// ============================================================================
// caps.file — files the USER picks (the `file.picker` capability).
// Declare it with `// @capability file.picker`.
// ============================================================================

/** Options for `caps.file.exportText`. Nothing here names a location. */
declare interface ScriptFileExportOptions {
  /** Labels the picker's file-type row, e.g. "text/csv". */
  mimeType?: string;
  /**
   * How the text is encoded once the user has chosen a file.
   * Use `"utf-8-bom"` for CSV that Excel must open with correct accents.
   */
  encoding?: "utf-8" | "utf-8-bom" | "ansi";
  /** Your own label for the file-type row ("Quarterly report"). */
  description?: string;
}

/** Options for `caps.file.importText`. */
declare interface ScriptFileImportOptions {
  /**
   * Extensions the picker offers, without dots (`["csv", "txt"]`). This filters
   * what the dialog SHOWS; the user can still choose anything.
   */
  extensions?: string[];
  /** Your own label for the file-type row. */
  description?: string;
}

/** A file the user picked, handed to you as text. */
declare interface ScriptImportedFile {
  /** The file's NAME, exactly as the user saw it. Never the folder. */
  name: string;
  /** Its contents. */
  content: string;
}

/**
 * Read and write files the USER picks, one at a time.
 *
 * This is the sanctioned replacement for VBA's `FileSystemObject`, and it is
 * built the opposite way round. Your script never supplies a path, never
 * receives one, and cannot remember one: it hands over a FILE NAME and some
 * CONTENT, Calcula opens the ordinary Windows dialog, and the person at the
 * keyboard decides which file is involved. There is no fixed target to aim at,
 * nothing to enumerate, and no way to touch a file the user did not just select
 * by hand.
 *
 * Both directions are capped at about 8 MB of text. An oversized import is
 * REFUSED rather than truncated — a half-read CSV is corrupt data that looks
 * like good data.
 *
 * Cancelling is never an error: both methods resolve `null`.
 */
declare interface ScriptFileApi {
  /**
   * Save text to a file the user picks. Resolves to the chosen file NAME, or
   * `null` if they cancelled.
   *
   * `suggestedName` pre-fills the dialog's name box and must be a bare file
   * name — a value containing `\`, `/`, `:` or `..` is rejected outright, so a
   * script cannot aim the picker at somewhere the user was not looking.
   *
   * ```js
   * const rows = await context.api.getRangeValues(0, 0, 99, 3);
   * const csv = rows.map((r) => r.map((c) => c.value).join(",")).join("\n");
   * const name = await context.caps.file.exportText("summary.csv", csv, {
   *   mimeType: "text/csv",
   *   encoding: "utf-8-bom",
   * });
   * if (!name) return; // the user cancelled
   * context.notify(`Saved ${name}`);
   * ```
   */
  exportText(
    suggestedName: string,
    content: string,
    options?: ScriptFileExportOptions,
  ): Promise<string | null>;
  /**
   * Read a text file the user picks. Resolves to `{ name, content }`, or `null`
   * if they cancelled.
   *
   * ```js
   * const file = await context.caps.file.importText({ extensions: ["csv"] });
   * if (!file) return;
   * const rows = file.content.split(/\r?\n/).map((line) => line.split(","));
   * context.log(`${file.name}: ${rows.length} rows`);
   * ```
   */
  importText(options?: ScriptFileImportOptions): Promise<ScriptImportedFile | null>;
  /**
   * Save the sheet you would PRINT as a PDF, to a file the user picks. Resolves
   * to the chosen file NAME, or `null` if they cancelled.
   *
   * You supply a name and nothing else — no bytes, no page setup, no range.
   * Calcula renders the document from the workbook's own print settings (print
   * area, print titles, page breaks, headers and footers), which is the same
   * path File ▸ Export to PDF takes, so a script's PDF and a person's PDF can
   * never disagree.
   *
   * ```js
   * const name = await context.caps.file.exportPdf("March report.pdf");
   * if (name) context.notify(`Saved ${name}`);
   * ```
   *
   * There is no way to send a document to a PRINTER. The only implementation
   * needs a pop-up window and the operating system's print dialog, can be
   * silently blocked, and reports nothing back — a call that may quietly do
   * nothing is worse than a missing one.
   */
  exportPdf(suggestedName?: string): Promise<string | null>;
}

// ============================================================================
// caps.shortcut — one keyboard shortcut (the `ui.shortcut` capability).
// Declare it with `// @capability ui.shortcut`.
// ============================================================================
//
// This is the Application.OnKey replacement, and it is deliberately narrower
// than OnKey was:
//   - the combination must be Ctrl+Shift+<letter>. Everything else belongs to
//     the grid and to Calcula — typing, Escape, Tab, Enter, the arrows, Home/
//     End/PageUp/PageDown, Delete, F1-F12, and the Ctrl+<key> shortcuts
//     (Ctrl+S, Ctrl+Z, Ctrl+C/V, Ctrl+B/I/U, ...);
//   - a combination anything else already holds is REFUSED. Nothing is ever
//     silently overridden, and Calcula's own shortcuts always win;
//   - at most 8 shortcuts per script;
//   - your handler is called with `{ combo }` and nothing else. There is no way
//     to observe the keyboard — only to be told that your own shortcut fired;
//   - the binding disappears when the script unmounts, and the user can see and
//     remove it in the meantime.

/** Options for `caps.shortcut.bind`. */
declare interface ScriptShortcutOptions {
  /** What the user's shortcut list should call it ("Refresh all figures"). */
  label?: string;
}

/** One shortcut this script currently holds. */
declare interface ScriptShortcutBinding {
  /** Stable id for this binding. */
  id: string;
  /** The canonical combination ("Ctrl+Shift+R"). */
  combo: string;
  /** Your script's id. */
  scriptId: string;
  /** Your script's name, as the shortcut list shows it. */
  scriptName: string;
  /** The exposed method the keys call. */
  handler: string;
  /** The label shown in the shortcut list. */
  label: string;
}

/** What a bound shortcut hands your handler — the combination, and nothing
 *  else. Not the key, not the event, not what else was typed. */
declare interface ScriptShortcutEvent {
  combo: string;
}

declare interface ScriptShortcutApi {
  /**
   * Bind `combo` to `handlerName` — a method you already published with
   * `context.expose(...)`. The handler is called with a `{ combo }` object.
   *
   * REJECTS (it never fails quietly) when the combination is not
   * Ctrl+Shift+<letter>, when Calcula reserves it, when anything else already
   * uses it, or when you already hold 8 shortcuts. The rejection message says
   * which.
   *
   * ```js
   * context.expose("refreshAll", (e) => {
   *   context.log(`${e.combo} pressed`);
   * });
   * try {
   *   await context.caps.shortcut.bind("Ctrl+Shift+R", "refreshAll");
   * } catch (err) {
   *   context.notify(String(err), "warning");
   * }
   * ```
   */
  bind(
    combo: string,
    handlerName: string,
    options?: ScriptShortcutOptions,
  ): Promise<ScriptShortcutBinding>;
  /** Give one shortcut back. Resolves `false` if you were not holding it. */
  unbind(combo: string): Promise<boolean>;
  /** The shortcuts this script currently holds. */
  list(): Promise<ScriptShortcutBinding[]>;
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
   */
  at(
    timeOfDay: string,
    handlerName: string,
    options?: { label?: string },
  ): Promise<ScheduledJob>;
  /** Your script's own scheduled jobs in this workbook. */
  list(): Promise<ScheduledJob[]>;
  /** Cancel one of your own jobs. Resolves true if a job was removed. */
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
  /** The input areas this workbook is asked to fill in. */
  listRegions(): Promise<WritebackRegion[]>;
  /** Your answers so far, with the state of each. */
  getLayer(): Promise<WritebackLayerView>;
  /**
   * Fill in one cell. Validated against the publisher's schema and lifecycle
   * rules; rejected values throw with the real reason. A region whose policy is
   * `immediate` sends the value as soon as it is drafted.
   */
  saveDraft(
    regionId: string,
    sheetId: string,
    row: number,
    col: number,
    value: WritebackValue,
  ): Promise<unknown>;
  /** Send every unsent answer for one area. Returns how many went. */
  submitRegion(regionId: string): Promise<number>;
  /** See exactly what `submitRegion` would send, before sending it. */
  previewSubmission(regionId: string): Promise<WritebackSubmissionPreview>;
  /** PUBLISHER ONLY: every respondent's answers for an area you publish. */
  listSubmissions(target: WritebackTarget): Promise<WritebackSubmissionRow[]>;
  /** PUBLISHER ONLY: approve, reject, or reopen somebody's answer. */
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
  /** Sanitized snapshot: tables, measures, relationships, writeback columns. */
  info(connectionId: string): Promise<unknown>;
  /** Create or replace one definition. `kind` is "measure" | "calcColumn" |
   *  "relationship" | "hierarchy" | "kpi" | "calcGroup" | "perspective" |
   *  "culture" | "scriptFunction" | "calculatedTable" | "tableVariable" |
   *  "context" | "contextColumn" | "writebackColumn" | "metadata" |
   *  "dateTable" | "extensionData". */
  upsert(connectionId: string, kind: string, payload: Record<string, unknown>): Promise<unknown>;
  /** Delete one definition (same `kind` vocabulary as `upsert`). */
  delete(connectionId: string, kind: string, payload: Record<string, unknown>): Promise<unknown>;
  /** Check a measure formula WITHOUT saving it. */
  validateMeasure(connectionId: string, name: string, formula: string, originalName?: string): Promise<unknown>;
  /** Check a context expression WITHOUT saving it. */
  validateContext(connectionId: string, name: string, expression: string, originalName?: string): Promise<unknown>;
  /** Every outstanding issue in the whole model. */
  validateModel(connectionId: string): Promise<unknown>;
  /** The model's dependency graph (nodes + edges). */
  dependencyGraph(connectionId: string): Promise<unknown>;
  /** What one measure is built from, all the way down. */
  measureLineage(connectionId: string, name: string): Promise<unknown>;
  /**
   * What would BREAK if you deleted this object — the impact check to run
   * before a delete. `kind` is "measure" | "calcColumn" | "contextColumn" |
   * "calculatedTable" | "table"; `table` is required for the two column kinds.
   * Security roles that depend on it are reported as a COUNT
   * (`privilegedDependents`), never by name.
   */
  dependents(connectionId: string, kind: string, name: string, table?: string): Promise<unknown>;
  /**
   * Start an atomic run: every edit until `batchEnd` lands as ONE undo entry.
   * Only this script may end or cancel it, and an abandoned batch is rolled
   * back (never committed) after ~30 seconds. Batching buys atomicity, not
   * budget — each edit inside still costs a rate-limit token.
   */
  batchBegin(connectionId: string): Promise<unknown>;
  /** Commit the open batch as one undo entry. */
  batchEnd(connectionId: string): Promise<unknown>;
  /** Roll the open batch back as if none of it had happened. */
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
  /** Read a key. Resolves `null` when it has never been set. */
  get(key: string): Promise<string | null>;
  /** Write a key. The whole store is capped at 256 KB per script. */
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
   */
  value(connection: string, ...members: string[]): Promise<number | null>;
  /** Resolve a KPI's value/goal/status. `property` is 1 = value, 2 = goal,
   *  3 = status, 4 = trend. */
  kpi(connection: string, kpi: string, property: number): Promise<number | null>;
  /** List the distinct members of a level (a model column). */
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
  /** Declare (or redeclare) this script's connector and its tables. */
  register(connectionId: string, definition: Record<string, unknown>): Promise<unknown>;
  /** Remove your own connector, and the model tables it feeds. */
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
   */
  biQuery(connectionId: string, request: ScriptBiQueryRequest): Promise<ScriptBiQueryResult>;
  /**
   * Run RAW SQL against a connection's underlying database.
   *
   * This is a STRICTLY larger reach than `biQuery` and has its own capability
   * (`bi.sql`) for that reason: the model's scoping does not apply, so any
   * table the connection can see is reachable. Statements are read-only.
   */
  biSql(connectionId: string, sql: string): Promise<ScriptBiQueryResult>;
  /** The BI connections in this workbook (id and name only). */
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
  /**
   * Save a file, or read one — always the file the USER picks, never one your
   * script names. Requires the `file.picker` capability
   * (`// @capability file.picker`).
   *
   * ```js
   * await context.caps.file.exportText("report.csv", csv, { mimeType: "text/csv" });
   * const cfg = await context.caps.file.importText({ extensions: ["json"] });
   * ```
   */
  file: ScriptFileApi;
  /**
   * Bind ONE keyboard shortcut to a method you exposed — Calcula's replacement
   * for VBA's `Application.OnKey`. Requires the `ui.shortcut` capability
   * (`// @capability ui.shortcut`).
   *
   * ```js
   * context.expose("refreshAll", () => context.log("refreshed"));
   * await context.caps.shortcut.bind("Ctrl+Shift+R", "refreshAll", {
   *   label: "Refresh all figures",
   * });
   * ```
   */
  shortcut: ScriptShortcutApi;
  /**
   * Bring somebody else's published .calp packages into this workbook, and keep
   * the ones you subscribe to up to date. Requires the
   * `distribution.subscribe` capability (`// @capability distribution.subscribe`).
   *
   * Three things are worth knowing before you design around this:
   *
   *  - **You can only use registries the user already added.** Naming a path or
   *    URL they have not saved is refused, by name, in the backend. Start from
   *    `listRegistries()`; do not hard-code a location.
   *  - **You cannot switch pulled code on.** A package's object scripts arrive
   *    restricted and NOT running; the user answers the consent prompt. That is
   *    true of `refreshApply()` too — a package script whose source CHANGED is
   *    switched off again until the user re-approves it, so a script can never
   *    update itself into running new code.
   *  - **A script that arrived in a package cannot call any of this.** These
   *    methods are unlocked-tier and distributed scripts are forced restricted,
   *    which is what stops a package from pulling further packages.
   *
   * ```js
   * const [reg] = await context.caps.packages.listRegistries();
   * const info = await context.caps.packages.inspect(reg.location, "vendor-kpis", "latest");
   * context.log(`${info.packageName} carries ${info.scripts.length} scripts`);
   * await context.caps.packages.pull(reg.location, "vendor-kpis", "^2.0.0");
   * ```
   */
  packages: ScriptPackagesApi;
  /**
   * Publish this workbook to one of your package registries. Requires the
   * `distribution.publish` capability (`// @capability distribution.publish`) —
   * deliberately a DIFFERENT permission from `caps.packages`, because
   * publishing puts YOUR name on content other people will run.
   *
   * Holding the capability is not enough. This machine must already have a
   * publisher identity (Calcula will not let a script create the Ed25519 key
   * other people pin as "you"), and if the package name already exists in that
   * registry you must hold ITS key. `publishedBy` is not yours to set: the
   * byline comes from the identity that signs.
   *
   * ```js
   * const next = await context.caps.publish.nextVersion(reg, "sales-report", "minor");
   * const dry  = await context.caps.publish.preview();
   * context.log(`would ship ${dry.sheetNames.length} sheets`);
   * await context.caps.publish.package({
   *   registry: reg, packageName: "sales-report", version: next,
   * });
   * ```
   */
  publish: ScriptPublishApi;
}

// ============================================================================
// caps.packages / caps.publish — the .calp package loop, split by DIRECTION.
// Inbound needs `distribution.subscribe`; outbound needs `distribution.publish`.
// ============================================================================

/** One registry the user has set up on this machine. */
declare interface ScriptRegistry {
  id: string;
  name: string;
  /** Pass this to the other methods. A location you did not get from here will
   *  be refused. */
  location: string;
}

/** One package version listed in a registry. */
declare interface ScriptRegistryVersion {
  version: string;
  publishedAt: string;
  publishedBy: string;
}

/** One package listed in a registry. */
declare interface ScriptRegistryPackage {
  name: string;
  description: string;
  /** "report" | "template" | "dataset" | "library" | a publisher's own kind. */
  kind: string;
  author: string;
  versions: ScriptRegistryVersion[];
}

/** One package this workbook subscribes to. */
declare interface ScriptSubscription {
  packageName: string;
  registryUrl: string;
  versionPin: string;
  resolvedVersion: string;
  resolvedAt: string;
}

declare interface ScriptSubscriptionList {
  formatVersion: number;
  subscriptions: ScriptSubscription[];
}

/** One script a package carries, as seen BEFORE taking it. */
declare interface ScriptPackagedScript {
  name: string;
  objectType: string;
  description: string | null;
  /** What the publisher's signed manifest says this script may use. */
  requestedCapabilities: string[];
}

/** What `inspect()` reports — enough to decide, nothing materialized. */
declare interface ScriptPackageInspection {
  packageName: string;
  resolvedVersion: string;
  /** Display name of the VERIFIED signer. */
  publisherName: string;
  /** The signer's Ed25519 public key (hex) — the only comparable identity. */
  publisherKey: string;
  /**
   * A publisher pin belongs to the REGISTRY it came from, not to the package
   * name alone, so every status below is about this registry.
   *
   * "verified"  — signed by the key this machine pinned when the USER
   *               subscribed to this package from this registry.
   * "notPinned" — the signature is valid, but nobody on this computer has ever
   *               agreed to trust that signer for this package name from this
   *               registry. This is what `inspect()` normally returns:
   *               inspecting is PASSIVE and deliberately does not create trust,
   *               so a script cannot make a package trusted merely by asking
   *               about it.
   * "notPinnedNameConflict"
   *             — as above, AND a DIFFERENT publisher key is already trusted
   *               for this same package name from another registry. Two
   *               registries claiming one name is what a package hijack looks
   *               like. Treat it as worse than "notPinned", never as first
   *               contact.
   * "firstUse", "firstUseKnownPublisher", "firstUseAcceptedNameConflict"
   *             — unreachable from `inspect()`; only a commit point (a pull the
   *               user performed) can pin.
   *
   * AUTHENTIC IS NOT TRUSTED: anyone can generate a key and sign a package, so
   * a valid signature proves only that the bytes are unaltered. Do not treat
   * "notPinned" — or, especially, "notPinnedNameConflict" — as success.
   */
  trustStatus: string;
  sheets: Array<{ name: string; description: string }>;
  scripts: ScriptPackagedScript[];
  tableNames: string[];
  namedRangeNames: string[];
  writebackRegionCount: number;
  chartCount: number;
  pivotCount: number;
}

/** What a pull materialized. */
declare interface ScriptPullResult {
  packageName: string;
  resolvedVersion: string;
  sheetsPulled: number;
  tablesPulled: number;
  /** Object scripts materialized — RESTRICTED and NOT RUNNING until the user
   *  approves them. */
  scriptsPulled: number;
  publisherName: string;
  /** One of the pinning states: "verified" (matched the pin this registry
   *  already held), "firstUse" (the pin was created by this pull),
   *  "firstUseKnownPublisher" (created for this registry, same key already
   *  trusted elsewhere) or "firstUseAcceptedNameConflict" (created despite a
   *  different key holding this name at another registry). A pull is a commit
   *  point, so neither "notPinned" state can occur here — see
   *  ScriptPackageInspection.trustStatus for the full vocabulary. */
  trustStatus: string;
}

/** What one subscription would change on refresh. */
declare interface ScriptSubscriptionPreview {
  packageName: string;
  currentVersion: string;
  newVersion: string;
  cellsChanged: number;
  overridesConflicted: number;
  overridesAutoCleared: number;
}

declare interface ScriptRefreshPreview {
  subscriptionPreviews: ScriptSubscriptionPreview[];
  totalCellsChanged: number;
  totalSheetsAdded: number;
  totalSheetsRemoved: number;
  totalOverridesConflicted: number;
  totalOverridesAutoCleared: number;
}

declare interface ScriptRefreshResult {
  subscriptionsRefreshed: number;
  sheetsAdded: number;
  sheetsRemoved: number;
  sheetsUpdated: number;
  conflictsCreated: number;
  overridesAutoCleared: number;
}

/**
 * INBOUND .calp distribution (`distribution.subscribe`).
 *
 * Everything here is verified exactly as an interactive subscribe is: the
 * publisher's Ed25519 signature over the version manifest, the trust-on-first-
 * use pin, a SHA-256 check of every artifact against the signed checksum map,
 * and the package's declared minimum app version. There is no "script path"
 * that skips a check — these call the same backend functions the Subscribe and
 * Refresh dialogs call.
 */
declare interface ScriptPackagesApi {
  /** The registries set up on this machine — the only locations the rest of
   *  this API will accept. */
  listRegistries(): Promise<ScriptRegistry[]>;
  /** What this workbook currently subscribes to. */
  listSubscriptions(): Promise<ScriptSubscriptionList>;
  /** The packages available in one of your registries. */
  browse(registry: string): Promise<ScriptRegistryPackage[]>;
  /** Look inside a package version — including every script it carries and the
   *  capabilities each declares — WITHOUT bringing anything in. */
  inspect(
    registry: string,
    packageName: string,
    versionPin: string,
  ): Promise<ScriptPackageInspection>;
  /**
   * Subscribe to a package and materialize it into this workbook.
   *
   * `versionPin` is a semver pin: an exact version ("1.2.0"), a range
   * ("^1.0.0", "~1.2.0") or "latest".
   */
  pull(
    registry: string,
    packageName: string,
    versionPin: string,
  ): Promise<ScriptPullResult>;
  /** What updating every subscription would change — without changing it. */
  refreshPreview(): Promise<ScriptRefreshPreview>;
  /** Update every subscription to its publisher's newest matching version. */
  refreshApply(): Promise<ScriptRefreshResult>;
}

/** What `caps.publish.package` takes.
 *
 *  `publishedBy`, `customObjects` and `includeComments` are deliberately NOT
 *  members: the byline comes from the key that signs, package payloads are
 *  Calcula's to collect, and shipping threaded comments to a registry is a
 *  privacy decision only a person makes. Passing one is an error, not a
 *  silently ignored field. */
declare interface ScriptPublishSpec {
  /** One of the locations `caps.packages.listRegistries()` returned. */
  registry: string;
  packageName: string;
  /** Semver — `nextVersion()` will suggest one. */
  version: string;
  /** "report" (default) | "template" | "dataset" | "library" | your own kind. */
  kind?: string;
  /** Sheets to ship. Omit for the kind's default: every sheet for a report, and
   *  NO sheets for a "library" (whose payload is its module scripts). */
  sheetIndices?: number[];
}

/** What `caps.publish.model` takes. Schema only — no data, no credentials. */
declare interface ScriptPublishModelSpec {
  registry: string;
  packageName: string;
  version: string;
  /** Which BI connection's model to publish. */
  connectionId: string;
}

/** One line of the publish transparency report. */
declare interface ScriptPublishReportItem {
  category: string;
  count: number;
  detail: string;
}

/** What a publish shipped, and what it could not carry. */
declare interface ScriptPublishResult {
  packageName: string;
  version: string;
  sheetsPublished: number;
  tablesPublished: number;
  namedRangesPublished: number;
  scriptsPublished: number;
  modulesPublished: number;
  notebooksPublished: number;
  report: {
    included: ScriptPublishReportItem[];
    excluded: ScriptPublishReportItem[];
  };
  /** Disclosure warnings — read them; they are how a publish says what it could
   *  not carry instead of dropping it silently. */
  warnings: string[];
}

/** What `preview()` reports. Sends nothing. */
declare interface ScriptPublishPreview {
  sheetNames: string[];
  report: {
    included: ScriptPublishReportItem[];
    excluded: ScriptPublishReportItem[];
  };
  warnings: string[];
}

/**
 * OUTBOUND .calp distribution (`distribution.publish`).
 *
 * A publish LEAVES THE MACHINE and cannot be taken back: everyone subscribed to
 * the package receives the new version. Calcula rate-limits this hard, records
 * every attempt in the workbook's audit trail with the package, the version and
 * the registry, and refuses outright unless this machine already holds the
 * publisher key — and, for a package that already exists, unless it holds THAT
 * package's key.
 */
declare interface ScriptPublishApi {
  /** What publishing would ship and what it would leave behind. Sends nothing.
   *  Omit `sheetIndices` to preview every sheet. */
  preview(sheetIndices?: number[]): Promise<ScriptPublishPreview>;
  /** The next version number for one of your packages. */
  nextVersion(
    registry: string,
    packageName: string,
    bump: "major" | "minor" | "patch",
  ): Promise<string>;
  /** Publish this workbook as a new version. Irreversible. */
  package(spec: ScriptPublishSpec): Promise<ScriptPublishResult>;
  /** Publish ONE BI model as a model-only package. */
  model(spec: ScriptPublishModelSpec): Promise<ScriptPublishResult>;
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
// Column filtering / AutoFilter (G4)
// ============================================================================

/** How ONE column of the filter is currently filtered. */
declare interface ScriptAutoFilterColumn {
  /** 0-based offset FROM THE FILTER'S FIRST COLUMN (not an absolute column):
   *  a filter over C1:F20 addresses column D as 1. */
  columnIndex: number;
  /** The kind of criteria in force: "values", "custom", "color", "icon",
   *  "dynamic", "top10", ... — passed through from the workbook verbatim. */
  filterOn: string;
  /** The values kept by a values filter (empty for the other kinds). */
  values: string[];
  criterion1: string | null;
  criterion2: string | null;
  operator: "and" | "or" | null;
  /** True when blank cells are excluded. */
  filterOutBlanks: boolean;
}

/** The column filter on the active sheet. */
declare interface ScriptAutoFilter {
  /** The filter's own id (a UUID string), stable while the filter exists. */
  id: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  enabled: boolean;
  /** True when at least one column is currently hiding rows. */
  isDataFiltered: boolean;
  /** One entry per column of the range, in range order; null = unfiltered. */
  columns: Array<ScriptAutoFilterColumn | null>;
  /** Absolute row indices the filter is hiding right now. */
  hiddenRows: number[];
}

/**
 * What you may ask of one column. Two shapes, matching the two things a person
 * can do in the filter dropdown:
 *
 * ```js
 * await api.filter.setColumn(1, { kind: "values", values: ["North", "South"] });
 * await api.filter.setColumn(2, { kind: "custom", criterion1: ">=100" });
 * ```
 */
declare type ScriptAutoFilterCriteria =
  | {
      kind: "values";
      /** The values to KEEP (max 10 000). */
      values: string[];
      /** Keep blank cells too. Default false. */
      includeBlanks?: boolean;
    }
  | {
      kind: "custom";
      /** An Excel-style rule: ">=100", "<>done", "=*text*". */
      criterion1: string;
      criterion2?: string;
      /** How the two rules combine. Default "and". */
      operator?: "and" | "or";
    };

/** Distinct values in one column, for building a values filter. */
declare interface ScriptAutoFilterValues {
  values: Array<{ value: string; count: number }>;
  hasBlanks: boolean;
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
  /** The chart's ChartSpec. Async — only your OWN object has a live mirror. */
  getSpec(): Promise<Record<string, unknown>>;
  /** Merge a partial patch into the spec (schema-validated; rejects if invalid). */
  updateSpec(patch: Record<string, unknown>): Promise<void>;
  /** Replace the whole spec (schema-validated; rejects if invalid). */
  replaceSpec(fullSpec: Record<string, unknown>): Promise<void>;
  setStyleProperty(name: string, value: string): Promise<void>;
  /** Delete this chart. */
  delete(): Promise<void>;
}

/** A handle on ANOTHER table (api.table(id)). Coordinates are TABLE-RELATIVE
 *  (row 0 = first data row, col 0 = first table column) and clamped to the
 *  table body, exactly as inside that table's own script. */
declare interface ScriptTableHandle {
  readonly id: string;
  getCellValue(row: number, colIndex: number): Promise<string>;
  setCellValue(row: number, colIndex: number, value: string): Promise<void>;
  addRow(): Promise<void>;
  range(address: string): ScriptRange;
  cell(row: number, colIndex: number): ScriptRange;
  /** Delete this table (the cells and their values are kept). */
  delete(): Promise<void>;
}

/** A handle on ANOTHER pivot table (api.pivot(id)). */
declare interface ScriptPivotHandle {
  readonly id: string;
  getFields(): Promise<{ rows: string[]; columns: string[]; values: string[]; filters: string[] }>;
  refresh(): Promise<void>;
  /** Place a source field in an area. `position` inserts at an index (default:
   *  append); `aggregation` applies when the area is "values". */
  addField(field: string, area: ScriptPivotArea, position?: number, aggregation?: ScriptAggregation): Promise<void>;
  /** Move an already-placed field to another area. */
  moveField(field: string, area: ScriptPivotArea, position?: number): Promise<void>;
  /** Remove a placed field. Omit `area` to remove it from wherever it sits. */
  removeField(field: string, area?: ScriptPivotArea): Promise<void>;
  /** Change how a VALUE field is summarized. */
  setAggregation(field: string, aggregation: ScriptAggregation): Promise<void>;
  /** Apply LAYOUT directives (applied left to right, later wins). */
  setLayout(directives: ScriptPivotLayoutDirective[]): Promise<void>;
  /** Delete this pivot table. */
  delete(): Promise<void>;
}

/** A handle on ANOTHER slicer (api.slicer(id)). */
declare interface ScriptSlicerHandle {
  readonly id: string;
  getSelectedItems(): Promise<string[]>;
  /** null selects ALL items; [] clears the selection. */
  setSelectedItems(items: string[] | null): Promise<void>;
  clearSelection(): Promise<void>;
  selectAll(): Promise<void>;
  setStyleProperty(name: string, value: string): Promise<void>;
}

/** A handle on ANOTHER form control / shape (api.shape(id)). */
declare interface ScriptShapeHandle {
  readonly id: string;
  setProperty(key: string, value: string): Promise<void>;
  getCellValue(cellRef: string): Promise<string>;
  sendMessage(type: string, data?: unknown): Promise<void>;
}

/** A handle on ANOTHER named range (api.namedRange(name)). */
declare interface ScriptNamedRangeHandle {
  readonly name: string;
  getValues(): Promise<string[][]>;
  setValues(values: string[][]): Promise<void>;
  /** Delete this name (formulas using it will break). */
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

/** What `save()` / `saveAs()` resolve to. `saved: false` is the cancelled case
 *  — a Before-Save handler vetoed, or the user dismissed the picker — and is
 *  never an error, so the whole cancel path is `if (!result.saved) return;`. */
declare interface ScriptSaveResult {
  /** True when the file was actually written. */
  saved: boolean;
  /** The file NAME written to; `null` when nothing was saved. Never a path. */
  name: string | null;
}

/**
 * The workbook facet of the canonical model (C3): Workbook -> Sheet -> Range,
 * plus the FILE lifecycle of the document your script lives in.
 *
 * There is no `open()`, `close()` or `new()`, and that is deliberate. Calcula
 * holds one document at a time, so each of those would replace or discard the
 * workbook the user is looking at — including their unsaved changes — on a
 * script's say-so. "Open" is worse still: clicking a file in a picker means
 * "open this file", not "let this running script read this file", so the click
 * would not be honest consent for what followed. Your script may PERSIST the
 * workbook it lives in; it may never replace or discard it. If what you need is
 * to read a file the user chooses, that is `context.caps.file.importText`.
 */
declare interface ScriptWorkbook {
  /** All sheets, in tab order. */
  sheets(): Promise<ScriptSheet[]>;
  /** The active sheet. */
  activeSheet(): Promise<ScriptSheet>;
  /** A sheet by exact name or 0-based index; null if not found. */
  sheet(nameOrIndex: string | number): Promise<ScriptSheet | null>;
  /**
   * Save back to the file this workbook came from — exactly what Ctrl+S does,
   * including any `onBeforeSave` handler's right to cancel it.
   *
   * Rejects if the workbook has never been saved (there is no file to save it
   * back to — call `saveAs()`), if this script saved less than 5 seconds ago,
   * or if called from inside an `onBeforeSave` / `onBeforeClose` handler.
   *
   * ```js
   * const result = await context.api.workbook.save();
   * if (!result.saved) return; // a Before-Save handler cancelled it
   * ```
   */
  save(): Promise<ScriptSaveResult>;
  /**
   * Ask the user where to save a copy. You pass nothing: they choose the folder,
   * the name and the format in the ordinary Windows dialog, and if they choose
   * `.xlsx` they get the same warning about what that format cannot carry.
   * Resolves `{ saved: false }` if they cancel.
   */
  saveAs(): Promise<ScriptSaveResult>;
  /** Whether this workbook has unsaved changes. */
  isDirty(): Promise<boolean>;
  /** This workbook's file NAME (`"Budget.cala"`), or `null` if it has never
   *  been saved. Just the name — the folder is deliberately not available to a
   *  script, because a path is useless to you and revealing about the user. */
  fileName(): Promise<string | null>;
}

/** Extended API surface available only in "unlocked" access mode. */
declare interface UnlockedAPI {
  /**
   * Canonical Workbook -> Sheet -> Range navigation (C3): the same model
   * extensions use. e.g. `const s = await api.workbook.sheet("Data"); await
   * s.range("A1:B5").setValues(...)`. Cross-sheet reach (unlocked tier only).
   */
  readonly workbook: ScriptWorkbook;
  /** Read a cell value by row/col (active sheet) as a DISPLAY STRING. */
  getCellValue(row: number, col: number): Promise<string>;
  /** Write a cell value by row/col (active sheet). */
  setCellValue(row: number, col: number, value: string): Promise<void>;
  /** Batch-update multiple cells (one undo step). */
  updateCellsBatch(updates: Array<{ row: number; col: number; value: string }>): Promise<void>;
  /** Read one cell WITH its type and formula (any sheet; defaults to active). */
  getCellData(row: number, col: number, sheetIndex?: number): Promise<ScriptCell>;
  /**
   * Read a whole rectangle in ONE call as typed cells (max 100 000 cells).
   * Prefer this over looping getCellValue: a 100x100 block is one round trip
   * instead of 10 000, and the cells keep their types + formulas.
   */
  getRangeValues(startRow: number, startCol: number, endRow: number, endCol: number, sheetIndex?: number): Promise<ScriptCell[][]>;
  /** Get all sheet names. */
  getSheetNames(): Promise<string[]>;
  /** Get the active sheet index. */
  getActiveSheet(): Promise<number>;
  /** Set the active sheet. */
  setActiveSheet(index: number): Promise<void>;
  /** Emit a custom event on the global event bus. Any name you invent is
   *  namespaced to `userscript:*`, so it can never collide with an app event. */
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
   * | `app:writeback-submission-received` | `{ regionId, count }` — answers arrived for an area YOU publish |
   *
   * Anything else is treated as one of your own custom names.
   *
   * ABOUT `app:writeback-submission-received`, because it is unlike the rest.
   * Nothing pushes into this app when somebody else's machine submits, so this
   * event is raised by a poll of the publisher inbox that runs ONLY while
   * something is subscribed — your subscription is what starts it, and
   * unsubscribing stops it. Expect a delay of up to a minute, not an instant.
   * You are told WHICH area and HOW MANY, never who or what: the answers
   * themselves stay behind `caps.writeback.listSubmissions`, which only works
   * if this workbook can sign the package.
   *
   * ```js
   * context.api.onEvent("app:sheet-renamed", ({ oldName, newName }) => {
   *   context.log(`${oldName} is now ${newName}`);
   * });
   * ```
   */
  onEvent(name: string, handler: (detail: any) => void): () => void;
  /** Execute a registered command by ID. Args are forwarded to the handler unchanged. */
  executeCommand(commandId: string, args?: unknown): void;
  /**
   * Begin an undo transaction. All cell changes until commitBatch() are
   * grouped as a single undo entry.
   * @param description Human-readable description shown in the Undo menu.
   */
  beginBatch(description: string): Promise<void>;
  /** Commit the current batch, finalizing it as a single undo entry. */
  commitBatch(): Promise<void>;
  /** Cancel the current batch, discarding all changes since beginBatch(). */
  cancelBatch(): Promise<void>;

  // -- Formatting --

  /**
   * Apply a PARTIAL format to a rectangle (max 100 000 cells) — one call, one
   * undo step. Only the properties you set change. Works on ANY sheet.
   * e.g. `await api.setRangeFormat(0, 0, 0, 4, { bold: true, backgroundColor: "#EEEEEE" })`
   */
  setRangeFormat(startRow: number, startCol: number, endRow: number, endCol: number, format: ScriptFormat, sheetIndex?: number): Promise<void>;
  /** Remove ALL formatting from a rectangle, keeping the values. ACTIVE SHEET
   *  only — call setActiveSheet() first for another sheet. */
  clearRangeFormat(startRow: number, startCol: number, endRow: number, endCol: number, sheetIndex?: number): Promise<void>;

  // -- Structure --
  // Every method in this block acts on the ACTIVE sheet. Passing a sheetIndex
  // that names another sheet REJECTS (it never silently retargets) — call
  // setActiveSheet() first. Only formatting is genuinely sheet-scoped.

  /** Insert `count` rows at `startRow`, shifting everything below down. */
  insertRows(startRow: number, count: number, sheetIndex?: number): Promise<void>;
  /** Delete `count` rows from `startRow` (their contents are lost). */
  deleteRows(startRow: number, count: number, sheetIndex?: number): Promise<void>;
  /** Insert `count` columns at `startCol`, shifting everything right. */
  insertColumns(startCol: number, count: number, sheetIndex?: number): Promise<void>;
  /** Delete `count` columns from `startCol` (their contents are lost). */
  deleteColumns(startCol: number, count: number, sheetIndex?: number): Promise<void>;
  /** Merge a rectangle into one cell (only the top-left value survives). */
  mergeCells(startRow: number, startCol: number, endRow: number, endCol: number, sheetIndex?: number): Promise<void>;
  /** Split the merged region containing (row, col) back into single cells. */
  unmergeCells(row: number, col: number, sheetIndex?: number): Promise<void>;
  /** Set a row's height in pixels (0 restores the sheet default). */
  setRowHeight(row: number, height: number, sheetIndex?: number): Promise<void>;
  /** Set a column's width in pixels (0 restores the sheet default). */
  setColumnWidth(col: number, width: number, sheetIndex?: number): Promise<void>;
  /** Freeze rows/columns so they stay on screen while scrolling. `freezeRow` is
   *  how many rows to freeze from the top; null unfreezes that axis. */
  freezePanes(freezeRow: number | null, freezeCol: number | null): Promise<void>;
  /**
   * Split the window into scrollable panes — the other half of View ▸ Window.
   * Unlike freezing, both panes scroll; `splitRow` is the row the horizontal
   * split sits above, and null removes that axis.
   * `await api.splitPanes(null, null)` removes the split entirely.
   */
  splitPanes(splitRow: number | null, splitCol: number | null): Promise<void>;

  // -- Sheets --

  /** Add a sheet (and make it active). Rejects a name that already exists. */
  addSheet(name?: string): Promise<{ index: number; name: string }>;
  /** Delete a sheet and everything on it. Rejects on the last remaining sheet. */
  deleteSheet(index: number): Promise<void>;
  /** Rename a sheet. Rejects a name that already exists. */
  renameSheet(index: number, newName: string): Promise<void>;
  /** Show or hide a sheet. Rejects hiding the last visible one. */
  setSheetVisibility(index: number, visibility: "visible" | "hidden" | "veryHidden"): Promise<void>;
  /**
   * Move a sheet to another position in the tab bar.
   *
   * EVERY OTHER SHEET IS RENUMBERED by this, so any index you were holding is
   * stale afterwards — re-read with `getSheetNames()`. Rejects an unknown
   * `fromIndex` or a `toIndex` past the last position (it never clamps
   * silently, which would leave you believing a sheet moved where it did not).
   */
  moveSheet(fromIndex: number, toIndex: number): Promise<void>;
  /**
   * Duplicate a sheet — cells, formatting and objects — as a new sheet placed
   * immediately after its source. Resolves to the new sheet's index and name.
   *
   * The insert RENUMBERS every sheet at or after that position, so re-read any
   * index you were holding. Rejects a name that already exists.
   *
   * ```js
   * const { index } = await api.copySheet(0, "February");
   * await api.setActiveSheet(index);
   * ```
   */
  copySheet(sourceIndex: number, newName?: string): Promise<{ index: number; name: string }>;

  // -- Sort + find/replace --

  /**
   * Sort a rectangle by one or more criteria (ACTIVE SHEET). Resolves to the
   * number of rows (or columns) moved.
   */
  sortRange(startRow: number, startCol: number, endRow: number, endCol: number, fields: ScriptSortField[], options?: { matchCase?: boolean; hasHeaders?: boolean; orientation?: "rows" | "columns" }, sheetIndex?: number): Promise<number>;
  // -- Column filtering (AutoFilter) --

  /**
   * The column filter on the ACTIVE SHEET — Excel's AutoFilter, the thing the
   * little arrows in a header row drive.
   *
   * Column indexes here are RELATIVE to the filter's first column, exactly as
   * the dropdown addresses them: a filter over C1:F20 calls column D `1`.
   *
   * ```js
   * await api.filter.apply(0, 0, 500, 4);          // header row + data
   * await api.filter.setColumn(1, { kind: "values", values: ["North"] });
   * await api.filter.setColumn(3, { kind: "custom", criterion1: ">=1000" });
   * const f = await api.filter.get();
   * context.log(`${f.hiddenRows.length} rows hidden`);
   * await api.filter.clear();                      // show everything again
   * ```
   *
   * ACTIVE SHEET ONLY — there is no sheet argument because the workbook has no
   * such command; call `setActiveSheet()` first.
   *
   * Requires the AutoFilter feature to be enabled. If it is not, these REJECT
   * rather than filtering somewhere you cannot see.
   */
  filter: {
    /** Read the filter, its per-column criteria and the rows it is hiding.
     *  Resolves to null when the sheet has no filter. */
    get(): Promise<ScriptAutoFilter | null>;
    /** The distinct values in one column, with counts — what the dropdown
     *  shows you, so you can build a values filter from it. */
    listValues(columnIndex: number): Promise<ScriptAutoFilterValues>;
    /** Turn filtering on for a rectangle whose FIRST ROW is the header row.
     *  Applying over an existing filter moves it (same filter, new range). */
    apply(startRow: number, startCol: number, endRow: number, endCol: number): Promise<ScriptAutoFilter>;
    /** Filter one column, hiding the rows that do not match. */
    setColumn(columnIndex: number, criteria: ScriptAutoFilterCriteria): Promise<ScriptAutoFilter>;
    /** Stop filtering one column — or every column, if you pass nothing — and
     *  show those rows again. The filter and its buttons stay. */
    clear(columnIndex?: number | null): Promise<ScriptAutoFilter>;
    /** Turn filtering off completely: no buttons, every row shown. */
    remove(): Promise<void>;
  };

  /** Find every matching cell on the active sheet, in reading order. */
  findAll(query: string, options?: { caseSensitive?: boolean; matchEntireCell?: boolean; searchFormulas?: boolean }): Promise<{ matches: ScriptFindMatch[]; totalCount: number }>;
  /** Replace everywhere on the active sheet (one undo step). */
  replaceAll(search: string, replacement: string, options?: { caseSensitive?: boolean; matchEntireCell?: boolean }): Promise<{ replacementCount: number }>;

  // -- Formula evaluation (VBA's Application.WorksheetFunction) --

  /**
   * Work out the answer to a spreadsheet formula WITHOUT writing it anywhere.
   *
   * This is the replacement for `Application.WorksheetFunction.VLookup(...)`:
   * all 400+ built-in functions, evaluated by the real engine against the live
   * grid, so you never have to reimplement `XLOOKUP` in JavaScript or park a
   * formula in a scratch cell and read it back. Cell references resolve; the
   * leading `=` is optional; nothing is stored and no undo entry is made.
   *
   * ```js
   * const total = await context.api.evaluate("SUMIFS(D:D, B:B, \"North\")");
   * if (total.type === "number") context.log(`North: ${total.value}`);
   * ```
   *
   * TWO HONEST LIMITS. Custom functions (your own JS UDFs) are NOT resolved
   * here — a UDF's body lives in another script's sandbox, and reaching into it
   * from inside a running evaluation is a door nobody consented to — so an
   * unknown name answers `#NAME?`. `GETPIVOTDATA` and `GET.CONTROLVALUE` have no
   * source wired either. Everything else behaves exactly as it would in a cell.
   *
   * A formula that cannot be parsed answers `#SYNTAX!` rather than throwing.
   */
  evaluate(expression: string, options?: { sheetIndex?: number }): Promise<ScriptEvaluatedValue>;
  /**
   * Evaluate several expressions in ONE round trip (max 64, each up to 8192
   * characters). Results come back in the order you asked for them; one bad
   * expression yields `#SYNTAX!` in its own slot and never loses the others.
   */
  evaluateAll(expressions: string[], options?: { sheetIndex?: number }): Promise<ScriptEvaluatedValue[]>;

  // -- Formulas, A1 or R1C1 (VBA's Range.Formula / Range.FormulaR1C1) --

  /**
   * Read the formula in a cell. Resolves `null` when the cell holds a plain
   * value, is empty, or has its formula hidden by sheet protection.
   *
   * Pass `{ style: "R1C1" }` to get it in R1C1 notation, relative to that cell.
   */
  getCellFormula(row: number, col: number, options?: ScriptFormulaOptions): Promise<string | null>;
  /**
   * Put a formula into a cell. Pass `null` to clear it.
   *
   * With `{ style: "R1C1" }` the string is read as R1C1 and converted relative
   * to the target cell — which is what makes writing the SAME relative formula
   * down a column one line instead of a loop that rebuilds an address per row:
   *
   * ```js
   * for (let r = 1; r <= 100; r++) {
   *   await context.api.setCellFormula(r, 3, "=RC[-2]*RC[-1]", { style: "R1C1" });
   * }
   * ```
   *
   * The leading `=` is added if you omit it: this method always writes a
   * FORMULA. For text or a literal number, use `setCellValue`.
   *
   * The style is what YOU are writing, never the user's View ▸ R1C1 setting — a
   * script's meaning must not change because somebody ticked a checkbox.
   */
  setCellFormula(row: number, col: number, formula: string | null, options?: ScriptFormulaOptions): Promise<void>;

  // -- Copy / paste / paste special (VBA's Range.Copy + PasteSpecial) --
  //
  // The clipboard behind these belongs to YOUR SCRIPT: it lives in Calcula, one
  // per script, and it is thrown away when the script stops. It is NOT the
  // Windows clipboard and NOT the one the user's own Ctrl+V reads. A script can
  // neither see what the person at the keyboard copied — that may be a password
  // — nor take away what they have in hand, nor use the clipboard as a way of
  // getting data out of Calcula. There is deliberately no method for any of it.

  /**
   * Copy a block of cells (values, formulas and formatting) into this script's
   * own clipboard. ACTIVE SHEET only. Resolves to the size copied.
   */
  copyRange(startRow: number, startCol: number, endRow: number, endCol: number, sheetIndex?: number): Promise<ScriptClipboardSize>;
  /**
   * Paste what was copied, with its top-left corner at (row, col). ACTIVE SHEET
   * only, one undo step. Relative references are shifted per cell, exactly as a
   * user's Ctrl+V would shift them.
   *
   * ```js
   * await context.api.copyRange(0, 0, 9, 3);
   * await context.api.paste(20, 0);
   * ```
   */
  paste(row: number, col: number, options?: ScriptPasteOptions): Promise<ScriptClipboardSize>;
  /**
   * The same operation spelled as PasteSpecial: `{ mode: "values" }` drops the
   * formulas and the formatting, `{ mode: "formulas" }` keeps the formulas and
   * drops the formatting, `{ transpose: true }` turns rows into columns, and
   * `{ skipBlanks: true }` leaves the destination alone where the source was
   * empty.
   *
   * There is no `"formats"` mode. Calcula has no batched way to write a style
   * onto a cell that does not exist yet, so a formats-only paste would appear to
   * succeed while doing nothing at all for every blank destination cell — and a
   * silent partial paste is worse than an honest absence.
   */
  pasteSpecial(row: number, col: number, options: ScriptPasteOptions): Promise<ScriptClipboardSize>;

  // -- Workbook objects: enumerate --
  // Identity and position only — never an object's contents.

  /** Every chart in the workbook. */
  charts(): Promise<ScriptObjectRef[]>;
  /** Every structured table in the workbook. */
  tables(): Promise<ScriptObjectRef[]>;
  /** Every pivot table in the workbook. */
  pivots(): Promise<ScriptObjectRef[]>;
  /** Every named range in the workbook. */
  namedRanges(): Promise<ScriptObjectRef[]>;
  /** Every slicer in the workbook. */
  slicers(): Promise<ScriptObjectRef[]>;
  /** Every cell-anchored form control / shape in the workbook. */
  shapes(): Promise<ScriptObjectRef[]>;

  // -- Workbook objects: create / delete --

  /**
   * Add a chart from a full ChartSpec. The spec is schema-validated — the
   * promise REJECTS (with the violations) rather than creating a broken chart.
   * Resolves to the new chart's id.
   * e.g. `const id = await api.createChart({ mark: "bar", data: "Sheet1!A1:B10", series: [...] })`
   */
  createChart(spec: Record<string, unknown>, options?: { name?: string; sheetIndex?: number; x?: number; y?: number; width?: number; height?: number }): Promise<string>;
  /** Delete a chart by id. */
  deleteChart(chartId: string): Promise<void>;
  /**
   * Turn a block of cells into a table. Always on the ACTIVE SHEET (the header
   * names are read from the live grid) — call setActiveSheet() first for
   * another sheet. Resolves to the new table's descriptor.
   */
  createTable(startRow: number, startCol: number, endRow: number, endCol: number, options?: { name?: string; hasHeaders?: boolean }): Promise<ScriptObjectRef>;
  /** Delete a table (its cells and values are kept). ACTIVE SHEET only. */
  deleteTable(tableId: string): Promise<void>;
  /**
   * Create a named range. Omit `sheetIndex` (or pass null) for a
   * workbook-scoped name. `refersTo` is a formula: "=Sheet1!$A$1:$B$10".
   */
  createNamedRange(name: string, refersTo: string, options?: { sheetIndex?: number | null; comment?: string }): Promise<void>;
  /** Delete a named range (formulas using the name will break). */
  deleteNamedRange(name: string): Promise<void>;
  /**
   * Create a pivot table and lay out its fields in one call. Field names are
   * the SOURCE COLUMN names; areas use the Pivot Layout DSL's vocabulary.
   * e.g. `await api.createPivot("A1:D100", "F1", { rows: ["Region"], values: [{ field: "Sales", aggregation: "sum" }] })`
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
  /** Delete a pivot table. */
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
   */
  callMethod(targetType: string, targetInstanceId: string | null, methodName: string, ...args: any[]): Promise<any>;
  /**
   * Call an export of a shared library this script declared with a
   * `// @uses <alias> <package>@<pin>` pragma.
   *
   * You normally do NOT call this by hand — declaring the pragma generates an
   * `imports` binding, and `imports.<alias>.<export>(...)` is the same call:
   *
   * ```js
   * // @uses stats acme.stats@^1.2.0
   * const avg = await imports.stats.mean([1, 2, 3]);
   * ```
   *
   * Note what this method does NOT take: an address. You name one of your own
   * aliases, and Calcula resolves it against the imports IT recorded for THIS
   * script. There is no handle or token to pass on, so a library you import
   * cannot be reached by another script just because it knows something you
   * know. A library is also never able to do more than you can: it runs with
   * your declared capabilities narrowed to its own, and a call through it that
   * needs a permission you have not been granted asks YOU for it first.
   * @param alias The alias from your `// @uses` pragma.
   * @param methodName A name the library declared with `// @export`.
   * @param args Arguments to pass, as an array.
   * @returns Promise of the library function's return value.
   */
  callImport(alias: string, methodName: string, args: any[]): Promise<any>;
  /** Log to the script console (visible in the Code tab output panel). */
  log(...args: any[]): void;
  /** Show a toast notification to the user. */
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
  /** The top-left cell's display value. */
  getValue(): Promise<string>;
  /**
   * All values as a rows x cols grid of display strings — ONE round trip.
   * These are FORMATTED strings: do NOT write them back (every formula would
   * become its rendered text). Use getData() when you need types or formulas.
   */
  getValues(): Promise<string[][]>;
  /** All cells with value, type and formula — ONE round trip. The safe read
   *  for a read/modify/write round-trip. */
  getData(): Promise<ScriptCell[][]>;
  /** All formulas as a rows x cols grid ("" where a cell has none). */
  getFormulas(): Promise<string[][]>;
  /** Set the top-left cell's value. */
  setValue(value: string): Promise<void>;
  /** Set values from a 2D array (clamped to the range's dimensions) — ONE call,
   *  one undo step. */
  setValues(values: string[][]): Promise<void>;
  /** Apply a PARTIAL format to every cell in the range — ONE call, one undo
   *  step. Absent properties are left alone:
   *  `await sheet.range("A1:C1").format({ bold: true })`. */
  format(format: ScriptFormat): Promise<void>;
  /** Remove ALL formatting from the range, keeping the values. */
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
  /** Read a cell's DISPLAY STRING from the specified (or active) sheet. */
  getCellValue(row: number, col: number, sheetIndex?: number): Promise<string>;
  /** Write a cell value. */
  setCellValue(row: number, col: number, value: string, sheetIndex?: number): Promise<void>;
  /** Read one cell WITH its type and formula. Restricted scripts may only name
   *  their own (active) sheet. */
  getCellData(row: number, col: number, sheetIndex?: number): Promise<ScriptCell>;
  /**
   * Read the formula in a cell on this sheet, in A1 or R1C1 notation. Resolves
   * `null` when the cell holds a plain value, is empty, or has its formula
   * hidden by sheet protection.
   */
  getCellFormula(row: number, col: number, options?: ScriptFormulaOptions): Promise<string | null>;
  /**
   * Put a formula into a cell on this sheet; `null` clears it. With
   * `{ style: "R1C1" }` the string is read as R1C1 relative to that cell, which
   * is how you write one relative formula down a whole column:
   *
   * ```js
   * for (let r = 1; r <= 100; r++) {
   *   await context.setCellFormula(r, 3, "=RC[-2]*RC[-1]", { style: "R1C1" });
   * }
   * ```
   *
   * The leading `=` is added if you omit it — this always writes a FORMULA; use
   * `setCellValue` for text. Restricted scripts may only name their own sheet.
   */
  setCellFormula(row: number, col: number, formula: string | null, options?: ScriptFormulaOptions): Promise<void>;
  /** Apply a PARTIAL format to a rectangle on this sheet — one call, one undo
   *  step. Only the properties you set change. Restricted scripts may only name
   *  their own (active) sheet. */
  setRangeFormat(startRow: number, startCol: number, endRow: number, endCol: number, format: ScriptFormat, sheetIndex?: number): Promise<void>;
  /** Remove ALL formatting from a rectangle on this sheet, keeping the values. */
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
    /** Clear this script's cached render results and repaint. */
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
  /** Set the selected items programmatically. */
  setSelectedItems(items: string[]): Promise<void>;
  /** Clear all selections. */
  clearSelection(): Promise<void>;
  /** Select all items. */
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
     */
    setProperty(name: string, value: string): void;
    /** Discard this slicer's cached item painting and repaint it. Call it after
     *  changing state your `itemRenderer` reads but Calcula cannot see. */
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
  /** Set the selected date range (ISO "YYYY-MM-DD"; null leaves a bound open). */
  setRange(start: string | null, end: string | null): Promise<void>;
  /** Clear the selection so every date is shown. */
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
   *  rejects if the merged spec would be invalid. */
  updateSpec(patch: Record<string, unknown>): Promise<void>;
  /** Replace the entire chart specification (full re-author). Schema-validated —
   *  the promise rejects on an invalid spec. */
  replaceSpec(fullSpec: Record<string, unknown>): Promise<void>;
  /** Style customization. */
  style: {
    /** Set a canvas-style property override (stored in chart spec). */
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
  /** Refresh the pivot table data. */
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
   */
  addField(field: string, area: ScriptPivotArea, position?: number, aggregation?: ScriptAggregation): Promise<void>;
  /** Move an already-placed field to another area (or another position). */
  moveField(field: string, area: ScriptPivotArea, position?: number): Promise<void>;
  /** Remove a placed field. Omit `area` to remove it from wherever it sits. */
  removeField(field: string, area?: ScriptPivotArea): Promise<void>;
  /** Change how a VALUE field is summarized. */
  setAggregation(field: string, aggregation: ScriptAggregation): Promise<void>;
  /** Apply LAYOUT directives, left to right (a later directive wins).
   *  e.g. `await pivot.setLayout(["tabular", "values-on-rows", "no-grand-totals"])` */
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

  /** Open (activate) this panel programmatically. */
  open(): void;
  /** Close (hide) this panel. For sidebar panels, collapses the side panel. */
  close(): void;
  /** Set a badge on the panel's tab/icon (e.g., notification count). Pass null to clear. */
  setBadge(text: string | null): void;
  /** Move this panel to a different location ("ribbon" or "sidebar"). */
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
  /** Read a table cell by 0-based data row + 0-based column index (async). */
  getCellValue(row: number, colIndex: number): Promise<string>;
  /** Write a table cell by 0-based data row + 0-based column index (async, undoable). */
  setCellValue(row: number, colIndex: number, value: string): Promise<void>;
  /** Append a new data row to the table (async, undoable). */
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
  /** Write a 2D array of values into the range (async, undoable). */
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
  /** Set a shape property value. */
  setProperty(key: string, value: string): Promise<void>;

  /** Read a cell value by reference (e.g., "A1", "B5"). Returns the display value. */
  getCellValue(cellRef: string): Promise<string>;
  /** Called when any cell value changes. Use to re-render when source data updates. */
  onCellChange(handler: (detail: { changes: Array<{ row: number; col: number; newValue: string }> }) => void): () => void;

  /**
   * Declare custom properties that appear in the shape's Properties pane, so a
   * user can configure your script without editing it. Sits on the context
   * itself (NOT under `render`) — declaring a property is a change to the
   * object's model, not to how it is painted.
   */
  declareProperties(props: DeclaredProperty[]): void;

  /** Rendering methods. */
  render: {
    /** Replace canvas rendering with an interactive HTML iframe overlay. */
    setHtmlContent(html: string): void;
    /** Send a message to the shape's HTML iframe. Inside the iframe, listen via `window.addEventListener('shape-message', (e) => { e.detail.type, e.detail.data })`. */
    sendMessage(type: string, data?: unknown): void;
    /** Listen for messages sent from the shape's HTML iframe via `calcula.sendMessage(type, data)`. */
    onMessage(handler: (detail: { type: string; data: unknown }) => void): () => void;
    /** Provide a custom canvas render function (replaces default shape path rendering). */
    canvasRenderer(renderer: (ctx: CanvasRenderingContext2D, bounds: ShapeRenderBounds) => void): () => void;
    /** Discard this shape's cached painting and repaint it. Needed when your
     *  renderer reads state Calcula cannot observe. */
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
  /** Write a 2D array into the bound range (clamped to it; one undo step). */
  setValues(values: string[][]): Promise<void>;
  /**
   * Apply a registered CELL TYPE to the bound range — the declarative half of
   * granular bricks (a rating widget, a status pill, a progress bar). `typeId`
   * names a cell type some extension registered; `params` configures it.
   */
  setCellType(typeId: string, params?: Record<string, unknown>): Promise<void>;
  /** Remove the cell type from the bound range, restoring plain cells. */
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
    /** Request a repaint (your renderer reads state Calcula cannot observe). */
    invalidate(): void;
  };
}

// ============================================================================
// The objectType -> context map (generated)
// ============================================================================

// @generated:context-type-map
