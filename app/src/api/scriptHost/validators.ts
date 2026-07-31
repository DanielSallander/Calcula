//! FILENAME: app/src/api/scriptHost/validators.ts
// PURPOSE: Static argument validators for broker-mediated script calls.
// CONTEXT: Run BEFORE the tier check (design §5: error messages must not
//          probe policy). Each returns `true` or a human-readable reason.
//          Validators are shape/sanity checks only — they never consult
//          state, so they are safe to run for any caller.

import { SCRIPT_OBJECT_KINDS } from "./objectInventory";
import {
  PIVOT_AGGREGATIONS,
  PIVOT_AREAS,
  PIVOT_LAYOUT_DIRECTIVES,
} from "./pivotLayoutVocabulary";
import {
  DIALOG_FIELD_NAME_RE,
  DIALOG_FIELD_TYPE_SET,
  DIALOG_FIELD_TYPES,
  MAX_DIALOG_FIELDS,
  MAX_DIALOG_FIELD_LABEL,
  MAX_DIALOG_FIELD_NAME,
  MAX_DIALOG_LABEL,
  MAX_DIALOG_MESSAGE,
  MAX_DIALOG_OPTIONS,
  MAX_DIALOG_OPTION_TEXT,
  MAX_DIALOG_TITLE,
  RESERVED_DIALOG_FIELD_NAMES,
} from "./scriptDialogSpec";

export type Validator = (args: unknown[]) => true | string;

const MAX_STRING = 1_000_000; // 1 MB of text per string argument
const MAX_EVENT_NAME = 256;
const MAX_KEY = 512;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isCellCoord(v: unknown): boolean {
  return isFiniteNumber(v) && v >= 0 && v <= 10_000_000 && Number.isInteger(v);
}

function isBoundedString(v: unknown, max = MAX_STRING): v is string {
  return typeof v === "string" && v.length <= max;
}

export const vNone: Validator = (args) =>
  args.length === 0 || "expected no arguments";

export const vAny: Validator = () => true;

export const vNotify: Validator = ([message, type]) => {
  if (!isBoundedString(message, 2000)) return "message must be a string (max 2000 chars)";
  if (type !== undefined && !["info", "success", "warning", "error"].includes(type as string)) {
    return "type must be info|success|warning|error";
  }
  return true;
};

/** base.unexpose: just the method name that base.expose registered. */
export const vUnexpose: Validator = ([name]) => {
  if (!isBoundedString(name, MAX_KEY) || (name as string).length === 0) {
    return "method name must be a non-empty string";
  }
  return true;
};

export const vExpose: Validator = ([name, isPublic]) => {
  // Worker-realm protocol: the handler stays in the worker realm (rt.exposed);
  // only [name, isPublic] cross the RPC boundary (host's base.expose executor
  // reads the same shape). A function can't be structured-cloned, so it is
  // never sent here.
  if (!isBoundedString(name, MAX_KEY) || (name as string).length === 0) {
    return "method name must be a non-empty string";
  }
  if (isPublic !== undefined && typeof isPublic !== "boolean") {
    return "public flag must be a boolean";
  }
  return true;
};

export const vCall: Validator = ([targetType, targetInstanceId, methodName]) => {
  if (!isBoundedString(targetType, MAX_KEY)) return "targetType must be a string";
  if (targetInstanceId !== null && !isBoundedString(targetInstanceId, MAX_KEY)) {
    return "targetInstanceId must be a string or null";
  }
  if (!isBoundedString(methodName, MAX_KEY) || (methodName as string).length === 0) {
    return "methodName must be a non-empty string";
  }
  return true;
};

export const vHook: Validator = ([name]) =>
  isBoundedString(name, MAX_EVENT_NAME) && (name as string).length > 0
    ? true
    : "event name must be a non-empty string";

export const vGetState: Validator = () => true;
/** Cheap broker-side pre-filter for object.setState. Most aspects are validated
 *  by their own store impl; chart spec writes additionally get a shape+size gate
 *  here (runs BEFORE the tier check, no state reads) so an oversized / non-object
 *  spec is rejected uniformly before reaching the extension's schema validator. */
export const vSetState: Validator = ([aspect, aspectArgs]) => {
  if (aspect === "table.setRangeFormat") {
    // The format object gets the SAME enumerated gate as the range-scoped
    // methods — an own-object aspect must not be the lax way in.
    if (!Array.isArray(aspectArgs) || aspectArgs.length < 5) {
      return "expected [startRow, startCol, endRow, endCol, format]";
    }
    return checkFormatObject(aspectArgs[4]);
  }
  if (aspect === "chart.updateSpec" || aspect === "chart.replaceSpec") {
    return checkChartSpec(aspectArgs);
  }
  // Pivot layout mutation (B3): the field/area/aggregation vocabulary is the
  // Pivot Layout DSL's, checked here so a typo ("Rows", "avg") fails with the
  // accepted list instead of reaching the backend as a silent no-op.
  if (PIVOT_LAYOUT_ASPECTS.has(aspect as string)) {
    return checkPivotLayoutAspect(aspect as string, aspectArgs);
  }
  return true;
};
export const vDecl: Validator = ([decls]) =>
  typeof decls === "object" && decls !== null ? true : "expected a declarations object";

export const vHtml: Validator = ([html]) =>
  isBoundedString(html, 5_000_000) ? true : "html must be a string (max 5 MB)";

export const vCellRef: Validator = ([row, col, sheetIndex]) => {
  if (!isCellCoord(row)) return "row must be a non-negative integer";
  if (!isCellCoord(col)) return "col must be a non-negative integer";
  if (sheetIndex !== undefined && !isCellCoord(sheetIndex)) {
    return "sheetIndex must be a non-negative integer";
  }
  return true;
};

export const vCellSet: Validator = ([row, col, value, sheetIndex]) => {
  if (!isCellCoord(row)) return "row must be a non-negative integer";
  if (!isCellCoord(col)) return "col must be a non-negative integer";
  if (!isBoundedString(value)) return "value must be a string (max 1 MB)";
  if (sheetIndex !== undefined && !isCellCoord(sheetIndex)) {
    return "sheetIndex must be a non-negative integer";
  }
  return true;
};

export const vBatch: Validator = ([updates]) => {
  if (!Array.isArray(updates)) return "updates must be an array";
  for (const u of updates) {
    if (typeof u !== "object" || u === null) return "each update must be an object";
    const { row, col, value } = u as { row?: unknown; col?: unknown; value?: unknown };
    if (!isCellCoord(row)) return "each update.row must be a non-negative integer";
    if (!isCellCoord(col)) return "each update.col must be a non-negative integer";
    if (!isBoundedString(value)) return "each update.value must be a string (max 1 MB)";
  }
  return true;
};

/**
 * Ceiling for ONE bulk range call (read or write). Mirrors the
 * api.updateCellsBatch limit so a script's bulk read and bulk write share one
 * number. Enforced HERE (before the tier check) and again host-side.
 */
export const MAX_RANGE_CELLS = 100_000;

/** Bulk range READ args: [startRow, startCol, endRow, endCol, sheetIndex?]. */
export const vRangeRef: Validator = ([startRow, startCol, endRow, endCol, sheetIndex]) => {
  if (!isCellCoord(startRow)) return "startRow must be a non-negative integer";
  if (!isCellCoord(startCol)) return "startCol must be a non-negative integer";
  if (!isCellCoord(endRow)) return "endRow must be a non-negative integer";
  if (!isCellCoord(endCol)) return "endCol must be a non-negative integer";
  if ((endRow as number) < (startRow as number)) return "endRow must be >= startRow";
  if ((endCol as number) < (startCol as number)) return "endCol must be >= startCol";
  const cells =
    ((endRow as number) - (startRow as number) + 1) *
    ((endCol as number) - (startCol as number) + 1);
  if (cells > MAX_RANGE_CELLS) return `range too large: ${cells} cells (max ${MAX_RANGE_CELLS})`;
  if (sheetIndex !== undefined && sheetIndex !== null && !isCellCoord(sheetIndex)) {
    return "sheetIndex must be a non-negative integer";
  }
  return true;
};

/** Bulk range WRITE args: [startRow, startCol, values, sheetIndex?]. `values` is
 *  a rows x cols grid of strings anchored at (startRow, startCol); a hole
 *  (undefined / null entry) leaves that cell untouched. */
export const vRangeWrite: Validator = ([startRow, startCol, values, sheetIndex]) => {
  if (!isCellCoord(startRow)) return "startRow must be a non-negative integer";
  if (!isCellCoord(startCol)) return "startCol must be a non-negative integer";
  if (!Array.isArray(values)) return "values must be a 2D array";
  let cells = 0;
  for (const row of values) {
    if (!Array.isArray(row)) return "each values row must be an array";
    cells += row.length;
    if (cells > MAX_RANGE_CELLS) return `range too large: over ${MAX_RANGE_CELLS} cells`;
    for (const v of row) {
      if (v === undefined || v === null) continue;
      if (!isBoundedString(v)) return "each value must be a string (max 1 MB)";
    }
  }
  if (sheetIndex !== undefined && sheetIndex !== null && !isCellCoord(sheetIndex)) {
    return "sheetIndex must be a non-negative integer";
  }
  return true;
};

