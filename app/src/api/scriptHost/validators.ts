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

/**
 * base.callImport: [alias, methodName, args].
 *
 * SHAPE ONLY, on purpose. Neither the alias nor the method name is trusted here
 * — the alias is resolved against the HOST-side import table keyed by the
 * CALLING script's id (host.ts `authorizeImportCall`), and the method name is
 * checked against the exports that table recorded. A validator cannot do that
 * job: it never reads state, and it runs before the tier check, so anything it
 * decided would leak policy into an error message.
 */
export const vCallImport: Validator = ([alias, methodName, args]) => {
  if (!isBoundedString(alias, MAX_KEY) || (alias as string).length === 0) {
    return "alias must be a non-empty string";
  }
  if (!isBoundedString(methodName, MAX_KEY) || (methodName as string).length === 0) {
    return "methodName must be a non-empty string";
  }
  if (args !== undefined && !Array.isArray(args)) return "args must be an array";
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
  // Chart geometry (Wave 4): move/resize/rename/re-sheet an existing chart.
  // The bounds are EXACTLY vCreateChart's placement bounds — moving a chart
  // must not be a laxer door than creating one there.
  if (aspect === "chart.setGeometry") {
    return checkChartGeometryAspect(aspectArgs);
  }
  // Table STRUCTURE mutation (Wave 4): the ListObject management family —
  // rename/resize/columns/totals/style/convert/insert/delete row. Enumerated
  // shapes, so a typo'd totals function fails with the accepted list instead
  // of reaching the backend.
  if (TABLE_STRUCTURE_ASPECTS.has(aspect as string)) {
    return checkTableStructureAspect(aspect as string, aspectArgs);
  }
  // Named-range definition edit (Wave 4): one patch object, gated here so both
  // setState doors reject an unknown key / illegal name before the tier check.
  if (aspect === "namedRange.update") {
    return checkNamedRangeUpdate(aspectArgs);
  }
  // Pivot layout mutation (B3): the field/area/aggregation vocabulary is the
  // Pivot Layout DSL's, checked here so a typo ("Rows", "avg") fails with the
  // accepted list instead of reaching the backend as a silent no-op.
  if (PIVOT_LAYOUT_ASPECTS.has(aspect as string)) {
    return checkPivotLayoutAspect(aspect as string, aspectArgs);
  }
  // Pivot DATA mutation (Wave 3): filters / item visibility / sort / number
  // format — gated exactly like the layout family above, so both the
  // own-object door and api.objectSetState land on the same shape check.
  if (PIVOT_DATA_ASPECTS.has(aspect as string)) {
    return checkPivotDataAspect(aspect as string, aspectArgs);
  }
  return true;
};
export const vDecl: Validator = ([decls]) =>
  typeof decls === "object" && decls !== null ? true : "expected a declarations object";

export const vHtml: Validator = ([html]) =>
  isBoundedString(html, 5_000_000) ? true : "html must be a string (max 5 MB)";

// ============================================================================
// Sheet references (Wave 1): index OR name, everywhere a sheet can be named
// ============================================================================
// A sheet is addressed the way VBA always allowed: by 0-based index or by NAME.
// The validator only checks SHAPE (an index-shaped number, or a string that
// could be a sheet name under the same character rules renameSheet enforces);
// RESOLUTION — exact name first, then unique case-insensitive, with an error
// that lists the actual sheets — happens host-side at execution time against
// live state (host.ts resolveSheetRef). Never worker-side: a name must mean
// what the workbook means by it at the moment the call lands.

function checkSheetRef(v: unknown, label: string): true | string {
  if (typeof v === "number") {
    return isCellCoord(v)
      ? true
      : `${label} must be a non-negative 0-based sheet index or a sheet name`;
  }
  if (typeof v === "string") {
    // Same character rules as renameSheet: 1-255 chars, none of : \ / ? * [ ]
    const named = checkSheetName(v);
    return named === true ? true : `${label}: ${named}`;
  }
  return `${label} must be a 0-based sheet index (number) or a sheet name (string)`;
}

/** Optional sheet slot: undefined/null = "the active sheet". */
function checkOptionalSheetRef(v: unknown, label = "sheetIndex"): true | string {
  if (v === undefined || v === null) return true;
  return checkSheetRef(v, label);
}

/** Single required sheet-ref argument (api.setActiveSheet / api.deleteSheet). */
export const vSheetRef: Validator = ([ref]) => checkSheetRef(ref, "sheet");

// ============================================================================
// Typed cell writes (Wave 1): string | number | boolean | null per cell
// ============================================================================
// A script that writes 42 means the NUMBER 42 — the host converts it through
// the same invariant input-parse path a paste of a numeric cell takes, so it
// lands typed rather than as text. `null` CLEARS the cell (the honest spelling
// of Range.Value = Empty). Strings keep the 1 MB ceiling.

export function checkCellWriteValue(v: unknown, label: string): true | string {
  if (v === null || typeof v === "boolean") return true;
  if (typeof v === "number") {
    return Number.isFinite(v) ? true : `${label} must be a finite number`;
  }
  if (typeof v === "string") {
    return v.length <= MAX_STRING ? true : `${label} is over 1 MB of text`;
  }
  return `${label} must be a string, number, boolean or null (null clears the cell)`;
}

export const vCellRef: Validator = ([row, col, sheetIndex]) => {
  if (!isCellCoord(row)) return "row must be a non-negative integer";
  if (!isCellCoord(col)) return "col must be a non-negative integer";
  return checkOptionalSheetRef(sheetIndex);
};

export const vCellSet: Validator = ([row, col, value, sheetIndex]) => {
  if (!isCellCoord(row)) return "row must be a non-negative integer";
  if (!isCellCoord(col)) return "col must be a non-negative integer";
  const val = checkCellWriteValue(value, "value");
  if (val !== true) return val;
  return checkOptionalSheetRef(sheetIndex);
};

export const vBatch: Validator = ([updates]) => {
  if (!Array.isArray(updates)) return "updates must be an array";
  for (const u of updates) {
    if (typeof u !== "object" || u === null) return "each update must be an object";
    const { row, col, value } = u as { row?: unknown; col?: unknown; value?: unknown };
    if (!isCellCoord(row)) return "each update.row must be a non-negative integer";
    if (!isCellCoord(col)) return "each update.col must be a non-negative integer";
    const val = checkCellWriteValue(value, "each update.value");
    if (val !== true) return val;
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
  return checkOptionalSheetRef(sheetIndex);
};

/** Bulk range WRITE args: [startRow, startCol, values, sheetIndex?]. `values` is
 *  a rows x cols grid of cell values (string | number | boolean | null)
 *  anchored at (startRow, startCol); a hole (undefined entry) leaves that cell
 *  untouched, an explicit null CLEARS it. */
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
      if (v === undefined) continue; // hole: leave the cell untouched
      const val = checkCellWriteValue(v, "each value");
      if (val !== true) return val;
    }
  }
  return checkOptionalSheetRef(sheetIndex);
};

// ============================================================================
// Selection + navigation (Wave 2): api.select / api.scrollTo / api.clearRange
// ============================================================================
// The A1-STRING form of api.select is resolved WORKER-SIDE (contextShims) to
// numeric coordinates before the broker call, so these validators only ever
// see numbers — plus an optional sheet ref, which resolves host-side at
// execution time exactly like every other Wave-1 sheet slot.

/** Ceiling for one api.select call's areas (a multi-area selection). Excel's
 *  own Ctrl+Click selections are human-sized; a script that wants thousands of
 *  disjoint rectangles selected is not selecting, it is painting. */
export const MAX_SELECT_AREAS = 128;

/** One rectangular area: { startRow, startCol, endRow, endCol }. */
function checkSelectArea(v: unknown, label: string): true | string {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return `${label} must be an object { startRow, startCol, endRow, endCol }`;
  }
  const a = v as Record<string, unknown>;
  for (const key of ["startRow", "startCol", "endRow", "endCol"]) {
    if (!isCellCoord(a[key])) return `${label}.${key} must be a non-negative integer`;
  }
  return true;
}

/** api.select args: [startRow, startCol, endRow?, endCol?, options?]. */
export const vSelect: Validator = ([startRow, startCol, endRow, endCol, options]) => {
  if (!isCellCoord(startRow)) return "startRow must be a non-negative integer";
  if (!isCellCoord(startCol)) return "startCol must be a non-negative integer";
  if (endRow !== undefined && endRow !== null && !isCellCoord(endRow)) {
    return "endRow must be a non-negative integer";
  }
  if (endCol !== undefined && endCol !== null && !isCellCoord(endCol)) {
    return "endCol must be a non-negative integer";
  }
  if (options === undefined || options === null) return true;
  if (typeof options !== "object" || Array.isArray(options)) {
    return "options must be an object { sheetIndex?, scroll?, ranges? }";
  }
  const o = options as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key !== "sheetIndex" && key !== "scroll" && key !== "ranges") {
      return `unknown select option "${key}" (allowed: sheetIndex, scroll, ranges)`;
    }
  }
  if (o.scroll !== undefined && typeof o.scroll !== "boolean") {
    return "options.scroll must be a boolean";
  }
  if (o.ranges !== undefined) {
    if (!Array.isArray(o.ranges)) return "options.ranges must be an array of areas";
    if (o.ranges.length > MAX_SELECT_AREAS) {
      return `too many areas: ${o.ranges.length} (max ${MAX_SELECT_AREAS})`;
    }
    for (let i = 0; i < o.ranges.length; i++) {
      const verdict = checkSelectArea(o.ranges[i], `options.ranges[${i}]`);
      if (verdict !== true) return verdict;
    }
  }
  return checkOptionalSheetRef(o.sheetIndex, "options.sheetIndex");
};

/** api.scrollTo args: [row, col, sheet?] — a viewport move, never a write. */
export const vScrollTo: Validator = ([row, col, sheetIndex]) => {
  if (!isCellCoord(row)) return "row must be a non-negative integer";
  if (!isCellCoord(col)) return "col must be a non-negative integer";
  return checkOptionalSheetRef(sheetIndex);
};

/** The four edge directions api.getRangeEdge understands — the same strings
 *  Rust's EdgeDirection::parse accepts (core/engine/src/navigation.rs), so a
 *  typo fails HERE with the accepted list instead of crossing to the backend. */
export const SCRIPT_EDGE_DIRECTIONS: ReadonlySet<string> = new Set([
  "up", "down", "left", "right",
]);

/** api.getRangeEdge args: [row, col, direction, sheet?] — a pure read (where
 *  WOULD Ctrl+Arrow land), never a navigation. */
export const vRangeEdge: Validator = ([row, col, direction, sheetIndex]) => {
  if (!isCellCoord(row)) return "row must be a non-negative integer";
  if (!isCellCoord(col)) return "col must be a non-negative integer";
  if (!SCRIPT_EDGE_DIRECTIONS.has(direction as string)) {
    return `direction must be one of: ${[...SCRIPT_EDGE_DIRECTIONS].join(", ")}`;
  }
  return checkOptionalSheetRef(sheetIndex);
};

/** api.getUsedRange args: [sheet?] — just the optional Wave-1 sheet ref. */
export const vUsedRange: Validator = ([sheetIndex]) =>
  checkOptionalSheetRef(sheetIndex);

/** api.setTabColor args: [sheet, color] — `color` is a hex color, or null to
 *  remove the tab colour entirely. */
export const vTabColor: Validator = ([sheet, color]) => {
  const ref = checkSheetRef(sheet, "sheet");
  if (ref !== true) return ref;
  if (color === null) return true;
  return isHexColor(color)
    ? true
    : 'color must be a hex color like "#RRGGBB" (or null to remove the tab colour)';
};

/** What api.clearRange may be told to clear. Deliberately NOT the backend's
 *  whole ClearApplyTo union: "hyperlinks"/"removeHyperlinks"/"resetContents"
 *  are interactive-menu refinements with no script story yet, and an
 *  enumerated set here means a typo fails with the accepted list. */
export const SCRIPT_CLEAR_APPLY_TO: ReadonlySet<string> = new Set([
  "all", "contents", "formats",
]);

/** api.clearRange args: [startRow, startCol, endRow, endCol, options?, sheet?]. */
export const vClearRange: Validator = ([startRow, startCol, endRow, endCol, options, sheetIndex]) => {
  const range = vRangeRef([startRow, startCol, endRow, endCol, sheetIndex]);
  if (range !== true) return range;
  if (options === undefined || options === null) return true;
  if (typeof options !== "object" || Array.isArray(options)) {
    return "options must be an object { applyTo? }";
  }
  const o = options as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key !== "applyTo") return `unknown clear option "${key}" (allowed: applyTo)`;
  }
  if (o.applyTo !== undefined && !SCRIPT_CLEAR_APPLY_TO.has(o.applyTo as string)) {
    return `applyTo must be one of: ${[...SCRIPT_CLEAR_APPLY_TO].join(", ")}`;
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
// PROTECTION ATTRIBUTES ARE TIER-GATED, NOT ABSENT (Wave 3, item 8). The
// backend FormattingParams also carries `locked` / `formulaHidden` (and the
// checkbox/button cell-control flags). The cell-control flags stay out
// entirely; `locked`/`formulaHidden` are accepted ONLY by the UNLOCKED
// api.setRangeFormat row (vRangeFormatUnlocked below) — a DISTRIBUTED script
// is forced to the restricted tier at pull, so packaged code can never unlock
// cells out from under the sheet protection that guards them.

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
 * RANGE-EDGE border keys (Wave 3, item 2). The six per-side keys above apply
 * their border to EVERY cell of the rectangle — outlining a table with
 * borderTop draws interior lines. These three describe the RECTANGLE instead:
 * the host decomposes them into the per-cell truth (outline = only the edge
 * cells get the respective side; insideHorizontal/insideVertical = only the
 * interior edges, on both adjoining cells, exactly as Excel stores them).
 * They are WRITE-ONLY vocabulary: a format read-back reports the decomposed
 * per-cell sides, never these keys.
 */
const RANGE_BORDER_KEYS = [
  "borderOutline", "borderInsideHorizontal", "borderInsideVertical",
] as const;
export const SCRIPT_RANGE_BORDER_KEYS: ReadonlySet<string> = new Set(RANGE_BORDER_KEYS);

/**
 * Every key `setRangeFormat` accepts, with its shape. Exported so the tests and
 * the scaffold/docs surface enumerate the SAME set the broker enforces.
 */
export const SCRIPT_FORMAT_KEYS: ReadonlySet<string> = new Set([
  "bold", "italic", "underline", "strikethrough",
  "fontSize", "fontFamily", "textColor", "backgroundColor",
  "textAlign", "verticalAlign", "numberFormat",
  "wrapText", "textRotation", "indent", "shrinkToFit",
  "fill",
  ...BORDER_KEYS,
  ...RANGE_BORDER_KEYS,
]);

/** `#RRGGBB` or `#RRGGBBAA` (the `#` is optional — Rust's Color::from_hex trims it). */
function isHexColor(v: unknown): boolean {
  return typeof v === "string" && /^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v);
}

// ============================================================================
// Theme colors (Wave 4, formatting breadth)
// ============================================================================
// Wherever a format key takes a color, it takes a HEX STRING or a THEME
// REFERENCE `{ theme, tint? }`. The slot names are the engine's 12 OOXML slots
// (theme.rs ThemeColorSlot::from_key, key for key); `tint` is a FRACTION in
// -1..1 (positive = lighter, negative = darker — the host converts to the
// backend's permille form). textColor/backgroundColor theme refs ride the
// FormattingParams *_theme/*_tint fields and READ BACK as the theme object;
// border-side theme refs are resolved to their current hex at write time (the
// border pipeline stores absolute colors only) and read back as that hex.

/** The 12 theme color slots (mirrors engine ThemeColorSlot keys). */
export const SCRIPT_THEME_SLOTS: ReadonlySet<string> = new Set([
  "dark1", "light1", "dark2", "light2",
  "accent1", "accent2", "accent3", "accent4", "accent5", "accent6",
  "hyperlink", "followedHyperlink",
]);

/** One color value: hex string OR `{ theme, tint? }`. Exported for tests. */
export function checkColorValue(key: string, v: unknown): true | string {
  if (isHexColor(v)) return true;
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    const c = v as Record<string, unknown>;
    for (const k of Object.keys(c)) {
      if (c[k] === undefined) continue;
      if (k !== "theme" && k !== "tint") {
        return `${key}.${k} is not a theme-color property (use theme, tint)`;
      }
    }
    if (!SCRIPT_THEME_SLOTS.has(c.theme as string)) {
      return `${key}.theme must be one of: ${[...SCRIPT_THEME_SLOTS].join(", ")}`;
    }
    if (c.tint !== undefined && (!isFiniteNumber(c.tint) || c.tint < -1 || c.tint > 1)) {
      return `${key}.tint must be a number between -1 (darkest) and 1 (lightest)`;
    }
    return true;
  }
  return `${key} must be a hex color like "#RRGGBB" or a theme reference { theme, tint? }`;
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
  return checkColorValue(`${key}.color`, side.color);
}

