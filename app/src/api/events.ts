//! FILENAME: app/src/api/events.ts
// PURPOSE: Application-wide event system for decoupled communication.
// CONTEXT: Extensions and Shell use this to communicate without direct coupling.
// FIX: Event names must match core/lib/events.ts which is the canonical source.

// ============================================================================
// Event Names
// ============================================================================

export const AppEvents = {
  // Clipboard events (from core)
  CUT: "app:cut",
  COPY: "app:copy",
  PASTE: "app:paste",

  // Find/Replace events (from core)
  FIND: "app:find",
  REPLACE: "app:replace",

  // Freeze pane events
  FREEZE_CHANGED: "app:freeze-changed",

  // Split window events
  SPLIT_CHANGED: "app:split-changed",

  // View mode events
  VIEW_MODE_CHANGED: "app:view-mode-changed",
  SHOW_FORMULAS_TOGGLED: "app:show-formulas-toggled",
  DISPLAY_ZEROS_TOGGLED: "app:display-zeros-toggled",
  DISPLAY_GRIDLINES_TOGGLED: "app:display-gridlines-toggled",
  DISPLAY_HEADINGS_TOGGLED: "app:display-headings-toggled",
  DISPLAY_FORMULA_BAR_TOGGLED: "app:display-formula-bar-toggled",

  // Selection events
  SELECTION_CHANGED: "app:selection-changed",

  // Sheet events.
  //
  // SHEET_CHANGED is "the ACTIVE sheet changed". The three below are the sheet
  // COLLECTION changing, which until now nothing on the bus reported — a script
  // or extension could not react to a sheet appearing, disappearing or being
  // renamed. Emitted by the tauri-api sheet wrappers themselves, so every caller
  // announces the change (toolbar, sheet tabs, scripts, .calp pull). Payloads:
  //   SHEET_ADDED   { sheetIndex, sheetName, source }
  //   SHEET_DELETED { sheetIndex, sheetName }
  //   SHEET_RENAMED { sheetIndex, oldName, newName }
  // These payloads are visible to user scripts (scriptHost allowlist), so treat
  // their shape as public.
  SHEET_CHANGED: "app:sheet-changed",
  SHEET_ADDED: "app:sheet-added",
  SHEET_DELETED: "app:sheet-deleted",
  SHEET_RENAMED: "app:sheet-renamed",

  // Recalculation finished (an EXPLICIT recalc pass: Calculate Now / F9 /
  // Calculate Sheet / a post-model-change refresh). The incremental recalc that
  // follows a single edit is already reported by CELL_VALUES_CHANGED; this event
  // is the "the workbook is settled now" signal a script needs before reading
  // derived values in bulk.
  RECALCULATION_COMPLETED: "app:recalculation-completed",

  // A recalculation pass is RUNNING. Emitted by the backend on a ~100 ms clock
  // (never per formula) so the status bar can show progress and, above all,
  // offer a Cancel button. This is the Ctrl+Break affordance: the pass now runs
  // off the UI thread precisely so this event can be delivered and the button
  // can be clicked while it runs. Payload: CalcProgressPayload.
  CALC_PROGRESS: "app:calc-progress",

  // A recalculation was CANCELLED and some cells still hold pre-pass values.
  // The workbook is not wrong, but it is not settled either — the status bar
  // shows "Calculate" (Excel's own word for it) until a recalculation finishes.
  // Payload: RecalcIncompletePayload.
  RECALC_INCOMPLETE: "app:recalc-incomplete",

  // Data events
  DATA_CHANGED: "app:data-changed",
  CELLS_UPDATED: "app:cells-updated",
  CELL_VALUES_CHANGED: "app:cell-values-changed",

  // Editing events
  EDIT_STARTED: "app:edit-started",
  EDIT_ENDED: "app:edit-ended",

  // Grid events
  GRID_REFRESH: "app:grid-refresh",

  // Context menu events - FIX: Must match core/lib/events.ts
  CONTEXT_MENU_REQUEST: "app:context-menu-request",
  CONTEXT_MENU_CLOSE: "app:context-menu-close",

  // Structure events (row/column insert/delete)
  ROWS_INSERTED: "app:rows-inserted",
  COLUMNS_INSERTED: "app:columns-inserted",
  ROWS_DELETED: "app:rows-deleted",
  COLUMNS_DELETED: "app:columns-deleted",
  STRUCTURAL_UNDO: "app:structural-undo",

  // Generic post-mutation refresh. Core emits ONE of these with a list of change
  // DOMAINS (not feature/extension names) after undo/redo/commit; a Shell-side
  // translator fans it out to the per-feature refresh events. This keeps Core
  // feature-agnostic (it no longer dispatches pivot:refresh/slicers:refresh/etc).
  MUTATION_REFRESH: "app:mutation-refresh",

  // Navigation events
  NAVIGATE_TO_CELL: "app:navigate-to-cell",

  // Named ranges
  NAMED_RANGES_CHANGED: "app:named-ranges-changed",

  // Table (ListObject) lifecycle. These live in @api rather than inside the
  // Table extension because Pivot, Charts and AutoFilter all need to know when
  // a table's geometry or column set changes — an extension reaching into
  // another extension's internals (or hardcoding its event strings) is exactly
  // what the facade rule forbids. String values are unchanged, so existing
  // window listeners keep working during migration.
  TABLE_CREATED: "app:table-created",
  TABLE_DEFINITIONS_UPDATED: "app:table-definitions-updated",

  // Blur commit prevention
  PREVENT_BLUR_COMMIT: "app:prevent-blur-commit",

  // Status bar context menu
  STATUS_BAR_CONTEXT_MENU: "app:status-bar-context-menu",

  // Fill handle events
  FILL_COMPLETED: "app:fill-completed",

  // Annotation events (comments and notes)
  ANNOTATIONS_CHANGED: "app:annotations-changed",

  // Zoom events
  ZOOM_CHANGED: "app:zoom-changed",

  // Document Theme events (Office-style cell-content colors). NOT app appearance.
  THEME_CHANGED: "app:theme-changed",

  // App Appearance / Skin events (application chrome + grid skin). Distinct from
  // THEME_CHANGED so reskinning the app never marks the document dirty.
  APPEARANCE_CHANGED: "app:appearance-changed",

  // Workbook lifecycle events
  BEFORE_SAVE: "app:before-save",
  AFTER_SAVE: "app:after-save",
  BEFORE_OPEN: "app:before-open",
  AFTER_OPEN: "app:after-open",
  BEFORE_NEW: "app:before-new",
  AFTER_NEW: "app:after-new",
  BEFORE_CLOSE: "app:before-close",

  // Dirty state events
  DIRTY_STATE_CHANGED: "app:dirty-state-changed",

  // Linked sheet events
  LINKED_SHEETS_REFRESHED: "app:linked-sheets-refreshed",

  // Reference style events
  REFERENCE_STYLE_CHANGED: "app:reference-style-changed",

  // Locale events
  LOCALE_CHANGED: "app:locale-changed",

  // Status bar text events
  STATUS_BAR_TEXT_CHANGED: "app:status-bar-text-changed",

  // UI focus events
  NAMEBOX_FOCUS: "app:namebox-focus",

  // Ribbon visibility events
  RIBBON_TOGGLE_MINIMIZE: "app:ribbon-toggle-minimize",

  // Chart selection events
  CHART_SELECTION_CHANGED: "app:chart-selection-changed",

  // Dimension events (row/column resize)
  ROW_RESIZED: "app:row-resized",
  COLUMN_RESIZED: "app:column-resized",

  // BI model lifecycle events (design: docs/design/model-extensibility.md §5.3).
  // Emitted by the Rust model-install choke points (Tauri wire names
  // "bi:model-changed" / "bi:refresh-completed") and bridged onto this bus by
  // the Shell under the app: prefix convention. Payloads are METADATA-ONLY
  // (never expressions, row data, or role definitions); sandboxed script
  // subscribers receive a THINNED payload (see scriptHost/allowlist.ts
  // thinAppEventForScripts).
  BI_MODEL_CHANGED: "app:bi-model-changed",
  BI_REFRESH_COMPLETED: "app:bi-refresh-completed",

  // Report-distribution lifecycle (.calp). Emitted after a subscribe-pull or a
  // refresh-apply lands, so anything holding package-derived state (scripts,
  // chart libraries, the Package Explorer) can re-read. This replaced the
  // untyped, script-invisible "calp:scripts-pulled" window event: it carries a
  // proper app: id, so a script CAN subscribe to it — with a THINNED payload
  // (package name + version only; see scriptHost/allowlist.ts
  // thinAppEventForScripts), because the counts describe the subscriber's
  // workbook, not the package.
  PACKAGE_UPDATED: "app:package-updated",

  // A writeback SUBMISSION arrived for a region THIS workbook publishes (§5.5).
  //
  // HONESTY NOTE — READ BEFORE SUBSCRIBING. Submissions are appended to a
  // registry on disk by OTHER people's machines. Nothing pushes into this
  // process when that happens, so this event cannot fire on its own: it is
  // raised by the DEMAND-DRIVEN publisher-inbox poll in @api/distribution.ts,
  // which runs ONLY while something is subscribed (a script's api.onEvent, or
  // the Responses dashboard being open) and only for regions this machine can
  // prove it publishes (Ed25519 key possession, re-checked in Rust on every
  // read). With no subscriber there is no poll and no cost. See
  // SUBMISSION_POLL_INTERVAL_MS and getSubmissionWatchStatus() for the exact,
  // disclosed cost.
  //
  // The payload names WHO submitted and WHERE, never WHAT (see
  // WritebackSubmissionReceivedPayload); sandboxed script subscribers are
  // thinned further to { regionId, count } (thinAppEventForScripts), because a
  // per-respondent region's cell coordinates ARE an identity. The answers stay
  // behind the publisher-gated cap.writebackListSubmissions.
  WRITEBACK_SUBMISSION_RECEIVED: "app:writeback-submission-received",
} as const;