// ============================================================================
// Formatting (B2)
// ============================================================================
// The format object is validated by ENUMERATION, not by "strip what I know":
// an unknown key is REJECTED with the list of accepted ones. A silently ignored
// `bgColor` typo would leave a script author staring at an unchanged grid with
// no error to search for — and a permissive object is also the classic way a
// privileged field (locked / formulaHidden) sneaks into a formatting call.
//
// PROTECTION ATTRIBUTES ARE DELIBERATELY ABSENT. The backend FormattingParams
// also carries `locked` / `formulaHidden` (and the checkbox/button cell-control
// flags). Those are protection + cell-behavior surfaces with their own
// governance; formatting is not the door to them.

/** Excel's underline styles (mirrors core UnderlineStyle). */
const UNDERLINE_STYLES = new Set([
  "none", "single", "double", "singleAccounting", "doubleAccounting",
]);
const TEXT_ALIGNS = new Set(["left", "center", "right", "general"]);
const VERTICAL_ALIGNS = new Set(["top", "middle", "bottom"]);
const TEXT_ROTATIONS = new Set(["none", "rotate90", "rotate270"]);
/** Border line styles the backend's parse_border_side understands. */
const BORDER_STYLES = new Set(["none", "thin", "medium", "thick", "dashed", "dotted", "double"]);

const BORDER_KEYS = [
  "borderTop", "borderRight", "borderBottom", "borderLeft",
  "borderDiagonalDown", "borderDiagonalUp",
] as const;

/**
 * Every key `setRangeFormat` accepts, with its shape. Exported so the tests and
 * the scaffold/docs surface enumerate the SAME set the broker enforces.
 */
export const SCRIPT_FORMAT_KEYS: ReadonlySet<string> = new Set([
  "bold", "italic", "underline", "strikethrough",
  "fontSize", "fontFamily", "textColor", "backgroundColor",
  "textAlign", "verticalAlign", "numberFormat",
  "wrapText", "textRotation", "indent", "shrinkToFit",
  ...BORDER_KEYS,
]);

/** `#RRGGBB` or `#RRGGBBAA` (the `#` is optional — Rust's Color::from_hex trims it). */
function isHexColor(v: unknown): boolean {
  return typeof v === "string" && /^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v);
}

function checkBorderSide(key: string, v: unknown): true | string {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return `${key} must be an object { style, color }`;
  }
  const side = v as Record<string, unknown>;
  for (const k of Object.keys(side)) {
    if (k !== "style" && k !== "color") return `${key}.${k} is not a border property (use style, color)`;
  }
  if (!BORDER_STYLES.has(side.style as string)) {
    return `${key}.style must be one of: ${[...BORDER_STYLES].join(", ")}`;
  }
  if (!isHexColor(side.color)) return `${key}.color must be a hex color like "#000000"`;
  return true;
}

/**
 * Validate a partial format object. Only the properties present are changed —
 * an absent key leaves that attribute alone, so a script can bold a range
 * without resetting its font or number format.
 */
export function checkFormatObject(format: unknown): true | string {
  if (typeof format !== "object" || format === null || Array.isArray(format)) {
    return "format must be an object";
  }
  const f = format as Record<string, unknown>;
  const keys = Object.keys(f);
  if (keys.length === 0) {
    return `format must set at least one property (one of: ${[...SCRIPT_FORMAT_KEYS].join(", ")})`;
  }
  for (const key of keys) {
    const value = f[key];
    if (!SCRIPT_FORMAT_KEYS.has(key)) {
      return `unknown format property "${key}" (allowed: ${[...SCRIPT_FORMAT_KEYS].join(", ")})`;
    }
    if (value === undefined) continue; // explicit undefined = "leave alone"
    switch (key) {
      case "bold":
      case "italic":
      case "strikethrough":
      case "wrapText":
      case "shrinkToFit":
        if (typeof value !== "boolean") return `${key} must be a boolean`;
        break;
      case "underline":
        if (!UNDERLINE_STYLES.has(value as string)) {
          return `underline must be one of: ${[...UNDERLINE_STYLES].join(", ")}`;
        }
        break;
      case "textAlign":
        if (!TEXT_ALIGNS.has(value as string)) {
          return `textAlign must be one of: ${[...TEXT_ALIGNS].join(", ")}`;
        }
        break;
      case "verticalAlign":
        if (!VERTICAL_ALIGNS.has(value as string)) {
          return `verticalAlign must be one of: ${[...VERTICAL_ALIGNS].join(", ")}`;
        }
        break;
      case "textRotation":
        if (!TEXT_ROTATIONS.has(value as string)) {
          return `textRotation must be one of: ${[...TEXT_ROTATIONS].join(", ")}`;
        }
        break;
      case "fontSize":
        // Excel's font-size range, in POINTS (the app's font unit).
        if (!isFiniteNumber(value) || value < 1 || value > 409) {
          return "fontSize must be a number between 1 and 409 (points)";
        }
        break;
      case "indent":
        if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 0 || value > 250) {
          return "indent must be an integer between 0 and 250";
        }
        break;
      case "fontFamily":
        if (!isBoundedString(value, 128) || value.length === 0) {
          return "fontFamily must be a non-empty string (max 128 chars)";
        }
        break;
      case "numberFormat":
        if (!isBoundedString(value, 512)) return "numberFormat must be a string (max 512 chars)";
        break;
      case "textColor":
      case "backgroundColor":
        if (!isHexColor(value)) return `${key} must be a hex color like "#RRGGBB"`;
        break;
      default: {
        // The only keys left are the six border sides.
        const verdict = checkBorderSide(key, value);
        if (verdict !== true) return verdict;
      }
    }
  }
  return true;
}

/** setRangeFormat args: [startRow, startCol, endRow, endCol, format, sheetIndex?]. */
export const vRangeFormat: Validator = ([startRow, startCol, endRow, endCol, format, sheetIndex]) => {
  const rect = vRangeRef([startRow, startCol, endRow, endCol, sheetIndex]);
  if (rect !== true) return rect;
  return checkFormatObject(format);
};

// ============================================================================
// Structural operations (B2)
// ============================================================================

/** The most rows/columns one insert/delete call may move. */
export const MAX_STRUCTURAL_COUNT = 1_000_000;

/** insertRows / deleteRows / insertColumns / deleteColumns args:
 *  [start, count, sheetIndex?]. */
export const vRowColOp: Validator = ([start, count, sheetIndex]) => {
  if (!isCellCoord(start)) return "start must be a non-negative integer";
  if (!isFiniteNumber(count) || !Number.isInteger(count) || count < 1) {
    return "count must be an integer >= 1";
  }
  if (count > MAX_STRUCTURAL_COUNT) {
    return `count too large: ${count} (max ${MAX_STRUCTURAL_COUNT})`;
  }
  if (sheetIndex !== undefined && sheetIndex !== null && !isCellCoord(sheetIndex)) {
    return "sheetIndex must be a non-negative integer";
  }
  return true;
};

/** setRowHeight / setColumnWidth args: [index, size, sheetIndex?]. `size` is in
 *  pixels; 0 clears the override and restores the sheet default. */
export const vDimension: Validator = ([index, size, sheetIndex]) => {
  if (!isCellCoord(index)) return "index must be a non-negative integer";
  if (!isFiniteNumber(size) || size < 0 || size > 4096) {
    return "size must be a number between 0 and 4096 pixels (0 restores the default)";
  }
  if (sheetIndex !== undefined && sheetIndex !== null && !isCellCoord(sheetIndex)) {
    return "sheetIndex must be a non-negative integer";
  }
  return true;
};

/** freezePanes args: [freezeRow, freezeCol]. null on a bound = not frozen. */
export const vFreeze: Validator = ([freezeRow, freezeCol]) => {
  for (const [name, v] of [["freezeRow", freezeRow], ["freezeCol", freezeCol]] as const) {
    if (v === null || v === undefined) continue;
    if (!isCellCoord(v)) return `${name} must be a non-negative integer or null`;
  }
  return true;
};

// ============================================================================
// Sheet CRUD (B2)
// ============================================================================

const MAX_SHEET_NAME = 255;
/** Excel's forbidden sheet-name characters (plus a leading/trailing apostrophe). */
const ILLEGAL_SHEET_NAME_CHARS = /[:\\/?*[\]]/;

function checkSheetName(name: unknown): true | string {
  if (!isBoundedString(name, MAX_SHEET_NAME) || name.trim().length === 0) {
    return `sheet name must be a non-empty string (max ${MAX_SHEET_NAME} chars)`;
  }
  if (ILLEGAL_SHEET_NAME_CHARS.test(name)) {
    return "sheet name may not contain : \\ / ? * [ ]";
  }
  return true;
}

