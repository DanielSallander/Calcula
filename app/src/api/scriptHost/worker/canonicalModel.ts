//! FILENAME: app/src/api/scriptHost/worker/canonicalModel.ts
// PURPOSE: The worker-realm binding of Calcula's canonical Range/Cell model
//          (C3 step 3). Object scripts get the SAME Workbook -> Sheet -> Range
//          -> Cell shape extensions use (api/range.ts), so an author who learns
//          `range.setValues(...)` in one runtime carries it to the other.
// CONTEXT: The object-script worker CANNOT call Tauri directly (no `./lib`); it
//          reaches the host only by broker RPC. So this is a SEPARATE
//          implementation of the same model, backed by an injected transport
//          the context shim wires to allowlisted broker methods: the per-cell
//          sheet.getCellValue / sheet.setCellValue, plus the BULK
//          sheet.getRangeValues / sheet.setRangeValues (B1) which move a whole
//          rectangle — typed, with formulas — in ONE round trip and land a
//          block write as a single undo step. Pure + self-contained: no imports,
//          so it is safe to run inside the hardened worker realm. The single
//          shared .d.ts that makes all three runtimes agree on one model is
//          C3 step 4.

/** Reads a cell's display value by 0-based row/col (resolved by the shim to a
 *  broker aspect). */
export type CellReader = (row: number, col: number) => Promise<string>;
/** Writes a cell's value by 0-based row/col. */
export type CellWriter = (row: number, col: number, value: string) => Promise<void>;

/**
 * A cell WITH its type (B1). The display string alone cannot tell the number 5
 * from the text "5", an error from a cell containing "#DIV/0!", or a formula
 * from its rendered result — so `getValues()` + `setValues()` is a data-loss
 * round-trip: it writes every formula back as text. `getData()` returns these
 * instead, and `formula` is the thing to write back when you mean to preserve
 * one.
 *
 * Structurally identical to `ScriptCell` in @api/scriptableObjects (and to
 * Rust's `TypedCellData`); redeclared here because this module is imported by
 * the hardened worker realm and stays dependency-free on purpose.
 */
export interface ScriptCell {
  /** number | string | boolean | null (null = an empty cell). An error cell
   *  carries its Excel literal, e.g. "#DIV/0!". */
  value: string | number | boolean | null;
  /** The formatted text the grid shows. */
  display: string;
  /** The cell's formula ("=A1+B1"); absent when it has none (or a protected
   *  sheet hides it). */
  formula?: string;
  type: "number" | "text" | "boolean" | "empty" | "error";
}

/**
 * How a ScriptRange reaches the grid. `readCell`/`writeCell` are the always-
 * available single-cell fallbacks; `readRange`/`writeCells` are the ONE-CALL
 * bulk paths a shim wires when the script's tier has a bulk broker method.
 * Without them a 100x100 block costs 10,000 sequential RPCs.
 */
export interface RangeTransport {
  readCell: CellReader;
  writeCell: CellWriter;
  /** Typed rectangle read in one call (dense rows x cols). */
  readRange?: (
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ) => Promise<ScriptCell[][]>;
  /** Block write in one call, anchored at (startRow, startCol). A hole
   *  (undefined) leaves that cell untouched. */
  writeCells?: (
    startRow: number,
    startCol: number,
    values: Array<Array<string | undefined>>,
  ) => Promise<void>;
  /** Apply a PARTIAL format to the rectangle (B2). */
  formatRange?: (
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    format: ScriptFormat,
  ) => Promise<void>;
  /** Strip all formatting from the rectangle, keeping the values (B2). */
  clearFormatRange?: (
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ) => Promise<void>;
  /** Read the rectangle's formats as a dense rows x cols grid (Wave 3). */
  readFormats?: (
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ) => Promise<ScriptCellFormat[][]>;
  /** Apply a NAMED cell style to the rectangle (Wave 4) — unlocked reach,
   *  active sheet only (the backend command is). */
  applyNamedStyle?: (
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    name: string,
  ) => Promise<void>;
  /** Set (or, with null, clear) the rectangle's data-validation rule (Wave 3). */
  setValidation?: (
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    rule: ScriptValidationRule | null,
  ) => Promise<void>;
  /** Read one cell's data-validation rule (null = none) (Wave 3). */
  readValidation?: (row: number, col: number) => Promise<ScriptValidationRule | null>;
  // ---- Navigation reads + selection (Wave 2). Optional like the bulk paths:
  //      a transport without them yields an honest throw, never a wrong answer.
  /** Where Ctrl+Arrow would land from (row, col) — VBA Range.End. */
  rangeEdge?: (row: number, col: number, direction: EdgeDirection) => Promise<CellPoint>;
  /** The contiguous data block around (row, col) — VBA CurrentRegion. */
  currentRegion?: (row: number, col: number) => Promise<RegionResult>;
  /** Select the rectangle (as the user would), scrolling it into view unless
   *  told not to. */
  selectRange?: (
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    scroll: boolean,
  ) => Promise<void>;
  // ---- Fill + auto-fit (Wave 3, items 10/11). Optional like the rest. ----
  /** Fill the rectangle from its leading band (api.fillRange, the fill-handle
   *  machinery). */
  fillRange?: (
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    options: RangeFillOptions,
  ) => Promise<FillCount>;
  /** Best-fit an inclusive column span to its contents (api.autoFitColumns —
   *  the double-click measurement). */
  autoFitColumns?: (startCol: number, endCol: number) => Promise<FillCount>;
  // ---- Range-scoped ops (Wave 4). Optional like the rest: a transport
  //      without them makes the range methods throw an honest error. ----
  /** Find every match INSIDE the rectangle (api.findAll with a range clamp). */
  findInRange?: (
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    query: string,
    options?: RangeFindOptions,
  ) => Promise<SheetFindResult>;
  /** Replace INSIDE the rectangle only (api.replaceAll with a range clamp),
   *  one undo step. */
  replaceInRange?: (
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    search: string,
    replacement: string,
    options?: RangeReplaceOptions,
  ) => Promise<{ replacementCount: number }>;
  /** Remove duplicate rows from the rectangle (api.removeDuplicates). */
  removeDuplicates?: (
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    options?: RangeRemoveDuplicatesOptions,
  ) => Promise<RemoveDuplicatesCount>;
  /** Split a one-column rectangle by delimiters (api.textToColumns). */
  textToColumns?: (
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    options?: RangeTextToColumnsOptions,
  ) => Promise<TextToColumnsCount>;
  /** The cells of one class inside the rectangle (api.getSpecialCells). */
  specialCells?: (
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    kind: SpecialCellsKind,
  ) => Promise<SpecialCellsAnswer>;
  /** Drive one input cell until a target formula cell reaches a value
   *  (api.goalSeek). */
  goalSeek?: (
    targetRow: number,
    targetCol: number,
    targetValue: number,
    variableRow: number,
    variableCol: number,
  ) => Promise<GoalSeekOutcome>;
  /** Group the rectangle's ROWS into an outline group (api.groupRows). */
  groupRows?: (startRow: number, endRow: number) => Promise<RangeGroupResult>;
  /** Ungroup the rectangle's ROWS (api.ungroupRows). */
  ungroupRows?: (startRow: number, endRow: number) => Promise<RangeGroupResult>;
}

/** What a range group()/ungroup() resolves to (mirrors GroupingOpResult in
 *  @api/groupingService — the seam the broker's outline rows dispatch into). */
export interface RangeGroupResult {
  /** Deepest row group level on the sheet afterwards (0 = none). */
  maxRowLevel: number;
  /** Deepest column group level on the sheet afterwards (0 = none). */
  maxColLevel: number;
  /** Absolute row indices whose visibility the operation changed. */
  hiddenRowsChanged: number[];
  /** Absolute column indices whose visibility the operation changed. */
  hiddenColsChanged: number[];
}

/** How a range-level fill addresses the fill machinery. The rectangle it goes
 *  with is SOURCE + TARGET together; `sourceSize` is the thickness of the seed
 *  band at the edge the fill starts from (default 1 — Excel's FillDown). */
export interface RangeFillOptions {
  direction: "down" | "up" | "right" | "left";
  /** "copy" (default): tile the band, shifting formulas. "series": the drag
   *  handle's series/date/custom-list inference. */
  type?: "copy" | "series";
  sourceSize?: number;
}

/** What fill / auto-fit resolve to: how many cells (or columns/rows) changed. */
export interface FillCount {
  count: number;
}

/**
 * A PARTIAL cell format (B2). Only the properties present are changed — an
 * absent key leaves that attribute alone, so `format({ bold: true })` never
 * resets the number format. Unknown keys are REJECTED by the broker (with the
 * accepted list) rather than ignored.
 *
 * PER-CELL vs RANGE-EDGE borders (Wave 3, item 2). The six borderTop/...
 * keys are PER CELL: every cell of the rectangle gets that side, so
 * borderTop on a table draws interior lines too. The three borderOutline /
 * borderInsideHorizontal / borderInsideVertical keys describe the RECTANGLE:
 * the host decomposes them into per-cell truth (outline lands only on the
 * edge cells; the inside keys land on the interior edges, on both adjoining
 * cells, exactly as Excel stores them). Reads report the decomposed per-cell
 * sides, never these three keys.
 *
 * `locked` / `formulaHidden` are accepted ONLY through the unlocked
 * api.setRangeFormat row — a restricted (e.g. distributed) script's format
 * call is refused if it names them, so packaged code can never unlock cells.
 * The checkbox/button cell controls stay out entirely: separate surfaces.
 */
