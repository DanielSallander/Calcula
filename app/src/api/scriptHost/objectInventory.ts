//! FILENAME: app/src/api/scriptHost/objectInventory.ts
// PURPOSE: The workbook-object KINDS a script may enumerate/create/delete, and
//          the pure store-row -> safe-descriptor mappers behind api.listObjects
//          (B3: object creation, enumeration and cross-instance access).
// CONTEXT: Pure — no state reads, no host imports — so the broker executors,
//          the argument validators and the tests all agree on ONE vocabulary.
//          A descriptor carries the STABLE ID a script needs to address the
//          object again (api.chart(id).updateSpec(...), api.deleteTable(id))
//          plus non-sensitive identity. It NEVER carries a spec body, a data
//          payload, a connection string or a credential — enumeration answers
//          "what is in this workbook", not "what is inside this object".

/** Every object kind api.listObjects can enumerate. */
export type ScriptObjectKind =
  | "chart"
  | "table"
  | "pivot"
  | "namedRange"
  | "slicer"
  | "shape";

/** The same set as a runtime guard (validators + host both consult it). */
export const SCRIPT_OBJECT_KINDS: ReadonlySet<string> = new Set<ScriptObjectKind>([
  "chart",
  "table",
  "pivot",
  "namedRange",
  "slicer",
  "shape",
]);

/**
 * One enumerated workbook object.
 *
 * `id` is the handle every other B3 method takes: `api.chart(id)`,
 * `api.deleteTable(id)`, `api.object("pivot", id)`. It is stable across a
 * session (an EntityId for charts/tables/pivots/slicers, the NAME for a named
 * range, the anchor-derived control id for a shape).
 */
export interface ScriptObjectRef {
  kind: ScriptObjectKind;
  /** Stable handle — pass this back to address the object. */
  id: string;
  /** Display name ("" when the object has none). */
  name: string;
  /** Sheet the object lives on; null for a workbook-scoped object. */
  sheetIndex: number | null;
  /** A1 address the object occupies / refers to, when it has one. */
  range?: string;
  /** Pivot: the source data range it aggregates. */
  sourceRange?: string;
  /** Named range: the formula it refers to. */
  refersTo?: string;
  /** Chart: its mark ("bar", "line", ...). Shape: its control type. */
  kindDetail?: string;
  /** Slicer: the field it filters on. */
  fieldName?: string;
  /** Table: data-row count. */
  rowCount?: number;
  /** Table: column count. */
  columnCount?: number;
}

// ============================================================================
// A1 helpers
// ============================================================================