/** addSheet args: [name?]. Omitted name = the app's next default ("Sheet3"). */
export const vSheetName: Validator = ([name]) => {
  if (name === undefined || name === null) return true;
  return checkSheetName(name);
};

/** renameSheet args: [index, newName]. */
export const vSheetRename: Validator = ([index, newName]) => {
  if (!isCellCoord(index)) return "index must be a non-negative integer";
  return checkSheetName(newName);
};

/** setSheetVisibility args: [index, visibility]. */
export const vSheetVisibility: Validator = ([index, visibility]) => {
  if (!isCellCoord(index)) return "index must be a non-negative integer";
  if (!["visible", "hidden", "veryHidden"].includes(visibility as string)) {
    return "visibility must be visible|hidden|veryHidden";
  }
  return true;
};

// ============================================================================
// Sort + find/replace (B2)
// ============================================================================

const MAX_SORT_FIELDS = 64;
const SORT_ON = new Set(["value", "cellColor", "fontColor", "icon"]);
const SORT_DATA_OPTIONS = new Set(["normal", "textAsNumber"]);
const SORT_ORIENTATIONS = new Set(["rows", "columns"]);

/** sortRange args: [startRow, startCol, endRow, endCol, fields, options?, sheetIndex?]. */
export const vSortRange: Validator = ([startRow, startCol, endRow, endCol, fields, options, sheetIndex]) => {
  const rect = vRangeRef([startRow, startCol, endRow, endCol, sheetIndex]);
  if (rect !== true) return rect;
  if (!Array.isArray(fields) || fields.length === 0 || fields.length > MAX_SORT_FIELDS) {
    return `fields must be a non-empty array (max ${MAX_SORT_FIELDS})`;
  }
  for (const f of fields) {
    if (typeof f !== "object" || f === null || Array.isArray(f)) {
      return "each sort field must be an object { key, ascending?, sortOn?, color?, dataOption?, customOrder? }";
    }
    const field = f as Record<string, unknown>;
    for (const k of Object.keys(field)) {
      if (!["key", "ascending", "sortOn", "color", "dataOption", "subField", "customOrder"].includes(k)) {
        return `unknown sort-field property "${k}"`;
      }
    }
    if (!isFiniteNumber(field.key) || !Number.isInteger(field.key) || field.key < 0) {
      return "sort field key must be a non-negative integer offset from the range start";
    }
    if (field.ascending !== undefined && typeof field.ascending !== "boolean") {
      return "sort field ascending must be a boolean";
    }
    if (field.sortOn !== undefined && !SORT_ON.has(field.sortOn as string)) {
      return `sort field sortOn must be one of: ${[...SORT_ON].join(", ")}`;
    }
    if (field.color !== undefined && !isHexColor(field.color)) {
      return "sort field color must be a hex color like \"#RRGGBB\"";
    }
    if (field.dataOption !== undefined && !SORT_DATA_OPTIONS.has(field.dataOption as string)) {
      return `sort field dataOption must be one of: ${[...SORT_DATA_OPTIONS].join(", ")}`;
    }
    if (field.subField !== undefined && !isBoundedString(field.subField, MAX_KEY)) {
      return "sort field subField must be a string";
    }
    if (field.customOrder !== undefined && !isBoundedString(field.customOrder, 8192)) {
      return "sort field customOrder must be a string";
    }
  }
  if (options !== undefined && options !== null) {
    if (typeof options !== "object" || Array.isArray(options)) return "options must be an object";
    const o = options as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (!["matchCase", "hasHeaders", "orientation"].includes(k)) {
        return `unknown sort option "${k}" (allowed: matchCase, hasHeaders, orientation)`;
      }
    }
    if (o.matchCase !== undefined && typeof o.matchCase !== "boolean") return "matchCase must be a boolean";
    if (o.hasHeaders !== undefined && typeof o.hasHeaders !== "boolean") return "hasHeaders must be a boolean";
    if (o.orientation !== undefined && !SORT_ORIENTATIONS.has(o.orientation as string)) {
      return `orientation must be one of: ${[...SORT_ORIENTATIONS].join(", ")}`;
    }
  }
  return true;
};

const MAX_SEARCH_TEXT = 8192;

function checkFindOptions(options: unknown, allowed: string[]): true | string {
  if (options === undefined || options === null) return true;
  if (typeof options !== "object" || Array.isArray(options)) return "options must be an object";
  const o = options as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) return `unknown search option "${k}" (allowed: ${allowed.join(", ")})`;
    if (o[k] !== undefined && typeof o[k] !== "boolean") return `${k} must be a boolean`;
  }
  return true;
}

/** findAll args: [query, options?]. */
export const vFind: Validator = ([query, options]) => {
  if (!isBoundedString(query, MAX_SEARCH_TEXT) || query.length === 0) {
    return `query must be a non-empty string (max ${MAX_SEARCH_TEXT} chars)`;
  }
  return checkFindOptions(options, ["caseSensitive", "matchEntireCell", "searchFormulas"]);
};

/** replaceAll args: [search, replacement, options?]. */
export const vReplace: Validator = ([search, replacement, options]) => {
  if (!isBoundedString(search, MAX_SEARCH_TEXT) || search.length === 0) {
    return `search must be a non-empty string (max ${MAX_SEARCH_TEXT} chars)`;
  }
  if (!isBoundedString(replacement, MAX_SEARCH_TEXT)) {
    return `replacement must be a string (max ${MAX_SEARCH_TEXT} chars)`;
  }
  return checkFindOptions(options, ["caseSensitive", "matchEntireCell"]);
};

// ============================================================================
// Workbook objects: enumeration, creation, deletion, cross-instance (B3)
// ============================================================================

/** The most objects one api.listObjects call may return. */
export const MAX_OBJECT_LIST = 5_000;
/** Longest object id / name a script may pass. */
const MAX_OBJECT_ID = 512;
const MAX_OBJECT_NAME = 255;

function isObjectId(v: unknown): v is string {
  return isBoundedString(v, MAX_OBJECT_ID) && v.trim().length > 0;
}

/** listObjects args: [kind]. */
export const vObjectKind: Validator = ([kind]) => {
  if (!isBoundedString(kind, 64) || !SCRIPT_OBJECT_KINDS.has(kind)) {
    return `kind must be one of: ${[...SCRIPT_OBJECT_KINDS].join(", ")}`;
  }
  return true;
};

/** Single-handle args: [id]. Used by every delete* method. */
export const vObjectId: Validator = ([id]) =>
  isObjectId(id) ? true : "id must be a non-empty string";

/**
 * Cross-instance state args: [objectType, targetId, aspect, aspectArgs].
 *
 * The aspect payload gets the EXACT same gate the own-object object.setState
 * path gets (vSetState) — addressing another instance must never be the lax way
 * into an aspect. The tier check that makes this unlocked-only happens in the
 * broker, after this.
 */
export const vObjectAspect: Validator = ([objectType, targetId, aspect, aspectArgs]) => {
  if (!isBoundedString(objectType, 64) || (objectType as string).length === 0) {
    return "objectType must be a non-empty string";
  }
  if (!isObjectId(targetId)) return "target id must be a non-empty string";
  if (!isBoundedString(aspect, MAX_KEY) || (aspect as string).length === 0) {
    return "aspect must be a non-empty string";
  }
  if (aspectArgs !== undefined && !Array.isArray(aspectArgs)) {
    return "aspect arguments must be an array";
  }
  return vSetState([aspect, aspectArgs ?? []]);
};

/** Shared chart-spec gate: shape + JSON-serializability + 2 MB ceiling. */
function checkChartSpec(aspectArgs: unknown): true | string {
  if (!Array.isArray(aspectArgs) || aspectArgs.length < 1) return "expected a spec argument";
  const spec = aspectArgs[0];
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) return "spec must be an object";
  let size = 0;
  try {
    size = JSON.stringify(spec).length;
  } catch {
    return "spec must be JSON-serializable";
  }
  if (size > 2_000_000) return "spec too large (max 2 MB)";
  return true;
}

