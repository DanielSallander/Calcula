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
 * Sheet-aware via the ACTIVE sheet, NOT spec.data.sheetIndex: a coordinate chart
 * reads its cells through getViewportCells, which is active-sheet-only (a
 * coordinate range and a same-sheet param ref can't read cross-sheet), so ONLY an
 * active-sheet change can affect it. A change with no `sheetIndex` is assumed
 * active (the historical implicit contract); a change tagged with another sheet is
 * ignored (it can't be in the chart's read-set). Gating on spec.data.sheetIndex
 * would be wrong — the fetch ignores it, so when chart placement and data sheet
 * diverge a real active-sheet edit would be missed (under-invalidation). Pure.
 */
export function chartIntersectsChanges(
  spec: ChartSpec,
  changes: ReadonlyArray<ChangedCell>,
  activeSheetIndex: number,
): boolean {
  if (changes.length === 0) return false;
  if (hasUnboundedDeps(spec)) return true;

  const d = spec.data as DataRangeRef;
  const onActiveSheet = (c: ChangedCell): boolean => (c.sheetIndex ?? activeSheetIndex) === activeSheetIndex;
  for (const c of changes) {
    if (!onActiveSheet(c)) continue;
    if (c.row >= d.startRow && c.row <= d.endRow && c.col >= d.startCol && c.col <= d.endCol) return true;
  }
  // A change to a bound param's cell affects the chart even outside the data bbox.
  for (const p of spec.params ?? []) {
    if (!p.cellRef) continue;
    const t = parseParamCellTarget(p.cellRef);
    if (t && changes.some((c) => onActiveSheet(c) && c.row === t.row && c.col === t.col)) return true;
  }
  return false;
}
