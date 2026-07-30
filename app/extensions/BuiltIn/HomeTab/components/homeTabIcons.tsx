//! FILENAME: app/extensions/BuiltIn/HomeTab/components/homeTabIcons.tsx
// PURPOSE: Maps Home tab item ids to their ribbon SVG icons.
// CONTEXT: Items with typographic identities (B, I, U, S, x², x₂, the "A" of
// Font Color) intentionally stay as styled text — Excel renders those as
// letters too — so they are absent here and callers fall back to item.icon.

import React from "react";
import { RibbonIcon, type RibbonIconProps } from "@api";

const ICONS: Record<string, React.ComponentType<RibbonIconProps>> = {
  // Clipboard
  cut: RibbonIcon.Cut,
  copy: RibbonIcon.Copy,
  paste: RibbonIcon.Paste,
  formatPainter: RibbonIcon.FormatPainter,
  // Font
  increaseFontSize: RibbonIcon.FontSizeUp,
  decreaseFontSize: RibbonIcon.FontSizeDown,
  formatCells: RibbonIcon.FormatCells,
  backgroundColor: RibbonIcon.FillColor,
  // Alignment
  alignTop: RibbonIcon.AlignTop,
  alignMiddle: RibbonIcon.AlignMiddle,
  alignBottom: RibbonIcon.AlignBottom,
  alignLeft: RibbonIcon.AlignLeft,
  alignCenter: RibbonIcon.AlignCenter,
  alignRight: RibbonIcon.AlignRight,
  wrapText: RibbonIcon.WrapText,
  increaseIndent: RibbonIcon.IndentIncrease,
  decreaseIndent: RibbonIcon.IndentDecrease,
  mergeCells: RibbonIcon.MergeCells,
  // Number (numberFormat renders as a Select in the ribbon; its icon shows in
  // the customize dialog)
  numberFormat: RibbonIcon.NumberFormat,
  percentFormat: RibbonIcon.Percent,
  commaFormat: RibbonIcon.Comma,
  increaseDecimal: RibbonIcon.DecimalIncrease,
  decreaseDecimal: RibbonIcon.DecimalDecrease,
  // Styles
  cellStyles: RibbonIcon.CellStyles,
  // Cells
  insertRow: RibbonIcon.InsertRow,
  insertColumn: RibbonIcon.InsertColumn,
  deleteRow: RibbonIcon.DeleteRow,
  deleteColumn: RibbonIcon.DeleteColumn,
  // Editing
  undo: RibbonIcon.Undo,
  redo: RibbonIcon.Redo,
  find: RibbonIcon.Find,
  clearContents: RibbonIcon.ClearContents,
  clearFormatting: RibbonIcon.ClearFormatting,
  clearAll: RibbonIcon.ClearAll,
};

/** SVG icon for a Home tab item, or null for text-glyph items (B, I, U...). */
export function homeTabIcon(itemId: string, size?: number): React.ReactNode | null {
  const Icon = ICONS[itemId];
  return Icon ? <Icon size={size} /> : null;
}
