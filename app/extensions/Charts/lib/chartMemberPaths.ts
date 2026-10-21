//! FILENAME: app/extensions/Charts/lib/chartMemberPaths.ts
// PURPOSE: WHO each datum of a model chart is: the member-KEY paths of its
//          categories and series (ParsedChartData.categoryMembers /
//          seriesMembers), and the three things P4's cross-filter does with
//          them -- align a highlight result by key, mark the chart's own
//          selected datums, and say whether a held selection tuple still names
//          a datum.
// CONTEXT: P4 (G4), S5. A datum's identity used to be its label: " > "-joined
//          row headers in the app locale. A label is display text: it changes
//          with the locale, two members can share one ("(Blank)" vs ""), and a
//          two-field category cannot be split back. The pivot view now carries
//          `groupMembers` (fieldIndex -> "Table.Column" and valueId -> KEY, from
//          the ONE key function behind `PivotCellData.member`), and every value
//          cell carries its `groupPath` of [fieldIndex, valueId] pairs: rows'
//          fields first, then columns'. This file turns the two into paths.
//
//          FAIL CLOSED. A path that cannot be resolved completely is not
//          guessed: the whole list is left absent, and the chart is simply not
//          a cross-filter source this read (a click does nothing). A partial
//          list would let a click filter on ANOTHER datum's member.
//
//          Pure: no store, no backend.

import type { PivotViewResponse, PivotRowData, PivotColumnData, PivotCellData } from "@api/pivot";
import type { MemberCoord, MemberPath } from "@api/reportFilters";
import type { ParsedChartData } from "../types";

/** The member paths of the categories and series a reader charted. */
export interface ChartMemberPaths {
  categoryMembers: MemberPath[];
  seriesMembers: MemberPath[];
}

interface FieldMembers {
  fieldKey: string;
  keys: Map<number, string>;
}

function hasPath(cell: PivotCellData | undefined): cell is PivotCellData & { groupPath: Array<[number, number]> } {
  return !!cell && Array.isArray(cell.groupPath) && cell.groupPath.length > 0;
}

/**
 * The member paths of the rows and value columns a reader charted, or null
 * when the view cannot say (no `groupMembers`, or some coordinate of some
 * charted datum has no key). `rows` and `dataColumns` must be exactly the ones
 * the reader turned into categories and series, in that order.
 *
 * A category's path is read from its row's value cells' `groupPath`, keeping
 * the ROW fields' entries; a value-free row falls back to its deepest row
 * header. A series' path is read from its column's value cells, keeping the
 * COLUMN fields' entries; a column with no value cell falls back to its column
 * header. A grand-total row or column has the empty path (no field narrows it).
 */
export function memberPathsOfView(
  view: PivotViewResponse,
  rows: readonly PivotRowData[],
  dataColumns: readonly PivotColumnData[],
): ChartMemberPaths | null {
  if (!Array.isArray(view.groupMembers)) return null;
  const fields = new Map<number, FieldMembers>();
  for (const g of view.groupMembers) {
    fields.set(g.fieldIndex, { fieldKey: g.fieldKey, keys: new Map(g.members.map(([id, key]) => [id, key])) });
  }
  const rowFields = new Set((view.rowFieldSummaries ?? []).map((f) => f.fieldIndex));
  const colFields = new Set((view.columnFieldSummaries ?? []).map((f) => f.fieldIndex));

  /** The coordinates of `groupPath` on `axis`'s fields, or null when one has no key. */
  const pathOf = (groupPath: ReadonlyArray<[number, number]>, axis: Set<number>): MemberCoord[] | null => {
    const out: MemberCoord[] = [];
    for (const [fieldIndex, valueId] of groupPath) {
      if (!axis.has(fieldIndex)) continue;
      const field = fields.get(fieldIndex);
      const key = field?.keys.get(valueId);
      if (!field || key === undefined) return null;
      out.push({ field: field.fieldKey, key });
    }
    return out;
  };

  const categoryMembers: MemberPath[] = [];
  for (const row of rows) {
    let source: ReadonlyArray<[number, number]> | null = null;
    for (const col of dataColumns) {
      const cell = row.cells[col.viewCol];
      if (hasPath(cell)) {
        source = cell.groupPath;
        break;
      }
    }
    if (!source) {
      for (let c = Math.min(view.rowLabelColCount, row.cells.length) - 1; c >= 0; c--) {
        const cell = row.cells[c];
        if (hasPath(cell)) {
          source = cell.groupPath;
          break;
        }
      }
    }
    const path = pathOf(source ?? [], rowFields);
    if (!path) return null;
    // A data row of a query with row fields always sits under some member: an
    // empty path there means the view did not say which, not "every member".
    if (row.rowType === "Data" && rowFields.size > 0 && path.length === 0) return null;
    categoryMembers.push(path);
  }

  const headerRows = view.rows.filter((r) => r.rowType === "ColumnHeader");
  const seriesMembers: MemberPath[] = [];
  for (const col of dataColumns) {
    let source: ReadonlyArray<[number, number]> | null = null;
    for (const row of rows) {
      const cell = row.cells[col.viewCol];
      if (hasPath(cell)) {
        source = cell.groupPath;
        break;
      }
    }
    if (!source) {
      for (let h = headerRows.length - 1; h >= 0; h--) {
        const cell = headerRows[h].cells[col.viewCol];
        if (hasPath(cell)) {
          source = cell.groupPath;
          break;
        }
      }
    }
    const path = pathOf(source ?? [], colFields);
    if (!path) return null;
    if (col.colType === "Data" && colFields.size > 0 && path.length === 0) return null;
    seriesMembers.push(path);
  }

  return { categoryMembers, seriesMembers };
}

