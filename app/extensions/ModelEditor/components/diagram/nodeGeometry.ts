// FILENAME: app/extensions/ModelEditor/components/diagram/nodeGeometry.ts
// PURPOSE: Shared node geometry for the relationship diagram (kept out of the
//          component files so Fast Refresh only sees component exports there).
//          Node WIDTH is dynamic: each table is sized so its header and every
//          column (name + data type) fit without clipping, clamped to a range.
//          Width is estimated (no DOM measure) so it works inside the pure
//          layout engine; the estimate is deliberately a touch generous so names
//          are never clipped, and the same estimate drives label truncation.

import type { ModelColumnInfo, ModelTableInfo } from "@api";

export const HEADER_HEIGHT = 28;
export const ROW_HEIGHT = 20;
const PADDING = 8;

/** A positioned node rectangle in the diagram (layout coordinates). */
export interface NodePos {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Which face of a node an edge connects to. */
export type EdgeSide = "left" | "right" | "top" | "bottom";

/** Which faces an edge leaves/enters, from the nodes' relative centers. The
 *  single source of truth for both routing and per-face fan-out grouping. */
export function edgeSides(
  from: NodePos,
  to: NodePos,
): { isHorizontal: boolean; fromSide: EdgeSide; toSide: EdgeSide } {
  const fromCx = from.x + from.width / 2;
  const fromCy = from.y + from.height / 2;
  const toCx = to.x + to.width / 2;
  const toCy = to.y + to.height / 2;
  if (Math.abs(fromCx - toCx) > Math.abs(fromCy - toCy)) {
    const left = fromCx < toCx;
    return {
      isHorizontal: true,
      fromSide: left ? "right" : "left",
      toSide: left ? "left" : "right",
    };
  }
  const up = fromCy < toCy;
  return { isHorizontal: false, fromSide: up ? "bottom" : "top", toSide: up ? "top" : "bottom" };
}

export const MIN_NODE_WIDTH = 180;
export const MAX_NODE_WIDTH = 460;
/** Back-compat alias — the minimum node width. */
export const NODE_WIDTH = MIN_NODE_WIDTH;

const PAD_L = 10; // left text inset
const PAD_R = 10; // right text inset
const COL_GAP = 14; // gap between a column's name and its data type
const IM_BADGE_W = 30; // right-side space reserved for the "IM" storage badge
const FN_GLYPH_W = 16; // right-side space reserved for the calculated-column ƒ glyph

type TextKind = "normal" | "bold" | "mono";

/** Rough text width as (chars × fontSize × per-kind advance factor). */
export function estTextWidth(text: string, fontSize: number, kind: TextKind = "normal"): number {
  const factor = kind === "bold" ? 0.64 : 0.6;
  return text.length * fontSize * factor;
}

export function getNodeHeight(table: ModelTableInfo): number {
  return HEADER_HEIGHT + Math.max(table.columns.length, 1) * ROW_HEIGHT + PADDING;
}

/** Width sized to fit the header and the widest column, clamped to the range. */
export function getNodeWidth(table: ModelTableInfo): number {
  const isInMemory = table.storageMode === "InMemory";
  let req = PAD_L + estTextWidth(table.name, 12, "bold") + (isInMemory ? IM_BADGE_W : PAD_R);
  for (const c of table.columns) {
    const w =
      PAD_L +
      estTextWidth(c.name, 11) +
      COL_GAP +
      estTextWidth(c.dataType, 9, "mono") +
      PAD_R +
      (c.isCalculated ? FN_GLYPH_W : 0);
    if (w > req) req = w;
  }
  return Math.min(MAX_NODE_WIDTH, Math.max(MIN_NODE_WIDTH, Math.ceil(req)));
}

/** Truncate with a trailing ".." so `text` fits within `maxPx` at `fontSize`. */
export function fitLabel(
  text: string,
  fontSize: number,
  maxPx: number,
  kind: TextKind = "normal",
): string {
  if (estTextWidth(text, fontSize, kind) <= maxPx) return text;
  let s = text;
  while (s.length > 1 && estTextWidth(`${s}..`, fontSize, kind) > maxPx) s = s.slice(0, -1);
  return s.length > 1 ? `${s}..` : text.slice(0, 1);
}

/** Header title fitted to the node width (reserves room for the IM badge). */
export function headerLabel(table: ModelTableInfo, width: number): string {
  const reservedRight = table.storageMode === "InMemory" ? IM_BADGE_W : PAD_R;
  return fitLabel(table.name, 12, width - PAD_L - reservedRight, "bold");
}

/** Column name fitted to the node width (reserves room for type + ƒ glyph). */
export function columnLabel(col: ModelColumnInfo, width: number): string {
  const reservedRight =
    COL_GAP + estTextWidth(col.dataType, 9, "mono") + PAD_R + (col.isCalculated ? FN_GLYPH_W : 0);
  return fitLabel(col.name, 11, width - PAD_L - reservedRight);
}
