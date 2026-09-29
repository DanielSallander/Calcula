//! FILENAME: app/extensions/Controls/lib/controlAnchors.ts
// PURPOSE: The ONE place that decides which anchor cell a NEW control gets and
//          where it paints: the free-anchor allocator, the placement rules for
//          a create request, and the queue every control creation runs on.
// CONTEXT: A control's anchor cell is its IDENTITY. The backend keys control
//          metadata by (sheet, row, col), and the instanceId an object script
//          binds to is derived from the same three numbers. So an anchor must be
//          unique on its sheet — and the backend's `set_control_metadata` is a
//          plain map insert that REPLACES whatever an occupied cell holds.
//
//          Two callers used to need a free anchor for a control that has no
//          natural cell (a pasted/duplicated copy), and the canvas sheet adds a
//          third: an object inserted at a snapped pixel rectangle on a page that
//          has no cells at all. The allocator lived privately in
//          controlClipboard.ts; it lives here now so paste, duplicate and the
//          three create seams share one rule.
//
//          ALLOCATION IS SERIALISED WITH THE WRITE. Picking a "free" cell is a
//          read (`get_all_controls`) and claiming it is a later write
//          (`set_control_metadata`). Two inserts in flight would otherwise both
//          read the same state, both pick the same cell, and the second write
//          would silently REPLACE the first control — the same invisible
//          overwrite the button/picture seams warn about. `withControlAnchor`
//          runs "decide the anchor, write the control" as one step on a FIFO
//          queue, so the next allocation always sees the previous write.

import { idsNamedByLayout } from "@api/objectSelection";
import { getAllControls } from "./controlApi";

// ============================================================================
// Types
// ============================================================================

/** An anchor cell on some sheet (the sheet travels separately). */
export interface AnchorCell {
  row: number;
  col: number;
}

/** A sheet-pixel point (no scroll offset). */
export interface SheetPoint {
  x: number;
  y: number;
}

/**
 * The address half of every create request the three control seams accept:
 * an anchor cell, a position, or both (see `ControlPlacementRequest` in
 * @api/controlsService). Deliberately loose here — the seams' own union types
 * are what callers see; this module re-checks at runtime, because a request can
 * also arrive from a script broker that no compiler ever saw.
 */
export interface ControlAddress {
  sheetIndex: number;
  row?: number;
  col?: number;
  x?: number;
  y?: number;
}

// ============================================================================
// The allocator
// ============================================================================

/** Columns a sheet has (A..XFD). A column index at or past this is not a cell. */
export const ANCHOR_COLUMN_COUNT = 16384;

/**
 * Pick an anchor cell that none of `occupied` holds.
 *
 * The rule is the one paste/duplicate always used — row 0, one column right of
 * the right-most occupied anchor — because it keeps allocated anchors out of the
 * way of the cells a user is likely to put a control on by hand. When that
 * column would fall off the sheet, the first unoccupied cell in row-major order
 * is used instead; by pigeonhole it exists within `occupied.length + 1` rows.
 */
export function pickFreeAnchorCell(occupied: readonly AnchorCell[]): AnchorCell {
  let maxCol = -1;
  for (const cell of occupied) {
    if (cell.col > maxCol) maxCol = cell.col;
  }
  if (maxCol + 1 < ANCHOR_COLUMN_COUNT) {
    return { row: 0, col: maxCol + 1 };
  }

  const taken = new Set(occupied.map((cell) => `${cell.row}:${cell.col}`));
  for (let row = 0; row <= occupied.length; row++) {
    for (let col = 0; col < ANCHOR_COLUMN_COUNT; col++) {
      if (!taken.has(`${row}:${col}`)) return { row, col };
    }
  }
  // Unreachable: `occupied.length + 1` full rows cannot all be taken by
  // `occupied.length` anchors.
  throw new Error("No free anchor cell could be found on this sheet.");
}

/**
 * The anchors of controls the sheet's LAYOUT still names -- a canvas's
 * `locked` and `zOrder` refs (`control:<row>:<col>`), live or dead
 * (@api/objectSelection `idsNamedByLayout`). [] on a worksheet.
 */
export function anchorsNamedByLayout(sheetIndex: number): AnchorCell[] {
  const out: AnchorCell[] = [];
  for (const id of idsNamedByLayout(sheetIndex, "control")) {
    const m = /^(\d+):(\d+)$/.exec(id);
    if (m) out.push({ row: Number(m[1]), col: Number(m[2]) });
  }
  return out;
}

