//! FILENAME: app/extensions/MacroRecorder/lib/actionCodegen.ts
// PURPOSE: Turn a list of RecordedActions into runnable Calcula script source.
// CONTEXT: A PURE function — no app state, no clock, no locale lookup (the
//          caller injects both). That is deliberate: the generator is the part
//          of the recorder that has to be exactly right, so it is the part that
//          must be exhaustively unit-testable.
//
// TARGETS ARE EXPLICIT, NEVER IMPLIED. The two script runtimes have genuinely
// different surfaces, and code written for one does not run on the other:
//
//   objectScript — the async UnlockedAPI (`context.api`) of an object script.
//                  Values, formatting, structure, sheets, merge, freeze,
//                  find/replace, fills, remove-duplicates, executeCommand,
//                  and BI-model edits via the consented `caps.biModel` gateway.
//   notebook     — the synchronous QuickJS `Calcula.*` ops of a notebook cell.
//                  Values, sheets, fillDown/fillRight. Nothing else — its
//                  model surface is read-only, so model edits never replay.
//
// Anything a target cannot express is emitted as a clearly-marked comment AND
// reported in `unsupported`, so the UI can say so out loud. Silently dropping an
// action would produce a macro that runs cleanly and does the wrong thing —
// the single worst outcome for a feature whose whole job is trust.

import type {
  MacroTarget,
  MacroWrapper,
  RecordedAction,
  RecordedEvent,
  RecordedGridEventOf,
  RecordedModelEditEvent,
} from "./types";
// The two rules the recorder shares with Developer > New Macro's starter: a
// macro's JavaScript identifier, and the sentence a module macro throws when
// it is run without cell access. ONE source (@api/scriptHost/macroStarter, a
// zero-import leaf, so this generator stays a pure function), so a recorded
// macro and a written one print byte-identical text. Re-exported because the
// recorder's tests pin them from here.
import { macroNeedsCellAccessMessage, toIdentifier } from "@api/scriptHost/macroStarter";

export { macroNeedsCellAccessMessage, toIdentifier };

// ============================================================================
// Options / result
// ============================================================================

export interface MacroCodegenOptions {
  /** Which runtime the emitted source must run in. Required — never guessed. */
  target: MacroTarget;
  /** How the body is packaged. Defaults: objectScript -> "objectScript",
   *  notebook -> "notebookCell". There is exactly one shape per target, so this
   *  is only ever passed to be explicit. */
  wrapper?: MacroWrapper;
  /** Macro name; drives the header and the generated function's identifier. */
  name?: string;
  /**
   * The decimal separator of the locale the recording was taken in.
   *
   * The batch write path can hand the backend values that are already in
   * INVARIANT (US) form. Replaying such a value through `setCellValue` sends it
   * back through locale parsing, so "1.5" in a comma-decimal locale would not
   * come back as 1.5. Invariant numerics are therefore re-spelled with this
   * separator. Default ".".
   */
  decimalSeparator?: string;
  /** Cells per emitted `updateCellsBatch` call. Default 500. */
  batchChunkSize?: number;
  /** Emit the header comment block. Default true. */
  header?: boolean;
  /** Wrap the body in one undo transaction (objectScript only). Default true. */
  undoBatch?: boolean;
  /** Activate the first action's sheet before doing anything. Default true. */
  emitInitialSheetActivate?: boolean;
  /** Timestamp for the header. Injected so the output is deterministic. */
  recordedAt?: string;
}

export interface MacroCodegenResult {
  /** The generated source. */
  source: string;
  /** One line per action the chosen target cannot express. Also present in the
   *  source as comments; surfaced separately so the UI can warn. */
  unsupported: string[];
}

interface ResolvedOptions {
  target: MacroTarget;
  wrapper: MacroWrapper;
  name: string;
  fnName: string;
  decimalSeparator: string;
  batchChunkSize: number;
  header: boolean;
  undoBatch: boolean;
  emitInitialSheetActivate: boolean;
  recordedAt: string;
}

// ============================================================================
// Literal helpers
// ============================================================================

/** Characters that must not appear raw inside a double-quoted JS literal. */
const ESCAPES: Record<string, string> = {
  "\\": "\\\\",
  '"': '\\"',
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
  "\u000b": "\\v",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

/**
 * A double-quoted JavaScript string literal for `value`.
 *
 * Handles the cases a naive quote-concat gets wrong and a macro recorder
 * really does hit: a quote or backslash the user typed, a multi-line cell,
 * and U+2028/U+2029 (legal inside a JS string but historically line
 * terminators). Remaining control characters go out as escapes, not raw.
 */
export function jsString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const mapped = ESCAPES[ch];
    if (mapped !== undefined) {
      out += mapped;
    } else if (ch < " " || ch === "\u007f") {
      out += "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
    } else {
      out += ch;
    }
  }
  return out + '"';
}

/** 0-based column index -> spreadsheet letters ("A", "Z", "AA"). */
export function colLetter(index: number): string {
  let i = index;
  let out = "";
  while (i >= 0) {
    out = String.fromCharCode(65 + (i % 26)) + out;
    i = Math.floor(i / 26) - 1;
  }
  return out;
}

/** 0-based row/col -> "A1". Used in comments only. */
function a1(row: number, col: number): string {
  return `${colLetter(col)}${row + 1}`;
}

/** 0-based rectangle -> "A1:C10" (or "A1" for a single cell). */
function a1Range(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): string {
  const from = a1(startRow, startCol);
  if (startRow === endRow && startCol === endCol) return from;
  return `${from}:${a1(endRow, endCol)}`;
}

/** A bare JavaScript identifier (`toIdentifier` applies the same test on the
 *  @api side; this copy serves `objKey` only). */
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** An object-literal key: bare when it is a valid identifier, quoted otherwise. */
function objKey(key: string): string {
  return IDENT_RE.test(key) ? key : jsString(key);
}

/**
 * Re-spell an invariant numeric value in the recording locale.
 *
 * Only plain decimal numbers are converted — a formula in invariant form also
 * carries invariant ARGUMENT separators, which cannot be fixed by a character
 * swap, so those are left alone and reported by the caller instead.
 */
export function localizeInvariantNumber(value: string, separator: string): string {
  if (separator === ".") return value;
  if (!/^[+-]?\d+\.\d+([eE][+-]?\d+)?$/.test(value)) return value;
  return value.replace(".", separator);
}

// ============================================================================
// Small structural helpers
// ============================================================================

/** Split sorted-or-not indices into ascending runs of consecutive values. */
export function consecutiveRuns(indices: number[]): Array<[number, number]> {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const runs: Array<[number, number]> = [];
  for (const i of sorted) {
    const last = runs[runs.length - 1];
    if (last && i === last[1] + 1) {
      last[1] = i;
    } else {
      runs.push([i, i]);
    }
  }
  return runs;
}

/** ScriptFormat's accepted property set (objectContexts.d.ts). */
const SCRIPT_FORMAT_KEYS = new Set([
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "fontSize",
  "fontFamily",
  "textColor",
  "backgroundColor",
  "textAlign",
  "verticalAlign",
  "numberFormat",
  "wrapText",
  "textRotation",
  "indent",
  "shrinkToFit",
  "borderTop",
  "borderRight",
  "borderBottom",
  "borderLeft",
  "borderDiagonalDown",
  "borderDiagonalUp",
]);

type FormattingPayload = RecordedGridEventOf<"formatting">["formatting"];

