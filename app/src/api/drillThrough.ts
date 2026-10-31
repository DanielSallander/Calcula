//! FILENAME: app/src/api/drillThrough.ts
// PURPOSE: The ONE TypeScript shape of a model visual's DRILL-THROUGH
//          definition -- what a design-query chart (`ChartSpec.drillThrough`)
//          and a BI pivot (`DrillThroughBehavior.designQuery`) store, and what
//          the shared runner (`extensions/_shared/drillThrough`) runs -- plus
//          the TS mirrors of the Rust `drill_through` command's request and
//          response (app/src-tauri/src/drill_through.rs).
// CONTEXT: docs/design/model-drillthrough.md. A definition is a design-query
//          DSL text plus the PRESENTATION its result takes (a table of static
//          cells or a chart of some mark). It stores NO connection id: the run
//          takes the connection from the source object (2.2), because a
//          subscriber's connections are re-minted on every open and a stored
//          id would die with the publisher's session. The clicked datum is
//          identified by member KEYS, never labels (2.3); labels ride beside
//          the keys for captions and titles only.
//
//          Owned by the API facade so that neither family imports the other:
//          `pivotTypes.ts` and Charts' `types.ts` both import THIS file, and
//          `_shared/drillThrough` reads the same shape. Seams point one way:
//          nothing here imports app/extensions.

import type { PivotNotice } from "./pivotTypes";
import { sheetNamesEqual } from "./sheetNames";

// ============================================================================
// The definition
// ============================================================================

/**
 * How a drill-through's result is shown. Mirrors Rust `DrillPresentation`
 * (`#[serde(tag = "kind", rename_all = "camelCase")]`).
 *
 *   - `table`: a WORKSHEET of static cells (caption rows, then the view).
 *   - `chart`: a CANVAS holding one design-query chart of `mark`, with the
 *     mark's options exactly as a ChartSpec carries them (`markOptions`).
 *     `mark` names a registered chart mark, and the run creates the chart
 *     through the Charts store seam, which refuses what a ChartSpec does not
 *     accept (its mark-id pattern, the mark's own options) BEFORE any sheet is
 *     added. The editor DERIVES its list from `@api/chartMarks` and offers
 *     only the marks that seam accepts, never a hand-written list.
 */
export type DrillPresentation =
  | { kind: "table" }
  | { kind: "chart"; mark: string; markOptions?: Record<string, unknown> };

/** A drill-through definition. Mirrors Rust `DrillDesignQuery`. */
export interface DrillThroughDefinition {
  /** The design-query DSL (`ROWS:` / `COLUMNS:` / `VALUES:` / `FILTERS:` / `CALC:`). */
  dslText: string;
  presentation: DrillPresentation;
  /** The drill's name: the result sheet's base name (cleaned to the sheet-name
   *  rules), a table result's bold title as written, and the chart title's
   *  first half. Absent = "Drillthrough". */
  name?: string;
  /**
   * Power BI's "Keep all filters": carry the page's filters resolved for the
   * source visual into the drill, beside the clicked datum. ABSENT = TRUE;
   * read it through {@link drillKeepsFilters}, never directly.
   */
  keepFilters?: boolean;
}

/**
 * One field's filter as the drill carries it: member KEYS (never labels),
 * with labels beside them for the caption. Mirrors Rust `DrillFilterSpec`.
 *
 *   - `includedKeys`: an IN-list (`= (...)`); `""` is the blank member.
 *   - `hiddenKeys`: a NOT IN list.
 *   - `labels`: parallel to `includedKeys`, for display only.
 */
export interface DrillFilterSpec {
  /** "Table.Column", the model's spelling (`biFieldKey`). */
  field: string;
  includedKeys?: string[];
  hiddenKeys?: string[];
  labels?: string[];
}

// ============================================================================
// The `drill_through` command (Rust drill_through.rs), two ops
// ============================================================================

/** `toSheet`'s presentation: the kind of sheet the backend appends. */
export type DrillSheetPresentation = "table" | "chart";

/** Mirrors Rust `DrillThroughRequest::PivotContext`. */
export interface DrillThroughPivotContextRequest {
  op: "pivotContext";
  pivotId: string;
  /** The pivot cell's `groupPath`: `[fieldIndex, valueId]` pairs. */
  groupPath: Array<[number, number]>;
}

/**
 * Mirrors Rust `DrillThroughRequest::ToSheet`. `query` is the compiled
 * `DesignQueryRequest` (a TABLE run; the backend computes the view and writes
 * it); a CHART presentation sends no query -- the frontend dry-runs it and
 * creates the chart on the appended canvas. `caption` is a list of COMPLETE
 * lines the backend writes verbatim under the title (row 1 onward).
 */
