//! FILENAME: app/src/core/lib/r1c1.ts
// PURPOSE: A1 <-> R1C1 reference-style conversion for formula display and the
//          edit round-trip (formula bar + grid "Show Formulas" mode).
// CONTEXT: Core lib, pure (no shell/extension imports). Ported from the Rust
//          implementation in app/src-tauri/src/r1c1.rs so the frontend can
//          render/parse R1C1 at display/commit time without a per-cell backend
//          round-trip. All base rows/cols are 0-based.

/** Convert a 0-based column index to letters (0 -> "A", 25 -> "Z", 26 -> "AA"). */
export function colIndexToLetter(col: number): string {
  let result = "";
  let c = col;
  for (;;) {
    result = String.fromCharCode(65 + (c % 26)) + result;
    if (c < 26) break;
    c = Math.floor(c / 26) - 1;
  }
  return result;
}

/** Convert a column letter string ("A", "AA", "XFD") to a 0-based index. */
export function letterToColIndex(letters: string): number {
  let result = 0;
  for (const ch of letters) {
    const val = ch.toUpperCase().charCodeAt(0) - 65 + 1;
    result = result * 26 + val;
  }
  return result - 1;
}

const A1_REF_RE = /^(\$?)([A-Za-z]+)(\$?)(\d+)$/;

/** Convert a single A1 reference (e.g. "$A$1", "B7") to R1C1, relative to a base cell. */
export function refA1ToR1C1(reference: string, baseRow: number, baseCol: number): string {
  const m = A1_REF_RE.exec(reference);
  if (!m) return reference;

  const colAbs = m[1] === "$";
  const rowAbs = m[3] === "$";
  const colIdx = letterToColIndex(m[2]);
  const rowIdx = (parseInt(m[4], 10) || 1) - 1;

  const rowDiff = rowIdx - baseRow;
  const colDiff = colIdx - baseCol;

  const rowPart = rowAbs
    ? `R${rowIdx + 1}`
    : rowDiff === 0
      ? "R"
      : `R[${rowDiff}]`;
  const colPart = colAbs
    ? `C${colIdx + 1}`
    : colDiff === 0
      ? "C"
      : `C[${colDiff}]`;

  return `${rowPart}${colPart}`;
}

const R1C1_REF_RE = /^R(\[(-?\d+)\]|(\d+))?C(\[(-?\d+)\]|(\d+))?$/i;

/** Convert a single R1C1 reference (e.g. "R1C1", "R[-1]C[2]", "RC") to A1, relative to a base cell. */
export function refR1C1ToA1(reference: string, baseRow: number, baseCol: number): string {
  const m = R1C1_REF_RE.exec(reference);
  if (!m) return reference;

  let rowIdx: number;
  let rowAbs: boolean;
  if (m[2] !== undefined) {
    rowIdx = Math.max(0, baseRow + (parseInt(m[2], 10) || 0));
    rowAbs = false;
  } else if (m[3] !== undefined) {
    rowIdx = Math.max(0, (parseInt(m[3], 10) || 1) - 1);
    rowAbs = true;
  } else {
    rowIdx = baseRow;
    rowAbs = false;
  }

  let colIdx: number;
  let colAbs: boolean;
  if (m[5] !== undefined) {
    colIdx = Math.max(0, baseCol + (parseInt(m[5], 10) || 0));
    colAbs = false;
  } else if (m[6] !== undefined) {
    colIdx = Math.max(0, (parseInt(m[6], 10) || 1) - 1);
    colAbs = true;
  } else {
    colIdx = baseCol;
    colAbs = false;
  }

  return `${colAbs ? "$" : ""}${colIndexToLetter(colIdx)}${rowAbs ? "$" : ""}${rowIdx + 1}`;
}

/**
 * Split a formula body into runs, converting only the parts OUTSIDE string
 * literals (so "A1" inside a "..." text literal is left untouched).
 */
function convertOutsideStrings(body: string, convertSegment: (seg: string) => string): string {
  let result = "";
  let inString = false;
  let segment = "";
  for (const ch of body) {
    if (ch === '"') {
      if (inString) {
        segment += ch;
        result += segment;
        segment = "";
        inString = false;
      } else {
        result += convertSegment(segment);
        segment = ch;
        inString = true;
      }
    } else {
      segment += ch;
    }
  }
  result += inString ? segment : convertSegment(segment);
  return result;
}

/** Preserve a leading "=" so callers can pass a full formula. */
function splitEquals(formula: string): [prefix: string, body: string] {
  return formula.startsWith("=") ? ["=", formula.slice(1)] : ["", formula];
}

const A1_FORMULA_RE = /\$?[A-Za-z]{1,3}\$?\d+/g;

/** Convert every A1 reference in a formula to R1C1, relative to the cell at (baseRow, baseCol). */
export function formulaA1ToR1C1(formula: string, baseRow: number, baseCol: number): string {
  const [prefix, body] = splitEquals(formula);
  const convertSegment = (seg: string): string =>
    seg.replace(A1_FORMULA_RE, (match: string, offset: number) => {
      // Not a reference if it is part of a name/function (preceded by a letter
      // or underscore, or immediately followed by "(" as in LOG10() / an identifier).
      const prev = offset > 0 ? seg[offset - 1] : "";
      if (/[A-Za-z_]/.test(prev)) return match;
      const next = seg[offset + match.length] ?? "";
      if (next === "(" || /[A-Za-z_]/.test(next)) return match;
      return refA1ToR1C1(match, baseRow, baseCol);
    });
  return prefix + convertOutsideStrings(body, convertSegment);
}

const R1C1_FORMULA_RE = /R(\[-?\d+\]|\d+)?C(\[-?\d+\]|\d+)?/gi;

/** Convert every R1C1 reference in a formula back to A1, relative to the cell at (baseRow, baseCol). */
export function formulaR1C1ToA1(formula: string, baseRow: number, baseCol: number): string {
  const [prefix, body] = splitEquals(formula);
  const convertSegment = (seg: string): string =>
    // R1C1_FORMULA_RE has two capture groups, so `offset` is the 4th callback arg.
    seg.replace(R1C1_FORMULA_RE, (match: string, _g1: string, _g2: string, offset: number) => {
      // Skip R/C that are part of a function name or identifier.
      const prev = offset > 0 ? seg[offset - 1] : "";
      if (/[A-Za-z0-9_]/.test(prev)) return match;
      const next = seg[offset + match.length] ?? "";
      if (/[A-Za-z_]/.test(next)) return match;
      return refR1C1ToA1(match, baseRow, baseCol);
    });
  return prefix + convertOutsideStrings(body, convertSegment);
}
