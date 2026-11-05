//! FILENAME: app/src/api/autoFilterService.ts
// PURPOSE: The feature-neutral seam through which the API facade can drive
//          column filtering without knowing that an AutoFilter extension exists.
// CONTEXT: Inversion of Control, the same shape printService.ts and
//          componentStoreRegistry use. The AutoFilter extension OWNS the filter:
//          the chevron overlay regions, the cached AutoFilterInfo that chevron
//          clicks resolve column indexes against, and the hidden-row set pushed
//          into Core's grid state. @api owns nothing about filtering except this
//          one contract.
//
// WHY THE SCRIPT BROKER GOES THROUGH HERE RATHER THAN STRAIGHT TO THE BACKEND.
// Every apply/clear/remove command already exists in @api/backend.ts, so calling
// them directly would "work" — and would leave the extension holding a STALE
// AutoFilterInfo. That is not cosmetic: a chevron click sends a column index
// RELATIVE to the cached start_col, which the backend resolves against its own
// (moved) start_col, so a stale cache silently filters a DIFFERENT column than
// the one the user clicked. The extension's store is the only place that
// refreshes the cache, re-syncs the overlay region and pushes hidden rows into
// the grid, so that is the door.
//
// TABLE OWNERSHIP IS NOT MODELLED HERE AT ALL, ON PURPOSE. `Table.autoFilterId`
// is DERIVED state that Rust recomputes in `relink_autofilter_owner` at every
// site where a sheet's filter is created, moved or removed (and it does so
// AFTER releasing the auto_filters guard, because create_table locks
// tables->auto_filters and the reverse order would deadlock). Nothing on this
// path may set, clear or infer that link: the controller calls the same Tauri
// commands the ribbon calls, and the relink happens inside them.

import { getAutoFilter, getHiddenRows } from "./backend";

/** Where a filter sits and what it is currently doing. Mirrors the backend's
 *  AutoFilterInfo plus the hidden-row set, which is what a caller actually
 *  wants to know ("what did that do?") and which the info alone does not say. */
export interface AutoFilterSnapshot {
  /** The filter's EntityId (UUID string). */
  id: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  enabled: boolean;
  /** Whether any column currently hides rows. */
  isDataFiltered: boolean;
  /** One entry per column of the range, in range order; null = unfiltered.
   *  `columnIndex` is RELATIVE to startCol, which is how every backend command
   *  addresses a column. */
  columns: Array<AutoFilterColumnState | null>;
  /** Absolute row indices currently hidden by the filter. */
  hiddenRows: number[];
}

/** The criteria on one filtered column, read back. */
export interface AutoFilterColumnState {
  columnIndex: number;
  /** "values" | "custom" | "color" | "icon" | "dynamic" | "top10" ... — the
   *  backend's FilterOn discriminator, passed through verbatim. */
  filterOn: string;
  /** Selected values for a values filter (empty for other kinds). */
  values: string[];
  criterion1: string | null;
  criterion2: string | null;
  operator: "and" | "or" | null;
  /** True when blanks are excluded. */
  filterOutBlanks: boolean;
}

/** What a caller may ASK for on one column. Exactly two shapes are offered —
 *  pick values, or write a rule — because those are the two a person can also
 *  do in the dropdown, and a script surface that can express filters the UI
 *  cannot is a surface the user cannot inspect or undo by hand. */
export type AutoFilterColumnCriteria =
  | {
      kind: "values";
      /** The values to KEEP. */
      values: string[];
      /** Whether blank cells are kept too (default false). */
      includeBlanks?: boolean;
    }
  | {
      kind: "custom";
      /** An Excel-style criterion: ">=100", "<>done", "=*text*". */
      criterion1: string;
      criterion2?: string;
      /** How the two criteria combine (default "and"). */
      operator?: "and" | "or";
    };

/** Distinct values in one column, for building a values filter. */
export interface AutoFilterUniqueValues {
  values: Array<{ value: string; count: number }>;
  hasBlanks: boolean;
}