/**
 * A generic change-domain reported by a MUTATION_REFRESH event. These are
 * change CLASSES, not feature/extension names — Core knows nothing about which
 * extension consumes each. The Shell translator maps each domain to the concrete
 * per-feature refresh event(s).
 */
export type MutationDomain = "styles" | "pivot" | "slicer" | "ribbonFilter" | "paneControl" | "objects";

/** Payload of AppEvents.MUTATION_REFRESH. */
export interface MutationRefreshPayload {
  domains: MutationDomain[];
  source: "undo" | "redo" | "commit";
}

/** A single cell value change within a CELL_VALUES_CHANGED event. */
export interface CellValueChange {
  row: number;
  col: number;
  /**
   * Sheet the change occurred on. Absent means "the active sheet" — the historical
   * implicit contract, kept so existing single-sheet emitters need no change.
   * Cross-sheet emitters (fills/edits that touch other sheets) MUST set it so
   * sheet-scoped consumers (chart invalidation, render-cache staleness) don't
   * mistake an off-sheet edit for an active-sheet one.
   */
  sheetIndex?: number;
  oldValue?: string;
  newValue: string;
  formula?: string | null;
}

/** Payload emitted with CELL_VALUES_CHANGED event. */
export interface CellValuesChangedPayload {
  changes: CellValueChange[];
  source: "user" | "undo" | "redo" | "paste" | "fill" | "clear" | "script" | "api";
}