// ============================================================================
// Pattern / gradient fills (Wave 4, formatting breadth)
// ============================================================================
// The `fill` format key mirrors the engine's Fill enum (style.rs) through the
// FillParam the backend already parses (styles.rs parse_fill_param /
// parse_pattern_type / parse_gradient_direction) — enumerated HERE so a typo'd
// pattern name fails with the accepted list instead of silently becoming
// PatternType::None. `{ type: "none" }` removes the fill (back to the default
// background); `backgroundColor` remains the shorthand for a solid fill.

/** Excel's pattern vocabulary (mirrors parse_pattern_type, word for word). */
export const SCRIPT_FILL_PATTERN_TYPES: ReadonlySet<string> = new Set([
  "solid", "darkGray", "mediumGray", "lightGray", "gray125", "gray0625",
  "darkHorizontal", "darkVertical", "darkDown", "darkUp", "darkGrid", "darkTrellis",
  "lightHorizontal", "lightVertical", "lightDown", "lightUp", "lightGrid", "lightTrellis",
]);

/** Gradient directions (mirrors parse_gradient_direction, word for word). */
export const SCRIPT_GRADIENT_DIRECTIONS: ReadonlySet<string> = new Set([
  "horizontal", "vertical", "diagonalDown", "diagonalUp", "fromCenter",
]);

/** Keys legal per fill type ("type" itself included). */
const FILL_TYPE_KEYS: Record<string, string[]> = {
  none: ["type"],
  solid: ["type", "color"],
  pattern: ["type", "patternType", "fgColor", "bgColor"],
  gradient: ["type", "color1", "color2", "direction"],
};

/** One fill spec. Exported for tests and the setState aspect gate. */
export function checkFillParam(v: unknown): true | string {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return 'fill must be an object { type: "none" | "solid" | "pattern" | "gradient", ... }';
  }
  const f = v as Record<string, unknown>;
  const type = f.type;
  if (typeof type !== "string" || !(type in FILL_TYPE_KEYS)) {
    return `fill.type must be one of: ${Object.keys(FILL_TYPE_KEYS).join(", ")}`;
  }
  const allowed = FILL_TYPE_KEYS[type];
  for (const key of Object.keys(f)) {
    if (f[key] === undefined) continue;
    if (!allowed.includes(key)) {
      return `unknown fill key "${key}" for type "${type}" (allowed: ${allowed.join(", ")})`;
    }
  }
  switch (type) {
    case "none":
      return true;
    case "solid":
      return checkColorValue("fill.color", f.color);
    case "pattern": {
      if (!SCRIPT_FILL_PATTERN_TYPES.has(f.patternType as string)) {
        return `fill.patternType must be one of: ${[...SCRIPT_FILL_PATTERN_TYPES].join(", ")}`;
      }
      const fg = checkColorValue("fill.fgColor", f.fgColor);
      if (fg !== true) return fg;
      return checkColorValue("fill.bgColor", f.bgColor);
    }
    default: {
      // gradient
      if (!SCRIPT_GRADIENT_DIRECTIONS.has(f.direction as string)) {
        return `fill.direction must be one of: ${[...SCRIPT_GRADIENT_DIRECTIONS].join(", ")}`;
      }
      const c1 = checkColorValue("fill.color1", f.color1);
      if (c1 !== true) return c1;
      return checkColorValue("fill.color2", f.color2);
    }
  }
}

/**
 * Validate a partial format object. Only the properties present are changed —
 * an absent key leaves that attribute alone, so a script can bold a range
 * without resetting its font or number format.
 *
 * `allowProtection` admits the `locked` / `formulaHidden` booleans — passed
 * ONLY by vRangeFormatUnlocked (the api.setRangeFormat row); every other
 * caller keeps the refusal, with a message that says WHY rather than
 * pretending the key is unknown.
 */
export function checkFormatObject(
  format: unknown,
  opts?: { allowProtection?: boolean },
): true | string {
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
    if (key === "locked" || key === "formulaHidden") {
      if (!opts?.allowProtection) {
        return (
          `"${key}" is a sheet-protection attribute, not formatting — ` +
          "only the unlocked api.setRangeFormat may change it"
        );
      }
      if (value === undefined) continue; // explicit undefined = "leave alone"
      if (typeof value !== "boolean") return `${key} must be a boolean`;
      continue;
    }
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
      case "backgroundColor": {
        const verdict = checkColorValue(key, value);
        if (verdict !== true) return verdict;
        break;
      }
      case "fill": {
        const verdict = checkFillParam(value);
        if (verdict !== true) return verdict;
        break;
      }
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

/**
 * api.setRangeFormat args (the UNLOCKED row only): same shape as vRangeFormat,
 * but the protection attributes `locked` / `formulaHidden` are accepted. The
 * restricted-tier rows keep vRangeFormat — a distributed script must not be
 * able to unlock cells (see the tier note at the top of this section).
 */
export const vRangeFormatUnlocked: Validator = ([startRow, startCol, endRow, endCol, format, sheetIndex]) => {
  const rect = vRangeRef([startRow, startCol, endRow, endCol, sheetIndex]);
  if (rect !== true) return rect;
  return checkFormatObject(format, { allowProtection: true });
};

// ============================================================================
// Named cell styles (Wave 4, formatting breadth)
// ============================================================================
// VBA's Styles collection / Range.Style, over the SAME named_styles commands
// the Cell Styles gallery uses. A style NAME is just a display string (the
// backend map is name-keyed); the length cap mirrors sheet names.

const MAX_NAMED_STYLE_NAME = 255;

function checkNamedStyleName(name: unknown): true | string {
  if (!isBoundedString(name, MAX_NAMED_STYLE_NAME) || name.trim().length === 0) {
    return `style name must be a non-empty string (max ${MAX_NAMED_STYLE_NAME} chars)`;
  }
  return true;
}

/** api.deleteNamedStyle args: [name]. */
export const vNamedStyleName: Validator = ([name]) => checkNamedStyleName(name);

/** api.applyNamedStyle args: [name, startRow, startCol, endRow, endCol, sheet?]. */
export const vNamedStyleApply: Validator = ([name, startRow, startCol, endRow, endCol, sheetIndex]) => {
  const named = checkNamedStyleName(name);
  if (named !== true) return named;
  return vRangeRef([startRow, startCol, endRow, endCol, sheetIndex]);
};

/**
 * api.createNamedStyle args: [name, format]. The format is the SAME enumerated
 * gate setRangeFormat uses, minus what makes no sense in a per-cell style: the
 * three RANGE-EDGE border keys (a named style has no rectangle to decompose
 * against) and the protection attributes (a distributed script must not mint
 * an unlocking style; use the unlocked api.setRangeFormat on the cells).
 */
export const vNamedStyleCreate: Validator = ([name, format]) => {
  const named = checkNamedStyleName(name);
  if (named !== true) return named;
  if (typeof format === "object" && format !== null && !Array.isArray(format)) {
    for (const key of Object.keys(format as Record<string, unknown>)) {
      if (SCRIPT_RANGE_BORDER_KEYS.has(key)) {
        return (
          `"${key}" describes a rectangle, but a named style is PER-CELL — ` +
          "use borderTop / borderRight / borderBottom / borderLeft instead"
        );
      }
    }
  }
  return checkFormatObject(format);
};

// ============================================================================
// Format READ-BACK + calculation control + sheet protection (Wave 3)
// ============================================================================
// The read rows (api.getRangeFormat / api.getCellFormat and their sheet.*
// twins) reuse vRangeRef / vCellRef — a format read is addressed exactly like
// a value read. Below are the validators the new WRITE/CONTROL rows need.

/** The two calculation modes the backend stores (calculation.rs). The Rust
 *  setter is STRICT since the Wave-3 hardening: anything else — including the
 *  formerly-coerced "auto" — rejects with the accepted pair, so this gate and
 *  the backend agree spelling for spelling and getCalculationMode() === the
 *  value you set. */
export const SCRIPT_CALCULATION_MODES: ReadonlySet<string> = new Set([
  "automatic", "manual",
]);

/** api.setCalculationMode args: [mode]. */
export const vCalculationMode: Validator = ([mode]) => {
  if (!SCRIPT_CALCULATION_MODES.has(mode as string)) {
    return `mode must be one of: ${[...SCRIPT_CALCULATION_MODES].join(", ")}`;
  }
  return true;
};

/** api.recalculate args: [options?] — { full?: boolean }. Default (and
 *  full: false) recalculates the active sheet; full: true the whole workbook. */
export const vRecalculate: Validator = ([options]) => {
  if (options === undefined || options === null) return true;
  if (typeof options !== "object" || Array.isArray(options)) {
    return "options must be an object { full? }";
  }
  const o = options as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key !== "full") return `unknown recalculate option "${key}" (allowed: full)`;
  }
  if (o.full !== undefined && typeof o.full !== "boolean") {
    return "options.full must be a boolean";
  }
  return true;
};

/** The boolean permission flags of SheetProtectionOptions (mirrors the Rust
 *  struct in protection.rs / the backend.ts interface, key for key). */
export const SHEET_PROTECTION_OPTION_KEYS: ReadonlySet<string> = new Set([
  "allowSelectLockedCells", "allowSelectUnlockedCells",
  "allowFormatCells", "allowFormatColumns", "allowFormatRows",
  "allowInsertColumns", "allowInsertRows", "allowInsertHyperlinks",
  "allowDeleteColumns", "allowDeleteRows",
  "allowSort", "allowAutoFilter", "allowPivotTables",
  "allowEditObjects", "allowEditScenarios",
]);

const MAX_PROTECTION_PASSWORD = 255;

/**
 * api.protectSheet args: [options?, sheet?]. `options` is the full
 * SheetProtectionOptions flag set (all optional; omitted flags take the same
 * defaults the Protect Sheet dialog uses) plus `password`.
 *
 * `scriptsCanEdit` (VBA's UserInterfaceOnly) is recognized and REFUSED with
 * the reason: the backend write gates check sheet protection for script
 * writes exactly as for keystrokes, and plumbing a scripts-exempt flag
 * through every write path is a Rust-side change this wave did not make.
 * Refusing loudly beats accepting a flag that silently does nothing.
 */
export const vProtectSheet: Validator = ([options, sheetIndex]) => {
  if (options !== undefined && options !== null) {
    if (typeof options !== "object" || Array.isArray(options)) {
      return "options must be an object (protection flags + password?)";
    }
    const o = options as Record<string, unknown>;
    for (const key of Object.keys(o)) {
      const value = o[key];
      if (value === undefined) continue;
      if (key === "password") {
        if (!isBoundedString(value, MAX_PROTECTION_PASSWORD)) {
          return `password must be a string (max ${MAX_PROTECTION_PASSWORD} chars)`;
        }
        continue;
      }
      if (key === "scriptsCanEdit") {
        return (
          "scriptsCanEdit (UserInterfaceOnly) is not supported yet: sheet " +
          "protection currently binds scripts exactly as it binds the user, " +
          "so protecting a sheet also blocks this script's own writes to its " +
          "locked cells"
        );
      }
      if (!SHEET_PROTECTION_OPTION_KEYS.has(key)) {
        return `unknown protection option "${key}" (allowed: password, ${[...SHEET_PROTECTION_OPTION_KEYS].join(", ")})`;
      }
      if (typeof value !== "boolean") return `${key} must be a boolean`;
    }
  }
  return checkOptionalSheetRef(sheetIndex);
};

/** api.unprotectSheet args: [password?, sheet?]. A wrong password answers
 *  false host-side — it is never a validation error. */
export const vUnprotectSheet: Validator = ([password, sheetIndex]) => {
  if (password !== undefined && password !== null && !isBoundedString(password, MAX_PROTECTION_PASSWORD)) {
    return `password must be a string (max ${MAX_PROTECTION_PASSWORD} chars)`;
  }
  return checkOptionalSheetRef(sheetIndex);
};

/** api.getProtectionStatus args: [sheet?] — just the optional sheet ref. */
export const vProtectionStatus: Validator = ([sheetIndex]) =>
  checkOptionalSheetRef(sheetIndex);

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
  return checkOptionalSheetRef(sheetIndex);
};

/** setRowHeight / setColumnWidth args: [index, size, sheetIndex?]. `size` is in
 *  pixels; 0 clears the override and restores the sheet default. */
export const vDimension: Validator = ([index, size, sheetIndex]) => {
  if (!isCellCoord(index)) return "index must be a non-negative integer";
  if (!isFiniteNumber(size) || size < 0 || size > 4096) {
    return "size must be a number between 0 and 4096 pixels (0 restores the default)";
  }
  return checkOptionalSheetRef(sheetIndex);
};

/** The most columns (or rows) one auto-fit call may measure. Measurement is
 *  canvas text metrics per non-empty cell, so it is priced like a big read,
 *  not like a resize. */
export const MAX_AUTOFIT_SPAN = 10_000;

/** autoFitColumns / autoFitRows args: [start, end, sheetIndex?] — an INCLUSIVE
 *  index span, mirroring the double-click best-fit's multi-select behavior. */
export const vAutoFitSpan: Validator = ([start, end, sheetIndex]) => {
  if (!isCellCoord(start)) return "start must be a non-negative integer";
  if (!isCellCoord(end)) return "end must be a non-negative integer";
  if ((end as number) < (start as number)) return "end must be >= start";
  const span = (end as number) - (start as number) + 1;
  if (span > MAX_AUTOFIT_SPAN) {
    return `span too large: ${span} (max ${MAX_AUTOFIT_SPAN})`;
  }
  return checkOptionalSheetRef(sheetIndex);
};

/** What api.fillRange accepts for options.direction / options.type. */
const FILL_DIRECTIONS = new Set(["down", "up", "right", "left"]);
const FILL_TYPES = new Set(["copy", "series"]);

/** fillRange args: [startRow, startCol, endRow, endCol, options?, sheetIndex?].
 *  The rectangle is SOURCE + TARGET together (Excel's FillDown shape): the
 *  band of `sourceSize` rows/columns at the edge filling starts from seeds the
 *  rest. `sourceSize` past the range's extent along the fill axis is refused
 *  (there would be nothing left to fill and no honest way to guess a band). */