/** Render a recorded FormattingOptions as a ScriptFormat object literal.
 *  Returns null when nothing survives the filter. */
function formatLiteral(formatting: FormattingPayload): {
  literal: string | null;
  dropped: string[];
} {
  const parts: string[] = [];
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(formatting)) {
    if (value === undefined) continue;
    if (!SCRIPT_FORMAT_KEYS.has(key)) {
      dropped.push(key);
      continue;
    }
    parts.push(`${objKey(key)}: ${valueLiteral(value)}`);
  }
  return { literal: parts.length > 0 ? `{ ${parts.join(", ")} }` : null, dropped };
}

/** JSON-ish literal for a recorded plain value (string/number/bool/object). */
function valueLiteral(value: unknown): string {
  if (typeof value === "string") return jsString(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(valueLiteral).join(", ")}]`;
  if (typeof value === "object") {
    const parts = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${objKey(k)}: ${valueLiteral(v)}`);
    return `{ ${parts.join(", ")} }`;
  }
  return "undefined";
}

/** JSON for command args, or null when they cannot be represented. */
function argsLiteral(args: unknown): string | null {
  if (args === undefined) return null;
  try {
    const json = JSON.stringify(args);
    if (json === undefined) return null;
    return json;
  } catch {
    return null;
  }
}

// ============================================================================
// Emitter
// ============================================================================

interface EmitContext {
  o: ResolvedOptions;
  lines: string[];
  unsupported: string[];
  /** Counter for generated temp variable names. */
  temp: number;
  /** True once an invariant FORMULA has been seen (one warning, not N). */
  warnedInvariantFormula: boolean;
  /** True once a `caps.biModel` call was emitted: widens the scaffold to
   *  `(api, caps)` and adds the `// @capability bi.model` pragma. */
  usesCaps: boolean;
  /** Connections already introduced with a name comment. */
  namedConnections: Set<string>;
  /** The sheet the action being emitted was recorded on (`RecordedAction.sheetIndex`:
   *  the sheet that was active). An event that names ANOTHER sheet replays there. */
  sheet: number | null;
}

function push(ctx: EmitContext, line: string): void {
  ctx.lines.push(line);
}

function unsupported(ctx: EmitContext, message: string): void {
  ctx.unsupported.push(message);
  push(ctx, `// NOT REPLAYABLE (${ctx.o.target}): ${message}`);
}

/** The write list for one merged run of consecutive cell-write events.
 *  Later writes to the same cell win; first-appearance order is kept. */
export function mergeWrites(
  writes: Array<{ row: number; col: number; value: string; invariant?: boolean }>,
): Array<{ row: number; col: number; value: string; invariant?: boolean }> {
  const order: string[] = [];
  const byKey = new Map<string, { row: number; col: number; value: string; invariant?: boolean }>();
  for (const w of writes) {
    const key = `${w.row}:${w.col}`;
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, w);
  }
  return order.map((k) => byKey.get(k)!);
}

function writeValue(
  ctx: EmitContext,
  w: { value: string; invariant?: boolean },
): string {
  if (!w.invariant) return jsString(w.value);
  if (w.value.startsWith("=")) {
    if (!ctx.warnedInvariantFormula) {
      ctx.warnedInvariantFormula = true;
      push(
        ctx,
        "// NOTE: the formulas below were recorded in invariant (US) form —" +
          " check the argument separator if your locale uses ';'.",
      );
    }
    return jsString(w.value);
  }
  return jsString(localizeInvariantNumber(w.value, ctx.o.decimalSeparator));
}

function emitCellWrites(
  ctx: EmitContext,
  writes: Array<{ row: number; col: number; value: string; invariant?: boolean }>,
): void {
  const merged = mergeWrites(writes);
  if (merged.length === 0) return;

  if (merged.length === 1) {
    const w = merged[0];
    const value = writeValue(ctx, w);
    if (ctx.o.target === "objectScript") {
      push(ctx, `await api.setCellValue(${w.row}, ${w.col}, ${value}); // ${a1(w.row, w.col)}`);
    } else {
      push(ctx, `Calcula.setCellValue(${w.row}, ${w.col}, ${value}); // ${a1(w.row, w.col)}`);
    }
    return;
  }

  // Many cells: one call per chunk, never one line per cell.
  const entries = merged.map(
    (w) => `  { row: ${w.row}, col: ${w.col}, value: ${writeValue(ctx, w)} },`,
  );

  if (ctx.o.target === "objectScript") {
    for (let start = 0; start < entries.length; start += ctx.o.batchChunkSize) {
      const chunk = entries.slice(start, start + ctx.o.batchChunkSize);
      push(ctx, `await api.updateCellsBatch([`);
      for (const e of chunk) push(ctx, e);
      push(ctx, `]);`);
    }
    return;
  }

  // The notebook runtime has no bulk write; one array + one loop still beats
  // N separate statements for both size and readability.
  ctx.temp += 1;
  const name = `writes${ctx.temp}`;
  push(ctx, `const ${name} = [`);
  for (const e of entries) push(ctx, e);
  push(ctx, `];`);
  push(ctx, `for (const w of ${name}) Calcula.setCellValue(w.row, w.col, w.value);`);
}

/**
 * The sheets a recorded format reached, in replay order: `null` for the
 * action's OWN sheet (an ordinary call, the active sheet at replay), then every
 * OTHER sheet by index (a sheet-addressed call).
 *
 * `sheetIndices` absent = the action's sheet alone (as before the event
 * carried its sheets). Present, it is EVERY sheet the one command formatted:
 * a grouped gesture's group, the action's sheet among them -- recorded without
 * it, a grouped Bold replayed on the active sheet alone -- or the sheets a
 * script's off-sheet format named, which need not include the action's sheet
 * (and then the action's sheet is left alone).
 */
function formattedSheets(ctx: EmitContext, sheetIndices: readonly number[] | undefined): Array<number | null> {
  if (sheetIndices === undefined || sheetIndices.length === 0) return [null];
  const others = sheetIndices.filter((s, i) => s !== ctx.sheet && sheetIndices.indexOf(s) === i);
  return ctx.sheet !== null && sheetIndices.includes(ctx.sheet) ? [null, ...others] : others;
}

/** " on sheets 0, 2" for an event that names its sheets; "" for one that does not. */
function namedSheetsLabel(ctx: EmitContext, sheetIndices: readonly number[] | undefined): string {
  if (sheetIndices === undefined || sheetIndices.length === 0) return "";
  const all = formattedSheets(ctx, sheetIndices).map((s) => (s === null ? ctx.sheet : s));
  return ` on sheet${all.length === 1 ? "" : "s"} ${all.join(", ")}`;
}

/** The sheet an event NAMED when it is not the action's own; null otherwise. */
function otherSheet(ctx: EmitContext, sheetIndex: number | undefined): number | null {
  return sheetIndex !== undefined && sheetIndex !== ctx.sheet ? sheetIndex : null;
}

