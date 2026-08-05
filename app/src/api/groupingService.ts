//! FILENAME: app/src/api/groupingService.ts
// PURPOSE: The feature-neutral seam through which the API facade can drive
//          row/column outline grouping without knowing that a Grouping
//          extension exists.
// CONTEXT: Inversion of Control, the same shape autoFilterService.ts and
//          printService.ts use. The Grouping extension OWNS the outline: the
//          outline-bar renderer, the cached OutlineInfo click hit-testing
//          resolves against, and the group-hidden row/col sets it pushes into
//          Core's grid state. @api owns nothing about grouping except this one
//          contract.
//
// WHY THE SCRIPT BROKER GOES THROUGH HERE RATHER THAN STRAIGHT TO THE BACKEND.
// Every group/ungroup command already exists in @api/backend.ts, so calling
// them directly would "work" — and would leave the grid SHOWING rows the
// backend now hides (and an outline bar that never appears), because only the
// extension's store pushes hidden rows/cols into grid state and resizes the
// outline bar. The extension's store is the only place that does that sync, so
// that is the door. With the extension disabled these REFUSE rather than
// grouping invisibly.

/** What one grouping operation did — the outline's new depth plus exactly
 *  which rows/columns changed visibility because of it. */
export interface GroupingOpResult {
  /** Deepest row group level on the sheet after the operation (0 = none). */
  maxRowLevel: number;
  /** Deepest column group level on the sheet after the operation (0 = none). */
  maxColLevel: number;
  /** Absolute row indices whose visibility this operation changed. */
  hiddenRowsChanged: number[];
  /** Absolute column indices whose visibility this operation changed. */
  hiddenColsChanged: number[];
}

/**
 * What the Grouping extension provides. Every method acts on the ACTIVE SHEET,
 * because every backend outline command does — there is no sheet parameter to
 * pass, so callers must switch sheets first rather than be silently
 * retargeted. All spans are 0-based and inclusive.
 *
 * Implementations must REJECT (throw) on a failed operation — never resolve
 * with a "nothing happened" result — and must leave the grid, the outline bar
 * and the backend in agreement before resolving.
 */
export interface GroupingController {
  /** Group a row span (create or deepen the outline level). */
  groupRows(startRow: number, endRow: number): Promise<GroupingOpResult>;
  /** Ungroup a row span (remove or shallow the outline level). */
  ungroupRows(startRow: number, endRow: number): Promise<GroupingOpResult>;
  /** Group a column span. */
  groupColumns(startCol: number, endCol: number): Promise<GroupingOpResult>;
  /** Ungroup a column span. */
  ungroupColumns(startCol: number, endCol: number): Promise<GroupingOpResult>;
  /** Show rows/columns only up to an outline level (Excel's little 1/2/3
   *  buttons). `null` leaves that axis alone. */
  showOutlineLevel(
    rowLevel: number | null,
    colLevel: number | null,
  ): Promise<GroupingOpResult>;
}

let controller: GroupingController | null = null;

/**
 * Register the Grouping driver. Called once by the Grouping extension at
 * activation; returns the unregister function for its cleanup list.
 *
 * Last registration wins, and unregistering only clears the controller if it
 * is still the one that was registered — so a re-activation followed by the
 * OLD cleanup running cannot blank out the live provider.
 */
export function registerGroupingController(
  next: GroupingController,
): () => void {
  controller = next;
  return () => {
    if (controller === next) controller = null;
  };
}

/** Whether outline grouping is currently drivable. */
export function hasGroupingController(): boolean {
  return controller !== null;
}

/**
 * The registered controller.
 *
 * THROWS when none is registered (the Grouping extension is disabled or failed
 * to load). Refusing loudly is the point: grouping the backend while the grid
 * still shows every row — and while no outline bar exists to expand them again
 * — is worse than not grouping at all.
 */
export function requireGroupingController(): GroupingController {
  if (!controller) {
    throw new Error(
      "Outline grouping is unavailable: no Grouping provider is registered (the Grouping extension is not loaded).",
    );
  }
  return controller;
}

/** Test/reset hook: forget the registered controller. */
export function resetGroupingController(): void {
  controller = null;
}