export const vFillRange: Validator = ([startRow, startCol, endRow, endCol, options, sheetIndex]) => {
  const rect = vRangeRef([startRow, startCol, endRow, endCol, sheetIndex]);
  if (rect !== true) return rect;
  if (options === undefined || options === null) return true;
  if (typeof options !== "object" || Array.isArray(options)) {
    return "options must be an object { direction?, type?, sourceSize? }";
  }
  const o = options as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!["direction", "type", "sourceSize"].includes(key)) {
      return `unknown fill option "${key}" (allowed: direction, type, sourceSize)`;
    }
  }
  const direction = o.direction === undefined ? "down" : o.direction;
  if (!FILL_DIRECTIONS.has(direction as string)) {
    return `direction must be one of: ${[...FILL_DIRECTIONS].join(", ")}`;
  }
  if (o.type !== undefined && !FILL_TYPES.has(o.type as string)) {
    return `type must be one of: ${[...FILL_TYPES].join(", ")}`;
  }
  if (o.sourceSize !== undefined) {
    if (!isFiniteNumber(o.sourceSize) || !Number.isInteger(o.sourceSize) || o.sourceSize < 1) {
      return "sourceSize must be an integer >= 1";
    }
    const axisSpan =
      direction === "down" || direction === "up"
        ? (endRow as number) - (startRow as number) + 1
        : (endCol as number) - (startCol as number) + 1;
    if (o.sourceSize > axisSpan) {
      return `sourceSize (${o.sourceSize}) exceeds the range's ${
        direction === "down" || direction === "up" ? "row" : "column"
      } count (${axisSpan})`;
    }
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
// Data validation (Wave 3, item 5)
// ============================================================================
// The script-facing rule is FLAT (type + operator + formulas + messages +
// dropdown flag); the host maps it onto the backend's nested DataValidation
// union. The type strings mirror the serde tags in data_validation.rs /
// core/types DataValidationRule EXACTLY (minus "none": clearing is
// clearDataValidation, never a rule). Per-type key enumeration, so an unknown
// or out-of-place key fails HERE with the accepted list.

/** The rule types a script may set — the serde union tags, minus "none". */
export const SCRIPT_VALIDATION_TYPES: ReadonlySet<string> = new Set([
  "wholeNumber", "decimal", "list", "date", "time", "textLength", "custom",
]);

/** Comparison operators (mirrors DataValidationOperator, key for key). */
export const SCRIPT_VALIDATION_OPERATORS: ReadonlySet<string> = new Set([
  "between", "notBetween", "equal", "notEqual",
  "greaterThan", "lessThan", "greaterThanOrEqual", "lessThanOrEqual",
]);

/** Error-alert styles (mirrors DataValidationAlertStyle). */
export const SCRIPT_VALIDATION_ALERT_STYLES: ReadonlySet<string> = new Set([
  "stop", "warning", "information",
]);

/** Most literal entries one list rule may carry. */
export const MAX_VALIDATION_LIST_VALUES = 1024;
const MAX_VALIDATION_TEXT = 2048;
const MAX_VALIDATION_FORMULA = 8192;

/** Keys legal for EVERY rule type (the message/behavior envelope). */
const VALIDATION_COMMON_KEYS = [
  "type", "ignoreBlanks",
  "inputTitle", "inputMessage", "showInput",
  "errorTitle", "errorMessage", "errorStyle", "showError",
];

/** Extra keys per rule type. */
const VALIDATION_TYPE_KEYS: Record<string, string[]> = {
  wholeNumber: ["operator", "formula1", "formula2"],
  decimal: ["operator", "formula1", "formula2"],
  date: ["operator", "formula1", "formula2"],
  time: ["operator", "formula1", "formula2"],
  textLength: ["operator", "formula1", "formula2"],
  custom: ["formula"],
  list: ["values", "sourceRange", "inCellDropdown"],
};

/**
 * One flat validation rule. Exported so the aspect/tests can gate the same
 * shape; returns `true` or the reason.
 */
export function checkValidationRule(rule: unknown): true | string {
  if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
    return "rule must be an object { type, ... }";
  }
  const r = rule as Record<string, unknown>;
  const type = r.type;
  if (!isBoundedString(type, 64) || !SCRIPT_VALIDATION_TYPES.has(type)) {
    return `rule.type must be one of: ${[...SCRIPT_VALIDATION_TYPES].join(", ")}`;
  }
  const allowed = [...VALIDATION_COMMON_KEYS, ...VALIDATION_TYPE_KEYS[type]];
  for (const key of Object.keys(r)) {
    if (r[key] === undefined) continue;
    if (!allowed.includes(key)) {
      return `unknown rule key "${key}" for type "${type}" (allowed: ${allowed.join(", ")})`;
    }
  }
  // The envelope, one gate for every type.
  if (r.ignoreBlanks !== undefined && typeof r.ignoreBlanks !== "boolean") {
    return "rule.ignoreBlanks must be a boolean";
  }
  for (const key of ["inputTitle", "inputMessage", "errorTitle", "errorMessage"]) {
    if (r[key] !== undefined && !isBoundedString(r[key], MAX_VALIDATION_TEXT)) {
      return `rule.${key} must be a string (max ${MAX_VALIDATION_TEXT} chars)`;
    }
  }
  for (const key of ["showInput", "showError"]) {
    if (r[key] !== undefined && typeof r[key] !== "boolean") {
      return `rule.${key} must be a boolean`;
    }
  }
  if (r.errorStyle !== undefined && !SCRIPT_VALIDATION_ALERT_STYLES.has(r.errorStyle as string)) {
    return `rule.errorStyle must be one of: ${[...SCRIPT_VALIDATION_ALERT_STYLES].join(", ")}`;
  }
  // The per-type payload.
  if (VALIDATION_TYPE_KEYS[type][0] === "operator") {
    // The five compare kinds: operator + formula1 (+ formula2 for the
    // two-bound operators).
    if (!SCRIPT_VALIDATION_OPERATORS.has(r.operator as string)) {
      return `rule.operator must be one of: ${[...SCRIPT_VALIDATION_OPERATORS].join(", ")}`;
    }
    if (!isFiniteNumber(r.formula1)) {
      return "rule.formula1 must be a number (dates and times use their serial-number form)";
    }
    const twoBound = r.operator === "between" || r.operator === "notBetween";
    if (twoBound && !isFiniteNumber(r.formula2)) {
      return `rule.formula2 is required for the "${r.operator}" operator`;
    }
    if (!twoBound && r.formula2 !== undefined) {
      return `rule.formula2 is only used with "between" / "notBetween"`;
    }
  } else if (type === "custom") {
    if (!isBoundedString(r.formula, MAX_VALIDATION_FORMULA) || r.formula.trim().length === 0) {
      return `rule.formula must be a non-empty formula string (max ${MAX_VALIDATION_FORMULA} chars)`;
    }
  } else {
    // list: exactly ONE source — literal values or a sheet range.
    const hasValues = r.values !== undefined;
    const hasRange = r.sourceRange !== undefined;
    if (hasValues === hasRange) {
      return "a list rule needs exactly one source: values (an array) OR sourceRange (a rectangle)";
    }
    if (hasValues) {
      if (!Array.isArray(r.values) || r.values.length === 0) {
        return "rule.values must be a non-empty array of strings";
      }
      if (r.values.length > MAX_VALIDATION_LIST_VALUES) {
        return `too many list values: ${r.values.length} (max ${MAX_VALIDATION_LIST_VALUES})`;
      }
      for (const v of r.values) {
        if (!isBoundedString(v, MAX_VALIDATION_TEXT)) {
          return `each list value must be a string (max ${MAX_VALIDATION_TEXT} chars)`;
        }
      }
    } else {
      const box = checkValidationBox(r.sourceRange, "rule.sourceRange");
      if (box !== true) return box;
      const sr = (r.sourceRange as Record<string, unknown>).sheetIndex;
      if (sr !== undefined && sr !== null && !isCellCoord(sr)) {
        return "rule.sourceRange.sheetIndex must be a non-negative 0-based sheet index";
      }
    }
    if (r.inCellDropdown !== undefined && typeof r.inCellDropdown !== "boolean") {
      return "rule.inCellDropdown must be a boolean";
    }
  }
  return true;
}

/** A plain rectangle object ({ startRow, startCol, endRow, endCol }). */
function checkValidationBox(v: unknown, label: string): true | string {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return `${label} must be an object { startRow, startCol, endRow, endCol }`;
  }
  const box = v as Record<string, unknown>;
  for (const key of ["startRow", "startCol", "endRow", "endCol"]) {
    if (!isCellCoord(box[key])) return `${label}.${key} must be a non-negative integer`;
  }
  if ((box.endRow as number) < (box.startRow as number)) return `${label}.endRow must be >= startRow`;
  if ((box.endCol as number) < (box.startCol as number)) return `${label}.endCol must be >= startCol`;
  return true;
}

/** api.setDataValidation args: [startRow, startCol, endRow, endCol, rule,
 *  sheet?]. NO cell-count ceiling on purpose: a validation range is ONE stored
 *  rule, not per-cell work, and whole-column validation is the normal case. */
export const vDataValidationSet: Validator = ([startRow, startCol, endRow, endCol, rule, sheetIndex]) => {
  const box = checkValidationBox({ startRow, startCol, endRow, endCol }, "range");
  if (box !== true) return box;
  const verdict = checkValidationRule(rule);
  if (verdict !== true) return verdict;
  return checkOptionalSheetRef(sheetIndex);
};

/** api.clearDataValidation args: [range, sheet?] — `range` is a rectangle. */
export const vDataValidationClear: Validator = ([range, sheetIndex]) => {
  const box = checkValidationBox(range, "range");
  if (box !== true) return box;
  return checkOptionalSheetRef(sheetIndex);
};

/** api.listDataValidations / api.listHyperlinks args: [sheet?]. */
export const vSheetScopedList: Validator = ([sheetIndex]) =>
  checkOptionalSheetRef(sheetIndex);

// ============================================================================
// Hyperlinks (Wave 3, item 6)
// ============================================================================
// api.addHyperlink args: [row, col, link, options?, sheet?]. `link` is a typed
// union on `type` (the serde HyperlinkType tags); per-type key enumeration so
// an out-of-place key fails with the accepted list. There is deliberately NO
// "follow" method anywhere: navigation to internal targets is api.select /
// scrollTo; opening external targets from a script is not a grid op.

/** The link types (mirrors HyperlinkType, tag for tag). */
export const SCRIPT_HYPERLINK_TYPES: ReadonlySet<string> = new Set([
  "url", "email", "internalReference", "file",
]);

const MAX_HYPERLINK_TARGET = 2048;
const MAX_HYPERLINK_TEXT = 1024;

const HYPERLINK_TYPE_KEYS: Record<string, string[]> = {
  url: ["type", "target"],
  file: ["type", "target"],
  email: ["type", "target", "subject"],
  internalReference: ["type", "cellReference", "sheetName"],
};

/** One link spec. Exported for tests. */
export function checkHyperlinkSpec(link: unknown): true | string {
  if (typeof link !== "object" || link === null || Array.isArray(link)) {
    return "link must be an object { type, ... }";
  }
  const l = link as Record<string, unknown>;
  const type = l.type;
  if (!isBoundedString(type, 64) || !SCRIPT_HYPERLINK_TYPES.has(type)) {
    return `link.type must be one of: ${[...SCRIPT_HYPERLINK_TYPES].join(", ")}`;
  }
  const allowed = HYPERLINK_TYPE_KEYS[type];
  for (const key of Object.keys(l)) {
    if (l[key] === undefined) continue;
    if (!allowed.includes(key)) {
      return `unknown link key "${key}" for type "${type}" (allowed: ${allowed.join(", ")})`;
    }
  }
  if (type === "internalReference") {
    if (!isBoundedString(l.cellReference, 64) || l.cellReference.trim().length === 0) {
      return 'link.cellReference must be an A1 cell reference like "B4"';
    }
    if (l.sheetName !== undefined && l.sheetName !== null) {
      const named = checkSheetName(l.sheetName);
      if (named !== true) return `link.sheetName: ${named}`;
    }
  } else {
    if (!isBoundedString(l.target, MAX_HYPERLINK_TARGET) || l.target.trim().length === 0) {
      return `link.target must be a non-empty string (max ${MAX_HYPERLINK_TARGET} chars)`;
    }
    if (type === "email" && l.subject !== undefined && !isBoundedString(l.subject, MAX_HYPERLINK_TEXT)) {
      return `link.subject must be a string (max ${MAX_HYPERLINK_TEXT} chars)`;
    }
  }
  return true;
}

/** api.addHyperlink args: [row, col, link, options?, sheet?]. */
export const vAddHyperlink: Validator = ([row, col, link, options, sheetIndex]) => {
  if (!isCellCoord(row)) return "row must be a non-negative integer";
  if (!isCellCoord(col)) return "col must be a non-negative integer";
  const spec = checkHyperlinkSpec(link);
  if (spec !== true) return spec;
  if (options !== undefined && options !== null) {
    if (typeof options !== "object" || Array.isArray(options)) {
      return "options must be an object { displayText?, tooltip? }";
    }
    const o = options as Record<string, unknown>;
    for (const key of Object.keys(o)) {
      if (o[key] === undefined) continue;
      if (key !== "displayText" && key !== "tooltip") {
        return `unknown hyperlink option "${key}" (allowed: displayText, tooltip)`;
      }
      if (!isBoundedString(o[key], MAX_HYPERLINK_TEXT)) {
        return `${key} must be a string (max ${MAX_HYPERLINK_TEXT} chars)`;
      }
    }
  }
  return checkOptionalSheetRef(sheetIndex);
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

/** renameSheet args: [sheet, newName] — `sheet` is a 0-based index or a name. */
export const vSheetRename: Validator = ([sheet, newName]) => {
  const ref = checkSheetRef(sheet, "sheet");
  if (ref !== true) return ref;
  return checkSheetName(newName);
};

/** setSheetVisibility args: [sheet, visibility] — `sheet` is an index or a name. */
export const vSheetVisibility: Validator = ([sheet, visibility]) => {
  const ref = checkSheetRef(sheet, "sheet");
  if (ref !== true) return ref;
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
/** Longest A1 spelling accepted where a range option may be a string. */
const MAX_A1_RANGE_TEXT = 64;

/**
 * A range OPTION (Wave 4): a plain rectangle { startRow, startCol, endRow,
 * endCol } or an A1 spelling ("B2:D10", resolved host-side). Shared by the
 * find/replace `range` option; the box must be normalized (end >= start) —
 * the executors clamp results, they do not repair geometry.
 */
function checkRangeOption(v: unknown, label: string): true | string {
  if (typeof v === "string") {
    if (!isBoundedString(v, MAX_A1_RANGE_TEXT) || v.trim().length === 0) {
      return `${label} must be an A1 range like "B2:D10" (max ${MAX_A1_RANGE_TEXT} chars)`;
    }
    return true;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return `${label} must be an A1 string or an object { startRow, startCol, endRow, endCol }`;
  }
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (o[k] === undefined) continue;
    if (!["startRow", "startCol", "endRow", "endCol"].includes(k)) {
      return `unknown ${label} key "${k}" (allowed: startRow, startCol, endRow, endCol)`;
    }
  }
  if (!isCellCoord(o.startRow)) return `${label}.startRow must be a non-negative integer`;
  if (!isCellCoord(o.startCol)) return `${label}.startCol must be a non-negative integer`;
  if (!isCellCoord(o.endRow)) return `${label}.endRow must be a non-negative integer`;
  if (!isCellCoord(o.endCol)) return `${label}.endCol must be a non-negative integer`;
  if ((o.endRow as number) < (o.startRow as number)) return `${label}.endRow must be >= startRow`;
  if ((o.endCol as number) < (o.startCol as number)) return `${label}.endCol must be >= startCol`;
  return true;
}

/** Boolean search flags, plus the Wave-3 `sheetIndex` slot (index or NAME —
 *  resolved host-side under the Wave-1 rules, like every other sheet ref) and
 *  the Wave-4 `range` clamp (a Box or an A1 spelling). */
function checkFindOptions(options: unknown, allowed: string[]): true | string {
  if (options === undefined || options === null) return true;
  if (typeof options !== "object" || Array.isArray(options)) return "options must be an object";
  const o = options as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) return `unknown search option "${k}" (allowed: ${allowed.join(", ")})`;
    if (k === "sheetIndex") {
      const ref = checkOptionalSheetRef(o[k], "options.sheetIndex");
      if (ref !== true) return ref;
      continue;
    }
    if (k === "range") {
      if (o[k] === undefined || o[k] === null) continue;
      const rect = checkRangeOption(o[k], "options.range");
      if (rect !== true) return rect;
      continue;
    }
    if (o[k] !== undefined && typeof o[k] !== "boolean") return `${k} must be a boolean`;
  }
  return true;
}

/** findAll args: [query, options?]. */
export const vFind: Validator = ([query, options]) => {
  if (!isBoundedString(query, MAX_SEARCH_TEXT) || query.length === 0) {
    return `query must be a non-empty string (max ${MAX_SEARCH_TEXT} chars)`;
  }
  return checkFindOptions(
    options,
    ["caseSensitive", "matchEntireCell", "searchFormulas", "sheetIndex", "range"],
  );
};

/** replaceAll args: [search, replacement, options?]. */
export const vReplace: Validator = ([search, replacement, options]) => {
  if (!isBoundedString(search, MAX_SEARCH_TEXT) || search.length === 0) {
    return `search must be a non-empty string (max ${MAX_SEARCH_TEXT} chars)`;
  }
  if (!isBoundedString(replacement, MAX_SEARCH_TEXT)) {
    return `replacement must be a string (max ${MAX_SEARCH_TEXT} chars)`;
  }
  return checkFindOptions(options, ["caseSensitive", "matchEntireCell", "sheetIndex", "range"]);
};

// ============================================================================
// Range ops (Wave 4, RANGE-OPS cluster): removeDuplicates / textToColumns /
// getSpecialCells / goalSeek
// ============================================================================

/** Most key columns one removeDuplicates call may name (one per column of the
 *  widest legal range is far below this). */
const MAX_KEY_COLUMNS = 1_024;
/** Most delimiters one textToColumns call may name. */
const MAX_DELIMITERS = 16;

/** removeDuplicates args: [startRow, startCol, endRow, endCol, options?, sheet?].
 *  `options.columns` are 0-based offsets FROM THE RANGE START (sortRange
 *  style) — bounded by the range's own width. */
export const vRemoveDuplicates: Validator = (
  [startRow, startCol, endRow, endCol, options, sheetIndex],
) => {
  const rect = vRangeRef([startRow, startCol, endRow, endCol, sheetIndex]);
  if (rect !== true) return rect;
  if (options === undefined || options === null) return true;
  if (typeof options !== "object" || Array.isArray(options)) {
    return "options must be an object { columns?, hasHeaders? }";
  }
  const o = options as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (o[k] === undefined) continue;
    if (!["columns", "hasHeaders"].includes(k)) {
      return `unknown removeDuplicates option "${k}" (allowed: columns, hasHeaders)`;
    }
  }
  if (o.hasHeaders !== undefined && typeof o.hasHeaders !== "boolean") {
    return "hasHeaders must be a boolean";
  }
  if (o.columns !== undefined) {
    if (!Array.isArray(o.columns) || o.columns.length === 0 || o.columns.length > MAX_KEY_COLUMNS) {
      return `columns must be a non-empty array of column offsets (max ${MAX_KEY_COLUMNS})`;
    }
    const width = (endCol as number) - (startCol as number) + 1;
    for (const c of o.columns) {
      if (!isFiniteNumber(c) || !Number.isInteger(c) || c < 0) {
        return "each columns entry must be a non-negative integer offset from the range start";
      }
      if (c >= width) {
        return `columns offset ${c} is outside the range (width ${width})`;
      }
    }
  }
  return true;
};

/** textToColumns args: [startRow, startCol, endRow, endCol, options?]. The
 *  source must be ONE column; the sheet slot rides in options.sheetIndex. */