export interface ScriptFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: "none" | "single" | "double" | "singleAccounting" | "doubleAccounting";
  strikethrough?: boolean;
  /** Font size in POINTS (1-409). */
  fontSize?: number;
  fontFamily?: string;
  /** "#RRGGBB(AA)" hex, or a theme reference `{ theme, tint? }` (Wave 4). */
  textColor?: ScriptColorValue;
  backgroundColor?: ScriptColorValue;
  textAlign?: "left" | "center" | "right" | "general";
  verticalAlign?: "top" | "middle" | "bottom";
  /** An Excel number-format code, e.g. "#,##0.00" or "General". */
  numberFormat?: string;
  wrapText?: boolean;
  textRotation?: "none" | "rotate90" | "rotate270";
  /** Indent steps (0-250). */
  indent?: number;
  shrinkToFit?: boolean;
  /** Pattern/gradient/solid fill (Wave 4); `{ type: "none" }` removes it.
   *  `backgroundColor` stays the shorthand for a solid fill. */
  fill?: ScriptFillSpec;
  borderTop?: ScriptBorderSide;
  borderRight?: ScriptBorderSide;
  borderBottom?: ScriptBorderSide;
  borderLeft?: ScriptBorderSide;
  borderDiagonalDown?: ScriptBorderSide;
  borderDiagonalUp?: ScriptBorderSide;
  /** RANGE-EDGE: a border around the rectangle only (per-cell truth: top row
   *  gets top, bottom row bottom, left column left, right column right). */
  borderOutline?: ScriptBorderSide;
  /** RANGE-EDGE: the horizontal edges BETWEEN rows (never the outer top or
   *  bottom edge). */
  borderInsideHorizontal?: ScriptBorderSide;
  /** RANGE-EDGE: the vertical edges BETWEEN columns (never the outer left or
   *  right edge). */
  borderInsideVertical?: ScriptBorderSide;
  /** Whether the cells are locked while their sheet is protected (default
   *  true). UNLOCKED api.setRangeFormat only — refused everywhere else. */
  locked?: boolean;
  /** Whether the cells' formulas are hidden while their sheet is protected.
   *  UNLOCKED api.setRangeFormat only — refused everywhere else. */
  formulaHidden?: boolean;
}

/**
 * The FULLY-POPULATED form of one cell's format, as the format READ-BACK
 * (api.getRangeFormat / getCellFormat, range.getFormats()/getFormat()) answers
 * it — every key writable through setRangeFormat, in the same vocabulary, plus
 * the two protection attributes (readable at both tiers; changing them stays
 * unlocked-only). Border sides read back as words (thin/medium/thick/...);
 * colors read back canonical "#rrggbb"; textRotation may additionally be the
 * "custom:N" form the UI can set. Structural twin of ScriptCellFormat in
 * host.ts — redeclared here because this module stays dependency-free.
 */
export interface ScriptCellFormat {
  bold: boolean;
  italic: boolean;
  underline: string;
  strikethrough: boolean;
  fontSize: number;
  fontFamily: string;
  /** "#rrggbb" when absolute; `{ theme, tint }` when theme-referenced (the
   *  DEFAULT cell is theme-referenced: text dark1, background light1). */
  textColor: ScriptColorReadback;
  /** The text color resolved against the current theme ("#rrggbb"). */
  textColorResolved: string;
  backgroundColor: ScriptColorReadback;
  backgroundColorResolved: string;
  textAlign: string;
  verticalAlign: string;
  numberFormat: string;
  wrapText: boolean;
  textRotation: string;
  indent: number;
  shrinkToFit: boolean;
  /** The cell's fill; `{ type: "none" }` when it has none (a plain
   *  backgroundColor write reads back as a solid fill — that IS the storage). */
  fill: ScriptFillReadback;
  borderTop: { style: string; color: string };
  borderRight: { style: string; color: string };
  borderBottom: { style: string; color: string };
  borderLeft: { style: string; color: string };
  borderDiagonalDown: { style: string; color: string };
  borderDiagonalUp: { style: string; color: string };
  locked: boolean;
  formulaHidden: boolean;
}

/** A theme color reference (Wave 4): a document-theme slot key plus an
 *  optional tint FRACTION (-1..1, positive = lighter). */
export interface ScriptThemeColorRef {
  theme: string;
  tint?: number;
}

/** Any color a script writes: hex or a theme reference. */
export type ScriptColorValue = string | ScriptThemeColorRef;

/** A theme color as the read-back reports it (tint always present). */
export interface ScriptThemeColorReadback {
  theme: string;
  tint: number;
}

/** A color as the read-back reports it. */
export type ScriptColorReadback = string | ScriptThemeColorReadback;

/** The `fill` format key (write side) — structural twin of ScriptFillSpec in
 *  host.ts; the broker enumerates types, pattern names and directions. */
export type ScriptFillSpec =
  | { type: "none" }
  | { type: "solid"; color: ScriptColorValue }
  | { type: "pattern"; patternType: string; fgColor: ScriptColorValue; bgColor: ScriptColorValue }
  | { type: "gradient"; color1: ScriptColorValue; color2: ScriptColorValue; direction: string };

/** A fill as the read-back reports it. */
export type ScriptFillReadback =
  | { type: "none" }
  | { type: "solid"; color: ScriptColorReadback }
  | { type: "pattern"; patternType: string; fgColor: ScriptColorReadback; bgColor: ScriptColorReadback }
  | { type: "gradient"; color1: ScriptColorReadback; color2: ScriptColorReadback; direction: string };

/** One border edge. */
export interface ScriptBorderSide {
  style: "none" | "thin" | "medium" | "thick" | "dashed" | "dotted" | "double";
  /** "#RRGGBB(AA)" hex, or a theme reference — border theme colors are
   *  resolved to their current hex at write time (the border pipeline stores
   *  absolute colors), so they read back as that hex. */
  color: ScriptColorValue;
}