function emitFormatting(
  ctx: EmitContext,
  ev: RecordedGridEventOf<"formatting">,
): void {
  const { literal, dropped } = formatLiteral(ev.formatting);
  const rowRuns = consecutiveRuns(ev.rows);
  const colRuns = consecutiveRuns(ev.cols);
  if (rowRuns.length === 0 || colRuns.length === 0) return;

  if (ctx.o.target !== "objectScript") {
    unsupported(
      ctx,
      `format ${a1Range(rowRuns[0][0], colRuns[0][0], rowRuns[rowRuns.length - 1][1], colRuns[colRuns.length - 1][1])}` +
        `${namedSheetsLabel(ctx, ev.sheetIndices)} — the notebook runtime has no formatting API`,
    );
    return;
  }

  if (dropped.length > 0) {
    push(
      ctx,
      `// Dropped (not part of the script format surface): ${dropped.join(", ")}`,
    );
  }
  if (!literal) return;

  // `api.setRangeFormat` is sheet-addressable (its sixth argument): another
  // sheet is formatted where it stands, and the active sheet never moves.
  for (const sheet of formattedSheets(ctx, ev.sheetIndices)) {
    const sheetArg = sheet === null ? "" : `, ${sheet}`;
    const sheetNote = sheet === null ? "" : ` on sheet ${sheet}`;
    for (const [r0, r1] of rowRuns) {
      for (const [c0, c1] of colRuns) {
        push(
          ctx,
          `await api.setRangeFormat(${r0}, ${c0}, ${r1}, ${c1}, ${literal}${sheetArg}); // ${a1Range(r0, c0, r1, c1)}${sheetNote}`,
        );
      }
    }
  }
}

/**
 * The most cells ONE script call may name: the broker's `MAX_RANGE_CELLS`
 * (@api/scriptHost/validators -- `vRangeRef` refuses a bigger rectangle for
 * `api.clearRange` / `api.clearRangeFormat`) and `api.updateCellsBatch`'s own
 * limit (allowlist.ts). Restated rather than imported so this generator stays a
 * pure, import-free function; clearRangeBoundedReplay.test.ts pins all three
 * equal.
 */
export const SCRIPT_RANGE_MAX_CELLS = 100_000;

/**
 * The most positions a replayed big Clear Contents READS to find the cells that
 * hold a value: the recorded rectangle cut to the sheet's used range, read in
 * row bands of at most `SCRIPT_RANGE_MAX_CELLS` (at most about 60 reads). The
 * used range is the BOUNDING BOX of everything stored, so one far-away cell
 * (a value or a formatted blank at XFD1048576) stretches it over the whole
 * sheet; a cut bigger than this is refused when the macro runs, with the
 * reason, rather than read for hours.
 */
export const CLEAR_REPLAY_MAX_SCANNED_CELLS = 5_000_000;

/**
 * A recorded Clear (Delete / Clear Contents / Clear Formats / Clear All).
 *
 * NEVER UNBOUNDED. The gesture names a RECTANGLE, and a clicked column header
 * is 1,048,576 positions, Select All about 17 billion. This used to replay as a
 * loop pushing one update per position of the WHOLE rectangle (object script)
 * or calling `setCellValue` once per position (notebook), so such a macro hung
 * its run or ran out of memory. Now:
 *
 *   - a rectangle of at most `SCRIPT_RANGE_MAX_CELLS` replays as before: the
 *     contents as ONE `api.updateCellsBatch` (a notebook: one loop), the
 *     formats as ONE `api.clearRangeFormat`;
 *   - a bigger one clears CONTENTS only in the cells that HOLD a value or a
 *     formula. The recorded rectangle is cut to the sheet's used range, READ AT
 *     REPLAY TIME (`getUsedRange`, Excel's UsedRange -- a position outside it
 *     holds no value), and that cut is read in row bands of at most
 *     `SCRIPT_RANGE_MAX_CELLS` cells (`getRangeValues`; a notebook's
 *     `getRange`); "" is written only where a band holds something, so an
 *     empty position costs no write, no undo record and no recalculation seed.
 *     The used range is a bounding box, so a sparse sheet (A1:D100 plus one cell
 *     at XFD1048576) makes the cut the whole sheet: a cut of more than
 *     `CLEAR_REPLAY_MAX_SCANNED_CELLS` positions is REFUSED when the macro runs
 *     (it throws, naming the size), never looped over -- the cut is only known
 *     then, so it cannot be a generation-time note. Its FORMATS are not
 *     replayable: a whole-column or whole-row format is a property of the line,
 *     not of stored cells, so it can be neither cut to the used range nor
 *     cleared in pieces (each piece would write an explicit-Normal cell per
 *     position), and one call over the rectangle is refused by the script API.
 *     Said out loud (`unsupported`), never dropped.
 *
 * The contents of the action's OWN sheet go through `api.updateCellsBatch`,
 * not `api.clearRange`, on purpose: an application's macro that a person runs
 * gets cell access only (owner decision B, `EXPLICIT_RUN_CELL_METHODS` in
 * @api/scriptHost/explicitRunGrant), which admits `updateCellsBatch`,
 * `getUsedRange` and `getRangeValues` but not `clearRange` -- a recorded Delete
 * must keep working there.
 *
 * A clear the caller addressed to ANOTHER sheet -- a grouped clear reaches each
 * OTHER grouped sheet this way, and so does a script's off-sheet clear --
 * replays on THAT sheet (both script surfaces take the sheet as an argument, so
 * the active sheet never moves). Emitted as if on the action's sheet, it
 * cleared the active sheet instead and left the named one untouched.
 */
function emitClearRange(
  ctx: EmitContext,
  ev: RecordedGridEventOf<"clearRange">,
): void {
  const { startRow, startCol, endRow, endCol, applyTo } = ev;
  const sheet = otherSheet(ctx, ev.sheetIndex);
  const label = a1Range(startRow, startCol, endRow, endCol) + (sheet === null ? "" : ` on sheet ${sheet}`);
  const clearsContents = applyTo === "all" || applyTo === "contents" || applyTo === "resetContents";
  const clearsFormats = applyTo === "all" || applyTo === "formats";

  if (!clearsContents && !clearsFormats) {
    unsupported(ctx, `clear "${applyTo}" on ${label} — no script API for that clear kind`);
    return;
  }

  const cells = (endRow - startRow + 1) * (endCol - startCol + 1);
  const fits = cells <= SCRIPT_RANGE_MAX_CELLS;
  const rect: ClearRect = { startRow, startCol, endRow, endCol, sheet, label };
  if (ctx.o.target === "objectScript") {
    if (rect.sheet !== null) {
      // Another sheet: the sheet-addressable `api.clearRange` (`clearRangeFormat`
      // refuses an off-sheet target, `updateCellsBatch` names no sheet).
      if (fits) {
        emitSheetAddressedClear(ctx, rect, clearsContents, clearsFormats);
        return;
      }
      if (clearsContents) emitBoundedSheetAddressedContentsClear(ctx, rect);
      if (clearsFormats) unsupported(ctx, bigFormatClearMessage(label, cells));
      return;
    }
    if (clearsContents) {
      if (fits) emitContentsBatch(ctx, rect);
      else emitBoundedContentsBatches(ctx, rect);
    }
    if (clearsFormats) {
      if (fits) push(ctx, `await api.clearRangeFormat(${startRow}, ${startCol}, ${endRow}, ${endCol}); // ${label}`);
      else unsupported(ctx, bigFormatClearMessage(label, cells));
    }
    return;
  }

  // Notebook: the QuickJS surface has a typed per-cell write (with a sheet
  // argument) and no clear op and no formatting op.
  if (clearsContents) {
    if (cells <= SCRIPT_RANGE_MAX_CELLS) emitNotebookContentsLoop(ctx, rect);
    else emitBoundedNotebookContentsClear(ctx, rect);
  }
  if (clearsFormats) {
    unsupported(ctx, `clear formats on ${label} — the notebook runtime has no formatting API`);
  }
}

