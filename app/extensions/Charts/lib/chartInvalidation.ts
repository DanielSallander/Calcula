//! FILENAME: app/extensions/Charts/lib/chartInvalidation.ts
// PURPOSE: Decide whether a chart's read-set intersects a set of changed cells
//          (C5 S7d scoped invalidation). Conservative SUPERSET: any chart whose
//          dependency set can't be cheaply bounded (non-coord data range, lookup
//          transform, or a =cell-ref title/axis/series) always intersects, so a
//          chart is never wrongly skipped — only safely skipped when provably
//          clear. Over-invalidation is always safe; under-invalidation is not.

import type { ChartSpec, DataRangeRef } from "../types";
import { isDataRangeRef } from "../types";
import { parseParamCellTarget } from "./dataSourceResolver";

export interface ChangedCell {
  row: number;
  col: number;
  /**
   * Sheet the change occurred on. Absent means "the active sheet" — resolved by
   * the caller via `activeSheetIndex`. Set for cross-sheet edits so a change on
   * another sheet doesn't wrongly match a chart whose data lives on this one.
   */
  sheetIndex?: number;
}

/** True when the chart depends on cells we cannot cheaply bound -> always invalidate. */
function hasUnboundedDeps(spec: ChartSpec): boolean {
  // A concat container renders from its CHILDREN's own data ranges (read in the
  // reader), not spec.data — its read-set is the union of the children's, which
  // this bbox model doesn't capture, so always invalidate. (facet/repeat read the
  // parent spec.data grid, so they ARE covered by the bbox below.)
  if (spec.concat && spec.concat.charts.length > 0) return true;
  // Only a coordinate DataRangeRef gives a cheap sync bbox; an A1 string / named
  // range / pivot source does not.
  if (!isDataRangeRef(spec.data)) return true;
  // A lookup transform reads a secondary range outside the chart's data.
  if (spec.transform?.some((t) => t.type === "lookup")) return true;
  // A cell-reference (=A1) in a string field is read by resolveSpecReferences.
  const isRef = (v: string | null | undefined): boolean => typeof v === "string" && v.startsWith("=");
  if (isRef(spec.title) || isRef(spec.xAxis?.title) || isRef(spec.yAxis?.title)) return true;
  if (spec.series?.some((s) => isRef(s.name))) return true;
  return false;
}

/**
 * Whether any changed cell falls in the chart's read-set: its data-range bbox
 * (coordinates only) or a bound param's cell. Unbounded-dependency charts return
 * true (conservative).
 *
 * TWO SHEETS, TWO RULES.
 *
 *   - The DATA range is read from the chart's SOURCE sheet
 *     (`sourceSheetIndex`: the data ref's sheet id mapped to the live index, or
 *     its `sheetIndex` when it has no id — see
 *     `dataSourceResolver.peekRangeRefSheetIndex`). The reader reads exactly
 *     that sheet (`getRangeCellsTyped(..., sheetIndex)`), so exactly a change ON
 *     that sheet can affect it: a change tagged `sheetIndex: s` intersects when
 *     `s === sourceSheetIndex` and the cell is in the bbox, and an UNTAGGED
 *     change means the active sheet (the historical implicit contract), so it
 *     intersects only while the source sheet is the active one. This is what
 *     lets a chart on a CANVAS repaint when its data sheet is edited — and why
 *     keying on the active sheet, as this used to, left it frozen.
 *     `sourceSheetIndex === null` means "not known right now" (a cold id cache,
 *     or a source sheet that has just been deleted): the answer is then true,
 *     because a skipped invalidation is the one mistake this function must
 *     never make.
 *   - A PARAM cell is read from the sheet the chart reads (`locateParamCell`:
 *     the chart's own sheet, or on a canvas its data sheet), named by
 *     `paramSheetIndex` ({@link paramCellSheetIndex} computes it): a change
 *     counts when it is on that sheet. `null` means "not known right now" (a
 *     cold sheet cache) and counts a change on ANY sheet -- conservative.
 *     Omitted, it is the ACTIVE sheet (the historical rule, for a caller that
 *     has no placed chart).
 *
 * Pure.
 */
export function chartIntersectsChanges(
  spec: ChartSpec,
  changes: ReadonlyArray<ChangedCell>,
  activeSheetIndex: number,
  sourceSheetIndex: number | null,
  paramSheetIndex?: number | null,
): boolean {
  if (changes.length === 0) return false;
  if (hasUnboundedDeps(spec)) return true;
  if (sourceSheetIndex === null) return true;

  const d = spec.data as DataRangeRef;
  const sheetOf = (c: ChangedCell): number => c.sheetIndex ?? activeSheetIndex;
  for (const c of changes) {
    if (sheetOf(c) !== sourceSheetIndex) continue;
    if (c.row >= d.startRow && c.row <= d.endRow && c.col >= d.startCol && c.col <= d.endCol) return true;
  }
  // A change to a bound param's cell affects the chart even outside the data bbox.
  const paramSheet = paramSheetIndex === undefined ? activeSheetIndex : paramSheetIndex;
  const onParamSheet = (c: ChangedCell): boolean => paramSheet === null || sheetOf(c) === paramSheet;
  for (const p of spec.params ?? []) {
    if (!p.cellRef) continue;
    const t = parseParamCellTarget(p.cellRef);
    if (t && changes.some((c) => onParamSheet(c) && c.row === t.row && c.col === t.col)) return true;
  }
  return false;
}

/**
 * The sheet a placed chart's unqualified param cell is on -- the SYNCHRONOUS
 * mirror of `locateParamCell` (dataSourceResolver.ts), for the cell-change
 * listener, which cannot await:
 *   - host on a worksheet: the host;
 *   - host on a canvas: the data's sheet (`sourceSheetIndex`), or -1 when the
 *     data has no sheet (no param cell anywhere: no change can hit it);
 *   - host kind not known (`hostIsCanvas` null: a cold sheet cache), or a
 *     canvas whose data sheet is not known right now: null (conservative).
 * Pure.
 */
export function paramCellSheetIndex(
  hostSheetIndex: number,
  hostIsCanvas: boolean | null,
  sourceSheetIndex: number | null,
  dataHasSheet: boolean,
): number | null {
  if (hostIsCanvas === null) return null;
  if (!hostIsCanvas) return hostSheetIndex;
  if (!dataHasSheet) return -1;
  return sourceSheetIndex;
}
