//! FILENAME: app/src/api/scriptHost/scriptFormBindings.ts
// PURPOSE: The PURE half of form data binding — parsing a widget's `bind`,
//          turning a typed cell into what a widget shows and edits, turning a
//          widget's answer into what the cell receives, and deciding what is
//          dirty. No host reach: the reads and writes themselves live in
//          host.ts (they are broker calls under the form script's own handle,
//          and need executeImpl / the sheet clamp / the undo batch, all of which
//          are private there).
//
// THE ONE RULE EVERY WRITER HERE OBEYS: a widget writes the TYPED value (or
// the user's formula text), never the cell's display string. The entry ladder
// refuses currency text (core/engine/src/number_text.rs ENTRY), so echoing
// "£1,234.50" back into a Currency cell would store TEXT — the exact defect
// the built-in DataForm has today. A number widget bound to that cell edits
// 1234.5 and writes 1234.5; the cell's own format then paints it.

import { parseA1Body, splitSheetPrefix } from "./worker/canonicalModel";
import type { ScriptCell } from "../scriptableObjects";
import type { ControlValue } from "../controlValues";
import {
  FORM_INPUT_TYPE_SET,
  MAX_FORM_OPTIONS,
  MAX_FORM_TABLE_CELLS,
  type FormBinding,
  type FormOption,
  type FormSeed,
  type FormSpec,
  type FormValue,
  type FormWidget,
} from "./scriptFormSpec";

// ============================================================================
// Which widgets are bound, and to what
// ============================================================================

export interface FormBindingDecl {
  name: string;
  widgetType: string;
  bind: FormBinding;
  /** The widget's own writeOn, else the form's, else "submit". */
  writeOn: "submit" | "change";
  /**
   * A `listbox` that takes several answers. It decides the SHAPE of this
   * widget's seed — a list for multi, one string otherwise — and the shape has
   * to match what the renderer holds, or the two disagree about whether the
   * user changed anything. A single-select listbox seeded as a list from a
   * cell reading "EMEA, APAC" was judged DIRTY while untouched, and the
   * submit wrote the first entry back, silently truncating the cell.
   */
  multi: boolean;
}

/** Every INPUT widget that declares a `bind`, in tree order. */
export function collectFormBindings(spec: FormSpec): FormBindingDecl[] {
  const out: FormBindingDecl[] = [];
  const formWriteOn = spec.writeOn ?? "submit";
  const walk = (widgets: FormWidget[]): void => {
    for (const w of widgets) {
      if (FORM_INPUT_TYPE_SET.has(w.type) && "bind" in w && w.bind !== undefined && w.name) {
        out.push({
          name: w.name,
          widgetType: w.type,
          bind: w.bind,
          writeOn: ("writeOn" in w && w.writeOn) || formWriteOn,
          multi: w.type === "listbox" && "multi" in w && w.multi === true,
        });
      }
      if ("children" in w && Array.isArray(w.children)) walk(w.children);
      if (w.type === "tabs") for (const page of w.pages) walk(page.children);
    }
  };
  walk(spec.children);
  return out;
}

/**
 * Widgets whose CONTENT (not value) comes from the workbook: a choice list
 * read from a range, a table's rows read from a range, an image resolved from
 * a media handle. Keyed by the widget's `name`; a nameless widget has nowhere
 * to receive a seed, so it is skipped (it renders its inline content).
 */
export interface FormSourceDecl {
  name: string;
  widgetType: string;
  source: { kind: "options"; range: string } | { kind: "rows"; range: string } | { kind: "image"; src: string };
}

export function collectFormSources(spec: FormSpec): FormSourceDecl[] {
  const out: FormSourceDecl[] = [];
  const walk = (widgets: FormWidget[]): void => {
    for (const w of widgets) {
      if (w.name) {
        if ("options" in w && w.options && !Array.isArray(w.options)) {
          out.push({ name: w.name, widgetType: w.type, source: { kind: "options", range: w.options.range } });
        }
        if (w.type === "table" && !Array.isArray(w.rows)) {
          out.push({ name: w.name, widgetType: w.type, source: { kind: "rows", range: w.rows.range } });
        }
        if (w.type === "image" && w.src.length > 0) {
          out.push({ name: w.name, widgetType: w.type, source: { kind: "image", src: w.src } });
        }
      }
      if ("children" in w && Array.isArray(w.children)) walk(w.children);
      if (w.type === "tabs") for (const page of w.pages) walk(page.children);
    }
  };
  walk(spec.children);
  return out;
}