/** One recorded clear rectangle; `sheet` null = the action's own sheet. */
interface ClearRect {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  sheet: number | null;
  label: string;
}

function bigFormatClearMessage(label: string, cells: number): string {
  return (
    `clear formats on ${label} (${cells} cells) — the script API clears formats on at most ` +
    `${SCRIPT_RANGE_MAX_CELLS} cells per call, and a whole-row or whole-column format cannot be cleared piece by piece`
  );
}

/**
 * Another sheet, a rectangle that fits one call: ONE
 * `api.clearRange(..., { applyTo }, sheet)` -- the script API's own vocabulary
 * (vClearRange: all / contents / formats), so "resetContents" replays as a
 * contents clear.
 */
function emitSheetAddressedClear(
  ctx: EmitContext,
  r: ClearRect,
  clearsContents: boolean,
  clearsFormats: boolean,
): void {
  const scriptApplyTo = clearsContents && clearsFormats ? "all" : clearsContents ? "contents" : "formats";
  const what = scriptApplyTo === "all" ? "contents and formats" : scriptApplyTo;
  push(
    ctx,
    `await api.clearRange(${r.startRow}, ${r.startCol}, ${r.endRow}, ${r.endCol}, { applyTo: ${jsString(scriptApplyTo)} }, ${r.sheet}); // clear ${what} of ${r.label}`,
  );
}

/**
 * The replay-time cut of the recorded rectangle to the used range: declares
 * `used`, `r0`, `r1`, `c0`, `c1`. `usedExpr` is the runtime's read of the used
 * range (an object script awaits `api.getUsedRange`; a notebook parses the JSON
 * text `Calcula.getUsedRange` returns).
 */
function pushUsedRangeCut(ctx: EmitContext, r: ClearRect, usedExpr: string): void {
  push(ctx, `  const used = ${usedExpr};`);
  push(ctx, `  const r0 = Math.max(${r.startRow}, used.startRow), r1 = Math.min(${r.endRow}, used.endRow);`);
  push(ctx, `  const c0 = Math.max(${r.startCol}, used.startCol), c1 = Math.min(${r.endCol}, used.endCol);`);
}

/**
 * Inside `if (the cut is not empty)`: refuse a cut too big to read
 * (`CLEAR_REPLAY_MAX_SCANNED_CELLS`) with the reason, then declare `step`, the
 * rows of one band of at most `SCRIPT_RANGE_MAX_CELLS` cells (a sheet has at
 * most 16,384 columns, so a band is at least 6 rows).
 */
function pushScanGuardAndStep(ctx: EmitContext, r: ClearRect): void {
  const what = jsString(`Clear Contents of ${r.label} was not replayed: inside it, the sheet's used range covers `);
  const why = jsString(
    ` cells, more than the ${CLEAR_REPLAY_MAX_SCANNED_CELLS} a replay reads to find the cells that hold a value. ` +
      `Clear a smaller range, or delete the far-away cells that stretch the used range.`,
  );
  push(ctx, `    const scanned = (r1 - r0 + 1) * (c1 - c0 + 1);`);
  push(ctx, `    if (scanned > ${CLEAR_REPLAY_MAX_SCANNED_CELLS}) throw new Error(${what} + scanned + ${why});`);
  push(ctx, `    const step = Math.floor(${SCRIPT_RANGE_MAX_CELLS} / (c1 - c0 + 1));`);
}

/**
 * Another sheet, a bigger rectangle: its cut to THAT sheet's used range read in
 * row bands, and each band that holds a value cleared as ONE sheet-addressed
 * `api.clearRange` over the rows and columns that hold one (an empty band costs
 * a read and nothing else).
 */
function emitBoundedSheetAddressedContentsClear(ctx: EmitContext, r: ClearRect): void {
  push(ctx, `{ // clear contents of ${r.label}: only where a cell holds a value, at most ${SCRIPT_RANGE_MAX_CELLS} cells per call`);
  pushUsedRangeCut(ctx, r, `await api.getUsedRange(${r.sheet})`);
  push(ctx, `  if (!used.empty && r0 <= r1 && c0 <= c1) {`);
  pushScanGuardAndStep(ctx, r);
  push(ctx, `    for (let r = r0; r <= r1; r += step) {`);
  push(ctx, `      const band = await api.getRangeValues(r, c0, Math.min(r + step - 1, r1), c1, ${r.sheet});`);
  push(ctx, `      let top = -1, bottom = -1, left = c1, right = c0;`);
  push(ctx, `      for (let i = 0; i < band.length; i++) {`);
  push(ctx, `        for (let k = 0; k < band[i].length; k++) {`);
  push(ctx, `          if (band[i][k].type === "empty" && !band[i][k].formula) continue;`);
  push(ctx, `          if (top < 0) top = r + i;`);
  push(ctx, `          bottom = r + i;`);
  push(ctx, `          left = Math.min(left, c0 + k);`);
  push(ctx, `          right = Math.max(right, c0 + k);`);
  push(ctx, `        }`);
  push(ctx, `      }`);
  push(ctx, `      if (top >= 0) await api.clearRange(top, left, bottom, right, { applyTo: "contents" }, ${r.sheet});`);
  push(ctx, `    }`);
  push(ctx, `  }`);
  push(ctx, `}`);
}

/** The action's own sheet, at most SCRIPT_RANGE_MAX_CELLS positions: one loop and ONE batch call (as always). */
function emitContentsBatch(ctx: EmitContext, r: ClearRect): void {
  push(ctx, `{ // clear contents of ${r.label}`);
  push(ctx, `  const updates = [];`);
  push(ctx, `  for (let r = ${r.startRow}; r <= ${r.endRow}; r++) {`);
  push(ctx, `    for (let c = ${r.startCol}; c <= ${r.endCol}; c++) updates.push({ row: r, col: c, value: "" });`);
  push(ctx, `  }`);
  push(ctx, `  await api.updateCellsBatch(updates);`);
  push(ctx, `}`);
}

/**
 * The action's own sheet, a bigger rectangle: its cut to the used range read in
 * row bands (`api.getRangeValues`, which the explicit-run cell access admits),
 * and "" written only to the cells that hold a value or a formula, in
 * `api.updateCellsBatch` calls of at most SCRIPT_RANGE_MAX_CELLS.
 */
function emitBoundedContentsBatches(ctx: EmitContext, r: ClearRect): void {
  push(ctx, `{ // clear contents of ${r.label}: only the cells that hold a value, at most ${SCRIPT_RANGE_MAX_CELLS} per call`);
  pushUsedRangeCut(ctx, r, "await api.getUsedRange()");
  push(ctx, `  if (!used.empty && r0 <= r1 && c0 <= c1) {`);
  pushScanGuardAndStep(ctx, r);
  push(ctx, `    let updates = [];`);
  push(ctx, `    for (let r = r0; r <= r1; r += step) {`);
  push(ctx, `      const band = await api.getRangeValues(r, c0, Math.min(r + step - 1, r1), c1);`);
  push(ctx, `      for (let i = 0; i < band.length; i++) {`);
  push(ctx, `        for (let k = 0; k < band[i].length; k++) {`);
  push(ctx, `          if (band[i][k].type === "empty" && !band[i][k].formula) continue;`);
  push(ctx, `          updates.push({ row: r + i, col: c0 + k, value: "" });`);
  push(ctx, `          if (updates.length === ${SCRIPT_RANGE_MAX_CELLS}) {`);
  push(ctx, `            await api.updateCellsBatch(updates);`);
  push(ctx, `            updates = [];`);
  push(ctx, `          }`);
  push(ctx, `        }`);
  push(ctx, `      }`);
  push(ctx, `    }`);
  push(ctx, `    if (updates.length > 0) await api.updateCellsBatch(updates);`);
  push(ctx, `  }`);
  push(ctx, `}`);
}