export const vTextToColumns: Validator = ([startRow, startCol, endRow, endCol, options]) => {
  const rect = vRangeRef([startRow, startCol, endRow, endCol, undefined]);
  if (rect !== true) return rect;
  if (startCol !== endCol) return "textToColumns source must be a single column";
  if (options === undefined || options === null) return true;
  if (typeof options !== "object" || Array.isArray(options)) {
    return "options must be an object { delimiters?, consecutiveAsOne?, destination?, sheetIndex? }";
  }
  const o = options as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (o[k] === undefined) continue;
    if (!["delimiters", "consecutiveAsOne", "destination", "sheetIndex"].includes(k)) {
      return `unknown textToColumns option "${k}" (allowed: delimiters, consecutiveAsOne, destination, sheetIndex)`;
    }
  }
  if (o.delimiters !== undefined) {
    if (!Array.isArray(o.delimiters) || o.delimiters.length === 0 ||
        o.delimiters.length > MAX_DELIMITERS) {
      return `delimiters must be a non-empty array of single characters (max ${MAX_DELIMITERS})`;
    }
    for (const d of o.delimiters) {
      if (typeof d !== "string" || d.length !== 1) {
        return "each delimiter must be exactly one character";
      }
    }
  }
  if (o.consecutiveAsOne !== undefined && typeof o.consecutiveAsOne !== "boolean") {
    return "consecutiveAsOne must be a boolean";
  }
  if (o.destination !== undefined && o.destination !== null) {
    if (typeof o.destination !== "object" || Array.isArray(o.destination)) {
      return "destination must be an object { row, col }";
    }
    const dest = o.destination as Record<string, unknown>;
    for (const k of Object.keys(dest)) {
      if (dest[k] === undefined) continue;
      if (k !== "row" && k !== "col") {
        return `unknown destination key "${k}" (allowed: row, col)`;
      }
    }
    if (!isCellCoord(dest.row)) return "destination.row must be a non-negative integer";
    if (!isCellCoord(dest.col)) return "destination.col must be a non-negative integer";
  }
  return checkOptionalSheetRef(o.sheetIndex, "options.sheetIndex");
};

/** The cell classes api.getSpecialCells accepts (mirrors the backend's
 *  get_special_cells kinds). */
export const SPECIAL_CELLS_KINDS: ReadonlySet<string> = new Set([
  "constants", "formulas", "blanks", "visible",
]);

/** getSpecialCells args: [startRow, startCol, endRow, endCol, kind, sheet?]. */
export const vSpecialCells: Validator = (
  [startRow, startCol, endRow, endCol, kind, sheetIndex],
) => {
  const rect = vRangeRef([startRow, startCol, endRow, endCol, sheetIndex]);
  if (rect !== true) return rect;
  if (!isBoundedString(kind, 32) || !SPECIAL_CELLS_KINDS.has(kind)) {
    return `kind must be one of: ${[...SPECIAL_CELLS_KINDS].join(", ")}`;
  }
  return true;
};

/** Iteration ceiling a script may ask goal seek for. */
const MAX_GOAL_SEEK_ITERATIONS = 10_000;

/** goalSeek args: [params] — one object, mirroring the backend's
 *  GoalSeekParams plus the sheetIndex slot (which must resolve to the ACTIVE
 *  sheet; the executor refuses others). */
export const vGoalSeek: Validator = ([params]) => {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return "goalSeek takes one object { targetRow, targetCol, targetValue, variableRow, variableCol, maxIterations?, tolerance?, sheetIndex? }";
  }
  const p = params as Record<string, unknown>;
  const allowed = [
    "targetRow", "targetCol", "targetValue", "variableRow", "variableCol",
    "maxIterations", "tolerance", "sheetIndex",
  ];
  for (const k of Object.keys(p)) {
    if (p[k] === undefined) continue;
    if (!allowed.includes(k)) {
      return `unknown goalSeek key "${k}" (allowed: ${allowed.join(", ")})`;
    }
  }
  if (!isCellCoord(p.targetRow)) return "targetRow must be a non-negative integer";
  if (!isCellCoord(p.targetCol)) return "targetCol must be a non-negative integer";
  if (!isCellCoord(p.variableRow)) return "variableRow must be a non-negative integer";
  if (!isCellCoord(p.variableCol)) return "variableCol must be a non-negative integer";
  if (!isFiniteNumber(p.targetValue)) return "targetValue must be a finite number";
  if (p.targetRow === p.variableRow && p.targetCol === p.variableCol) {
    return "the target cell and the variable cell must be different cells";
  }
  if (p.maxIterations !== undefined) {
    if (!isFiniteNumber(p.maxIterations) || !Number.isInteger(p.maxIterations) ||
        p.maxIterations < 1 || p.maxIterations > MAX_GOAL_SEEK_ITERATIONS) {
      return `maxIterations must be an integer between 1 and ${MAX_GOAL_SEEK_ITERATIONS}`;
    }
  }
  if (p.tolerance !== undefined) {
    if (!isFiniteNumber(p.tolerance) || p.tolerance <= 0) {
      return "tolerance must be a positive number";
    }
  }
  return checkOptionalSheetRef(p.sheetIndex, "sheetIndex");
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

// ============================================================================
// Conditional formatting CRUD (Wave 3, item 3)
// ============================================================================
// The rule union mirrors the Rust serde shapes in conditional_formatting.rs
// EXACTLY: `type` is the serde variant tag (camelCase), and the per-kind keys
// are the struct's fields. Validation is by ENUMERATION, SCRIPT_FORMAT_KEYS
// style — an unknown key or kind is REJECTED with the accepted list, because a
// silently dropped `bgColor` typo leaves the script author staring at an
// unstyled grid with nothing to search for.

/** Every serde variant tag of ConditionalFormatRule (Rust `#[serde(tag = "type")]`). */
export const CF_RULE_KINDS: ReadonlySet<string> = new Set([
  "colorScale", "dataBar", "iconSet", "cellValue", "containsText",
  "topBottom", "aboveAverage", "duplicateValues", "uniqueValues",
  "expression", "blankCells", "noBlanks", "errorCells", "noErrors",
  "timePeriod",
]);

/** Rust CFValueType. */
const CF_VALUE_TYPES = new Set([
  "number", "percent", "formula", "percentile", "min", "max", "autoMin", "autoMax",
]);
const CF_DATA_BAR_DIRECTIONS = new Set(["context", "leftToRight", "rightToLeft"]);
const CF_DATA_BAR_AXIS_POSITIONS = new Set(["automatic", "cellMidpoint", "none"]);
const CF_ICON_SET_TYPES = new Set([
  "threeArrows", "threeArrowsGray", "threeFlags", "threeTrafficLights1",
  "threeTrafficLights2", "threeSigns", "threeSymbols", "threeSymbols2",
  "threeStars", "threeTriangles", "fourArrows", "fourArrowsGray", "fourRating",
  "fourTrafficLights", "fourRedToBlack", "fiveArrows", "fiveArrowsGray",
  "fiveRating", "fiveQuarters", "fiveBoxes",
]);
const CF_THRESHOLD_OPERATORS = new Set(["greaterThan", "greaterThanOrEqual"]);
const CF_CELL_VALUE_OPERATORS = new Set([
  "equal", "notEqual", "greaterThan", "greaterThanOrEqual",
  "lessThan", "lessThanOrEqual", "between", "notBetween",
]);
const CF_TEXT_RULE_TYPES = new Set(["contains", "notContains", "beginsWith", "endsWith"]);
const CF_TOP_BOTTOM_TYPES = new Set(["topItems", "topPercent", "bottomItems", "bottomPercent"]);
const CF_AVERAGE_RULE_TYPES = new Set([
  "aboveAverage", "belowAverage", "equalOrAboveAverage", "equalOrBelowAverage",
  "oneStdDevAbove", "oneStdDevBelow", "twoStdDevAbove", "twoStdDevBelow",
  "threeStdDevAbove", "threeStdDevBelow",
]);
const CF_TIME_PERIODS = new Set([
  "today", "yesterday", "tomorrow", "last7Days", "thisWeek", "lastWeek",
  "nextWeek", "thisMonth", "lastMonth", "nextMonth", "thisQuarter",
  "lastQuarter", "nextQuarter", "thisYear", "lastYear", "nextYear",
]);

/**
 * Every key the CF `format` object accepts (mirrors Rust ConditionalFormat).
 * DISTINCT from SCRIPT_FORMAT_KEYS: CF's `underline` is a BOOLEAN (not a
 * style word) and its borders are flat color/style string pairs.
 */
export const CF_FORMAT_KEYS: ReadonlySet<string> = new Set([
  "backgroundColor", "textColor", "bold", "italic", "underline",
  "strikethrough", "numberFormat",
  "borderTopColor", "borderTopStyle", "borderBottomColor", "borderBottomStyle",
  "borderLeftColor", "borderLeftStyle", "borderRightColor", "borderRightStyle",
]);
const CF_FORMAT_BOOLEAN_KEYS = new Set(["bold", "italic", "underline", "strikethrough"]);

/** The most ranges one CF rule may target. */
export const MAX_CF_RANGES = 64;
const MAX_CF_TEXT = 8192;
const MAX_CF_COLOR = 64;
const MAX_CF_THRESHOLDS = 16;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkOnlyKeys(
  o: Record<string, unknown>, label: string, allowed: readonly string[],
): true | string {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) {
      return `unknown ${label} property "${k}" (allowed: ${allowed.join(", ")})`;
    }
  }
  return true;
}

function checkCFColor(v: unknown, label: string): true | string {
  if (!isBoundedString(v, MAX_CF_COLOR) || v.length === 0) {
    return `${label} must be a non-empty color string (e.g. "#FF0000")`;
  }
  return true;
}

function checkColorScalePoint(v: unknown, label: string): true | string {
  if (!isPlainObject(v)) return `${label} must be an object { valueType, value?, formula?, color }`;
  const keys = checkOnlyKeys(v, label, ["valueType", "value", "formula", "color"]);
  if (keys !== true) return keys;
  if (!CF_VALUE_TYPES.has(v.valueType as string)) {
    return `${label}.valueType must be one of: ${[...CF_VALUE_TYPES].join(", ")}`;
  }
  if (v.value !== undefined && !isFiniteNumber(v.value)) return `${label}.value must be a finite number`;
  if (v.formula !== undefined && !isBoundedString(v.formula, MAX_CF_TEXT)) {
    return `${label}.formula must be a string (max ${MAX_CF_TEXT} chars)`;
  }
  return checkCFColor(v.color, `${label}.color`);
}

function checkIconSetThreshold(v: unknown, label: string): true | string {
  if (!isPlainObject(v)) return `${label} must be an object { valueType, value, operator, formula? }`;
  const keys = checkOnlyKeys(v, label, ["valueType", "value", "operator", "formula"]);
  if (keys !== true) return keys;
  if (!CF_VALUE_TYPES.has(v.valueType as string)) {
    return `${label}.valueType must be one of: ${[...CF_VALUE_TYPES].join(", ")}`;
  }
  if (!isFiniteNumber(v.value)) return `${label}.value must be a finite number`;
  if (!CF_THRESHOLD_OPERATORS.has(v.operator as string)) {
    return `${label}.operator must be one of: ${[...CF_THRESHOLD_OPERATORS].join(", ")}`;
  }
  if (v.formula !== undefined && !isBoundedString(v.formula, MAX_CF_TEXT)) {
    return `${label}.formula must be a string (max ${MAX_CF_TEXT} chars)`;
  }
  return true;
}

/** One CF RULE, per kind — the union's serde shape, enumerated. */
export function checkCFRule(rule: unknown): true | string {
  if (!isPlainObject(rule)) return "rule must be an object with a `type` key";
  const kind = rule.type;
  if (!isBoundedString(kind, 64) || !CF_RULE_KINDS.has(kind)) {
    return `rule.type must be one of: ${[...CF_RULE_KINDS].join(", ")}`;
  }
  switch (kind) {
    case "colorScale": {
      const keys = checkOnlyKeys(rule, "colorScale", ["type", "minPoint", "midPoint", "maxPoint"]);
      if (keys !== true) return keys;
      const min = checkColorScalePoint(rule.minPoint, "minPoint");
      if (min !== true) return min;
      if (rule.midPoint !== undefined) {
        const mid = checkColorScalePoint(rule.midPoint, "midPoint");
        if (mid !== true) return mid;
      }
      return checkColorScalePoint(rule.maxPoint, "maxPoint");
    }
    case "dataBar": {
      const keys = checkOnlyKeys(rule, "dataBar", [
        "type", "minValueType", "minValue", "minFormula", "maxValueType",
        "maxValue", "maxFormula", "fillColor", "borderColor",
        "negativeFillColor", "negativeBorderColor", "axisColor",
        "axisPosition", "direction", "showValue", "gradientFill",
      ]);
      if (keys !== true) return keys;
      for (const k of ["minValueType", "maxValueType"] as const) {
        if (!CF_VALUE_TYPES.has(rule[k] as string)) {
          return `dataBar.${k} must be one of: ${[...CF_VALUE_TYPES].join(", ")}`;
        }
      }
      for (const k of ["minValue", "maxValue"] as const) {
        if (rule[k] !== undefined && !isFiniteNumber(rule[k])) return `dataBar.${k} must be a finite number`;
      }
      for (const k of ["minFormula", "maxFormula"] as const) {
        if (rule[k] !== undefined && !isBoundedString(rule[k], MAX_CF_TEXT)) {
          return `dataBar.${k} must be a string (max ${MAX_CF_TEXT} chars)`;
        }
      }
      const fill = checkCFColor(rule.fillColor, "dataBar.fillColor");
      if (fill !== true) return fill;
      for (const k of ["borderColor", "negativeFillColor", "negativeBorderColor", "axisColor"] as const) {
        if (rule[k] !== undefined) {
          const c = checkCFColor(rule[k], `dataBar.${k}`);
          if (c !== true) return c;
        }
      }
      if (!CF_DATA_BAR_AXIS_POSITIONS.has(rule.axisPosition as string)) {
        return `dataBar.axisPosition must be one of: ${[...CF_DATA_BAR_AXIS_POSITIONS].join(", ")}`;
      }
      if (!CF_DATA_BAR_DIRECTIONS.has(rule.direction as string)) {
        return `dataBar.direction must be one of: ${[...CF_DATA_BAR_DIRECTIONS].join(", ")}`;
      }
      if (typeof rule.showValue !== "boolean") return "dataBar.showValue must be a boolean";
      if (typeof rule.gradientFill !== "boolean") return "dataBar.gradientFill must be a boolean";
      return true;
    }
    case "iconSet": {
      const keys = checkOnlyKeys(rule, "iconSet", [
        "type", "iconSet", "thresholds", "reverseIcons", "showIconOnly",
      ]);
      if (keys !== true) return keys;
      if (!CF_ICON_SET_TYPES.has(rule.iconSet as string)) {
        return `iconSet.iconSet must be one of: ${[...CF_ICON_SET_TYPES].join(", ")}`;
      }
      if (!Array.isArray(rule.thresholds) || rule.thresholds.length > MAX_CF_THRESHOLDS) {
        return `iconSet.thresholds must be an array (max ${MAX_CF_THRESHOLDS})`;
      }
      for (let i = 0; i < rule.thresholds.length; i++) {
        const t = checkIconSetThreshold(rule.thresholds[i], `thresholds[${i}]`);
        if (t !== true) return t;
      }
      if (typeof rule.reverseIcons !== "boolean") return "iconSet.reverseIcons must be a boolean";
      if (typeof rule.showIconOnly !== "boolean") return "iconSet.showIconOnly must be a boolean";
      return true;
    }
    case "cellValue": {
      const keys = checkOnlyKeys(rule, "cellValue", ["type", "operator", "value1", "value2"]);
      if (keys !== true) return keys;
      if (!CF_CELL_VALUE_OPERATORS.has(rule.operator as string)) {
        return `cellValue.operator must be one of: ${[...CF_CELL_VALUE_OPERATORS].join(", ")}`;
      }
      if (!isBoundedString(rule.value1, MAX_CF_TEXT)) {
        return `cellValue.value1 must be a string (max ${MAX_CF_TEXT} chars; a literal or a formula)`;
      }
      if (rule.value2 !== undefined && !isBoundedString(rule.value2, MAX_CF_TEXT)) {
        return `cellValue.value2 must be a string (max ${MAX_CF_TEXT} chars)`;
      }
      return true;
    }
    case "containsText": {
      const keys = checkOnlyKeys(rule, "containsText", ["type", "ruleType", "text"]);
      if (keys !== true) return keys;
      if (!CF_TEXT_RULE_TYPES.has(rule.ruleType as string)) {
        return `containsText.ruleType must be one of: ${[...CF_TEXT_RULE_TYPES].join(", ")}`;
      }
      if (!isBoundedString(rule.text, MAX_CF_TEXT) || rule.text.length === 0) {
        return `containsText.text must be a non-empty string (max ${MAX_CF_TEXT} chars)`;
      }
      return true;
    }
    case "topBottom": {
      const keys = checkOnlyKeys(rule, "topBottom", ["type", "ruleType", "rank"]);
      if (keys !== true) return keys;
      if (!CF_TOP_BOTTOM_TYPES.has(rule.ruleType as string)) {
        return `topBottom.ruleType must be one of: ${[...CF_TOP_BOTTOM_TYPES].join(", ")}`;
      }
      if (!isFiniteNumber(rule.rank) || !Number.isInteger(rule.rank) || rule.rank < 1 || rule.rank > 1_000_000) {
        return "topBottom.rank must be an integer between 1 and 1000000";
      }
      return true;
    }
    case "aboveAverage": {
      const keys = checkOnlyKeys(rule, "aboveAverage", ["type", "ruleType"]);
      if (keys !== true) return keys;
      if (!CF_AVERAGE_RULE_TYPES.has(rule.ruleType as string)) {
        return `aboveAverage.ruleType must be one of: ${[...CF_AVERAGE_RULE_TYPES].join(", ")}`;
      }
      return true;
    }
    case "timePeriod": {
      const keys = checkOnlyKeys(rule, "timePeriod", ["type", "period"]);
      if (keys !== true) return keys;
      if (!CF_TIME_PERIODS.has(rule.period as string)) {
        return `timePeriod.period must be one of: ${[...CF_TIME_PERIODS].join(", ")}`;
      }
      return true;
    }
    case "expression": {
      const keys = checkOnlyKeys(rule, "expression", ["type", "formula"]);
      if (keys !== true) return keys;
      if (!isBoundedString(rule.formula, MAX_CF_TEXT) || rule.formula.length === 0) {
        return `expression.formula must be a non-empty string (max ${MAX_CF_TEXT} chars)`;
      }
      return true;
    }
    // Unit variants: `type` is the whole payload.
    default:
      return checkOnlyKeys(rule, kind, ["type"]);
  }
}

