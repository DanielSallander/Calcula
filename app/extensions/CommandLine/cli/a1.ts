// FILENAME: app/extensions/CommandLine/cli/a1.ts
// PURPOSE: Small clean-room A1 reference parser for the app CLI domain:
//          "B3" -> {row:2,col:1}, "A1:C9" -> a rectangle, "Sheet2!A1" /
//          "'My Sheet'!A1:B2" -> sheet-qualified rectangles, plus formatters
//          for labels. All coordinates are 0-BASED rows/cols.
// CONTEXT: Deliberately local — the CLI must not deep-import core's reference
//          machinery (the Facade Rule), and the shapes it needs are tiny.
//          try* variants return null; the strict variants throw a plain Error
//          (callers wrap into CliError with the command's line number).

export interface CellRef {
  row: number;
  col: number;
}

export interface RangeRef {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface QualifiedRange {
  /** Sheet name when the reference was qualified ("Sheet2!A1"); else absent. */
  sheet?: string;
  range: RangeRef;
}

/** `$` absolute markers are accepted and ignored; letters are ci; up to 4
 *  letters ("XFD" is Excel's last column; headroom beyond it is harmless). */
const CELL_RE = /^\$?([A-Za-z]{1,4})\$?([0-9]{1,9})$/;

/** "A" -> 0, "Z" -> 25, "AA" -> 26. Null when not purely A-Z letters. */
export function colLetterToIndex(letters: string): number | null {
  if (letters.length === 0 || letters.length > 4) return null;
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) return null;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

/** 0 -> "A", 25 -> "Z", 26 -> "AA". */
export function indexToColLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function tryParseA1(text: string): CellRef | null {
  const m = CELL_RE.exec(text.trim());
  if (!m) return null;
  const col = colLetterToIndex(m[1]);
  if (col === null) return null;
  const row = parseInt(m[2], 10) - 1;
  if (row < 0) return null; // "A0"
  return { row, col };
}

export function parseA1(text: string): CellRef {
  const ref = tryParseA1(text);
  if (!ref) throw new Error(`'${text}' is not a cell reference (expected e.g. B3)`);
  return ref;
}

/** "A1:C9" or a single cell "A1". Reversed corners are normalized. */
export function tryParseRange(text: string): RangeRef | null {
  const t = text.trim();
  const colonAt = t.indexOf(":");
  if (colonAt < 0) {
    const c = tryParseA1(t);
    return c ? { startRow: c.row, startCol: c.col, endRow: c.row, endCol: c.col } : null;
  }
  const a = tryParseA1(t.slice(0, colonAt));
  const b = tryParseA1(t.slice(colonAt + 1));
  if (!a || !b) return null;
  return {
    startRow: Math.min(a.row, b.row),
    startCol: Math.min(a.col, b.col),
    endRow: Math.max(a.row, b.row),
    endCol: Math.max(a.col, b.col),
  };
}

export function parseRange(text: string): RangeRef {
  const r = tryParseRange(text);
  if (!r) throw new Error(`'${text}' is not a range (expected e.g. A1 or A1:C9)`);
  return r;
}

/**
 * "Sheet2!A1:B2" | "'My Sheet'!A1" (doubled '' = literal quote) | "A1".
 * A bare sheet name may contain spaces when it arrived pre-unquoted
 * ("My Sheet!A1" from a quoted CLI token).
 */
export function tryParseQualified(text: string): QualifiedRange | null {
  const t = text.trim();
  if (t.startsWith("'")) {
    let i = 1;
    let name = "";
    let closed = false;
    while (i < t.length) {
      if (t[i] === "'") {
        if (t[i + 1] === "'") {
          name += "'";
          i += 2;
          continue;
        }
        closed = true;
        break;
      }
      name += t[i];
      i++;
    }
    if (!closed || name === "" || t[i + 1] !== "!") return null;
    const range = tryParseRange(t.slice(i + 2));
    return range ? { sheet: name, range } : null;
  }
  const bang = t.indexOf("!");
  if (bang >= 0) {
    const name = t.slice(0, bang);
    if (name === "" || name.includes(":")) return null;
    const range = tryParseRange(t.slice(bang + 1));
    return range ? { sheet: name, range } : null;
  }
  const range = tryParseRange(t);
  return range ? { range } : null;
}

export function parseQualified(text: string): QualifiedRange {
  const q = tryParseQualified(text);
  if (!q) {
    throw new Error(`'${text}' is not a reference (expected e.g. A1, A1:C9 or Sheet2!A1)`);
  }
  return q;
}

export function formatA1(ref: CellRef): string {
  return indexToColLetter(ref.col) + String(ref.row + 1);
}

/** "A1" for a single cell, else "A1:C9". */
export function formatRange(r: Pick<RangeRef, "startRow" | "startCol" | "endRow" | "endCol">): string {
  const a = formatA1({ row: r.startRow, col: r.startCol });
  const b = formatA1({ row: r.endRow, col: r.endCol });
  return a === b ? a : `${a}:${b}`;
}

export function isSingleCell(r: RangeRef): boolean {
  return r.startRow === r.endRow && r.startCol === r.endCol;
}

/** Label a qualified range for output ("Sheet2!A1:B2", quoting spaced names). */
export function formatQualified(q: QualifiedRange): string {
  const range = formatRange(q.range);
  if (q.sheet === undefined) return range;
  const needsQuotes = /[\s']/.test(q.sheet);
  const sheet = needsQuotes ? `'${q.sheet.replace(/'/g, "''")}'` : q.sheet;
  return `${sheet}!${range}`;
}
