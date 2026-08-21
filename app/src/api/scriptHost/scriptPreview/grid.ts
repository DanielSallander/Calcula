//! FILENAME: app/src/api/scriptHost/scriptPreview/grid.ts
// PURPOSE: The cell vocabulary a preview backend stores and compares in — one
//          implementation, shared by the offline eval harness and the in-app
//          Worker-realm dry run.
// CONTEXT: docs/design/local-model-script-authoring.md §5c.
//
//          WHY THIS IS ITS OWN FILE. These semantics were arrived at by chasing
//          the Rust backend three separate times (numeric canonicalization, the
//          sort comparator, the used-range span), each time because a CORRECT
//          script graded WRONG. A second copy of them — one for the corpus, one
//          for the app — would drift on the first Rust change, and this project
//          has measured that shape often enough to name it: two implementations
//          of one truth is one implementation and one lie.
//
//          EVERYTHING here is pure and environment-free: no Worker, no Tauri, no
//          DOM. That is what lets the SAME semantics run inside a Node grading
//          subprocess and inside the renderer.

/**
 * One cell, stored as its INPUT STRING — the same canonical form
 * `cell_input_string` (Rust) renders: formulas "=...", integers without ".0",
 * text verbatim, TRUE/FALSE, "" for empty. Type is derived from the input the
 * way user entry derives it, so a `setCellValue(r, c, 42)` and a seed "42" are
 * indistinguishable — which is exactly what a diff needs.
 *
 * `display` is carried SEPARATELY and only for cells a real workbook snapshot
 * supplied: a formula's cached value. Nothing in this module computes it — see
 * the note on `shapeOf`.
 */
export interface PreviewCell {
  input: string;
  format: Record<string, unknown>;
  /**
   * The value the workbook last computed for this cell, when the seed came from
   * a real document. Absent for a fixture-seeded cell, and NEVER derived: this
   * module has no evaluator, and inventing one digit of a formula's value would
   * make the preview lie in the one direction a reviewer cannot check.
   */
  cachedDisplay?: string;
}

export type CellShape = {
  value: string | number | boolean | null;
  display: string;
  type: "number" | "text" | "boolean" | "empty" | "error";
  formula?: string;
};

export class PreviewGrid {
  cells = new Map<string, PreviewCell>();

  private key(row: number, col: number): string {
    return `${row},${col}`;
  }

  input(row: number, col: number): string {
    return this.cells.get(this.key(row, col))?.input ?? "";
  }

  cachedDisplay(row: number, col: number): string | undefined {
    return this.cells.get(this.key(row, col))?.cachedDisplay;
  }

  setInput(row: number, col: number, raw: string): void {
    // Canonicalize numeric spellings the way the backend does: the product
    // parses "36.00" into the NUMBER 36, whose cell_input_string is "36"
    // (integers without ".0"). Storing the author's spelling verbatim made
    // `sum.toFixed(2)` grade as the wrong value while the product would have
    // read it back canonical — a correct script graded wrong.
    let input = raw;
    if (input !== "" && !input.startsWith("=") && input !== "TRUE" && input !== "FALSE") {
      const n = Number(input);
      if (input.trim() !== "" && Number.isFinite(n)) input = String(n);
    }
    const k = this.key(row, col);
    const existing = this.cells.get(k);
    if (input === "") {
      if (existing) {
        existing.input = "";
        // A cleared cell has no cached value. Keeping the old one would let a
        // later read report the value of something the script just deleted.
        delete existing.cachedDisplay;
      }
      return;
    }
    if (existing) {
      existing.input = input;
      // WRITTEN cells lose their snapshot value. The script just replaced the
      // content; the workbook has not recalculated (nothing here can), so the
      // honest answer for a formula the script itself wrote is "unknown", which
      // `shapeOf` reports as empty. Carrying the PREVIOUS cell's cached value
      // forward would attribute a stale number to new content.
      delete existing.cachedDisplay;
    } else {
      this.cells.set(k, { input, format: {} });
    }
  }

  /** Seed a cell that came from a real document, cached value included. */
  seedFromDocument(row: number, col: number, input: string, cachedDisplay?: string): void {
    this.setInput(row, col, input);
    if (cachedDisplay === undefined) return;
    const cell = this.cells.get(this.key(row, col));
    if (cell) cell.cachedDisplay = cachedDisplay;
  }

  /**
   * Record a value COMPUTED for a cell that already exists.
   *
   * Separate from `seedFromDocument` because the two are different claims: a
   * seed says "this is what the workbook holds", while this says "this is what
   * the formula in this cell evaluates to". Only the evaluator may make the
   * second claim, and it may not create cells — a value for a cell that is not
   * there is a bug in the caller, not a cell to invent.
   */
  setCachedDisplay(row: number, col: number, display: string): void {
    const cell = this.cells.get(this.key(row, col));
    if (cell) cell.cachedDisplay = display;
  }

  mergeFormat(row: number, col: number, fmt: Record<string, unknown>): void {
    const k = this.key(row, col);
    const existing = this.cells.get(k);
    if (existing) Object.assign(existing.format, fmt);
    else this.cells.set(k, { input: "", format: { ...fmt } });
  }

  format(row: number, col: number): Record<string, unknown> {
    return this.cells.get(this.key(row, col))?.format ?? {};
  }

