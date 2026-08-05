//! FILENAME: app/src/api/scriptHost/__tests__/formatReadback.test.ts
// PURPOSE: Wave 3 items 1 + 2 — format READ-BACK and range-edge borders.
// COVERS:  (1) validator matrices: the three range-edge border keys, the
//              locked/formulaHidden tier gate (vRangeFormat refuses,
//              vRangeFormatUnlocked accepts);
//          (2) ALLOWLIST wiring for the four read rows + the swapped
//              api.setRangeFormat validator;
//          (3) THE CONTRACT: setRangeFormat(X) -> getRangeFormat === X for a
//              matrix covering EVERY SCRIPT_FORMAT_KEYS entry, driven through
//              the real applyRangeFormat/readRangeFormats executors over a
//              backend emulator that reproduces the Rust write mapping
//              (styles.rs apply_formatting/apply_border_preset +
//              api_types.rs StyleData::from_cell_style) faithfully;
//          (4) border DECOMPOSITION: outline/insideH/insideV land as per-cell
//              truth via apply_border_preset, are refused off-sheet, and the
//              per-side keys keep their per-cell semantics;
//          (5) read plumbing: dense fill, per-style caching, active-sheet
//              viewport reads vs cross-sheet watch-cell reads;
//          (6) the worker shim + range.getFormats()/getFormat() sugar dispatch
//              the right broker rows with the right argument order.

import { describe, it, expect, vi } from "vitest";

vi.mock("../../grid", () => ({
  refreshGridData: vi.fn(),
  refreshGridDimensions: vi.fn(),
  convertFormulaStyle: vi.fn(async (f: string) => f),
}));

import {
  checkFormatObject,
  checkColorValue,
  checkFillParam,
  vRangeFormat,
  vRangeFormatUnlocked,
  SCRIPT_FORMAT_KEYS,
  SCRIPT_RANGE_BORDER_KEYS,
  SCRIPT_THEME_SLOTS,
  SCRIPT_FILL_PATTERN_TYPES,
  SCRIPT_GRADIENT_DIRECTIONS,
  MAX_RANGE_CELLS,
  vRangeRef,
  vCellRef,
} from "../validators";
import { ALLOWLIST } from "../allowlist";
import {
  applyRangeFormat,
  readRangeFormats,
  readCellFormat,
  styleDataToScriptFormat,
  borderPresetArgs,
  applyThemeTint,
  resolveThemeColorRef,
  type ScriptCellFormat,
  type ScriptRangeFormat,
} from "../host";
import { buildWorkerContext, type WorkerRuntime } from "../worker/contextShims";
import type { MountSpec, W2H } from "../protocol";

// ============================================================================
// (1) validators
// ============================================================================

describe("range-edge border keys in the format gate", () => {
  it("are members of SCRIPT_FORMAT_KEYS and take the border-side shape", () => {
    for (const key of SCRIPT_RANGE_BORDER_KEYS) {
      expect(SCRIPT_FORMAT_KEYS.has(key), key).toBe(true);
      expect(checkFormatObject({ [key]: { style: "thin", color: "#000000" } }), key).toBe(true);
      expect(checkFormatObject({ [key]: { style: "solid", color: "#000000" } }), key).not.toBe(true);
      expect(checkFormatObject({ [key]: { style: "thin" } }), key).not.toBe(true);
      expect(checkFormatObject({ [key]: "thin" }), key).not.toBe(true);
    }
  });
});

describe("locked / formulaHidden tier gate", () => {
  it("vRangeFormat (restricted rows) refuses them WITH the reason", () => {
    for (const key of ["locked", "formulaHidden"]) {
      const verdict = vRangeFormat([0, 0, 1, 1, { [key]: false }]);
      expect(verdict, key).not.toBe(true);
      expect(String(verdict)).toContain("protection");
      expect(String(verdict)).toContain("unlocked");
    }
  });

  it("vRangeFormatUnlocked accepts booleans and still type-checks them", () => {
    expect(vRangeFormatUnlocked([0, 0, 1, 1, { locked: false }])).toBe(true);
    expect(vRangeFormatUnlocked([0, 0, 1, 1, { formulaHidden: true, bold: true }])).toBe(true);
    expect(vRangeFormatUnlocked([0, 0, 1, 1, { locked: "no" }])).not.toBe(true);
    expect(vRangeFormatUnlocked([0, 0, 1, 1, { formulaHidden: 1 }])).not.toBe(true);
    // Everything else stays exactly as strict as the base gate.
    expect(vRangeFormatUnlocked([0, 0, 1, 1, { bgColor: "#ffffff" }])).not.toBe(true);
    expect(vRangeFormatUnlocked([0, 0, MAX_RANGE_CELLS, 0, { bold: true }])).not.toBe(true);
  });

  it("the keys stay OUT of SCRIPT_FORMAT_KEYS (the shared enumeration)", () => {
    expect(SCRIPT_FORMAT_KEYS.has("locked")).toBe(false);
    expect(SCRIPT_FORMAT_KEYS.has("formulaHidden")).toBe(false);
  });
});

// ============================================================================
// (2) allowlist wiring
// ============================================================================

describe("format read-back allowlist rows", () => {
  it("the api.* rows are unlocked-tier reads with the range/cell validators", () => {
    expect(ALLOWLIST["api.getRangeFormat"]).toMatchObject({ tier: "unlocked", class: "read" });
    expect(ALLOWLIST["api.getRangeFormat"].validate).toBe(vRangeRef);
    expect(ALLOWLIST["api.getRangeFormat"].limits?.maxCells).toBe(MAX_RANGE_CELLS);
    expect(ALLOWLIST["api.getCellFormat"]).toMatchObject({ tier: "unlocked", class: "read" });
    expect(ALLOWLIST["api.getCellFormat"].validate).toBe(vCellRef);
    expect(ALLOWLIST["api.getRangeFormat"].capability).toBeUndefined();
  });

  it("the sheet.* twins are restricted-tier reads (active-sheet clamped)", () => {
    expect(ALLOWLIST["sheet.getRangeFormat"]).toMatchObject({ tier: "restricted", class: "read" });
    expect(ALLOWLIST["sheet.getRangeFormat"].validate).toBe(vRangeRef);
    expect(ALLOWLIST["sheet.getCellFormat"]).toMatchObject({ tier: "restricted", class: "read" });
    expect(ALLOWLIST["sheet.getCellFormat"].validate).toBe(vCellRef);
  });

  it("ONLY api.setRangeFormat takes the protection-accepting validator", () => {
    expect(ALLOWLIST["api.setRangeFormat"].validate).toBe(vRangeFormatUnlocked);
    expect(ALLOWLIST["sheet.setRangeFormat"].validate).toBe(vRangeFormat);
  });
});

