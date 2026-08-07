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

// ============================================================================
// Group launcher glyphs
// ============================================================================

/** Size a group launcher glyph renders at in the ribbon band. */
export const LAUNCHER_ICON_SIZE = 20;

/** Glyph id -> icon component. The persisted layout stores only the ID
 *  (`HomeTabGroup.iconId`); React elements must never enter localStorage. */
const GROUP_ICON_COMPONENTS: Record<string, React.ComponentType<RibbonIconProps>> = {
  clipboard: RibbonIcon.Paste,
  alignment: RibbonIcon.AlignLeft,
  number: RibbonIcon.NumberFormat,
  styles: RibbonIcon.CellStyles,
  cells: RibbonIcon.InsertRow,
  editing: RibbonIcon.Find,
  // Extra choices for user-created groups (not used by DEFAULT_LAYOUT).
  format: RibbonIcon.FormatCells,
  fill: RibbonIcon.FillColor,
  merge: RibbonIcon.MergeCells,
  percent: RibbonIcon.Percent,
  wrap: RibbonIcon.WrapText,
  undo: RibbonIcon.Undo,
  insertColumn: RibbonIcon.InsertColumn,
  deleteRow: RibbonIcon.DeleteRow,
};

/** The Font group is typographic on purpose: its in-group buttons are letters
 *  (B, I, U), so its launcher is an "A" rather than an SVG. */
const GROUP_TEXT_GLYPHS: Record<string, string> = { font: "A" };

/** Glyph used when a group names no icon and its id matches nothing. */
export const GROUP_ICON_FALLBACK_ID = "format";

/** Every glyph a group may choose, in menu order. */
export const GROUP_ICON_IDS: string[] = [
  ...Object.keys(GROUP_TEXT_GLYPHS),
  ...Object.keys(GROUP_ICON_COMPONENTS),
].sort();

/** Launcher glyph for a group icon id, or null when the id is unknown. */
export function groupIcon(iconId: string | undefined, size?: number): React.ReactNode | null {
  if (!iconId) return null;
  const text = GROUP_TEXT_GLYPHS[iconId];
  if (text) return text;
  const Icon = GROUP_ICON_COMPONENTS[iconId];
  return Icon ? <Icon size={size ?? LAUNCHER_ICON_SIZE} /> : null;
}

/**
 * Launcher glyph for a group, with the full fallback chain:
 * explicit `iconId` -> the group id (how the seven built-in groups have always
 * resolved) -> the generic fallback glyph.
 */
export function groupIconFor(
  group: { id: string; iconId?: string },
  size?: number
): React.ReactNode {
  return (
    groupIcon(group.iconId, size) ??
    groupIcon(group.id, size) ??
    groupIcon(GROUP_ICON_FALLBACK_ID, size)
  );
}

/** Gear glyph for the "Customize Home Tab..." View-menu entry. Drawn here
 *  rather than in @api because it is this extension's own affordance. */
export function HomeTabCustomizeIcon({ size = 14 }: RibbonIconProps): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flex: "none" }}
      aria-hidden
    >
      <circle cx="8" cy="8" r="2.4" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </svg>
  );
}