/** The CF `format` object (what to apply on a match), enumerated. */
export function checkCFFormat(format: unknown): true | string {
  if (!isPlainObject(format)) return "format must be an object";
  for (const key of Object.keys(format)) {
    const value = format[key];
    if (!CF_FORMAT_KEYS.has(key)) {
      return `unknown format property "${key}" (allowed: ${[...CF_FORMAT_KEYS].join(", ")})`;
    }
    if (value === undefined) continue;
    if (CF_FORMAT_BOOLEAN_KEYS.has(key)) {
      if (typeof value !== "boolean") return `${key} must be a boolean`;
    } else if (!isBoundedString(value, 255) || value.length === 0) {
      return `${key} must be a non-empty string (max 255 chars)`;
    }
  }
  return true;
}

/** One numeric CF range box. A1 spellings resolve WORKER-side (Wave-1 style),
 *  so by the time the broker sees a range it is always this numeric shape. */
function checkCFRangeBox(v: unknown, label: string): true | string {
  if (!isPlainObject(v)) {
    return `${label} must be an object { startRow, startCol, endRow, endCol }`;
  }
  const keys = checkOnlyKeys(v, label, ["startRow", "startCol", "endRow", "endCol"]);
  if (keys !== true) return keys;
  for (const k of ["startRow", "startCol", "endRow", "endCol"] as const) {
    if (!isCellCoord(v[k])) return `${label}.${k} must be a non-negative integer`;
  }
  const b = v as { startRow: number; startCol: number; endRow: number; endCol: number };
  if (b.startRow > b.endRow || b.startCol > b.endCol) {
    return `${label} must be normalized (startRow <= endRow, startCol <= endCol)`;
  }
  return true;
}

function checkCFRanges(ranges: unknown): true | string {
  if (!Array.isArray(ranges) || ranges.length === 0 || ranges.length > MAX_CF_RANGES) {
    return `ranges must be a non-empty array of range objects (max ${MAX_CF_RANGES})`;
  }
  for (let i = 0; i < ranges.length; i++) {
    const r = checkCFRangeBox(ranges[i], `ranges[${i}]`);
    if (r !== true) return r;
  }
  return true;
}

function checkCFRuleId(v: unknown, label = "ruleId"): true | string {
  if (!isFiniteNumber(v) || !Number.isInteger(v) || v < 0 || v > Number.MAX_SAFE_INTEGER) {
    return `${label} must be a non-negative integer (the id addConditionalFormat / listConditionalFormats reported)`;
  }
  return true;
}

/** addConditionalFormat args: [spec] where spec = { rule, format, ranges, stopIfTrue? }. */
export const vCFSpec: Validator = ([spec]) => {
  if (!isPlainObject(spec)) return "expected a spec object { rule, format, ranges, stopIfTrue? }";
  const keys = checkOnlyKeys(spec, "spec", ["rule", "format", "ranges", "stopIfTrue"]);
  if (keys !== true) return keys;
  const rule = checkCFRule(spec.rule);
  if (rule !== true) return rule;
  const format = checkCFFormat(spec.format);
  if (format !== true) return format;
  const ranges = checkCFRanges(spec.ranges);
  if (ranges !== true) return ranges;
  if (spec.stopIfTrue !== undefined && typeof spec.stopIfTrue !== "boolean") {
    return "stopIfTrue must be a boolean";
  }
  return true;
};

/** updateConditionalFormat args: [ruleId, patch]. Only the keys present change. */
export const vCFUpdate: Validator = ([ruleId, patch]) => {
  const id = checkCFRuleId(ruleId);
  if (id !== true) return id;
  if (!isPlainObject(patch)) {
    return "expected a patch object { rule?, format?, ranges?, stopIfTrue?, enabled? }";
  }
  const keys = checkOnlyKeys(patch, "patch", ["rule", "format", "ranges", "stopIfTrue", "enabled"]);
  if (keys !== true) return keys;
  if (Object.keys(patch).length === 0) {
    return "patch must change at least one of: rule, format, ranges, stopIfTrue, enabled";
  }
  if (patch.rule !== undefined) {
    const rule = checkCFRule(patch.rule);
    if (rule !== true) return rule;
  }
  if (patch.format !== undefined) {
    const format = checkCFFormat(patch.format);
    if (format !== true) return format;
  }
  if (patch.ranges !== undefined) {
    const ranges = checkCFRanges(patch.ranges);
    if (ranges !== true) return ranges;
  }
  if (patch.stopIfTrue !== undefined && typeof patch.stopIfTrue !== "boolean") {
    return "stopIfTrue must be a boolean";
  }
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
    return "enabled must be a boolean";
  }
  return true;
};

/** deleteConditionalFormat args: [ruleId]. */
export const vCFRuleId: Validator = ([ruleId]) => checkCFRuleId(ruleId);

/** listConditionalFormats args: [sheet?]. The sheet ref (index or name)
 *  resolves host-side by the Wave-1 rules; the backend command is sheet-aware
 *  (conditional_formatting.rs takes sheetIndex), so a non-active sheet is
 *  honored, not refused. */
export const vCFList: Validator = ([sheet]) => checkOptionalSheetRef(sheet, "sheet");

/** clearConditionalFormats args: [range?, sheet?]. Omitted range = the whole
 *  sheet. Same sheet-aware slot as vCFList. */