/**
 * The next free anchor cell on a sheet, read from the backend — which holds
 * EVERY control on the sheet (in-cell buttons included), not just the floating
 * ones the store has loaded.
 *
 * An anchor the sheet's layout still NAMES is not free either, although no
 * control holds it: a canvas keeps a deleted control's lock and paint-order
 * ref (so Ctrl+Z of the delete restores both), and a control's ref IS its
 * anchor. Handing that anchor to a new control -- the newest control's anchor
 * is exactly the one the allocator frees -- made a pasted copy of a deleted,
 * locked shape come back locked and in the dead shape's slot (wave C review).
 *
 * Call it only from inside `withControlAnchor` (or `runControlCreation`): on its
 * own it is a read that a concurrent create can invalidate before the caller
 * writes.
 */
export async function findFreeAnchorCell(sheetIndex: number): Promise<AnchorCell> {
  const controls = await getAllControls(sheetIndex);
  return pickFreeAnchorCell([...controls, ...anchorsNamedByLayout(sheetIndex)]);
}

// ============================================================================
// The creation queue
// ============================================================================

let creationQueue: Promise<void> = Promise.resolve();

/**
 * Run a control-creating task after every task queued before it has settled.
 *
 * FIFO, and a rejected task does not poison the queue: the next task still
 * runs. The task must include the metadata WRITE, not just the anchor choice —
 * serialising only the read would leave the race exactly where it was.
 */
export function runControlCreation<T>(task: () => Promise<T>): Promise<T> {
  const run = creationQueue.then(task);
  creationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ============================================================================
// Placement rules
// ============================================================================

function isNonNegativeFinite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/**
 * The exact position a request asks for, or null when it names none.
 * THROWS for half a position or a coordinate that is not a non-negative finite
 * number: a control placed at NaN is a control nobody can see or click.
 */
export function requestedPosition(address: ControlAddress): SheetPoint | null {
  const { x, y } = address;
  if (x === undefined && y === undefined) return null;
  if (x === undefined || y === undefined) {
    throw new Error(
      "A control's position needs both x and y (sheet pixels); only one was given.",
    );
  }
  if (!isNonNegativeFinite(x) || !isNonNegativeFinite(y)) {
    throw new Error(
      `A control's position must be non-negative, finite sheet pixels; got x=${String(x)}, y=${String(y)}.`,
    );
  }
  return { x, y };
}

/**
 * The anchor a request names, or null when it names none (the provider then
 * allocates one). THROWS for half an anchor or a non-integer cell.
 */
export function requestedAnchor(address: ControlAddress): AnchorCell | null {
  const { row, col } = address;
  if (row === undefined && col === undefined) return null;
  if (row === undefined || col === undefined) {
    throw new Error(
      "A control's anchor needs both row and col; only one was given. Omit both to have one allocated.",
    );
  }
  if (!Number.isSafeInteger(row) || !Number.isSafeInteger(col) || row < 0 || col < 0) {
    throw new Error(
      `A control's anchor must be a non-negative whole row and column; got row=${String(row)}, col=${String(col)}.`,
    );
  }
  return { row, col };
}

/**
 * A size a request NAMES, or null when it names none. THROWS for a zero,
 * negative or non-finite size: a control nobody can see, created by a call
 * that reported success. `what` leads the message ("A button's width").
 */
export function requestedSize(what: string, value: number | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${what} must be a positive number of pixels; got ${String(value)}.`);
  }
  return value;
}

/**
 * Decide where a new control goes and run its creation with that answer, as ONE
 * serialised step.
 *
 *   * The request's own anchor is used when it names one — exactly the old path.
 *   * Otherwise a free anchor is allocated INSIDE the queued step, so the
 *     `create` that writes it is the next thing that happens on the queue.
 *   * `position` is the request's exact x/y, or null — in which case the caller
 *     paints at the anchor cell's walked origin, as it always has.
 *
 * Validation runs before anything is queued, so a malformed request rejects
 * without waiting behind other inserts. A request with neither an anchor nor a
 * position is refused: there is nothing to say where the control goes.
 */
export async function withControlAnchor<T>(
  address: ControlAddress,
  create: (anchor: AnchorCell, position: SheetPoint | null) => Promise<T>,
): Promise<T> {
  const position = requestedPosition(address);
  const named = requestedAnchor(address);
  if (!named && !position) {
    throw new Error(
      "A control needs an anchor cell (row + col) or a position (x + y, sheet pixels); the request gave neither.",
    );
  }
  return runControlCreation(async () => {
    const anchor = named ?? (await findFreeAnchorCell(address.sheetIndex));
    return create(anchor, position);
  });
}