/** createChart args: [spec, options?]. `options` places the new chart. */
export const vCreateChart: Validator = ([spec, options]) => {
  const shape = checkChartSpec([spec]);
  if (shape !== true) return shape;
  if (options === undefined || options === null) return true;
  if (typeof options !== "object" || Array.isArray(options)) return "options must be an object";
  const o = options as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!["name", "sheetIndex", "x", "y", "width", "height"].includes(k)) {
      return `unknown chart option "${k}" (allowed: name, sheetIndex, x, y, width, height)`;
    }
  }
  if (o.name !== undefined && !isBoundedString(o.name, MAX_OBJECT_NAME)) {
    return `name must be a string (max ${MAX_OBJECT_NAME} chars)`;
  }
  if (o.sheetIndex !== undefined && !isCellCoord(o.sheetIndex)) {
    return "sheetIndex must be a non-negative integer";
  }
  for (const k of ["x", "y"] as const) {
    if (o[k] !== undefined && (!isFiniteNumber(o[k]) || Math.abs(o[k] as number) > 1_000_000)) {
      return `${k} must be a number between -1000000 and 1000000 (pixels)`;
    }
  }
  for (const k of ["width", "height"] as const) {
    if (o[k] !== undefined && (!isFiniteNumber(o[k]) || (o[k] as number) < 10 || (o[k] as number) > 20_000)) {
      return `${k} must be a number between 10 and 20000 (pixels)`;
    }
  }
  return true;
};

/** createTable args: [startRow, startCol, endRow, endCol, options?]. */
export const vCreateTable: Validator = ([startRow, startCol, endRow, endCol, options]) => {
  const rect = vRangeRef([startRow, startCol, endRow, endCol]);
  if (rect !== true) return rect;
  if (options === undefined || options === null) return true;
  if (typeof options !== "object" || Array.isArray(options)) return "options must be an object";
  const o = options as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!["name", "hasHeaders"].includes(k)) {
      return `unknown table option "${k}" (allowed: name, hasHeaders)`;
    }
  }
  if (o.name !== undefined && !isBoundedString(o.name, MAX_OBJECT_NAME)) {
    return `name must be a string (max ${MAX_OBJECT_NAME} chars)`;
  }
  if (o.hasHeaders !== undefined && typeof o.hasHeaders !== "boolean") {
    return "hasHeaders must be a boolean";
  }
  return true;
};

/** Excel's forbidden characters in a defined name (plus whitespace). */
const ILLEGAL_NAME_CHARS = /[\s:\\/?*[\]()+\-,;<>=&^%$#@!~`'"{}|]/;

/** createNamedRange args: [name, refersTo, options?]. */
export const vCreateNamedRange: Validator = ([name, refersTo, options]) => {
  if (!isBoundedString(name, MAX_OBJECT_NAME) || (name as string).length === 0) {
    return `name must be a non-empty string (max ${MAX_OBJECT_NAME} chars)`;
  }
  if (ILLEGAL_NAME_CHARS.test(name as string)) {
    return "name may not contain spaces or punctuation (letters, digits, _ and . only)";
  }
  if (/^[0-9.]/.test(name as string)) return "name must start with a letter or underscore";
  if (!isBoundedString(refersTo, 8192) || (refersTo as string).length === 0) {
    return "refersTo must be a non-empty string (e.g. \"=Sheet1!$A$1:$B$10\")";
  }
  if (options === undefined || options === null) return true;
  if (typeof options !== "object" || Array.isArray(options)) return "options must be an object";
  const o = options as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!["sheetIndex", "comment"].includes(k)) {
      return `unknown named-range option "${k}" (allowed: sheetIndex, comment)`;
    }
  }
  if (o.sheetIndex !== undefined && o.sheetIndex !== null && !isCellCoord(o.sheetIndex)) {
    return "sheetIndex must be a non-negative integer or null (null = workbook scope)";
  }
  if (o.comment !== undefined && !isBoundedString(o.comment, 4096)) {
    return "comment must be a string (max 4096 chars)";
  }
  return true;
};

/** deleteNamedRange args: [name]. */
export const vNamedRangeName: Validator = ([name]) =>
  isBoundedString(name, MAX_OBJECT_NAME) && (name as string).length > 0
    ? true
    : "name must be a non-empty string";

const MAX_PIVOT_FIELDS = 128;

/** createPivot args: [sourceRange, destinationCell, fields, options?]. */
export const vCreatePivot: Validator = ([sourceRange, destinationCell, fields, options]) => {
  if (!isBoundedString(sourceRange, 512) || (sourceRange as string).length === 0) {
    return "sourceRange must be a non-empty A1 range (e.g. \"A1:D100\")";
  }
  if (!isBoundedString(destinationCell, 512) || (destinationCell as string).length === 0) {
    return "destinationCell must be a non-empty A1 cell (e.g. \"F1\")";
  }
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    return "fields must be an object { rows?, columns?, values?, filters? }";
  }
  const f = fields as Record<string, unknown>;
  for (const k of Object.keys(f)) {
    if (!PIVOT_AREAS.has(k)) {
      return `unknown pivot area "${k}" (allowed: ${[...PIVOT_AREAS].join(", ")})`;
    }
  }
  for (const area of ["rows", "columns", "filters"] as const) {
    const list = f[area];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > MAX_PIVOT_FIELDS) {
      return `${area} must be an array of field names (max ${MAX_PIVOT_FIELDS})`;
    }
    for (const n of list) {
      if (!isBoundedString(n, MAX_OBJECT_NAME) || n.length === 0) {
        return `each ${area} entry must be a non-empty field name`;
      }
    }
  }
  const values = f.values;
  if (values !== undefined) {
    if (!Array.isArray(values) || values.length > MAX_PIVOT_FIELDS) {
      return `values must be an array (max ${MAX_PIVOT_FIELDS})`;
    }
    for (const v of values) {
      const verdict = checkValueFieldSpec(v);
      if (verdict !== true) return verdict;
    }
  }
  if (!Array.isArray(values) || values.length === 0) {
    return "a pivot needs at least one value field, e.g. values: [{ field: \"Revenue\", aggregation: \"sum\" }]";
  }
  if (options === undefined || options === null) return true;
  if (typeof options !== "object" || Array.isArray(options)) return "options must be an object";
  const o = options as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!["name", "sourceSheet", "destinationSheet", "hasHeaders"].includes(k)) {
      return `unknown pivot option "${k}" (allowed: name, sourceSheet, destinationSheet, hasHeaders)`;
    }
  }
  if (o.name !== undefined && !isBoundedString(o.name, MAX_OBJECT_NAME)) {
    return `name must be a string (max ${MAX_OBJECT_NAME} chars)`;
  }
  for (const k of ["sourceSheet", "destinationSheet"] as const) {
    if (o[k] !== undefined && !isCellCoord(o[k])) return `${k} must be a non-negative integer`;
  }
  if (o.hasHeaders !== undefined && typeof o.hasHeaders !== "boolean") {
    return "hasHeaders must be a boolean";
  }
  return true;
};

/** One entry of a pivot `values` list: a field name + an aggregation word. */
function checkValueFieldSpec(v: unknown): true | string {
  if (isBoundedString(v, MAX_OBJECT_NAME)) {
    return v.length > 0 ? true : "each value entry must be a non-empty field name";
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return "each value entry must be a field name or { field, aggregation? }";
  }
  const spec = v as Record<string, unknown>;
  for (const k of Object.keys(spec)) {
    if (!["field", "aggregation"].includes(k)) {
      return `unknown value-field property "${k}" (allowed: field, aggregation)`;
    }
  }
  const field = spec.field;
  if (!isBoundedString(field, MAX_OBJECT_NAME) || field.length === 0) {
    return "each value entry needs a non-empty field name";
  }
  if (spec.aggregation !== undefined && !PIVOT_AGGREGATIONS.has(spec.aggregation as string)) {
    return `aggregation must be one of: ${[...PIVOT_AGGREGATIONS].join(", ")}`;
  }
  return true;
}

// ============================================================================
// Pivot layout mutation aspects (B3 §4)
// ============================================================================
// Reached through object.setState (own pivot) and api.objectSetState (any pivot
// at unlocked tier), so BOTH doors land on this one gate.

export const PIVOT_LAYOUT_ASPECTS: ReadonlySet<string> = new Set([
  "pivot.addField",
  "pivot.moveField",
  "pivot.removeField",
  "pivot.setAggregation",
  "pivot.setLayout",
]);

function checkPivotArea(area: unknown): true | string {
  if (!isBoundedString(area, 64) || !PIVOT_AREAS.has(area)) {
    return `area must be one of: ${[...PIVOT_AREAS].join(", ")}`;
  }
  return true;
}

function checkFieldName(name: unknown): true | string {
  if (!isBoundedString(name, MAX_OBJECT_NAME) || (name as string).trim().length === 0) {
    return "field must be a non-empty field name";
  }
  return true;
}

function checkPosition(position: unknown): true | string {
  if (position === undefined || position === null) return true;
  if (!isFiniteNumber(position) || !Number.isInteger(position) || position < 0 || position > MAX_PIVOT_FIELDS) {
    return `position must be an integer between 0 and ${MAX_PIVOT_FIELDS}`;
  }
  return true;
}