/** The notebook's typed write of an empty value, on the named sheet when there is one. */
function notebookClearCall(r: ClearRect, row: string, col: string): string {
  return `Calcula.setCellValue(${row}, ${col}, ""${r.sheet === null ? "" : `, ${r.sheet}`})`;
}

/**
 * Notebook, a rectangle of at most SCRIPT_RANGE_MAX_CELLS: one loop. Another
 * sheet is written through `setCellValue`'s sheet argument, never by switching
 * to it and back (the old switch-back read `Calcula.getActiveSheet().index`,
 * but that op returns a JSON STRING, so it switched to `undefined` and threw).
 */
function emitNotebookContentsLoop(ctx: EmitContext, r: ClearRect): void {
  push(ctx, `// clear contents of ${r.label}`);
  push(ctx, `for (let r = ${r.startRow}; r <= ${r.endRow}; r++) {`);
  push(ctx, `  for (let c = ${r.startCol}; c <= ${r.endCol}; c++) ${notebookClearCall(r, "r", "c")};`);
  push(ctx, `}`);
}

/**
 * Notebook, a bigger rectangle: the cut to the used range read in row bands
 * (`Calcula.getRange`, JSON text of display strings; the ops return JSON text),
 * and "" written only where a cell holds something. A cell that reads "" can
 * still hold a formula whose result is empty text, so such a position asks
 * `Calcula.getCellFormula` -- an in-process read, bounded by the same scan cap.
 */
function emitBoundedNotebookContentsClear(ctx: EmitContext, r: ClearRect): void {
  const sheetArg = r.sheet === null ? "" : `, ${r.sheet}`;
  push(ctx, `{ // clear contents of ${r.label}: only the cells that hold a value`);
  pushUsedRangeCut(ctx, r, `JSON.parse(Calcula.getUsedRange(${r.sheet === null ? "" : r.sheet}))`);
  push(ctx, `  if (!used.empty && r0 <= r1 && c0 <= c1) {`);
  pushScanGuardAndStep(ctx, r);
  push(ctx, `    for (let r = r0; r <= r1; r += step) {`);
  push(ctx, `      const band = JSON.parse(Calcula.getRange(r, c0, Math.min(r + step - 1, r1), c1${sheetArg}));`);
  push(ctx, `      for (let i = 0; i < band.length; i++) {`);
  push(ctx, `        for (let k = 0; k < band[i].length; k++) {`);
  push(ctx, `          if (band[i][k] === "" && Calcula.getCellFormula(r + i, c0 + k${sheetArg}) === "") continue;`);
  push(ctx, `          ${notebookClearCall(r, "r + i", "c0 + k")};`);
  push(ctx, `        }`);
  push(ctx, `      }`);
  push(ctx, `    }`);
  push(ctx, `  }`);
  push(ctx, `}`);
}

function emitFillRange(
  ctx: EmitContext,
  ev: RecordedGridEventOf<"fillRange">,
): void {
  const label = `${a1Range(ev.sourceStartRow, ev.sourceStartCol, ev.sourceEndRow, ev.sourceEndCol)} -> ${a1Range(ev.targetStartRow, ev.targetStartCol, ev.targetEndRow, ev.targetEndCol)}`;
  const sameCols =
    ev.sourceStartCol === ev.targetStartCol && ev.sourceEndCol === ev.targetEndCol;
  const sameRows =
    ev.sourceStartRow === ev.targetStartRow && ev.sourceEndRow === ev.targetEndRow;

  if (ctx.o.target === "notebook") {
    if (sameCols && ev.targetStartRow === ev.sourceEndRow + 1) {
      push(
        ctx,
        `Calcula.fillDown(${ev.sourceStartRow}, ${ev.sourceStartCol}, ${ev.targetEndRow}, ${ev.targetEndCol}); // ${label}`,
      );
      return;
    }
    if (sameRows && ev.targetStartCol === ev.sourceEndCol + 1) {
      push(
        ctx,
        `Calcula.fillRight(${ev.sourceStartRow}, ${ev.sourceStartCol}, ${ev.targetEndRow}, ${ev.targetEndCol}); // ${label}`,
      );
      return;
    }
    unsupported(ctx, `fill ${label} — only downward and rightward fills have a Calcula op`);
    return;
  }

  // objectScript: `api.fillRange` takes the COMBINED source+target rectangle,
  // a direction, and the source-band size. Its default type "copy" (copy
  // values, shift formulas) is exactly the backend `fill_range` this event
  // recorded, so the replay is faithful — see commands/data.rs fill_range.
  const emit = (
    r0: number, c0: number, r1: number, c1: number,
    direction: string, sourceSize: number,
  ) => {
    push(
      ctx,
      `await api.fillRange(${r0}, ${c0}, ${r1}, ${c1}, { direction: ${jsString(direction)}, sourceSize: ${sourceSize} }); // ${label}`,
    );
  };
  if (sameCols && ev.targetStartRow === ev.sourceEndRow + 1) {
    emit(
      ev.sourceStartRow, ev.sourceStartCol, ev.targetEndRow, ev.targetEndCol,
      "down", ev.sourceEndRow - ev.sourceStartRow + 1,
    );
    return;
  }
  if (sameCols && ev.targetEndRow === ev.sourceStartRow - 1) {
    emit(
      ev.targetStartRow, ev.sourceStartCol, ev.sourceEndRow, ev.targetEndCol,
      "up", ev.sourceEndRow - ev.sourceStartRow + 1,
    );
    return;
  }
  if (sameRows && ev.targetStartCol === ev.sourceEndCol + 1) {
    emit(
      ev.sourceStartRow, ev.sourceStartCol, ev.targetEndRow, ev.targetEndCol,
      "right", ev.sourceEndCol - ev.sourceStartCol + 1,
    );
    return;
  }
  if (sameRows && ev.targetEndCol === ev.sourceStartCol - 1) {
    emit(
      ev.sourceStartRow, ev.targetStartCol, ev.sourceEndRow, ev.sourceEndCol,
      "left", ev.sourceEndCol - ev.sourceStartCol + 1,
    );
    return;
  }
  unsupported(ctx, `fill ${label} — the source and target bands are not adjacent`);
}

/**
 * The sort-field properties `api.sortRange` accepts, in the order they are
 * emitted. The broker validator REJECTS an unknown property outright, so this
 * list is a hard filter and not a style choice: emitting a field the recorder
 * happened to see but the script API does not know would generate a macro that
 * fails on its first run.
 */
const SCRIPT_SORT_FIELD_KEYS = [
  "key",
  "ascending",
  "sortOn",
  "color",
  "dataOption",
  "subField",
  "customOrder",
] as const;

type SortFieldPayload = RecordedGridEventOf<"sort">["fields"][number];

/** Render one recorded sort criterion as a ScriptSortField object literal. */
function sortFieldLiteral(field: SortFieldPayload): string {
  const parts: string[] = [];
  for (const key of SCRIPT_SORT_FIELD_KEYS) {
    const value = field[key];
    if (value === undefined) continue;
    parts.push(`${key}: ${valueLiteral(value)}`);
  }
  return `{ ${parts.join(", ")} }`;
}

