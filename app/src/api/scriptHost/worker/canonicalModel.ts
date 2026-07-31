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
}

/**
 * A PARTIAL cell format (B2). Only the properties present are changed — an
 * absent key leaves that attribute alone, so `format({ bold: true })` never
 * resets the number format. Unknown keys are REJECTED by the broker (with the
 * accepted list) rather than ignored.
 *
 * Protection attributes (locked / formulaHidden) and the checkbox/button cell
 * controls are deliberately NOT part of this object: they are separate
 * surfaces with their own governance, not formatting.
 */
export interface ScriptFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: "none" | "single" | "double" | "singleAccounting" | "doubleAccounting";
  strikethrough?: boolean;
  /** Font size in POINTS (1-409). */
  fontSize?: number;
  fontFamily?: string;
  /** "#RRGGBB" or "#RRGGBBAA". */
  textColor?: string;
  backgroundColor?: string;
  textAlign?: "left" | "center" | "right" | "general";
  verticalAlign?: "top" | "middle" | "bottom";
  /** An Excel number-format code, e.g. "#,##0.00" or "General". */
  numberFormat?: string;
  wrapText?: boolean;
  textRotation?: "none" | "rotate90" | "rotate270";
  /** Indent steps (0-250). */
  indent?: number;
  shrinkToFit?: boolean;
  borderTop?: ScriptBorderSide;
  borderRight?: ScriptBorderSide;
  borderBottom?: ScriptBorderSide;
  borderLeft?: ScriptBorderSide;
  borderDiagonalDown?: ScriptBorderSide;
  borderDiagonalUp?: ScriptBorderSide;
}

/** One border edge. */
export interface ScriptBorderSide {
  style: "none" | "thin" | "medium" | "thick" | "dashed" | "dotted" | "double";
  /** "#RRGGBB" or "#RRGGBBAA". */
  color: string;
}

interface Box {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
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
  const m = ref.match(/^([A-Za-z]+)(\d+)$/);
  if (!m) throw new Error(`Invalid cell reference: "${ref}"`);
  return { row: parseInt(m[2], 10) - 1, col: lettersToCol(m[1]) };
}

/** Parse "A1", "A1:B5", "$A$1:$B$5" (a "Sheet!" prefix is ignored — a range
 *  built from a sheet context is bound to THAT sheet). */
export function parseA1(address: string): Box {
  let work = address.trim();
  const bang = work.indexOf("!");
  if (bang !== -1) work = work.slice(bang + 1);
  work = work.replace(/\$/g, "");
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
  };
  return range;
}

/** Build a ScriptRange from an A1 address. */
export function rangeFromAddress(t: RangeTransport, address: string): ScriptRange {
  return makeRange(t, parseA1(address));
}

// ---------------------------------------------------------------------------
// Workbook / Sheet navigation (the cross-object canonical model — unlocked tier)
// ---------------------------------------------------------------------------

/** A worksheet facet: the navigation level above a ScriptRange. */
export interface ScriptSheet {
  readonly index: number;
  readonly name: string;
  /** A range on THIS sheet by A1 address. */
  range(address: string): ScriptRange;
  /** A single cell on this sheet (0-based). */
  cell(row: number, col: number): ScriptRange;
  /** Make this the active sheet. */
  activate(): Promise<void>;
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
}

function makeSheet(t: WorkbookTransport, index: number, name: string): ScriptSheet {
  const transport: RangeTransport = {
    readCell: (row, col) => t.readCell(index, row, col),
    writeCell: (row, col, value) => t.writeCell(index, row, col, value),
    readRange: (sr, sc, er, ec) => t.readRange(index, sr, sc, er, ec),
    writeCells: (sr, sc, values) => t.writeCells(index, sr, sc, values),
    formatRange: (sr, sc, er, ec, format) => t.formatRange(index, sr, sc, er, ec, format),
    clearFormatRange: (sr, sc, er, ec) => t.clearFormatRange(index, sr, sc, er, ec),
  };
  return {
    index,
    name,
    range: (address) => rangeFromAddress(transport, address),
    cell: (row, col) =>
      makeRange(transport, { startRow: row, startCol: col, endRow: row, endCol: col }),
    activate: () => t.setActiveSheet(index),
  };
}

/** Build the Workbook navigation facet over an injected transport. */
export function makeWorkbook(t: WorkbookTransport): ScriptWorkbook {
  return {
    async sheets() {
      const names = await t.getSheetNames();
      return names.map((name, i) => makeSheet(t, i, name));
    },
    async activeSheet() {
      const [names, active] = await Promise.all([t.getSheetNames(), t.getActiveSheet()]);
      const idx = active >= 0 && active < names.length ? active : 0;
      return makeSheet(t, idx, names[idx] ?? "");
    },
    async sheet(nameOrIndex) {
      const names = await t.getSheetNames();
      const idx =
        typeof nameOrIndex === "number" ? nameOrIndex : names.indexOf(nameOrIndex);
      if (idx < 0 || idx >= names.length) return null;
      return makeSheet(t, idx, names[idx]);
    },
  };
}