  entries(): Array<{ row: number; col: number; cell: PreviewCell }> {
    return [...this.cells.entries()]
      .map(([k, cell]) => {
        const [row, col] = k.split(",").map(Number);
        return { row, col, cell };
      })
      .sort((a, b) => a.row - b.row || a.col - b.col);
  }

  /** A snapshot of every cell's input string, for diffing after a run. */
  inputSnapshot(): Map<string, string> {
    return new Map(this.entries().map(({ row, col, cell }) => [`${row},${col}`, cell.input]));
  }
}

/**
 * Derive the typed shape a `ScriptCell` reports from an input string, plus the
 * DISPLAY the real workbook computed for it when a snapshot supplied one.
 *
 * TWO DISTINCT JOBS, and conflating them is what makes a preview lie:
 *
 *  - TYPE and VALUE come from the input string, exactly as user entry derives
 *    them. A formula's value cannot be derived at all — nothing here evaluates
 *    — so without a snapshot it is reported as empty rather than guessed.
 *  - DISPLAY is the FORMATTED text, and it is the workbook's business, not
 *    this module's. `api.getCellValue` returns `cell.display` in the product,
 *    so a currency-formatted 42 reads back "$42.00" there. When the snapshot
 *    supplied that text it is used verbatim; otherwise the unformatted value is
 *    the honest floor.
 *
 * KNOWN LIMIT, stated rather than hidden: a cell the SCRIPT writes loses its
 * cached display (it is no longer the workbook's answer for that content) and
 * reads back unformatted, whereas the product would re-apply the cell's number
 * format. It bites only on cells that carry a non-General format, and inventing
 * a formatter here would be a second implementation of one the backend owns.
 */
export function shapeOf(input: string, cached?: string): CellShape {
  if (input === "") return { value: null, display: cached ?? "", type: "empty" };
  if (input.startsWith("=")) {
    if (cached === undefined) {
      return { value: null, display: "", type: "text", formula: input };
    }
    // A snapshot-supplied value: report it exactly as the workbook holds it,
    // typed the way a reader would see it.
    const n = Number(cached);
    if (cached.trim() !== "" && Number.isFinite(n)) {
      return { value: n, display: cached, type: "number", formula: input };
    }
    if (cached === "TRUE" || cached === "FALSE") {
      return { value: cached === "TRUE", display: cached, type: "boolean", formula: input };
    }
    if (cached.startsWith("#")) {
      return { value: cached, display: cached, type: "error", formula: input };
    }
    return { value: cached, display: cached, type: "text", formula: input };
  }
  if (input === "TRUE" || input === "FALSE") {
    return { value: input === "TRUE", display: cached ?? input, type: "boolean" };
  }
  const n = Number(input);
  if (input.trim() !== "" && Number.isFinite(n)) {
    return { value: n, display: cached ?? input, type: "number" };
  }
  return { value: input, display: cached ?? input, type: "text" };
}

/** Read a cell as the shape a script sees, cached value included. */
export function cellShape(grid: PreviewGrid, row: number, col: number): CellShape {
  return shapeOf(grid.input(row, col), grid.cachedDisplay(row, col));
}

/** `setCellValue` semantics: typed exactly as if the user entered it. */
export function inputFromWrite(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value); // stored as text
    return String(value);
  }
  return String(value);
}

/**
 * Row comparison, mirroring `compare_rows_by_fields` (data.rs): type order
 * Numbers < Text < Booleans < Errors < Empty, numeric compare within numbers,
 * case-insensitive text unless matchCase, and `descending` REVERSES the whole
 * ordering — which places empties FIRST descending, exactly like the backend.
 */
export function compareCellInputs(a: string, b: string, matchCase: boolean): number {
  const sa = shapeOf(a);
  const sb = shapeOf(b);
  const rank = (s: CellShape): number =>
    s.type === "number" ? 0 : s.type === "text" ? 1 : s.type === "boolean" ? 2 : s.type === "error" ? 3 : 4;
  const ra = rank(sa);
  const rb = rank(sb);
  if (ra !== rb) return ra - rb;
  if (sa.type === "number" && sb.type === "number") {
    return (sa.value as number) - (sb.value as number);
  }
  if (sa.type === "boolean" && sb.type === "boolean") {
    return Number(sa.value) - Number(sb.value);
  }
  const ta = matchCase ? String(sa.display) : String(sa.display).toLowerCase();
  const tb = matchCase ? String(sb.display) : String(sb.display).toLowerCase();
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}

export function cellsInRange(
  grid: PreviewGrid,
  r1: number,
  c1: number,
  r2: number,
  c2: number,
): Array<{ row: number; col: number; input: string }> {
  return grid
    .entries()
    .filter(({ row, col }) => row >= r1 && row <= r2 && col >= c1 && col <= c2)
    .map(({ row, col, cell }) => ({ row, col, input: cell.input }));
}

export function replaceCaseInsensitive(text: string, search: string, replacement: string): string {
  if (search === "") return text;
  const lower = text.toLowerCase();
  const q = search.toLowerCase();
  let out = "";
  let i = 0;
  for (;;) {
    const at = lower.indexOf(q, i);
    if (at === -1) {
      out += text.slice(i);
      return out;
    }
    out += text.slice(i, at) + replacement;
    i = at + search.length;
  }
}
