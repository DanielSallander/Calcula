//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/hooks/useFormatCellsState.ts
// PURPOSE: Local state management for the Format Cells dialog.
// CONTEXT: Manages the working copy of cell styles that the user edits
// before applying. Loads initial values from the active cell's style.
//
// THE BASELINE (survey D5). The dialog loads ONE cell's style -- the active
// cell -- and OK used to write every property of it to every selected cell, so
// a selection with mixed fonts came back uniform, and an EMPTY active cell
// wrote the store's own defaults (`fontFamily: "system-ui"` among them, the
// BUG-0062 symptom) over everything. Excel writes only what the user changed:
// a property left alone stays as it was in every cell. The dialog now records
// what it loaded as `baseline` and OK writes the difference
// (lib/formatCellsWrites.ts).

import { create } from "zustand";
import type { PatternType, GradientDirection, UnderlineStyle } from "@api";

// ============================================================================
// Types
// ============================================================================

export type FillMode = "none" | "solid" | "gradient" | "pattern";

export interface FormatCellsState {
  // Font
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: UnderlineStyle;
  strikethrough: boolean;
  textColor: string;

  // Alignment
  textAlign: string;
  verticalAlign: string;
  wrapText: boolean;
  shrinkToFit: boolean;
  textRotation: string;
  indent: number;

  // Number
  numberFormat: string;

  // Fill
  backgroundColor: string;
  fillMode: FillMode;
  gradientColor1: string;
  gradientColor2: string;
  gradientDirection: GradientDirection;
  patternType: PatternType;
  patternFgColor: string;
  patternBgColor: string;

  // Protection
  locked: boolean;
  formulaHidden: boolean;

  // Border. For a RANGE, top/right/bottom/left are the range's OUTER edges
  // (Excel's Border tab) and the two inside lines are the lines between its
  // rows and between its columns; for one cell they are that cell's sides and
  // there are no inside lines.
  borderTop: BorderSide;
  borderRight: BorderSide;
  borderBottom: BorderSide;
  borderLeft: BorderSide;
  borderInsideHorizontal: BorderSide;
  borderInsideVertical: BorderSide;
  borderDiagonalDown: BorderSide;
  borderDiagonalUp: BorderSide;
  /** The None preset was chosen: OK clears every border of the range first. */
  borderClearAll: boolean;

  /** Whether the selection spans more than one row / column (enables the
   *  inside lines and the Inside preset, as in Excel). */
  rangeShape: { multiRow: boolean; multiCol: boolean };

  /** The Number category a caller asked to open on (`FORMAT_CELLS { category }`
   *  -- "More Accounting Formats..." asks for "accounting"), or null. */
  numberCategory: string | null;

  /** What the dialog LOADED; OK writes only what differs from it. */
  baseline: FormatCellsSnapshot;

  /**
   * The properties the USER set since the baseline (every individual setter
   * marks its key; loading a style does not). OK writes a touched property
   * even when its value equals the baseline: the baseline is the ACTIVE cell
   * only, and the dialog has no "mixed" state, so on a range whose active cell
   * is already bold, re-choosing Bold is how the user makes EVERY cell bold
   * (review finding (k), 2026-10-04 -- that OK wrote nothing).
   */
  touched: ReadonlySet<keyof FormatCellsSnapshot>;

  // Active tab
  activeTab: string;
}

/** The properties OK can write, i.e. the state minus the dialog's own chrome. */
export type FormatCellsSnapshot = Omit<
  FormatCellsState,
  "baseline" | "touched" | "activeTab" | "numberCategory" | "rangeShape" | "borderClearAll"
>;

export interface BorderSide {
  style: "none" | "thin" | "medium" | "thick" | "dashed" | "dotted" | "double";
  color: string;
}

const DEFAULT_BORDER: BorderSide = { style: "none", color: "#000000" };

export interface FormatCellsActions {
  // Bulk set (loading from cell style)
  loadFromStyle: (style: Partial<FormatCellsState>) => void;
  /** Record the current values as what was loaded (see the header). */
  markBaseline: () => void;
  reset: () => void;

