//! FILENAME: app/extensions/BuiltIn/PasteSpecial/pasteSpecialExecute.ts
// PURPOSE: Core execution logic for Paste Special operations.
// CONTEXT: Handles all paste variants (values, formulas, formats, operations,
//          transpose, skip blanks, paste link, keep source column widths)
//          using existing API primitives.
//
//          EVERY door lands in one of the three exported functions below --
//          the Paste Special dialog's OK and Paste Link, the quick pastes and
//          the Home tab's Paste menu rows (index.ts) -- and each one asks the
//          same questions before it writes anything: does something else own
//          the selection (BUG-0185), was the clipboard CUT, is the internal
//          clipboard stale, does a protected region lie under the paste
//          (pasteRefusals.ts). A refused paste writes nothing, opens no undo
//          step and says ONE sentence. The functions answer whether they
//          pasted (true) or refused (false).
//
//          ON A FLOATING GRID'S CELLS (P3, owner finding G3): a door that
//          resolved an OBJECT target hands it in (`target`), and the paste is
//          written to the object's cells in ONE `updateCellsBatch(.., { target })`
//          -- value and source style together, Excel's relative shift on the
//          object's own coordinates -- plus the number formats through
//          `applyFormatting(.., { target })`. What has no route onto an object's
//          cells is refused there in one sentence: a style-only write
//          (Formatting, No Borders -- there is no style-index write that takes a
//          target, BUG-0513), comments and validation (their doors refuse on a floating
//          grid), and column widths (the object's widths are not the sheet's).
//
//          AN OPERATION (Add / Subtract / Multiply / Divide) asks two more
//          questions before it writes (`operationRefusal`): does the paste area
//          touch a DYNAMIC ARRAY (Excel: "You can't change part of an array.",
//          nothing changes), and -- on a protected sheet -- does it cover a cell
//          whose formula the typed read WITHHELD (the operation would have to
//          keep a formula it is not allowed to read). And every formula or
//          stored value this module writes is flagged as a PASTE
//          (`CellUpdateInput.pasted`), so a pasted NUMBER or FORMULA stays one
//          in a Text-formatted (@) cell in the same write: Excel's Text format
//          governs typing, never a paste.
//
//          A CONSTANT -- and, under a values attribute, a formula's RESULT --
//          is written from the value the copy read TYPED
//          (`ClipboardData.values`, `storedConstantOf`), invariant: never by
//          re-typing its display text, which held only what the source's
//          number format showed (1.23456 under 0.00 pasted as 1.23).

import type { CellData, Selection, StyleData, FormattingOptions } from "@api/types";
import type {
  ClipboardData,
  FormulaShiftInput,
  AddCommentParams,
  CellUpdateInput,
  TypedCellData,
  SheetsResult,
  PastedConstant,
} from "@api/lib";
import type { PasteSpecialOptions, PasteOperation, PasteAttribute } from "./types";
import {
  getCell,
  getSheets,
  updateCell,
  setCellStyle,
  getStyle,
  applyFormatting,
  getColumnWidth,
  setColumnWidth,
  beginUndoTransaction,
  commitUndoTransaction,
  cancelUndoTransaction,
  shiftFormulasBatch,
  indexToCol,
  addComment,
  setDataValidation,
  clipboardSourceRow,
  pasteRowDeltas,
  updateCellsBatch,
  getRangeCellsTyped,
  getSpillRanges,
  isSheetProtected,
  pastedConstantInput,
} from "@api/lib";
import { cellEvents } from "@api";
import { alertAsync } from "@api/dialogs";
import {
  getCellTargetCells,
  getCellTargetCellsTyped,
  resolveCellTarget,
  type CellTargetRef,
} from "@api/cellTarget";
import { getFloatingRangeSpillRanges, type SpillRangeInfo } from "@api/floatingRangeSpills";
import { decimalSeparator, parseNumber } from "@api/locale";
import { getGridStateSnapshot } from "@api/state";
import { quoteSheetNameForFormula } from "@api/externalEdit";
import { ownUndoTransaction, type UndoTransactionCloses } from "@api/undoTicket";
import { pasteRefusal, pasteRefusalSentence, type PasteArea } from "./pasteRefusals";