/** A path as one comparable string (field and key, in order). */
export function memberPathKey(path: MemberPath): string {
  return JSON.stringify(path.map((c) => [c.field, c.key]));
}

/**
 * One identity per entry: the path's key plus its ORDINAL among equal paths.
 * Two series under one column member (two measures) share a path; the n-th
 * one of a result is the n-th one of another result of the same request.
 */
function identities(paths: readonly MemberPath[]): string[] {
  const seen = new Map<string, number>();
  return paths.map((p) => {
    const k = memberPathKey(p);
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return `${k}#${n}`;
  });
}

/**
 * `highlight`'s values laid onto `base`'s datums BY MEMBER KEY:
 * `[seriesIndex][categoryIndex]` of `base`. A datum the highlighted result
 * does not have (its member has no rows under the highlight) reads 0 -- never
 * the value at the same index, which belongs to some other member once the
 * highlight narrowed or reordered the categories. Null when either side has
 * no member paths: no highlight is better than a misaligned one.
 */
export function alignHighlightValues(base: ParsedChartData, highlight: ParsedChartData): number[][] | null {
  if (!base.categoryMembers || !base.seriesMembers || !highlight.categoryMembers || !highlight.seriesMembers) return null;
  if (base.categoryMembers.length !== base.categories.length || base.seriesMembers.length !== base.series.length) return null;
  const hiCategory = new Map(identities(highlight.categoryMembers).map((k, i) => [k, i]));
  const hiSeries = new Map(identities(highlight.seriesMembers).map((k, i) => [k, i]));
  const baseCategory = identities(base.categoryMembers);
  const baseSeries = identities(base.seriesMembers);
  return base.series.map((_, si) => {
    const hs = hiSeries.get(baseSeries[si]);
    return base.categories.map((_, ci) => {
      const hc = hiCategory.get(baseCategory[ci]);
      if (hs === undefined || hc === undefined) return 0;
      const v = highlight.series[hs]?.values[hc];
      return typeof v === "number" && Number.isFinite(v) ? v : 0;
    });
  });
}

/**
 * Whether `path` names the datum `tuple` selects: every one of the
 * selection's `fields` is on the path with the tuple's key. A field the path
 * does not carry never matches (the datum does not say, so it is not chosen).
 */
export function pathMatchesTuple(path: MemberPath, fields: readonly string[], tuple: readonly string[]): boolean {
  for (let i = 0; i < fields.length; i++) {
    const coord = path.find((c) => c.field === fields[i]);
    if (!coord || coord.key !== tuple[i]) return false;
  }
  return true;
}

/** The full path of datum (si, ci): its category's coordinates, then its series'. */
function datumPath(data: ParsedChartData, si: number, ci: number): MemberPath {
  return [...(data.categoryMembers?.[ci] ?? []), ...(data.seriesMembers?.[si] ?? [])];
}

/**
 * Whether a held selection tuple still names some datum of `data` (its member
 * did not vanish). False for every tuple when the data has no member paths.
 */
export function tupleIsLive(data: ParsedChartData, fields: readonly string[], tuple: readonly string[]): boolean {
  if (!data.categoryMembers || !data.seriesMembers) return false;
  for (let si = 0; si < data.series.length; si++) {
    for (let ci = 0; ci < data.categories.length; ci++) {
      if (pathMatchesTuple(datumPath(data, si, ci), fields, tuple)) return true;
    }
  }
  return false;
}

/**
 * The chart's OWN selected datums (ParsedChartData.crossFilterSelf), or
 * undefined when the data has no member paths or nothing is selected.
 */
export function crossFilterSelfOf(
  data: ParsedChartData,
  selection: { fields: readonly string[]; tuples: readonly (readonly string[])[] },
): ParsedChartData["crossFilterSelf"] {
  if (!data.categoryMembers || !data.seriesMembers || selection.tuples.length === 0) return undefined;
  const datums = data.series.map((_, si) =>
    data.categories.map((_, ci) => {
      const path = datumPath(data, si, ci);
      return selection.tuples.some((t) => pathMatchesTuple(path, selection.fields, t));
    }),
  );
  const categories = data.categories.map((_, ci) => datums.some((row) => row[ci] === true));
  const hasSeriesMembers = data.seriesMembers.some((p) => p.length > 0);
  return {
    categories,
    ...(hasSeriesMembers ? { series: datums.map((row) => row.some(Boolean)) } : {}),
    datums,
  };
}
