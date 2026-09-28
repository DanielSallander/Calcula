//! FILENAME: app/extensions/Charts/lib/chartSheetRefs.ts
// PURPOSE: Find every coordinate data reference (DataRangeRef) a chart spec
//          carries and stamp the source sheet's stable id onto it.
// CONTEXT: A DataRangeRef names its sheet by `sheetIndex`, which shifts on every
//          sheet insert / delete / move. `sheetId` (the workbook's sheet uuid)
//          does not, and the resolver reads it first (dataSourceResolver.ts).
//          The id is stamped wherever a ref enters the store -- at create, at
//          every persist, and once at load for a chart written before ids
//          existed -- so the index only has to be right at the moment it is
//          written.
//
//          A spec carries refs in FOUR places, and a walk that forgets one is a
//          ref that silently goes on following an index:
//            - `spec.data`                         the chart's own source
//            - `spec.layers[].data`                a layer's own source
//            - `spec.transform[type=lookup].from`  a lookup table
//            - `spec.concat.charts[]`              child specs -- recursively
//
//          A-1 strings ("Sheet1!A1:D10") stay NAME-bound on purpose: converting
//          one to a ref at create time is a separate decision (see the M4 map).
//          Pure: nothing here reads the backend; the caller supplies the
//          index -> id lookup from ONE sheet list.

import type { ChartSpec, DataSource, DataRangeRef, LayerSpec, TransformSpec } from "../types";
import { isDataRangeRef } from "../types";
import { storedSpecOf } from "./chartSpecNormalize";

/** Maps a live sheet index to that sheet's id (undefined when unknown). */
export type SheetIdForIndex = (sheetIndex: number) => string | undefined;

/** Bound on concat nesting, matching the reader's own guard against deep specs. */
const MAX_STAMP_DEPTH = 16;

/** True when `ref` has no usable sheet id yet. */
function isUnstamped(ref: DataRangeRef): boolean {
  return typeof ref.sheetId !== "string" || ref.sheetId === "";
}

/**
 * Stamp one data source. A DataRangeRef without an id gets the id of the sheet
 * its `sheetIndex` names; everything else (a stamped ref, an A1 string, a pivot
 * or design-query source, an index no sheet answers to) comes back as the SAME
 * object, so a caller can detect "nothing changed" by identity.
 */
export function stampDataSource<T extends DataSource | undefined>(source: T, idForIndex: SheetIdForIndex): T {
  if (source === undefined || !isDataRangeRef(source as DataSource)) return source;
  const ref = source as DataRangeRef;
  if (!isUnstamped(ref)) return source;
  const id = idForIndex(ref.sheetIndex);
  if (id === undefined || id === "") return source;
  return { ...ref, sheetId: id } as T;
}

/**
 * Stamp every DataRangeRef in `spec` (the four places above, concat children
 * recursively). Returns the SAME spec object when nothing needed a stamp, and a
 * new spec (copied only along the changed paths) otherwise.
 */
export function stampSpecSheetIds(spec: ChartSpec, idForIndex: SheetIdForIndex, depth = 0): ChartSpec {
  if (!spec || typeof spec !== "object") return spec;
  let changed = false;
  const next: ChartSpec = { ...spec };

  const data = stampDataSource(spec.data, idForIndex);
  if (data !== spec.data) {
    next.data = data;
    changed = true;
  }

  if (Array.isArray(spec.layers)) {
    let layersChanged = false;
    const layers = spec.layers.map((layer: LayerSpec) => {
      if (!layer || typeof layer !== "object" || layer.data === undefined) return layer;
      const ld = stampDataSource(layer.data, idForIndex);
      if (ld === layer.data) return layer;
      layersChanged = true;
      return { ...layer, data: ld };
    });
    if (layersChanged) {
      next.layers = layers;
      changed = true;
    }
  }

  if (Array.isArray(spec.transform)) {
    let transformChanged = false;
    const transform = spec.transform.map((t: TransformSpec) => {
      if (!t || typeof t !== "object" || t.type !== "lookup") return t;
      const from = stampDataSource(t.from, idForIndex);
      if (from === t.from) return t;
      transformChanged = true;
      return { ...t, from };
    });
    if (transformChanged) {
      next.transform = transform;
      changed = true;
    }
  }

  if (spec.concat && Array.isArray(spec.concat.charts) && depth < MAX_STAMP_DEPTH) {
    let childrenChanged = false;
    const charts = spec.concat.charts.map((child) => {
      const stamped = stampSpecSheetIds(child, idForIndex, depth + 1);
      if (stamped !== child) childrenChanged = true;
      return stamped;
    });
    if (childrenChanged) {
      next.concat = { ...spec.concat, charts };
      changed = true;
    }
  }

  return changed ? next : spec;
}

/**
 * Stamp the sheet ids onto a chart record AS THE BACKEND STORES IT (the entry's
 * `specJson`), not onto the definition the store normalized from it.
 *
 * WHY THE STORED TEXT. The load-time stamp is recorded by the backend as a
 * STAMP -- clean, no undo step -- only after it has verified that the new JSON
 * differs from the stored JSON by added `sheetId`s and nothing else
 * (chart_commands.rs, `count_sheet_id_stamps`). The normalized definition
 * differs in far more: a bare spec comes back wrapped in a ChartDefinition, and
 * missing axes, legend and palette come back filled in. So the stamp is applied
 * to the stored record itself, through the same walk as every other stamp.
 *
 * Returns the stamped JSON, or null when nothing needed a stamp or the record
 * is not a JSON object with a spec.
 */
export function stampStoredChartJson(specJson: string, idForIndex: SheetIdForIndex): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(specJson);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const { spec, bare } = storedSpecOf(record);
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) return null;
  const stamped = stampSpecSheetIds(spec as ChartSpec, idForIndex);
  if (stamped === spec) return null;
  return JSON.stringify(bare ? stamped : { ...record, spec: stamped });
}

/**
 * Whether any DataRangeRef in `spec` still lacks a sheet id -- the cheap,
 * synchronous question a persist path asks before it spends a sheet-list read.
 */
export function specHasUnstampedRangeRef(spec: ChartSpec, depth = 0): boolean {
  if (!spec || typeof spec !== "object") return false;
  const unstamped = (s: DataSource | undefined): boolean =>
    s !== undefined && isDataRangeRef(s) && isUnstamped(s);
  if (unstamped(spec.data)) return true;
  if (Array.isArray(spec.layers) && spec.layers.some((l) => !!l && unstamped(l.data))) return true;
  if (
    Array.isArray(spec.transform) &&
    spec.transform.some((t) => !!t && t.type === "lookup" && unstamped(t.from))
  ) {
    return true;
  }
  if (spec.concat && Array.isArray(spec.concat.charts) && depth < MAX_STAMP_DEPTH) {
    return spec.concat.charts.some((c) => specHasUnstampedRangeRef(c, depth + 1));
  }
  return false;
}