/** Validate one pivot-layout aspect's arguments (shape only, no state reads). */
export function checkPivotLayoutAspect(aspect: string, aspectArgs: unknown): true | string {
  const args = Array.isArray(aspectArgs) ? aspectArgs : [];
  switch (aspect) {
    case "pivot.addField":
    case "pivot.moveField": {
      const field = checkFieldName(args[0]);
      if (field !== true) return field;
      const area = checkPivotArea(args[1]);
      if (area !== true) return area;
      const position = checkPosition(args[2]);
      if (position !== true) return position;
      if (args[3] !== undefined && args[3] !== null) {
        if (!PIVOT_AGGREGATIONS.has(args[3] as string)) {
          return `aggregation must be one of: ${[...PIVOT_AGGREGATIONS].join(", ")}`;
        }
      }
      return true;
    }
    case "pivot.removeField": {
      const field = checkFieldName(args[0]);
      if (field !== true) return field;
      if (args[1] === undefined || args[1] === null) return true;
      return checkPivotArea(args[1]);
    }
    case "pivot.setAggregation": {
      const field = checkFieldName(args[0]);
      if (field !== true) return field;
      if (!PIVOT_AGGREGATIONS.has(args[1] as string)) {
        return `aggregation must be one of: ${[...PIVOT_AGGREGATIONS].join(", ")}`;
      }
      return true;
    }
    case "pivot.setLayout": {
      const directives = args[0];
      if (!Array.isArray(directives) || directives.length === 0) {
        return `expected a non-empty array of layout directives (allowed: ${[...PIVOT_LAYOUT_DIRECTIVES].join(", ")})`;
      }
      if (directives.length > 32) return "too many layout directives (max 32)";
      for (const d of directives) {
        if (!isBoundedString(d, 64) || !PIVOT_LAYOUT_DIRECTIVES.has(d)) {
          return `unknown layout directive "${String(d)}" (allowed: ${[...PIVOT_LAYOUT_DIRECTIVES].join(", ")})`;
        }
      }
      return true;
    }
    default:
      return true;
  }
}

export const vIndex: Validator = ([index]) =>
  isCellCoord(index) ? true : "index must be a non-negative integer";

export const vEvent: Validator = ([name]) =>
  isBoundedString(name, MAX_EVENT_NAME) && (name as string).length > 0
    ? true
    : "event name must be a non-empty string";

export const vCommand: Validator = ([commandId]) =>
  isBoundedString(commandId, MAX_KEY) && (commandId as string).length > 0
    ? true
    : "commandId must be a non-empty string";

export const vString: Validator = ([s]) =>
  isBoundedString(s) ? true : "expected a string (max 1 MB)";

export const vFetch: Validator = ([url, init]) => {
  if (!isBoundedString(url, 8192)) return "url must be a string (max 8192 chars)";
  try {
    const parsed = new URL(url as string);
    if (parsed.protocol !== "https:") return "only https URLs are allowed";
  } catch {
    return "url must be an absolute https URL";
  }
  if (init !== undefined && (typeof init !== "object" || init === null)) {
    return "init must be an object";
  }
  return true;
};

// Structured, model-scoped BI query (Wave 3 / bi.query). Args: [connectionId,
// { measures, groupBy, filters }]. The script supplies measures/columns/filter
// VALUES, never SQL text — so there is no injection surface; the engine plans
// the (read-only) query against the workbook's BI model. Shapes mirror
// backend.ts BiQueryRequest / BiColumnRef / BiFilter.
const MAX_BI_LIST = 256;

function isBiColumnRef(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const r = v as { table?: unknown; column?: unknown };
  return isBoundedString(r.table, MAX_KEY) && isBoundedString(r.column, MAX_KEY);
}

// Raw read-only SQL (Wave 3 / bi.sql, higher-trust). Args: [connectionId, sql].
// Frontend gate: a single SELECT/WITH statement. Rust re-validates read-only
// authoritatively (the connector executes it).
export const vBiSql: Validator = ([connectionId, sql]) => {
  if (!isBoundedString(connectionId, MAX_KEY) || (connectionId as string).length === 0) {
    return "connectionId must be a non-empty string";
  }
  if (!isBoundedString(sql, 100_000)) return "sql must be a string (max 100k chars)";
  const trimmed = (sql as string).trimStart().toLowerCase();
  if (!trimmed.startsWith("select") && !trimmed.startsWith("with")) {
    return "only read-only queries are allowed (SELECT / WITH)";
  }
  return true;
};

export const vBiQuery: Validator = ([connectionId, request]) => {
  if (!isBoundedString(connectionId, MAX_KEY) || (connectionId as string).length === 0) {
    return "connectionId must be a non-empty string";
  }
  if (typeof request !== "object" || request === null) return "request must be an object";
  const r = request as { measures?: unknown; groupBy?: unknown; filters?: unknown };
  if (!Array.isArray(r.measures) || r.measures.length > MAX_BI_LIST) {
    return `measures must be an array (max ${MAX_BI_LIST})`;
  }
  for (const m of r.measures) {
    if (!isBoundedString(m, MAX_KEY)) return "each measure must be a string";
  }
  if (!Array.isArray(r.groupBy) || r.groupBy.length > MAX_BI_LIST) {
    return `groupBy must be an array (max ${MAX_BI_LIST})`;
  }
  for (const g of r.groupBy) {
    if (!isBiColumnRef(g)) return "each groupBy entry must be { table, column }";
  }
  if (!Array.isArray(r.filters) || r.filters.length > MAX_BI_LIST) {
    return `filters must be an array (max ${MAX_BI_LIST})`;
  }
  for (const f of r.filters) {
    if (typeof f !== "object" || f === null) return "each filter must be an object";
    const ff = f as { column?: unknown; table?: unknown; operator?: unknown; value?: unknown };
    if (
      !isBoundedString(ff.column, MAX_KEY) ||
      !isBoundedString(ff.table, MAX_KEY) ||
      !isBoundedString(ff.operator, MAX_KEY) ||
      !isBoundedString(ff.value, MAX_KEY)
    ) {
      return "each filter must be { column, table, operator, value } of strings";
    }
  }
  return true;
};

export const vCubeValue: Validator = ([connection, members]) => {
  if (!isBoundedString(connection, MAX_KEY) || (connection as string).length === 0) {
    return "connection must be a non-empty string";
  }
  if (!Array.isArray(members) || members.length > MAX_BI_LIST) {
    return `members must be an array (max ${MAX_BI_LIST})`;
  }
  for (const m of members) {
    if (!isBoundedString(m, MAX_KEY)) return "each member must be a string";
  }
  return true;
};

export const vCubeKpi: Validator = ([connection, kpi, property]) => {
  if (!isBoundedString(connection, MAX_KEY) || (connection as string).length === 0) {
    return "connection must be a non-empty string";
  }
  if (!isBoundedString(kpi, MAX_KEY) || (kpi as string).length === 0) {
    return "kpi must be a non-empty string";
  }
  if (typeof property !== "number" || !Number.isInteger(property)) {
    return "property must be an integer (1=Value, 2=Goal, 3=Status)";
  }
  return true;
};

export const vCubeMembers: Validator = ([connection, level]) => {
  if (!isBoundedString(connection, MAX_KEY) || (connection as string).length === 0) {
    return "connection must be a non-empty string";
  }
  if (!isBoundedString(level, MAX_KEY) || (level as string).length === 0) {
    return "level must be a non-empty string (e.g. \"Geo[Country]\")";
  }
  return true;
};

/** cap.biModelInfo args: [connectionId]. */
export const vBiModelInfo: Validator = ([connectionId]) => {
  if (!isBoundedString(connectionId, MAX_KEY) || (connectionId as string).length === 0) {
    return "connectionId must be a non-empty string";
  }
  return true;
};

/** The model-object kinds a script may mutate via bi.model. This list is UX
 *  (clear early errors); the AUTHORITATIVE kind gate is Rust-side in
 *  script_bi_model — RLS roles, sources/connections, storage-mode and
 *  refresh knobs are not dispatchable there regardless of what reaches it.
 *
 *  MUST match GATEWAY_MUTABLE_KINDS in app/src-tauri/src/bi/model_editor.rs
 *  EXACTLY. Rust is authoritative: a kind listed here but not there produces a
 *  confusing late rejection, and a kind there but not here is unreachable
 *  because this validator rejects it before the call leaves the renderer. */
export const BI_MODEL_SCRIPTABLE_KINDS: ReadonlySet<string> = new Set([
  "measure", "calcColumn", "relationship", "hierarchy", "kpi", "calcGroup",
  "perspective", "culture", "scriptFunction", "calculatedTable",
  "tableVariable", "context", "contextColumn", "writebackColumn", "metadata",
  "dateTable", "extensionData",
]);

/** The read-only DIAGNOSTIC actions of the bi.model gateway that carry no
 *  arguments beyond the connection (validateModel / dependencyGraph). */
const BI_MODEL_VALIDATE_ACTIONS: ReadonlySet<string> = new Set([
  "validateMeasure", "validateContext", "validateModel",
]);

/** The lineage/impact reads. `dependencyGraph` takes nothing, `measureLineage`
 *  a measure name, `dependents` a (kind, name, table?) node address. */
