//! FILENAME: app/src/core/lib/pasteTiling.ts
// PURPOSE: Excel's rule for how many times a copied block is pasted into the
//          selection: TILED when the selection is an exact multiple of it.
// CONTEXT: Live Excel 16 [2026-10-30, fresh instances over COM,
//          clip5/probe-tile.ps1, probe-f.ps1 and probe-insert-tile.ps1 in the
//          fix programme's scratchpad]:
//            - F6 copied, H1:H3 selected, Paste -> f6 in H1, H2 and H3; into
//              H1:J2 -> six times;
//            - F1:F2 into H1:H4 -> f1,f2,f1,f2; F1:G2 into H1:K4 -> a 2x2 of
//              the block; F1:G1 into H1:K1 -> twice side by side;
//            - F1:F2 into H1:H3 (3 is no multiple of 2) -> pasted ONCE, and the
//              selection shrinks to H1:H2; F1:G2 into H1:J4 (rows a multiple,
//              columns not) -> ONCE; F1:F2 into H1:I4 (both a multiple) -> 2x2;
//            - a copied formula moves its relative references PER TILE (B1
//              =A1*2 into D1:D3 -> =C1*2, =C2*2, =C3*2); Paste Values tiles too;
//            - a selection that holds a MERGED cell -> pasted ONCE;
//            - a CUT pasted into a larger selection is refused, never tiled;
//            - Insert Copied Cells sizes its room the same way (F6 copied, F2:F3
//              selected -> two f6 inserted; rows 6:7 copied, rows 2:5 selected
//              -> the pair inserted twice; rows 2:4 -> once).
//          ONE rule, here, so plain Paste, Paste Special and Insert Copied
//          Cells cannot drift apart (exported through @api/lib).

import { MAX_CLIPBOARD_CELLS } from "./clipboardVisibility";

/** How many copies of the pasted block go down and across. `{ rows: 1, cols: 1 }` pastes it once. */
export interface PasteTiles {
  rows: number;
  cols: number;
}

/** The rectangle a paste is aimed at (any corner order). */
export interface PasteTilingSelection {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** Pasted once. */
export const PASTE_ONCE: PasteTiles = Object.freeze({ rows: 1, cols: 1 }) as PasteTiles;

/**
 * Excel's tiling rule: the pasted block (`blockHeight` x `blockWidth`, already
 * transposed when the paste transposes) is repeated over `selection` when the
 * selection's height AND width are each an exact multiple of the block's and
 * the selection is larger than the block; otherwise it is pasted once.
 * `holdsMergedCells` (a merged cell anywhere in the selection) pastes once, as
 * Excel does. A tiled paste over more than `maxCells` cells pastes once rather
 * than build a write that size (the clipboard's own capture cap).
 */
export function pasteTiles(
  blockHeight: number,
  blockWidth: number,
  selection: PasteTilingSelection | null | undefined,
  holdsMergedCells = false,
  maxCells: number = MAX_CLIPBOARD_CELLS,
): PasteTiles {
  if (!selection || holdsMergedCells) return PASTE_ONCE;
  if (!(blockHeight > 0) || !(blockWidth > 0)) return PASTE_ONCE;
  const height = Math.abs(selection.endRow - selection.startRow) + 1;
  const width = Math.abs(selection.endCol - selection.startCol) + 1;
  if (height % blockHeight !== 0 || width % blockWidth !== 0) return PASTE_ONCE;
  const rows = height / blockHeight;
  const cols = width / blockWidth;
  if (rows === 1 && cols === 1) return PASTE_ONCE;
  if (height * width > maxCells) return PASTE_ONCE;
  return { rows, cols };
}

/** Whether a paste over `selection` could tile at all -- the question to ask before reading its merges. */
export function pasteMayTile(
  blockHeight: number,
  blockWidth: number,
  selection: PasteTilingSelection | null | undefined,
): boolean {
  const tiles = pasteTiles(blockHeight, blockWidth, selection);
  return tiles.rows > 1 || tiles.cols > 1;
}