// The closes this module's gestures make, bound to each begin's answer by
// ownUndoTransaction: a gesture closes ONLY the undo transaction its own begin
// OPENED. Inside a script's open batch (or a command-line run) the begin JOINS,
// the gesture's writes become part of that holder's step, and the holder closes
// it -- an unconditional commit ended the batch halfway, and a cancel dropped
// its undo record (wave E, Y7). Keep Source Column Widths relies on the same
// rule from the other side: its OWN begin opens the step, and the cell paste
// and the width paste inside it join that step instead of closing it.
const UNDO_CLOSES: UndoTransactionCloses = {
  commitUndoTransaction: (...ticket) => commitUndoTransaction(...ticket),
  cancelUndoTransaction: (...ticket) => cancelUndoTransaction(...ticket),
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check if a source cell is considered "blank" for skip-blanks logic.
 */
function isCellBlank(cell: CellData | null | undefined): boolean {
  if (!cell) return true;
  return !cell.display && !cell.formula;
}

/**
 * Check if a cell displays a List or Dict collection value.
 */
function isCollectionCell(cell: { display?: string | null } | null | undefined): boolean {
  if (!cell?.display) return false;
  return cell.display.startsWith("[List(") || cell.display.startsWith("[Dict(");
}

/**
 * The attributes that paste the source's FORMULAS (shifted the Excel way);
 * the others paste its values. An operation under one of these keeps a source
 * formula a formula: `=5+(D3)`.
 */
const FORMULA_ATTRIBUTES: ReadonlySet<PasteAttribute> = new Set<PasteAttribute>([
  "all",
  "formulas",
  "allExceptBorders",
  "formulasAndNumberFormats",
]);

/**
 * What an operation (Add / Subtract / Multiply / Divide) computes from: the
 * cells read TYPED -- the value the engine stores (5.5), never the display
 * text ("5,50 kr", "1,234.00", "50%"), which is the app locale's and the
 * number format's (`Number(display)` read every formatted number, and every
 * fraction under a comma-decimal locale, as 0) -- and their FORMULAS, which an
 * operation keeps (BUG-0346: it used to write the computed number over the
 * destination's formula).
 */
interface OperationOperands {
  /** The source's typed cell at clipboard matrix position "r,c" (absent = blank). */
  source: Map<string, TypedCellData>;
  /** The destination's typed cell at "row,col", its own coordinates (absent = blank). */
  dest: Map<string, TypedCellData>;
  /**
   * The source's formulas, shifted to where they land, keyed "r,c" -- when the
   * attribute pastes formulas (FORMULA_ATTRIBUTES); null when it pastes values.
   */
  sourceFormulas: Map<string, string> | null;
  /**
   * The paste's place the operands were read from (undefined = the active
   * sheet). The write itself takes its place from the route: `PasteContext.target`
   * on the sheet, `writeTargetBatch`'s target on an object.
   */
  target: CellTargetRef | undefined;
}

/**
 * One side of an operation, as Excel reads it (measured live through COM,
 * 2026-10-29, Range.PasteSpecial with xlPasteSpecialOperationAdd ... Divide):
 *   - a FORMULA stays a formula, wrapped in parentheses -- the destination's
 *     own (`=A1` + 1 -> `=(A1)+1`, whatever it evaluates to: `=("x")+1` is
 *     #VALUE!, and `=(1/0)+1` #DIV/0!) and, under an attribute that pastes
 *     formulas, the source's, shifted (`5` + `=C1` -> `=5+(D3)`, both ->
 *     `=(A1)+(D3)`);
 *   - a NUMBER is spelled as a literal (`=(A1)+1.5`, `=(A1)--2`);
 *   - a BLANK cell counts as 0 (`=(A1)+0`, `=0+(D3)`), but blank on blank
 *     stays blank;
 *   - text, a boolean or an error held as a CONSTANT is inert: the destination
 *     is left exactly as it is, on either side ("abc" + 1 stays "abc", 5 + "abc"
 *     stays 5, `=A1` + "abc" stays `=A1`). Under a VALUES attribute a source
 *     formula's TRUE / FALSE counts as 1 / 0 (`=(A1)+1`), its text or error is
 *     inert.
 * Two constants compute a constant (5 + 1.5 = 6.5; 5 / 0 = #DIV/0!).
 */
type Operand =
  | { kind: "formula"; body: string }
  | { kind: "number"; value: number }
  | { kind: "blank" }
  | { kind: "inert" };

/** A formula's text without its leading "=". */
function formulaBody(formula: string): string {
  return formula.startsWith("=") ? formula.slice(1) : formula;
}

/** A typed CONSTANT as an operand: a finite number, a blank, or inert. */
function constantOperand(cell: TypedCellData | undefined): Operand {
  if (!cell || cell.type === "empty") return { kind: "blank" };
  if (cell.type === "number" && typeof cell.value === "number" && Number.isFinite(cell.value)) {
    return { kind: "number", value: cell.value };
  }
  return { kind: "inert" };
}

/** The destination's side: its own formula when it has one, else its value. */
function destOperand(cell: TypedCellData | undefined): Operand {
  if (cell?.formula) return { kind: "formula", body: formulaBody(cell.formula) };
  return constantOperand(cell);
}

/**
 * The source's side: its formula, shifted to where it lands, when the
 * attribute pastes formulas; else its VALUE (a formula's TRUE / FALSE as 1 / 0).
 */
function sourceOperand(
  sourceCell: CellData | null,
  srcR: number,
  srcC: number,
  operands: OperationOperands | null,
): Operand {
  const key = `${srcR},${srcC}`;
  if (operands?.sourceFormulas) {
    const formula = operands.sourceFormulas.get(key) ?? sourceCell?.formula ?? null;
    if (formula) return { kind: "formula", body: formulaBody(formula) };
  }
  const typed = operands?.source.get(key);
  if (typed?.formula && typed.type === "boolean") return { kind: "number", value: typed.value ? 1 : 0 };
  return constantOperand(typed);
}

/** The operator an operation writes into its formula. */
const OPERATION_SYMBOL: Record<Exclude<PasteOperation, "none">, string> = {
  add: "+",
  subtract: "-",
  multiply: "*",
  divide: "/",
};

/**
 * A number as a literal INSIDE a formula the user's way: the shortest text
 * that reads back as the same double, with the app locale's decimal separator
 * (the formula is written through the user-input parser, like every pasted
 * formula, which reads "1,5" as 1.5 under sv-SE / de-DE). Never grouped.
 */
function formulaNumberLiteral(value: number): string {
  return String(value).replace(".", decimalSeparator());
}

/** One operand's text in the operation's formula. */
function operandText(operand: Operand): string {
  switch (operand.kind) {
    case "formula":
      return `(${operand.body})`;
    case "number":
      return formulaNumberLiteral(operand.value);
    default:
      return "0";
  }
}

/**
 * What an operation writes into one destination cell, or null to leave it as
 * it is (an inert side; blank on blank). Two constants compute a constant,
 * written INVARIANT; a formula on either side gives Excel's formula, written
 * through the user-input parser as every pasted formula is.
 */
function operationWrite(
  dest: Operand,
  source: Operand,
  operation: PasteOperation,
): { value: string; invariant: boolean } | null {
  if (operation === "none" || dest.kind === "inert" || source.kind === "inert") return null;
  if (dest.kind === "blank" && source.kind === "blank") return null;
  if (dest.kind !== "formula" && source.kind !== "formula") {
    const d = dest.kind === "number" ? dest.value : 0;
    const s = source.kind === "number" ? source.value : 0;
    return { value: operationResultInput(applyOperation(d, s, operation)), invariant: true };
  }
  return { value: `=${operandText(dest)}${OPERATION_SYMBOL[operation]}${operandText(source)}`, invariant: false };
}

/**
 * The one shape every pasted formula or stored value is written in: a PASTE
 * (`pasted`), so the backend's typed-entry ladder skips its Text rung and a
 * formula, a number, TRUE / FALSE or an error stays what it is in a
 * Text-formatted (@) cell, keeping the cell's own style -- in the same write.
 * Excel, measured live through COM (2026-10-29): `=A1` + Values > Add 1 ->
 * `=(A1)+1`, 5 + Add 1 -> the number 6, Paste Formulas of `=A1` -> a formula,
 * Paste Link -> `=$C$1`, all still @. (Round 3 rewrote such a cell with
 * `styleIndex: 0` and put its style back afterwards; that rewrite also replaced
 * the cell's PROTECTION flags, so an unlocked @ input cell on a protected sheet
 * came back LOCKED, its style restore was refused and the cell was reported
 * skipped though the write had landed.) Only the display-text fallback (a copy
 * without stored values) stays an entry.
 */
function pastedUpdate(row: number, col: number, value: string, invariant: boolean): CellUpdateInput {
  const update: CellUpdateInput = { row, col, value };
  if (invariant) update.invariant = true;
  update.pasted = true;
  return update;
}

/** The most cells one typed sheet read asks for (the backend's MAX_TYPED_RANGE_CELLS). */
const TYPED_READ_BAND = 100_000;

/** A typed read of a sheet rectangle, banded so no call asks for more than the backend's cap. */
async function readSheetTyped(
  r0: number,
  c0: number,
  r1: number,
  c1: number,
  sheetIndex?: number,
): Promise<TypedCellData[]> {
  const width = c1 - c0 + 1;
  const rowBand = Math.max(1, Math.floor(TYPED_READ_BAND / Math.max(1, width)));
  const out: TypedCellData[] = [];
  for (let br = r0; br <= r1; br += rowBand) {
    // One push per cell, never `out.push(...band)`: a band is up to 100,000
    // cells, and spreading that many arguments is at the edge of V8's call
    // stack (see `matrixSize`).
    for (const cell of await getRangeCellsTyped(br, c0, Math.min(r1, br + rowBand - 1), c1, sheetIndex)) {
      out.push(cell);
    }
  }
  return out;
}

/**
 * The source's typed cells, keyed by clipboard matrix position: a typed read of
 * where the cells were copied FROM (a sheet -- found by its stable id, so a
 * rename or a reorder since the copy reads the right one -- or an object's
 * cells), each matrix row mapped back through `sourceRows` (a filtered copy
 * skips rows). When the source can no longer be read (its sheet is gone), the
 * stored values the copy read stand in (`ClipboardData.values`); only a copy
 * without them falls back to its display text: a number read in the APP
 * locale -- never with `Number()` -- or, when it reads as none, inert text.
 */
async function readSourceOperands(
  clipboard: ClipboardData,
  height: number,
  width: number,
): Promise<Map<string, TypedCellData>> {
  const out = new Map<string, TypedCellData>();
  if (height === 0 || width === 0) return out;
  const minRow = Math.min(clipboard.sourceSelection.startRow, clipboard.sourceSelection.endRow);
  const minCol = Math.min(clipboard.sourceSelection.startCol, clipboard.sourceSelection.endCol);
  // The rows' extent by a loop, never `Math.min(...rows)`: see `matrixSize`.
  const rowOf = new Map<number, number>();
  let r0 = Infinity;
  let r1 = -Infinity;
  for (let r = 0; r < height; r++) {
    const abs = clipboard.sourceRows?.[r] ?? minRow + r;
    rowOf.set(abs, r);
    if (abs < r0) r0 = abs;
    if (abs > r1) r1 = abs;
  }
  const c1 = minCol + width - 1;
  try {
    let read: TypedCellData[];
    if (clipboard.sourceTarget) {
      read = await getCellTargetCellsTyped(clipboard.sourceTarget, { startRow: r0, startCol: minCol, endRow: r1, endCol: c1 });
    } else {
      const sheet = await sourceSheetNow(clipboard);
      if (sheet === null) throw new Error(`the sheet "${clipboard.sourceSheetName}" no longer exists`);
      read = await readSheetTyped(r0, minCol, r1, c1, sheet?.index ?? clipboard.sourceSheetIndex);
    }
    for (const cell of read) {
      const r = rowOf.get(cell.row);
      if (r === undefined || cell.col < minCol || cell.col > c1) continue;
      out.set(`${r},${cell.col - minCol}`, cell);
    }
  } catch (err) {
    console.warn("[PasteSpecial] the copied cells could not be re-read; using what the copy read:", err);
    clipboard.cells.forEach((row, r) =>
      row.forEach((cell, c) => {
        // The STORED value the copy read typed (ClipboardData.values), when it
        // has one; only a copy without them parses its display text.
        const stored = clipboard.values?.[r]?.[c];
        if (stored && stored.type !== "empty") {
          out.set(`${r},${c}`, {
            row: r,
            col: c,
            value: stored.value,
            display: cell?.display ?? "",
            formula: cell?.formula ?? null,
            type: stored.type,
          });
          return;
        }
        if (clipboard.values) return;
        if (!cell?.display) return;
        const n = parseNumber(cell.display);
        const isNumber = n !== null && Number.isFinite(n);
        out.set(`${r},${c}`, {
          row: r,
          col: c,
          value: isNumber ? n : cell.display,
          display: cell.display,
          formula: cell.formula ?? null,
          type: isNumber ? "number" : "text",
        });
      }),
    );
  }
  return out;
}

/** The destination's typed cells over a rectangle (sheet or object), keyed "row,col". */
function destOperandsOf(read: readonly TypedCellData[]): Map<string, TypedCellData> {
  const out = new Map<string, TypedCellData>();
  for (const cell of read) out.set(`${cell.row},${cell.col}`, cell);
  return out;
}

/**
 * An operation's result as cell input: INVARIANT text (String(3.5) is "3.5"),
 * written with `invariant: true`, so the backend never reads it as a de-DE /
 * sv-SE entry (where "3.5" is not 3,5).
 */
function operationResultInput(result: number): string {
  return isNaN(result) ? "#DIV/0!" : String(result);
}

/**
 * Apply a mathematical operation between source and target values.
 */
function applyOperation(
  targetValue: number,
  sourceValue: number,
  operation: PasteOperation
): number {
  switch (operation) {
    case "add":
      return targetValue + sourceValue;
    case "subtract":
      return targetValue - sourceValue;
    case "multiply":
      return targetValue * sourceValue;
    case "divide":
      return sourceValue !== 0 ? targetValue / sourceValue : NaN;
    default:
      return sourceValue;
  }
}

/**
 * The formula Paste Link writes for one source cell, spelled the way Excel
 * spells it (measured live through COM, 2026-10-04, Worksheet.Paste
 * Link:=True):
 *   - ONE cell copied: an ABSOLUTE link, `=$A$1`;
 *   - a RANGE copied: a RELATIVE link per cell, `=A1`, `=B2`;
 *   - on another sheet the source sheet is named, quoted when the parser
 *     cannot read it bare: `=Sheet1!$A$1`, `='My Data'!A1`.
 */
function buildLinkFormula(sheetPrefix: string, row: number, col: number, absolute: boolean): string {
  const colLetter = indexToCol(col);
  return absolute ? `=${sheetPrefix}$${colLetter}$${row + 1}` : `=${sheetPrefix}${colLetter}${row + 1}`;
}

/** The sheet a copy came from, as it is NOW. */
interface SourceSheetNow {
  /** Its index in the workbook now. */
  index: number;
  /** Its name now -- what a link spells. */
  name: string;
  /** Whether it is the active sheet, the one a paste writes. */
  isActive: boolean;
}

/**
 * Where a SHEET copy's source sheet is now, found by the stable id the copy
 * recorded (`ClipboardData.sourceSheetId`). The name and index recorded at the
 * copy go stale: renaming the sheet left Paste Link spelling the OLD name, a
 * link to nothing (#REF!, BUG-0348), and a sheet inserted, moved or deleted
 * before it moves its index. Excel follows the sheet: renamed while the
 * marching ants are up, it keeps copy mode and Paste Link writes the NEW name
 * (`=Data!$A$1`; measured live through COM, 2026-10-29).
 *
 * Null when no sheet carries the id any more (the sheet was deleted).
 * Undefined when nothing better than the recorded index and name is known: an
 * object source, a copy that recorded no id (the sheet context had none), a
 * sheet list that cannot be read or that carries no ids at all.
 */
async function sourceSheetNow(clipboard: ClipboardData): Promise<SourceSheetNow | null | undefined> {
  const id = clipboard.sourceSheetId;
  if (!id || clipboard.sourceTarget) return undefined;
  let list: SheetsResult;
  try {
    list = await getSheets();
  } catch (err) {
    console.warn("[PasteSpecial] the sheet list could not be read; using the sheet recorded at the copy:", err);
    return undefined;
  }
  const sheets = list?.sheets ?? [];
  if (!sheets.some((s) => s.sheetId)) return undefined;
  const sheet = sheets.find((s) => s.sheetId === id);
  if (!sheet) return null;
  return { index: sheet.index, name: sheet.name, isActive: sheet.index === list.activeIndex };
}

/**
 * The sheet prefix a link needs: none on the source sheet itself, `Name!`
 * anywhere else. Before ClipboardData recorded its source sheet the link was
 * always written bare, so a Paste Link on another sheet linked to the same
 * ADDRESSES on the destination sheet (clipboard survey defect 1). The source
 * sheet is the one `sourceSheetNow` found (its name and place NOW); without
 * one, the index and name recorded at the copy. Unknown on either side (a
 * payload that predates the field, no grid state) is treated as the same
 * sheet -- the old behaviour, never a guess at a name.
 */
function linkSheetPrefix(clipboard: ClipboardData, target: CellTargetRef | undefined, source: SourceSheetNow | undefined): string {
  const sourceName = source?.name ?? clipboard.sourceSheetName;
  const sourceTarget = clipboard.sourceTarget;
  if (target || sourceTarget) {
    // An OBJECT on either side (a floating grid's cells, P3). The link lives
    // where it is written: inside the same object it is bare; anywhere else it
    // names its source -- the sheet, or the object, whose name a formula
    // spells as a sheet's (`=Float1!$A$1`).
    if (target && sourceTarget && target.kind === sourceTarget.kind && target.id === sourceTarget.id) return "";
    return sourceName ? `${quoteSheetNameForFormula(sourceName)}!` : "";
  }
  if (source) return source.isActive ? "" : `${quoteSheetNameForFormula(source.name)}!`;
  const targetSheet = getGridStateSnapshot()?.sheetContext?.activeSheetIndex;
  const sourceSheet = clipboard.sourceSheetIndex;
  if (targetSheet === undefined || sourceSheet === undefined || !sourceName) return "";
  if (targetSheet === sourceSheet) return "";
  return `${quoteSheetNameForFormula(sourceName)}!`;
}

/**
 * The matrix's size: rows, and the widest row -- found by a LOOP. It was
 * `Math.max(...cells.map((r) => r.length))`, one call argument per copied row,
 * which overflows V8's call stack somewhere above 100,000 rows ("Maximum call
 * stack size exceeded" at 150,000): a legal copy of A1:A200000 made EVERY
 * Paste Special variant throw before writing anything, with only a console
 * error to show for it, while plain Paste of the same clipboard worked.
 */
function matrixSize(cells: (CellData | null)[][]): { height: number; width: number } {
  let width = 0;
  for (const row of cells) {
    const length = row?.length ?? 0;
    if (length > width) width = length;
  }
  return { height: cells.length, width };
}

/**
 * The cells a paste of `clipboard` at `target` writes: the target's top-left,
 * the source's size (swapped by Transpose), clamped to the grid. Plain Paste's
 * guard asks about exactly this rectangle.
 */
function pasteAreaOf(
  clipboard: ClipboardData,
  target: Selection,
  transpose: boolean,
  totalRows: number,
  totalCols: number,
): PasteArea {
  const row = Math.min(target.startRow, target.endRow);
  const col = Math.min(target.startCol, target.endCol);
  const { height, width } = matrixSize(clipboard.cells ?? []);
  return {
    row,
    col,
    height: Math.max(0, Math.min(transpose ? width : height, totalRows - row)),
    width: Math.max(0, Math.min(transpose ? height : width, totalCols - col)),
  };
}

/**
 * The questions every door asks before writing (see the file header):
 * Core's selection must be Core's, and `pasteRefusal` must have nothing to
 * say. Says the refusal ONCE (the owner's toast, or an alert) and answers
 * false; answers true when the paste may go ahead.
 */
async function mayPaste(
  clipboard: ClipboardData,
  area: PasteArea | null,
  label: string,
  target?: CellTargetRef,
): Promise<boolean> {
  // A door that resolved an OBJECT target hands it in; otherwise the question
  // is asked here (the paste lands in Core's selection, or -- with an owner
  // that does not admit pasting -- is refused once, BUG-0185).
  if (!target && resolveCellTarget(label, "content") === null) return false;
  if (!clipboard.cells || clipboard.cells.length === 0) {
    void alertAsync(pasteRefusalSentence.nothingCopied(label));
    return false;
  }
  // The range guards describe the ACTIVE sheet's regions; an object's cells
  // are gated by the backend on the object's own cells.
  const refusal = await pasteRefusal(clipboard, target ? null : area, label);
  if (refusal !== null) {
    void alertAsync(refusal);
    return false;
  }
  return true;
}

/**
 * The attributes that write no cell VALUE, so an operation chosen beside them
 * computes nothing (`pasteSingleCell` never reaches `pasteWithOperation`) and
 * has nothing for `operationRefusal` to guard.
 */
const NO_OPERATION_ATTRIBUTES: ReadonlySet<PasteAttribute> = new Set<PasteAttribute>([
  "formats",
  "comments",
  "validation",
  "columnWidths",
]);

/** Whether a spill (its formula and the cells it spills into) overlaps `area`. */
function spillOverlaps(spill: SpillRangeInfo, area: PasteArea): boolean {
  const top = Math.min(spill.originRow, spill.endRow);
  const bottom = Math.max(spill.originRow, spill.endRow);
  const left = Math.min(spill.originCol, spill.endCol);
  const right = Math.max(spill.originCol, spill.endCol);
  return (
    top <= area.row + area.height - 1 &&
    bottom >= area.row &&
    left <= area.col + area.width - 1 &&
    right >= area.col
  );
}

/** A1-style address of a cell on the sheet (for a refusal sentence). */
function cellAddress(row: number, col: number): string {
  return `${indexToCol(col)}${row + 1}`;
}

/**
 * Why an OPERATION (Add / Subtract / Multiply / Divide) must not paste into
 * `area`, or null when it may. Asked after `mayPaste` and BEFORE any write or
 * undo step, so a refusal changes nothing:
 *
 *   1. A DYNAMIC ARRAY under the paste area (its formula, or any cell it spills
 *      into) -- on the sheet, or on the floating grid being pasted into. Excel
 *      refuses the whole paste ("You can't change part of an array."). The
 *      grid route writes cell by cell, so before this the formula cell was
 *      rewritten as `=(SEQUENCE(3))+10` and re-spilled, and every spilled cell
 *      after it was then refused on its own -- a half-done paste whose numbers
 *      were neither the old ones nor the expected ones. Read failures fall
 *      through: the backend's own per-write spill check still refuses a write
 *      over a spilled cell.
 *   2. On a PROTECTED sheet (the grid route), a cell whose formula the typed
 *      read WITHHELD (`TypedCellData.formulaWithheld`: the sheet hides it).
 *      The operation would see only the value and replace the formula with a
 *      constant -- silently, on a cell whose formula the user cannot even see.
 *      Excel keeps it (`=(A1)+1`); keeping it needs the formula text, which
 *      only the backend may read, so this refuses instead, naming the cell
 *      (fail closed: a protection state or a read that fails refuses too).
 *      WHATEVER the cell's lock state -- a locked cell inside an allow-edit
 *      range is writable -- and NEVER over a hidden-format cell that holds a
 *      constant or nothing, which withholds nothing: Excel computes there (a
 *      blank + 1 is 1, 7 + 1 is 8), and so does this paste.
 */
async function operationRefusal(
  area: PasteArea,
  label: string,
  target: CellTargetRef | undefined,
): Promise<string | null> {
  if (area.height <= 0 || area.width <= 0) return null;

  let spills: SpillRangeInfo[] = [];
  try {
    spills = target ? await getFloatingRangeSpillRanges(target.id) : await getSpillRanges();
  } catch (err) {
    console.warn("[PasteSpecial] the dynamic arrays under the paste could not be read:", err);
  }
  if ((spills ?? []).some((spill) => spillOverlaps(spill, area))) return pasteRefusalSentence.partOfArray(label);

  // A floating grid's cells are never on a protected sheet of their own (the
  // host's protection gates the write in the backend), and its typed read
  // withholds nothing.
  if (target) return null;
  let protectedSheet: boolean;
  try {
    protectedSheet = await isSheetProtected();
  } catch (err) {
    console.warn("[PasteSpecial] the sheet's protection could not be read:", err);
    return pasteRefusalSentence.protectionUnknown(label);
  }
  if (!protectedSheet) return null;

  try {
    const r1 = area.row + area.height - 1;
    const c1 = area.col + area.width - 1;
    for (const cell of await readSheetTyped(area.row, area.col, r1, c1)) {
      if (cell.row < area.row || cell.row > r1 || cell.col < area.col || cell.col > c1) continue;
      if (cell.formulaWithheld) return pasteRefusalSentence.hiddenFormula(label, cellAddress(cell.row, cell.col));
    }
  } catch (err) {
    console.warn("[PasteSpecial] the protected cells under the paste could not be read:", err);
    return pasteRefusalSentence.protectionUnknown(label);
  }
  return null;
}

/** The style table entry `index`, read once per `cache`. */
function cachedStyle(cache: Map<number, Promise<StyleData>>, index: number): Promise<StyleData> {
  let style = cache.get(index);
  if (!style) {
    style = getStyle(index);
    cache.set(index, style);
  }
  return style;
}

// ============================================================================
// Main Execution Functions
// ============================================================================

/**
 * Execute a Paste Special operation. Answers true when it pasted (a partial
 * paste included -- its skipped cells are named in one alert), false when it
 * refused before writing anything.
 *
 * @param label - What the door is called in a refusal ("Paste Values",
 *   "Paste (Transpose)", ...). The dialog's OK is "Paste Special".
 */
export async function executePasteSpecial(
  clipboard: ClipboardData,
  targetSelection: Selection,
  options: PasteSpecialOptions,
  totalRows: number,
  totalCols: number,
  label = "Paste Special",
  target?: CellTargetRef,
): Promise<boolean> {
  if (target && !TARGET_PASTE_ATTRIBUTES.has(options.pasteAttribute)) {
    void alertAsync(pasteRefusalSentence.notOnFloatingGrid(label));
    return false;
  }
  // THE Paste Special door: the dialog's OK and the quick commands (Paste
  // Values / Formulas / Formatting) all land here, and the target is Core's
  // selection. While something else owns the selection (BUG-0185) that is a
  // cell the user cannot see: refused, once, nothing written. Column widths
  // write no cell, so no cell area is guarded for them.
  const area =
    options.pasteAttribute === "columnWidths"
      ? null
      : pasteAreaOf(clipboard, targetSelection, options.transpose, totalRows, totalCols);
  if (!(await mayPaste(clipboard, area, label, target))) return false;
  // An operation's own questions (a dynamic array, a hidden formula), still
  // before any write or undo step: a refusal leaves the paste area untouched.
  if (options.operation !== "none" && area && !NO_OPERATION_ATTRIBUTES.has(options.pasteAttribute)) {
    const refusal = await operationRefusal(area, label, target);
    if (refusal !== null) {
      void alertAsync(refusal);
      return false;
    }
  }
  if (target) await pasteCellsOnTarget(clipboard, targetSelection, options, totalRows, totalCols, target);
  else await pasteCells(clipboard, targetSelection, options, totalRows, totalCols);
  return true;
}

/**
 * Excel's "Keep Source Column Widths" (Home > Paste): the FULL paste (values,
 * formulas, formatting -- Paste Special "All") AND the source columns' widths
 * on the destination columns, as ONE undo step. Paste Special's own "Column
 * widths" radio pastes the widths only, never the cells; this row is both.
 *
 * Its OWN begin opens the step; the cell paste's and the width paste's begins
 * JOIN it (ownUndoTransaction makes their closes no-ops), so Ctrl+Z takes the
 * cells and the widths back together. Anything that throws -- a width the
 * backend refuses -- cancels the WHOLE step: cells and widths go together.
 */
export async function executePasteKeepSourceColumnWidths(
  clipboard: ClipboardData,
  targetSelection: Selection,
  totalRows: number,
  totalCols: number,
  label = "Paste (Keep Source Column Widths)",
  target?: CellTargetRef,
): Promise<boolean> {
  if (target) {
    // A floating grid's column widths are the OBJECT's, not the sheet's that
    // this paste copies them from and to.
    void alertAsync(pasteRefusalSentence.notOnFloatingGrid(label));
    return false;
  }
  const options: PasteSpecialOptions = { pasteAttribute: "all", operation: "none", skipBlanks: false, transpose: false };
  const area = pasteAreaOf(clipboard, targetSelection, false, totalRows, totalCols);
  if (!(await mayPaste(clipboard, area, label))) return false;

  const tx = ownUndoTransaction(
    await beginUndoTransaction(`${label} ${area.height * area.width} cells`),
    UNDO_CLOSES,
  );
  try {
    await pasteCells(clipboard, targetSelection, options, totalRows, totalCols);
    const { width: sourceWidth } = matrixSize(clipboard.cells);
    await pasteColumnWidths(clipboard, area.col, sourceWidth, totalCols);
    await tx.commit();
  } catch (error) {
    // The cell paste and the width paste have each told the user why; here
    // the step they joined is dropped whole, so no half of the gesture stays.
    try { await tx.cancel(); } catch { /* already closed */ }
    throw error;
  }
  return true;
}

/**
 * Excel's relative shift for the formulas a paste of `clipboard` at
 * (`targetRow`, `targetCol`) writes, keyed "r,c" by SOURCE matrix position.
 * Coordinate-relative, so a floating grid's own (backing) coordinates shift
 * exactly like a sheet's; a sheet-qualified reference (`=Float1!A1`) keeps the
 * sheet it names. Empty for a cut and for the attributes that write no formula.
 */
async function shiftedFormulasFor(
  clipboard: ClipboardData,
  pasteAttribute: PasteAttribute,
  transpose: boolean,
  targetRow: number,
  targetCol: number,
): Promise<Map<string, string>> {
  const shiftedFormulaMap = new Map<string, string>();
  const cellsToPaste = clipboard.cells;
  const { height: sourceHeight, width: sourceWidth } = matrixSize(cellsToPaste);
  if (clipboard.isCut || !FORMULA_ATTRIBUTES.has(pasteAttribute)) return shiftedFormulaMap;

  const sourceSel = clipboard.sourceSelection;
  const sourceMinRow = Math.min(sourceSel.startRow, sourceSel.endRow);
  const sourceMinCol = Math.min(sourceSel.startCol, sourceSel.endCol);

  const formulaEntries: { r: number; c: number; formula: string }[] = [];
  for (let r = 0; r < sourceHeight; r++) {
    for (let c = 0; c < sourceWidth; c++) {
      const cell = cellsToPaste[r]?.[c];
      if (cell?.formula) {
        formulaEntries.push({ r, c, formula: cell.formula });
      }
    }
  }
  if (formulaEntries.length === 0) return shiftedFormulaMap;

  // A FILTERED COPY HAS NO SINGLE ROW DELTA. `cellsToPaste` matrix row `r`
  // was captured from absolute sheet row `clipboard.sourceRows[r]`, which
  // skips filter-hidden rows, so the visible rows slide together. Every row
  // after the first hidden gap therefore shifts by a DIFFERENT amount, and
  // the old shared `targetRow - sourceMinRow` mis-pointed all of them.
  // For an unfiltered copy every delta is identical, i.e. unchanged.
  const rowDeltas = pasteRowDeltas(
    clipboard.sourceRows,
    sourceMinRow,
    targetRow,
    sourceHeight
  );

  // Calculate deltas accounting for transpose
  const inputs: FormulaShiftInput[] = formulaEntries.map((e) => {
    if (transpose) {
      // When transposed, source [r][c] maps to target [c][r]
      const destRow = targetRow + e.c;
      const destCol = targetCol + e.r;
      return {
        formula: e.formula,
        rowDelta:
          destRow - clipboardSourceRow(clipboard.sourceRows, sourceMinRow, e.r),
        colDelta: destCol - (sourceMinCol + e.c),
      };
    } else {
      return {
        formula: e.formula,
        rowDelta: rowDeltas[e.r],
        colDelta: targetCol - sourceMinCol,
      };
    }
  });
  const shiftedFormulas = await shiftFormulasBatch(inputs);
  for (let i = 0; i < formulaEntries.length; i++) {
    const { r, c } = formulaEntries[i];
    shiftedFormulaMap.set(`${r},${c}`, shiftedFormulas[i]);
  }
  return shiftedFormulaMap;
}

/**
 * The cell paste itself, AFTER the questions (`mayPaste`): no refusal here,
 * only the work. Its begin opens its own undo step, or joins the one a caller
 * (Keep Source Column Widths, a script's batch) holds open.
 */
async function pasteCells(
  clipboard: ClipboardData,
  targetSelection: Selection,
  options: PasteSpecialOptions,
  totalRows: number,
  totalCols: number,
): Promise<void> {
  const { pasteAttribute, operation, skipBlanks, transpose } = options;
  const cellsToPaste = clipboard.cells;

  const targetRow = Math.min(targetSelection.startRow, targetSelection.endRow);
  const targetCol = Math.min(targetSelection.startCol, targetSelection.endCol);

  const { height: sourceHeight, width: sourceWidth } = matrixSize(cellsToPaste);

  // When transposing, swap dimensions
  const pasteHeight = transpose ? sourceWidth : sourceHeight;
  const pasteWidth = transpose ? sourceHeight : sourceWidth;

  // Clamp to grid bounds
  const actualPasteHeight = Math.min(pasteHeight, totalRows - targetRow);
  const actualPasteWidth = Math.min(pasteWidth, totalCols - targetCol);

  // Handle Column Widths specially - no cell data involved
  if (pasteAttribute === "columnWidths") {
    await pasteColumnWidths(clipboard, targetCol, sourceWidth, totalCols);
    return;
  }

  // Shift formulas for copy operations (not cut)
  const shiftedFormulaMap = await shiftedFormulasFor(clipboard, pasteAttribute, transpose, targetRow, targetCol);

  // An operation computes from the source's and the destination's cells, read
  // typed before anything is written (never their display text), and keeps
  // their formulas (Excel's `=(A1)+1`, BUG-0346).
  let operands: OperationOperands | null = null;
  if (operation !== "none" && actualPasteHeight > 0 && actualPasteWidth > 0) {
    const [source, destRead] = await Promise.all([
      readSourceOperands(clipboard, sourceHeight, sourceWidth),
      readSheetTyped(targetRow, targetCol, targetRow + actualPasteHeight - 1, targetCol + actualPasteWidth - 1),
    ]);
    operands = {
      source,
      dest: destOperandsOf(destRead),
      sourceFormulas: FORMULA_ATTRIBUTES.has(pasteAttribute) ? shiftedFormulaMap : null,
      target: undefined,
    };
  }

  // The grid route: no object target (`ctx.target` is the paste's place).
  const ctx: PasteContext = {
    clipboard,
    shiftedFormulaMap,
    styles: new Map(),
    target: undefined,
    operands,
    contentLanded: false,
  };

  // Begin undo transaction
  const cellCount = actualPasteHeight * actualPasteWidth;
  const tx = ownUndoTransaction(
    await beginUndoTransaction(`Paste Special (${pasteAttribute}) ${cellCount} cells`),
    UNDO_CLOSES,
  );

  // A cell whose write was refused is SKIPPED; a cell whose content landed
  // and whose formatting then failed is not -- its value changed -- and is
  // reported as such.
  let failedCells = 0;
  let firstFailure: string | null = null;
  let unformattedCells = 0;
  let firstUnformatted: string | null = null;
  try {
    for (let pr = 0; pr < actualPasteHeight; pr++) {
      for (let pc = 0; pc < actualPasteWidth; pc++) {
        const destRow = targetRow + pr;
        const destCol = targetCol + pc;

        // Map paste position back to source position
        const srcR = transpose ? pc : pr;
        const srcC = transpose ? pr : pc;

        // Bounds check on source
        if (srcR >= sourceHeight || srcC >= sourceWidth) continue;

        const sourceCell = cellsToPaste[srcR]?.[srcC] ?? null;

        // Skip blanks check
        if (skipBlanks && isCellBlank(sourceCell)) {
          continue;
        }

        // Grid bounds check
        if (destRow >= totalRows || destCol >= totalCols) continue;

        ctx.contentLanded = false;
        const failure = await pasteSingleCell(
          sourceCell,
          destRow,
          destCol,
          srcR,
          srcC,
          pasteAttribute,
          operation,
          ctx,
        );
        if (failure !== null && ctx.contentLanded) {
          unformattedCells++;
          firstUnformatted = firstUnformatted ?? failure;
        } else if (failure !== null) {
          failedCells++;
          firstFailure = firstFailure ?? failure;
        }
      }
    }

    // Commit whatever applied (an all-refused paste commits an empty
    // transaction, which is a no-op) so a partial paste stays undoable.
    await tx.commit();

    // Refresh grid
    window.dispatchEvent(new CustomEvent("styles:refresh"));
    window.dispatchEvent(new CustomEvent("grid:refresh"));
  } catch (error) {
    // Close the transaction — left open, every subsequent edit silently joins
    // it and collapses into one giant Ctrl+Z step.
    try { await tx.cancel(); } catch { /* already closed */ }
    void alertAsync(error instanceof Error ? error.message : String(error));
    throw error;
  }
  const sentences: string[] = [];
  if (failedCells > 0) {
    sentences.push(`Paste Special skipped ${failedCells} cell(s):\n${firstFailure ?? "unknown error"}`);
  }
  if (unformattedCells > 0) {
    sentences.push(pasteRefusalSentence.formattingNotApplied(unformattedCells, firstUnformatted ?? "unknown error"));
  }
  if (sentences.length > 0) void alertAsync(sentences.join("\n\n"));
}

/**
 * Execute a Paste Link operation: one link formula per copied cell, pointing
 * at the cell it was copied FROM -- on the sheet it was copied from, the row
 * it was copied from (a filtered copy's rows map back through `sourceRows`,
 * never `sourceMinRow + r`: clipboard survey defect 2). Answers true when it
 * pasted, false when it refused.
 */
export async function executePasteLink(
  clipboard: ClipboardData,
  targetSelection: Selection,
  totalRows: number,
  totalCols: number,
  label = "Paste Link",
  target?: CellTargetRef,
): Promise<boolean> {
  // Same door as executePasteSpecial (the dialog's Paste Link, the Edit menu's
  // Paste Link): refused while the selection is not Core's (BUG-0185), after
  // a cut, from a stale clipboard, over a protected region. With an OBJECT
  // target the links go into the object's cells in one batch.
  const area = pasteAreaOf(clipboard, targetSelection, false, totalRows, totalCols);
  if (!(await mayPaste(clipboard, area, label, target))) return false;

  // The source sheet as it is NOW (BUG-0348): renamed since the copy, the
  // link spells the new name; deleted, there is nothing left to link to.
  const source = await sourceSheetNow(clipboard);
  if (source === null) {
    void alertAsync(pasteRefusalSentence.sourceSheetGone(label, clipboard.sourceSheetName));
    return false;
  }

  const cellsToPaste = clipboard.cells;

  const targetRow = area.row;
  const targetCol = area.col;

  const sourceSel = clipboard.sourceSelection;
  const sourceMinRow = Math.min(sourceSel.startRow, sourceSel.endRow);
  const sourceMinCol = Math.min(sourceSel.startCol, sourceSel.endCol);

  const { height: pasteHeight, width: pasteWidth } = matrixSize(cellsToPaste);
  const actualPasteHeight = area.height;
  const actualPasteWidth = area.width;

  // Excel: one copied cell links absolutely, a copied range relatively.
  const absolute = pasteHeight === 1 && pasteWidth === 1;
  const sheetPrefix = linkSheetPrefix(clipboard, target, source);

  if (target) {
    const updates: CellUpdateInput[] = [];
    for (let r = 0; r < actualPasteHeight; r++) {
      for (let c = 0; c < actualPasteWidth; c++) {
        const srcRow = clipboardSourceRow(clipboard.sourceRows, sourceMinRow, r);
        const srcCol = sourceMinCol + c;
        // Every link is a formula, pasted: it stays one in a Text-formatted cell.
        updates.push(pastedUpdate(targetRow + r, targetCol + c, buildLinkFormula(sheetPrefix, srcRow, srcCol, absolute), false));
      }
    }
    await writeTargetBatch(updates, [], `Paste Link ${updates.length} cells`, target);
    return true;
  }

  const tx = ownUndoTransaction(
    await beginUndoTransaction(`Paste Link ${actualPasteHeight * actualPasteWidth} cells`),
    UNDO_CLOSES,
  );

  // A link is a formula, pasted: it stays one in a Text-formatted cell (pastedUpdate).
  let failedCells = 0;
  let firstFailure: string | null = null;
  try {
    for (let r = 0; r < actualPasteHeight; r++) {
      for (let c = 0; c < actualPasteWidth; c++) {
        const destRow = targetRow + r;
        const destCol = targetCol + c;

        if (destRow >= totalRows || destCol >= totalCols) continue;

        // The cell this matrix entry was copied from.
        const srcRow = clipboardSourceRow(clipboard.sourceRows, sourceMinRow, r);
        const srcCol = sourceMinCol + c;
        const formula = buildLinkFormula(sheetPrefix, srcRow, srcCol, absolute);

        try {
          // The sheet branch: no object target (that one returned above),
          // passed on all the same so this write can never land elsewhere.
          const updatedCells = await updateCellsBatch([pastedUpdate(destRow, destCol, formula, false)], { target });
          for (const cell of updatedCells) {
            if (cell.sheetIndex !== undefined) continue;
            cellEvents.emit({
              row: cell.row,
              col: cell.col,
              oldValue: undefined,
              newValue: cell.display,
              formula: cell.formula ?? null,
            });
          }
        } catch (err) {
          console.error(`[PasteSpecial] Failed to paste link (${destRow}, ${destCol}):`, err);
          failedCells++;
          firstFailure = firstFailure ?? (err instanceof Error ? err.message : String(err));
        }
      }
    }

    await tx.commit();

    window.dispatchEvent(new CustomEvent("styles:refresh"));
    window.dispatchEvent(new CustomEvent("grid:refresh"));
  } catch (error) {
    try { await tx.cancel(); } catch { /* already closed */ }
    void alertAsync(error instanceof Error ? error.message : String(error));
    throw error;
  }
  if (failedCells > 0) {
    void alertAsync(
      `Paste Link skipped ${failedCells} cell(s):\n${firstFailure ?? "unknown error"}`,
    );
  }
  return true;
}

// ============================================================================
// Internal Helpers
// ============================================================================

/** What one paste shares across its cells. */
interface PasteContext {
  clipboard: ClipboardData;
  shiftedFormulaMap: Map<string, string>;
  /** Style-table reads, once per index per paste (a column of one style asks once). */
  styles: Map<number, Promise<StyleData>>;
  /**
   * The paste's place: undefined on this per-cell route, which writes the
   * ACTIVE sheet (an object's cells go through `pasteCellsOnTarget`). Passed on
   * every target-taking wrapper call, so a write can never drop it.
   */
  target: CellTargetRef | undefined;
  /** An operation's typed operands (null when the paste has no operation). */
  operands: OperationOperands | null;
  /**
   * Whether the cell being pasted has had its CONTENT written yet (set by
   * `writeContent`, reset per cell): a failure after that -- the source's
   * style or number format refused -- is not a skipped cell, because the
   * cell's value already changed.
   */
  contentLanded: boolean;
}

/** The style table entry `index`, read once per paste. */
function styleOf(ctx: PasteContext, index: number): Promise<StyleData> {
  return cachedStyle(ctx.styles, index);
}

/**
 * Write one cell's CONTENT on this paste's place and record that it landed.
 * Every content write of the per-cell route goes through here, so a later
 * failure of the same cell is told apart from a refused write.
 */
async function writeContent(update: CellUpdateInput, ctx: PasteContext): Promise<CellData[]> {
  const written = await updateCellsBatch([update], { target: ctx.target });
  ctx.contentLanded = true;
  return written;
}

/** The display-text fallback (a copy without stored values; a collection's JSON): an ENTRY, as before. */
async function writeEntry(row: number, col: number, value: string, ctx: PasteContext): Promise<CellData[]> {
  const { cells } = await updateCell(row, col, value);
  ctx.contentLanded = true;
  return cells;
}

/** The formula a paste writes for source matrix cell (srcR, srcC), or null when it writes a value. */
function pastedFormulaOf(
  sourceCell: CellData | null,
  srcR: number,
  srcC: number,
  shiftedFormulaMap: Map<string, string>,
): string | null {
  return shiftedFormulaMap.get(`${srcR},${srcC}`) ?? sourceCell?.formula ?? null;
}

/**
 * What a paste writes for the copied cell at matrix position (srcR, srcC) as a
 * VALUE: its stored value, from the typed read the copy made
 * (`ClipboardData.values`; a formula cell's RESULT), through the one rule
 * `pastedConstantInput` -- the number 1.23456, never the "1.23" it showed under
 * 0.00, written invariant. Null when the copy carries no stored values (it could
 * not read them typed) or the rule cannot vouch for this cell: the paste then
 * writes the display text, as before.
 */
function storedConstantOf(clipboard: ClipboardData, sourceCell: CellData | null, srcR: number, srcC: number): PastedConstant | null {
  const values = clipboard.values;
  if (!values) return null;
  return pastedConstantInput(values[srcR]?.[srcC], sourceCell?.display ?? "");
}

/**
 * Write one copied CONSTANT into a cell of the active sheet: its stored value,
 * invariant, as a PASTE -- a number, TRUE / FALSE or an error stays one in a
 * Text-formatted cell (Excel, measured live through COM 2026-10-29: Paste
 * Values and Paste Formulas of the number 5 into an @ cell -> the number 5).
 */
async function writeStoredConstant(
  constant: PastedConstant,
  destRow: number,
  destCol: number,
  ctx: PasteContext,
): Promise<CellData[]> {
  return writeContent({ row: destRow, col: destCol, ...constant }, ctx);
}

/**
 * Paste the source's formula (shifted) -- or, for a constant, its STORED value
 * (`storedConstantOf`) -- into one cell of the active sheet, as a PASTE: a
 * formula or a number stays one in a Text-formatted cell. Only a copy with no
 * stored values writes the display text, as an entry, as before.
 */
async function writeFormulaOrDisplay(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number,
  srcR: number,
  srcC: number,
  ctx: PasteContext,
): Promise<void> {
  const formula = pastedFormulaOf(sourceCell, srcR, srcC, ctx.shiftedFormulaMap);
  if (formula) {
    emitUpdated(await writeContent(pastedUpdate(destRow, destCol, formula, false), ctx));
    return;
  }
  const constant = storedConstantOf(ctx.clipboard, sourceCell, srcR, srcC);
  if (constant) {
    emitUpdated(await writeStoredConstant(constant, destRow, destCol, ctx));
    return;
  }
  emitUpdated(await writeEntry(destRow, destCol, sourceCell?.display ?? "", ctx));
}

/**
 * Paste the source's VALUE into one cell of the active sheet (Paste Values and
 * its variants): a List / Dict collection as its JSON text, as before; any
 * other cell as its STORED value -- a formula's result, a constant -- written
 * invariant (`storedConstantOf`); only a copy with no stored values writes
 * the display text.
 */
async function writeValue(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number,
  srcR: number,
  srcC: number,
  ctx: PasteContext,
): Promise<void> {
  if (isCollectionCell(sourceCell)) {
    const jsonText = ctx.clipboard.collectionTexts?.get(`${srcR},${srcC}`);
    emitUpdated(await writeEntry(destRow, destCol, jsonText || (sourceCell?.display ?? ""), ctx));
    return;
  }
  const constant = storedConstantOf(ctx.clipboard, sourceCell, srcR, srcC);
  if (constant) {
    emitUpdated(await writeStoredConstant(constant, destRow, destCol, ctx));
    return;
  }
  emitUpdated(await writeEntry(destRow, destCol, sourceCell?.display ?? "", ctx));
}

/**
 * The style a source cell carries. An EMPTY source position (no cell record:
 * the matrix holds null) carries the DEFAULT style, index 0 -- what plain
 * Paste writes for it (`sourceCell?.styleIndex ?? 0`, useClipboard.ts), and
 * what Excel does: pasting an unformatted empty cell clears the destination's
 * formatting. Paste All and Paste Formatting used to skip such a cell and
 * leave the destination's old formatting standing.
 */
function sourceStyleIndex(sourceCell: CellData | null): number {
  return sourceCell?.styleIndex ?? 0;
}

/**
 * Paste a single cell based on the selected attribute and operation.
 */
async function pasteSingleCell(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number,
  srcR: number,
  srcC: number,
  pasteAttribute: PasteAttribute,
  operation: PasteOperation,
  ctx: PasteContext,
): Promise<string | null> {
  const { clipboard } = ctx;
  try {
    switch (pasteAttribute) {
      case "all":
        await pasteAll(sourceCell, destRow, destCol, srcR, srcC, operation, ctx);
        break;
      case "formulas":
        await pasteFormulas(sourceCell, destRow, destCol, srcR, srcC, operation, ctx);
        break;
      case "values":
        await pasteValues(sourceCell, destRow, destCol, srcR, srcC, operation, ctx);
        break;
      case "formats":
        await pasteFormats(sourceCell, destRow, destCol);
        break;
      case "comments":
        await pasteComments(clipboard, destRow, destCol, srcR, srcC);
        break;
      case "validation":
        await pasteValidation(clipboard, destRow, destCol, srcR, srcC);
        break;
      case "allExceptBorders":
        await pasteAllExceptBorders(sourceCell, destRow, destCol, srcR, srcC, operation, ctx);
        break;
      case "formulasAndNumberFormats":
        await pasteFormulasAndNumberFormats(sourceCell, destRow, destCol, srcR, srcC, operation, ctx);
        break;
      case "valuesAndNumberFormats":
        await pasteValuesAndNumberFormats(sourceCell, destRow, destCol, srcR, srcC, operation, ctx);
        break;
      case "valuesAndSourceFormatting":
        await pasteValuesAndSourceFormatting(sourceCell, destRow, destCol, srcR, srcC, operation, ctx);
        break;
      case "columnWidths":
        // Handled before the cell loop (pasteCells); no cell is written.
        break;
    }
  } catch (err) {
    // Per-cell failure (most commonly a sheet-protection refusal): report it
    // to the caller so the OPERATION can tell the user, instead of swallowing
    // every refusal and finishing as a silent no-op.
    console.error(`[PasteSpecial] Failed to paste cell (${destRow}, ${destCol}):`, err);
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}

/** Announce the cells a write changed (the active sheet's only). */
function emitUpdated(updatedCells: CellData[]): void {
  for (const cell of updatedCells) {
    if (cell.sheetIndex !== undefined) continue;
    cellEvents.emit({
      row: cell.row,
      col: cell.col,
      oldValue: undefined,
      newValue: cell.display,
      formula: cell.formula ?? null,
    });
  }
}

/**
 * Paste All: value/formula + style (same as standard paste). With an
 * operation the source's style is pasted whether or not the operation wrote
 * the cell (Excel: "abc" + Add 1 stays "abc" and takes the source's format).
 */
async function pasteAll(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number,
  srcR: number,
  srcC: number,
  operation: PasteOperation,
  ctx: PasteContext,
): Promise<void> {
  if (operation !== "none") {
    // With operation: compute and write result, also copy style
    await pasteWithOperation(sourceCell, destRow, destCol, srcR, srcC, operation, ctx);
  } else {
    // No operation: paste formula/value, then the style
    await writeFormulaOrDisplay(sourceCell, destRow, destCol, srcR, srcC, ctx);
  }
  await setCellStyle(destRow, destCol, sourceStyleIndex(sourceCell));
}

/**
 * Paste Formulas: formula text only, keep target formatting.
 */
async function pasteFormulas(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number,
  srcR: number,
  srcC: number,
  operation: PasteOperation,
  ctx: PasteContext,
): Promise<void> {
  if (operation !== "none") {
    await pasteWithOperation(sourceCell, destRow, destCol, srcR, srcC, operation, ctx);
  } else {
    // Do NOT set style - keep target formatting
    await writeFormulaOrDisplay(sourceCell, destRow, destCol, srcR, srcC, ctx);
  }
}

/**
 * Paste Values: the stored value only (flattens formulas to their results),
 * no formatting change (`writeValue`). For List/Dict cells, pastes the JSON
 * representation if available.
 */
async function pasteValues(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number,
  srcR: number,
  srcC: number,
  operation: PasteOperation,
  ctx: PasteContext,
): Promise<void> {
  if (operation !== "none") {
    await pasteWithOperation(sourceCell, destRow, destCol, srcR, srcC, operation, ctx);
  } else {
    // Do NOT set style - keep target formatting
    await writeValue(sourceCell, destRow, destCol, srcR, srcC, ctx);
  }
}

/**
 * Paste Values and Source Formatting (Excel's Home > Paste > "Values & Source
 * Formatting"): the flattened value, as Paste Values writes it, and then the
 * source cell's WHOLE style -- every field, by pointing the destination at the
 * source's style index, so a field added to the style later travels too.
 */
async function pasteValuesAndSourceFormatting(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number,
  srcR: number,
  srcC: number,
  operation: PasteOperation,
  ctx: PasteContext,
): Promise<void> {
  await pasteValues(sourceCell, destRow, destCol, srcR, srcC, operation, ctx);
  await setCellStyle(destRow, destCol, sourceStyleIndex(sourceCell));
}

/**
 * Paste Formats: style only, no value change.
 */
async function pasteFormats(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number
): Promise<void> {
  await setCellStyle(destRow, destCol, sourceStyleIndex(sourceCell));

  cellEvents.emit({
    row: destRow,
    col: destCol,
    oldValue: undefined,
    newValue: "",
    formula: null,
  });
}

/**
 * What an operation writes over one destination cell (see `Operand`), or null
 * to leave it as it is. Skips List/Dict collection cells on either side (not
 * meaningful for arithmetic). Reads only what `pasteCells` /
 * `pasteCellsOnTarget` read typed BEFORE the paste wrote anything.
 */
function operationWriteFor(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number,
  srcR: number,
  srcC: number,
  operation: PasteOperation,
  operands: OperationOperands | null,
): { value: string; invariant: boolean } | null {
  const destCell = operands?.dest.get(`${destRow},${destCol}`);
  if (isCollectionCell(sourceCell) || isCollectionCell(destCell)) return null;
  return operationWrite(destOperand(destCell), sourceOperand(sourceCell, srcR, srcC, operands), operation);
}

/**
 * Paste with mathematical operation (Excel's rules: `Operand`): a formula on
 * either side gives `=(old)+src`; two constants give the computed constant,
 * written INVARIANT; an inert side writes nothing. Either result is a number
 * or a formula, written as a PASTE, so it stays one in a Text-formatted cell.
 */
async function pasteWithOperation(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number,
  srcR: number,
  srcC: number,
  operation: PasteOperation,
  ctx: PasteContext,
): Promise<void> {
  const write = operationWriteFor(sourceCell, destRow, destCol, srcR, srcC, operation, ctx.operands);
  if (write === null) return;
  emitUpdated(await writeContent(pastedUpdate(destRow, destCol, write.value, write.invariant), ctx));
}

// ----------------------------------------------------------------------------
// No Borders
// ----------------------------------------------------------------------------

/** The style fields that ARE borders -- derived from the type, never listed. */
type BorderKey = Extract<keyof StyleData, `border${string}`>;
/** What applyFormatting takes for one border side. */
type BorderParam = NonNullable<FormattingOptions[BorderKey]>;
/** One border side as the style table reports it. */
type BorderSide = StyleData[BorderKey];

/** The border sides a style carries, read off the style itself. */
function borderKeysOf(style: StyleData): BorderKey[] {
  return (Object.keys(style) as Array<keyof StyleData>).filter(
    (k): k is BorderKey => k.startsWith("border"),
  );
}

function isNoBorder(side: BorderSide | undefined): boolean {
  return !side || side.style === "none" || side.width === 0;
}

function sameBorder(a: BorderSide | undefined, b: BorderSide | undefined): boolean {
  if (isNoBorder(a) && isNoBorder(b)) return true;
  if (isNoBorder(a) || isNoBorder(b)) return false;
  return a!.style === b!.style && a!.color === b!.color && a!.width === b!.width;
}

function borderParamOf(side: BorderSide | undefined): BorderParam {
  return isNoBorder(side) ? { style: "none", color: "#000000" } : { style: side!.style, color: side!.color };
}

/**
 * Paste All Except Borders (Excel's "No Borders"): the value/formula and
 * EVERY style field of the source except its borders; the destination keeps
 * its OWN borders.
 *
 * Excel, measured live through COM (2026-10-04, xlPasteAllExceptBorders onto a
 * cell that had a thick top border and italic): bold and indent 2 arrived from
 * the source, the destination's italic went, the source's bottom border did
 * NOT arrive, and the destination's thick top border STAYED.
 *
 * DERIVED, not hand-listed. This used to re-apply a hand-copied list of
 * fifteen style fields through applyFormatting, which left out indent,
 * shrink-to-fit, fills, theme colours and the protection flags -- and would
 * have left out every field added to the style after it (clipboard survey
 * defect 5). Now the destination is pointed at the SOURCE's style index (the
 * whole style, whatever it holds), and only the border sides -- found by
 * their `border` prefix on the style objects themselves -- are put back to
 * what the destination had, side by side, and only where the two differ.
 * The one lossy corner is the border wire itself: applyFormatting takes a
 * side as {style, color}, so a destination border coloured from a THEME slot
 * comes back as its resolved colour.
 */
async function pasteAllExceptBorders(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number,
  srcR: number,
  srcC: number,
  operation: PasteOperation,
  ctx: PasteContext,
): Promise<void> {
  // The destination's borders, read BEFORE the source style replaces them.
  const destCell = await getCell(destRow, destCol);
  const destStyle = await styleOf(ctx, destCell?.styleIndex ?? 0);

  if (operation !== "none") {
    await pasteWithOperation(sourceCell, destRow, destCol, srcR, srcC, operation, ctx);
  } else {
    await writeFormulaOrDisplay(sourceCell, destRow, destCol, srcR, srcC, ctx);
  }

  // Every style field of the source...
  const sourceIndex = sourceStyleIndex(sourceCell);
  const sourceStyle = await styleOf(ctx, sourceIndex);
  await setCellStyle(destRow, destCol, sourceIndex);

  // ...except borders: each side the destination had differently goes back.
  const borders: Partial<Record<BorderKey, BorderParam>> = {};
  for (const key of new Set([...borderKeysOf(sourceStyle), ...borderKeysOf(destStyle)])) {
    if (sameBorder(sourceStyle[key], destStyle[key])) continue;
    borders[key] = borderParamOf(destStyle[key]);
  }
  if (Object.keys(borders).length > 0) {
    await applyFormatting([destRow], [destCol], borders as FormattingOptions, { target: ctx.target });
  }
}

/**
 * Paste Formulas and Number Formats: formula text + number format, keep other formatting.
 */
async function pasteFormulasAndNumberFormats(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number,
  srcR: number,
  srcC: number,
  operation: PasteOperation,
  ctx: PasteContext,
): Promise<void> {
  if (operation !== "none") {
    await pasteWithOperation(sourceCell, destRow, destCol, srcR, srcC, operation, ctx);
  } else {
    await writeFormulaOrDisplay(sourceCell, destRow, destCol, srcR, srcC, ctx);
  }

  // Copy only the number format from source style
  if (sourceCell) {
    const sourceStyle = await styleOf(ctx, sourceCell.styleIndex);
    await applyFormatting([destRow], [destCol], { numberFormat: sourceStyle.numberFormat }, { target: ctx.target });
  }
}

/**
 * Paste Values and Number Formats: the stored value (flattened) + number format, keep other formatting.
 */
async function pasteValuesAndNumberFormats(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number,
  srcR: number,
  srcC: number,
  operation: PasteOperation,
  ctx: PasteContext,
): Promise<void> {
  if (operation !== "none") {
    await pasteWithOperation(sourceCell, destRow, destCol, srcR, srcC, operation, ctx);
  } else {
    await writeValue(sourceCell, destRow, destCol, srcR, srcC, ctx);
  }

  // Copy only the number format from source style
  if (sourceCell) {
    const sourceStyle = await styleOf(ctx, sourceCell.styleIndex);
    await applyFormatting([destRow], [destCol], { numberFormat: sourceStyle.numberFormat }, { target: ctx.target });
  }
}

/**
 * Paste Comments: copy comment from source cell to target cell.
 *
 * A refusal THROWS to pasteSingleCell, which counts it and names it in the
 * paste's one alert -- it used to be caught here and logged, so a protected
 * destination finished as a silent no-op.
 */
async function pasteComments(
  clipboard: ClipboardData,
  destRow: number,
  destCol: number,
  srcR: number,
  srcC: number,
): Promise<void> {
  const comment = clipboard.comments?.get(`${srcR},${srcC}`);
  if (!comment) return;

  const params: AddCommentParams = {
    row: destRow,
    col: destCol,
    authorEmail: comment.authorEmail,
    authorName: comment.authorName,
    content: comment.content,
    richContent: comment.richContent,
    mentions: comment.mentions,
  };
  await addComment(params);
}

/**
 * Paste Validation: copy data validation rule from source cell to target cell.
 * A refusal throws to pasteSingleCell (see pasteComments).
 */
async function pasteValidation(
  clipboard: ClipboardData,
  destRow: number,
  destCol: number,
  srcR: number,
  srcC: number,
): Promise<void> {
  const validation = clipboard.validations?.get(`${srcR},${srcC}`);
  if (!validation) return;

  await setDataValidation(destRow, destCol, destRow, destCol, validation);
}

/**
 * Paste Column Widths: copy source column dimensions to target columns.
 */
async function pasteColumnWidths(
  clipboard: ClipboardData,
  targetCol: number,
  sourceWidth: number,
  totalCols: number
): Promise<void> {
  const sourceSel = clipboard.sourceSelection;
  const sourceMinCol = Math.min(sourceSel.startCol, sourceSel.endCol);

  const tx = ownUndoTransaction(await beginUndoTransaction(`Paste Column Widths`), UNDO_CLOSES);

  try {
    for (let c = 0; c < sourceWidth; c++) {
      const srcCol = sourceMinCol + c;
      const destCol = targetCol + c;

      if (destCol >= totalCols) break;

      const width = await getColumnWidth(srcCol);
      if (width !== null) {
        await setColumnWidth(destCol, width);
      }
    }

    await tx.commit();
    window.dispatchEvent(new CustomEvent("grid:refresh"));
  } catch (error) {
    console.error("[PasteSpecial] Column widths paste failed:", error);
    try { await tx.cancel(); } catch { /* already closed */ }
    void alertAsync(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

// ============================================================================
// The OBJECT route (a floating grid's cells, P3)
// ============================================================================

/**
 * The attributes a paste onto an object's cells can write: those expressible
 * as a value (with or without the source's whole style) plus a number format.
 * A style-only write has no route onto an object's cells (no style-index write
 * takes a target), comments and validation have no door there, and column
 * widths are the object's own.
 */
const TARGET_PASTE_ATTRIBUTES: ReadonlySet<PasteAttribute> = new Set<PasteAttribute>([
  "all",
  "formulas",
  "values",
  "valuesAndSourceFormatting",
  "formulasAndNumberFormats",
  "valuesAndNumberFormats",
]);

/**
 * Write `updates` (values, with a style index where the source's style
 * travels) to the object's cells in ONE batch, then each `numberFormats`
 * entry, all inside ONE undo step (the batch's own owned step joins it).
 * A refusal is shown and the step closed; nothing half-applied is left open.
 * A pasted formula or stored value carries `pasted` (`pastedUpdate`), so it
 * keeps its kind in a Text-formatted cell in this same batch.
 */
async function writeTargetBatch(
  updates: CellUpdateInput[],
  numberFormats: Array<{ row: number; col: number; numberFormat: string }>,
  description: string,
  target: CellTargetRef,
): Promise<void> {
  const tx = ownUndoTransaction(await beginUndoTransaction(description), UNDO_CLOSES);
  let landed = false;
  try {
    if (updates.length > 0) {
      await updateCellsBatch(updates, { target });
      landed = true;
    }
    for (const nf of numberFormats) {
      await applyFormatting([nf.row], [nf.col], { numberFormat: nf.numberFormat }, { target });
      landed = true;
    }
    await tx.commit();
  } catch (error) {
    // What landed stays ONE undoable step; with nothing landed the step is dropped.
    try {
      if (landed) await tx.commit();
      else await tx.cancel();
    } catch {
      /* already closed */
    }
    void alertAsync(error instanceof Error ? error.message : String(error));
    throw error;
  }
  window.dispatchEvent(new CustomEvent("styles:refresh"));
  window.dispatchEvent(new CustomEvent("grid:refresh"));
}

/**
 * What a Paste All (or Values & Source Formatting) WITH AN OPERATION writes
 * into an object cell the operation leaves alone -- an inert side ("abc" + 1),
 * blank on blank -- so the source's style still arrives, as it does on the
 * sheet (Excel, measured live through COM 2026-10-29: "abc" + Add of a bold
 * 0.00% 1 stays "abc", bold, 0.00%). There is no style-index write that takes a
 * target (BUG-0513), so the cell's own content is written back unchanged with
 * the style, as a PASTE (it keeps its kind under an @ source style): a blank as
 * a clear (the backend keeps the style a clear brings), a number, TRUE / FALSE
 * or an error as its invariant literal, text behind an apostrophe (stored
 * verbatim, never re-read as a number).
 *
 * Null -- the cell keeps its old format, as before -- where writing it back
 * would not be exact: a FORMULA (re-entering it on a floating grid is not
 * neutral: no UDF or CUBE pre-resolution reaches that route), rich text (the
 * runs would be lost), a List / Dict collection.
 */
function contentWrittenBack(
  dest: TypedCellData | undefined,
  richText: boolean,
): { value: string; invariant: boolean } | null {
  if (!dest || dest.type === "empty") return { value: "", invariant: false };
  if (dest.formula || dest.formulaWithheld || isCollectionCell(dest)) return null;
  switch (dest.type) {
    case "number":
      return typeof dest.value === "number" && Number.isFinite(dest.value)
        ? { value: String(dest.value), invariant: true }
        : null;
    case "boolean":
      return { value: dest.value ? "TRUE" : "FALSE", invariant: true };
    case "error":
      return typeof dest.value === "string" && dest.value.startsWith("#")
        ? { value: dest.value, invariant: true }
        : null;
    case "text":
      return richText ? null : { value: `'${String(dest.value ?? "")}`, invariant: false };
    default:
      return null;
  }
}

/**
 * Paste Special onto an OBJECT's cells: the same rules as `pasteCells`
 * (transpose, skip blanks, operations, Excel's relative shift), written as one
 * batch through the target instead of one active-sheet call per cell.
 */
async function pasteCellsOnTarget(
  clipboard: ClipboardData,
  targetSelection: Selection,
  options: PasteSpecialOptions,
  totalRows: number,
  totalCols: number,
  target: CellTargetRef,
): Promise<void> {
  const { pasteAttribute, operation, skipBlanks, transpose } = options;
  const cellsToPaste = clipboard.cells;
  const targetRow = Math.min(targetSelection.startRow, targetSelection.endRow);
  const targetCol = Math.min(targetSelection.startCol, targetSelection.endCol);
  const { height: sourceHeight, width: sourceWidth } = matrixSize(cellsToPaste);
  const pasteHeight = transpose ? sourceWidth : sourceHeight;
  const pasteWidth = transpose ? sourceHeight : sourceWidth;
  const actualPasteHeight = Math.max(0, Math.min(pasteHeight, totalRows - targetRow));
  const actualPasteWidth = Math.max(0, Math.min(pasteWidth, totalCols - targetCol));
  if (actualPasteHeight === 0 || actualPasteWidth === 0) return;

  const shiftedFormulaMap = await shiftedFormulasFor(clipboard, pasteAttribute, transpose, targetRow, targetCol);

  const carriesStyle = pasteAttribute === "all" || pasteAttribute === "valuesAndSourceFormatting";
  const carriesNumberFormat =
    pasteAttribute === "formulasAndNumberFormats" || pasteAttribute === "valuesAndNumberFormats";
  const writesFormula =
    pasteAttribute === "all" || pasteAttribute === "formulas" || pasteAttribute === "formulasAndNumberFormats";

  // An operation reads what the destination holds now: the object's cells,
  // through its typed read (never the active sheet's cell at those
  // coordinates) -- the stored values, the formulas an operation keeps, and
  // the display the collection check reads. When the source's style travels,
  // the styled read says which cells carry rich text (`contentWrittenBack`).
  let operands: OperationOperands | null = null;
  let richTextAt: ReadonlySet<string> | null = null;
  if (operation !== "none") {
    const rect = {
      startRow: targetRow,
      startCol: targetCol,
      endRow: targetRow + actualPasteHeight - 1,
      endCol: targetCol + actualPasteWidth - 1,
    };
    const [typed, source, styled] = await Promise.all([
      getCellTargetCellsTyped(target, rect),
      readSourceOperands(clipboard, sourceHeight, sourceWidth),
      carriesStyle ? richTextCellsOf(target, rect) : Promise.resolve(null),
    ]);
    operands = {
      source,
      dest: destOperandsOf(typed),
      sourceFormulas: FORMULA_ATTRIBUTES.has(pasteAttribute) ? shiftedFormulaMap : null,
      target,
    };
    richTextAt = styled;
  }

  const styles = new Map<number, Promise<StyleData>>();

  const updates: CellUpdateInput[] = [];
  const numberFormats: Array<{ row: number; col: number; numberFormat: string }> = [];
  for (let pr = 0; pr < actualPasteHeight; pr++) {
    for (let pc = 0; pc < actualPasteWidth; pc++) {
      const destRow = targetRow + pr;
      const destCol = targetCol + pc;
      const srcR = transpose ? pc : pr;
      const srcC = transpose ? pr : pc;
      if (srcR >= sourceHeight || srcC >= sourceWidth) continue;
      const sourceCell = cellsToPaste[srcR]?.[srcC] ?? null;
      if (skipBlanks && isCellBlank(sourceCell)) continue;
      const key = `${destRow},${destCol}`;

      // Every write but the display-text fallback is a PASTE (`pastedUpdate`):
      // a formula or a stored value keeps its kind in a Text-formatted cell.
      let update: CellUpdateInput | null = null;
      if (operation !== "none") {
        // The same rules as on a sheet (`Operand`): a formula stays a formula,
        // an inert side or blank on blank writes nothing, collections are skipped.
        const write = operationWriteFor(sourceCell, destRow, destCol, srcR, srcC, operation, operands);
        if (write) update = pastedUpdate(destRow, destCol, write.value, write.invariant);
        if (write === null && carriesStyle && richTextAt !== null) {
          // The operation leaves the cell alone; the source's style still arrives.
          const back = contentWrittenBack(operands?.dest.get(key), richTextAt.has(key));
          if (back) update = pastedUpdate(destRow, destCol, back.value, back.invariant);
        }
      } else {
        // A formula (when the attribute pastes formulas), else the STORED
        // value -- a constant, or under a values attribute a formula's result
        // -- invariant (`storedConstantOf`); a collection as its JSON text;
        // only a copy with no stored values writes the display text.
        const formula = writesFormula ? pastedFormulaOf(sourceCell, srcR, srcC, shiftedFormulaMap) : null;
        const constant = formula || isCollectionCell(sourceCell) ? null : storedConstantOf(clipboard, sourceCell, srcR, srcC);
        if (formula) {
          update = pastedUpdate(destRow, destCol, formula, false);
        } else if (constant) {
          update = { row: destRow, col: destCol, ...constant };
        } else {
          let value = sourceCell?.display ?? "";
          if (!writesFormula && isCollectionCell(sourceCell)) {
            const jsonText = clipboard.collectionTexts?.get(`${srcR},${srcC}`);
            if (jsonText) value = jsonText;
          }
          update = { row: destRow, col: destCol, value };
        }
      }

      if (update !== null) {
        if (carriesStyle) update.styleIndex = sourceStyleIndex(sourceCell);
        updates.push(update);
      }
      if (carriesNumberFormat && sourceCell) {
        const sourceStyle = await cachedStyle(styles, sourceCell.styleIndex);
        numberFormats.push({ row: destRow, col: destCol, numberFormat: sourceStyle.numberFormat });
      }
    }
  }
  if (updates.length === 0 && numberFormats.length === 0) return;
  await writeTargetBatch(
    updates,
    numberFormats,
    `Paste Special (${pasteAttribute}) ${actualPasteHeight * actualPasteWidth} cells`,
    target,
  );
}

/**
 * The object cells ("row,col") in `rect` that carry rich text, from the
 * styled read; null when it cannot be read -- then no cell's content is
 * written back (`contentWrittenBack`), as before.
 */
async function richTextCellsOf(
  target: CellTargetRef,
  rect: { startRow: number; startCol: number; endRow: number; endCol: number },
): Promise<ReadonlySet<string> | null> {
  try {
    const read = await getCellTargetCells(target, rect);
    const out = new Set<string>();
    for (const cell of read?.cells ?? []) {
      if (cell.richText && cell.richText.length > 0) out.add(`${cell.row},${cell.col}`);
    }
    return out;
  } catch (err) {
    console.warn("[PasteSpecial] the floating grid's cells could not be read for their rich text:", err);
    return null;
  }
}