/** A range source ("A2:A20", "Sheet2!A2:B9") as a sheet name plus a box. */
export function parseFormRange(range: string): {
  sheetName: string | null;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
} {
  const { sheetName, rest } = splitSheetPrefix(range.trim());
  const box = parseA1Body(rest);
  return { sheetName, ...box };
}

/** Choice list from a read rectangle: every non-empty cell's text, in reading order, deduplicated. */
export function optionsFromCells(cells: ScriptCell[][]): FormOption[] {
  const seen = new Set<string>();
  const out: FormOption[] = [];
  for (const row of cells) {
    for (const cell of row) {
      const text = cell.display !== "" ? cell.display : cell.value === null ? "" : String(cell.value);
      if (text === "" || seen.has(text)) continue;
      seen.add(text);
      out.push({ value: text, label: text });
      // THE SAME CAP AS AN INLINE LIST. A `{ range }` list is read through the
      // script's range row, whose own bound is MAX_RANGE_CELLS (100,000) — two
      // hundred times the cap on a list written out in the layout. Without this
      // the caps in the spec validator meant nothing: `options: { range:
      // "A1:A100000" }` produced a dropdown with a hundred thousand entries and
      // the host painted every one of them.
      if (out.length >= MAX_FORM_OPTIONS) return out;
    }
  }
  return out;
}

/**
 * Table rows from a read rectangle: typed values where the cell has one, else
 * its text. Clamped to the same cell budget an inline `rows` array gets, for
 * the reason above — the range read's own bound is far larger.
 */
export function rowsFromCells(cells: ScriptCell[][]): FormValue[][] {
  const width = Math.max(1, cells[0]?.length ?? 1);
  const maxRows = Math.max(1, Math.floor(MAX_FORM_TABLE_CELLS / width));
  return cells
    .slice(0, maxRows)
    .map((row) =>
      row.map((cell) => (cell.value !== null && typeof cell.value !== "string" ? cell.value : cell.display || cell.value)),
    );
}

export type ParsedFormBinding =
  /**
   * `sheetRef` is a NAME or a 0-based INDEX, exactly what `resolveSheetRefIn`
   * accepts, and null for "the sheet the form was shown on". It used to be a
   * string, so the documented `{ cell: "B2", sheet: 1 }` was stringified to
   * "1" and resolved as a sheet NAMED "1" — never found, and the widget opened
   * disabled saying so.
   */
  | { kind: "cell"; sheetRef: string | number | null; row: number; col: number }
  | { kind: "name"; name: string }
  | { kind: "control"; name: string };

/** A defined name: letters, digits, underscore, period, backslash; not A1-shaped. */
const DEFINED_NAME_RE = /^[A-Za-z_\\][A-Za-z0-9_.\\]*$/;

/**
 * Parse a widget's `bind`. A bare string is tried as a single-cell A1 address
 * first ("B2", "Sheet1!B2", "'My sheet'!B2"); what does not parse as one is a
 * defined name. Throws (with a message the widget's `reason` can carry) for a
 * rectangle — an input widget binds ONE cell — or for a string that is neither.
 */