/**
 * OPTIONAL payload on the CELLS_UPDATED event. CELLS_UPDATED remains a fire-on-
 * every-change signal that may be emitted bare; when the changed cells are known
 * (the canonical cellEvents path) they ride along here so subscribers can scope
 * their work (e.g. invalidate only charts whose range intersects a change). Uses
 * the `changes` key only (never top-level row/col) — handlers must treat it as
 * possibly-absent and fall back to a full refresh.
 */
export interface CellsUpdatedPayload {
  changes: CellValueChange[];
}

/** The change domain reported by a BI_MODEL_CHANGED event. */
export type BiModelChangeDomain =
  | "measure" | "calcColumn" | "relationship" | "hierarchy" | "kpi"
  | "calcGroup" | "scriptFunction" | "table" | "context" | "contextColumn"
  | "variable" | "calculatedTable" | "perspective" | "culture" | "role"
  | "writebackColumn" | "source" | "extensionData" | "metadata" | "bulk";

/** Payload of AppEvents.BI_MODEL_CHANGED (metadata-only, never expressions). */
export interface BiModelChangedPayload {
  connectionId: string;
  domain: BiModelChangeDomain;
  /** Changed object's name when cheaply determinable (single add/edit/rename). */
  objectName?: string;
  source: "user" | "script" | "extension" | "undo" | "redo" | "package";
  /** Set when the mutation came through the consent-gated script gateway. */
  scriptId?: string;
  /** Monotonic per-model revision — detect missed events, then re-read. */
  revision: number;
}