/** An inclusive 0-based cell rectangle — the geometry behind a ScriptRange. */
export interface Box {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** An edge-navigation direction (VBA Range.End / Ctrl+Arrow). The same four
 *  strings Rust's EdgeDirection::parse accepts (core/engine/src/navigation.rs). */
export type EdgeDirection = "up" | "down" | "left" | "right";

/** A single cell position, as api.getRangeEdge answers it. */
export interface CellPoint {
  row: number;
  col: number;
}

/** A discovered rectangle (current region / used range). `empty: true` means
 *  nothing was found — an isolated seed cell (region collapses to the seed) or
 *  a sheet that stores nothing (coordinates are meaningless zeros). */
export interface RegionResult extends Box {
  empty: boolean;
}

/** Sheet visibility, exactly as the backend stores it. */
export type SheetVisibility = "visible" | "hidden" | "veryHidden";

/** One sheet as the rich listing (api.getSheets) reports it. */
export interface WorkbookSheetInfo {
  index: number;
  name: string;
  visibility: SheetVisibility;
  tabColor: string | null;
}

/**
 * The flat data-validation rule (Wave 3, item 5) — the write AND read-back
 * shape. Structural twin of ScriptValidationRule in host.ts, redeclared here
 * because this module stays dependency-free. The broker enumerates the legal
 * keys PER TYPE (validators.ts checkValidationRule) and rejects unknown ones
 * with the accepted list.
 */
export interface ScriptValidationRule {
  type: "wholeNumber" | "decimal" | "list" | "date" | "time" | "textLength" | "custom";
  operator?:
    | "between" | "notBetween" | "equal" | "notEqual"
    | "greaterThan" | "lessThan" | "greaterThanOrEqual" | "lessThanOrEqual";
  formula1?: number;
  formula2?: number;
  /** custom only. */
  formula?: string;
  /** list only: literal dropdown entries (exactly one of values/sourceRange). */
  values?: string[];
  /** list only: the rectangle the entries come from. */
  sourceRange?: { sheetIndex?: number } & Box;
  /** list only (default true). */
  inCellDropdown?: boolean;
  ignoreBlanks?: boolean;
  inputTitle?: string;
  inputMessage?: string;
  showInput?: boolean;
  errorTitle?: string;
  errorMessage?: string;
  errorStyle?: "stop" | "warning" | "information";
  showError?: boolean;
}

// ---- Sheet-handle structural ops (Wave 3): the argument shapes, redeclared
//      dependency-free (twins of the api.* flat-row shapes in contextShims).

/** One sort criterion (key = 0-based offset FROM THE RANGE START). */
export interface SheetSortField {
  key: number;
  ascending?: boolean;
  sortOn?: "value" | "cellColor" | "fontColor" | "icon";
  color?: string;
  dataOption?: "normal" | "textAsNumber";
  subField?: string;
  customOrder?: string;
}

export interface SheetSortOptions {
  matchCase?: boolean;
  hasHeaders?: boolean;
  orientation?: "rows" | "columns";
}

export interface SheetFindOptions {
  caseSensitive?: boolean;
  matchEntireCell?: boolean;
  searchFormulas?: boolean;
}

export interface SheetFindResult {
  matches: Array<{ row: number; col: number }>;
  totalCount: number;
}

export interface SheetClearOptions {
  applyTo?: "all" | "contents" | "formats";
}

// ---- Range-scoped ops (Wave 4, RANGE-OPS cluster): the argument/result
//      shapes for range.find/replace/removeDuplicates/textToColumns/
//      specialCells/goalSeek. Redeclared dependency-free like everything else
//      in this module; the broker validates the same shapes (validators.ts).

/** Options for range.find(): the search flags WITHOUT a sheet/range slot —
 *  both are the range's own. */
export interface RangeFindOptions {
  caseSensitive?: boolean;
  matchEntireCell?: boolean;
  searchFormulas?: boolean;
}

/** Options for range.replace(). */
export interface RangeReplaceOptions {
  caseSensitive?: boolean;
  matchEntireCell?: boolean;
}

/** Options for range.removeDuplicates(). `columns` are 0-based offsets FROM
 *  THE RANGE START (sortRange-style), not absolute column indexes. */
export interface RangeRemoveDuplicatesOptions {
  columns?: number[];
  hasHeaders?: boolean;
}

/** What removeDuplicates resolves to. */
export interface RemoveDuplicatesCount {
  removedCount: number;
}

/** Options for range.textToColumns(). Each delimiter is ONE character;
 *  omitting `delimiters` splits on commas. `destination` defaults to the
 *  range's own top-left cell (split in place). */
export interface RangeTextToColumnsOptions {
  delimiters?: string[];
  consecutiveAsOne?: boolean;
  destination?: CellPoint;
}

/** What textToColumns resolves to. */
export interface TextToColumnsCount {
  rowsProcessed: number;
  columnsProduced: number;
  cellsWritten: number;
}

/** The cell classes specialCells can select (Excel Range.SpecialCells). */
export type SpecialCellsKind = "constants" | "formulas" | "blanks" | "visible";

/** What specialCells resolves to. `truncated: true` means the backend cap
 *  dropped entries — the list is INCOMPLETE. */
export interface SpecialCellsAnswer {
  cells: CellPoint[];
  truncated: boolean;
}

/** What goalSeek resolves to. `solution` is the value left in the changing
 *  cell (the closest found even when `converged` is false). */
export interface GoalSeekOutcome {
  converged: boolean;
  solution: number;
  iterations: number;
}

/** 0-based column index -> A1 letters (0 -> "A", 26 -> "AA"). */
function colToLetters(col: number): string {
  let s = "";
  let n = col + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** A1 letters -> 0-based column index ("A" -> 0, "AA" -> 26). */
function lettersToCol(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

function parseRef(ref: string): { row: number; col: number } {
  const m = ref.trim().match(/^([A-Za-z]+)(\d+)$/);
  if (!m) throw new Error(`Invalid cell reference: "${ref}"`);
  const rowNum = parseInt(m[2], 10);
  // Row 0 does not exist in A1 notation — reject like Rust parse_ref does
  // (core/script-engine/src/ops/canonical_model.rs); silently mapping "A0" to
  // row -1 would skip the named-range fallback and fail later with a
  // coordinate error that never mentions the address.
  if (rowNum === 0) throw new Error(`Invalid cell reference: "${ref}"`);
  return { row: rowNum - 1, col: lettersToCol(m[1]) };
}

/**
 * Split an optional Excel-style sheet prefix off an address: "Sheet2!A1" and
 * the quoted form "'My Sheet'!A1:B5" (with '' as the escaped literal quote).
 * Pure string surgery — nothing is resolved here. Twin of the prefix-unquoting
 * block in core/script-engine/src/ops/canonical_model.rs `parse_a1`.
 */
export function splitSheetPrefix(address: string): { sheetName: string | null; rest: string } {
  const work = address.trim();
  const bang = work.indexOf("!");
  if (bang === -1) return { sheetName: null, rest: work };
  const rawPrefix = work.slice(0, bang).trim();
  const rest = work.slice(bang + 1);
  const quoted =
    rawPrefix.length >= 2 && rawPrefix.startsWith("'") && rawPrefix.endsWith("'");
  const sheetName = quoted ? rawPrefix.slice(1, -1).replace(/''/g, "'") : rawPrefix;
  return { sheetName, rest };
}

/** Format sheet names for an error message: `"Alpha", "Beta"`. Twin of
 *  `sheet_names_for_error` in core/script-engine/src/ops/mod.rs. */
function sheetNamesForError(names: string[]): string {
  if (names.length === 0) return "(none)";
  return names.map((n) => `"${n}"`).join(", ");
}

/**
 * Resolve a sheet NAME to its 0-based index: exact match first, then a UNIQUE
 * case-insensitive match. The error lists the workbook's sheet names so the
 * script author sees what WOULD have matched. Twin of `resolve_sheet_name` in
 * core/script-engine/src/ops/mod.rs — both realms must agree, message for
 * message.
 */
export function resolveSheetName(names: string[], name: string): number {
  const exact = names.indexOf(name);
  if (exact !== -1) return exact;
  const lower = name.toLowerCase();
  const matches: number[] = [];
  for (let i = 0; i < names.length; i++) {
    if (names[i].toLowerCase() === lower) matches.push(i);
  }
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(
      `No sheet named "${name}". Sheets in this workbook: ${sheetNamesForError(names)}`,
    );
  }
  throw new Error(
    `Sheet name "${name}" is ambiguous: it case-insensitively matches more than one sheet. ` +
      `Sheets in this workbook: ${sheetNamesForError(names)}`,
  );
}

/** Parse an A1 BODY — "A1", "A1:B5", "$A$1:$B$5" — with NO prefix handling.
 *  Split any "Sheet!" prefix off with splitSheetPrefix first; a stray "!" here
 *  fails as an invalid cell reference rather than being re-split. */
export function parseA1Body(body: string): Box {
  const work = body.replace(/\$/g, "");
  const parts = work.split(":");
  const a = parseRef(parts[0]);
  if (parts.length === 1) {
    return { startRow: a.row, startCol: a.col, endRow: a.row, endCol: a.col };
  }
  const b = parseRef(parts[1]);
  return {
    startRow: Math.min(a.row, b.row),
    startCol: Math.min(a.col, b.col),
    endRow: Math.max(a.row, b.row),
    endCol: Math.max(a.col, b.col),
  };
}

/**
 * Parse "A1", "A1:B5", "$A$1:$B$5" for a range whose transport is PINNED to
 * one context (a table's body; the sheet context handles its own prefix). A
 * "Sheet!" prefix is REFUSED here, never silently dropped: the old behavior
 * sent `range("Data!A1")` to whatever sheet the range happened to be bound to
 * — the WRONG one. Contexts that CAN address another sheet (workbook
 * navigation, api.range) resolve the prefix themselves before parsing the
 * body; the decision table for that resolution lives in `resolveSheetName`
 * above and its twin in core/script-engine/src/ops/canonical_model.rs.
 */
export function parseA1(address: string): Box {
  const { sheetName, rest } = splitSheetPrefix(address);
  if (sheetName !== null) {
    throw new Error(
      `Address "${address.trim()}" names sheet "${sheetName}", but this range is bound to ` +
        `its own context and cannot address another sheet. Use api.range("${sheetName}!${rest}") ` +
        `or api.workbook.sheet(...) for cross-sheet access.`,
    );
  }
  return parseA1Body(rest);
}

/**
 * The object-script Range facet — the canonical model's Range, async over the
 * broker. Mirrors the navigation + data ops of the extension `CellRange`
 * (api/range.ts); values are display strings (the object-script convention,
 * matching `namedRange.getValues()`), not full CellData.
 */
export interface ScriptRange {
  readonly startRow: number;
  readonly startCol: number;
  readonly endRow: number;
  readonly endCol: number;
  readonly rowCount: number;
  readonly colCount: number;
  readonly isSingleCell: boolean;
  /** A1 address ("A1" or "A1:B5"). */
  readonly address: string;
  /** A new range shifted by (dr, dc), same size. */
  offset(rowOffset: number, colOffset: number): ScriptRange;
  /** A new range, same top-left, resized to rows x cols. */
  resize(rows: number, cols: number): ScriptRange;
  /** A single-cell range at the given offset within this range. */
  getCell(rowOffset: number, colOffset: number): ScriptRange;
  /** The top-left cell's display value. */
  getValue(): Promise<string>;
  /** All values as a rows x cols grid of display strings — ONE round trip.
   *  Display strings are FORMATTED text: prefer getData() when you care about
   *  types, and never write getValues() output back (it turns formulas into
   *  their rendered text). */
  getValues(): Promise<string[][]>;
  /** All cells with their type + formula, as a rows x cols grid — ONE round
   *  trip. This is the safe read for a read/modify/write round-trip. */
  getData(): Promise<ScriptCell[][]>;
  /** All formulas as a rows x cols grid ("" where a cell has none). */
  getFormulas(): Promise<string[][]>;
  /** All formats as a rows x cols grid — ONE round trip. The read-back twin of
   *  format(): every writable key reports back in the same vocabulary. */
  getFormats(): Promise<ScriptCellFormat[][]>;
  /** The top-left cell's format. */
  getFormat(): Promise<ScriptCellFormat>;
  /** Set the top-left cell's value. */
  setValue(value: string): Promise<void>;
  /** Set values from a 2D array (clamped to the range's dimensions), in ONE
   *  call where the tier allows it. Undoable as a single step. */
  setValues(values: string[][]): Promise<void>;
  /** Apply a PARTIAL format to every cell in the range — ONE call, one undo
   *  step. Absent properties are left alone. */
  format(format: ScriptFormat): Promise<void>;
  /** Remove ALL formatting from the range, keeping the values. */
  clearFormat(): Promise<void>;
  /** Apply a NAMED cell style ("Good", "Heading 1", a custom one) to every
   *  cell of this range — VBA's Range.Style (Wave 4). Active sheet only. */
  applyStyle(name: string): Promise<void>;
  /** Set a data-validation rule on every cell of this range (what future
   *  edits will accept, an optional dropdown, and the messages shown);
   *  `null` removes the rules instead (Wave 3). */
  setValidation(rule: ScriptValidationRule | null): Promise<void>;
  /** The data-validation rule on this range's TOP-LEFT cell, in the same
   *  shape setValidation() accepts; null when the cell has none (Wave 3). */
  validation(): Promise<ScriptValidationRule | null>;
  // ---- Navigation + selection (Wave 2) ----
  /** The single-cell range where Ctrl+Arrow would land from this range's
   *  TOP-LEFT cell (VBA Range.End operates on the range's first cell), over
   *  the full Excel grid bounds. The last-row idiom works:
   *  `api.range("A1048576").end("up")`. */
  end(direction: EdgeDirection): Promise<ScriptRange>;
  /** The contiguous block of data around this range's TOP-LEFT cell (VBA
   *  CurrentRegion / Ctrl+A). An isolated cell yields itself. */
  currentRegion(): Promise<ScriptRange>;
  /** Select this range exactly as if the user had clicked it, scrolling it
   *  into view unless `scroll` is false. */
  select(scroll?: boolean): Promise<void>;
  // ---- Range algebra (Wave 2): pure coordinate math, no broker call. The
  //      TWIN of this table lives in core/script-engine/src/ops/canonical_model.rs
  //      (contains / intersect / boundingUnion on NotebookRange) — both realms
  //      MUST agree, case for case. ----
  /** True when the 0-based cell lies inside this range (inclusive; negative
   *  coordinates are always outside). */
  contains(row: number, col: number): boolean;
  /** The overlapping rectangle, or null when disjoint. `other` may be any
   *  Range-shaped object (startRow/startCol/endRow/endCol); the result is
   *  bound to THIS range's sheet. */
  intersect(other: Box): ScriptRange | null;
  /** The smallest single rectangle covering both ranges. Named honestly: this
   *  is NOT VBA Union's multi-area result — the gaps between the inputs are
   *  included. Bound to THIS range's sheet. */
  boundingUnion(other: Box): ScriptRange;
  // ---- Fill + auto-fit (Wave 3, items 10/11): the fill-handle machinery and
  //      the double-click best-fit, addressed from a range. ACTIVE SHEET only
  //      (the host refuses, never redirects, a range bound elsewhere). ----
  /** Excel's Fill Down over this range: the FIRST row seeds the rest — values
   *  copied, formulas shifted per cell. A one-row range fills nothing. */
  fillDown(): Promise<FillCount>;
  /** Fill Up: the LAST row seeds the rows above it. */
  fillUp(): Promise<FillCount>;
  /** Fill Right: the FIRST column seeds the columns to its right. */
  fillRight(): Promise<FillCount>;
  /** Fill Left: the LAST column seeds the columns to its left. */
  fillLeft(): Promise<FillCount>;
  /** VBA Range.AutoFill: THIS range seeds `destination` (a Box-shaped range or
   *  an A1 address on the same sheet), which must include this range and
   *  extend it in exactly one direction — precisely a fill-handle drag.
   *  `type` defaults to "series" (the drag's inference); "copy" is Ctrl+drag. */
  autoFill(destination: Box | string, type?: "copy" | "series"): Promise<FillCount>;
  /** Best-fit this range's COLUMNS to their contents — the double-click
   *  measurement, including extension contributions. */
  autoFit(): Promise<FillCount>;
  // ---- Range-scoped ops (Wave 4, RANGE-OPS cluster). ----
  /** Find every matching cell INSIDE this range (VBA Range.Find, all
   *  matches), in reading order. Coordinates are grid-absolute. */
  find(query: string, options?: RangeFindOptions): Promise<SheetFindResult>;
  /** Replace INSIDE this range only (one undo step). Formula cells are
   *  skipped, like Replace All. */
  replace(
    search: string,
    replacement: string,
    options?: RangeReplaceOptions,
  ): Promise<{ replacementCount: number }>;
  /** Remove duplicate rows from this range (Data ▸ Remove Duplicates): rows
   *  whose key columns repeat an earlier row are deleted and the survivors
   *  close up. `columns` are offsets FROM THE RANGE START; omitted = every
   *  column of the range. ACTIVE SHEET only. */
  removeDuplicates(options?: RangeRemoveDuplicatesOptions): Promise<RemoveDuplicatesCount>;
  /** Split this ONE-COLUMN range into columns by delimiters (Data ▸ Text to
   *  Columns). Writes at `options.destination` (default: in place). ACTIVE
   *  SHEET only. */
  textToColumns(options?: RangeTextToColumnsOptions): Promise<TextToColumnsCount>;
  /** The cells of one class inside this range — Excel's Go To Special
   *  (Range.SpecialCells). "visible" is the filter-aware kind: what survives
   *  AutoFilter/advanced-filter/outline hiding. */
  specialCells(kind: SpecialCellsKind): Promise<SpecialCellsAnswer>;
  /** Goal Seek: drive `changingCell` (an A1 address on this sheet, or a
   *  single-cell Range shape) until THIS range's top-left formula cell
   *  evaluates to `targetValue`. ACTIVE SHEET only. */
  goalSeek(targetValue: number, changingCell: string | Box): Promise<GoalSeekOutcome>;
  /** Group this range's ROWS into a collapsible outline group (Data ▸ Group —
   *  VBA `Range.Rows.Group`). Columns are api.groupColumns' business: a range
   *  that guessed which axis you meant would guess wrong half the time.
   *  ACTIVE SHEET only; requires the Grouping feature to be enabled. */
  group(): Promise<RangeGroupResult>;
  /** Ungroup this range's ROWS (Data ▸ Ungroup — VBA `Range.Rows.Ungroup`).
   *  ACTIVE SHEET only; requires the Grouping feature to be enabled. */
  ungroup(): Promise<RangeGroupResult>;
}

/**
 * Read another Range's geometry off an arbitrary value: any object exposing
 * numeric `startRow`/`startCol`/`endRow`/`endCol` (every canonical Range does).
 * TWIN of `box_from_range_value` in core/script-engine/src/ops/canonical_model.rs
 * — same acceptance rule (four non-negative integers), same error message.
 */
function boxFromRangeValue(value: unknown, method: string): Box {
  const fail = (): Error =>
    new Error(`${method} expects a Range (an object with startRow/startCol/endRow/endCol)`);
  if (typeof value !== "object" || value === null) throw fail();
  const o = value as Record<string, unknown>;
  const coord = (v: unknown): number => {
    if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
      throw fail();
    }
    return v;
  };
  return {
    startRow: coord(o.startRow),
    startCol: coord(o.startCol),
    endRow: coord(o.endRow),
    endCol: coord(o.endCol),
  };
}

/** Build a ScriptRange over `box`, backed by the injected transport. */
export function makeRange(t: RangeTransport, box: Box): ScriptRange {
  const read = t.readCell;
  const range: ScriptRange = {
    startRow: box.startRow,
    startCol: box.startCol,
    endRow: box.endRow,
    endCol: box.endCol,
    get rowCount() {
      return box.endRow - box.startRow + 1;
    },
    get colCount() {
      return box.endCol - box.startCol + 1;
    },
    get isSingleCell() {
      return box.startRow === box.endRow && box.startCol === box.endCol;
    },
    get address() {
      const topLeft = colToLetters(box.startCol) + (box.startRow + 1);
      if (range.isSingleCell) return topLeft;
      return `${topLeft}:${colToLetters(box.endCol)}${box.endRow + 1}`;
    },
    offset(rowOffset, colOffset) {
      return makeRange(t, {
        startRow: box.startRow + rowOffset,
        startCol: box.startCol + colOffset,
        endRow: box.endRow + rowOffset,
        endCol: box.endCol + colOffset,
      });
    },
    resize(rows, cols) {
      return makeRange(t, {
        startRow: box.startRow,
        startCol: box.startCol,
        endRow: box.startRow + rows - 1,
        endCol: box.startCol + cols - 1,
      });
    },
    getCell(rowOffset, colOffset) {
      const row = box.startRow + rowOffset;
      const col = box.startCol + colOffset;
      if (row > box.endRow || col > box.endCol) {
        throw new Error(`Offset (${rowOffset}, ${colOffset}) is outside range ${range.address}`);
      }
      return makeRange(t, { startRow: row, startCol: col, endRow: row, endCol: col });
    },
    async getValue() {
      return read(box.startRow, box.startCol);
    },
    async getData() {
      if (!t.readRange) {
        throw new Error(
          "typed reads (getData/getFormulas) are not available for this range — " +
            "its context provides display-string access only",
        );
      }
      return t.readRange(box.startRow, box.startCol, box.endRow, box.endCol);
    },
    async getValues() {
      if (t.readRange) {
        const data = await t.readRange(box.startRow, box.startCol, box.endRow, box.endCol);
        return data.map((row) => row.map((cell) => cell.display));
      }
      // Fallback for a transport with no bulk read: SEQUENTIAL on purpose —
      // firing the whole rectangle in parallel would blow the worker's
      // in-flight call cap (MAX_INFLIGHT_CALLS) and reject with rpc-saturated.
      const out: string[][] = [];
      for (let r = box.startRow; r <= box.endRow; r++) {
        const row: string[] = [];
        for (let c = box.startCol; c <= box.endCol; c++) {
          row.push(await read(r, c));
        }
        out.push(row);
      }
      return out;
    },
    async getFormulas() {
      const data = await range.getData();
      return data.map((row) => row.map((cell) => cell.formula ?? ""));
    },
    async getFormats() {
      if (!t.readFormats) {
        throw new Error(
          "format reads (getFormats/getFormat) are not available for this range — " +
            "its context provides value access only",
        );
      }
      return t.readFormats(box.startRow, box.startCol, box.endRow, box.endCol);
    },
    async getFormat() {
      if (!t.readFormats) {
        throw new Error(
          "format reads (getFormats/getFormat) are not available for this range — " +
            "its context provides value access only",
        );
      }
      const grid = await t.readFormats(box.startRow, box.startCol, box.startRow, box.startCol);
      return grid[0][0];
    },
    async setValue(value) {
      await t.writeCell(box.startRow, box.startCol, value);
    },
    async setValues(values) {
      // Clamp to the range's own dimensions first (the range IS the contract:
      // a bigger input never writes outside it).
      const clamped: Array<Array<string | undefined>> = [];
      for (let r = 0; r < values.length && r < range.rowCount; r++) {
        const row = values[r] ?? [];
        const out: Array<string | undefined> = [];
        for (let c = 0; c < row.length && c < range.colCount; c++) {
          out.push(row[c]);
        }
        clamped.push(out);
      }
      if (t.writeCells) {
        await t.writeCells(box.startRow, box.startCol, clamped);
        return;
      }
      // Per-cell fallback (transport without a bulk write): sequential, same
      // in-flight-cap reasoning as getValues().
      for (let r = 0; r < clamped.length; r++) {
        const row = clamped[r];
        for (let c = 0; c < row.length; c++) {
          const v = row[c];
          if (v === undefined) continue;
          await t.writeCell(box.startRow + r, box.startCol + c, v);
        }
      }
    },
    async format(format) {
      // No per-cell fallback exists (formatting is inherently rectangular in
      // the backend), so a transport without it says so instead of no-opping.
      if (!t.formatRange) {
        throw new Error(
          "format() is not available for this range — its context provides value access only",
        );
      }
      await t.formatRange(box.startRow, box.startCol, box.endRow, box.endCol, format);
    },
    async clearFormat() {
      if (!t.clearFormatRange) {
        throw new Error(
          "clearFormat() is not available for this range — its context provides value access only",
        );
      }
      await t.clearFormatRange(box.startRow, box.startCol, box.endRow, box.endCol);
    },
    async applyStyle(name) {
      if (!t.applyNamedStyle) {
        throw new Error(
          "applyStyle() is not available for this range — named styles are unlocked-tier reach",
        );
      }
      await t.applyNamedStyle(box.startRow, box.startCol, box.endRow, box.endCol, name);
    },
    async setValidation(rule) {
      if (!t.setValidation) {
        throw new Error(
          "setValidation() is not available for this range — its context provides value access only",
        );
      }
      await t.setValidation(box.startRow, box.startCol, box.endRow, box.endCol, rule);
    },
    async validation() {
      if (!t.readValidation) {
        throw new Error(
          "validation() is not available for this range — its context provides value access only",
        );
      }
      return t.readValidation(box.startRow, box.startCol);
    },
    // ---- Navigation + selection (Wave 2) ----
    async end(direction) {
      if (!t.rangeEdge) {
        throw new Error(
          "end() is not available for this range — its context provides value access only",
        );
      }
      // From the TOP-LEFT cell, like VBA Range.End (the Rust twin does the
      // same: canonical_model.rs `end` navigates from b.start_row/start_col).
      const target = await t.rangeEdge(box.startRow, box.startCol, direction);
      return makeRange(t, {
        startRow: target.row,
        startCol: target.col,
        endRow: target.row,
        endCol: target.col,
      });
    },
    async currentRegion() {
      if (!t.currentRegion) {
        throw new Error(
          "currentRegion() is not available for this range — its context provides value access only",
        );
      }
      // An isolated seed answers `empty: true` with the rectangle collapsed to
      // the seed cell — which IS the VBA CurrentRegion answer for an isolated
      // cell, so the box is returned as-is either way.
      const region = await t.currentRegion(box.startRow, box.startCol);
      return makeRange(t, {
        startRow: region.startRow,
        startCol: region.startCol,
        endRow: region.endRow,
        endCol: region.endCol,
      });
    },
    async select(scroll) {
      if (!t.selectRange) {
        throw new Error(
          "select() is not available for this range — its context provides value access only",
        );
      }
      await t.selectRange(box.startRow, box.startCol, box.endRow, box.endCol, scroll !== false);
    },
    // ---- Range algebra: pure coordinate math, no broker call. TWIN of the
    //      NotebookRange table in core/script-engine/src/ops/canonical_model.rs
    //      (contains / intersect / boundingUnion) — the two realms MUST agree,
    //      case for case: contains is inclusive with negatives outside;
    //      intersect is max-of-starts/min-of-ends, null when disjoint;
    //      boundingUnion is min-of-starts/max-of-ends. ----
    contains(row, col) {
      return (
        row >= 0 &&
        col >= 0 &&
        row >= box.startRow &&
        row <= box.endRow &&
        col >= box.startCol &&
        col <= box.endCol
      );
    },
    intersect(other) {
      const o = boxFromRangeValue(other, "intersect");
      const startRow = Math.max(box.startRow, o.startRow);
      const startCol = Math.max(box.startCol, o.startCol);
      const endRow = Math.min(box.endRow, o.endRow);
      const endCol = Math.min(box.endCol, o.endCol);
      if (startRow > endRow || startCol > endCol) return null;
      return makeRange(t, { startRow, startCol, endRow, endCol });
    },
    boundingUnion(other) {
      const o = boxFromRangeValue(other, "boundingUnion");
      return makeRange(t, {
        startRow: Math.min(box.startRow, o.startRow),
        startCol: Math.min(box.startCol, o.startCol),
        endRow: Math.max(box.endRow, o.endRow),
        endCol: Math.max(box.endCol, o.endCol),
      });
    },
    // ---- Fill + auto-fit (Wave 3): thin delegates over the optional
    //      transport ops, with the same honest-refusal style as format(). ----
    async fillDown() {
      return requireFill("fillDown")(box.startRow, box.startCol, box.endRow, box.endCol, {
        direction: "down", type: "copy", sourceSize: 1,
      });
    },
    async fillUp() {
      return requireFill("fillUp")(box.startRow, box.startCol, box.endRow, box.endCol, {
        direction: "up", type: "copy", sourceSize: 1,
      });
    },
    async fillRight() {
      return requireFill("fillRight")(box.startRow, box.startCol, box.endRow, box.endCol, {
        direction: "right", type: "copy", sourceSize: 1,
      });
    },
    async fillLeft() {
      return requireFill("fillLeft")(box.startRow, box.startCol, box.endRow, box.endCol, {
        direction: "left", type: "copy", sourceSize: 1,
      });
    },
    async autoFill(destination, type) {
      const fill = requireFill("autoFill");
      const dest =
        typeof destination === "string"
          ? parseA1(destination)
          : boxFromRangeValue(destination, "autoFill");
      // The destination must CONTAIN this range and extend it in exactly one
      // direction — the geometry of a fill-handle drag (and of VBA AutoFill,
      // which rejects anything else).
      const sameCols = dest.startCol === box.startCol && dest.endCol === box.endCol;
      const sameRows = dest.startRow === box.startRow && dest.endRow === box.endRow;
      let direction: RangeFillOptions["direction"];
      let sourceSize: number;
      if (sameCols && dest.startRow === box.startRow && dest.endRow > box.endRow) {
        direction = "down";
        sourceSize = box.endRow - box.startRow + 1;
      } else if (sameCols && dest.endRow === box.endRow && dest.startRow < box.startRow) {
        direction = "up";
        sourceSize = box.endRow - box.startRow + 1;
      } else if (sameRows && dest.startCol === box.startCol && dest.endCol > box.endCol) {
        direction = "right";
        sourceSize = box.endCol - box.startCol + 1;
      } else if (sameRows && dest.endCol === box.endCol && dest.startCol < box.startCol) {
        direction = "left";
        sourceSize = box.endCol - box.startCol + 1;
      } else {
        throw new Error(
          `autoFill destination must include this range (${range.address}) and extend it in ` +
            `exactly one direction — like dragging the fill handle`,
        );
      }
      return fill(dest.startRow, dest.startCol, dest.endRow, dest.endCol, {
        direction,
        type: type ?? "series",
        sourceSize,
      });
    },
    async autoFit() {
      if (!t.autoFitColumns) {
        throw new Error(
          "autoFit() is not available for this range — its context provides value access only",
        );
      }
      return t.autoFitColumns(box.startCol, box.endCol);
    },
    // ---- Range-scoped ops (Wave 4): thin delegates over the optional
    //      transport ops, same honest-refusal style as format()/end(). ----
    async find(query, options) {
      if (!t.findInRange) {
        throw new Error(
          "find() is not available for this range — its context provides value access only",
        );
      }
      return t.findInRange(box.startRow, box.startCol, box.endRow, box.endCol, query, options);
    },
    async replace(search, replacement, options) {
      if (!t.replaceInRange) {
        throw new Error(
          "replace() is not available for this range — its context provides value access only",
        );
      }
      return t.replaceInRange(
        box.startRow, box.startCol, box.endRow, box.endCol, search, replacement, options,
      );
    },
    async removeDuplicates(options) {
      if (!t.removeDuplicates) {
        throw new Error(
          "removeDuplicates() is not available for this range — its context provides value access only",
        );
      }
      return t.removeDuplicates(box.startRow, box.startCol, box.endRow, box.endCol, options);
    },
    async textToColumns(options) {
      if (!t.textToColumns) {
        throw new Error(
          "textToColumns() is not available for this range — its context provides value access only",
        );
      }
      return t.textToColumns(box.startRow, box.startCol, box.endRow, box.endCol, options);
    },
    async specialCells(kind) {
      if (!t.specialCells) {
        throw new Error(
          "specialCells() is not available for this range — its context provides value access only",
        );
      }
      return t.specialCells(box.startRow, box.startCol, box.endRow, box.endCol, kind);
    },
    async goalSeek(targetValue, changingCell) {
      if (!t.goalSeek) {
        throw new Error(
          "goalSeek() is not available for this range — its context provides value access only",
        );
      }
      // The TARGET is this range's top-left cell (VBA Range.GoalSeek is a
      // single-cell method); the CHANGING cell must be exactly one cell.
      const dest =
        typeof changingCell === "string"
          ? parseA1(changingCell)
          : boxFromRangeValue(changingCell, "goalSeek");
      if (dest.startRow !== dest.endRow || dest.startCol !== dest.endCol) {
        throw new Error("goalSeek changing cell must be a single cell");
      }
      return t.goalSeek(box.startRow, box.startCol, targetValue, dest.startRow, dest.startCol);
    },
    async group() {
      if (!t.groupRows) {
        throw new Error(
          "group() is not available for this range — its context provides value access only",
        );
      }
      return t.groupRows(box.startRow, box.endRow);
    },
    async ungroup() {
      if (!t.ungroupRows) {
        throw new Error(
          "ungroup() is not available for this range — its context provides value access only",
        );
      }
      return t.ungroupRows(box.startRow, box.endRow);
    },
  };
  /** Insist the transport can fill, in the same honest-refusal style the
   *  format()/end() paths use. */
  function requireFill(label: string): NonNullable<RangeTransport["fillRange"]> {
    if (!t.fillRange) {
      throw new Error(
        `${label}() is not available for this range — its context provides value access only`,
      );
    }
    return t.fillRange;
  }
  return range;
}

/** Build a ScriptRange from an A1 address over a PINNED transport. A "Sheet!"
 *  prefix throws (see parseA1) — a pinned transport has no other sheet to
 *  rebind to, and silently dropping the prefix wrote to the wrong sheet. */
export function rangeFromAddress(t: RangeTransport, address: string): ScriptRange {
  return makeRange(t, parseA1(address));
}

// ---------------------------------------------------------------------------
// Workbook / Sheet navigation (the cross-object canonical model — unlocked tier)
// ---------------------------------------------------------------------------

/** Where ScriptSheet.move() puts the sheet: an absolute tab-bar position, or a
 *  position relative to another sheet (named or indexed). */
export type SheetMoveTarget =
  | number
  | { before: number | string }
  | { after: number | string };

/**
 * A worksheet facet: the navigation level above a ScriptRange — and, since
 * Wave 2, a HANDLE the script can hold and drive (VBA's "Set ws = ..." idiom):
 * rename/delete/move/copy/visibility/tab colour, all thin delegates over the
 * flat api.* rows.
 *
 * IDENTITY IS THE NAME. Every management delegate passes the sheet's NAME to
 * the flat row (which resolves it host-side, per call, against the live list),
 * never the index it was built with — so a concurrent tab re-order does not
 * redirect a rename/delete/move to whatever sheet now occupies the old
 * position. `rename()` re-points the handle at the new name; `index` stays the
 * construction-time position (re-read via workbook.sheet(...) after a move).
 */
export interface ScriptSheet {
  readonly index: number;
  readonly name: string;
  /** A range on this sheet by A1 address. A "Sheet!" prefix is RESOLVED, never
   *  silently dropped: naming this sheet stays here; naming another existing
   *  sheet REBINDS the returned range to that sheet; an unknown name throws
   *  listing the workbook's sheets. */
  range(address: string): ScriptRange;
  /** A single cell on this sheet (0-based). */
  cell(row: number, col: number): ScriptRange;
  /** Make this the active sheet. */
  activate(): Promise<void>;
  // ---- Wave 2: the rich sheet facet ----
  /** The rectangle of cells this sheet actually uses, as a live ScriptRange —
   *  null when the sheet stores nothing at all. */
  usedRange(): Promise<ScriptRange | null>;
  /** Rename this sheet. The handle follows the new name. */
  rename(newName: string): Promise<void>;
  /** Delete this sheet and everything on it (rejects on the last sheet). */
  delete(): Promise<void>;
  /** This sheet's current visibility. */
  visibility(): Promise<SheetVisibility>;
  /** Show or hide this sheet (rejects hiding the last visible one). */
  setVisibility(visibility: SheetVisibility): Promise<void>;
  /** This sheet's tab colour ("#RRGGBB"), or null when it has none. */
  tabColor(): Promise<string | null>;
  /** Change this sheet's tab colour (null removes it). */
  setTabColor(color: string | null): Promise<void>;
  /** Move this sheet: to an absolute position, or `{ before: "Sheet" }` /
   *  `{ after: 2 }` relative to another sheet. Indexes held elsewhere are
   *  stale afterwards. */
  move(to: SheetMoveTarget): Promise<void>;
  /** Duplicate this sheet (cells, formatting, objects) as a new sheet placed
   *  immediately after it. Resolves to the copy's index and name. */
  copy(newName?: string): Promise<{ index: number; name: string }>;
  // ---- Wave 3: structural ops ON THIS SHEET (no activate-dance). Thin
  //      delegates over the sheet-addressable flat rows, identity passed by
  //      NAME like every management delegate above.
  /** Insert `count` rows at `startRow` ON THIS SHEET. */
  insertRows(startRow: number, count: number): Promise<void>;
  /** Delete `count` rows from `startRow` ON THIS SHEET. */
  deleteRows(startRow: number, count: number): Promise<void>;
  /** Insert `count` columns at `startCol` ON THIS SHEET. */
  insertColumns(startCol: number, count: number): Promise<void>;
  /** Delete `count` columns from `startCol` ON THIS SHEET. */
  deleteColumns(startCol: number, count: number): Promise<void>;
  /** Merge a rectangle ON THIS SHEET (only the top-left value survives). */
  mergeCells(startRow: number, startCol: number, endRow: number, endCol: number): Promise<void>;
  /** Unmerge the merged region containing (row, col) ON THIS SHEET. */
  unmergeCells(row: number, col: number): Promise<void>;
  /** Sort a rectangle ON THIS SHEET; resolves to the rows/columns moved. */
  sortRange(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    fields: SheetSortField[],
    options?: SheetSortOptions,
  ): Promise<number>;
  /** Clear a rectangle ON THIS SHEET (everything / contents / formats). */
  clearRange(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    options?: SheetClearOptions,
  ): Promise<{ count: number }>;
  /** Find every matching cell ON THIS SHEET. */
  findAll(query: string, options?: SheetFindOptions): Promise<SheetFindResult>;
  /** Replace everywhere ON THIS SHEET (one undo step). */
  replaceAll(
    search: string,
    replacement: string,
    options?: { caseSensitive?: boolean; matchEntireCell?: boolean },
  ): Promise<{ replacementCount: number }>;
  // ---- Wave 3 (item 11): the double-click best-fit, sheet-wide spans. ----
  /** Size an inclusive column span to fit its contents ON THIS SHEET — the
   *  double-click measurement (extension chrome included). ACTIVE sheet only:
   *  measurement needs the rendered sheet, so another sheet is refused. */
  autoFitColumns(startCol: number, endCol: number): Promise<FillCount>;
  /** Size an inclusive row span to fit its contents ON THIS SHEET (empty rows
   *  reset to the default height). ACTIVE sheet only, like autoFitColumns. */
  autoFitRows(startRow: number, endRow: number): Promise<FillCount>;
}

/** The workbook facet: navigate Workbook -> Sheet -> Range across sheets. */
export interface ScriptWorkbook {
  /** All sheets, in tab order. */
  sheets(): Promise<ScriptSheet[]>;
  /** The active sheet. */
  activeSheet(): Promise<ScriptSheet>;
  /** A sheet by exact name or 0-based index; null if not found. */
  sheet(nameOrIndex: string | number): Promise<ScriptSheet | null>;
}

/**
 * The injected transport behind Workbook navigation. The shim wires these to
 * broker aspects: getSheetNames/getActiveSheet/setActiveSheet to the unlocked
 * `api.*` aspects, and readCell/writeCell to `sheet.getCellValue`/`setCellValue`
 * WITH a sheetIndex — cross-sheet access the host permits only for unlocked
 * scripts (this transport is only ever wired for the unlocked tier).
 */
export interface WorkbookTransport {
  getSheetNames(): Promise<string[]>;
  getActiveSheet(): Promise<number>;
  setActiveSheet(index: number): Promise<void>;
  readCell(sheetIndex: number, row: number, col: number): Promise<string>;
  writeCell(sheetIndex: number, row: number, col: number, value: string): Promise<void>;
  /** Typed rectangle read on one sheet, in ONE call. */
  readRange(
    sheetIndex: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ): Promise<ScriptCell[][]>;
  /** Block write on one sheet, in ONE call (one undo step). */
  writeCells(
    sheetIndex: number,
    startRow: number,
    startCol: number,
    values: Array<Array<string | undefined>>,
  ): Promise<void>;
  /** Apply a partial format to a rectangle on one sheet (B2). */
  formatRange(
    sheetIndex: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    format: ScriptFormat,
  ): Promise<void>;
  /** Strip all formatting from a rectangle on one sheet (B2). */
  clearFormatRange(
    sheetIndex: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ): Promise<void>;
  /** Read a rectangle's formats on one sheet (Wave 3). Optional like the
   *  Wave-2 members below: a lean transport keeps the honest throw. */
  readFormats?(
    sheetIndex: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ): Promise<ScriptCellFormat[][]>;
  /** Apply a NAMED cell style to a rectangle on one sheet (Wave 4). The host
   *  refuses a non-active target (the backend command is active-sheet-only). */
  applyNamedStyle?(
    sheetIndex: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    name: string,
  ): Promise<void>;
  // ---- Wave 2 (all OPTIONAL, like RangeTransport's bulk paths: a transport
  //      without them makes the facet methods throw an honest error, never
  //      answer wrongly). The sheet-management ops take a sheet REF — index or
  //      NAME, resolved host-side per call — because the rich ScriptSheet
  //      facet holds its sheet BY NAME: a concurrent tab re-order must not
  //      redirect a rename/delete/move to whatever sheet now sits at the old
  //      index. ----
  /** Where Ctrl+Arrow would land on one sheet (api.getRangeEdge). */
  rangeEdge?(
    sheetIndex: number,
    row: number,
    col: number,
    direction: EdgeDirection,
  ): Promise<CellPoint>;
  /** The contiguous data block around a cell on one sheet (api.getCurrentRegion). */
  currentRegion?(sheetIndex: number, row: number, col: number): Promise<RegionResult>;
  /** The bounding box of everything stored on a sheet (api.getUsedRange). */
  usedRange?(sheet: number | string): Promise<RegionResult>;
  /** Select a rectangle on one sheet, activating it first if needed (api.select). */
  selectRange?(
    sheetIndex: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    scroll: boolean,
  ): Promise<void>;
  /** The rich sheet listing (api.getSheets): visibility + tab colour. */
  getSheetInfos?(): Promise<WorkbookSheetInfo[]>;
  /** Rename a sheet (api.renameSheet). */
  renameSheet?(sheet: number | string, newName: string): Promise<void>;
  /** Delete a sheet and everything on it (api.deleteSheet). */
  deleteSheet?(sheet: number | string): Promise<void>;
  /** Show or hide a sheet (api.setSheetVisibility). */
  setSheetVisibility?(sheet: number | string, visibility: SheetVisibility): Promise<void>;
  /** Move a sheet to a tab-bar position (api.moveSheet). */
  moveSheet?(sheet: number | string, toIndex: number): Promise<void>;
  /** Duplicate a sheet (api.copySheet). */
  copySheet?(sheet: number | string, newName?: string): Promise<{ index: number; name: string }>;
  /** Change or remove a sheet's tab colour (api.setTabColor). */
  setTabColor?(sheet: number | string, color: string | null): Promise<void>;
  // ---- Wave 3: sheet-addressable STRUCTURAL + DATA ops, so the rich sheet
  //      facet can drive its own sheet without the activate-dance. Same
  //      optionality contract as everything above; the facet passes its NAME.
  /** Insert rows on one sheet (api.insertRows). */
  insertRows?(sheet: number | string, startRow: number, count: number): Promise<void>;
  /** Delete rows on one sheet (api.deleteRows). */
  deleteRows?(sheet: number | string, startRow: number, count: number): Promise<void>;
  /** Insert columns on one sheet (api.insertColumns). */
  insertColumns?(sheet: number | string, startCol: number, count: number): Promise<void>;
  /** Delete columns on one sheet (api.deleteColumns). */
  deleteColumns?(sheet: number | string, startCol: number, count: number): Promise<void>;
  /** Merge a rectangle on one sheet (api.mergeCells). */
  mergeCells?(
    sheet: number | string,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ): Promise<void>;
  /** Unmerge the region containing a cell on one sheet (api.unmergeCells). */
  unmergeCells?(sheet: number | string, row: number, col: number): Promise<void>;
  /** Sort a rectangle on one sheet (api.sortRange). */
  sortRange?(
    sheet: number | string,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    fields: SheetSortField[],
    options?: SheetSortOptions,
  ): Promise<number>;
  /** Clear a rectangle on one sheet (api.clearRange). */
  clearRange?(
    sheet: number | string,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    options?: SheetClearOptions,
  ): Promise<{ count: number }>;
  /** Find every match on one sheet (api.findAll). */
  findAll?(sheet: number | string, query: string, options?: SheetFindOptions): Promise<SheetFindResult>;
  /** Replace everywhere on one sheet (api.replaceAll). */
  replaceAll?(
    sheet: number | string,
    search: string,
    replacement: string,
    options?: { caseSensitive?: boolean; matchEntireCell?: boolean },
  ): Promise<{ replacementCount: number }>;
  /** Set/clear a data-validation rule on a rectangle of one sheet
   *  (api.setDataValidation / api.clearDataValidation). */
  setValidation?(
    sheetIndex: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    rule: ScriptValidationRule | null,
  ): Promise<void>;
  /** Read one cell's data-validation rule on one sheet (api.getDataValidation). */
  readValidation?(sheetIndex: number, row: number, col: number): Promise<ScriptValidationRule | null>;
  // ---- Wave 3 (items 10/11): fill + auto-fit. Same optionality contract. ----
  /** Fill a rectangle from its leading band on one sheet (api.fillRange). */
  fillRange?(
    sheetIndex: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    options: RangeFillOptions,
  ): Promise<FillCount>;
  /** Best-fit a column span to its contents on one sheet (api.autoFitColumns). */
  autoFitColumns?(sheet: number | string, startCol: number, endCol: number): Promise<FillCount>;
  /** Best-fit a row span to its contents on one sheet (api.autoFitRows). */
  autoFitRows?(sheet: number | string, startRow: number, endRow: number): Promise<FillCount>;
  // ---- Range-scoped ops (Wave 4). Same optionality contract. ----
  /** Find inside a rectangle of one sheet (api.findAll + range option). */
  findInRange?(
    sheetIndex: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    query: string,
    options?: RangeFindOptions,
  ): Promise<SheetFindResult>;
  /** Replace inside a rectangle of one sheet (api.replaceAll + range option). */
  replaceInRange?(
    sheetIndex: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    search: string,
    replacement: string,
    options?: RangeReplaceOptions,
  ): Promise<{ replacementCount: number }>;
  /** Remove duplicate rows from a rectangle (api.removeDuplicates). */
  removeDuplicates?(
    sheetIndex: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    options?: RangeRemoveDuplicatesOptions,
  ): Promise<RemoveDuplicatesCount>;
  /** Split a one-column rectangle by delimiters (api.textToColumns). */
  textToColumns?(
    sheetIndex: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    options?: RangeTextToColumnsOptions,
  ): Promise<TextToColumnsCount>;
  /** The cells of one class inside a rectangle (api.getSpecialCells). */
  specialCells?(
    sheetIndex: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    kind: SpecialCellsKind,
  ): Promise<SpecialCellsAnswer>;
  /** Goal Seek on one sheet (api.goalSeek). */
  goalSeek?(
    sheetIndex: number,
    targetRow: number,
    targetCol: number,
    targetValue: number,
    variableRow: number,
    variableCol: number,
  ): Promise<GoalSeekOutcome>;
  /** Group a row band on one sheet (api.groupRows — ACTIVE sheet only,
   *  refused host-side otherwise). */
  groupRows?(sheetIndex: number, startRow: number, endRow: number): Promise<RangeGroupResult>;
  /** Ungroup a row band on one sheet (api.ungroupRows). */
  ungroupRows?(sheetIndex: number, startRow: number, endRow: number): Promise<RangeGroupResult>;
}

/** The per-sheet RangeTransport a WorkbookTransport implies for ONE sheet:
 *  every call carries `index` as its sheet argument. */
export function sheetRangeTransport(t: WorkbookTransport, index: number): RangeTransport {
  return {
    readCell: (row, col) => t.readCell(index, row, col),
    writeCell: (row, col, value) => t.writeCell(index, row, col, value),
    readRange: (sr, sc, er, ec) => t.readRange(index, sr, sc, er, ec),
    writeCells: (sr, sc, values) => t.writeCells(index, sr, sc, values),
    formatRange: (sr, sc, er, ec, format) => t.formatRange(index, sr, sc, er, ec, format),
    clearFormatRange: (sr, sc, er, ec) => t.clearFormatRange(index, sr, sc, er, ec),
    readFormats: t.readFormats
      ? (sr, sc, er, ec) => t.readFormats!(index, sr, sc, er, ec)
      : undefined,
    // Wave 4: named-style sugar, same forwarding contract as readFormats.
    applyNamedStyle: t.applyNamedStyle
      ? (sr, sc, er, ec, name) => t.applyNamedStyle!(index, sr, sc, er, ec, name)
      : undefined,
    // Wave 3: validation sugar, same forwarding contract as readFormats.
    setValidation: t.setValidation
      ? (sr, sc, er, ec, rule) => t.setValidation!(index, sr, sc, er, ec, rule)
      : undefined,
    readValidation: t.readValidation
      ? (row, col) => t.readValidation!(index, row, col)
      : undefined,
    // Wave 2: forwarded only when the workbook transport provides them, so a
    // range built over a lean transport keeps throwing the honest
    // "not available for this range" error instead of a TypeError.
    rangeEdge: t.rangeEdge
      ? (row, col, direction) => t.rangeEdge!(index, row, col, direction)
      : undefined,
    currentRegion: t.currentRegion
      ? (row, col) => t.currentRegion!(index, row, col)
      : undefined,
    selectRange: t.selectRange
      ? (sr, sc, er, ec, scroll) => t.selectRange!(index, sr, sc, er, ec, scroll)
      : undefined,
    // Wave 3: fill + auto-fit, same forwarding contract.
    fillRange: t.fillRange
      ? (sr, sc, er, ec, options) => t.fillRange!(index, sr, sc, er, ec, options)
      : undefined,
    autoFitColumns: t.autoFitColumns
      ? (startCol, endCol) => t.autoFitColumns!(index, startCol, endCol)
      : undefined,
    // Wave 4: range-scoped ops, same forwarding contract.
    findInRange: t.findInRange
      ? (sr, sc, er, ec, query, options) => t.findInRange!(index, sr, sc, er, ec, query, options)
      : undefined,
    replaceInRange: t.replaceInRange
      ? (sr, sc, er, ec, search, replacement, options) =>
          t.replaceInRange!(index, sr, sc, er, ec, search, replacement, options)
      : undefined,
    removeDuplicates: t.removeDuplicates
      ? (sr, sc, er, ec, options) => t.removeDuplicates!(index, sr, sc, er, ec, options)
      : undefined,
    textToColumns: t.textToColumns
      ? (sr, sc, er, ec, options) => t.textToColumns!(index, sr, sc, er, ec, options)
      : undefined,
    specialCells: t.specialCells
      ? (sr, sc, er, ec, kind) => t.specialCells!(index, sr, sc, er, ec, kind)
      : undefined,
    goalSeek: t.goalSeek
      ? (targetRow, targetCol, targetValue, variableRow, variableCol) =>
          t.goalSeek!(index, targetRow, targetCol, targetValue, variableRow, variableCol)
      : undefined,
    // Wave 4: outline grouping sugar (rows only — see ScriptRange.group()).
    groupRows: t.groupRows
      ? (startRow, endRow) => t.groupRows!(index, startRow, endRow)
      : undefined,
    ungroupRows: t.ungroupRows
      ? (startRow, endRow) => t.ungroupRows!(index, startRow, endRow)
      : undefined,
  };
}

function makeSheet(
  t: WorkbookTransport,
  index: number,
  name: string,
  names: string[],
): ScriptSheet {
  const transport = sheetRangeTransport(t, index);
  // The handle's identity. rename() re-points it, and every management
  // delegate below passes THIS name to the flat row — resolved host-side per
  // call — so a concurrent tab re-order cannot redirect the call to whatever
  // sheet now sits at the construction-time index.
  let currentName = name;
  /** Insist an optional transport op exists, with the same honest-refusal
   *  style the range paths use. */
  function requireOp<T>(op: T | undefined, label: string): T {
    if (!op) {
      throw new Error(
        `${label}() is not available for this sheet — its context provides navigation only`,
      );
    }
    return op;
  }
  /** This sheet's CURRENT listing entry, found by name (never by position). */
  async function ownInfo(label: string): Promise<WorkbookSheetInfo> {
    const infos = await requireOp(t.getSheetInfos, label).call(t);
    const own = infos.find((s) => s.name === currentName);
    if (!own) {
      throw new Error(
        `Sheet "${currentName}" no longer exists. Sheets in this workbook: ` +
          sheetNamesForError(infos.map((s) => s.name)),
      );
    }
    return own;
  }
  return {
    index,
    get name() {
      return currentName;
    },
    // A "Sheet!" prefix must RESOLVE, never silently drop (dropping it sent a
    // sheet("Alpha").range("Beta!A1") write to Alpha — the WRONG sheet):
    // naming this sheet stays here; naming ANOTHER existing sheet rebinds the
    // returned range to that sheet (this call shape returns a fresh range
    // carrying its own transport, so it can); an unknown name throws listing
    // the workbook's sheets. The TWIN of this decision table lives in
    // core/script-engine/src/ops/canonical_model.rs `parse_a1` — both realms
    // must agree, case for case.
    range: (address) => {
      const { sheetName, rest } = splitSheetPrefix(address);
      const target = sheetName === null ? index : resolveSheetName(names, sheetName);
      const box = parseA1Body(rest);
      return makeRange(target === index ? transport : sheetRangeTransport(t, target), box);
    },
    cell: (row, col) =>
      makeRange(transport, { startRow: row, startCol: col, endRow: row, endCol: col }),
    activate: () => t.setActiveSheet(index),
    // ---- Wave 2: the rich sheet facet (thin delegates over the flat rows,
    //      identity passed by NAME — see the interface note) ----
    async usedRange() {
      const used = await requireOp(t.usedRange, "usedRange").call(t, currentName);
      if (used.empty) return null;
      // Bind the returned range to the sheet's CURRENT index (re-resolved by
      // name), not the construction-time one — a re-order between then and now
      // must not hand back a range that reads a different sheet.
      const liveNames = await t.getSheetNames();
      const liveIndex = resolveSheetName(liveNames, currentName);
      return makeRange(sheetRangeTransport(t, liveIndex), {
        startRow: used.startRow,
        startCol: used.startCol,
        endRow: used.endRow,
        endCol: used.endCol,
      });
    },
    async rename(newName) {
      await requireOp(t.renameSheet, "rename").call(t, currentName, newName);
      currentName = newName;
    },
    async delete() {
      await requireOp(t.deleteSheet, "delete").call(t, currentName);
    },
    async visibility() {
      return (await ownInfo("visibility")).visibility;
    },
    async setVisibility(visibility) {
      await requireOp(t.setSheetVisibility, "setVisibility").call(t, currentName, visibility);
    },
    async tabColor() {
      return (await ownInfo("tabColor")).tabColor;
    },
    async setTabColor(color) {
      await requireOp(t.setTabColor, "setTabColor").call(t, currentName, color);
    },
    async move(to) {
      const moveSheet = requireOp(t.moveSheet, "move");
      if (typeof to === "number") {
        await moveSheet.call(t, currentName, to);
        return;
      }
      // Relative form. The anchor and this sheet are located in ONE listing
      // read, and the destination is computed for the backend's
      // remove-then-insert semantics (move_sheet rotates the element to
      // to_index): removing a sheet that sits BEFORE the anchor shifts the
      // anchor down by one.
      const infos = await requireOp(t.getSheetInfos, "move").call(t);
      const listNames = infos.map((s) => s.name);
      const self = listNames.indexOf(currentName);
      if (self === -1) {
        throw new Error(
          `Sheet "${currentName}" no longer exists. Sheets in this workbook: ` +
            sheetNamesForError(listNames),
        );
      }
      const anchorRef = "before" in to ? to.before : to.after;
      let anchor: number;
      if (typeof anchorRef === "number") {
        if (!Number.isInteger(anchorRef) || anchorRef < 0 || anchorRef >= infos.length) {
          throw new Error(
            `No sheet at position ${anchorRef}. Sheets in this workbook: ` +
              sheetNamesForError(listNames),
          );
        }
        anchor = anchorRef;
      } else {
        anchor = resolveSheetName(listNames, anchorRef);
      }
      if (anchor === self) {
        throw new Error(`Cannot move sheet "${currentName}" relative to itself`);
      }
      const toIndex =
        "before" in to
          ? self < anchor
            ? anchor - 1
            : anchor
          : self < anchor
            ? anchor
            : anchor + 1;
      await moveSheet.call(t, currentName, toIndex);
    },
    async copy(newName) {
      return requireOp(t.copySheet, "copy").call(t, currentName, newName);
    },
    // ---- Wave 3: structural delegates, identity by NAME like the rest ----
    async insertRows(startRow, count) {
      await requireOp(t.insertRows, "insertRows").call(t, currentName, startRow, count);
    },
    async deleteRows(startRow, count) {
      await requireOp(t.deleteRows, "deleteRows").call(t, currentName, startRow, count);
    },
    async insertColumns(startCol, count) {
      await requireOp(t.insertColumns, "insertColumns").call(t, currentName, startCol, count);
    },
    async deleteColumns(startCol, count) {
      await requireOp(t.deleteColumns, "deleteColumns").call(t, currentName, startCol, count);
    },
    async mergeCells(startRow, startCol, endRow, endCol) {
      await requireOp(t.mergeCells, "mergeCells").call(t, currentName, startRow, startCol, endRow, endCol);
    },
    async unmergeCells(row, col) {
      await requireOp(t.unmergeCells, "unmergeCells").call(t, currentName, row, col);
    },
    async sortRange(startRow, startCol, endRow, endCol, fields, options) {
      return requireOp(t.sortRange, "sortRange").call(
        t, currentName, startRow, startCol, endRow, endCol, fields, options,
      );
    },
    async clearRange(startRow, startCol, endRow, endCol, options) {
      return requireOp(t.clearRange, "clearRange").call(
        t, currentName, startRow, startCol, endRow, endCol, options,
      );
    },
    async findAll(query, options) {
      return requireOp(t.findAll, "findAll").call(t, currentName, query, options);
    },
    async replaceAll(search, replacement, options) {
      return requireOp(t.replaceAll, "replaceAll").call(t, currentName, search, replacement, options);
    },
    // ---- Wave 3 (item 11): best-fit delegates, identity by NAME like the
    //      rest (the host refuses a name that is not the active sheet). ----
    async autoFitColumns(startCol, endCol) {
      return requireOp(t.autoFitColumns, "autoFitColumns").call(t, currentName, startCol, endCol);
    },
    async autoFitRows(startRow, endRow) {
      return requireOp(t.autoFitRows, "autoFitRows").call(t, currentName, startRow, endRow);
    },
  };
}

/** Build the Workbook navigation facet over an injected transport. */
export function makeWorkbook(t: WorkbookTransport): ScriptWorkbook {
  return {
    async sheets() {
      const names = await t.getSheetNames();
      return names.map((name, i) => makeSheet(t, i, name, names));
    },
    async activeSheet() {
      const [names, active] = await Promise.all([t.getSheetNames(), t.getActiveSheet()]);
      const idx = active >= 0 && active < names.length ? active : 0;
      return makeSheet(t, idx, names[idx] ?? "", names);
    },
    async sheet(nameOrIndex) {
      const names = await t.getSheetNames();
      const idx =
        typeof nameOrIndex === "number" ? nameOrIndex : names.indexOf(nameOrIndex);
      if (idx < 0 || idx >= names.length) return null;
      return makeSheet(t, idx, names[idx], names);
    },
  };
}
