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
//          object's own coordinates -- then every style-only write (Formatting,
//          the source's style on a cell an operation leaves alone, and No
//          Borders' source style with each cell's OWN borders kept,
//          `keepBorders`) in ONE `setCellStyles(.., { target })` (BUG-0513,
//          BUG-0345, BUG-0347), and the number formats grouped
//          (`numberFormatGroups`) -- all inside the paste's ONE undo step, and
//          never half done: every cell that takes formatting is CHECKED before
//          the first write (`writeTargetBatch`). A host that refuses Format
//          Cells refuses a formatting-only paste whole over a LOCKED grid cell,
//          changes nothing SILENTLY over unlocked ones (BUG-0655, the sheet's
//          rule), and pastes content without its formatting. What has no route
//          onto an object's cells is refused there in one sentence: comments
//          and validation (their doors refuse on a floating grid), and column
//          widths (the object's widths are not the sheet's).
//
//          ON A PROTECTED SHEET the paste is never half done either: every
//          written cell is asked BEFORE the first write (`protectedPasteGate`)
//          -- content onto a locked cell refuses the whole paste, and a sheet
//          that does not allow Format Cells refuses a formatting-only paste
//          whole over a locked cell, changes nothing silently over unlocked
//          ones, and pastes content without its formatting, as Excel does
//          [LIVE].
//
//          EVERY sheet-route paste COLLECTS its writes (`TileBatch`), tiled (a
//          selection that is a multiple of the copy) or not (BUG-0345): every
//          cell's content in one `updateCellsBatch`, every tile's formulas in
//          one shift, every style-only write in one `setCellStyles`, the number
//          formats grouped -- a bounded number of calls whatever the area. Only
//          comments and validation remain one call per cell: the backend has no
//          batch door for them. Paste Link writes its links in one batch too.
//
//          AFTER A PASTE the pasted range is SELECTED (BUG-0349), as plain
//          Paste does and Excel does [LIVE]: Core's selection on the sheet, the
//          grid's own selection on a floating grid.
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
//
//          AND IT IS WHAT THE SOURCE HOLDS AT THE WRITE (BUG-0657): with no
//          operation, no Transpose and Skip Blanks off, every content write
//          names its SOURCE cell (`pasteSourcePlan`, `CellUpdateInput.source`;
//          `valuesOnly` for the values attributes) and the backend writes what
//          that cell holds then -- the snapshot answers only for the formatting
//          and the fallback `value`. The settled snapshot alone lost to a
//          source written continuously (an animation, a fast scheduled job).