  // Individual setters
  setFontFamily: (v: string) => void;
  setFontSize: (v: number) => void;
  setBold: (v: boolean) => void;
  setItalic: (v: boolean) => void;
  setUnderline: (v: UnderlineStyle) => void;
  setStrikethrough: (v: boolean) => void;
  setTextColor: (v: string) => void;
  setTextAlign: (v: string) => void;
  setVerticalAlign: (v: string) => void;
  setWrapText: (v: boolean) => void;
  setShrinkToFit: (v: boolean) => void;
  setTextRotation: (v: string) => void;
  setIndent: (v: number) => void;
  setNumberFormat: (v: string) => void;
  setBackgroundColor: (v: string) => void;
  setFillMode: (v: FillMode) => void;
  setGradientColor1: (v: string) => void;
  setGradientColor2: (v: string) => void;
  setGradientDirection: (v: GradientDirection) => void;
  setPatternType: (v: PatternType) => void;
  setPatternFgColor: (v: string) => void;
  setPatternBgColor: (v: string) => void;
  setLocked: (v: boolean) => void;
  setFormulaHidden: (v: boolean) => void;
  setBorderTop: (v: BorderSide) => void;
  setBorderRight: (v: BorderSide) => void;
  setBorderBottom: (v: BorderSide) => void;
  setBorderLeft: (v: BorderSide) => void;
  setBorderInsideHorizontal: (v: BorderSide) => void;
  setBorderInsideVertical: (v: BorderSide) => void;
  setBorderDiagonalDown: (v: BorderSide) => void;
  setBorderDiagonalUp: (v: BorderSide) => void;
  setBorderClearAll: (v: boolean) => void;
  setRangeShape: (v: { multiRow: boolean; multiCol: boolean }) => void;
  setNumberCategory: (v: string | null) => void;
  setActiveTab: (v: string) => void;
}

export type FormatCellsStore = FormatCellsState & FormatCellsActions;

// ============================================================================
// Default State
// ============================================================================

const DEFAULT_SNAPSHOT: FormatCellsSnapshot = {
  fontFamily: "system-ui",
  fontSize: 11,
  bold: false,
  italic: false,
  underline: "none" as UnderlineStyle,
  strikethrough: false,
  textColor: "#000000",
  textAlign: "general",
  verticalAlign: "bottom",
  wrapText: false,
  shrinkToFit: false,
  textRotation: "none",
  indent: 0,
  numberFormat: "General",
  backgroundColor: "#ffffff",
  fillMode: "none" as FillMode,
  gradientColor1: "#ffffff",
  gradientColor2: "#4472c4",
  gradientDirection: "horizontal" as GradientDirection,
  patternType: "lightGray" as PatternType,
  patternFgColor: "#000000",
  patternBgColor: "#ffffff",
  locked: true,
  formulaHidden: false,
  borderTop: { ...DEFAULT_BORDER },
  borderRight: { ...DEFAULT_BORDER },
  borderBottom: { ...DEFAULT_BORDER },
  borderLeft: { ...DEFAULT_BORDER },
  borderInsideHorizontal: { ...DEFAULT_BORDER },
  borderInsideVertical: { ...DEFAULT_BORDER },
  borderDiagonalDown: { ...DEFAULT_BORDER },
  borderDiagonalUp: { ...DEFAULT_BORDER },
};

const DEFAULT_STATE: FormatCellsState = {
  ...DEFAULT_SNAPSHOT,
  borderClearAll: false,
  rangeShape: { multiRow: false, multiCol: false },
  numberCategory: null,
  // A dialog whose load never landed compares against its own defaults, so it
  // still writes only what the user changed.
  baseline: DEFAULT_SNAPSHOT,
  touched: new Set(),
  activeTab: "number",
};

/** `touched` with `key` added (a new set: the store's state is immutable). */
function touch(
  touched: ReadonlySet<keyof FormatCellsSnapshot>,
  key: keyof FormatCellsSnapshot,
): ReadonlySet<keyof FormatCellsSnapshot> {
  if (touched.has(key)) return touched;
  const next = new Set(touched);
  next.add(key);
  return next;
}

/** The writable properties of a state (everything a snapshot carries). */
export function snapshotOf(state: FormatCellsState): FormatCellsSnapshot {
  const out = {} as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SNAPSHOT)) {
    out[key] = (state as unknown as Record<string, unknown>)[key];
  }
  return out as unknown as FormatCellsSnapshot;
}

// ============================================================================
// Store
// ============================================================================