const BI_MODEL_LINEAGE_ACTIONS: ReadonlySet<string> = new Set([
  "dependencyGraph", "measureLineage", "dependents",
]);

/** The node kinds `dependents` can address. Mirrors gateway_dependents in
 *  app/src-tauri/src/bi/model_editor.rs exactly; a kind outside this set is
 *  rejected there by name too. `calcColumn` / `contextColumn` additionally
 *  require the owning table, because their node id is "<table>.<name>". */
const BI_MODEL_DEPENDENT_KINDS: ReadonlySet<string> = new Set([
  "measure", "calcColumn", "contextColumn", "calculatedTable", "table",
]);

/** The `dependents` kinds whose node id is table-qualified. */
const BI_MODEL_TABLE_QUALIFIED_KINDS: ReadonlySet<string> = new Set([
  "calcColumn", "contextColumn",
]);

/** The batch actions of the bi.model gateway (atomic multi-edit transaction). */
const BI_MODEL_BATCH_ACTIONS: ReadonlySet<string> = new Set([
  "batchBegin", "batchEnd", "batchCancel",
]);

/** cap.biModelValidate args: [connectionId, action, payload]. */
export const vBiModelValidate: Validator = ([connectionId, action, payload]) => {
  if (!isBoundedString(connectionId, MAX_KEY) || (connectionId as string).length === 0) {
    return "connectionId must be a non-empty string";
  }
  if (!isBoundedString(action, MAX_KEY) || !BI_MODEL_VALIDATE_ACTIONS.has(action as string)) {
    return `action must be one of: ${[...BI_MODEL_VALIDATE_ACTIONS].join(", ")}`;
  }
  if (payload !== undefined && (typeof payload !== "object" || payload === null || Array.isArray(payload))) {
    return "payload must be an object";
  }
  const p = (payload ?? {}) as Record<string, unknown>;
  if (action === "validateMeasure") {
    if (!isBoundedString(p.name, MAX_KEY) || (p.name as string).length === 0) {
      return "validateMeasure needs payload.name (a non-empty string)";
    }
    if (!isBoundedString(p.formula, MAX_STRING)) return "payload.formula must be a string";
  }
  if (action === "validateContext") {
    if (!isBoundedString(p.name, MAX_KEY) || (p.name as string).length === 0) {
      return "validateContext needs payload.name (a non-empty string)";
    }
    if (!isBoundedString(p.expression, MAX_STRING)) return "payload.expression must be a string";
  }
  return true;
};

/** cap.biModelLineage args: [connectionId, action, payload]. */
export const vBiModelLineage: Validator = ([connectionId, action, payload]) => {
  if (!isBoundedString(connectionId, MAX_KEY) || (connectionId as string).length === 0) {
    return "connectionId must be a non-empty string";
  }
  if (!isBoundedString(action, MAX_KEY) || !BI_MODEL_LINEAGE_ACTIONS.has(action as string)) {
    return `action must be one of: ${[...BI_MODEL_LINEAGE_ACTIONS].join(", ")}`;
  }
  if (payload !== undefined && (typeof payload !== "object" || payload === null || Array.isArray(payload))) {
    return "payload must be an object";
  }
  const p = (payload ?? {}) as Record<string, unknown>;
  if (action === "measureLineage") {
    if (!isBoundedString(p.name, MAX_KEY) || (p.name as string).length === 0) {
      return "measureLineage needs payload.name (a non-empty string)";
    }
  }
  if (action === "dependents") {
    if (!isBoundedString(p.kind, MAX_KEY) || !BI_MODEL_DEPENDENT_KINDS.has(p.kind as string)) {
      return `dependents payload.kind must be one of: ${[...BI_MODEL_DEPENDENT_KINDS].join(", ")}`;
    }
    if (!isBoundedString(p.name, MAX_KEY) || (p.name as string).length === 0) {
      return "dependents needs payload.name (a non-empty string)";
    }
    if (p.table !== undefined && p.table !== null && !isBoundedString(p.table, MAX_KEY)) {
      return "dependents payload.table must be a string when present";
    }
    if (
      BI_MODEL_TABLE_QUALIFIED_KINDS.has(p.kind as string) &&
      (!isBoundedString(p.table, MAX_KEY) || (p.table as string).length === 0)
    ) {
      return `dependents for a '${p.kind as string}' requires payload.table`;
    }
  }
  return true;
};

/** cap.biModelBatch args: [connectionId, action]. */
export const vBiModelBatch: Validator = ([connectionId, action]) => {
  if (!isBoundedString(connectionId, MAX_KEY) || (connectionId as string).length === 0) {
    return "connectionId must be a non-empty string";
  }
  if (!isBoundedString(action, MAX_KEY) || !BI_MODEL_BATCH_ACTIONS.has(action as string)) {
    return `action must be one of: ${[...BI_MODEL_BATCH_ACTIONS].join(", ")}`;
  }
  return true;
};

/** cap.biModelUpsert / cap.biModelDelete args: [connectionId, kind, payload]. */
export const vBiModelMutation: Validator = ([connectionId, kind, payload]) => {
  if (!isBoundedString(connectionId, MAX_KEY) || (connectionId as string).length === 0) {
    return "connectionId must be a non-empty string";
  }
  if (!isBoundedString(kind, MAX_KEY) || !BI_MODEL_SCRIPTABLE_KINDS.has(kind as string)) {
    return `kind must be one of: ${[...BI_MODEL_SCRIPTABLE_KINDS].join(", ")}`;
  }
  if (payload !== undefined && (typeof payload !== "object" || payload === null || Array.isArray(payload))) {
    return "payload must be an object";
  }
  return true;
};

/** cap.connectorRegister args: [connectionId, def]. Deep validation happens in
 *  the trusted connector host + the Rust gate; this is the cheap shape gate. */
export const vConnectorRegister: Validator = ([connectionId, def]) => {
  if (!isBoundedString(connectionId, MAX_KEY) || (connectionId as string).length === 0) {
    return "connectionId must be a non-empty string";
  }
  if (typeof def !== "object" || def === null) return "def must be an object";
  const d = def as { sourceId?: unknown; tables?: unknown };
  if (!isBoundedString(d.sourceId, MAX_KEY) || !(d.sourceId as string).startsWith("script:")) {
    return "def.sourceId must be a string starting with 'script:'";
  }
  if (!Array.isArray(d.tables) || d.tables.length === 0 || d.tables.length > 64) {
    return "def.tables must be a non-empty array (max 64)";
  }
  return true;
};

/** cap.connectorRemove args: [connectionId, sourceId]. */
export const vConnectorRemove: Validator = ([connectionId, sourceId]) => {
  if (!isBoundedString(connectionId, MAX_KEY) || (connectionId as string).length === 0) {
    return "connectionId must be a non-empty string";
  }
  if (!isBoundedString(sourceId, MAX_KEY) || !(sourceId as string).startsWith("script:")) {
    return "sourceId must be a string starting with 'script:'";
  }
  return true;
};

// ============================================================================
// schedule — persistent, consented recurring jobs (the OnTime replacement)
// ============================================================================
//
// Every shape here is a CHEAP pre-flight so a script gets a readable error
// instead of a backend rejection. The AUTHORITATIVE gate is the Rust
// `script_scheduler` command, which re-checks the grant on registration AND on
// every firing, re-applies the interval floor, caps the job count, and refuses
// to hand out a job whose script is not mounted. Nothing below is a security
// boundary — it is ergonomics in front of one.

/** The floor a script's requested cadence is checked against. MUST agree with
 *  Rust `MIN_INTERVAL_SECS` (scripting/scheduler.rs) and with the connector
 *  refresh floor that was folded into the scheduler; Rust re-applies it either
 *  way, so a mismatch only costs a confusing error message. */
export const MIN_SCHEDULE_INTERVAL_SECS = 30;

/** A handler name must address a method the script itself EXPOSED — the whole
 *  invocation surface of a scheduled job. */
function scheduleHandlerError(handler: unknown): string | null {
  if (!isBoundedString(handler, MAX_KEY) || (handler as string).length === 0) {
    return "handler must be the name of a method this script exposed with context.expose(...)";
  }
  return null;
}

/** Optional { label } bag accepted by both registration methods. */
function scheduleOptionsError(options: unknown): string | null {
  if (options === undefined || options === null) return null;
  if (typeof options !== "object" || Array.isArray(options)) return "options must be an object";
  const label = (options as { label?: unknown }).label;
  if (label !== undefined && !isBoundedString(label, MAX_KEY)) {
    return "options.label must be a short string";
  }
  return null;
}