import type { CellData, Selection, StyleData } from "@api/types";
import type {
  ClipboardData,
  FormulaShiftInput,
  AddCommentParams,
  CellUpdateInput,
  CellStyleWrite,
  TypedCellData,
  SheetsResult,
  PastedConstant,
  PasteSource,
} from "@api/lib";
import type { PasteSpecialOptions, PasteOperation, PasteAttribute } from "./types";
import {
  getSheets,
  setCellStyle,
  setCellStyles,
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
  canEditCells,
  canPerformAction,
  pastedConstantInput,
  getMergedRegions,
  PASTE_ONCE,
  pasteMayTile,
  pasteTiles,
  clipboardSourceStandsAt,
  type PasteTiles,
} from "@api/lib";
import { cellEvents } from "@api";
import { alertAsync } from "@api/dialogs";
import {
  cellTargetFor,
  getCellTargetCellsTyped,
  resolveCellTarget,
  selectTargetCells,
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
 * Where a Paste Special write pastes FROM (BUG-0657): the source cells it
 * names (`CellUpdateInput.source`), so the backend writes what each holds AT
 * THE WRITE -- read under the batch's own guards, before any of its writes --
 * rather than the settled snapshot, which a writer that never stops (an
 * animation, a fast scheduled job) has already outrun by then. Excel pastes
 * what the source holds at the paste [LIVE, round 19, misc19/probe3.ps1: with
 * A1 = B1*2 copied, a write of 5 into B1 keeps the copy pending and Paste
 * Values gives 10]. Plain Paste has named its sources since round C
 * (useClipboard.ts `pasteSourceOf`); this is the same rule for the doors here.
 */
interface PasteSourcePlan {
  /** The source sheet's index NOW (unused, but a valid index, with `target`). */
  sheetIndex: number;
  /** An object's cells (a floating grid) the copy came from, in its coordinates. */
  target?: CellTargetRef;
  /** A values attribute: the source's value (a formula's result), never its formula. */
  valuesOnly: boolean;
  minRow: number;
  minCol: number;
}

/**
 * The sources a paste of `clipboard` under `options` names, or null when it
 * pastes the snapshot. Named only where the backend's paste rule is the whole
 * answer: the cell's CONTENT attributes (formulas shifted as Copy + Paste
 * shifts them; `valuesOnly` for the values attributes), with no operation, no
 * Transpose and Skip Blanks off -- the backend has no rule for an operation, a
 * transposed shift or a skipped blank, so those keep the snapshot. Never for
 * a cut (refused before this), a copy whose source no longer stands where it
 * was copied (`clipboardSourceStandsAt`: it followed a shift, its positions
 * were lost, the mode ended), or a source sheet that is gone.
 */
async function pasteSourcePlan(clipboard: ClipboardData, options: PasteSpecialOptions): Promise<PasteSourcePlan | null> {
  const { pasteAttribute, operation, skipBlanks, transpose } = options;
  if (operation !== "none" || transpose || skipBlanks || clipboard.isCut) return null;
  if (!CONTENT_ATTRIBUTES.has(pasteAttribute)) return null;
  if (!clipboardSourceStandsAt(clipboard)) return null;
  const valuesOnly = !FORMULA_ATTRIBUTES.has(pasteAttribute);
  const minRow = Math.min(clipboard.sourceSelection.startRow, clipboard.sourceSelection.endRow);
  const minCol = Math.min(clipboard.sourceSelection.startCol, clipboard.sourceSelection.endCol);
  if (clipboard.sourceTarget) {
    // An object's cells carry no sheet (ClipboardData.sourceSheetIndex is -1,
    // which the wire's index refuses); the backend reads the object's own.
    return { sheetIndex: 0, target: clipboard.sourceTarget, valuesOnly, minRow, minCol };
  }
  const sheet = await sourceSheetNow(clipboard);
  if (sheet === null) return null;
  const sheetIndex = sheet?.index ?? clipboard.sourceSheetIndex;
  if (!Number.isInteger(sheetIndex) || sheetIndex < 0) return null;
  return { sheetIndex, valuesOnly, minRow, minCol };
}

/** The source cell of clipboard matrix position (srcR, srcC) under `plan`. */
function pasteSourceAt(plan: PasteSourcePlan, clipboard: ClipboardData, srcR: number, srcC: number): PasteSource {
  return {
    sheetIndex: plan.sheetIndex,
    row: clipboardSourceRow(clipboard.sourceRows, plan.minRow, srcR),
    col: plan.minCol + srcC,
    ...(plan.target ? { target: plan.target } : {}),
    ...(plan.valuesOnly ? { valuesOnly: true } : {}),
  };
}

/**
 * Right before the writes go out: a copy that FOLLOWED a shift during the
 * paste's awaits names other cells now, so every write pastes the snapshot it
 * carries instead (as plain Paste does past its bounded restarts).
 */
function keepSourcesOnlyWhereTheyStand(clipboard: ClipboardData, updates: CellUpdateInput[]): void {
  if (clipboardSourceStandsAt(clipboard)) return;
  for (const update of updates) delete update.source;
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
  tiles: PasteTiles = PASTE_ONCE,
): PasteArea {
  const row = Math.min(target.startRow, target.endRow);
  const col = Math.min(target.startCol, target.endCol);
  const { height, width } = matrixSize(clipboard.cells ?? []);
  return {
    row,
    col,
    height: Math.max(0, Math.min((transpose ? width : height) * tiles.rows, totalRows - row)),
    width: Math.max(0, Math.min((transpose ? height : width) * tiles.cols, totalCols - col)),
  };
}

/**
 * How many times the copied block is pasted over `targetSelection` (Excel's
 * TILING rule, @api/lib `pasteTiles` [LIVE: Paste Values of a 1-cell copy into
 * H1:H3 writes all three]): repeated when the selection is an exact multiple
 * of the (transposed) block and holds no merged cell, else once. A cut and an
 * object's cells are pasted once; a merge read that fails pastes once.
 */
async function pasteTilesFor(
  clipboard: ClipboardData,
  targetSelection: Selection,
  transpose: boolean,
  target: CellTargetRef | undefined,
): Promise<PasteTiles> {
  if (clipboard.isCut || target) return PASTE_ONCE;
  const { height, width } = matrixSize(clipboard.cells ?? []);
  const blockHeight = transpose ? width : height;
  const blockWidth = transpose ? height : width;
  if (!pasteMayTile(blockHeight, blockWidth, targetSelection)) return PASTE_ONCE;
  let merged = true;
  try {
    const regions = await getMergedRegions({
      startRow: targetSelection.startRow,
      startCol: targetSelection.startCol,
      endRow: targetSelection.endRow,
      endCol: targetSelection.endCol,
    });
    merged = !Array.isArray(regions) || regions.length > 0;
  } catch (err) {
    console.warn("[PasteSpecial] the merged cells under the paste could not be read; the copy is pasted once:", err);
  }
  return pasteTiles(blockHeight, blockWidth, targetSelection, merged);
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
  // write no cell, so no cell area is guarded for them. A selection that is a
  // multiple of the copy is TILED (`pasteTilesFor`), and the area guarded is
  // the whole tiled area.
  const tiles =
    options.pasteAttribute === "columnWidths"
      ? PASTE_ONCE
      : await pasteTilesFor(clipboard, targetSelection, options.transpose, target);
  const area =
    options.pasteAttribute === "columnWidths"
      ? null
      : pasteAreaOf(clipboard, targetSelection, options.transpose, totalRows, totalCols, tiles);
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
  else return pasteCells(clipboard, targetSelection, options, totalRows, totalCols, tiles);
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
  // The cells tile as plain Paste's do; the widths are the source columns'.
  const tiles = await pasteTilesFor(clipboard, targetSelection, false, undefined);
  const area = pasteAreaOf(clipboard, targetSelection, false, totalRows, totalCols, tiles);
  if (!(await mayPaste(clipboard, area, label))) return false;

  const tx = ownUndoTransaction(
    await beginUndoTransaction(`${label} ${area.height * area.width} cells`),
    UNDO_CLOSES,
  );
  try {
    if (!(await pasteCells(clipboard, targetSelection, options, totalRows, totalCols, tiles))) {
      // Refused before any cell was written (a protected sheet): the widths
      // do not land without the cells, and the step is dropped.
      await tx.cancel();
      return false;
    }
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
  const [map] = await shiftedFormulasForTiles(clipboard, pasteAttribute, transpose, [{ row: targetRow, col: targetCol }]);
  return map;
}

/**
 * `shiftedFormulasFor` for EVERY tile of a tiled paste at once: one map per
 * anchor (each tile's top-left), all shifted by ONE `shiftFormulasBatch` call
 * (round 15, rev13B) -- one call per tile was one IPC per pasted cell for a
 * one-cell copy over a column.
 */
async function shiftedFormulasForTiles(
  clipboard: ClipboardData,
  pasteAttribute: PasteAttribute,
  transpose: boolean,
  anchors: ReadonlyArray<{ row: number; col: number }>,
): Promise<Map<string, string>[]> {
  const maps = anchors.map(() => new Map<string, string>());
  const cellsToPaste = clipboard.cells;
  const { height: sourceHeight, width: sourceWidth } = matrixSize(cellsToPaste);
  if (clipboard.isCut || !FORMULA_ATTRIBUTES.has(pasteAttribute)) return maps;

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
  if (formulaEntries.length === 0) return maps;

  const inputs: FormulaShiftInput[] = [];
  for (const { row: targetRow, col: targetCol } of anchors) {
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
    for (const e of formulaEntries) {
      if (transpose) {
        // When transposed, source [r][c] maps to target [c][r]
        const destRow = targetRow + e.c;
        const destCol = targetCol + e.r;
        inputs.push({
          formula: e.formula,
          rowDelta:
            destRow - clipboardSourceRow(clipboard.sourceRows, sourceMinRow, e.r),
          colDelta: destCol - (sourceMinCol + e.c),
        });
      } else {
        inputs.push({
          formula: e.formula,
          rowDelta: rowDeltas[e.r],
          colDelta: targetCol - sourceMinCol,
        });
      }
    }
  }
  const shiftedFormulas = await shiftFormulasBatch(inputs);
  let i = 0;
  for (const map of maps) {
    for (const { r, c } of formulaEntries) {
      map.set(`${r},${c}`, shiftedFormulas[i]);
      i += 1;
    }
  }
  return maps;
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
  tiles: PasteTiles = PASTE_ONCE,
): Promise<boolean> {
  const { pasteAttribute, operation, skipBlanks, transpose } = options;
  const cellsToPaste = clipboard.cells;

  const targetRow = Math.min(targetSelection.startRow, targetSelection.endRow);
  const targetCol = Math.min(targetSelection.startCol, targetSelection.endCol);

  const { height: sourceHeight, width: sourceWidth } = matrixSize(cellsToPaste);

  // When transposing, swap dimensions
  const pasteHeight = transpose ? sourceWidth : sourceHeight;
  const pasteWidth = transpose ? sourceHeight : sourceWidth;

  // Clamp to grid bounds -- the whole area, the block times its tiles.
  const actualPasteHeight = Math.min(pasteHeight * tiles.rows, totalRows - targetRow);
  const actualPasteWidth = Math.min(pasteWidth * tiles.cols, totalCols - targetCol);

  // Handle Column Widths specially - no cell data involved
  if (pasteAttribute === "columnWidths") {
    await pasteColumnWidths(clipboard, targetCol, sourceWidth, totalCols);
    return true;
  }

  // Shift formulas for copy operations (not cut): each TILE's formulas are
  // shifted to where that tile lands (B1 =A1*2 into D1:D3 -> =C1*2, =C2*2,
  // =C3*2 [LIVE]), one map per tile, keyed by source position -- every tile's
  // in ONE shift call.
  const anchors: { row: number; col: number }[] = [];
  for (let tr = 0; tr < tiles.rows; tr++) {
    for (let tc = 0; tc < tiles.cols; tc++) {
      anchors.push({ row: targetRow + tr * pasteHeight, col: targetCol + tc * pasteWidth });
    }
  }
  const tileFormulaMaps = await shiftedFormulasForTiles(clipboard, pasteAttribute, transpose, anchors);
  const shiftedFormulaMap = tileFormulaMaps[0];

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

  // The cells this paste writes, each with its source -- decided ONCE, so the
  // protection questions below ask about exactly the cells the loop writes.
  const plan: PlannedCell[] = [];
  for (let ar = 0; ar < actualPasteHeight; ar++) {
    for (let ac = 0; ac < actualPasteWidth; ac++) {
      const destRow = targetRow + ar;
      const destCol = targetCol + ac;
      // The cell's place in its tile, and which tile (a paste that is not
      // tiled has one: tile 0, and pr / pc are the area's own).
      const pr = ar % pasteHeight;
      const pc = ac % pasteWidth;
      const tileFormulas = tileFormulaMaps[Math.floor(ar / pasteHeight) * tiles.cols + Math.floor(ac / pasteWidth)];

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

      plan.push({ destRow, destCol, srcR, srcC, sourceCell, tileFormulas });
    }
  }

  // NEVER HALF DONE on a protected sheet (rev12A): the questions a cell's
  // write would ask one cell at a time, asked of every written cell BEFORE
  // the first write and before any undo step (`protectedPasteGate`).
  const gate = await protectedPasteGate(plan, pasteAttribute, `Paste Special (${pasteAttribute})`);
  if (gate.refusal !== null) {
    void alertAsync(gate.refusal);
    return false;
  }
  // A formatting-only paste the sheet's Format Cells option refuses over
  // unlocked cells: nothing to paste, and -- as in Excel -- nothing said and
  // no undo step.
  if (gate.nothingToPaste) return true;

  // What each content write pastes FROM (BUG-0657, `pasteSourcePlan`).
  const sources = await pasteSourcePlan(clipboard, options);

  // The grid route: no object target (`ctx.target` is the paste's place).
  const ctx: PasteContext = {
    clipboard,
    shiftedFormulaMap,
    styles: new Map(),
    target: undefined,
    operands,
    contentLanded: false,
    formattingDropped: gate.formattingRefused !== null,
    // EVERY paste collects its writes and sends them together (`TileBatch`),
    // tiled or not (BUG-0345: an untiled Paste Values over 1,000 cells was
    // 1,000+ calls, one per cell).
    batch: newTileBatch(),
  };

  // Begin undo transaction
  const cellCount = actualPasteHeight * actualPasteWidth;
  const tx = ownUndoTransaction(
    await beginUndoTransaction(`Paste Special (${pasteAttribute}) ${cellCount} cells`),
    UNDO_CLOSES,
  );

  // A cell whose write was refused is SKIPPED (comments and validation, still
  // one call per cell); a cell whose content landed and whose formatting then
  // failed is not -- its value changed -- and is reported as such. The content
  // itself goes out in ONE batch, refused whole (Excel refuses a paste whole;
  // the gate above has already asked every written cell). (After the gate,
  // a formatting failure happens only when the sheet's protection changed
  // between the gate and the write.)
  let failedCells = 0;
  let firstFailure: string | null = null;
  let unformattedCells = 0;
  let firstUnformatted: string | null = null;
  try {
    for (const { destRow, destCol, srcR, srcC, sourceCell, tileFormulas } of plan) {
      ctx.shiftedFormulaMap = tileFormulas;
      if (ctx.operands?.sourceFormulas) ctx.operands.sourceFormulas = tileFormulas;
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
      // ...named on the cell's content write, whose `value` is then only the
      // fallback for what the backend cannot vouch for (a collection value).
      const content = sources ? ctx.batch.byCell.get(`${destRow},${destCol}`) : undefined;
      if (sources && content) content.source = pasteSourceAt(sources, clipboard, srcR, srcC);
      if (failure !== null && ctx.contentLanded) {
        unformattedCells++;
        firstUnformatted = firstUnformatted ?? failure;
      } else if (failure !== null) {
        failedCells++;
        firstFailure = firstFailure ?? failure;
      }
    }

    // The paste's collected writes, sent together (`flushTileBatch`) -- naming
    // their sources only while the copy still stands where it was copied.
    keepSourcesOnlyWhereTheyStand(clipboard, ctx.batch.updates);
    const flushed = await flushTileBatch(ctx.batch);
    failedCells += flushed.failedCells;
    firstFailure = firstFailure ?? flushed.firstFailure;
    unformattedCells += flushed.unformattedCells;
    firstUnformatted = firstUnformatted ?? flushed.firstUnformatted;

    // Commit whatever applied (an all-refused paste commits an empty
    // transaction, which is a no-op) so a partial paste stays undoable.
    await tx.commit();

    // Refresh grid
    window.dispatchEvent(new CustomEvent("styles:refresh"));
    window.dispatchEvent(new CustomEvent("grid:refresh"));
    // Excel selects the pasted range (BUG-0349, `selectPastedSheetArea`).
    selectPastedSheetArea({ row: targetRow, col: targetCol, height: actualPasteHeight, width: actualPasteWidth });
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
  // Format Cells not allowed (`gate.formattingRefused`): the content landed
  // WITHOUT its formatting, and -- as in Excel [LIVE] -- nothing is said. A
  // format refused AFTER the gate (protection changed meanwhile) is told.
  if (gate.formattingRefused === null && unformattedCells > 0) {
    sentences.push(pasteRefusalSentence.formattingNotApplied(unformattedCells, firstUnformatted ?? "unknown error"));
  }
  if (sentences.length > 0) void alertAsync(sentences.join("\n\n"));
  return true;
}

/** One cell a sheet-route paste writes, and the source cell it takes. */
interface PlannedCell {
  destRow: number;
  destCol: number;
  srcR: number;
  srcC: number;
  sourceCell: CellData | null;
  /** The shifted formulas of the tile this cell lies in. */
  tileFormulas: Map<string, string>;
}

/** The attributes whose paste writes a cell's CONTENT (a value or a formula). */
const CONTENT_ATTRIBUTES: ReadonlySet<PasteAttribute> = new Set<PasteAttribute>([
  "all",
  "formulas",
  "values",
  "allExceptBorders",
  "formulasAndNumberFormats",
  "valuesAndNumberFormats",
  "valuesAndSourceFormatting",
]);

/** The attributes whose paste writes FORMATTING (a style, a number format). */
const FORMATTING_ATTRIBUTES: ReadonlySet<PasteAttribute> = new Set<PasteAttribute>([
  "all",
  "formats",
  "allExceptBorders",
  "formulasAndNumberFormats",
  "valuesAndNumberFormats",
  "valuesAndSourceFormatting",
]);

/**
 * The protected-sheet questions of a SHEET-route paste, asked of exactly the
 * cells it writes (`plan`), before anything is written -- the writes used to
 * ask them one cell at a time, so a paste over A1:A3 wrote A1 and A2 and
 * skipped A3 (rev12A); the content batch refuses whole, but its formatting
 * writes follow it. Excel answers them for the whole paste at once
 * [LIVE, Excel 16 COM, 2026-10-30, fmtprot/probe1-2.ps1; A1:A4 unlocked, A5
 * locked]:
 *   - CONTENT onto a LOCKED cell refuses the whole paste, whatever the
 *     options: Paste Special > Values and > All Except Borders onto A4:A5
 *     raise "The cell or chart you're trying to change is on a protected
 *     sheet" and A4 is unchanged. -> `refusal`.
 *   - FORMATTING asks the sheet's Format Cells option ONCE (`setCellStyle`'s
 *     `checkArea`, the backend's own gate; with the option on, a locked cell
 *     is formatted too and keeps its Locked flag). Refused, a formatting-only
 *     paste (Formats) changes nothing: SILENTLY when every destination is
 *     unlocked, and with the protected-sheet refusal when a locked cell is in
 *     the range -> `nothingToPaste` / `refusal` [LIVE, also cutfmt/probe1.ps1,
 *     2026-10-31: PasteSpecial(xlPasteFormats) onto an unlocked cell with
 *     Format Cells off raises nothing and changes nothing]; a paste that
 *     carries content pastes it WITHOUT the formatting, silently (Excel:
 *     ws.Paste and PasteSpecial(xlPasteAll) of a bold 0.00 cell onto an
 *     unlocked one land the value, not bold, General, no error) ->
 *     `formattingRefused`, which nothing reports to the user.
 * The lock flags are asked ONCE for every written cell (`canEditCells`, one
 * call) -- one call per cell doubled the calls of a large protected paste.
 * A protection state that cannot be read leaves each write to its own backend
 * gate (every cell write is gated there), so it never lets through what
 * protection forbids.
 */
/**
 * Whether the active sheet's protection is what refuses formatting: protected,
 * with Format Cells NOT allowed. False when it is allowed or the option cannot
 * be read -- then a failed format check was something else, and is shown.
 */
async function formatCellsOptionRefuses(): Promise<boolean> {
  try {
    const answer = await canPerformAction("formatCells");
    return answer.canEdit === false;
  } catch (err) {
    console.warn("[PasteSpecial] the sheet's Format Cells option could not be read:", err);
    return false;
  }
}

async function protectedPasteGate(
  plan: readonly PlannedCell[],
  pasteAttribute: PasteAttribute,
  label: string,
): Promise<{ refusal: string | null; formattingRefused: string | null; nothingToPaste: boolean }> {
  const allowed = { refusal: null, formattingRefused: null, nothingToPaste: false };
  if (plan.length === 0) return allowed;
  const writesContent = CONTENT_ATTRIBUTES.has(pasteAttribute);
  const writesFormatting = FORMATTING_ATTRIBUTES.has(pasteAttribute);
  if (!writesContent && !writesFormatting) return allowed;

  // A protection state that cannot be read falls back to the writes' own gates:
  // the backend still refuses every locked or unformattable cell itself
  // (each write is gated), so nothing is ever written that protection forbids
  // -- only the all-or-nothing guarantee is lost, never the protection.
  let protectedSheet: boolean;
  try {
    protectedSheet = await isSheetProtected();
  } catch (err) {
    console.warn("[PasteSpecial] the sheet's protection could not be read; each cell's write is gated on its own:", err);
    return allowed;
  }
  if (!protectedSheet) return allowed;

  // The first LOCKED written cell's refusal, asked of every written cell in
  // ONE call; null when none is locked, or (`unreadable`) when the flags could
  // not be read.
  const unreadable = Symbol("unreadable");
  const lockedRefusal = async (): Promise<string | null | typeof unreadable> => {
    let answer: Awaited<ReturnType<typeof canEditCells>>;
    try {
      answer = await canEditCells(plan.map((c) => ({ row: c.destRow, col: c.destCol })));
    } catch (err) {
      console.warn("[PasteSpecial] the locked cells under the paste could not be read; each cell's write is gated on its own:", err);
      return unreadable;
    }
    if (answer.canEdit) return null;
    // The backend names the cell; the fallback cannot know which one it was.
    return answer.reason || pasteRefusalSentence.lockedCell(label, "a cell of the paste area");
  };

  if (writesContent) {
    const locked = await lockedRefusal();
    // Unreadable: as above, the content batch still refuses any locked cell (whole).
    if (typeof locked === "string") return { ...allowed, refusal: locked };
  }

  if (writesFormatting) {
    const area = boundsOfCells(plan.map((c) => ({ row: c.destRow, col: c.destCol })));
    if (area !== null) {
      try {
        // The sheet route writes the ACTIVE sheet: no object target.
        await setCellStyle(area.startRow, area.startCol, 0, { target: undefined, checkArea: area });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (writesContent) return { ...allowed, formattingRefused: reason };
        // Formatting only, and only when it was the OPTION that refused: Excel
        // refuses only when a LOCKED cell is in the range; over unlocked cells
        // (and locked cells inside an Allow Edit Range: [LIVE, Excel 16 COM,
        // 2026-10-31, ui18/probe-editrange-formats.ps1] PasteSpecial
        // xlPasteFormats onto a locked C1 inside a no-password edit range with
        // Format Cells off raises nothing and changes nothing, like an
        // unlocked cell; a locked C5 outside it raises the protected-sheet
        // error) it changes nothing and says nothing. Any OTHER failure of the
        // check (a canvas sheet, an IPC error) is shown, never passed off as a
        // silent success (round 18).
        if (!(await formatCellsOptionRefuses())) return { ...allowed, refusal: reason };
        const locked = await lockedRefusal();
        if (typeof locked === "string") return { ...allowed, refusal: locked };
        if (locked === unreadable) return { ...allowed, refusal: reason };
        return { ...allowed, nothingToPaste: true };
      }
    }
  }
  return allowed;
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
    if (await writeTargetBatch(updates, [], `Paste Link ${updates.length} cells`, target)) {
      selectPastedTarget(target, {
        startRow: targetRow,
        startCol: targetCol,
        endRow: targetRow + actualPasteHeight - 1,
        endCol: targetCol + actualPasteWidth - 1,
      });
    }
    return true;
  }

  // Every link in ONE batch (BUG-0345: it was one call per cell), refused
  // whole as Excel refuses a paste whole; a link is a formula, pasted: it
  // stays one in a Text-formatted cell (pastedUpdate).
  const updates: CellUpdateInput[] = [];
  for (let r = 0; r < actualPasteHeight; r++) {
    for (let c = 0; c < actualPasteWidth; c++) {
      const destRow = targetRow + r;
      const destCol = targetCol + c;
      if (destRow >= totalRows || destCol >= totalCols) continue;
      // The cell this matrix entry was copied from.
      const srcRow = clipboardSourceRow(clipboard.sourceRows, sourceMinRow, r);
      const srcCol = sourceMinCol + c;
      updates.push(pastedUpdate(destRow, destCol, buildLinkFormula(sheetPrefix, srcRow, srcCol, absolute), false));
    }
  }

  const tx = ownUndoTransaction(
    await beginUndoTransaction(`Paste Link ${actualPasteHeight * actualPasteWidth} cells`),
    UNDO_CLOSES,
  );
  try {
    // The sheet branch: no object target (that one returned above), passed on
    // all the same so this write can never land elsewhere.
    emitUpdated(await updateCellsBatch(updates, { target }));
    await tx.commit();

    window.dispatchEvent(new CustomEvent("styles:refresh"));
    window.dispatchEvent(new CustomEvent("grid:refresh"));
    // Excel selects the pasted range (BUG-0349).
    selectPastedSheetArea(area);
  } catch (error) {
    try { await tx.cancel(); } catch { /* already closed */ }
    void alertAsync(error instanceof Error ? error.message : String(error));
    throw error;
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
   * The paste's place: undefined on this sheet route, which writes the
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
  /**
   * The protected sheet does not allow Format Cells (`protectedPasteGate`):
   * the paste writes its CONTENT only, every style and number-format write
   * left out -- Excel pastes the value alone [LIVE].
   */
  formattingDropped: boolean;
  /** The paste's writes, collected instead of sent cell by cell. See `TileBatch`. */
  batch: TileBatch;
}

/**
 * A sheet-route paste's writes, collected and then sent together -- tiled
 * (round 15, rev13B) or not (BUG-0345, 2026-11-04): every cell's content --
 * with the source's style index riding the same update where the style
 * travels -- in ONE `updateCellsBatch`, the number formats in as few
 * rows x columns `applyFormatting` calls as they allow (`numberFormatGroups`),
 * and every style-only write -- Paste Formatting, a style an operation's
 * skipped cell still takes, No Borders' source style with the destination's
 * own borders kept (`keepBorders`, the backend's: every side as the cell holds
 * it, theme colour and weight included, BUG-0347) -- in ONE `setCellStyles`.
 * Before, every cell was its own awaited IPC, each with its own recalculation
 * (Paste Values over 1,000 cells was 1,000+ calls; No Borders added a read and
 * a lossy border restore per cell). Plain Paste already wrote one batch. The
 * writes are made in the per-cell order.
 */
interface TileBatch {
  updates: CellUpdateInput[];
  /** The content update per destination cell ("row,col"), so a style can ride it. */
  byCell: Map<string, CellUpdateInput>;
  /**
   * Style-only writes; `announce` is Paste Formatting's cell event once the
   * style landed; `keepBorders` keeps the cell's own border sides (No Borders).
   */
  styleWrites: Array<{ row: number; col: number; styleIndex: number; announce: boolean; keepBorders?: boolean }>;
  /** A number format per destination cell, grouped when sent (`numberFormatGroups`). */
  numberFormats: Array<{ row: number; col: number; numberFormat: string }>;
}

function newTileBatch(): TileBatch {
  return { updates: [], byCell: new Map(), styleWrites: [], numberFormats: [] };
}

/**
 * Send a paste's collected writes (`TileBatch`): content (with the styles
 * riding it), the style-only writes (ONE call, all or nothing), the number
 * formats (grouped). A content batch the backend refuses THROWS (nothing of it
 * landed; the caller closes the step and says why); a formatting write that
 * fails afterwards is counted -- on a cell whose content landed as "not
 * formatted", on a cell that only took formatting as skipped.
 */
async function flushTileBatch(batch: TileBatch): Promise<{
  failedCells: number;
  firstFailure: string | null;
  unformattedCells: number;
  firstUnformatted: string | null;
}> {
  const out = { failedCells: 0, firstFailure: null as string | null, unformattedCells: 0, firstUnformatted: null as string | null };
  const failed = (row: number, col: number, err: unknown): void => {
    const why = err instanceof Error ? err.message : String(err);
    console.error(`[PasteSpecial] Failed to paste cell (${row}, ${col}):`, err);
    if (batch.byCell.has(`${row},${col}`)) {
      out.unformattedCells += 1;
      out.firstUnformatted = out.firstUnformatted ?? why;
    } else {
      out.failedCells += 1;
      out.firstFailure = out.firstFailure ?? why;
    }
  };
  if (batch.updates.length > 0) {
    emitUpdated(await updateCellsBatch(batch.updates, { target: undefined }));
  }
  if (batch.styleWrites.length > 0) {
    try {
      await setCellStyles(
        batch.styleWrites.map((sw) => ({
          row: sw.row,
          col: sw.col,
          styleIndex: sw.styleIndex,
          ...(sw.keepBorders ? { keepBorders: true } : {}),
        })),
        { target: undefined },
      );
      for (const sw of batch.styleWrites) {
        if (sw.announce) cellEvents.emit({ row: sw.row, col: sw.col, oldValue: undefined, newValue: "", formula: null });
      }
    } catch (err) {
      // All or nothing: no cell of the set took its style.
      for (const sw of batch.styleWrites) failed(sw.row, sw.col, err);
    }
  }
  for (const { rows, cols, numberFormat } of numberFormatGroups(batch.numberFormats)) {
    try {
      await applyFormatting(rows, cols, { numberFormat }, { target: undefined });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      console.error("[PasteSpecial] A number format could not be pasted:", err);
      out.unformattedCells += rows.length * cols.length;
      out.firstUnformatted = out.firstUnformatted ?? why;
    }
  }
  return out;
}

/** The style table entry `index`, read once per paste. */
function styleOf(ctx: PasteContext, index: number): Promise<StyleData> {
  return cachedStyle(ctx.styles, index);
}

/**
 * Collect one cell's CONTENT (`TileBatch`) and record that it landed, so a
 * later failure of the same cell is told apart from a refused write. Returns
 * no cells: the batch announces what it wrote when it is sent.
 */
async function writeContent(update: CellUpdateInput, ctx: PasteContext): Promise<CellData[]> {
  ctx.batch.updates.push(update);
  ctx.batch.byCell.set(`${update.row},${update.col}`, update);
  ctx.contentLanded = true;
  return [];
}

/** The display-text fallback (a copy without stored values; a collection's JSON): an ENTRY, as before. */
async function writeEntry(row: number, col: number, value: string, ctx: PasteContext): Promise<CellData[]> {
  // A batch update without `pasted` / `invariant`: an entry, read as typed.
  return writeContent({ row, col, value }, ctx);
}

/**
 * Point one destination cell at the source's style INDEX: on the cell's own
 * content update when it has one (the style rides the same write, as plain
 * Paste sends it), else as a style-only write.
 */
async function writeStyle(row: number, col: number, styleIndex: number, ctx: PasteContext, announce = false): Promise<void> {
  const update = ctx.batch.byCell.get(`${row},${col}`);
  if (update && !announce) update.styleIndex = styleIndex;
  else ctx.batch.styleWrites.push({ row, col, styleIndex, announce });
}

/**
 * Give one destination cell a source cell's number format, collected and
 * grouped when sent (`numberFormatGroups`).
 */
async function writeNumberFormat(row: number, col: number, numberFormat: string, ctx: PasteContext): Promise<void> {
  ctx.batch.numberFormats.push({ row, col, numberFormat });
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
        await pasteFormats(sourceCell, destRow, destCol, ctx);
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
  if (ctx.formattingDropped) return;
  await writeStyle(destRow, destCol, sourceStyleIndex(sourceCell), ctx);
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
  if (ctx.formattingDropped) return;
  await writeStyle(destRow, destCol, sourceStyleIndex(sourceCell), ctx);
}

/**
 * Paste Formats: style only, no value change. (On a floating grid's cells
 * the object route writes the same style index through the target:
 * `pasteCellsOnTarget`.)
 */
async function pasteFormats(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number,
  ctx: PasteContext,
): Promise<void> {
  await writeStyle(destRow, destCol, sourceStyleIndex(sourceCell), ctx, true);
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

/**
 * Paste All Except Borders (Excel's "No Borders"): the value/formula and
 * EVERY style field of the source except its borders; the destination keeps
 * its OWN borders.
 *
 * Excel, measured live through COM (2026-10-04, xlPasteAllExceptBorders onto a
 * cell that had a thick top border and italic): bold and indent 2 arrived from
 * the source, the destination's italic went, the source's bottom border did
 * NOT arrive, and the destination's thick top border STAYED -- in full detail:
 * a THEME-coloured medium dashed bottom border stays theme colour 5, medium,
 * dashed [LIVE, Excel 16 COM, 2026-11-04, paste-x/probe1.ps1].
 *
 * DERIVED, not hand-listed: the destination is pointed at the SOURCE's style
 * index (the whole style, whatever it holds) by a style-only write that keeps
 * the cell's own border sides (`keepBorders`), decided by the backend from the
 * cell's own style. It used to read each destination and put each differing
 * side back through applyFormatting, whose wire takes a side as {style,
 * color} -- a theme-coloured border came back as a fixed colour and a
 * medium dashed side as a thin one (BUG-0347).
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
  if (operation !== "none") {
    await pasteWithOperation(sourceCell, destRow, destCol, srcR, srcC, operation, ctx);
  } else {
    await writeFormulaOrDisplay(sourceCell, destRow, destCol, srcR, srcC, ctx);
  }
  // Format Cells not allowed: the content alone (no style).
  if (ctx.formattingDropped) return;
  ctx.batch.styleWrites.push({
    row: destRow,
    col: destCol,
    styleIndex: sourceStyleIndex(sourceCell),
    announce: false,
    keepBorders: true,
  });
}

/**
 * The number format a Values / Formulas and Number Formats paste writes onto
 * one destination cell: the source cell's -- and an EMPTY source position's
 * too, the default style's (`sourceStyleIndex`). Excel [LIVE, Excel 16 COM,
 * 2026-11-04, paste-x/probe1.ps1]: G1 = 5, G2 empty (General); G1:G2 pasted
 * with Values and Number Formats (and Formulas and Number Formats) onto I1:I2
 * leaves I2 EMPTY in General -- its 0% gone, its bold kept -- and an empty G2
 * formatted 0.000 brings 0.000. This used to skip an empty source position and
 * leave the destination's number format standing (BUG-0349's second half).
 */
async function pasteSourceNumberFormat(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number,
  ctx: PasteContext,
): Promise<void> {
  if (ctx.formattingDropped) return;
  const sourceStyle = await styleOf(ctx, sourceStyleIndex(sourceCell));
  await writeNumberFormat(destRow, destCol, sourceStyle.numberFormat, ctx);
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
  await pasteSourceNumberFormat(sourceCell, destRow, destCol, ctx);
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
  await pasteSourceNumberFormat(sourceCell, destRow, destCol, ctx);
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
 * as a value (with or without the source's whole style) plus a number format,
 * and -- through `setCellStyle`'s target (BUG-0513) -- the style-only paste
 * (Formatting) and All Except Borders, exactly as on a sheet. Comments and
 * validation have no door there, and column widths are the object's own.
 */
const TARGET_PASTE_ATTRIBUTES: ReadonlySet<PasteAttribute> = new Set<PasteAttribute>([
  "all",
  "formulas",
  "values",
  "formats",
  "allExceptBorders",
  "valuesAndSourceFormatting",
  "formulasAndNumberFormats",
  "valuesAndNumberFormats",
]);

/**
 * Whether the target HOST's protection is what refuses formatting: protected,
 * with Format Cells NOT allowed (`canPerformAction` with the target, BUG-0655).
 * False when it is allowed or the option cannot be read -- then a failed format
 * check was something else, and is shown.
 */
async function targetFormatCellsOptionRefuses(target: CellTargetRef): Promise<boolean> {
  try {
    const answer = await canPerformAction("formatCells", { target });
    return answer.canEdit === false;
  } catch (err) {
    console.warn("[PasteSpecial] the floating grid host's Format Cells option could not be read:", err);
    return false;
  }
}

/**
 * Write `updates` (values, with a style index where the source's style
 * travels) to the object's cells in ONE batch, then every style-only write
 * (`styleWrites`: Paste Formatting, a style an operation's skipped cell still
 * takes, and Paste (No Borders)'s source style with each cell's OWN border
 * sides kept, `keepBorders`) in ONE `setCellStyles`, then the number formats
 * grouped into as few rows x columns writes as they allow (`numberFormatGroups`)
 * -- a bounded number of calls whatever the area (BUG-0345) -- all inside ONE
 * undo step (the batch's own owned step joins it). The kept borders are the
 * backend's: every side as the cell holds it, theme colour and weight included
 * (BUG-0347; they used to be put back through applyFormatting as a fixed colour
 * and width 1). A refusal is shown and the step closed; nothing half-applied is
 * left open. A pasted formula or stored value carries `pasted` (`pastedUpdate`),
 * so it keeps its kind in a Text-formatted cell in this same batch.
 *
 * NEVER HALF DONE (rev10A). BEFORE ANY WRITE every cell that takes formatting
 * -- a style write, a number format, and a content update carrying the
 * source's style -- is CHECKED once (`setCellStyle`'s `checkArea`: the host's
 * Format Cells option -- with it allowed, a LOCKED cell is formatted too and
 * keeps its Locked flag, as in Excel); the content batch gates its own cells
 * whole. With the option refused:
 *   - nothing but formatting to paste (Paste Formatting): the sheet's rule
 *     (BUG-0655) -- SILENT, nothing changed and no undo step, when every
 *     destination is unlocked; the protected-sheet refusal, before any cell
 *     changes, when a LOCKED one is in the range [LIVE, Excel 16 COM,
 *     fmtprot/probe1.ps1 and cutfmt/probe1.ps1: PasteSpecial(xlPasteFormats)
 *     onto unlocked cells with Format Cells off raises nothing and changes
 *     nothing; with A3 locked it raises and A1:A2 are unchanged]. The lock
 *     flags are the GRID's own cells' under the host's protection
 *     (`canEditCells` with the target). Only the OPTION refusing is silent: a
 *     check that failed for another reason, or an option or lock state that
 *     cannot be read, is shown;
 *   - content too: the content is pasted WITHOUT the formatting, and nothing
 *     is said (as the sheet route) -- Excel, Format Cells not allowed, pastes
 *     All / No Borders / Values and Number Formats onto unlocked cells as the
 *     value alone, the format dropped, with no error [LIVE, Excel 16 COM;
 *     cutfmt/probe1.ps1]. A locked cell still refuses the whole content
 *     batch, before anything is written.
 */
async function writeTargetBatch(
  updates: CellUpdateInput[],
  numberFormats: Array<{ row: number; col: number; numberFormat: string }>,
  description: string,
  target: CellTargetRef,
  styleWrites: readonly CellStyleWrite[] = [],
): Promise<boolean> {
  const styledUpdates = updates.filter((u) => u.styleIndex !== undefined);
  const checkArea = boundsOfCells([...styleWrites, ...numberFormats, ...styledUpdates]);
  let formattingRefused: string | null = null;
  if (checkArea !== null) {
    try {
      await setCellStyle(checkArea.startRow, checkArea.startCol, 0, { target, checkArea });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (updates.length === 0) {
        // Formatting only: silent exactly when the host's OPTION refuses and
        // every destination is unlocked (BUG-0655, the sheet's rule).
        if (!(await targetFormatCellsOptionRefuses(target))) {
          void alertAsync(reason);
          throw error;
        }
        let locked: Awaited<ReturnType<typeof canEditCells>>;
        try {
          locked = await canEditCells([...styleWrites, ...numberFormats], { target });
        } catch (err) {
          console.warn("[PasteSpecial] the floating grid's locked cells could not be read:", err);
          void alertAsync(reason);
          throw error;
        }
        if (!locked.canEdit) {
          const refusal = locked.reason || reason;
          void alertAsync(refusal);
          throw new Error(refusal);
        }
        // Nothing to paste, nothing said, no undo step (Excel).
        return false;
      }
      formattingRefused = reason;
    }
  }
  if (formattingRefused !== null) {
    // The content alone: no style index rides the batch, no formatting write follows.
    updates = updates.map(({ styleIndex: _dropped, ...content }) => content);
    numberFormats = [];
    styleWrites = [];
  }
  const tx = ownUndoTransaction(await beginUndoTransaction(description), UNDO_CLOSES);
  let landed = false;
  try {
    if (updates.length > 0) {
      await updateCellsBatch(updates, { target });
      landed = true;
    }
    if (styleWrites.length > 0) {
      await setCellStyles([...styleWrites], { target });
      landed = true;
    }
    for (const group of numberFormatGroups(numberFormats)) {
      await applyFormatting(group.rows, group.cols, { numberFormat: group.numberFormat }, { target });
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
  // With the format refused (`formattingRefused`) the content landed alone,
  // and -- as in Excel, and as the sheet route does -- nothing is said.
  return true;
}

/**
 * The number formats a paste writes, grouped into as few `applyFormatting`
 * calls as they allow (BUG-0345): the cells of one format in one column
 * first, then the columns of one format whose ROW sets are equal merged --
 * so every group is an exact rows x columns product of cells that take that
 * format, and nothing else. A column of 1,000 cells in one format is ONE call
 * (it was one per cell); a block whose columns share a format is one call.
 */
function numberFormatGroups(
  cells: ReadonlyArray<{ row: number; col: number; numberFormat: string }>,
): Array<{ rows: number[]; cols: number[]; numberFormat: string }> {
  const byColumn = new Map<string, { numberFormat: string; col: number; rows: number[] }>();
  for (const { row, col, numberFormat } of cells) {
    const key = `${col}|${numberFormat}`;
    let entry = byColumn.get(key);
    if (!entry) {
      entry = { numberFormat, col, rows: [] };
      byColumn.set(key, entry);
    }
    entry.rows.push(row);
  }
  const byRows = new Map<string, { rows: number[]; cols: number[]; numberFormat: string }>();
  for (const { numberFormat, col, rows } of byColumn.values()) {
    const sorted = [...new Set(rows)].sort((a, b) => a - b);
    // The rows come LAST and hold no "|", so a format containing one cannot collide.
    const key = `${numberFormat}|${sorted.join(",")}`;
    let group = byRows.get(key);
    if (!group) {
      group = { rows: sorted, cols: [], numberFormat };
      byRows.set(key, group);
    }
    group.cols.push(col);
  }
  const groups = [...byRows.values()];
  for (const g of groups) g.cols.sort((a, b) => a - b);
  return groups;
}

/**
 * Excel selects the PASTED range after every Paste Special variant (BUG-0349)
 * [LIVE, Excel 16 COM, 2026-11-04, paste-x/probe1.ps1: a 3x2 copy pasted on D1
 * as Values, Formulas, Formats, All Except Borders, Values and Number Formats,
 * Formulas and Number Formats, All and Paste Link leaves D1:E3 selected, D1
 * active; Transpose D1:F2; into D1:E4 (no multiple) D1:E3; into D1:E6 (tiled)
 * D1:E6], as plain Paste does here. The active sheet's selection, Core's.
 */
function selectPastedSheetArea(area: { row: number; col: number; height: number; width: number }): void {
  if (area.height <= 0 || area.width <= 0) return;
  selectTargetCells({ kind: "grid", selection: null }, {
    startRow: area.row,
    startCol: area.col,
    endRow: area.row + area.height - 1,
    endCol: area.col + area.width - 1,
    type: "cells",
  });
}

/**
 * `selectPastedSheetArea` on a floating grid: the OBJECT's own selection,
 * through the owner that holds it now -- only when that owner still answers
 * the same object (a paste whose grid lost the selection meanwhile selects
 * nothing rather than another object's cells).
 */
function selectPastedTarget(target: CellTargetRef, rect: { startRow: number; startCol: number; endRow: number; endCol: number }): void {
  const now = cellTargetFor("content");
  if ("refusal" in now || now.kind !== "object" || now.ref.kind !== target.kind || now.ref.id !== target.id) return;
  selectTargetCells(now, { ...rect, type: "cells" });
}

/** The bounding rectangle of `cells`, or null when there are none. */
function boundsOfCells(
  cells: ReadonlyArray<{ row: number; col: number }>,
): { startRow: number; startCol: number; endRow: number; endCol: number } | null {
  if (cells.length === 0) return null;
  let startRow = Infinity;
  let startCol = Infinity;
  let endRow = -Infinity;
  let endCol = -Infinity;
  for (const { row, col } of cells) {
    startRow = Math.min(startRow, row);
    startCol = Math.min(startCol, col);
    endRow = Math.max(endRow, row);
    endCol = Math.max(endCol, col);
  }
  return { startRow, startCol, endRow, endCol };
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

  // Paste Formatting: the source's style INDEX per cell, no content
  // (`setCellStyle` with the target, as `pasteFormats` on a sheet).
  const stylesOnly = pasteAttribute === "formats";
  // Paste (No Borders): the content, then the source's style as a style-only
  // write that keeps each cell's OWN border sides (`keepBorders`, decided by
  // the backend from the cell's own style -- BUG-0347), as on a sheet.
  const keepsDestBorders = pasteAttribute === "allExceptBorders";
  const carriesStyle =
    pasteAttribute === "all" || pasteAttribute === "valuesAndSourceFormatting" || keepsDestBorders;
  const carriesNumberFormat =
    pasteAttribute === "formulasAndNumberFormats" || pasteAttribute === "valuesAndNumberFormats";
  const writesFormula =
    pasteAttribute === "all" ||
    pasteAttribute === "formulas" ||
    pasteAttribute === "formulasAndNumberFormats" ||
    keepsDestBorders;
  const rect = {
    startRow: targetRow,
    startCol: targetCol,
    endRow: targetRow + actualPasteHeight - 1,
    endCol: targetCol + actualPasteWidth - 1,
  };

  // An operation reads what the destination holds now: the object's cells,
  // through its typed read (never the active sheet's cell at those
  // coordinates) -- the stored values, the formulas an operation keeps, and
  // the display the collection check reads.
  let operands: OperationOperands | null = null;
  if (operation !== "none" && !stylesOnly) {
    const [typed, source] = await Promise.all([
      getCellTargetCellsTyped(target, rect),
      readSourceOperands(clipboard, sourceHeight, sourceWidth),
    ]);
    operands = {
      source,
      dest: destOperandsOf(typed),
      sourceFormulas: FORMULA_ATTRIBUTES.has(pasteAttribute) ? shiftedFormulaMap : null,
      target,
    };
  }

  const styles = new Map<number, Promise<StyleData>>();
  // What each content write pastes FROM (BUG-0657), as on a sheet.
  const sources = stylesOnly ? null : await pasteSourcePlan(clipboard, options);

  const updates: CellUpdateInput[] = [];
  const numberFormats: Array<{ row: number; col: number; numberFormat: string }> = [];
  const styleWrites: CellStyleWrite[] = [];
  for (let pr = 0; pr < actualPasteHeight; pr++) {
    for (let pc = 0; pc < actualPasteWidth; pc++) {
      const destRow = targetRow + pr;
      const destCol = targetCol + pc;
      const srcR = transpose ? pc : pr;
      const srcC = transpose ? pr : pc;
      if (srcR >= sourceHeight || srcC >= sourceWidth) continue;
      const sourceCell = cellsToPaste[srcR]?.[srcC] ?? null;
      if (skipBlanks && isCellBlank(sourceCell)) continue;

      if (stylesOnly) {
        styleWrites.push({ row: destRow, col: destCol, styleIndex: sourceStyleIndex(sourceCell) });
        continue;
      }

      // Every write but the display-text fallback is a PASTE (`pastedUpdate`):
      // a formula or a stored value keeps its kind in a Text-formatted cell.
      let update: CellUpdateInput | null = null;
      if (operation !== "none") {
        // The same rules as on a sheet (`Operand`): a formula stays a formula,
        // an inert side or blank on blank writes nothing, collections are skipped.
        const write = operationWriteFor(sourceCell, destRow, destCol, srcR, srcC, operation, operands);
        if (write) update = pastedUpdate(destRow, destCol, write.value, write.invariant);
        if (write === null && carriesStyle) {
          // The operation leaves the cell alone; the source's style still
          // arrives, as on a sheet (`pasteAll`): Excel, measured live through
          // COM 2026-10-29, "abc" + Add of a bold 0.00% 1 stays "abc", bold,
          // 0.00%. A style-only write (BUG-0513), so the content -- a formula,
          // rich text, a collection -- is never re-entered.
          styleWrites.push({
            row: destRow,
            col: destCol,
            styleIndex: sourceStyleIndex(sourceCell),
            ...(keepsDestBorders ? { keepBorders: true } : {}),
          });
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
        if (sources) update.source = pasteSourceAt(sources, clipboard, srcR, srcC);
      }

      if (update !== null) {
        if (keepsDestBorders) {
          // The source's whole style but the cell's OWN borders: a style-only
          // write after the content, kept by the backend (`keepBorders`).
          styleWrites.push({ row: destRow, col: destCol, styleIndex: sourceStyleIndex(sourceCell), keepBorders: true });
        } else if (carriesStyle) {
          update.styleIndex = sourceStyleIndex(sourceCell);
        }
        updates.push(update);
      }
      if (carriesNumberFormat) {
        // An EMPTY source position carries the default style's number format
        // too (`sourceStyleIndex`): Excel [LIVE, Excel 16 COM, 2026-11-04,
        // paste-x/probe1.ps1] Paste Special > Values and Number Formats of an
        // empty General cell onto a 0% cell leaves it empty in General.
        const sourceStyle = await cachedStyle(styles, sourceStyleIndex(sourceCell));
        numberFormats.push({ row: destRow, col: destCol, numberFormat: sourceStyle.numberFormat });
      }
    }
  }
  if (updates.length === 0 && numberFormats.length === 0 && styleWrites.length === 0) return;
  keepSourcesOnlyWhereTheyStand(clipboard, updates);
  const wrote = await writeTargetBatch(
    updates,
    numberFormats,
    `Paste Special (${pasteAttribute}) ${actualPasteHeight * actualPasteWidth} cells`,
    target,
    styleWrites,
  );
  // Excel selects the pasted range (BUG-0349): the grid's own selection.
  if (wrote) selectPastedTarget(target, rect);
}