export const vCFClear: Validator = ([range, sheet]) => {
  if (range !== undefined && range !== null) {
    const box = checkCFRangeBox(range, "range");
    if (box !== true) return box;
  }
  return checkOptionalSheetRef(sheet, "sheet");
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

/**
 * The chart placement keys ONE gate proves, shared by vCreateChart (options)
 * and the chart.setGeometry aspect (patch) — the bounds are one decision, not
 * two: name <= 255, sheetIndex a Wave-1 sheet ref, x/y within +-1,000,000 px,
 * width/height 10..20,000 px.
 */
function checkChartPlacementProps(o: Record<string, unknown>, label: string): true | string {
  for (const k of Object.keys(o)) {
    if (!["name", "sheetIndex", "x", "y", "width", "height"].includes(k)) {
      return `unknown ${label} "${k}" (allowed: name, sheetIndex, x, y, width, height)`;
    }
  }
  if (o.name !== undefined && !isBoundedString(o.name, MAX_OBJECT_NAME)) {
    return `name must be a string (max ${MAX_OBJECT_NAME} chars)`;
  }
  const sheet = checkOptionalSheetRef(o.sheetIndex);
  if (sheet !== true) return sheet;
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
}

/** chart.setGeometry aspect args: [patch]. At least one placement key. */
export function checkChartGeometryAspect(aspectArgs: unknown): true | string {
  const args = Array.isArray(aspectArgs) ? aspectArgs : [];
  const patch = args[0];
  if (!isPlainObject(patch)) {
    return "expected a geometry patch object ({ x?, y?, width?, height?, name?, sheetIndex? })";
  }
  if (Object.keys(patch).length === 0) {
    return "geometry patch must set at least one of: x, y, width, height, name, sheetIndex";
  }
  return checkChartPlacementProps(patch, "geometry property");
}

/** createChart args: [spec, options?]. `options` places the new chart. */
export const vCreateChart: Validator = ([spec, options]) => {
  const shape = checkChartSpec([spec]);
  if (shape !== true) return shape;
  if (options === undefined || options === null) return true;
  if (typeof options !== "object" || Array.isArray(options)) return "options must be an object";
  return checkChartPlacementProps(options as Record<string, unknown>, "chart option");
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

/** ONE spelling rule for a defined name, shared by create and rename. */
function checkDefinedNameSpelling(name: unknown, label = "name"): true | string {
  if (!isBoundedString(name, MAX_OBJECT_NAME) || (name as string).length === 0) {
    return `${label} must be a non-empty string (max ${MAX_OBJECT_NAME} chars)`;
  }
  if (ILLEGAL_NAME_CHARS.test(name as string)) {
    return `${label} may not contain spaces or punctuation (letters, digits, _ and . only)`;
  }
  if (/^[0-9.]/.test(name as string)) return `${label} must start with a letter or underscore`;
  return true;
}

/** refersTo formula text, shared by create and update. */
function checkRefersTo(refersTo: unknown): true | string {
  if (!isBoundedString(refersTo, 8192) || (refersTo as string).length === 0) {
    return "refersTo must be a non-empty string (e.g. \"=Sheet1!$A$1:$B$10\")";
  }
  return true;
}

/**
 * namedRange.update aspect args: [patch]. Mirrors the MCP update_named_range
 * tri-state: an ABSENT key keeps the stored value; `sheetIndex: null` clears
 * the scope to workbook. At least one key must be present — an empty patch is
 * a question, not an edit.
 */
export function checkNamedRangeUpdate(aspectArgs: unknown): true | string {
  const args = Array.isArray(aspectArgs) ? aspectArgs : [];
  const patch = args[0];
  if (!isPlainObject(patch)) {
    return "expected an update object ({ refersTo?, newName?, comment?, sheetIndex? })";
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) {
    return "update must set at least one of: refersTo, newName, comment, sheetIndex";
  }
  for (const k of keys) {
    if (!["refersTo", "newName", "comment", "sheetIndex"].includes(k)) {
      return `unknown named-range update key "${k}" (allowed: refersTo, newName, comment, sheetIndex)`;
    }
  }
  if (patch.newName !== undefined) {
    const spelled = checkDefinedNameSpelling(patch.newName, "newName");
    if (spelled !== true) return spelled;
  }
  if (patch.refersTo !== undefined) {
    const target = checkRefersTo(patch.refersTo);
    if (target !== true) return target;
  }
  if (patch.comment !== undefined && !isBoundedString(patch.comment, 4096)) {
    return "comment must be a string (max 4096 chars)";
  }
  if (patch.sheetIndex !== undefined && patch.sheetIndex !== null) {
    const sheet = checkSheetRef(patch.sheetIndex, "sheetIndex");
    if (sheet !== true) return `${sheet} (or null = workbook scope)`;
  }
  return true;
}

/** createNamedRange args: [name, refersTo, options?]. */
export const vCreateNamedRange: Validator = ([name, refersTo, options]) => {
  const spelled = checkDefinedNameSpelling(name);
  if (spelled !== true) return spelled;
  const target = checkRefersTo(refersTo);
  if (target !== true) return target;
  if (options === undefined || options === null) return true;
  if (typeof options !== "object" || Array.isArray(options)) return "options must be an object";
  const o = options as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!["sheetIndex", "comment"].includes(k)) {
      return `unknown named-range option "${k}" (allowed: sheetIndex, comment)`;
    }
  }
  if (o.sheetIndex !== undefined && o.sheetIndex !== null) {
    const sheet = checkSheetRef(o.sheetIndex, "sheetIndex");
    if (sheet !== true) return `${sheet} (or null = workbook scope)`;
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
    const sheet = checkOptionalSheetRef(o[k], k);
    if (sheet !== true) return sheet;
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

// ============================================================================
// Pivot DATA aspects (Wave 3, item 4): report filters, item visibility, sort,
// number format — the "set the page filter, refresh" macro's missing line.
// ============================================================================
// Reached through the SAME two doors as the layout aspects (object.setState on
// an own pivot, api.objectSetState on any pivot at unlocked tier); no new
// allowlist row. `field` is the SOURCE COLUMN name, resolved host-side against
// the pivot's cache with the real names listed on a miss.

export const PIVOT_DATA_ASPECTS: ReadonlySet<string> = new Set([
  "pivot.setFilter",
  "pivot.clearFilter",
  "pivot.setItemVisibility",
  "pivot.sortField",
  "pivot.setNumberFormat",
]);

/** Directions pivot.sortField accepts. There is deliberately NO "none"/null:
 *  the backend (sort_pivot_field) can only set ascending/descending — a
 *  "clear sort" that silently did nothing would be worse than an absence. */
export const PIVOT_SORT_DIRECTIONS: ReadonlySet<string> = new Set(["asc", "desc"]);

/** The most items one pivot.setFilter call may keep. */
export const MAX_PIVOT_FILTER_ITEMS = 10_000;
const MAX_PIVOT_ITEM_NAME = 4096;
const MAX_PIVOT_NUMBER_FORMAT = 255;

/** Validate one pivot DATA aspect's arguments (shape only, no state reads). */
export function checkPivotDataAspect(aspect: string, aspectArgs: unknown): true | string {
  const args = Array.isArray(aspectArgs) ? aspectArgs : [];
  switch (aspect) {
    case "pivot.setFilter": {
      const field = checkFieldName(args[0]);
      if (field !== true) return field;
      const values = args[1];
      if (values === null) return true; // null = clear the field's filters
      if (!Array.isArray(values) || values.length > MAX_PIVOT_FILTER_ITEMS) {
        return `values must be an array of item names to KEEP (max ${MAX_PIVOT_FILTER_ITEMS}) or null to clear`;
      }
      for (const v of values) {
        if (!isBoundedString(v, MAX_PIVOT_ITEM_NAME)) {
          return `each filter value must be a string (max ${MAX_PIVOT_ITEM_NAME} chars)`;
        }
      }
      return true;
    }
    case "pivot.clearFilter":
      return checkFieldName(args[0]);
    case "pivot.setItemVisibility": {
      const field = checkFieldName(args[0]);
      if (field !== true) return field;
      // An ITEM may legitimately be the empty string (a blank cell in the
      // source column), so unlike `field` it is not required non-empty.
      if (!isBoundedString(args[1], MAX_PIVOT_ITEM_NAME)) {
        return `item must be a string (max ${MAX_PIVOT_ITEM_NAME} chars)`;
      }
      if (typeof args[2] !== "boolean") return "visible must be a boolean";
      return true;
    }
    case "pivot.sortField": {
      const field = checkFieldName(args[0]);
      if (field !== true) return field;
      if (!PIVOT_SORT_DIRECTIONS.has(args[1] as string)) {
        return `direction must be one of: ${[...PIVOT_SORT_DIRECTIONS].join(", ")}`;
      }
      return true;
    }
    case "pivot.setNumberFormat": {
      const field = checkFieldName(args[0]);
      if (field !== true) return field;
      if (!isBoundedString(args[1], MAX_PIVOT_NUMBER_FORMAT) || (args[1] as string).length === 0) {
        return `format must be a non-empty number format string (max ${MAX_PIVOT_NUMBER_FORMAT} chars), e.g. "#,##0.00"`;
      }
      return true;
    }
    default:
      return true;
  }
}

// ============================================================================
// Table STRUCTURE aspects (Wave 4): the ListObject management family —
// rename/resize/columns/totals row/style/convert-to-range/insert/delete row.
// ============================================================================
// Reached through the SAME two doors as the pivot aspect families
// (object.setState on an own table, api.objectSetState on any table at
// unlocked tier); no new allowlist rows. Every aspect maps 1:1 onto an
// existing backend table command; the ACTIVE-SHEET rule those commands
// enforce is asserted host-side with the fix spelled out.

export const TABLE_STRUCTURE_ASPECTS: ReadonlySet<string> = new Set([
  "table.rename",
  "table.resize",
  "table.addColumn",
  "table.removeColumn",
  "table.renameColumn",
  "table.setTotalsRow",
  "table.setTotalsFunction",
  "table.setStyle",
  "table.convertToRange",
  "table.insertRow",
  "table.deleteRow",
]);

/** The backend's TotalsRowFunction vocabulary (backend.ts), verbatim. */
export const TABLE_TOTALS_FUNCTIONS: ReadonlySet<string> = new Set([
  "none", "average", "count", "countNumbers", "max", "min", "sum",
  "stdDev", "var", "custom",
]);

/** The 7 boolean TableStyleOptions keys (backend.ts), verbatim. */
export const TABLE_STYLE_OPTION_KEYS: ReadonlySet<string> = new Set([
  "bandedRows", "bandedColumns", "headerRow", "totalRow",
  "firstColumn", "lastColumn", "showFilterButton",
]);

const MAX_TABLE_FORMULA = 8192;

function checkTableColumnName(v: unknown, label: string): true | string {
  if (!isBoundedString(v, MAX_OBJECT_NAME) || (v as string).trim().length === 0) {
    return `${label} must be a non-empty column name (max ${MAX_OBJECT_NAME} chars)`;
  }
  return true;
}

/** An optional 0-based data-row position (insert/add-column index). */
function checkTableRowPosition(v: unknown, label: string, required: boolean): true | string {
  if (v === undefined || v === null) {
    return required ? `${label} must be a non-negative integer` : true;
  }
  if (!isFiniteNumber(v) || !Number.isInteger(v) || v < 0 || v > 10_000_000) {
    return `${label} must be a non-negative integer`;
  }
  return true;
}

/** Validate one table STRUCTURE aspect's arguments (shape only, no state reads). */
export function checkTableStructureAspect(aspect: string, aspectArgs: unknown): true | string {
  const args = Array.isArray(aspectArgs) ? aspectArgs : [];
  switch (aspect) {
    case "table.rename": {
      if (!isBoundedString(args[0], MAX_OBJECT_NAME) || (args[0] as string).trim().length === 0) {
        return `newName must be a non-empty string (max ${MAX_OBJECT_NAME} chars)`;
      }
      return true;
    }
    case "table.resize":
      // The same rectangle gate every range argument gets (grid coordinates).
      return vRangeRef([args[0], args[1], args[2], args[3]]);
    case "table.addColumn": {
      const name = checkTableColumnName(args[0], "name");
      if (name !== true) return name;
      return checkTableRowPosition(args[1], "position", false);
    }
    case "table.removeColumn":
      return checkTableColumnName(args[0], "name");
    case "table.renameColumn": {
      const oldName = checkTableColumnName(args[0], "oldName");
      if (oldName !== true) return oldName;
      return checkTableColumnName(args[1], "newName");
    }
    case "table.setTotalsRow":
      return typeof args[0] === "boolean" ? true : "show must be a boolean";
    case "table.setTotalsFunction": {
      const column = checkTableColumnName(args[0], "column");
      if (column !== true) return column;
      if (!TABLE_TOTALS_FUNCTIONS.has(args[1] as string)) {
        return `function must be one of: ${[...TABLE_TOTALS_FUNCTIONS].join(", ")}`;
      }
      if (args[1] === "custom") {
        if (!isBoundedString(args[2], MAX_TABLE_FORMULA) || (args[2] as string).length === 0) {
          return "a \"custom\" totals function needs a formula string as the third argument";
        }
      } else if (args[2] !== undefined && args[2] !== null) {
        return "a formula is only accepted with the \"custom\" totals function";
      }
      return true;
    }
    case "table.setStyle": {
      const style = args[0];
      if (isBoundedString(style, MAX_OBJECT_NAME) && (style as string).length > 0) return true;
      if (!isPlainObject(style)) {
        return "style must be a style NAME or an object ({ styleName?, styleOptions? })";
      }
      for (const k of Object.keys(style)) {
        if (!["styleName", "styleOptions"].includes(k)) {
          return `unknown style key "${k}" (allowed: styleName, styleOptions)`;
        }
      }
      if (Object.keys(style).length === 0) {
        return "style must set styleName and/or styleOptions";
      }
      if (style.styleName !== undefined &&
          (!isBoundedString(style.styleName, MAX_OBJECT_NAME) || (style.styleName as string).length === 0)) {
        return `styleName must be a non-empty string (max ${MAX_OBJECT_NAME} chars)`;
      }
      if (style.styleOptions !== undefined) {
        if (!isPlainObject(style.styleOptions)) return "styleOptions must be an object of booleans";
        for (const [k, v] of Object.entries(style.styleOptions)) {
          if (!TABLE_STYLE_OPTION_KEYS.has(k)) {
            return `unknown styleOptions key "${k}" (allowed: ${[...TABLE_STYLE_OPTION_KEYS].join(", ")})`;
          }
          if (typeof v !== "boolean") return `styleOptions.${k} must be a boolean`;
        }
      }
      return true;
    }
    case "table.convertToRange":
      return args.length === 0 || "convertToRange takes no arguments";
    case "table.insertRow":
      return checkTableRowPosition(args[0], "position", false);
    case "table.deleteRow":
      return checkTableRowPosition(args[0], "position", true);
    default:
      return true;
  }
}

// ============================================================================
// Notes + comments (Wave 4): the cell-annotation CRUD rows.
// ============================================================================
// Notes are VBA's Range.NoteText 90% case (one text per cell); comments are
// the threaded kind. Text is capped WELL below the 1 MB cell ceiling — 32k is
// Excel's own note limit and nobody reads a longer tooltip.

export const MAX_NOTE_TEXT = 32_768;

function checkAnnotationText(v: unknown, label: string): true | string {
  if (!isBoundedString(v, MAX_NOTE_TEXT) || (v as string).length === 0) {
    return `${label} must be a non-empty string (max ${MAX_NOTE_TEXT} chars)`;
  }
  return true;
}

/** setNote args: [row, col, text | null, sheet?]. null REMOVES the note. */
export const vSetNote: Validator = ([row, col, text, sheet]) => {
  if (!isCellCoord(row)) return "row must be a non-negative integer";
  if (!isCellCoord(col)) return "col must be a non-negative integer";
  if (text !== null) {
    const t = checkAnnotationText(text, "text");
    if (t !== true) return `${t} (or null to remove the note)`;
  }
  return checkOptionalSheetRef(sheet, "sheet");
};

/** addComment args: [row, col, text]. */
export const vAddComment: Validator = ([row, col, text]) => {
  if (!isCellCoord(row)) return "row must be a non-negative integer";
  if (!isCellCoord(col)) return "col must be a non-negative integer";
  return checkAnnotationText(text, "text");
};

/** replyToComment args: [commentId, text]. */
export const vCommentReply: Validator = ([commentId, text]) => {
  if (!isBoundedString(commentId, MAX_KEY) || (commentId as string).length === 0) {
    return "commentId must be a non-empty string";
  }
  return checkAnnotationText(text, "text");
};

/** resolveComment args: [commentId, resolved?]. Omitted resolved = true. */
export const vResolveComment: Validator = ([commentId, resolved]) => {
  if (!isBoundedString(commentId, MAX_KEY) || (commentId as string).length === 0) {
    return "commentId must be a non-empty string";
  }
  if (resolved !== undefined && typeof resolved !== "boolean") {
    return "resolved must be a boolean (omit for true)";
  }
  return true;
};

/** listComments args: [range?, sheet?]. Omitted range = the whole sheet. The
 *  rectangle is a FILTER over stored comments, not a cell payload, so it gets
 *  coordinate/ordering checks but no MAX_RANGE_CELLS ceiling — "every comment
 *  in column A" is a legitimate question. */
export const vListComments: Validator = ([range, sheet]) => {
  if (range !== undefined && range !== null) {
    if (!isPlainObject(range)) {
      return "range must be an object ({ startRow, startCol, endRow, endCol }) or null";
    }
    for (const k of ["startRow", "startCol", "endRow", "endCol"] as const) {
      if (!isCellCoord(range[k])) return `range.${k} must be a non-negative integer`;
    }
    if ((range.endRow as number) < (range.startRow as number)) return "range.endRow must be >= range.startRow";
    if ((range.endCol as number) < (range.startCol as number)) return "range.endCol must be >= range.startCol";
  }
  return checkOptionalSheetRef(sheet, "sheet");
};

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

// ============================================================================
// distribution.publish / distribution.subscribe — the .calp package loop (B3)
// ============================================================================
//
// Every shape here is a CHEAP pre-flight. The authoritative gate is the Rust
// `script_distribution` gateway, which re-checks the ACTION'S OWN capability
// (outbound and inbound never share a grant), refuses any registry the user has
// not already configured, demands Ed25519 publisher-key possession before a
// registry write, rate-limits per bucket, and then dispatches into the very same
// calp_* commands the interactive UI calls — so a scripted pull passes exactly
// the signature, TOFU, artifact-integrity and min_app_version checks a human's
// does, and a scripted publish signs with exactly the same key.

/** Registry locations, package names and version strings are identifiers, not
 *  documents — a megabyte-long "package name" is a bug or an attack. */
const MAX_REGISTRY_LOCATION = 2048;
const MAX_PACKAGE_NAME = 256;
const MAX_VERSION_TEXT = 128;

/** The version-bump levels `calp_next_version` understands. */
const VERSION_BUMPS: ReadonlySet<string> = new Set(["major", "minor", "patch"]);

/** Fields a script must never set on a publish. Each is rejected BY NAME (the
 *  Rust gateway rejects them again, authoritatively) rather than ignored,
 *  because silently overriding an argument leaves the author believing it
 *  worked:
 *   - publishedBy    : the byline other people read. Server-supplied from the
 *                      machine's publisher identity, so an automation cannot
 *                      publish under somebody else's name.
 *   - customObjects  : package payload. Collected by Calcula from registered
 *                      providers, never handed in by the caller.
 *   - includeComments: threaded comments are internal discussion; shipping them
 *                      to a registry is a privacy decision only a human makes. */
const FORBIDDEN_PUBLISH_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["publishedBy", "the byline is taken from this machine's publisher identity"],
  ["customObjects", "package payloads are collected by Calcula, never supplied by the caller"],
  [
    "includeComments",
    "shipping threaded comments to a registry is a privacy decision only a person can make",
  ],
];

function registryLocationError(location: unknown): string | null {
  if (!isBoundedString(location, MAX_REGISTRY_LOCATION) || (location as string).trim().length === 0) {
    return "registry must be a non-empty location string (use caps.packages.listRegistries() — a script may only use registries you already added)";
  }
  return null;
}

function packageNameError(name: unknown): string | null {
  if (!isBoundedString(name, MAX_PACKAGE_NAME) || (name as string).trim().length === 0) {
    return "packageName must be a non-empty string";
  }
  return null;
}

function versionTextError(v: unknown, label: string): string | null {
  if (!isBoundedString(v, MAX_VERSION_TEXT) || (v as string).trim().length === 0) {
    return `${label} must be a non-empty string`;
  }
  return null;
}

/** cap.pkgBrowse args: [registry]. */
export const vDistRegistry: Validator = ([registry]) => registryLocationError(registry) ?? true;

/** cap.pkgInspect / cap.pkgPull args: [registry, packageName, versionPin]. */
export const vDistPackageRef: Validator = ([registry, packageName, versionPin]) =>
  registryLocationError(registry) ??
  packageNameError(packageName) ??
  versionTextError(versionPin, "versionPin") ??
  true;

/** cap.pkgNextVersion args: [registry, packageName, bump]. */
export const vDistNextVersion: Validator = ([registry, packageName, bump]) => {
  const err = registryLocationError(registry) ?? packageNameError(packageName);
  if (err) return err;
  if (!isBoundedString(bump, 16) || !VERSION_BUMPS.has(bump as string)) {
    return `bump must be one of: ${[...VERSION_BUMPS].join(", ")}`;
  }
  return true;
};

/** A list of workbook sheet indices, or nothing (meaning "the default for this
 *  package kind"). Bounded because it is a selection, not a data structure. */
function sheetIndicesError(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) return "sheetIndices must be an array of sheet indices";
  if (v.length > 4096) return "sheetIndices has too many entries (max 4096)";
  for (const i of v) {
    if (!Number.isInteger(i) || (i as number) < 0) {
      return "sheetIndices entries must be non-negative integers";
    }
  }
  return null;
}

/** cap.pkgPublishPreview args: [sheetIndices?]. */
export const vDistPublishPreview: Validator = ([sheetIndices]) =>
  sheetIndicesError(sheetIndices) ?? true;

/** cap.pkgPublish args: [spec] where spec is
 *  `{ registry, packageName, version, kind?, sheetIndices? }`. */
export const vDistPublish: Validator = ([spec]) => {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    return "publish takes one object: { registry, packageName, version, kind?, sheetIndices? }";
  }
  const s = spec as Record<string, unknown>;
  for (const [key, why] of FORBIDDEN_PUBLISH_FIELDS) {
    if (key in s) return `'${key}' cannot be set from a script: ${why}`;
  }
  const err =
    registryLocationError(s.registry) ??
    packageNameError(s.packageName) ??
    versionTextError(s.version, "version") ??
    sheetIndicesError(s.sheetIndices);
  if (err) return err;
  if (s.kind !== undefined && s.kind !== null) {
    if (!isBoundedString(s.kind, 64) || (s.kind as string).trim().length === 0) {
      return "kind must be a non-empty string (e.g. \"report\", \"template\", \"dataset\", \"library\")";
    }
  }
  return true;
};

/** cap.pkgPublishModel args: [spec] where spec is
 *  `{ registry, packageName, version, connectionId }`. */