/** cap.scheduleEvery args: [intervalSecs, handler, options?]. */
export const vScheduleEvery: Validator = ([intervalSecs, handler, options]) => {
  if (typeof intervalSecs !== "number" || !Number.isFinite(intervalSecs)) {
    return "intervalSecs must be a finite number of seconds";
  }
  if (intervalSecs < MIN_SCHEDULE_INTERVAL_SECS) {
    return `intervalSecs must be at least ${MIN_SCHEDULE_INTERVAL_SECS} (got ${intervalSecs})`;
  }
  if (intervalSecs > 366 * 24 * 3600) return "intervalSecs must be at most one year";
  return scheduleHandlerError(handler) ?? scheduleOptionsError(options) ?? true;
};

/** cap.scheduleAt args: [timeOfDay, handler, options?] where timeOfDay is
 *  "HH:MM" in LOCAL time — the user's clock, because that is what "run at
 *  06:30" means to the person who consented. */
export const vScheduleAt: Validator = ([timeOfDay, handler, options]) => {
  if (!isBoundedString(timeOfDay, 5)) return "timeOfDay must be a 'HH:MM' string";
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(timeOfDay as string);
  if (!m) return "timeOfDay must be 'HH:MM' in 24-hour local time (e.g. '06:30')";
  return scheduleHandlerError(handler) ?? scheduleOptionsError(options) ?? true;
};

/** cap.scheduleCancel args: [jobId]. */
export const vScheduleCancel: Validator = ([jobId]) => {
  if (!isBoundedString(jobId, MAX_KEY) || (jobId as string).length === 0) {
    return "jobId must be a non-empty string";
  }
  return true;
};

// ============================================================================
// distribution.writeback — fill in and send a subscribed package's input cells
// ============================================================================
//
// Every shape here is a CHEAP pre-flight. The authoritative gate is the Rust
// `script_writeback` gateway, which re-checks the grant, splits contributor
// from publisher actions behind an Ed25519 key-possession test, rate-limits per
// bucket, and then dispatches into the very same calp_* commands the
// interactive UI calls — so a script submission passes exactly the schema,
// lifecycle, ownership and registry-trust checks a human's does.

/** The submission states a publisher may set. Mirrors the interactive
 *  `setSubmissionState` signature — a review can also RESET to "submitted". */
const WRITEBACK_REVIEW_STATES: ReadonlySet<string> = new Set([
  "approved", "rejected", "submitted",
]);

/** The wire shape of one submitted value (mirrors SubmissionValue in
 *  api/distribution.ts and calp::writeback::SubmissionValue in Rust). */
function submissionValueError(v: unknown): string | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return "value must be an object like { type: \"number\", value: 42 }";
  }
  const { type, value } = v as { type?: unknown; value?: unknown };
  switch (type) {
    case "number":
      return isFiniteNumber(value) ? null : "value.value must be a finite number";
    case "text":
      return isBoundedString(value, MAX_STRING) ? null : "value.value must be a string";
    case "boolean":
      return typeof value === "boolean" ? null : "value.value must be a boolean";
    case "empty":
      return null;
    default:
      return "value.type must be number|text|boolean|empty";
  }
}

/** Exactly one of `regionId` (a grid writeback region) or `writebackId` (a BI
 *  model writeback column) addresses the publisher's submission store. The Rust
 *  gateway discriminates on the same key, so demanding exactly one here turns a
 *  "publisher target not resolved" round trip into an immediate message. */
function writebackTargetError(t: unknown): string | null {
  if (typeof t !== "object" || t === null || Array.isArray(t)) {
    return "target must be an object with either regionId or writebackId";
  }
  const { regionId, writebackId } = t as { regionId?: unknown; writebackId?: unknown };
  const hasRegion = regionId !== undefined && regionId !== null;
  const hasColumn = writebackId !== undefined && writebackId !== null;
  if (hasRegion === hasColumn) {
    return "target needs exactly one of regionId (grid region) or writebackId (model column)";
  }
  if (hasRegion && (!isBoundedString(regionId, MAX_KEY) || (regionId as string).length === 0)) {
    return "target.regionId must be a non-empty string";
  }
  if (hasColumn && (!isBoundedString(writebackId, MAX_KEY) || (writebackId as string).length === 0)) {
    return "target.writebackId must be a non-empty string";
  }
  return null;
}

/** cap.writebackSubmit / cap.writebackPreview args: [regionId]. */
export const vWritebackRegionId: Validator = ([regionId]) => {
  if (!isBoundedString(regionId, MAX_KEY) || (regionId as string).length === 0) {
    return "regionId must be a non-empty string";
  }
  return true;
};

/** cap.writebackSaveDraft args: [regionId, sheetId, row, col, value]. */
export const vWritebackSaveDraft: Validator = ([regionId, sheetId, row, col, value]) => {
  if (!isBoundedString(regionId, MAX_KEY) || (regionId as string).length === 0) {
    return "regionId must be a non-empty string";
  }
  if (!isBoundedString(sheetId, MAX_KEY) || (sheetId as string).length === 0) {
    return "sheetId must be a non-empty string (use listRegions() to get it)";
  }
  if (!isCellCoord(row) || !isCellCoord(col)) return "row and col must be non-negative integers";
  const err = submissionValueError(value);
  return err ?? true;
};

/** cap.writebackListSubmissions args: [target] — PUBLISHER ONLY. */
export const vWritebackListSubmissions: Validator = ([target]) => {
  const err = writebackTargetError(target);
  return err ?? true;
};

/** cap.writebackReview args: [decision] — PUBLISHER ONLY. */
export const vWritebackReview: Validator = ([decision]) => {
  const err = writebackTargetError(decision);
  if (err) return err;
  const d = decision as Record<string, unknown>;
  if (!isBoundedString(d.newState, MAX_KEY) || !WRITEBACK_REVIEW_STATES.has(d.newState as string)) {
    return `newState must be one of: ${[...WRITEBACK_REVIEW_STATES].join(", ")}`;
  }
  if (d.reason !== undefined && d.reason !== null && !isBoundedString(d.reason, 4096)) {
    return "reason must be a string (max 4096 chars)";
  }
  if (d.regionId !== undefined && d.regionId !== null) {
    if (!isBoundedString(d.submitterId, MAX_KEY) || (d.submitterId as string).length === 0) {
      return "a region decision needs submitterId (a non-empty string)";
    }
    if (!isCellCoord(d.cellRow) || !isCellCoord(d.cellCol)) {
      return "a region decision needs cellRow and cellCol (non-negative integers)";
    }
    if (
      d.submissionId !== undefined && d.submissionId !== null &&
      !isBoundedString(d.submissionId, MAX_KEY)
    ) {
      return "submissionId must be a string when present";
    }
  } else {
    if (!isBoundedString(d.submissionId, MAX_KEY) || (d.submissionId as string).length === 0) {
      return "a model-column decision needs submissionId (a non-empty string)";
    }
  }
  return true;
};

export const vUdf: Validator = ([name, args]) => {
  if (!isBoundedString(name, MAX_KEY) || (name as string).length === 0) {
    return "udf name must be a non-empty string";
  }
  if (!Array.isArray(args)) return "udf args must be an array";
  if (args.length > 255) return "too many udf arguments (max 255)";
  return true;
};

// ============================================================================
// ui.dialog — modal question + declarative form (B4)
// ============================================================================
//
// Everything here is a pure SHAPE check on data that will be painted by trusted
// host code. The point of the strictness is not memory safety (a 5 MB string
// would survive structured clone fine) but the USER: a modal is an interruption
// the script did not have to earn, so its text is bounded to what a person can
// read, its buttons to what fits a button, and its fields to what fits a form.

/** Reject an unexpected member so a typo'd option surfaces instead of vanishing. */
function checkKnownKeys(o: Record<string, unknown>, allowed: readonly string[], what: string): true | string {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) {
      return `unknown ${what} "${k}" (allowed: ${allowed.join(", ")})`;
    }
  }
  return true;
}

/** Shared chrome members of every dialog options object. */
function checkDialogChrome(o: Record<string, unknown>): true | string {
  if (o.title !== undefined && !isBoundedString(o.title, MAX_DIALOG_TITLE)) {
    return `title must be a string (max ${MAX_DIALOG_TITLE} chars)`;
  }
  for (const k of ["okLabel", "cancelLabel"] as const) {
    if (o[k] !== undefined && (!isBoundedString(o[k], MAX_DIALOG_LABEL) || (o[k] as string).length === 0)) {
      return `${k} must be a non-empty string (max ${MAX_DIALOG_LABEL} chars)`;
    }
  }
  return true;
}

/** cap.dialogAlert / cap.dialogConfirm args: [message, options?]. */
export const vDialogMessage: Validator = ([message, options]) => {
  if (!isBoundedString(message, MAX_DIALOG_MESSAGE) || (message as string).trim().length === 0) {
    return `message must be a non-empty string (max ${MAX_DIALOG_MESSAGE} chars)`;
  }
  if (options === undefined || options === null) return true;
  if (typeof options !== "object" || Array.isArray(options)) return "options must be an object";
  const o = options as Record<string, unknown>;
  const known = checkKnownKeys(o, ["title", "okLabel", "cancelLabel", "danger"], "dialog option");
  if (known !== true) return known;
  const chrome = checkDialogChrome(o);
  if (chrome !== true) return chrome;
  if (o.danger !== undefined && typeof o.danger !== "boolean") return "danger must be a boolean";
  return true;
};