function emitSort(ctx: EmitContext, ev: RecordedGridEventOf<"sort">): void {
  const label = a1Range(ev.startRow, ev.startCol, ev.endRow, ev.endCol);

  if (ctx.o.target !== "objectScript") {
    unsupported(ctx, `sort ${label} — the notebook runtime has no sort op`);
    return;
  }

  // The broker requires a non-empty field list whose keys are non-negative
  // integer offsets from the range start. A recording that violates either
  // could only produce a macro that throws, so say so instead of emitting it.
  if (ev.fields.length === 0) {
    unsupported(ctx, `sort ${label} — no sort criteria were recorded`);
    return;
  }
  const badKey = ev.fields.find(
    (f) => !Number.isInteger(f.key) || f.key < 0,
  );
  if (badKey) {
    unsupported(
      ctx,
      `sort ${label} — sort key ${badKey.key} is not an offset from the range start`,
    );
    return;
  }

  const fields = ev.fields.map(sortFieldLiteral).join(", ");
  const options =
    `{ matchCase: ${ev.matchCase}, hasHeaders: ${ev.hasHeaders},` +
    ` orientation: ${jsString(ev.orientation)} }`;
  push(
    ctx,
    `await api.sortRange(${ev.startRow}, ${ev.startCol}, ${ev.endRow}, ${ev.endCol}, [${fields}], ${options}); // ${label}`,
  );
}

function emitObjectScriptOnly(
  ctx: EmitContext,
  statement: string,
  what: string,
): void {
  if (ctx.o.target === "objectScript") {
    push(ctx, statement);
  } else {
    unsupported(ctx, `${what} — no Calcula op on the notebook runtime`);
  }
}

// ============================================================================
// BI-model edits (caps.biModel — see bi/macro_capture.rs for the capture side)
// ============================================================================

/** First mention of a connection gets a comment naming it — the id alone is
 *  opaque, and the name is the only place the reader learns which model the
 *  macro edits. Replay always uses the id. */
function emitConnectionComment(ctx: EmitContext, ev: RecordedModelEditEvent): void {
  if (ctx.namedConnections.has(ev.connectionId)) return;
  ctx.namedConnections.add(ev.connectionId);
  const name = ev.connectionName ? ` "${ev.connectionName}"` : "";
  push(
    ctx,
    `// BI connection${name} (id recorded from this workbook). Model edits land`,
  );
  push(ctx, `// on the MODEL undo stack (Model Editor Undo), not this grid batch.`);
}

function emitModelEdit(ctx: EmitContext, ev: RecordedModelEditEvent): void {
  const label = `${ev.action} ${ev.modelKind}${ev.name ? ` ${jsString(ev.name)}` : ""}`;

  if (ctx.o.target !== "objectScript") {
    unsupported(
      ctx,
      `model ${label} — the notebook model surface is read-only; use the object-script target`,
    );
    return;
  }
  if (!ev.replayable || !ev.payload) {
    unsupported(
      ctx,
      `model ${label} — ${ev.reason ?? "this edit cannot be replayed"}`,
    );
    return;
  }

  ctx.usesCaps = true;
  emitConnectionComment(ctx, ev);
  const conn = jsString(ev.connectionId);
  const kind = jsString(ev.modelKind);
  const method = ev.action === "delete" ? "delete" : "upsert";
  // The payload arrives GATEWAY-READY from the Rust capture (built beside the
  // gateway's own field reads) — embed it verbatim, never remap fields here.
  const json = JSON.stringify(ev.payload, null, 2) ?? "{}";
  const jsonLines = json.split("\n");
  if (jsonLines.length === 1) {
    push(ctx, `await caps.biModel.${method}(${conn}, ${kind}, ${json});`);
    return;
  }
  push(ctx, `await caps.biModel.${method}(${conn}, ${kind}, ${jsonLines[0]}`);
  for (let k = 1; k < jsonLines.length - 1; k++) push(ctx, jsonLines[k]);
  push(ctx, `${jsonLines[jsonLines.length - 1]});`);
}

/**
 * A run of consecutive model edits on ONE connection. Two or more replayable
 * edits are wrapped in `batchBegin`/`batchEnd` so the replay is atomic and one
 * model undo step — regardless of whether the original gestures were batched
 * (a CLI batch that was CANCELLED never reaches codegen at all: the session
 * drops its actions on the `macro:model-batch` cancel marker).
 */
function emitModelRun(ctx: EmitContext, events: RecordedModelEditEvent[]): void {
  const replayable = events.filter((e) => e.replayable && e.payload);
  if (ctx.o.target !== "objectScript" || replayable.length < 2) {
    for (const e of events) emitModelEdit(ctx, e);
    return;
  }

  emitConnectionComment(ctx, events[0]);
  const conn = jsString(events[0].connectionId);
  push(ctx, `await caps.biModel.batchBegin(${conn}); // one model undo step`);
  push(ctx, `try {`);
  const start = ctx.lines.length;
  for (const e of events) emitModelEdit(ctx, e);
  const inner = ctx.lines.splice(start).map((l) => (l.length > 0 ? "  " + l : l));
  ctx.lines.push(...inner);
  push(ctx, `  await caps.biModel.batchEnd(${conn});`);
  push(ctx, `} catch (e) {`);
  push(ctx, `  await caps.biModel.batchCancel(${conn});`);
  push(ctx, `  throw e;`);
  push(ctx, `}`);
  ctx.usesCaps = true;
}

