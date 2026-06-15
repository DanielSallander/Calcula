//! FILENAME: app/src/api/scriptHost/worker/canonicalModel.ts
// PURPOSE: The worker-realm binding of Calcula's canonical Range/Cell model
//          (C3 step 3). Object scripts get the SAME Workbook -> Sheet -> Range
//          -> Cell shape extensions use (api/range.ts), so an author who learns
//          `range.setValues(...)` in one runtime carries it to the other.
// CONTEXT: The object-script worker CANNOT call Tauri directly (no `./lib`); it
//          reaches the host only by broker RPC. So this is a SEPARATE
//          implementation of the same model, backed by injected read/write
//          functions that the context shim wires to already-allowlisted broker
//          aspects (sheet.getCellValue / sheet.setCellValue — restricted,
//          own-sheet). Pure + self-contained: no imports, so it is safe to run
//          inside the hardened worker realm. The single shared .d.ts that makes
//          all three runtimes agree on one model is C3 step 4.

/** Reads a cell's display value by 0-based row/col (resolved by the shim to a
 *  broker aspect). */
export type CellReader = (row: number, col: number) => Promise<string>;
/** Writes a cell's value by 0-based row/col. */
export type CellWriter = (row: number, col: number, value: string) => Promise<void>;

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
  /** All values as a rows x cols grid of display strings. */
  getValues(): Promise<string[][]>;
  /** Set the top-left cell's value. */
  setValue(value: string): Promise<void>;
  /** Set values from a 2D array (clamped to the range's dimensions). */
  setValues(values: string[][]): Promise<void>;
}

/** Build a ScriptRange over `box`, backed by the injected read/write fns. */
export function makeRange(read: CellReader, write: CellWriter, box: Box): ScriptRange {
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
      return makeRange(read, write, {
        startRow: box.startRow + rowOffset,
        startCol: box.startCol + colOffset,
        endRow: box.endRow + rowOffset,
        endCol: box.endCol + colOffset,
      });
    },
    resize(rows, cols) {
      return makeRange(read, write, {
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
      return makeRange(read, write, { startRow: row, startCol: col, endRow: row, endCol: col });
    },
    async getValue() {
      return read(box.startRow, box.startCol);
    },
    async getValues() {
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
    async setValue(value) {
      await write(box.startRow, box.startCol, value);
    },
    async setValues(values) {
      for (let r = 0; r < values.length && r < range.rowCount; r++) {
        const row = values[r];
        for (let c = 0; c < row.length && c < range.colCount; c++) {
          await write(box.startRow + r, box.startCol + c, row[c]);
        }
      }
    },
  };
  return range;
}

/** Build a ScriptRange from an A1 address. */
export function rangeFromAddress(
  read: CellReader,
  write: CellWriter,
  address: string,
): ScriptRange {
  return makeRange(read, write, parseA1(address));
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
}

function makeSheet(t: WorkbookTransport, index: number, name: string): ScriptSheet {
  const read: CellReader = (row, col) => t.readCell(index, row, col);
  const write: CellWriter = (row, col, value) => t.writeCell(index, row, col, value);
  return {
    index,
    name,
    range: (address) => rangeFromAddress(read, write, address),
    cell: (row, col) =>
      makeRange(read, write, { startRow: row, startCol: col, endRow: row, endCol: col }),
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
