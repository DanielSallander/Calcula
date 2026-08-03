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
//                  find/replace, executeCommand. Cannot fill.
//   notebook     — the synchronous QuickJS `Calcula.*` ops of a notebook cell.
//                  Values, sheets, fillDown/fillRight. Nothing else.
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
} from "./types";

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

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * A safe JavaScript identifier derived from a macro name.
 * "Monthly close 2026" -> "monthlyClose2026"; unusable input -> `fallback`.
 */
export function toIdentifier(name: string, fallback = "recordedMacro"): string {
  const words = name
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return fallback;
  const joined =
    words[0].toLowerCase() +
    words
      .slice(1)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join("");
  const candidate = /^[0-9]/.test(joined) ? "_" + joined : joined;
  return IDENT_RE.test(candidate) ? candidate : fallback;
}

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
        " — the notebook runtime has no formatting API",
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

  for (const [r0, r1] of rowRuns) {
    for (const [c0, c1] of colRuns) {
      push(
        ctx,
        `await api.setRangeFormat(${r0}, ${c0}, ${r1}, ${c1}, ${literal}); // ${a1Range(r0, c0, r1, c1)}`,
      );
    }
  }
}

function emitClearRange(
  ctx: EmitContext,
  ev: RecordedGridEventOf<"clearRange">,
): void {
  const { startRow, startCol, endRow, endCol, applyTo } = ev;
  const label = a1Range(startRow, startCol, endRow, endCol);
  const clearsContents = applyTo === "all" || applyTo === "contents" || applyTo === "resetContents";
  const clearsFormats = applyTo === "all" || applyTo === "formats";
  const other = !clearsContents && !clearsFormats;

  if (other) {
    unsupported(ctx, `clear "${applyTo}" on ${label} — no script API for that clear kind`);
    return;
  }

  if (clearsContents) {
    if (ctx.o.target === "objectScript") {
      // A loop, not N literals: a cleared range is often thousands of cells,
      // and updateCellsBatch takes the whole rectangle in one call.
      push(ctx, `{ // clear contents of ${label}`);
      push(ctx, `  const updates = [];`);
      push(ctx, `  for (let r = ${startRow}; r <= ${endRow}; r++) {`);
      push(ctx, `    for (let c = ${startCol}; c <= ${endCol}; c++) updates.push({ row: r, col: c, value: "" });`);
      push(ctx, `  }`);
      push(ctx, `  await api.updateCellsBatch(updates);`);
      push(ctx, `}`);
    } else {
      push(ctx, `// clear contents of ${label}`);
      push(ctx, `for (let r = ${startRow}; r <= ${endRow}; r++) {`);
      push(ctx, `  for (let c = ${startCol}; c <= ${endCol}; c++) Calcula.setCellValue(r, c, "");`);
      push(ctx, `}`);
    }
  }

  if (clearsFormats) {
    if (ctx.o.target === "objectScript") {
      push(
        ctx,
        `await api.clearRangeFormat(${startRow}, ${startCol}, ${endRow}, ${endCol}); // ${label}`,
      );
    } else {
      unsupported(ctx, `clear formats on ${label} — the notebook runtime has no formatting API`);
    }
  }
}