/**
 * What the AutoFilter extension provides. Every method acts on the ACTIVE
 * SHEET, because every backend AutoFilter command does — there is no sheet
 * parameter to pass, so callers must switch sheets first rather than be
 * silently retargeted.
 */
export interface AutoFilterController {
  /** The filter on the active sheet, or null if there is none. */
  get(): Promise<AutoFilterSnapshot | null>;
  /** Distinct values in one column (index RELATIVE to the filter's startCol). */
  listValues(columnIndex: number): Promise<AutoFilterUniqueValues>;
  /** Turn filtering on for a rectangle (the first row is the header row).
   *  Applying over an existing filter MOVES it — same identity, new range. */
  apply(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ): Promise<AutoFilterSnapshot>;
  /** Filter one column. */
  setColumn(
    columnIndex: number,
    criteria: AutoFilterColumnCriteria,
  ): Promise<AutoFilterSnapshot>;
  /** Stop filtering one column, or every column when `columnIndex` is null.
   *  The filter itself (and its buttons) stays. */
  clear(columnIndex: number | null): Promise<AutoFilterSnapshot>;
  /** Turn filtering off entirely and show every row again. */
  remove(): Promise<void>;
  /** Re-run the filter's criteria over the CURRENT data (rows edited since the
   *  filter was applied are shown or hidden again) -- Excel's Reapply. Rejects
   *  when there is no filter to reapply. */
  reapply(): Promise<AutoFilterSnapshot>;
}

let controller: AutoFilterController | null = null;

/**
 * Register the AutoFilter driver. Called once by the AutoFilter extension at
 * activation; returns the unregister function for its cleanup list.
 *
 * Last registration wins, and unregistering only clears the controller if it is
 * still the one that was registered — so a re-activation followed by the OLD
 * cleanup running cannot blank out the live provider.
 */
export function registerAutoFilterController(
  next: AutoFilterController,
): () => void {
  controller = next;
  return () => {
    if (controller === next) controller = null;
  };
}

/** Whether column filtering is currently drivable. */
export function hasAutoFilterController(): boolean {
  return controller !== null;
}

/**
 * The registered controller.
 *
 * THROWS when none is registered (the AutoFilter extension is disabled or
 * failed to load). Refusing loudly is the point: filtering the backend while
 * the grid still shows every row, and while the extension's cached range is
 * wrong, is worse than not filtering at all — and a caller cannot tell "no
 * filter feature" from "nothing matched" if the answer is an empty result.
 */
export function requireAutoFilterController(): AutoFilterController {
  if (!controller) {
    throw new Error(
      "Column filtering is unavailable: no AutoFilter provider is registered (the AutoFilter extension is not loaded).",
    );
  }
  return controller;
}

/** Test/reset hook: forget the registered controller (and the last status it
 *  published; listeners stay subscribed). */
export function resetAutoFilterController(): void {
  controller = null;
  status = NO_FILTER;
}

// ============================================================================
// The filter's STATUS, pushed -- what a ribbon shows without asking
// ============================================================================
//
// WHY A PUSHED STATUS AND NOT `get()`. The Home tab's Sort & Filter menu shows
// Filter CHECKED while the sheet has a filter and enables Clear / Reapply only
// while data is filtered (measured in live Excel 2026-10-04: both are disabled
// for a filter that hides nothing). `get()` is a backend round trip that also
// re-syncs the overlay region as a side effect -- a surface that called it on
// every render, or on a timer, would be polling the workbook. The change events
// that already said all of this were private to the AutoFilter extension
// (its lib/filterEvents.ts), so nothing outside it could listen.
//
// So the extension PUBLISHES the two booleans every time its cached filter
// changes (the same cache a chevron click reads), and a surface subscribes.
// Listeners hear a real change only: publishing the same status twice is
// silent, so a re-sync that changed nothing does not re-render anything.

