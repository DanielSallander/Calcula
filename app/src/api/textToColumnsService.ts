//! FILENAME: app/src/api/textToColumnsService.ts
// PURPOSE: The feature-neutral seam through which the API facade can run a
//          Text-to-Columns split without knowing that a TextToColumns
//          extension exists.
// CONTEXT: Inversion of Control, the same shape autoFilterService.ts and
//          printService.ts use. The TextToColumns extension OWNS the split:
//          its parser (delimiters, text qualifier, consecutive-merge) and its
//          write path (one undo transaction + the grid refresh) are the SAME
//          code the Data ▸ Text to Columns wizard executes, so a script's
//          split and a person's split can never disagree about what a
//          delimiter means. @api owns nothing about splitting except this one
//          contract.
//
// ACTIVE SHEET ONLY, by construction: the provider writes through the same
// batch-update path the wizard uses, which addresses the active sheet. The
// script-host executor enforces that (assertActiveSheet) BEFORE calling here.
//
// With the extension disabled these REFUSE (requireTextToColumnsController
// throws) rather than splitting invisibly or answering an empty result a
// caller cannot tell from "nothing to split".

/** One Text-to-Columns run, as the script surface asks for it. */
export interface TextToColumnsRequest {
  /** The SOURCE: one column, rows startRow..endRow inclusive (0-based). */
  startRow: number;
  startCol: number;
  endRow: number;
  /** Must equal startCol — the source is a single column. */
  endCol: number;
  /** Single-character delimiters. Standard ones (tab, semicolon, comma,
   *  space) may appear together with AT MOST ONE custom character. Omitted =
   *  [","] (the wizard's default). */
  delimiters?: string[];
  /** Merge runs of consecutive delimiters into one split (default false). */
  consecutiveAsOne?: boolean;
  /** Where the split lands, top-left cell. Omitted = the source's own
   *  top-left (split in place, first column overwritten). */
  destination?: { row: number; col: number };
}

/** What a split did. `writtenCells` names every cell written, so the caller
 *  can attribute the writes (script-audit) without re-deriving geometry. */
export interface TextToColumnsResult {
  rowsProcessed: number;
  columnsProduced: number;
  cellsWritten: number;
  writtenCells: Array<{ row: number; col: number }>;
}

/** What the TextToColumns extension provides. */
export interface TextToColumnsController {
  /** Run one split as a single undo step. Rejects (throws) on a multi-column
   *  source, an unusable delimiter set, or a refused write (protection /
   *  writeback claims — the backend's reason propagates verbatim). */
  split(request: TextToColumnsRequest): Promise<TextToColumnsResult>;
}

let controller: TextToColumnsController | null = null;

/**
 * Register the TextToColumns driver. Called once by the TextToColumns
 * extension at activation; returns the unregister function for its cleanup
 * list. Last registration wins, and unregistering only clears the controller
 * if it is still the one that was registered — so a re-activation followed by
 * the OLD cleanup running cannot blank out the live provider.
 */
export function registerTextToColumnsController(
  next: TextToColumnsController,
): () => void {
  controller = next;
  return () => {
    if (controller === next) controller = null;
  };
}

/** Whether Text to Columns is currently drivable. */
export function hasTextToColumnsController(): boolean {
  return controller !== null;
}

/**
 * The registered controller.
 *
 * THROWS when none is registered (the TextToColumns extension is disabled or
 * failed to load). Refusing loudly is the point: a split that silently does
 * nothing leaves the script author staring at unchanged cells with no error
 * to search for.
 */
export function requireTextToColumnsController(): TextToColumnsController {
  if (!controller) {
    throw new Error(
      "Text to Columns is unavailable: no provider is registered (the TextToColumns extension is not loaded).",
    );
  }
  return controller;
}

/** Test/reset hook: forget the registered controller. */
export function resetTextToColumnsController(): void {
  controller = null;
}