export const vDistPublishModel: Validator = ([spec]) => {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    return "publishModel takes one object: { registry, packageName, version, connectionId }";
  }
  const s = spec as Record<string, unknown>;
  for (const [key, why] of FORBIDDEN_PUBLISH_FIELDS) {
    if (key in s) return `'${key}' cannot be set from a script: ${why}`;
  }
  const err =
    registryLocationError(s.registry) ??
    packageNameError(s.packageName) ??
    versionTextError(s.version, "version");
  if (err) return err;
  if (!isBoundedString(s.connectionId, MAX_KEY) || (s.connectionId as string).length === 0) {
    return "connectionId must be a non-empty string";
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

// ============================================================================
// file.picker — user-chosen file export / import (G1)
// ============================================================================
//
// THE INVARIANT THESE VALIDATORS EXIST TO KEEP: no path string ever crosses
// from a script to the disk. `suggestedName` is a FILE NAME, not a location,
// and this is where that is made true rather than hoped for — a suggestion
// containing a separator, a drive letter, a `..` segment or an ADS colon is
// REJECTED, not sanitized, so a script cannot pre-aim the picker at
// C:\Users\<name>\... and rely on a distracted click. The user still chooses
// the folder in the native dialog; the suggestion only pre-fills the name box.

/** Max characters of text one export may write / one import may return.
 *  ~8 MB of plain ASCII: enough for a real CSV report, small enough that a
 *  runaway script cannot fill a disk one picker at a time. */
export const MAX_FILE_TEXT_CHARS = 8_000_000;
/** Max length of the suggested file name (a name box, not a path). */
export const MAX_FILE_NAME = 128;
/** Max extension filters an import may ask the picker to offer. */
export const MAX_FILE_EXTENSIONS = 16;
/** Text encodings an export may request. Deliberately tiny: "utf-8-bom" exists
 *  because Excel misreads accented UTF-8 CSV without a BOM, and "ansi" because
 *  legacy tooling still demands it. Nothing here can escape a text file. */
const FILE_ENCODINGS: ReadonlySet<string> = new Set(["utf-8", "utf-8-bom", "ansi"]);

/** Characters that can never appear in a bare file name. Spelled as an explicit
 *  ARRAY rather than a regex character class on purpose: `\` and `/` inside a
 *  class are exactly the two characters an escaping slip silently drops, and
 *  those two are the whole point of this check. A list cannot be mis-escaped. */
const FORBIDDEN_NAME_CHARS: readonly string[] = [
  "\\", // Windows path separator (and the leading pair of a UNC path)
  "/",    // POSIX path separator
  ":",    // drive letter AND the NTFS alternate-data-stream marker
  "*",
  "?",
  "\"",
  "<",
  ">",
  "|",
];

/** An extension token as it appears in a picker filter: letters/digits only,
 *  no dot, no wildcard, no path. ("*" is deliberately NOT allowed — an
 *  "All files" filter is the host's decision, not the script's.) */
const SAFE_EXTENSION_RE = /^[A-Za-z0-9]{1,16}$/;

/** A MIME type used ONLY to label the picker's filter row. */
const SAFE_MIME_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$/;

/** True when `name` is a bare, safe file name (exported for the host + tests). */
export function isSafeFileName(name: unknown): name is string {
  if (!isBoundedString(name, MAX_FILE_NAME)) return false;
  if (name.length === 0) return false;
  // Validated VERBATIM, never after a trim: the exact string checked here is the
  // exact string handed to the picker, so there is no gap between what was
  // approved and what the dialog shows.
  if (name !== name.trim()) return false;
  for (const ch of FORBIDDEN_NAME_CHARS) {
    if (name.includes(ch)) return false;
  }
  // Control characters (including the NUL a truncation attack would use).
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  // "." and ".." pass every check above but are LOCATIONS, not names; a trailing
  // dot is silently stripped by Windows, which would make the file actually
  // written differ from the name we validated and audited.
  if (/^\.+$/.test(name)) return false;
  if (name.endsWith(".")) return false;
  return true;
}

/** cap.fileExportText args: [suggestedName, content, options?]. */
export const vFileExport: Validator = ([suggestedName, content, options]) => {
  if (!isSafeFileName(suggestedName)) {
    return `suggestedName must be a bare file name — no folders, no drive letters, no ".." (max ${MAX_FILE_NAME} chars)`;
  }
  if (typeof content !== "string") return "content must be a string";
  if (content.length > MAX_FILE_TEXT_CHARS) {
    return `content is ${content.length} characters (max ${MAX_FILE_TEXT_CHARS})`;
  }
  if (options === undefined || options === null) return true;
  if (typeof options !== "object" || Array.isArray(options)) return "options must be an object";
  const o = options as Record<string, unknown>;
  const known = checkKnownKeys(o, ["mimeType", "encoding", "description"], "export option");
  if (known !== true) return known;
  if (o.mimeType !== undefined && (typeof o.mimeType !== "string" || !SAFE_MIME_RE.test(o.mimeType))) {
    return 'mimeType must look like "text/csv"';
  }
  if (o.encoding !== undefined && (typeof o.encoding !== "string" || !FILE_ENCODINGS.has(o.encoding))) {
    return `encoding must be one of: ${[...FILE_ENCODINGS].join(", ")}`;
  }
  if (o.description !== undefined && (!isBoundedString(o.description, MAX_FILE_NAME) || (o.description as string).trim().length === 0)) {
    return `description must be a non-empty string (max ${MAX_FILE_NAME} chars)`;
  }
  return true;
};

/** cap.fileImportText args: [options?]. */
export const vFileImport: Validator = ([options]) => {
  if (options === undefined || options === null) return true;
  if (typeof options !== "object" || Array.isArray(options)) return "options must be an object";
  const o = options as Record<string, unknown>;
  const known = checkKnownKeys(o, ["extensions", "description"], "import option");
  if (known !== true) return known;
  if (o.extensions !== undefined) {
    if (!Array.isArray(o.extensions)) return "extensions must be an array of strings";
    if (o.extensions.length === 0) return "extensions must not be empty (omit it to offer every file)";
    if (o.extensions.length > MAX_FILE_EXTENSIONS) {
      return `extensions has ${o.extensions.length} entries (max ${MAX_FILE_EXTENSIONS})`;
    }
    for (const ext of o.extensions) {
      if (typeof ext !== "string" || !SAFE_EXTENSION_RE.test(ext)) {
        return 'each extension must be letters/digits only, without a dot (e.g. "csv")';
      }
    }
  }
  if (o.description !== undefined && (!isBoundedString(o.description, MAX_FILE_NAME) || (o.description as string).trim().length === 0)) {
    return `description must be a non-empty string (max ${MAX_FILE_NAME} chars)`;
  }
  return true;
};

// ============================================================================
// Workbook file lifecycle (G1) — no arguments cross at all
// ============================================================================
//
// save / saveAs / isDirty / fileName take NOTHING. That is the design, not an
// oversight: `save()` acts on the file the workbook already came from and
// `saveAs()` asks the user, so there is no argument a script could supply that
// would name a destination. vNone is therefore the whole validator, and any
// future argument here would be a path in disguise.

// ============================================================================
// ui.shortcut — one keyboard shortcut bound to one exposed method (G2)
// ============================================================================
//
// THE SHAPE OF THE COMBINATION IS NOT CHECKED HERE, on purpose. There is one
// place that decides which keys a script may take (scriptComboRefusal in
// app/src/api/keybindings.ts) and it is the same place that owns the registry
// and the dispatcher, so the rule cannot be true in one file and stale in
// another. Duplicating even a weakened form of it here — "looks like a combo" —
// would invite exactly the drift that lets a second, laxer gate become the one
// that matters. These validators bound SIZE and SHAPE of the arguments; the
// POLICY answer comes from the registry, and its refusal reaches the script
// verbatim.

/** Longest shortcut string accepted at the boundary ("Ctrl+Shift+Alt+Meta+X"
 *  is 21 characters; 64 is room to be wrong in a readable way). */
const MAX_COMBO_CHARS = 64;

/** cap.shortcutBind args: [combo, handlerName, options?]. */
export const vShortcutBind: Validator = ([combo, handler, options]) => {
  if (!isBoundedString(combo, MAX_COMBO_CHARS) || (combo as string).trim().length === 0) {
    return `combo must be a non-empty shortcut string (max ${MAX_COMBO_CHARS} chars), e.g. "Ctrl+Shift+R"`;
  }
  // The handler is a method the script itself published with context.expose —
  // a NAME, never a function. Nothing callable crosses the worker boundary, and
  // a name is what makes the binding readable in the shortcut list after the
  // fact ("Ctrl+Shift+R calls refreshAll()").
  if (!isBoundedString(handler, MAX_KEY) || (handler as string).trim().length === 0) {
    return "handler must be the name of a method this script exposed with context.expose(...)";
  }
  if (options === undefined || options === null) return true;
  if (typeof options !== "object" || Array.isArray(options)) return "options must be an object";
  const o = options as Record<string, unknown>;
  const known = checkKnownKeys(o, ["label"], "shortcut option");
  if (known !== true) return known;
  if (o.label !== undefined && !isBoundedString(o.label, MAX_KEY)) {
    return "options.label must be a short string";
  }
  return true;
};

/** cap.shortcutUnbind args: [combo]. */
export const vShortcutUnbind: Validator = ([combo]) => {
  if (!isBoundedString(combo, MAX_COMBO_CHARS) || (combo as string).trim().length === 0) {
    return `combo must be a non-empty shortcut string (max ${MAX_COMBO_CHARS} chars)`;
  }
  return true;
};

// ============================================================================
// api.evaluate — the WorksheetFunction bridge (G4)
// ============================================================================
//
// WHAT THESE BOUNDS ARE AND ARE NOT. They bound WORK, not reach: an expression
// evaluates against the same grid the calling tier can already read cell by
// cell, so there is nothing here to escalate. What a formula CAN do is run for a
// long time (`SUMPRODUCT` over whole columns) or recurse without a floor — the
// engine has no evaluation depth or time limit, verified, and a recursive
// named function will exhaust the stack. That hazard is NOT created here: a
// script holding this tier can already write the identical formula into a cell
// with api.setCellValue and get the identical evaluation. These limits therefore
// exist to make the ACCIDENT cheap (a loop calling evaluate() a thousand times a
// second), and the residual engine hazard is reported rather than papered over.

/** Longest single expression accepted. Excel's own formula limit is 8192
 *  characters, so anything longer was not going to evaluate anyway. */
export const MAX_EVAL_EXPRESSION_CHARS = 8_192;
/** Expressions per call. One round trip for a batch is the point; 64 keeps the
 *  worst-case synchronous evaluation on the Rust side bounded. */
export const MAX_EVAL_EXPRESSIONS = 64;

/** api.evaluate args: [expressions, options?]. */
export const vEvaluate: Validator = ([expressions, options]) => {
  if (!Array.isArray(expressions)) return "expressions must be an array of strings";
  if (expressions.length === 0) return "expressions must not be empty";
  if (expressions.length > MAX_EVAL_EXPRESSIONS) {
    return `too many expressions: ${expressions.length} (max ${MAX_EVAL_EXPRESSIONS})`;
  }
  for (const e of expressions) {
    if (!isBoundedString(e, MAX_EVAL_EXPRESSION_CHARS)) {
      return `each expression must be a string (max ${MAX_EVAL_EXPRESSION_CHARS} chars)`;
    }
    if ((e as string).trim().length === 0) return "an expression must not be empty";
  }
  if (options === undefined || options === null) return true;
  if (typeof options !== "object" || Array.isArray(options)) return "options must be an object";
  const o = options as Record<string, unknown>;
  const known = checkKnownKeys(o, ["sheetIndex"], "evaluate option");
  if (known !== true) return known;
  return checkOptionalSheetRef(o.sheetIndex, "options.sheetIndex");
};

// ============================================================================
// The APPLICATION cluster (Wave 4): status bar, batches that pause repaints,
// macros-by-name, and view/window state
// ============================================================================

/** Longest status-bar message accepted. The bar is one line of chrome; a
 *  message longer than this was never going to be readable there. */
export const MAX_STATUS_BAR_CHARS = 512;

/** api.setStatusBar args: [text]. `null` restores the default "Ready". */
export const vStatusBar: Validator = ([text]) => {
  if (text === null) return true;
  if (!isBoundedString(text, MAX_STATUS_BAR_CHARS)) {
    return `text must be a string (max ${MAX_STATUS_BAR_CHARS} chars) or null to clear the message`;
  }
  return true;
};

/** Longest undo-entry description accepted for api.beginBatch. */
export const MAX_BATCH_DESCRIPTION_CHARS = 200;

/** api.beginBatch args: [description, options?]. The options bag is CLOSED:
 *  an unknown key is refused rather than ignored, because a silently dropped
 *  `deferRepaint` is a script that believes the screen is paused while every
 *  write repaints. */
export const vBeginBatch: Validator = ([description, options]) => {
  if (!isBoundedString(description, MAX_BATCH_DESCRIPTION_CHARS)) {
    return `description must be a string (max ${MAX_BATCH_DESCRIPTION_CHARS} chars) — it names the undo entry`;
  }
  if (options === undefined || options === null) return true;
  if (typeof options !== "object" || Array.isArray(options)) return "options must be an object";
  const o = options as Record<string, unknown>;
  const known = checkKnownKeys(o, ["deferRepaint"], "beginBatch option");
  if (known !== true) return known;
  if (o.deferRepaint !== undefined && typeof o.deferRepaint !== "boolean") {
    return "options.deferRepaint must be a boolean";
  }
  return true;
};

/** Longest macro reference (display name or module id) accepted. */
export const MAX_MACRO_REF_CHARS = 256;

/** api.runMacro args: [nameOrId]. */
export const vRunMacro: Validator = ([ref]) => {
  if (!isBoundedString(ref, MAX_MACRO_REF_CHARS) || (ref as string).trim().length === 0) {
    return `name must be a non-empty string (max ${MAX_MACRO_REF_CHARS} chars) — a macro's display name or its module id`;
  }
  return true;
};

/** The View settings a script can read and write — each backed by the SAME
 *  event the View menu emits, so a script toggle and a menu click are one
 *  mechanism. */
export const SCRIPT_VIEW_OPTIONS: ReadonlySet<string> = new Set([
  "gridlines", "headings", "zeros", "formulas", "viewMode",
]);

/** The three view modes Core renders (mirrors core ViewMode). */
export const SCRIPT_VIEW_MODES: ReadonlySet<string> = new Set([
  "normal", "pageLayout", "pageBreakPreview",
]);

function checkViewOptionName(name: unknown): true | string {
  if (typeof name !== "string" || !SCRIPT_VIEW_OPTIONS.has(name)) {
    return `name must be one of: ${[...SCRIPT_VIEW_OPTIONS].join(", ")}`;
  }
  return true;
}

/** api.getViewOption args: [name]. */
export const vViewOptionGet: Validator = ([name]) => checkViewOptionName(name);

/** api.setViewOption args: [name, value]. The value's TYPE follows the name:
 *  the four toggles take a boolean, "viewMode" takes one of the three mode
 *  words — a mismatch is refused with the accepted list, never coerced. */
export const vViewOptionSet: Validator = ([name, value]) => {
  const named = checkViewOptionName(name);
  if (named !== true) return named;
  if (name === "viewMode") {
    if (typeof value !== "string" || !SCRIPT_VIEW_MODES.has(value)) {
      return `viewMode must be one of: ${[...SCRIPT_VIEW_MODES].join(", ")}`;
    }
    return true;
  }
  if (typeof value !== "boolean") return `${String(name)} takes a boolean value`;
  return true;
};

/** Zoom bounds, in PERCENT — the unit the whole script surface speaks. Inside
 *  Core's own factor clamp (0.1..5.0), so nothing here can be silently
 *  re-clamped after validation. */
export const ZOOM_PERCENT_MIN = 10;
export const ZOOM_PERCENT_MAX = 400;

/** api.setZoom args: [percent]. */
export const vZoom: Validator = ([percent]) => {
  if (!isFiniteNumber(percent) || percent < ZOOM_PERCENT_MIN || percent > ZOOM_PERCENT_MAX) {
    return `percent must be a number between ${ZOOM_PERCENT_MIN} and ${ZOOM_PERCENT_MAX}`;
  }
  return true;
};

// ============================================================================
// Explicit formula read / write, with a reference style (G4)
// ============================================================================
//
// Until now a script wrote a formula by passing "=A1+B1" to setCellValue and
// read one back inside a typed cell — A1 only, both directions, with no way to
// say which notation was meant. R1C1 is not a cosmetic preference: it is how a
// macro writes the SAME relative formula into a thousand cells without
// recomputing an address per cell, which is exactly what `FormulaR1C1` is for.
//
// The style is a WHOLE-STRING claim about the notation the caller is speaking,
// resolved host-side against the cell's own coordinates (an R1C1 offset is
// meaningless without a base cell). It is deliberately NOT read from the user's
// current reference-style setting: a script's meaning must not change because
// somebody ticked a View option.

/** Reference notations a formula argument may be written in. */
export const FORMULA_REFERENCE_STYLES: ReadonlySet<string> = new Set(["A1", "R1C1"]);

function checkFormulaOptions(options: unknown): true | string {
  if (options === undefined || options === null) return true;
  if (typeof options !== "object" || Array.isArray(options)) return "options must be an object";
  const o = options as Record<string, unknown>;
  const known = checkKnownKeys(o, ["style", "sheetIndex"], "formula option");
  if (known !== true) return known;
  if (o.style !== undefined && (typeof o.style !== "string" || !FORMULA_REFERENCE_STYLES.has(o.style))) {
    return `options.style must be one of: ${[...FORMULA_REFERENCE_STYLES].join(", ")}`;
  }
  return checkOptionalSheetRef(o.sheetIndex, "options.sheetIndex");
}

/** api.getCellFormula / sheet.getCellFormula args: [row, col, options?]. */
export const vFormulaRead: Validator = ([row, col, options]) => {
  if (!isCellCoord(row)) return "row must be a non-negative integer";
  if (!isCellCoord(col)) return "col must be a non-negative integer";
  return checkFormulaOptions(options);
};

/** api.setCellFormula / sheet.setCellFormula args: [row, col, formula, options?].
 *  `formula` may be null — that CLEARS the cell's formula, which is the honest
 *  spelling of `Range.Formula = ""` and cannot be confused with writing the
 *  literal text "". */
export const vFormulaWrite: Validator = ([row, col, formula, options]) => {
  if (!isCellCoord(row)) return "row must be a non-negative integer";
  if (!isCellCoord(col)) return "col must be a non-negative integer";
  if (formula !== null && !isBoundedString(formula, MAX_EVAL_EXPRESSION_CHARS)) {
    return `formula must be a string (max ${MAX_EVAL_EXPRESSION_CHARS} chars) or null to clear it`;
  }
  return checkFormulaOptions(options);
};

// ============================================================================
// Range copy / paste (G4)
// ============================================================================
//
// THE DECISION THIS VALIDATOR ENCODES: there is no method here that READS the
// system clipboard, and there never will be by accident, because there is no
// argument shape for one. What the user has copied may be a password, a bank
// number or a message from another application; "let this script see whatever
// you last copied" is ambient authority with no honest scope and no honest
// consent string, so it is REFUSED rather than gated. Copy fills a buffer that
// belongs to the calling script alone (host-side, per script, gone at unmount);
// paste reads it back. Neither touches the OS clipboard or the clipboard the
// user's own Ctrl+V reads, so a running script can never overwrite what a person
// has in hand, nor smuggle a workbook out through it.

/** What a paste transfers. "formats" is deliberately absent — see the host
 *  executor for the evidence (there is no batch style write, and set_cell_style
 *  silently no-ops on a cell that does not exist yet, so a formats-only paste
 *  would succeed while doing nothing for every blank destination cell). */
export const PASTE_MODES: ReadonlySet<string> = new Set(["all", "values", "formulas"]);

/** api.pasteRange args: [row, col, options?]. */
export const vPasteRange: Validator = ([row, col, options]) => {
  if (!isCellCoord(row)) return "row must be a non-negative integer";
  if (!isCellCoord(col)) return "col must be a non-negative integer";
  if (options === undefined || options === null) return true;
  if (typeof options !== "object" || Array.isArray(options)) return "options must be an object";
  const o = options as Record<string, unknown>;
  const known = checkKnownKeys(o, ["mode", "transpose", "skipBlanks", "sheetIndex"], "paste option");
  if (known !== true) return known;
  if (o.mode !== undefined && (typeof o.mode !== "string" || !PASTE_MODES.has(o.mode))) {
    return `options.mode must be one of: ${[...PASTE_MODES].join(", ")}`;
  }
  if (o.transpose !== undefined && typeof o.transpose !== "boolean") {
    return "options.transpose must be a boolean";
  }
  if (o.skipBlanks !== undefined && typeof o.skipBlanks !== "boolean") {
    return "options.skipBlanks must be a boolean";
  }
  return checkOptionalSheetRef(o.sheetIndex, "options.sheetIndex");
};

// ============================================================================
// cap.filePrintPdf — export the printable sheet as a PDF (G4, file.picker)
// ============================================================================
//
// Same construction as vFileExport, one argument shorter: the script names a
// FILE and nothing else. It does NOT hand over a payload — the host RENDERS the
// document from the workbook's own page setup — so there is no route here for a
// script to write bytes of its choosing to a file the user can be talked into
// picking. `suggestedName` is optional; the host supplies a default.

// ============================================================================
// Sheet move / copy + split panes (G4)
// ============================================================================

/** api.moveSheet args: [fromSheet, toIndex]. `fromSheet` identifies a sheet
 *  (index or name); `toIndex` is a POSITION in the tab bar, so it stays a
 *  number — "move Sheet1 to 'Summary'" has no meaning. */
export const vMoveSheet: Validator = ([fromSheet, toIndex]) => {
  const ref = checkSheetRef(fromSheet, "fromSheet");
  if (ref !== true) return ref;
  if (!isCellCoord(toIndex)) return "toIndex must be a non-negative integer";
  return true;
};

/**
 * The optional `{ before }` / `{ after }` position bag addSheet and copySheet
 * accept (Wave 4 — VBA's Add Before:=/After:=). EXACTLY ONE anchor: naming
 * both is rejected rather than one silently winning, and each anchor is an
 * ordinary Wave-1 sheet ref (index or name), resolved host-side.
 */
function checkSheetPosition(position: unknown): true | string {
  if (position === undefined || position === null) return true;
  if (typeof position !== "object" || Array.isArray(position)) {
    return "position must be an object like { before: \"Summary\" } or { after: 0 }";
  }
  const p = position as Record<string, unknown>;
  const known = checkKnownKeys(p, ["before", "after"], "position option");
  if (known !== true) return known;
  const hasBefore = p.before !== undefined && p.before !== null;
  const hasAfter = p.after !== undefined && p.after !== null;
  if (hasBefore && hasAfter) {
    return "position may name before OR after, not both";
  }
  if (hasBefore) return checkSheetRef(p.before, "position.before");
  if (hasAfter) return checkSheetRef(p.after, "position.after");
  return true;
}

/** api.addSheet args: [name?, position?]. Omitted name = the app's next
 *  default ("Sheet3"); omitted position = appended at the end (the historical
 *  contract). */
export const vAddSheet: Validator = ([name, position]) => {
  if (name !== undefined && name !== null) {
    const named = checkSheetName(name);
    if (named !== true) return named;
  }
  return checkSheetPosition(position);
};

/** api.copySheet args: [sourceSheet, newName?, position?]. `sourceSheet` is an
 *  index or a name; omitted name = the app's next default ("Sheet1 (2)");
 *  omitted position = immediately after the source (the historical contract). */
export const vCopySheet: Validator = ([sourceSheet, newName, position]) => {
  const ref = checkSheetRef(sourceSheet, "sourceSheet");
  if (ref !== true) return ref;
  if (newName !== undefined && newName !== null) {
    const named = checkSheetName(newName);
    if (named !== true) return named;
  }
  return checkSheetPosition(position);
};

/** api.splitPanes args: [splitRow, splitCol]. Same SHAPE as vFreeze, but a
 *  separate validator so the message names the argument the caller passed —
 *  "freezeRow must be..." on a splitPanes() call is the kind of small lie that
 *  sends an author looking in the wrong place. */
export const vSplit: Validator = ([splitRow, splitCol]) => {
  for (const [name, v] of [["splitRow", splitRow], ["splitCol", splitCol]] as const) {
    if (v === null || v === undefined) continue;
    if (!isCellCoord(v)) return `${name} must be a non-negative integer or null`;
  }
  return true;
};

// ============================================================================
// AutoFilter (G4)
// ============================================================================
//
// Every AutoFilter backend command acts on the ACTIVE SHEET and addresses a
// column by an index RELATIVE to the filter's own start column, so these
// validators enforce exactly that vocabulary and nothing wider. There is no
// sheetIndex argument to validate anywhere here — not because it is optional,
// but because there is none to pass (host.ts refuses an off-sheet call rather
// than pretending one exists).

/** A filter range may be at most this many columns wide. Not a security bound —
 *  the backend allocates one criteria slot per column, and a script asking for
 *  a filter across a million columns is a mistake worth catching early. */
export const MAX_AUTOFILTER_COLUMNS = 4096;

/** How many values a single values-filter may name, and how long each may be. */
export const MAX_AUTOFILTER_VALUES = 10_000;
const MAX_AUTOFILTER_VALUE_CHARS = 4096;
/** Length cap on a custom criterion (">=100", "=*text*"). */
const MAX_AUTOFILTER_CRITERION = 1024;

/** api.autoFilterApply args: [startRow, startCol, endRow, endCol]. */
export const vAutoFilterRange: Validator = ([startRow, startCol, endRow, endCol]) => {
  if (!isCellCoord(startRow)) return "startRow must be a non-negative integer";
  if (!isCellCoord(startCol)) return "startCol must be a non-negative integer";
  if (!isCellCoord(endRow)) return "endRow must be a non-negative integer";
  if (!isCellCoord(endCol)) return "endCol must be a non-negative integer";
  if ((endRow as number) < (startRow as number)) return "endRow must be >= startRow";
  if ((endCol as number) < (startCol as number)) return "endCol must be >= startCol";
  const cols = (endCol as number) - (startCol as number) + 1;
  if (cols > MAX_AUTOFILTER_COLUMNS) {
    return `filter range too wide: ${cols} columns (max ${MAX_AUTOFILTER_COLUMNS})`;
  }
  return true;
};

/** api.autoFilterListValues args: [columnIndex]. */
export const vAutoFilterColumn: Validator = ([columnIndex]) =>
  isCellCoord(columnIndex) && (columnIndex as number) < MAX_AUTOFILTER_COLUMNS
    ? true
    : `columnIndex must be a non-negative integer below ${MAX_AUTOFILTER_COLUMNS}, counted from the filter's first column`;

/** api.autoFilterClear args: [columnIndex | null]. null = every column. */
export const vAutoFilterClear: Validator = ([columnIndex]) => {
  if (columnIndex === null || columnIndex === undefined) return true;
  return vAutoFilterColumn([columnIndex]);
};

/** api.autoFilterSetColumn args: [columnIndex, criteria]. */
export const vAutoFilterCriteria: Validator = ([columnIndex, criteria]) => {
  const col = vAutoFilterColumn([columnIndex]);
  if (col !== true) return col;
  if (typeof criteria !== "object" || criteria === null || Array.isArray(criteria)) {
    return 'criteria must be an object: { kind: "values", values } or { kind: "custom", criterion1 }';
  }
  const c = criteria as Record<string, unknown>;
  if (c.kind === "values") {
    const known = checkKnownKeys(c, ["kind", "values", "includeBlanks"], "criteria option");
    if (known !== true) return known;
    if (!Array.isArray(c.values)) return "criteria.values must be an array of strings";
    if (c.values.length > MAX_AUTOFILTER_VALUES) {
      return `criteria.values may name at most ${MAX_AUTOFILTER_VALUES} values`;
    }
    for (const v of c.values) {
      if (!isBoundedString(v, MAX_AUTOFILTER_VALUE_CHARS)) {
        return `each criteria.values entry must be a string (max ${MAX_AUTOFILTER_VALUE_CHARS} chars)`;
      }
    }
    if (c.includeBlanks !== undefined && typeof c.includeBlanks !== "boolean") {
      return "criteria.includeBlanks must be a boolean";
    }
    return true;
  }
  if (c.kind === "custom") {
    const known = checkKnownKeys(
      c,
      ["kind", "criterion1", "criterion2", "operator"],
      "criteria option",
    );
    if (known !== true) return known;
    if (!isBoundedString(c.criterion1, MAX_AUTOFILTER_CRITERION) || c.criterion1.trim() === "") {
      return `criteria.criterion1 must be a non-empty string (max ${MAX_AUTOFILTER_CRITERION} chars)`;
    }
    if (
      c.criterion2 !== undefined &&
      c.criterion2 !== null &&
      !isBoundedString(c.criterion2, MAX_AUTOFILTER_CRITERION)
    ) {
      return `criteria.criterion2 must be a string (max ${MAX_AUTOFILTER_CRITERION} chars)`;
    }
    if (c.operator !== undefined && c.operator !== "and" && c.operator !== "or") {
      return 'criteria.operator must be "and" or "or"';
    }
    return true;
  }
  return 'criteria.kind must be "values" or "custom"';
};

/** cap.filePrintPdf args: [suggestedName?]. */
export const vPrintPdf: Validator = ([suggestedName]) => {
  if (suggestedName === undefined || suggestedName === null) return true;
  if (!isSafeFileName(suggestedName)) {
    return `suggestedName must be a bare file name — no folders, no drive letters, no ".." (max ${MAX_FILE_NAME} chars)`;
  }
  if (!/\.pdf$/i.test(suggestedName)) return 'suggestedName must end in ".pdf"';
  return true;
};

// ============================================================================
// Page setup + print layout (Wave 4, SHEETS cluster)
// ============================================================================
//
// The whole family is ACTIVE-SHEET-ONLY like AutoFilter: every backend print
// command acts on the active sheet, so the optional trailing sheet ref is a
// flagged slot the host refuses unless it names the active sheet. The patch
// vocabulary below mirrors the Rust `PageSetup` struct — minus printArea /
// printTitles* / manual*Breaks, which have their OWN rows (setPrintArea,
// addPageBreak, ...) and must not grow a second, competing spelling here.

/** The PageSetup keys a script may patch, each with its accepted shape. */
const PAGE_SETUP_PATCH_KEYS = [
  "paperSize", "orientation",
  "marginTop", "marginBottom", "marginLeft", "marginRight",
  "marginHeader", "marginFooter",
  "scale", "fitToWidth", "fitToHeight",
  "printGridlines", "printHeadings",
  "centerHorizontally", "centerVertically",
  "header", "footer",
] as const;

const PAGE_SETUP_PAPER_SIZES: ReadonlySet<string> = new Set([
  "letter", "a4", "a3", "legal", "tabloid",
]);

/** Header/footer template length cap ("&L&F&C&P of &N"-style strings). */
const MAX_HEADER_FOOTER_CHARS = 512;

/** One patch key's value check; null = OK. */
function pageSetupValueError(key: string, v: unknown): string | null {
  switch (key) {
    case "paperSize":
      return typeof v === "string" && PAGE_SETUP_PAPER_SIZES.has(v)
        ? null
        : `patch.paperSize must be one of: ${[...PAGE_SETUP_PAPER_SIZES].join(", ")}`;
    case "orientation":
      return v === "portrait" || v === "landscape"
        ? null
        : 'patch.orientation must be "portrait" or "landscape"';
    case "marginTop": case "marginBottom": case "marginLeft": case "marginRight":
    case "marginHeader": case "marginFooter":
      return isFiniteNumber(v) && v >= 0 && v <= 10
        ? null
        : `patch.${key} must be a number of inches (0 to 10)`;
    case "scale":
      return isFiniteNumber(v) && Number.isInteger(v) && v >= 10 && v <= 400
        ? null
        : "patch.scale must be an integer percent (10 to 400)";
    case "fitToWidth": case "fitToHeight":
      return isFiniteNumber(v) && Number.isInteger(v) && v >= 0 && v <= 32_767
        ? null
        : `patch.${key} must be a non-negative integer page count (0 = off)`;
    case "printGridlines": case "printHeadings":
    case "centerHorizontally": case "centerVertically":
      return typeof v === "boolean" ? null : `patch.${key} must be a boolean`;
    case "header": case "footer":
      return isBoundedString(v, MAX_HEADER_FOOTER_CHARS)
        ? null
        : `patch.${key} must be a string (max ${MAX_HEADER_FOOTER_CHARS} chars)`;
    default:
      return `unknown patch key "${key}"`;
  }
}

/** api.setPageSetup args: [patch, sheet?]. PARTIAL on purpose — only the keys
 *  present change, exactly like setRangeFormat. */
export const vPageSetupPatch: Validator = ([patch, sheet]) => {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    return "patch must be an object of page-setup properties";
  }
  const p = patch as Record<string, unknown>;
  const known = checkKnownKeys(p, PAGE_SETUP_PATCH_KEYS, "page-setup property");
  if (known !== true) return known;
  const keys = Object.keys(p);
  if (keys.length === 0) return "patch must name at least one page-setup property";
  for (const key of keys) {
    const err = pageSetupValueError(key, p[key]);
    if (err !== null) return err;
  }
  return checkOptionalSheetRef(sheet, "sheet");
};