// ============================================================================
// The backend emulator — the Rust write mapping, reproduced faithfully
// ============================================================================
// styles.rs apply_formatting applies each present key onto a clone of the
// cell's current style; api_types.rs from_cell_style reports it back. What is
// emulated here is exactly that pair (plus apply_border_preset's per-cell
// decomposition), so the round-trip below tests OUR vocabulary mapping
// against the backend's documented behaviour, not a convenient fiction.

interface EmuBorderSide {
  style: string;
  color: string;
  width: number;
}
/** A fill as StyleData carries it (fill_to_data's shape, keys flattened). */
interface EmuFill {
  type: string;
  [key: string]: unknown;
}
interface EmuStyle {
  bold: boolean;
  italic: boolean;
  underline: string;
  strikethrough: boolean;
  fontSize: number;
  fontFamily: string;
  textColor: string;
  backgroundColor: string;
  textAlign: string;
  verticalAlign: string;
  numberFormat: string;
  wrapText: boolean;
  textRotation: string;
  indent: number;
  shrinkToFit: boolean;
  borderTop: EmuBorderSide;
  borderRight: EmuBorderSide;
  borderBottom: EmuBorderSide;
  borderLeft: EmuBorderSide;
  borderDiagonalDown: EmuBorderSide;
  borderDiagonalUp: EmuBorderSide;
  textColorTheme?: string;
  textColorTint?: number;
  bgColorTheme?: string;
  bgColorTint?: number;
  fill?: EmuFill;
  locked: boolean;
  formulaHidden: boolean;
}

const NO_BORDER: EmuBorderSide = { style: "none", color: "#000000", width: 0 };

/** The Office theme, as get_document_theme reports it (theme.rs office()). */
const OFFICE_THEME = {
  name: "Office",
  colors: {
    dark1: "#000000", light1: "#ffffff", dark2: "#44546a", light2: "#e7e6e6",
    accent1: "#4472c4", accent2: "#ed7d31", accent3: "#a5a5a5",
    accent4: "#ffc000", accent5: "#5b9bd5", accent6: "#70ad47",
    hyperlink: "#0563c1", followedHyperlink: "#954f72",
  } as Record<string, string>,
  fonts: { heading: "Calibri Light", body: "Calibri" },
};

/** ThemeColor::to_css over the Office theme (slot + PERMILLE tint). */
const resolveEmuTheme = (slot: string, tintPermille: number): string =>
  applyThemeTint(OFFICE_THEME.colors[slot] ?? "#000000", tintPermille / 1000);

function defaultStyle(): EmuStyle {
  // The REAL default CellStyle stores THEME REFERENCES: text = Dark1,
  // background = Light1 (from_cell_style reports both slot and resolved hex).
  return {
    bold: false, italic: false, underline: "none", strikethrough: false,
    fontSize: 11, fontFamily: "Calibri",
    textColor: "#000000", backgroundColor: "#ffffff",
    textColorTheme: "dark1", textColorTint: 0,
    bgColorTheme: "light1", bgColorTint: 0,
    textAlign: "general", verticalAlign: "middle", numberFormat: "General",
    wrapText: false, textRotation: "none", indent: 0, shrinkToFit: false,
    borderTop: { ...NO_BORDER }, borderRight: { ...NO_BORDER },
    borderBottom: { ...NO_BORDER }, borderLeft: { ...NO_BORDER },
    borderDiagonalDown: { ...NO_BORDER }, borderDiagonalUp: { ...NO_BORDER },
    locked: true, formulaHidden: false,
  };
}

/** Color::from_hex(...).to_css(): '#' restored, lowercased. */
const cssColor = (hex: string): string =>
  (hex.startsWith("#") ? hex : `#${hex}`).toLowerCase();

/** parse_border_side (styles.rs): the word decides line style AND width. */
function parseBorderSide(side: { style: string; color: string }): EmuBorderSide {
  const width =
    side.style === "none" ? 0
    : side.style === "thin" ? 1
    : side.style === "medium" ? 2
    : side.style === "thick" ? 3
    : 1; // dashed | dotted | double
  return { style: side.style === "none" ? "none" : side.style, color: cssColor(side.color), width };
}

/** border_side_to_data (api_types.rs): width + line style fold back to a word.
 *  Solid widths 1/2/3 read thin/medium/thick; width 0 reads "none". */
function borderSideWord(side: EmuBorderSide): { style: string; color: string } {
  if (side.width === 0 || side.style === "none") return { style: "none", color: side.color };
  if (side.style === "solid" || ["thin", "medium", "thick"].includes(side.style)) {
    const word = side.width === 1 ? "thin" : side.width === 2 ? "medium" : "thick";
    return { style: word, color: side.color };
  }
  return { style: side.style, color: side.color };
}

/** parse_text_rotation (styles.rs). */
function parseTextRotation(rotation: string): string {
  switch (rotation) {
    case "none": case "0": return "none";
    case "rotate90": case "90": case "up": return "rotate90";
    case "rotate270": case "270": case "-90": case "down": return "rotate270";
    default: {
      const custom = rotation.startsWith("custom:") ? Number(rotation.slice(7)) : NaN;
      if (Number.isFinite(custom)) {
        if (custom === 0) return "none";
        if (custom === 90) return "rotate90";
        if (custom === -90) return "rotate270";
        return `custom:${custom}`;
      }
      return "none";
    }
  }
}

/** parse_number_format -> format_number_format_name for the codes this test
 *  writes ("General" round-trips; a recognized code reads back as its name). */
function numberFormatName(format: string): string {
  if (format.toLowerCase() === "general") return "General";
  if (/^0(\.0+)?%$/.test(format)) {
    const decimals = format.includes(".") ? format.length - format.indexOf(".") - 2 : 0;
    return `Percentage (${decimals} decimals)`;
  }
  return format; // custom strings carry through
}