export const useFormatCellsStore = create<FormatCellsStore>((set) => ({
  ...DEFAULT_STATE,

  loadFromStyle: (style) => set((state) => ({ ...state, ...style })),
  // The load overwrote whatever a control set before it landed, so nothing is
  // the user's choice yet.
  markBaseline: () => set((state) => ({ baseline: snapshotOf(state), touched: new Set() })),
  reset: () => set({ ...DEFAULT_STATE, touched: new Set() }),

  setFontFamily: (fontFamily) => set((s) => ({ fontFamily, touched: touch(s.touched, "fontFamily") })),
  setFontSize: (fontSize) => set((s) => ({ fontSize, touched: touch(s.touched, "fontSize") })),
  setBold: (bold) => set((s) => ({ bold, touched: touch(s.touched, "bold") })),
  setItalic: (italic) => set((s) => ({ italic, touched: touch(s.touched, "italic") })),
  setUnderline: (underline) => set((s) => ({ underline, touched: touch(s.touched, "underline") })),
  setStrikethrough: (strikethrough) => set((s) => ({ strikethrough, touched: touch(s.touched, "strikethrough") })),
  setTextColor: (textColor) => set((s) => ({ textColor, touched: touch(s.touched, "textColor") })),
  setTextAlign: (textAlign) => set((s) => ({ textAlign, touched: touch(s.touched, "textAlign") })),
  setVerticalAlign: (verticalAlign) => set((s) => ({ verticalAlign, touched: touch(s.touched, "verticalAlign") })),
  setWrapText: (wrapText) => set((s) => ({ wrapText, touched: touch(s.touched, "wrapText") })),
  setShrinkToFit: (shrinkToFit) => set((s) => ({ shrinkToFit, touched: touch(s.touched, "shrinkToFit") })),
  setTextRotation: (textRotation) => set((s) => ({ textRotation, touched: touch(s.touched, "textRotation") })),
  setIndent: (indent) => set((s) => ({ indent, touched: touch(s.touched, "indent") })),
  setNumberFormat: (numberFormat) => set((s) => ({ numberFormat, touched: touch(s.touched, "numberFormat") })),
  setBackgroundColor: (backgroundColor) => set((s) => ({ backgroundColor, touched: touch(s.touched, "backgroundColor") })),
  setFillMode: (fillMode) => set((s) => ({ fillMode, touched: touch(s.touched, "fillMode") })),
  setGradientColor1: (gradientColor1) => set((s) => ({ gradientColor1, touched: touch(s.touched, "gradientColor1") })),
  setGradientColor2: (gradientColor2) => set((s) => ({ gradientColor2, touched: touch(s.touched, "gradientColor2") })),
  setGradientDirection: (gradientDirection) => set((s) => ({ gradientDirection, touched: touch(s.touched, "gradientDirection") })),
  setPatternType: (patternType) => set((s) => ({ patternType, touched: touch(s.touched, "patternType") })),
  setPatternFgColor: (patternFgColor) => set((s) => ({ patternFgColor, touched: touch(s.touched, "patternFgColor") })),
  setPatternBgColor: (patternBgColor) => set((s) => ({ patternBgColor, touched: touch(s.touched, "patternBgColor") })),
  setLocked: (locked) => set((s) => ({ locked, touched: touch(s.touched, "locked") })),
  setFormulaHidden: (formulaHidden) => set((s) => ({ formulaHidden, touched: touch(s.touched, "formulaHidden") })),
  setBorderTop: (borderTop) => set((s) => ({ borderTop, touched: touch(s.touched, "borderTop") })),
  setBorderRight: (borderRight) => set((s) => ({ borderRight, touched: touch(s.touched, "borderRight") })),
  setBorderBottom: (borderBottom) => set((s) => ({ borderBottom, touched: touch(s.touched, "borderBottom") })),
  setBorderLeft: (borderLeft) => set((s) => ({ borderLeft, touched: touch(s.touched, "borderLeft") })),
  setBorderInsideHorizontal: (borderInsideHorizontal) => set((s) => ({ borderInsideHorizontal, touched: touch(s.touched, "borderInsideHorizontal") })),
  setBorderInsideVertical: (borderInsideVertical) => set((s) => ({ borderInsideVertical, touched: touch(s.touched, "borderInsideVertical") })),
  setBorderDiagonalDown: (borderDiagonalDown) => set((s) => ({ borderDiagonalDown, touched: touch(s.touched, "borderDiagonalDown") })),
  setBorderDiagonalUp: (borderDiagonalUp) => set((s) => ({ borderDiagonalUp, touched: touch(s.touched, "borderDiagonalUp") })),
  setBorderClearAll: (borderClearAll) => set({ borderClearAll }),
  setRangeShape: (rangeShape) => set({ rangeShape }),
  setNumberCategory: (numberCategory) => set({ numberCategory }),
  setActiveTab: (activeTab) => set({ activeTab }),
}));