function emitFillRange(
  ctx: EmitContext,
  ev: RecordedGridEventOf<"fillRange">,
): void {
  const label = `${a1Range(ev.sourceStartRow, ev.sourceStartCol, ev.sourceEndRow, ev.sourceEndCol)} -> ${a1Range(ev.targetStartRow, ev.targetStartCol, ev.targetEndRow, ev.targetEndCol)}`;

  if (ctx.o.target === "notebook") {
    const sameCols =
      ev.sourceStartCol === ev.targetStartCol && ev.sourceEndCol === ev.targetEndCol;
    const sameRows =
      ev.sourceStartRow === ev.targetStartRow && ev.sourceEndRow === ev.targetEndRow;
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

  unsupported(
    ctx,
    `fill ${label} — the object-script API has no fill; record on the notebook target for fills`,
  );
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
      unsupported(
        ctx,
        `border preset "${event.preset}" on ${a1Range(event.startRow, event.startCol, event.endRow, event.endCol)}` +
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
      const keys = event.keyColumns.map(colLetter).join(", ");
      // No `api.removeDuplicates` exists on either runtime. Reporting it is the
      // whole point: the rows it deleted are NOT coming back on replay, and a
      // silent omission would leave the duplicates in place with no warning.
      unsupported(
        ctx,
        `remove duplicates on ${label} (key column${event.keyColumns.length === 1 ? "" : "s"} ${keys || "none"})` +
          " — no script API for remove-duplicates",
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

    case "mergeCells":
      emitObjectScriptOnly(
        ctx,
        `await api.mergeCells(${event.startRow}, ${event.startCol}, ${event.endRow}, ${event.endCol}); // ${a1Range(event.startRow, event.startCol, event.endRow, event.endCol)}`,
        `merge ${a1Range(event.startRow, event.startCol, event.endRow, event.endCol)}`,
      );
      return;

    case "unmergeCells":
      emitObjectScriptOnly(
        ctx,
        `await api.unmergeCells(${event.row}, ${event.col}); // ${a1(event.row, event.col)}`,
        `unmerge at ${a1(event.row, event.col)}`,
      );
      return;

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
      emitObjectScriptOnly(
        ctx,
        `await api.addSheet(${jsString(event.name)});`,
        `add sheet ${jsString(event.name)}`,
      );
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
} {
  const ctx: EmitContext = {
    o,
    lines: [],
    unsupported: [],
    temp: 0,
    warnedInvariantFormula: false,
  };

  if (actions.length === 0) {
    push(ctx, "// Nothing was recorded.");
    return { lines: ctx.lines, unsupported: ctx.unsupported };
  }

  // `null` = "we have not told the runtime which sheet we are on yet".
  let emittedSheet: number | null = null;
  let first = true;

  let i = 0;
  while (i < actions.length) {
    const action = actions[i];

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

  return { lines: ctx.lines, unsupported: ctx.unsupported };
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
): string[] {
  const lines = [
    `// Macro: ${o.name}`,
    `// Recorded: ${o.recordedAt}  (${actionCount} action${actionCount === 1 ? "" : "s"})`,
    `// Target runtime: ${TARGET_DESCRIPTION[o.target]}`,
  ];
  if (o.target === "objectScript") {
    lines.push(
      "// Requires an UNLOCKED script: `context.api` is null in the restricted tier.",
    );
  }
  if (unsupportedList.length > 0) {
    lines.push(`// ${unsupportedList.length} action(s) could not be expressed on this target:`);
    for (const u of unsupportedList) lines.push(`//   - ${u}`);
  }
  return lines;
}

function wrapObjectScript(body: string[], o: ResolvedOptions): string[] {
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

  const fn = [
    `async function ${o.fnName}(api) {`,
    ...indent(inner, 2),
    `}`,
  ];

  // ONE entry point, both uses. `setup` is what Calcula calls when this script
  // is mounted, so ending the file with it is what makes the macro RUN rather
  // than merely exist. A module that only declared the function above — with a
  // comment explaining how someone else might call it — is what "I pressed Run
  // and nothing happened" actually was.
  return [
    ...fn,
    ``,
    `// Entry point. Calcula calls setup() when this script is mounted:`,
    `//   • on a BUTTON  -> the macro runs on every click`,
    `//   • run directly (Developer > Macros... > Run) -> it runs once, now`,
    `function setup(context) {`,
    `  if (!context.api) {`,
    `    context.notify(${jsString(`"${o.name}" needs an UNLOCKED script; this one is restricted.`)}, "error");`,
    `    return;`,
    `  }`,
    `  if (typeof context.onClick === "function") {`,
    `    context.onClick(async () => {`,
    `      try {`,
    `        await ${o.fnName}(context.api);`,
    `      } catch (e) {`,
    `        context.notify(String(e && e.message ? e.message : e), "error");`,
    `      }`,
    `    });`,
    `    return;`,
    `  }`,
    `  // Returned, not fired-and-forgotten: the mount resolves only after this`,
    `  // promise settles, so "the macro finished" is something the caller knows.`,
    `  return ${o.fnName}(context.api);`,
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
  const { lines: body, unsupported: notSupported } = emitBody(actions, o);

  const wrapped =
    o.target === "objectScript" ? wrapObjectScript(body, o) : body;

  const out: string[] = [];
  if (o.header) {
    out.push(...buildHeader(o, actions.length, notSupported));
    out.push("");
  }
  out.push(...wrapped);

  return { source: out.join("\n") + "\n", unsupported: notSupported };
}