/** parse_theme_or_absolute + resolve_theme_color, for ONE fill color slot. */
function emuFillColor(
  hex: unknown,
  theme: unknown,
  tint: unknown,
): { color: string; theme?: string; tint?: number } {
  if (typeof theme === "string" && OFFICE_THEME.colors[theme]) {
    const t = typeof tint === "number" ? tint : 0;
    return { color: resolveEmuTheme(theme, t), theme, tint: t };
  }
  return { color: cssColor(hex as string) };
}

/** parse_fill_param -> Fill -> fill_to_data, plus Fill::background_color()'s
 *  primary derivation (styles.rs + api_types.rs, branch for branch). */
function emuFillFromParam(p: Record<string, unknown>): {
  fill?: EmuFill;
  primary: { color: string; theme?: string; tint?: number };
} {
  switch (p.type) {
    case "none":
      // Fill::None: fill_to_data reports None; background falls back to the
      // DEFAULT_BACKGROUND theme reference (Light1).
      return { fill: undefined, primary: { color: "#ffffff", theme: "light1", tint: 0 } };
    case "solid": {
      const c = emuFillColor(p.color, p.colorTheme, p.colorTint);
      return {
        fill: { type: "solid", color: c.color, colorTheme: c.theme, colorTint: c.tint },
        primary: c,
      };
    }
    case "pattern": {
      const fg = emuFillColor(p.fgColor, p.fgColorTheme, p.fgColorTint);
      const bg = emuFillColor(p.bgColor, p.bgColorTheme, p.bgColorTint);
      return {
        fill: {
          type: "pattern", patternType: p.patternType,
          fgColor: fg.color, bgColor: bg.color,
          fgColorTheme: fg.theme, fgColorTint: fg.tint,
          bgColorTheme: bg.theme, bgColorTint: bg.tint,
        },
        primary: bg,
      };
    }
    default: {
      const c1 = emuFillColor(p.color1, p.color1Theme, p.color1Tint);
      const c2 = emuFillColor(p.color2, p.color2Theme, p.color2Tint);
      return {
        fill: {
          type: "gradient", direction: p.direction,
          color1: c1.color, color2: c2.color,
          color1Theme: c1.theme, color1Tint: c1.tint,
          color2Theme: c2.theme, color2Tint: c2.tint,
        },
        primary: c1,
      };
    }
  }
}

/** apply_formatting's per-key application (styles.rs:283-400). */
function applyFormatToStyle(style: EmuStyle, f: Record<string, unknown>): EmuStyle {
  const s: EmuStyle = JSON.parse(JSON.stringify(style));
  if (f.bold !== undefined) s.bold = f.bold as boolean;
  if (f.italic !== undefined) s.italic = f.italic as boolean;
  if (f.underline !== undefined) s.underline = f.underline as string;
  if (f.strikethrough !== undefined) s.strikethrough = f.strikethrough as boolean;
  if (f.fontSize !== undefined) s.fontSize = f.fontSize as number;
  if (f.fontFamily !== undefined) s.fontFamily = f.fontFamily as string;
  // Absolute text color -> ThemeColor::Absolute (theme fields drop); a theme
  // slot -> ThemeColor::Theme (applied AFTER, so the theme wins if both).
  if (f.textColor !== undefined) {
    s.textColor = cssColor(f.textColor as string);
    delete s.textColorTheme;
    delete s.textColorTint;
  }
  if (f.textColorTheme !== undefined) {
    const tint = typeof f.textColorTint === "number" ? f.textColorTint : 0;
    s.textColorTheme = f.textColorTheme as string;
    s.textColorTint = tint;
    s.textColor = resolveEmuTheme(f.textColorTheme as string, tint);
  }
  // Background writes store Fill::Solid — that IS how the engine keeps it.
  if (f.backgroundColor !== undefined) {
    const hex = cssColor(f.backgroundColor as string);
    s.backgroundColor = hex;
    delete s.bgColorTheme;
    delete s.bgColorTint;
    s.fill = { type: "solid", color: hex };
  }
  if (f.bgColorTheme !== undefined) {
    const tint = typeof f.bgColorTint === "number" ? f.bgColorTint : 0;
    const hex = resolveEmuTheme(f.bgColorTheme as string, tint);
    s.bgColorTheme = f.bgColorTheme as string;
    s.bgColorTint = tint;
    s.backgroundColor = hex;
    s.fill = { type: "solid", color: hex, colorTheme: f.bgColorTheme, colorTint: tint };
  }
  if (f.textAlign !== undefined) s.textAlign = f.textAlign as string;
  if (f.verticalAlign !== undefined) s.verticalAlign = f.verticalAlign as string;
  if (f.wrapText !== undefined) s.wrapText = f.wrapText as boolean;
  if (f.textRotation !== undefined) s.textRotation = parseTextRotation(f.textRotation as string);
  if (f.numberFormat !== undefined) s.numberFormat = numberFormatName(f.numberFormat as string);
  if (f.indent !== undefined) s.indent = f.indent as number;
  if (f.shrinkToFit !== undefined) s.shrinkToFit = f.shrinkToFit as boolean;
  for (const key of [
    "borderTop", "borderRight", "borderBottom", "borderLeft",
    "borderDiagonalDown", "borderDiagonalUp",
  ] as const) {
    if (f[key] !== undefined) s[key] = parseBorderSide(f[key] as { style: string; color: string });
  }
  // Fill is applied AFTER the background shorthand (styles.rs order), so an
  // explicit fill wins; the reported backgroundColor derives from its primary.
  if (f.fill !== undefined) {
    const { fill, primary } = emuFillFromParam(f.fill as Record<string, unknown>);
    if (fill === undefined) delete s.fill;
    else s.fill = fill;
    s.backgroundColor = primary.color;
    if (primary.theme) {
      s.bgColorTheme = primary.theme;
      s.bgColorTint = primary.tint ?? 0;
    } else {
      delete s.bgColorTheme;
      delete s.bgColorTint;
    }
  }
  if (f.locked !== undefined) s.locked = f.locked as boolean;
  if (f.formulaHidden !== undefined) s.formulaHidden = f.formulaHidden as boolean;
  return s;
}