function emitEvent(ctx: EmitContext, event: RecordedEvent): void {
  switch (event.kind) {
    // Sheet context is emitted by the sheet prologue below; the marker itself
    // has no body of its own.
    case "activateSheet":
      return;

    case "cellWrites":
      emitCellWrites(ctx, event.writes);
      return;

    case "formatting":
      emitFormatting(ctx, event);
      return;

    case "borderPreset":
      // Not replayable on any sheet; the note names every sheet it reached
      // (a grouped preset's group), so the reader knows what to redo.
      unsupported(
        ctx,
        `border preset "${event.preset}" on ${a1Range(event.startRow, event.startCol, event.endRow, event.endCol)}` +
          `${namedSheetsLabel(ctx, event.sheetIndices)}` +
          " — no script API for border presets; set the border sides individually",
      );
      return;

    case "clearRange":
      emitClearRange(ctx, event);
      return;

    case "fillRange":
      emitFillRange(ctx, event);
      return;

    case "sort":
      emitSort(ctx, event);
      return;

    case "removeDuplicates": {
      const label = a1Range(event.startRow, event.startCol, event.endRow, event.endCol);
      if (ctx.o.target !== "objectScript") {
        const keys = event.keyColumns.map(colLetter).join(", ");
        unsupported(
          ctx,
          `remove duplicates on ${label} (key column${event.keyColumns.length === 1 ? "" : "s"} ${keys || "none"})` +
            " — the notebook runtime has no remove-duplicates op",
        );
        return;
      }
      // The event records ABSOLUTE key columns; `api.removeDuplicates` takes
      // 0-based offsets FROM THE RANGE START (executeRemoveDuplicates maps
      // them back). Omitted columns mean "every column of the range".
      const offsets = event.keyColumns.map((c) => c - event.startCol);
      const columnsPart =
        offsets.length > 0 ? `columns: [${offsets.join(", ")}], ` : "";
      push(
        ctx,
        `await api.removeDuplicates(${event.startRow}, ${event.startCol}, ${event.endRow}, ${event.endCol}, { ${columnsPart}hasHeaders: ${event.hasHeaders} }); // ${label}`,
      );
      return;
    }

    case "insertRows":
      emitObjectScriptOnly(
        ctx,
        `await api.insertRows(${event.startRow}, ${event.count});`,
        `insert ${event.count} row(s) at row ${event.startRow + 1}`,
      );
      return;

    case "deleteRows":
      emitObjectScriptOnly(
        ctx,
        `await api.deleteRows(${event.startRow}, ${event.count});`,
        `delete ${event.count} row(s) at row ${event.startRow + 1}`,
      );
      return;

    case "insertColumns":
      emitObjectScriptOnly(
        ctx,
        `await api.insertColumns(${event.startCol}, ${event.count});`,
        `insert ${event.count} column(s) at ${colLetter(event.startCol)}`,
      );
      return;

    case "deleteColumns":
      emitObjectScriptOnly(
        ctx,
        `await api.deleteColumns(${event.startCol}, ${event.count});`,
        `delete ${event.count} column(s) at ${colLetter(event.startCol)}`,
      );
      return;

    // A merge the caller addressed to ANOTHER sheet (a script's off-sheet
    // merge) replays there: `api.mergeCells` / `api.unmergeCells` take the
    // sheet as their last argument, and the active sheet never moves.
    case "mergeCells": {
      const sheet = otherSheet(ctx, event.sheetIndex);
      const label =
        a1Range(event.startRow, event.startCol, event.endRow, event.endCol) + (sheet === null ? "" : ` on sheet ${sheet}`);
      emitObjectScriptOnly(
        ctx,
        `await api.mergeCells(${event.startRow}, ${event.startCol}, ${event.endRow}, ${event.endCol}${sheet === null ? "" : `, ${sheet}`}); // ${label}`,
        `merge ${label}`,
      );
      return;
    }

    case "unmergeCells": {
      const sheet = otherSheet(ctx, event.sheetIndex);
      const label = a1(event.row, event.col) + (sheet === null ? "" : ` on sheet ${sheet}`);
      emitObjectScriptOnly(
        ctx,
        `await api.unmergeCells(${event.row}, ${event.col}${sheet === null ? "" : `, ${sheet}`}); // ${label}`,
        `unmerge at ${label}`,
      );
      return;
    }

    case "rowHeight":
      emitObjectScriptOnly(
        ctx,
        `await api.setRowHeight(${event.row}, ${event.height});`,
        `set height of row ${event.row + 1}`,
      );
      return;

    case "columnWidth":
      emitObjectScriptOnly(
        ctx,
        `await api.setColumnWidth(${event.col}, ${event.width});`,
        `set width of column ${colLetter(event.col)}`,
      );
      return;

    case "freezePanes":
      emitObjectScriptOnly(
        ctx,
        `await api.freezePanes(${event.freezeRow}, ${event.freezeCol});`,
        "freeze panes",
      );
      return;

    case "replaceAll": {
      const opts = `{ caseSensitive: ${event.caseSensitive}, matchEntireCell: ${event.matchEntireCell} }`;
      emitObjectScriptOnly(
        ctx,
        `await api.replaceAll(${jsString(event.search)}, ${jsString(event.replacement)}, ${opts});`,
        `replace all ${jsString(event.search)}`,
      );
      return;
    }

    case "addSheet":
      // A canvas replays AS a canvas: the kind is fixed at creation, so a
      // macro that re-added it as a worksheet would build a different
      // workbook. A worksheet keeps the historical one-argument form.
      if (event.sheetKind === "canvas") {
        emitObjectScriptOnly(
          ctx,
          `await api.addSheet(${jsString(event.name)}, undefined, "canvas");`,
          `add canvas ${jsString(event.name)}`,
        );
      } else {
        emitObjectScriptOnly(
          ctx,
          `await api.addSheet(${jsString(event.name)});`,
          `add sheet ${jsString(event.name)}`,
        );
      }
      return;

    case "deleteSheet":
      emitObjectScriptOnly(
        ctx,
        `await api.deleteSheet(${event.index});`,
        `delete sheet ${event.index}`,
      );
      return;

    case "renameSheet":
      emitObjectScriptOnly(
        ctx,
        `await api.renameSheet(${event.index}, ${jsString(event.newName)});`,
        `rename sheet ${event.index}`,
      );
      return;

    case "command": {
      const args = argsLiteral(event.args);
      const call =
        args === null
          ? `api.executeCommand(${jsString(event.commandId)});`
          : `api.executeCommand(${jsString(event.commandId)}, ${args});`;
      emitObjectScriptOnly(
        ctx,
        `${call} // acts on the workbook state at replay time`,
        `command ${event.commandId}`,
      );
      return;
    }

    case "modelEdit":
      // Reached only for a run of one (emitBody groups consecutive model
      // edits into emitModelRun); the case keeps the switch exhaustive.
      emitModelEdit(ctx, event);
      return;

    default: {
      // Exhaustiveness: a new RecordedGridEvent variant must not fall through
      // silently — that is precisely the "runs cleanly, does the wrong thing"
      // failure this generator exists to avoid.
      const never: never = event;
      unsupported(ctx, `unrecognized recorded action ${JSON.stringify(never)}`);
    }
  }
}

// ============================================================================
// Body assembly
// ============================================================================

function emitSheetActivate(ctx: EmitContext, sheetIndex: number): void {
  if (ctx.o.target === "objectScript") {
    push(ctx, `await api.setActiveSheet(${sheetIndex});`);
  } else {
    push(ctx, `Calcula.setActiveSheet(${sheetIndex});`);
  }
}

function emitBody(actions: RecordedAction[], o: ResolvedOptions): {
  lines: string[];
  unsupported: string[];
  usesCaps: boolean;
} {
  const ctx: EmitContext = {
    o,
    lines: [],
    unsupported: [],
    temp: 0,
    warnedInvariantFormula: false,
    usesCaps: false,
    namedConnections: new Set(),
    sheet: null,
  };

  if (actions.length === 0) {
    push(ctx, "// Nothing was recorded.");
    return { lines: ctx.lines, unsupported: ctx.unsupported, usesCaps: false };
  }

  // `null` = "we have not told the runtime which sheet we are on yet".
  let emittedSheet: number | null = null;
  let first = true;

  let i = 0;
  while (i < actions.length) {
    const action = actions[i];

    // Model edits are sheet-independent (they run against a BI connection),
    // so they neither need nor trigger the sheet prologue. A run of them on
    // one connection is emitted together so replay can batch atomically.
    if (action.event.kind === "modelEdit") {
      const connectionId = action.event.connectionId;
      const run: RecordedModelEditEvent[] = [action.event];
      let j = i + 1;
      while (j < actions.length) {
        const e = actions[j].event;
        if (e.kind !== "modelEdit" || e.connectionId !== connectionId) break;
        run.push(e);
        j += 1;
      }
      emitModelRun(ctx, run);
      i = j;
      continue;
    }

    if (action.sheetIndex !== emittedSheet) {
      if (first && !o.emitInitialSheetActivate) {
        // Caller wants a sheet-agnostic macro: adopt whatever sheet is active.
        push(ctx, `// Runs on the active sheet (recorded on sheet ${action.sheetIndex}).`);
      } else {
        emitSheetActivate(ctx, action.sheetIndex);
      }
      emittedSheet = action.sheetIndex;
    }
    first = false;
    ctx.sheet = action.sheetIndex;

    // Merge a run of consecutive cell-write events on the same sheet into ONE
    // emitted call. Without this a 500-cell paste followed by a 500-cell fill
    // becomes 1000 statements.
    if (action.event.kind === "cellWrites") {
      const run = [...action.event.writes];
      let j = i + 1;
      while (
        j < actions.length &&
        actions[j].sheetIndex === action.sheetIndex &&
        actions[j].event.kind === "cellWrites"
      ) {
        run.push(...(actions[j].event as RecordedGridEventOf<"cellWrites">).writes);
        j += 1;
      }
      emitCellWrites(ctx, run);
      i = j;
      continue;
    }

    emitEvent(ctx, action.event);
    i += 1;
  }

  return { lines: ctx.lines, unsupported: ctx.unsupported, usesCaps: ctx.usesCaps };
}

