//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/hooks/useFormatCellsState.ts
// PURPOSE: Local state management for the Format Cells dialog.
// CONTEXT: Manages the working copy of cell styles that the user edits
// before applying. Loads initial values from the active cell's style.

import { create } from "zustand";

// ============================================================================
// Types
// ============================================================================

export interface FormatCellsState {
  // Font
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  textColor: string;

  // Alignment
  textAlign: string;
  verticalAlign: string;
  wrapText: boolean;
  textRotation: string;

  // Number
  numberFormat: string;

  // Fill
  backgroundColor: string;

  // Protection
  locked: boolean;
  formulaHidden: boolean;

  // Border (UI state only - not yet applied)
  borderTop: BorderSide;
  borderRight: BorderSide;
  borderBottom: BorderSide;
  borderLeft: BorderSide;

  // Active tab
  activeTab: string;
}

export interface BorderSide {
  style: "none" | "thin" | "medium" | "thick" | "dashed" | "dotted" | "double";
  color: string;
}

const DEFAULT_BORDER: BorderSide = { style: "none", color: "#000000" };

export interface FormatCellsActions {
  // Bulk set (loading from cell style)
  loadFromStyle: (style: Partial<FormatCellsState>) => void;
  reset: () => void;

  // Individual setters
  setFontFamily: (v: string) => void;
  setFontSize: (v: number) => void;
  setBold: (v: boolean) => void;
  setItalic: (v: boolean) => void;
  setUnderline: (v: boolean) => void;
  setStrikethrough: (v: boolean) => void;
  setTextColor: (v: string) => void;
  setTextAlign: (v: string) => void;
  setVerticalAlign: (v: string) => void;
  setWrapText: (v: boolean) => void;
  setTextRotation: (v: string) => void;
  setNumberFormat: (v: string) => void;
  setBackgroundColor: (v: string) => void;
  setLocked: (v: boolean) => void;
  setFormulaHidden: (v: boolean) => void;
  setBorderTop: (v: BorderSide) => void;
  setBorderRight: (v: BorderSide) => void;
  setBorderBottom: (v: BorderSide) => void;
  setBorderLeft: (v: BorderSide) => void;
  setActiveTab: (v: string) => void;
}

export type FormatCellsStore = FormatCellsState & FormatCellsActions;

// ============================================================================
// Default State
// ============================================================================

const DEFAULT_STATE: FormatCellsState = {
  fontFamily: "system-ui",
  fontSize: 11,
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  textColor: "#000000",
  textAlign: "general",
  verticalAlign: "middle",
  wrapText: false,
  textRotation: "none",
  numberFormat: "General",
  backgroundColor: "#ffffff",
  locked: true,
  formulaHidden: false,
  borderTop: { ...DEFAULT_BORDER },
  borderRight: { ...DEFAULT_BORDER },
  borderBottom: { ...DEFAULT_BORDER },
  borderLeft: { ...DEFAULT_BORDER },
  activeTab: "number",
};

// ============================================================================
// Store
// ============================================================================

export const useFormatCellsStore = create<FormatCellsStore>((set) => ({
  ...DEFAULT_STATE,

  loadFromStyle: (style) => set((state) => ({ ...state, ...style })),
  reset: () => set({ ...DEFAULT_STATE }),

  setFontFamily: (fontFamily) => set({ fontFamily }),
  setFontSize: (fontSize) => set({ fontSize }),
  setBold: (bold) => set({ bold }),
  setItalic: (italic) => set({ italic }),
  setUnderline: (underline) => set({ underline }),
  setStrikethrough: (strikethrough) => set({ strikethrough }),
  setTextColor: (textColor) => set({ textColor }),
  setTextAlign: (textAlign) => set({ textAlign }),
  setVerticalAlign: (verticalAlign) => set({ verticalAlign }),
  setWrapText: (wrapText) => set({ wrapText }),
  setTextRotation: (textRotation) => set({ textRotation }),
  setNumberFormat: (numberFormat) => set({ numberFormat }),
  setBackgroundColor: (backgroundColor) => set({ backgroundColor }),
  setLocked: (locked) => set({ locked }),
  setFormulaHidden: (formulaHidden) => set({ formulaHidden }),
  setBorderTop: (borderTop) => set({ borderTop }),
  setBorderRight: (borderRight) => set({ borderRight }),
  setBorderBottom: (borderBottom) => set({ borderBottom }),
  setBorderLeft: (borderLeft) => set({ borderLeft }),
  setActiveTab: (activeTab) => set({ activeTab }),
}));