/** Payload of AppEvents.BI_REFRESH_COMPLETED. */
export interface BiRefreshCompletedPayload {
  connectionId: string;
  tables: Array<{ name: string; ok: boolean; error?: string }>;
  durationMs: number;
}

/** Payload of AppEvents.SHEET_ADDED. */
export interface SheetAddedPayload {
  sheetIndex: number;
  sheetName: string;
  /** "new" for an empty sheet, "copy" when it was duplicated from another. */
  source: "new" | "copy";
}

/** Payload of AppEvents.SHEET_DELETED. */
export interface SheetDeletedPayload {
  /** The index the sheet occupied BEFORE it was removed. */
  sheetIndex: number;
  sheetName: string;
}

/** Payload of AppEvents.SHEET_RENAMED. */
export interface SheetRenamedPayload {
  sheetIndex: number;
  oldName: string;
  newName: string;
}

/** Payload of AppEvents.RECALCULATION_COMPLETED. */
export interface RecalculationCompletedPayload {
  /** "workbook" = calculate_now (F9), "sheet" = calculate_sheet. */
  scope: "workbook" | "sheet";
  /** How many cells the engine reported as changed. */
  cellsUpdated: number;
  durationMs: number;
}

/**
 * Payload of AppEvents.CALC_PROGRESS — mirrors `CalcProgressEvent` in
 * app/src-tauri/src/eval_budget.rs.
 *
 * The wall clock behind `elapsedMs` is the ONLY clock anywhere near
 * calculation, and it is allowed to exist because it decides when a BUTTON
 * appears, never what a cell contains.
 */
export interface CalcProgressPayload {
  scope: "workbook" | "sheet";
  cellsDone: number;
  cellsTotal: number;
  elapsedMs: number;
  /** True on the final event of a pass. */
  done: boolean;
  /** True when the pass ended because the user cancelled it. */
  cancelled: boolean;
  /** Cells left un-recalculated (non-zero only when `cancelled`). */
  pendingCells: number;
}

/** One cell a cancelled recalculation never reached. */
export interface PendingRecalcCell {
  row: number;
  col: number;
}

/** Payload of AppEvents.RECALC_INCOMPLETE. */
export interface RecalcIncompletePayload {
  sheetIndex: number;
  /** How many cells still hold pre-pass values. */
  cellCount: number;
}

/**
 * Payload of AppEvents.PACKAGE_UPDATED (trusted subscribers). Sandboxed script
 * subscribers receive only { packageName, version } — see thinAppEventForScripts.
 */
export interface PackageUpdatedPayload {
  packageName: string;
  /** Resolved semver of the version now installed; null when a refresh touched
   *  several subscriptions at once and no single version applies. */
  version: string | null;
  /** How the update happened. */
  kind: "subscribe" | "refresh";
  /** Sheets this update materialized into the workbook. */
  sheetsPulled: number;
  /** Object scripts this update materialized or replaced; `null` when the
   *  backend does not break the count out per package (the refresh path
   *  reports totals, not per-subscription counts). Subscribers must reload
   *  package-derived state regardless of the count. */
  scriptsPulled: number | null;
}