/** 0-based column index to A1 letters (0 -> "A", 26 -> "AA"). */
export function colLetters(col: number): string {
  let n = Math.max(0, Math.floor(col)) + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** A 0-based rectangle as an A1 range ("A1:C10"); a 1x1 rect collapses to "A1". */
export function a1Rect(startRow: number, startCol: number, endRow: number, endCol: number): string {
  const first = `${colLetters(startCol)}${startRow + 1}`;
  if (startRow === endRow && startCol === endCol) return first;
  return `${first}:${colLetters(endCol)}${endRow + 1}`;
}

// ============================================================================
// Row shapes (the minimum each source must hand the mapper)
// ============================================================================

/** A chart row as the Charts extension stores it (spec kept as opaque JSON). */
export interface ChartRow {
  chartId: string;
  name: string;
  sheetIndex: number;
  /** The stored ChartDefinition JSON ({ chartId, name, spec, ... }). */
  specJson: string;
}

/** A table row (a strict subset of @api/backend Table). */
export interface TableRow {
  id: string;
  name: string;
  sheetIndex: number;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  columns: unknown[];
  styleOptions?: { headerRow?: boolean; totalRow?: boolean };
}

/** A pivot row (a strict subset of @api/pivot PivotTableInfo). */
export interface PivotRow {
  id: string;
  name: string;
  sourceRange: string;
  destination: string;
}

/** A named-range row (a strict subset of the core NamedRange). */
export interface NamedRangeRow {
  name: string;
  sheetIndex: number | null;
  refersTo: string;
}

/** A slicer row (a strict subset of the Slicer extension's Slicer). */
export interface SlicerRow {
  id: string;
  name: string;
  sheetIndex: number;
  fieldName: string;
  sourceType: string;
}

/** A shape/form-control row (the Controls extension's ControlEntry). */
export interface ShapeRow {
  sheetIndex: number;
  row: number;
  col: number;
  controlType: string;
  name?: string;
}

// ============================================================================
// Mappers (pure)
// ============================================================================

/** Read a string property off a possibly-absent JSON object. */
function str(o: unknown, key: string): string | undefined {
  if (typeof o !== "object" || o === null) return undefined;
  const v = (o as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Chart -> descriptor. The stored definition is OPAQUE JSON (the ChartSpec
 * schema lives in the Charts extension), so mark/data are read defensively and
 * an unparseable spec degrades to the id + name instead of failing the whole
 * enumeration. Mirrors the Rust `format_chart_inventory` fields exactly, so the
 * script view and the AI view of a workbook can never drift.
 */
export function chartToRef(row: ChartRow): ScriptObjectRef {
  let def: unknown = null;
  try {
    def = JSON.parse(row.specJson);
  } catch {
    def = null;
  }
  const spec = typeof def === "object" && def !== null ? (def as Record<string, unknown>).spec : null;
  const dataValue = typeof spec === "object" && spec !== null ? (spec as Record<string, unknown>).data : undefined;
  const ref: ScriptObjectRef = {
    kind: "chart",
    id: row.chartId,
    name: row.name || str(def, "name") || "",
    sheetIndex: row.sheetIndex,
  };
  const mark = str(spec, "mark");
  if (mark) ref.kindDetail = mark;
  // `data` is a range string OR a structured DataRangeRef; only the string form
  // is an address a script can act on, so the object form is not flattened into
  // a fake address.
  if (typeof dataValue === "string") ref.range = dataValue;
  return ref;
}

/** Table -> descriptor. `rowCount` is DATA rows (the header row is excluded
 *  when the table has one), matching what table scripts see. */
export function tableToRef(row: TableRow): ScriptObjectRef {
  const hasHeader = row.styleOptions?.headerRow !== false;
  const span = row.endRow - row.startRow + 1;
  return {
    kind: "table",
    id: row.id,
    name: row.name || "",
    sheetIndex: row.sheetIndex,
    range: a1Rect(row.startRow, row.startCol, row.endRow, row.endCol),
    rowCount: Math.max(0, span - (hasHeader ? 1 : 0)),
    columnCount: row.columns.length,
  };
}

/** Pivot -> descriptor. A pivot's sheet is encoded in its destination address
 *  ("Sheet2!F1"), which the backend owns, so sheetIndex stays null. */
export function pivotToRef(row: PivotRow): ScriptObjectRef {
  return {
    kind: "pivot",
    id: row.id,
    name: row.name || "",
    sheetIndex: null,
    range: row.destination,
    sourceRange: row.sourceRange,
  };
}

/** Named range -> descriptor. The NAME is the id (that is how every named-range
 *  command addresses it); a workbook-scoped name reports sheetIndex null. */
export function namedRangeToRef(row: NamedRangeRow): ScriptObjectRef {
  return {
    kind: "namedRange",
    id: row.name,
    name: row.name,
    sheetIndex: row.sheetIndex,
    refersTo: row.refersTo,
  };
}

/** Slicer -> descriptor. */
export function slicerToRef(row: SlicerRow): ScriptObjectRef {
  return {
    kind: "slicer",
    id: row.id,
    name: row.name || "",
    sheetIndex: row.sheetIndex,
    fieldName: row.fieldName,
    kindDetail: row.sourceType,
  };
}

/**
 * Form control -> descriptor. Controls have no id of their own: they are
 * ANCHORED to a cell, and the script host's shape instanceId is derived from
 * that anchor ("control-{sheet}-{row}-{col}"). Building the same id here is
 * what makes `api.object("shape", ref.id, ...)` reach the very instance a shape
 * script is pinned to.
 */
export function shapeToRef(row: ShapeRow): ScriptObjectRef {
  return {
    kind: "shape",
    id: controlInstanceId(row.sheetIndex, row.row, row.col),
    name: row.name || "",
    sheetIndex: row.sheetIndex,
    range: a1Rect(row.row, row.col, row.row, row.col),
    kindDetail: row.controlType,
  };
}

/** The shape/button script instanceId for a cell-anchored control. */
export function controlInstanceId(sheetIndex: number, row: number, col: number): string {
  return `control-${sheetIndex}-${row}-${col}`;
}