export interface DrillThroughToSheetRequest {
  op: "toSheet";
  /** The sheet-name BASE (`drillThroughSheetName`); the backend makes it unique. */
  name: string;
  presentation: DrillSheetPresentation;
  query?: unknown;
  caption: string[];
  /**
   * The definition's NAME as its author wrote it (up to 80 characters, any
   * characters), written in bold at (0,0) of a table result. Absent or blank:
   * `name` is written there instead. Rust `#[serde(default)] title:
   * Option<String>`.
   */
  title?: string;
}

export type DrillThroughRequest = DrillThroughPivotContextRequest | DrillThroughToSheetRequest;

/** Mirrors Rust `DrillThroughResponse::PivotContext`. */
export interface DrillThroughPivotContextResponse {
  op: "pivotContext";
  connectionId: string;
  /**
   * The LIVE connection's application data-source key (the connection's
   * `packageDataSourceId`, read after the pivot's guards are released);
   * absent for a local connection.
   */
  packageDataSourceId?: string;
  /**
   * The CLICKED PATH only, as KEYS: one spec per group-path coordinate that
   * names a member. A synthetic "Total" row coordinate (a values-only pivot)
   * contributes NONE, so a caller never slices anything by
   * `groupPath.length` -- the split is this field and {@link standing}.
   */
  filters: DrillFilterSpec[];
  /** The pivot's own STANDING filters (pinned engine filters, hidden items), as KEYS. */
  standing: DrillFilterSpec[];
  /** What could not be carried ("the filter on X could not be carried"). */
  notices: PivotNotice[];
}

/** Mirrors Rust `DrillThroughResponse::ToSheet`. */
export interface DrillThroughToSheetResponse {
  op: "toSheet";
  sheetIndex: number;
  sheetName: string;
  sheetId: string;
  rowCount: number;
  colCount: number;
}

export type DrillThroughResponse = DrillThroughPivotContextResponse | DrillThroughToSheetResponse;

// ============================================================================
// Pure helpers
// ============================================================================

/** The sheet name when the definition offers none usable (a proper noun, like "DrillThrough" was). */
export const DRILL_THROUGH_DEFAULT_SHEET_NAME = "Drillthrough";

/** Whether the drill carries the page's filters (Power BI's "Keep all filters"). Absent = true. */
export function drillKeepsFilters(d: DrillThroughDefinition): boolean {
  return d.keepFilters !== false;
}

/** The drill's name as a title shows it: the definition's, else "Drill through". */
export function drillThroughDisplayName(d: DrillThroughDefinition): string {
  const name = (d.name ?? "").trim();
  return name || "Drill through";
}

/** Excel's limit, in CHARACTERS (Rust `MAX_SHEET_NAME_CHARS`). */
const MAX_SHEET_NAME_CHARS = 31;
/** Rust `ILLEGAL_SHEET_NAME_CHARS`: `: \ / ? * [ ]`. */
const ILLEGAL_SHEET_NAME_CHARS = /[:\\/?*[\]]/g;
/** Rust `RESERVED_SHEET_NAME`. */
const RESERVED_SHEET_NAME = "History";

/**
 * A sheet-name BASE the backend's `validate_sheet_name` accepts, or null:
 * illegal characters removed, apostrophes stripped from the ends, cut to 31
 * characters (code points, not UTF-16 units), never the reserved "History".
 * The backend still validates; this only keeps its "Drillthrough" fallback
 * from firing on a name a person would recognise.
 */
function sheetNameBase(raw: string): string | null {
  let name = raw.replace(ILLEGAL_SHEET_NAME_CHARS, "").trim().replace(/^'+|'+$/g, "").trim();
  if (!name) return null;
  const chars = Array.from(name);
  if (chars.length > MAX_SHEET_NAME_CHARS) {
    name = chars.slice(0, MAX_SHEET_NAME_CHARS).join("").trim().replace(/'+$/g, "").trim();
  }
  if (!name || sheetNamesEqual(name, RESERVED_SHEET_NAME)) return null;
  return name;
}

/**
 * The base name of the sheet a run appends (the backend makes it unique with
 * its FirstFree rule): the definition's name; else `<source> drill` after the
 * object it was drilled from; else "Drillthrough". Each candidate goes through
 * the sheet-name rules first, so a name with a `/` in it loses the `/` rather
 * than the whole name.
 */
export function drillThroughSheetName(d: DrillThroughDefinition, sourceName: string): string {
  const source = sourceName.trim();
  const candidates = [(d.name ?? "").trim(), source ? `${source} drill` : ""];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const clean = sheetNameBase(candidate);
    if (clean) return clean;
  }
  return DRILL_THROUGH_DEFAULT_SHEET_NAME;
}