export function parseFormBinding(bind: FormBinding): ParsedFormBinding {
  if (typeof bind === "string") {
    const text = bind.trim();
    if (text.length === 0) throw new Error("bind is empty");
    const { sheetName, rest } = splitSheetPrefix(text);
    const asCell = tryParseSingleCell(rest);
    if (asCell) return { kind: "cell", sheetRef: sheetName, row: asCell.row, col: asCell.col };
    if (sheetName !== null) {
      throw new Error(`"${text}" is not a single cell address`);
    }
    if (DEFINED_NAME_RE.test(text)) return { kind: "name", name: text };
    throw new Error(`"${text}" is neither a cell address nor a defined name`);
  }
  if ("cell" in bind) {
    const { sheetName, rest } = splitSheetPrefix(bind.cell);
    const asCell = tryParseSingleCell(rest);
    if (!asCell) throw new Error(`"${bind.cell}" is not a single cell address`);
    // A number stays a NUMBER: the host's one sheet resolver reads a number as
    // an index and a string as a name, and stringifying here made every
    // numeric `sheet` unresolvable.
    const explicit = bind.sheet;
    return {
      kind: "cell",
      sheetRef: explicit !== undefined ? explicit : sheetName,
      row: asCell.row,
      col: asCell.col,
    };
  }
  if ("name" in bind) {
    if (!DEFINED_NAME_RE.test(bind.name)) throw new Error(`"${bind.name}" is not a defined name`);
    return { kind: "name", name: bind.name };
  }
  return { kind: "control", name: bind.control };
}

function tryParseSingleCell(body: string): { row: number; col: number } | null {
  if (!/^\$?[A-Za-z]{1,3}\$?\d{1,7}$/.test(body.trim())) return null;
  try {
    const box = parseA1Body(body);
    if (box.startRow !== box.endRow || box.startCol !== box.endCol) return null;
    return { row: box.startRow, col: box.startCol };
  } catch {
    return null;
  }
}

// ============================================================================
// What a raw value MEANS for a widget (one rule, both realms)
// ============================================================================

/** Text view: null/undefined -> "", arrays joined, booleans Excel-style. */
function asFormText(value: FormValue | string[] | undefined): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

/** Boolean view: true / non-zero / "true" / "1" are on. */
function asFormBool(value: FormValue | string[] | undefined): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const t = value.trim().toUpperCase();
    return t === "TRUE" || t === "1";
  }
  return false;
}

/** List view: arrays of strings as-is, a non-blank scalar as a one-item list. */
function asFormList(value: FormValue | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  const text = asFormText(value);
  return text === "" ? [] : [text];
}

/**
 * What a raw value means for a widget of this type — THE one rule.
 *
 * The renderer and this host both hold a copy of every widget's value, and
 * every place they disagreed about a value's SHAPE produced a defect: a
 * single-select listbox seeded as a list looked edited and truncated its cell;
 * `show({ initial: { qty: "10" } })` compared "10" against 10 and wrote an
 * untouched widget; a script's `set("7")` left the mirror holding a string
 * while the widget held 7. So the renderer's `coerceValue` delegates here
 * rather than keeping a second copy, and the host coerces script-driven patch
 * values with the same call.
 */
export function coerceFormValue(
  widgetType: string,
  multi: boolean,
  raw: FormValue | string[] | undefined,
): FormValue | string[] {
  switch (widgetType) {
    case "textbox":
      return asFormText(raw);
    case "number": {
      if (raw === null || raw === undefined) return null;
      if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
      if (typeof raw === "boolean") return raw ? 1 : 0;
      if (Array.isArray(raw)) return null;
      const t = raw.trim();
      if (t === "") return null;
      const n = Number(t);
      // Text that is not a number is KEPT, so the validator can name the
      // problem instead of silently blanking what the user typed.
      return Number.isFinite(n) ? n : raw;
    }
    case "date": {
      if (typeof raw === "string") return raw;
      if (typeof raw === "number") return serialToIsoDate(raw);
      return "";
    }
    case "checkbox":
    case "toggle":
      return asFormBool(raw);
    case "radio":
    case "dropdown":
      return Array.isArray(raw) ? raw[0] ?? "" : asFormText(raw);
    case "listbox":
      if (multi) return asFormList(raw);
      return Array.isArray(raw) ? raw[0] ?? "" : asFormText(raw);
    default:
      return raw ?? null;
  }
}

// ============================================================================
// Cell -> widget (what the user sees and edits)
// ============================================================================