/** api.setPrintArea args: [startRow, startCol, endRow, endCol, sheet?]. */
export const vPrintArea: Validator = ([startRow, startCol, endRow, endCol, sheet]) => {
  for (const [name, v] of [
    ["startRow", startRow], ["startCol", startCol],
    ["endRow", endRow], ["endCol", endCol],
  ] as const) {
    if (!isCellCoord(v)) return `${name} must be a non-negative integer`;
  }
  if ((endRow as number) < (startRow as number)) return "endRow must be >= startRow";
  if ((endCol as number) < (startCol as number)) return "endCol must be >= startCol";
  return checkOptionalSheetRef(sheet, "sheet");
};

/** api.addPageBreak / api.removePageBreak args: [kind, index, sheet?]. A "row"
 *  break sits ABOVE `index`; a "col" break sits LEFT of it — so index 0 has no
 *  meaning for add (there is nothing above row 1), which the host refuses. */
export const vPageBreak: Validator = ([kind, index, sheet]) => {
  if (kind !== "row" && kind !== "col") return 'kind must be "row" or "col"';
  if (!isCellCoord(index)) return "index must be a non-negative integer";
  return checkOptionalSheetRef(sheet, "sheet");
};

// ============================================================================
// Outline grouping (Wave 4, SHEETS cluster) — over @api/groupingService
// ============================================================================

/** A group span may cover at most this many rows/columns. Not a security bound
 *  — the backend stores one level per row — but a million-row group is a
 *  mistake worth catching before the outline bar tries to draw it. */
export const MAX_GROUP_SPAN = 1_048_576;

/** api.groupRows / ungroupRows / groupColumns / ungroupColumns args:
 *  [start, end, sheet?] (0-based, inclusive — the ribbon's own vocabulary). */
export const vGroupSpan: Validator = ([start, end, sheet]) => {
  if (!isCellCoord(start)) return "start must be a non-negative integer";
  if (!isCellCoord(end)) return "end must be a non-negative integer";
  if ((end as number) < (start as number)) return "end must be >= start";
  if ((end as number) - (start as number) + 1 > MAX_GROUP_SPAN) {
    return `group span too large (max ${MAX_GROUP_SPAN})`;
  }
  return checkOptionalSheetRef(sheet, "sheet");
};

/** Excel's outline depth cap (8 levels, shown as buttons 1-8). */
const MAX_OUTLINE_LEVEL = 8;

/** api.showOutlineLevel args: [rowLevel | null, colLevel | null] — at least
 *  one axis. Level 0 collapses everything; level N shows groups to depth N. */
export const vOutlineLevel: Validator = ([rowLevel, colLevel, sheet]) => {
  const rowGiven = rowLevel !== undefined && rowLevel !== null;
  const colGiven = colLevel !== undefined && colLevel !== null;
  if (!rowGiven && !colGiven) return "pass rowLevel, colLevel, or both";
  for (const [name, given, v] of [
    ["rowLevel", rowGiven, rowLevel],
    ["colLevel", colGiven, colLevel],
  ] as const) {
    if (!given) continue;
    if (!isFiniteNumber(v) || !Number.isInteger(v) || v < 0 || v > MAX_OUTLINE_LEVEL) {
      return `${name} must be an integer between 0 and ${MAX_OUTLINE_LEVEL}, or null`;
    }
  }
  return checkOptionalSheetRef(sheet, "sheet");
};

// ============================================================================
// cap.scheduleOnce (Wave 4) — the one-shot half of Application.OnTime
// ============================================================================

/** The one-shot delay floor, mirroring Rust MIN_ONCE_DELAY_SECS
 *  (scripting/scheduler.rs) — pinned by a test, never imported across the
 *  boundary. */
export const MIN_ONCE_DELAY_SECS = 5;

/** cap.scheduleOnce args: [atMs, handler, options?]. `atMs` is an absolute
 *  epoch-millisecond time (the worker shim converts a Date). Whether it is
 *  far enough in the FUTURE is the host's business (validators never read the
 *  clock); the host floors the delay to MIN_ONCE_DELAY_SECS and refuses more
 *  than a year out. */
export const vScheduleOnce: Validator = ([atMs, handler, options]) => {
  if (!isFiniteNumber(atMs) || atMs < 0) {
    return "atMs must be an epoch-millisecond number (or pass a Date to schedule.once)";
  }
  return scheduleHandlerError(handler) ?? scheduleOptionsError(options) ?? true;
};