/** The two facts a ribbon needs, for the ACTIVE sheet. */
export interface AutoFilterStatus {
  /** The active sheet has an AutoFilter (its header buttons are showing). */
  hasFilter: boolean;
  /** Some column's criteria currently hide rows. */
  isDataFiltered: boolean;
}

const NO_FILTER: AutoFilterStatus = Object.freeze({ hasFilter: false, isDataFiltered: false });

let status: AutoFilterStatus = NO_FILTER;
const statusListeners = new Set<(status: AutoFilterStatus) => void>();

/** The last status the provider published (no filter until it says otherwise). */
export function getAutoFilterStatus(): AutoFilterStatus {
  return status;
}

/**
 * Hear every change of the active sheet's filter status: turned on or off,
 * criteria applied or cleared, the sheet switched. The listener is called with
 * the NEW status, only when it differs from the last one. Returns the
 * unsubscribe function.
 */
export function onChange(listener: (status: AutoFilterStatus) => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

/**
 * Called by the AutoFilter provider whenever its cached filter changes. A
 * status equal to the last one is not re-announced.
 */
export function publishAutoFilterStatus(next: AutoFilterStatus): void {
  const normalised: AutoFilterStatus = {
    hasFilter: next.hasFilter,
    // "Filtered" without a filter is not a state the ribbon can show.
    isDataFiltered: next.hasFilter && next.isDataFiltered,
  };
  if (
    normalised.hasFilter === status.hasFilter &&
    normalised.isDataFiltered === status.isDataFiltered
  ) {
    return;
  }
  status = normalised;
  // A COPY: a listener may unsubscribe while being told.
  for (const listener of [...statusListeners]) {
    try {
      listener(status);
    } catch (err) {
      console.error("[autoFilterService] status listener threw:", err);
    }
  }
}

// ============================================================================
// FILTER MODE -- Excel's Worksheet.FilterMode, for the gestures that change
// with it
// ============================================================================
//
// Excel switches two gestures on the SHEET's filter mode, not on whether the
// cells in hand are hidden -- measured live (Excel 16, 2026-11-05, lane uic
// probe1..probe3):
//   - AutoSum's Sum writes =SUBTOTAL(9,...) instead of =SUM(...) ANYWHERE on a
//     sheet in filter mode: inside the filtered range, in other columns, below
//     it, as a row total, in a one-cell guess -- and also when the criteria
//     hide no row at all. A filter with its buttons showing but no criteria,
//     rows hidden by hand and collapsed outline rows do NOT switch it, and a
//     filter on ANOTHER sheet does not either. An in-place Advanced Filter
//     does.
//   - Ctrl+Enter skips EVERY hidden row of its selection while the sheet is in
//     filter mode -- the filter's, and rows hidden by hand inside or outside
//     the filtered range -- and fills hidden rows like any other otherwise.
// So both ask this one question instead of looking at hidden rows.

/**
 * Whether the ACTIVE sheet is in filter mode (Excel's `Worksheet.FilterMode`):
 * its AutoFilter has criteria applied -- even criteria that hide nothing -- or
 * an Advanced Filter hides rows in place. Read from the backend each time (no
 * cached status), so it is right straight after a filter change or a sheet
 * switch. A failed read answers false: the gesture then behaves as on an
 * unfiltered sheet, which is what it did before it asked.
 *
 * Known gap: an Advanced Filter applied in place that hides NO row is not
 * seen (the backend keeps only its hidden rows), where Excel is in filter mode.
 */
export async function isActiveSheetFilterMode(): Promise<boolean> {
  const [info, hidden] = await Promise.all([
    getAutoFilter().catch(() => null),
    getHiddenRows().catch(() => [] as number[]),
  ]);
  if (info && info.enabled && info.isDataFiltered) return true;
  // The AutoFilter's own hidden rows exist only under criteria (handled above),
  // so any hidden row left is an Advanced Filter's.
  return hidden.length > 0;
}
