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

/** Test/reset hook: forget the registered controller. */
export function resetAutoFilterController(): void {
  controller = null;
}