/** StyleData::from_cell_style, for the fields the script surface reads. */
function emuStyleToStyleData(s: EmuStyle): Record<string, unknown> {
  return {
    ...s,
    borderTop: borderSideWord(s.borderTop),
    borderRight: borderSideWord(s.borderRight),
    borderBottom: borderSideWord(s.borderBottom),
    borderLeft: borderSideWord(s.borderLeft),
    borderDiagonalDown: borderSideWord(s.borderDiagonalDown),
    borderDiagonalUp: borderSideWord(s.borderDiagonalUp),
  };
}

/** The in-memory backend: a style registry + per-cell style indexes. */
function makeFormatLib() {
  const styles: EmuStyle[] = [defaultStyle()];
  const cellStyle = new Map<string, number>(); // "r,c" -> style index (active sheet)
  const getOrCreate = (style: EmuStyle): number => {
    const json = JSON.stringify(style);
    const found = styles.findIndex((s) => JSON.stringify(s) === json);
    if (found !== -1) return found;
    styles.push(style);
    return styles.length - 1;
  };
  const styleIndexAt = (row: number, col: number): number => cellStyle.get(`${row},${col}`) ?? 0;
  const presetCalls: unknown[][] = [];
  const formattingCalls: unknown[][] = [];
  const lib = {
    getActiveSheet: vi.fn(async () => 0),
    getSheets: vi.fn(async () => ({
      sheets: [0, 1, 2].map((i) => ({ index: i, name: `Sheet${i + 1}` })),
      activeIndex: 0,
    })),
    getDocumentTheme: vi.fn(async () => OFFICE_THEME),
    getUndoState: vi.fn(async () => ({ transactionOpen: false })),
    beginUndoTransaction: vi.fn(async () => undefined),
    commitUndoTransaction: vi.fn(async () => undefined),
    cancelUndoTransaction: vi.fn(async () => undefined),
    applyFormatting: vi.fn(async (rows: number[], cols: number[], format: Record<string, unknown>) => {
      formattingCalls.push([rows, cols, format]);
      for (const row of rows) {
        for (const col of cols) {
          const next = applyFormatToStyle(styles[styleIndexAt(row, col)], format);
          cellStyle.set(`${row},${col}`, getOrCreate(next));
        }
      }
      return { cells: [], styles: [] };
    }),
    applyFormattingToSheets: vi.fn(async () => undefined),
    applyBorderPreset: vi.fn(async (
      sr: number, sc: number, er: number, ec: number,
      preset: string, style: string, color: string, width: number,
    ) => {
      presetCalls.push([sr, sc, er, ec, preset, style, color, width]);
      const active: EmuBorderSide = { style, color: cssColor(color), width };
      for (let row = sr; row <= er; row++) {
        for (let col = sc; col <= ec; col++) {
          const next: EmuStyle = JSON.parse(JSON.stringify(styles[styleIndexAt(row, col)]));
          // apply_border_preset (styles.rs:1168-1234), branch for branch.
          if (preset === "insideHorizontal" || preset === "insideBoth") {
            if (row < er) next.borderBottom = { ...active };
            if (row > sr) next.borderTop = { ...active };
          }
          if (preset === "insideVertical" || preset === "insideBoth") {
            if (col < ec) next.borderRight = { ...active };
            if (col > sc) next.borderLeft = { ...active };
          }
          if (preset === "outside") {
            if (row === sr) next.borderTop = { ...active };
            if (row === er) next.borderBottom = { ...active };
            if (col === sc) next.borderLeft = { ...active };
            if (col === ec) next.borderRight = { ...active };
          }
          cellStyle.set(`${row},${col}`, getOrCreate(next));
        }
      }
      return { cells: [], styles: [] };
    }),
    getViewportCells: vi.fn(async (sr: number, sc: number, er: number, ec: number) => {
      const out: Array<{ row: number; col: number; styleIndex: number }> = [];
      for (const [key, styleIndex] of cellStyle) {
        const [row, col] = key.split(",").map(Number);
        if (row >= sr && row <= er && col >= sc && col <= ec && styleIndex !== 0) {
          out.push({ row, col, styleIndex });
        }
      }
      return out;
    }),
    getWatchCells: vi.fn(async (requests: Array<[number, number, number]>) =>
      requests.map(() => null),
    ),
    getStyle: vi.fn(async (index: number) => emuStyleToStyleData(styles[index] ?? styles[0])),
  };
  return { lib, presetCalls, formattingCalls, styleIndexAt, styles };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asLib = (l: unknown) => l as any;

// ============================================================================
// (3) THE CONTRACT: setRangeFormat(X) -> getRangeFormat reports X
// ============================================================================

/** One write value per SCRIPT_FORMAT_KEYS entry, chosen to round-trip
 *  EXACTLY (colors are written canonical-lowercase; the case-folding is its
 *  own test below). */
const PER_CELL_MATRIX: Record<string, unknown> = {
  bold: true,
  italic: true,
  underline: "doubleAccounting",
  strikethrough: true,
  fontSize: 24,
  fontFamily: "Arial",
  textColor: "#123456",
  backgroundColor: "#fedcba",
  textAlign: "center",
  verticalAlign: "top",
  numberFormat: "General",
  wrapText: true,
  textRotation: "rotate90",
  indent: 5,
  shrinkToFit: true,
  borderTop: { style: "thin", color: "#ff0000" },
  borderRight: { style: "medium", color: "#00ff00" },
  borderBottom: { style: "thick", color: "#0000ff" },
  borderLeft: { style: "dashed", color: "#111111" },
  borderDiagonalDown: { style: "dotted", color: "#222222" },
  borderDiagonalUp: { style: "double", color: "#333333" },
  // Wave 4: absolute colors round-trip verbatim; theme fill colors are the
  // separate theme suite below (a written {theme} gains its explicit tint on
  // the way back, so verbatim equality needs the tint spelled out).
  fill: { type: "pattern", patternType: "darkGrid", fgColor: "#112233", bgColor: "#445566" },
};
const RANGE_EDGE_MATRIX: Record<string, { style: string; color: string }> = {
  borderOutline: { style: "medium", color: "#101010" },
  borderInsideHorizontal: { style: "thin", color: "#202020" },
  borderInsideVertical: { style: "dotted", color: "#303030" },
};

describe("the round-trip contract (setRangeFormat -> getRangeFormat)", () => {
  it("the matrix covers EVERY SCRIPT_FORMAT_KEYS entry (a new key must join it)", () => {
    const covered = new Set([...Object.keys(PER_CELL_MATRIX), ...Object.keys(RANGE_EDGE_MATRIX)]);
    expect([...SCRIPT_FORMAT_KEYS].sort()).toEqual([...covered].sort());
  });

  it("every per-cell key reads back exactly what was written", async () => {
    for (const [key, value] of Object.entries(PER_CELL_MATRIX)) {
      const { lib } = makeFormatLib();
      await applyRangeFormat(asLib(lib), undefined, 1, 1, 2, 3, { [key]: value } as ScriptRangeFormat);
      const grid = await readRangeFormats(asLib(lib), undefined, 1, 1, 2, 3);
      for (const row of grid) {
        for (const cell of row) {
          expect((cell as unknown as Record<string, unknown>)[key], key).toEqual(value);
        }
      }
    }
  });

  it("a combined write reads back combined, and untouched cells stay default", async () => {
    const { lib } = makeFormatLib();
    await applyRangeFormat(asLib(lib), undefined, 0, 0, 0, 0, {
      bold: true, textColor: "#123456", numberFormat: "General",
      borderBottom: { style: "double", color: "#00aa00" },
    });
    const grid = await readRangeFormats(asLib(lib), undefined, 0, 0, 1, 0);
    expect(grid[0][0]).toMatchObject({
      bold: true,
      textColor: "#123456",
      numberFormat: "General",
      borderBottom: { style: "double", color: "#00aa00" },
      italic: false,
      locked: true,
    });
    // The neighbour was never formatted: full default read-back. The DEFAULT
    // cell is THEME-REFERENCED (text = dark1, background = light1) — that is
    // genuinely what the engine stores — with the resolved hex alongside.
    expect(grid[1][0]).toMatchObject({
      bold: false,
      textColor: { theme: "dark1", tint: 0 },
      textColorResolved: "#000000",
      backgroundColor: { theme: "light1", tint: 0 },
      backgroundColorResolved: "#ffffff",
      fill: { type: "none" },
      numberFormat: "General", borderBottom: { style: "none", color: "#000000" },
      locked: true, formulaHidden: false,
    });
  });

  it("locked / formulaHidden write through the unlocked path and read back", async () => {
    const { lib } = makeFormatLib();
    await applyRangeFormat(asLib(lib), undefined, 0, 0, 0, 0, { locked: false, formulaHidden: true });
    const cell = await readCellFormat(asLib(lib), undefined, 0, 0);
    expect(cell.locked).toBe(false);
    expect(cell.formulaHidden).toBe(true);
  });

  it("colors fold to canonical lowercase '#rrggbb' on the way back", async () => {
    const { lib } = makeFormatLib();
    await applyRangeFormat(asLib(lib), undefined, 0, 0, 0, 0, {
      textColor: "ABCDEF", borderTop: { style: "thin", color: "#FF00AA" },
    });
    const cell = await readCellFormat(asLib(lib), undefined, 0, 0);
    expect(cell.textColor).toBe("#abcdef");
    expect(cell.borderTop).toEqual({ style: "thin", color: "#ff00aa" });
  });

  it("a UI-set custom rotation reads back in the custom:N form", () => {
    const style = emuStyleToStyleData({ ...defaultStyle(), textRotation: "custom:45" });
    expect(styleDataToScriptFormat(style as never).textRotation).toBe("custom:45");
  });

  it("a recognized number-format code reads back as the backend's name", async () => {
    const { lib } = makeFormatLib();
    await applyRangeFormat(asLib(lib), undefined, 0, 0, 0, 0, { numberFormat: "0.00%" });
    const cell = await readCellFormat(asLib(lib), undefined, 0, 0);
    expect(cell.numberFormat).toBe("Percentage (2 decimals)");
  });
});

// ============================================================================
// (3b) THEME COLORS + PATTERN/GRADIENT FILLS (Wave 4, formatting breadth)
// ============================================================================

describe("theme color + fill vocabulary (validators)", () => {
  it("SCRIPT_THEME_SLOTS is exactly the engine's 12-slot set", () => {
    expect([...SCRIPT_THEME_SLOTS].sort()).toEqual(
      Object.keys(OFFICE_THEME.colors).sort(),
    );
  });

  it("checkColorValue accepts hex and { theme, tint? }, rejects the rest", () => {
    expect(checkColorValue("textColor", "#123456")).toBe(true);
    expect(checkColorValue("textColor", { theme: "accent1" })).toBe(true);
    expect(checkColorValue("textColor", { theme: "dark1", tint: -0.25 })).toBe(true);
    expect(checkColorValue("textColor", { theme: "accentX" })).not.toBe(true);
    expect(checkColorValue("textColor", { theme: "accent1", tint: 2 })).not.toBe(true);
    expect(checkColorValue("textColor", { theme: "accent1", shade: 1 })).not.toBe(true);
    expect(checkColorValue("textColor", "red")).not.toBe(true);
    expect(checkColorValue("textColor", 0xffffff)).not.toBe(true);
  });

  it("the format gate takes theme colors wherever a color goes", () => {
    expect(checkFormatObject({ textColor: { theme: "accent1", tint: 0.4 } })).toBe(true);
    expect(checkFormatObject({ backgroundColor: { theme: "light2" } })).toBe(true);
    expect(checkFormatObject({ borderTop: { style: "thin", color: { theme: "accent3" } } })).toBe(true);
    expect(checkFormatObject({ borderOutline: { style: "medium", color: { theme: "dark2", tint: -0.5 } } })).toBe(true);
    expect(checkFormatObject({ textColor: { theme: "nope" } })).not.toBe(true);
  });

  it("checkFillParam enumerates types, pattern names and directions", () => {
    expect(SCRIPT_FILL_PATTERN_TYPES.size).toBe(18);
    expect(SCRIPT_GRADIENT_DIRECTIONS.size).toBe(5);
    expect(checkFillParam({ type: "none" })).toBe(true);
    expect(checkFillParam({ type: "solid", color: "#ff0000" })).toBe(true);
    expect(checkFillParam({ type: "solid", color: { theme: "accent2", tint: 0.6 } })).toBe(true);
    expect(checkFillParam({
      type: "pattern", patternType: "lightGrid", fgColor: "#000000", bgColor: "#ffffff",
    })).toBe(true);
    expect(checkFillParam({
      type: "gradient", color1: "#ffffff", color2: { theme: "accent1" }, direction: "diagonalDown",
    })).toBe(true);
    // Typos fail with the accepted list, never silently become None.
    expect(checkFillParam({ type: "stripes" })).not.toBe(true);
    expect(checkFillParam({ type: "pattern", patternType: "zigzag", fgColor: "#000000", bgColor: "#ffffff" })).not.toBe(true);
    expect(checkFillParam({ type: "gradient", color1: "#ffffff", color2: "#000000", direction: "sideways" })).not.toBe(true);
    expect(checkFillParam({ type: "solid" })).not.toBe(true);
    expect(checkFillParam({ type: "none", color: "#ffffff" })).not.toBe(true);
    expect(checkFillParam({ type: "solid", color: "#ff0000", direction: "vertical" })).not.toBe(true);
    // The gate reaches fill through the format object too.
    expect(SCRIPT_FORMAT_KEYS.has("fill")).toBe(true);
    expect(checkFormatObject({ fill: { type: "solid", color: "#ff0000" } })).toBe(true);
    expect(checkFormatObject({ fill: { type: "wavy" } })).not.toBe(true);
  });
});

describe("applyThemeTint / resolveThemeColorRef (the engine's blend, mirrored)", () => {
  it("matches Excel's standard tint results for accent1", () => {
    // theme.rs apply_tint: positive blends toward white, negative toward black.
    expect(applyThemeTint("#4472c4", 0)).toBe("#4472c4");
    expect(applyThemeTint("#4472c4", 0.4)).toBe("#8faadc"); // "Lighter 40%"
    expect(applyThemeTint("#4472c4", -0.25)).toBe("#335693"); // "Darker 25%"
    expect(applyThemeTint("4472C4", 0)).toBe("#4472c4"); // canonicalizes
  });

  it("resolves a reference against a theme (missing tint = 0)", () => {
    expect(resolveThemeColorRef(OFFICE_THEME, { theme: "accent1" })).toBe("#4472c4");
    expect(resolveThemeColorRef(OFFICE_THEME, { theme: "accent1", tint: 0.4 })).toBe("#8faadc");
  });
});

describe("theme colors round-trip (write reference -> read reference)", () => {
  it("textColor { theme, tint } reads back as the theme object + resolved hex", async () => {
    const { lib } = makeFormatLib();
    await applyRangeFormat(asLib(lib), undefined, 0, 0, 0, 0, {
      textColor: { theme: "accent1", tint: 0.4 },
    });
    // The reference rides the *Theme/*Tint FormattingParams fields.
    expect(lib.applyFormatting.mock.calls[0][2]).toEqual({
      textColorTheme: "accent1", textColorTint: 400,
    });
    const cell = await readCellFormat(asLib(lib), undefined, 0, 0);
    expect(cell.textColor).toEqual({ theme: "accent1", tint: 0.4 });
    expect(cell.textColorResolved).toBe("#8faadc");
  });

  it("backgroundColor theme reads back as the theme object; the fill mirrors it", async () => {
    const { lib } = makeFormatLib();
    await applyRangeFormat(asLib(lib), undefined, 0, 0, 0, 0, {
      backgroundColor: { theme: "accent2" },
    });
    expect(lib.applyFormatting.mock.calls[0][2]).toEqual({
      bgColorTheme: "accent2", bgColorTint: 0,
    });
    const cell = await readCellFormat(asLib(lib), undefined, 0, 0);
    expect(cell.backgroundColor).toEqual({ theme: "accent2", tint: 0 });
    expect(cell.backgroundColorResolved).toBe("#ed7d31");
    expect(cell.fill).toEqual({ type: "solid", color: { theme: "accent2", tint: 0 } });
  });

  it("an absolute write CLEARS a previous theme reference", async () => {
    const { lib } = makeFormatLib();
    await applyRangeFormat(asLib(lib), undefined, 0, 0, 0, 0, {
      textColor: { theme: "accent1" },
    });
    await applyRangeFormat(asLib(lib), undefined, 0, 0, 0, 0, { textColor: "#123456" });
    const cell = await readCellFormat(asLib(lib), undefined, 0, 0);
    expect(cell.textColor).toBe("#123456");
    expect(cell.textColorResolved).toBe("#123456");
  });

  it("border theme colors are RESOLVED at write time and read back as hex", async () => {
    const { lib } = makeFormatLib();
    await applyRangeFormat(asLib(lib), undefined, 0, 0, 0, 0, {
      borderTop: { style: "thin", color: { theme: "accent1" } },
      borderBottom: { style: "medium", color: { theme: "accent1", tint: 0.4 } },
    });
    // The theme was consulted ONCE for the whole call.
    expect(lib.getDocumentTheme).toHaveBeenCalledTimes(1);
    const cell = await readCellFormat(asLib(lib), undefined, 0, 0);
    expect(cell.borderTop).toEqual({ style: "thin", color: "#4472c4" });
    expect(cell.borderBottom).toEqual({ style: "medium", color: "#8faadc" });
  });

  it("an all-absolute write never fetches the theme", async () => {
    const { lib } = makeFormatLib();
    await applyRangeFormat(asLib(lib), undefined, 0, 0, 0, 0, {
      bold: true, textColor: "#112233", fill: { type: "solid", color: "#445566" },
    });
    expect(lib.getDocumentTheme).not.toHaveBeenCalled();
  });
});

describe("fills round-trip", () => {
  it("a solid fill with a theme color round-trips the reference", async () => {
    const { lib } = makeFormatLib();
    await applyRangeFormat(asLib(lib), undefined, 0, 0, 0, 0, {
      fill: { type: "solid", color: { theme: "accent6", tint: 0.6 } },
    });
    const cell = await readCellFormat(asLib(lib), undefined, 0, 0);
    expect(cell.fill).toEqual({ type: "solid", color: { theme: "accent6", tint: 0.6 } });
    // The derived backgroundColor follows the fill's primary color.
    expect(cell.backgroundColor).toEqual({ theme: "accent6", tint: 0.6 });
  });

  it("a gradient round-trips verbatim (absolute colors)", async () => {
    const { lib } = makeFormatLib();
    const gradient = {
      type: "gradient", color1: "#ffffff", color2: "#4472c4", direction: "fromCenter",
    } as const;
    await applyRangeFormat(asLib(lib), undefined, 0, 0, 0, 0, { fill: gradient });
    const cell = await readCellFormat(asLib(lib), undefined, 0, 0);
    expect(cell.fill).toEqual(gradient);
  });

  it("{ type: 'none' } removes the fill (back to the default background)", async () => {
    const { lib } = makeFormatLib();
    await applyRangeFormat(asLib(lib), undefined, 0, 0, 0, 0, {
      fill: { type: "pattern", patternType: "darkGrid", fgColor: "#112233", bgColor: "#445566" },
    });
    await applyRangeFormat(asLib(lib), undefined, 0, 0, 0, 0, { fill: { type: "none" } });
    const cell = await readCellFormat(asLib(lib), undefined, 0, 0);
    expect(cell.fill).toEqual({ type: "none" });
    expect(cell.backgroundColor).toEqual({ theme: "light1", tint: 0 });
  });
});

// ============================================================================
// (4) border decomposition
// ============================================================================

describe("range-edge border decomposition", () => {
  it("maps each border word onto apply_border_preset's (style, width)", () => {
    expect(borderPresetArgs({ style: "none", color: "#000000" })).toEqual({ style: "solid", color: "#000000", width: 0 });
    expect(borderPresetArgs({ style: "thin", color: "#000000" })).toEqual({ style: "solid", color: "#000000", width: 1 });
    expect(borderPresetArgs({ style: "medium", color: "#000000" })).toEqual({ style: "solid", color: "#000000", width: 2 });
    expect(borderPresetArgs({ style: "thick", color: "#000000" })).toEqual({ style: "solid", color: "#000000", width: 3 });
    expect(borderPresetArgs({ style: "dashed", color: "#000000" })).toEqual({ style: "dashed", color: "#000000", width: 1 });
    expect(borderPresetArgs({ style: "dotted", color: "#000000" })).toEqual({ style: "dotted", color: "#000000", width: 1 });
    expect(borderPresetArgs({ style: "double", color: "#000000" })).toEqual({ style: "double", color: "#000000", width: 1 });
  });

  it("dispatches one preset call per edge key (insides first, outline last)", async () => {
    const { lib, presetCalls } = makeFormatLib();
    await applyRangeFormat(asLib(lib), undefined, 2, 1, 5, 4, {
      bold: true,
      borderOutline: RANGE_EDGE_MATRIX.borderOutline,
      borderInsideHorizontal: RANGE_EDGE_MATRIX.borderInsideHorizontal,
      borderInsideVertical: RANGE_EDGE_MATRIX.borderInsideVertical,
    });
    // The base (per-cell) keys go through apply_formatting WITHOUT the edge keys.
    expect(lib.applyFormatting).toHaveBeenCalledTimes(1);
    expect(lib.applyFormatting.mock.calls[0][2]).toEqual({ bold: true });
    expect(presetCalls).toEqual([
      [2, 1, 5, 4, "insideHorizontal", "solid", "#202020", 1],
      [2, 1, 5, 4, "insideVertical", "dotted", "#303030", 1],
      [2, 1, 5, 4, "outside", "solid", "#101010", 2],
    ]);
  });

  it("outline lands ONLY on the edge cells, per-cell truth readable back", async () => {
    const { lib } = makeFormatLib();
    const outline = { style: "medium", color: "#101010" };
    await applyRangeFormat(asLib(lib), undefined, 0, 0, 2, 2, { borderOutline: outline });
    const grid = await readRangeFormats(asLib(lib), undefined, 0, 0, 2, 2);
    const none = { style: "none", color: "#000000" };
    // Corner: two sides. Edge middle: one side. Center: none at all.
    expect(grid[0][0].borderTop).toEqual(outline);
    expect(grid[0][0].borderLeft).toEqual(outline);
    expect(grid[0][0].borderBottom).toEqual(none);
    expect(grid[0][1].borderTop).toEqual(outline);
    expect(grid[0][1].borderLeft).toEqual(none);
    expect(grid[1][1].borderTop).toEqual(none);
    expect(grid[1][1].borderBottom).toEqual(none);
    expect(grid[1][1].borderLeft).toEqual(none);
    expect(grid[1][1].borderRight).toEqual(none);
    expect(grid[2][2].borderBottom).toEqual(outline);
    expect(grid[2][2].borderRight).toEqual(outline);
    expect(grid[2][2].borderTop).toEqual(none);
  });

  it("insideHorizontal lands on BOTH adjoining cells and never the outer edge", async () => {
    const { lib } = makeFormatLib();
    const inside = { style: "thin", color: "#202020" };
    await applyRangeFormat(asLib(lib), undefined, 0, 0, 2, 0, { borderInsideHorizontal: inside });
    const grid = await readRangeFormats(asLib(lib), undefined, 0, 0, 2, 0);
    const none = { style: "none", color: "#000000" };
    expect(grid[0][0].borderTop).toEqual(none);      // outer top untouched
    expect(grid[0][0].borderBottom).toEqual(inside); // edge between rows 0|1
    expect(grid[1][0].borderTop).toEqual(inside);    // same edge, other cell
    expect(grid[1][0].borderBottom).toEqual(inside); // edge between rows 1|2
    expect(grid[2][0].borderTop).toEqual(inside);
    expect(grid[2][0].borderBottom).toEqual(none);   // outer bottom untouched
  });

  it("the per-side keys KEEP their per-cell semantics (every cell, unchanged)", async () => {
    const { lib } = makeFormatLib();
    const side = { style: "thin", color: "#ff0000" };
    await applyRangeFormat(asLib(lib), undefined, 0, 0, 1, 1, { borderTop: side });
    const grid = await readRangeFormats(asLib(lib), undefined, 0, 0, 1, 1);
    for (const row of grid) for (const cell of row) expect(cell.borderTop).toEqual(side);
    expect(lib.applyBorderPreset).not.toHaveBeenCalled();
  });

  it("refuses an edge key aimed at a NON-ACTIVE sheet (the preset backend has no sheet slot)", async () => {
    const { lib } = makeFormatLib();
    await expect(
      applyRangeFormat(asLib(lib), 2, 0, 0, 1, 1, {
        borderOutline: { style: "thin", color: "#000000" },
      }),
    ).rejects.toThrow(/active sheet/);
    expect(lib.applyBorderPreset).not.toHaveBeenCalled();
    expect(lib.applyFormatting).not.toHaveBeenCalled();
  });

  it("wraps a multi-call decomposition in the script undo batch", async () => {
    const { lib } = makeFormatLib();
    await applyRangeFormat(asLib(lib), undefined, 0, 0, 1, 1, {
      bold: true, borderOutline: { style: "thin", color: "#000000" },
    });
    expect(lib.beginUndoTransaction).toHaveBeenCalledTimes(1);
    expect(lib.commitUndoTransaction).toHaveBeenCalledTimes(1);
    // A single-key call takes no wrap at all — it is already one backend step.
    lib.beginUndoTransaction.mockClear();
    await applyRangeFormat(asLib(lib), undefined, 0, 0, 1, 1, { bold: false });
    expect(lib.beginUndoTransaction).not.toHaveBeenCalled();
  });
});

// ============================================================================
// (5) read plumbing
// ============================================================================

describe("readRangeFormats plumbing", () => {
  it("fetches each distinct style ONCE (per-style cache)", async () => {
    const { lib } = makeFormatLib();
    await applyRangeFormat(asLib(lib), undefined, 0, 0, 9, 9, { bold: true });
    lib.getStyle.mockClear();
    await readRangeFormats(asLib(lib), undefined, 0, 0, 9, 9);
    // 100 cells, one shared style: exactly one style fetch.
    expect(lib.getStyle).toHaveBeenCalledTimes(1);
  });

  it("reads a NON-ACTIVE sheet through getWatchCells triples", async () => {
    const { lib } = makeFormatLib();
    lib.getWatchCells.mockResolvedValueOnce([
      { row: 0, col: 0, styleIndex: 0 },
      null,
    ] as never);
    const grid = await readRangeFormats(asLib(lib), 2, 0, 0, 0, 1);
    expect(lib.getWatchCells).toHaveBeenCalledWith([[2, 0, 0], [2, 0, 1]]);
    expect(lib.getViewportCells).not.toHaveBeenCalled();
    // Both cells read back the default style (index 0 / no cell at all).
    expect(grid[0][0].locked).toBe(true);
    expect(grid[0][1].numberFormat).toBe("General");
  });

  it("refuses a rectangle over the bulk ceiling", async () => {
    const { lib } = makeFormatLib();
    await expect(
      readRangeFormats(asLib(lib), undefined, 0, 0, 999, 999),
    ).rejects.toThrow(/range too large/);
  });
});

// ============================================================================
// (6) worker shim dispatch + range sugar
// ============================================================================

interface PostedCall {
  callId: number;
  method: string;
  args: unknown[];
}

function makeContext(tier: "restricted" | "unlocked" = "unlocked"): {
  context: Record<string, unknown>;
  api: Record<string, unknown>;
  rt: WorkerRuntime;
  calls: PostedCall[];
  drain: () => void;
} {
  const calls: PostedCall[] = [];
  const spec = {
    protocolVersion: 1,
    scriptId: "wave3-format-test",
    objectType: "sheet",
    instanceId: null,
    tier,
    capabilities: [],
    apiVersion: "1.0.0",
    scriptName: "Wave3Format",
    packageInfo: null,
    snapshot: {},
    source: "",
  } as unknown as MountSpec;
  const { context, rt } = buildWorkerContext(spec, (msg: W2H) => {
    if (msg.t === "call") calls.push({ callId: msg.callId, method: msg.method, args: msg.args });
  });
  const drain = (): void => {
    for (const entry of rt.pending.values()) clearTimeout(entry.timer);
    rt.pending.clear();
  };
  return {
    context: context as Record<string, unknown>,
    api: (context as Record<string, unknown>).api as Record<string, unknown>,
    rt,
    calls,
    drain,
  };
}

describe("worker shim: format read-back methods", () => {
  it("the flat api methods dispatch verbatim", () => {
    const { api, calls, drain } = makeContext();
    void (api.getRangeFormat as (...a: unknown[]) => Promise<unknown>)(0, 0, 4, 2, "Data");
    void (api.getCellFormat as (...a: unknown[]) => Promise<unknown>)(3, 1);
    expect(calls.map((c) => [c.method, ...c.args])).toEqual([
      ["api.getRangeFormat", 0, 0, 4, 2, "Data"],
      ["api.getCellFormat", 3, 1, undefined],
    ]);
    drain();
  });

  it("the sheet context's methods dispatch the restricted sheet.* twins", () => {
    const { context, calls, drain } = makeContext("restricted");
    void (context.getRangeFormat as (...a: unknown[]) => Promise<unknown>)(0, 0, 1, 1);
    void (context.getCellFormat as (...a: unknown[]) => Promise<unknown>)(0, 0);
    expect(calls.map((c) => c.method)).toEqual(["sheet.getRangeFormat", "sheet.getCellFormat"]);
    drain();
  });

  it("range.getFormats()/getFormat() ride sheet.getRangeFormat on the sheet context", () => {
    const { context, calls, drain } = makeContext("restricted");
    const range = (context.range as (a: string) => Record<string, unknown>)("B2:C3");
    void (range.getFormats as () => Promise<unknown>)();
    void (range.getFormat as () => Promise<unknown>)();
    expect(calls.map((c) => [c.method, ...c.args])).toEqual([
      ["sheet.getRangeFormat", 1, 1, 2, 2],
      ["sheet.getRangeFormat", 1, 1, 1, 1], // getFormat reads only the top-left cell
    ]);
    drain();
  });

  it("workbook-navigation ranges ride api.getRangeFormat WITH the sheet index", async () => {
    const { api, rt, calls, drain } = makeContext();
    const wbPromise = (
      api.workbook as { sheet: (ref: unknown) => Promise<Record<string, unknown> | null> }
    ).sheet("Data");
    rt.settleCall(calls[0].callId, true, ["Intro", "Data"]);
    const sheet = await wbPromise;
    calls.length = 0;
    const range = (sheet as { range: (a: string) => Record<string, unknown> }).range("A1:B2");
    void (range.getFormats as () => Promise<unknown>)();
    expect(calls[0]).toMatchObject({ method: "api.getRangeFormat", args: [0, 0, 1, 1, 1] });
    drain();
  });
});