/** cap.dialogPrompt args: [message, options?]. */
export const vDialogPrompt: Validator = ([message, options]) => {
  const base = vDialogMessage([message, undefined]);
  if (base !== true) return base;
  if (options === undefined || options === null) return true;
  if (typeof options !== "object" || Array.isArray(options)) return "options must be an object";
  const o = options as Record<string, unknown>;
  const known = checkKnownKeys(
    o,
    ["title", "okLabel", "cancelLabel", "defaultValue", "placeholder", "multiline", "maxLength"],
    "prompt option",
  );
  if (known !== true) return known;
  const chrome = checkDialogChrome(o);
  if (chrome !== true) return chrome;
  if (o.defaultValue !== undefined && !isBoundedString(o.defaultValue, MAX_DIALOG_MESSAGE)) {
    return `defaultValue must be a string (max ${MAX_DIALOG_MESSAGE} chars)`;
  }
  if (o.placeholder !== undefined && !isBoundedString(o.placeholder, MAX_DIALOG_FIELD_LABEL)) {
    return `placeholder must be a string (max ${MAX_DIALOG_FIELD_LABEL} chars)`;
  }
  if (o.multiline !== undefined && typeof o.multiline !== "boolean") return "multiline must be a boolean";
  if (o.maxLength !== undefined && (!isFiniteNumber(o.maxLength) || o.maxLength < 1 || o.maxLength > MAX_DIALOG_MESSAGE)) {
    return `maxLength must be a number between 1 and ${MAX_DIALOG_MESSAGE}`;
  }
  return true;
};

const DIALOG_FIELD_KEYS = [
  "name", "label", "type", "required", "default", "placeholder", "help",
  "multiline", "maxLength", "min", "max", "step", "options",
] as const;

/** One declarative field. `seen` carries the names already used (uniqueness). */
function checkDialogField(field: unknown, index: number, seen: Set<string>): true | string {
  const where = `fields[${index}]`;
  if (typeof field !== "object" || field === null || Array.isArray(field)) {
    return `${where} must be an object`;
  }
  const f = field as Record<string, unknown>;
  const known = checkKnownKeys(f, DIALOG_FIELD_KEYS, `${where} property`);
  if (known !== true) return known;

  // name: it becomes a KEY on the result object, so it must be a plain
  // identifier — that is what keeps `result.__proto__` from being a thing.
  if (!isBoundedString(f.name, MAX_DIALOG_FIELD_NAME) || !DIALOG_FIELD_NAME_RE.test(f.name)) {
    return `${where}.name must be an identifier (letters, digits, underscore; max ${MAX_DIALOG_FIELD_NAME} chars)`;
  }
  if (RESERVED_DIALOG_FIELD_NAMES.has(f.name)) return `${where}.name "${f.name}" is reserved`;
  if (seen.has(f.name)) return `${where}.name "${f.name}" is used more than once`;
  seen.add(f.name);

  if (!isBoundedString(f.label, MAX_DIALOG_FIELD_LABEL) || (f.label as string).length === 0) {
    return `${where}.label must be a non-empty string (max ${MAX_DIALOG_FIELD_LABEL} chars)`;
  }
  if (!isBoundedString(f.type, 32) || !DIALOG_FIELD_TYPE_SET.has(f.type)) {
    return `${where}.type must be one of: ${DIALOG_FIELD_TYPES.join(", ")}`;
  }
  const type = f.type as string;

  for (const k of ["required", "multiline"] as const) {
    if (f[k] !== undefined && typeof f[k] !== "boolean") return `${where}.${k} must be a boolean`;
  }
  for (const k of ["placeholder", "help"] as const) {
    if (f[k] !== undefined && !isBoundedString(f[k], MAX_DIALOG_FIELD_LABEL)) {
      return `${where}.${k} must be a string (max ${MAX_DIALOG_FIELD_LABEL} chars)`;
    }
  }
  if (f.maxLength !== undefined && (!isFiniteNumber(f.maxLength) || f.maxLength < 1 || f.maxLength > MAX_DIALOG_MESSAGE)) {
    return `${where}.maxLength must be a number between 1 and ${MAX_DIALOG_MESSAGE}`;
  }
  for (const k of ["min", "max", "step"] as const) {
    if (f[k] !== undefined && !isFiniteNumber(f[k])) return `${where}.${k} must be a finite number`;
  }
  if (isFiniteNumber(f.min) && isFiniteNumber(f.max) && f.min > f.max) {
    return `${where}.min must not be greater than ${where}.max`;
  }
  if (f.step !== undefined && (f.step as number) <= 0) return `${where}.step must be greater than 0`;

  // default must match the field's own type, or the renderer would seed a
  // control with a value it cannot display and the result shape would lie.
  if (f.default !== undefined) {
    if (type === "checkbox") {
      if (typeof f.default !== "boolean") return `${where}.default must be a boolean for a checkbox`;
    } else if (type === "number") {
      if (!isFiniteNumber(f.default)) return `${where}.default must be a finite number`;
    } else if (!isBoundedString(f.default, MAX_DIALOG_MESSAGE)) {
      return `${where}.default must be a string (max ${MAX_DIALOG_MESSAGE} chars)`;
    }
  }

  if (type === "select") {
    if (!Array.isArray(f.options) || f.options.length === 0) {
      return `${where}.options must be a non-empty array for a select field`;
    }
    if (f.options.length > MAX_DIALOG_OPTIONS) {
      return `${where}.options has ${f.options.length} entries (max ${MAX_DIALOG_OPTIONS})`;
    }
    for (let i = 0; i < f.options.length; i++) {
      const opt = f.options[i];
      if (isBoundedString(opt, MAX_DIALOG_OPTION_TEXT)) continue;
      if (typeof opt !== "object" || opt === null || Array.isArray(opt)) {
        return `${where}.options[${i}] must be a string or { value, label }`;
      }
      const o = opt as Record<string, unknown>;
      const optKnown = checkKnownKeys(o, ["value", "label"], `${where}.options[${i}] property`);
      if (optKnown !== true) return optKnown;
      if (!isBoundedString(o.value, MAX_DIALOG_OPTION_TEXT)) {
        return `${where}.options[${i}].value must be a string (max ${MAX_DIALOG_OPTION_TEXT} chars)`;
      }
      if (o.label !== undefined && !isBoundedString(o.label, MAX_DIALOG_OPTION_TEXT)) {
        return `${where}.options[${i}].label must be a string (max ${MAX_DIALOG_OPTION_TEXT} chars)`;
      }
    }
  } else if (f.options !== undefined) {
    return `${where}.options is only valid on a select field`;
  }
  return true;
}

/** cap.dialogForm args: [spec]. */
export const vDialogForm: Validator = ([spec]) => {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) return "spec must be an object";
  const s = spec as Record<string, unknown>;
  const known = checkKnownKeys(
    s,
    ["title", "description", "submitLabel", "cancelLabel", "fields"],
    "form property",
  );
  if (known !== true) return known;
  if (s.title !== undefined && !isBoundedString(s.title, MAX_DIALOG_TITLE)) {
    return `title must be a string (max ${MAX_DIALOG_TITLE} chars)`;
  }
  if (s.description !== undefined && !isBoundedString(s.description, MAX_DIALOG_MESSAGE)) {
    return `description must be a string (max ${MAX_DIALOG_MESSAGE} chars)`;
  }
  for (const k of ["submitLabel", "cancelLabel"] as const) {
    if (s[k] !== undefined && (!isBoundedString(s[k], MAX_DIALOG_LABEL) || (s[k] as string).length === 0)) {
      return `${k} must be a non-empty string (max ${MAX_DIALOG_LABEL} chars)`;
    }
  }
  if (!Array.isArray(s.fields) || s.fields.length === 0) {
    return "fields must be a non-empty array";
  }
  if (s.fields.length > MAX_DIALOG_FIELDS) {
    return `fields has ${s.fields.length} entries (max ${MAX_DIALOG_FIELDS})`;
  }
  const seen = new Set<string>();
  for (let i = 0; i < s.fields.length; i++) {
    const result = checkDialogField(s.fields[i], i, seen);
    if (result !== true) return result;
  }
  return true;
};

export const vKey: Validator = ([key]) =>
  isBoundedString(key, MAX_KEY) && (key as string).length > 0
    ? true
    : "key must be a non-empty string (max 512 chars)";

export const vKV: Validator = ([key, value]) => {
  if (!isBoundedString(key, MAX_KEY) || (key as string).length === 0) {
    return "key must be a non-empty string (max 512 chars)";
  }
  if (!isBoundedString(value, 262_144)) return "value must be a string (max 256 KB)";
  return true;
};