/** Excel's serial epoch (day 0 = 1899-12-30, the 1900 leap-year fiction folded in). */
const SERIAL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);

/** A date serial as the ISO date a `<input type=date>` edits. */
export function serialToIsoDate(serial: number): string {
  const ms = SERIAL_EPOCH_UTC_MS + Math.floor(serial) * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * What a widget starts with, from the cell it is bound to. `value` is TYPED
 * per widget (the thing the widget edits and the host writes back); `display`
 * is the formatted text the grid shows (painted while the widget is
 * unfocused); `formula` is kept so a formula cell is shown, never rewritten
 * unless the user actually edits the widget.
 */
export function seedFromCell(widgetType: string, cell: ScriptCell, multi = false): FormSeed {
  const seed: FormSeed = { value: null, display: cell.display };
  if (cell.formula) seed.formula = cell.formula;
  const v = cell.value;
  // A single-select listbox holds ONE answer, exactly like a dropdown, and the
  // renderer coerces it to one string. Seeding it as a list made an untouched
  // widget look edited and truncated the cell on submit.
  if (widgetType === "listbox" && !multi) return seedFromCell("dropdown", cell);
  switch (widgetType) {
    case "number":
      seed.value = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
      break;
    case "checkbox":
    case "toggle":
      seed.value =
        typeof v === "boolean" ? v : typeof v === "number" ? v !== 0 : typeof v === "string" ? /^(true|1|yes)$/i.test(v.trim()) : false;
      break;
    case "date":
      seed.value = typeof v === "number" ? serialToIsoDate(v) : typeof v === "string" ? v : null;
      break;
    case "listbox":
      seed.value =
        typeof v === "string" && v.length > 0 ? v.split(",").map((s) => s.trim()).filter(Boolean) : v === null ? [] : [String(v)];
      break;
    case "textbox":
      // THE EDIT VALUE, NEVER THE DISPLAY. A textbox is a free-text editor:
      // whatever it holds is what gets written back. Seeding it with the
      // grid's formatted text meant a textbox bound to a currency-formatted
      // 1234.5 opened holding "£1,234.50", and one keystroke wrote that string
      // through the entry ladder — which refuses currency text and stores it
      // as TEXT (core/engine/src/number_text.rs), turning a number cell into a
      // string and breaking every formula that referenced it.
      //
      // The formatted text is not lost: it travels as `seed.display` and the
      // renderer paints it while the widget is unfocused and untouched
      // (`useShownText`, FormWidgetTree.tsx). This is the formula bar's rule.
      seed.value = typeof v === "string" ? v : v === null ? "" : String(v);
      break;
    default:
      // dropdown / radio: a choice is matched against option TEXT, and options
      // read from a range are built from each cell's display
      // (`optionsFromCells`). Seeding these from the display is what makes a
      // seeded selection match an option at all.
      seed.value = typeof v === "string" ? v : v === null ? "" : cell.display;
      break;
  }
  return seed;
}

/** A Controls-pane value as a widget seed (read-only binding). */
export function seedFromControlValue(
  widgetType: string,
  cv: ControlValue | null | undefined,
  multi = false,
): FormSeed {
  if (!cv) return { value: null, readOnly: true, reason: "no control by that name" };
  const value: FormValue | string[] =
    cv.kind === "textList" ? [...cv.value] : cv.kind === "boolean" ? cv.value : cv.kind === "number" ? cv.value : cv.value;
  const seed: FormSeed = { value, readOnly: true, reason: "a control value can be read, not written" };
  // Same shape rule as seedFromCell: only a MULTI listbox holds a list.
  const wantsList = widgetType === "listbox" && multi;
  if (wantsList && !Array.isArray(value)) seed.value = value === null ? [] : [String(value)];
  if (!wantsList && Array.isArray(value)) seed.value = value.join(", ");
  return seed;
}

// ============================================================================
// Widget -> cell (what the host writes)
// ============================================================================

/**
 * The write the executor receives for a widget's answer: the typed value (the
 * executor's scriptCellInput sends numbers/booleans invariant), the user's
 * formula text when they typed one, an ISO date string (the entry ladder
 * accepts year-first dates on every locale), a listbox joined with ", ", or
 * null to clear. NEVER the display string.
 */
export function cellWriteFor(widgetType: string, value: FormValue | string[]): string | number | boolean | null {
  if (Array.isArray(value)) return value.length === 0 ? null : value.join(", ");
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.startsWith("=")) return value;
  switch (widgetType) {
    case "number":
      return typeof value === "number" ? value : value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : String(value);
    case "checkbox":
    case "toggle":
      return value === true || value === "true";
    default:
      return typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : value;
  }
}