// ============================================================================
// Wrappers
// ============================================================================

function indent(lines: string[], spaces: number): string[] {
  const pad = " ".repeat(spaces);
  return lines.map((l) => (l.length > 0 ? pad + l : l));
}

const TARGET_DESCRIPTION: Record<MacroTarget, string> = {
  objectScript:
    "Calcula object script (unlocked tier) — async, driven through `context.api`.",
  notebook:
    "Calcula notebook cell (QuickJS) — synchronous, driven through the `Calcula.*` ops.",
};

function buildHeader(
  o: ResolvedOptions,
  actionCount: number,
  unsupportedList: string[],
  usesCaps: boolean,
): string[] {
  const lines = [
    `// Macro: ${o.name}`,
    `// Recorded: ${o.recordedAt}  (${actionCount} action${actionCount === 1 ? "" : "s"})`,
    `// Target runtime: ${TARGET_DESCRIPTION[o.target]}`,
  ];
  if (o.target === "objectScript") {
    lines.push(
      "// Needs cell access (`context.api`): your own macro has it, and an application's",
      "// macro has it when YOU run it (Developer > Macros > Run, its button, the command line).",
    );
  }
  if (usesCaps) {
    // The pragma is what Script Security reads (parseDeclaredCapabilities):
    // first run prompts for bi.model consent; the Rust gateway re-checks the
    // grant authoritatively on every call.
    lines.push(`// @capability bi.model`);
    lines.push(
      "// Edits the BI model through the consented bi.model gateway; those edits",
      "// land on the MODEL undo stack (Model Editor Undo), not the grid's Ctrl+Z.",
    );
  }
  if (unsupportedList.length > 0) {
    lines.push(`// ${unsupportedList.length} action(s) could not be expressed on this target:`);
    for (const u of unsupportedList) lines.push(`//   - ${u}`);
  }
  return lines;
}

function wrapObjectScript(
  body: string[],
  o: ResolvedOptions,
  usesCaps: boolean,
): string[] {
  const inner: string[] = [];
  if (o.undoBatch) {
    inner.push(`await api.beginBatch(${jsString(o.name)});`);
    inner.push(`try {`);
    inner.push(...indent(body, 2));
    inner.push(`  await api.commitBatch();`);
    inner.push(`} catch (e) {`);
    inner.push(`  await api.cancelBatch();`);
    inner.push(`  throw e;`);
    inner.push(`}`);
  } else {
    inner.push(...body);
  }

  // Model-free macros keep the historical `(api)` shape byte-for-byte; only a
  // macro that actually edits the model widens to `(api, caps)`.
  const params = usesCaps ? "api, caps" : "api";
  const callArgs = usesCaps ? "context.api, context.caps" : "context.api";

  const fn = [
    `async function ${o.fnName}(${params}) {`,
    ...indent(inner, 2),
    `}`,
  ];

  // ONE entry point, both uses. `setup` is what Calcula calls when this script
  // is mounted, so ending the file with it is what makes the macro RUN rather
  // than merely exist. A module that only declared the function above — with a
  // comment explaining how someone else might call it — is what "I pressed Run
  // and nothing happened" actually was.
  //
  // NO CELL ACCESS IS AN ERROR, NOT A QUIET RETURN (ownerB follow-up F12). The
  // guard used to notify and RETURN, so the mount resolved and the run was
  // reported -- by the caller and on the Rust run row -- as "ran" when nothing
  // had changed. It THROWS now: the run fails with a sentence naming how to
  // get cell access, before a single call, so "Nothing was changed" is true.
  return [
    ...fn,
    ``,
    `// Entry point. Calcula calls setup() when this script is mounted:`,
    `//   • on a BUTTON  -> the macro runs on every click`,
    `//   • run directly (Developer > Macros... > Run) -> it runs once, now`,
    `function setup(context) {`,
    `  if (!context.api) {`,
    `    throw new Error(${jsString(macroNeedsCellAccessMessage(o.name))});`,
    `  }`,
    `  if (typeof context.onClick === "function") {`,
    `    context.onClick(async () => {`,
    `      try {`,
    `        await ${o.fnName}(${callArgs});`,
    `      } catch (e) {`,
    `        context.notify(String(e && e.message ? e.message : e), "error");`,
    `      }`,
    `    });`,
    `    return;`,
    `  }`,
    `  // Returned, not fired-and-forgotten: the mount resolves only after this`,
    `  // promise settles, so "the macro finished" is something the caller knows.`,
    `  return ${o.fnName}(${callArgs});`,
    `}`,
  ];
}

// ============================================================================
// Entry point
// ============================================================================

function defaultWrapper(target: MacroTarget): MacroWrapper {
  return target === "notebook" ? "notebookCell" : "objectScript";
}

function resolveOptions(options: MacroCodegenOptions): ResolvedOptions {
  const target = options.target;
  const wrapper = options.wrapper ?? defaultWrapper(target);

  if (target === "notebook" && wrapper !== "notebookCell") {
    throw new Error(
      `Wrapper "${wrapper}" is an object-script shape; the notebook target only emits "notebookCell".`,
    );
  }
  if (target === "objectScript" && wrapper !== "objectScript") {
    throw new Error(
      `Wrapper "${wrapper}" is a notebook shape; the objectScript target emits "objectScript".`,
    );
  }

  const name = options.name?.trim() || "Recorded macro";
  return {
    target,
    wrapper,
    name,
    fnName: toIdentifier(name),
    decimalSeparator: options.decimalSeparator ?? ".",
    batchChunkSize: Math.max(1, options.batchChunkSize ?? 500),
    header: options.header ?? true,
    undoBatch: (options.undoBatch ?? true) && target === "objectScript",
    emitInitialSheetActivate: options.emitInitialSheetActivate ?? true,
    recordedAt: options.recordedAt ?? "(unrecorded)",
  };
}

/**
 * Generate runnable script source for `actions`.
 *
 * Pure: same actions + same options => byte-identical source.
 */
export function generateMacroSource(
  actions: RecordedAction[],
  options: MacroCodegenOptions,
): MacroCodegenResult {
  const o = resolveOptions(options);
  const { lines: body, unsupported: notSupported, usesCaps } = emitBody(actions, o);

  const wrapped =
    o.target === "objectScript" ? wrapObjectScript(body, o, usesCaps) : body;

  const out: string[] = [];
  if (o.header) {
    out.push(...buildHeader(o, actions.length, notSupported, usesCaps));
    out.push("");
  }
  out.push(...wrapped);

  return { source: out.join("\n") + "\n", unsupported: notSupported };
}