/** One newly-submitted value announced by WRITEBACK_SUBMISSION_RECEIVED. */
export interface WritebackSubmissionNotice {
  /** The submission event id — pass it back to approve/reject that exact one. */
  submissionId: string;
  submitterId: string;
  submitterName: string;
  cellRow: number;
  cellCol: number;
  /** ISO 8601 timestamp the contributor's machine recorded, when present. */
  submittedAt: string | null;
}

/**
 * Payload of AppEvents.WRITEBACK_SUBMISSION_RECEIVED (trusted subscribers).
 *
 * DELIBERATELY WITHOUT VALUES. This is a NOTIFICATION that answers arrived, not
 * a delivery of them: the values live behind the publisher-gated inbox
 * (loadRegionSubmissions / cap.writebackListSubmissions), which re-proves key
 * possession in Rust at every read. Putting them on an event bus would move
 * other people's answers to a surface that has no gate of its own.
 *
 * Sandboxed script subscribers receive only { regionId, count } — see
 * thinAppEventForScripts in scriptHost/allowlist.ts.
 */
export interface WritebackSubmissionReceivedPayload {
  regionId: string;
  /** How many newly-submitted values this poll pass observed for the region. */
  count: number;
  /** Up to MAX_REPORTED_SUBMISSIONS of them; see `truncated`. */
  submissions: WritebackSubmissionNotice[];
  /** True when `count` exceeded the per-event cap and `submissions` is partial. */
  truncated: boolean;
  /** When the poll OBSERVED them (this machine's clock), ISO 8601. Not when
   *  they were submitted — the gap is the poll interval, at most. */
  observedAt: string;
}

/** Payload emitted with FILL_COMPLETED event. */
export interface FillCompletedPayload {
  sourceRange: { startRow: number; startCol: number; endRow: number; endCol: number };
  targetRange: { startRow: number; startCol: number; endRow: number; endCol: number };
  direction: "down" | "up" | "right" | "left";
}

export type AppEventName = (typeof AppEvents)[keyof typeof AppEvents];

// ============================================================================
// User-script event namespacing (sandbox design §5, R5)
// ============================================================================

/**
 * Namespace prefix for events emitted by object scripts. Force-prefixing on
 * BOTH emit and subscribe (symmetric) means scripts using their own custom
 * names see no behavior change, while internal control events (e.g.
 * shape:setCanvasRenderer) can never be forged or observed by scripts.
 */
export const USERSCRIPT_EVENT_PREFIX = "userscript:";

/** Apply the userscript namespace to a custom event name (idempotent). */
export function namespaceUserEvent(name: string): string {
  return name.startsWith(USERSCRIPT_EVENT_PREFIX) ? name : USERSCRIPT_EVENT_PREFIX + name;
}

// ============================================================================
// Event Emitter/Listener Functions
// ============================================================================

/**
 * Emit an application event.
 * @param eventName The event name from AppEvents
 * @param detail The event payload
 */
export function emitAppEvent<T = unknown>(eventName: AppEventName | string, detail?: T): void {
  const event = new CustomEvent(eventName, { detail });
  window.dispatchEvent(event);
}

/**
 * Subscribe to an application event.
 * @param eventName The event name from AppEvents
 * @param callback The callback to invoke when the event fires
 * @returns Cleanup function to unsubscribe
 */
export function onAppEvent<T = unknown>(
  eventName: AppEventName | string,
  callback: (detail: T) => void
): () => void {
  const handler = (event: Event) => {
    const customEvent = event as CustomEvent<T>;
    callback(customEvent.detail);
  };

  window.addEventListener(eventName, handler);

  return () => {
    window.removeEventListener(eventName, handler);
  };
}

// ============================================================================
// UI Utilities
// ============================================================================

/**
 * Restore keyboard focus to the grid canvas.
 * Used after menu actions, dialogs, etc. to return focus to the spreadsheet.
 */
export function restoreFocusToGrid(): void {
  const canvas = document.querySelector("canvas") as HTMLElement | null;
  if (canvas) {
    canvas.focus();
  }
}