/** True when the widget's current value differs from what it was seeded with. */
export function isDirty(seed: FormSeed | undefined, value: FormValue | string[] | undefined): boolean {
  if (!seed) return value !== undefined && value !== null && value !== "";
  const a = seed.value;
  const b = value;
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = Array.isArray(a) ? a : a === null || a === undefined ? [] : [String(a)];
    const y = Array.isArray(b) ? b : b === null || b === undefined ? [] : [String(b)];
    return x.length !== y.length || x.some((v, i) => v !== y[i]);
  }
  // "" and null both mean "nothing entered"; only a real value on one side
  // and nothing on the other is a change.
  const aEmpty = a === null || a === undefined || a === "";
  const bEmpty = b === null || b === undefined || b === "";
  if (aEmpty || bEmpty) return aEmpty !== bEmpty;
  // Number vs its own text is the SAME answer, whichever side holds which.
  // Only one direction was covered, and the other one bites through
  // `show({ initial: { qty: "10" } })`: the seed keeps the script's string
  // while the renderer coerces the widget to the number 10, so an untouched
  // widget compared "10" against 10, counted as edited, and the submit wrote
  // it into the bound cell — over a formula, if that is what the cell held.
  if (typeof a === "number" && typeof b === "string") return Number(b) !== a;
  if (typeof a === "string" && typeof b === "number") return Number(a) !== b;
  return a !== b;
}

/**
 * Why the bound cells can no longer be written, or null when they can.
 *
 * THE SHEET LIST CAN MOVE UNDER AN OPEN FORM. The modal blocks the user, not
 * other scripts: a scheduled job or an MCP tool can delete or reorder sheets
 * while it is up, and every binding was resolved to an INDEX at show. Writing
 * that index afterwards puts the user's answers on whatever sheet now occupies
 * it — on the restricted tier too, where the pin is an index and the executor
 * writes the active sheet.
 *
 * Refused, never re-aimed: once the list has changed under the user, which
 * sheet they meant is not recoverable, and a wrong guess writes real data into
 * the wrong place.
 */
export function sheetIdentityRefusal(
  cells: ReadonlyArray<{ name: string; sheetIndex: number; sheetName: string | undefined }>,
  pinned: { index: number; name: string } | null,
  sheets: ReadonlyArray<{ index: number; name: string }>,
  surface: "form" | "pane" = "form",
): string | null {
  const nameAt = (index: number): string | undefined => sheets.find((s) => s.index === index)?.name;
  if (pinned !== null && nameAt(pinned.index) !== pinned.name) {
    return (
      `"${pinned.name}" is no longer where this ${surface} opened (the workbook's sheets changed) — ` +
      `close the ${surface} and open it again`
    );
  }
  for (const cell of cells) {
    if (cell.sheetName === undefined) continue;
    const now = nameAt(cell.sheetIndex);
    if (now === cell.sheetName) continue;
    return (
      `"${cell.name}" was read from "${cell.sheetName}", which has moved or been removed ` +
      `(that position now holds ${now === undefined ? "no sheet" : `"${now}"`}) — ` +
      `close the ${surface} and open it again`
    );
  }
  return null;
}

/** Names whose value differs from the seed — the only widgets ever written. */
export function dirtyNames(
  values: Record<string, FormValue | string[]>,
  seeds: Record<string, FormSeed>,
  candidates: readonly string[],
): string[] {
  return candidates.filter((name) => isDirty(seeds[name], values[name]));
}
