//! FILENAME: app/extensions/BuiltIn/HomeTab/components/homeTabIcons.tsx
// PURPOSE: Maps Home tab item ids and group icon ids to the duotone RibbonIcon set.
// CONTEXT: Every ALL_ITEMS id resolves to a RibbonIcon EXCEPT the deliberately
//          typographic ones (TYPOGRAPHIC_ITEM_IDS): B, I, U, S, x², x₂ and the
//          four Number glyphs (%, ",", ".0", "0."). Excel renders those as
//          letters too, and they read faster than any drawing of them, so they
//          are absent here and callers fall back to the catalog's `item.icon`
//          text. The Font colour "A" is the one letter that IS drawn: the
//          ColorSwatch bar needs an SVG over its 4px colour bar, and
//          RibbonIcon.FontColor is exactly that A (see api/icons/home.tsx).
//
//          The maps hold icon COMPONENTS, keyed by id: a persisted layout
//          stores only the id (`HomeTabGroup.iconId`), never a React element.

import React from "react";
import { RibbonIcon, type RibbonIconProps } from "@api";
import { LAUNCHER_ICON_SIZE as API_LAUNCHER_ICON_SIZE } from "@api/layout";

const ICONS: Record<string, React.ComponentType<RibbonIconProps>> = {
  // Clipboard
  cut: RibbonIcon.Cut,
  copy: RibbonIcon.Copy,
  paste: RibbonIcon.Paste,
  formatPainter: RibbonIcon.FormatPainter,
  // Font (fontName/fontSize render as Dropdowns in the ribbon; their icons
  // show in the customize dialog)
  fontName: RibbonIcon.Fonts,
  fontSize: RibbonIcon.Text,
  increaseFontSize: RibbonIcon.FontSizeUp,
  decreaseFontSize: RibbonIcon.FontSizeDown,
  textColor: RibbonIcon.FontColor,
  backgroundColor: RibbonIcon.FillColor,
  formatCells: RibbonIcon.FormatCells,
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
  // Number (numberFormat renders as a Dropdown in the ribbon; its icon shows
  // in the customize dialog)
  numberFormat: RibbonIcon.NumberFormat,
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
  // Layout (the separator paints nothing in the ribbon; its chip in the
  // customize dialog shows the page-break glyph)
  rowBreak: RibbonIcon.Breaks,
};

/**
 * Items that stay TEXT on purpose. The approved design keeps these
 * typographic in the band — B/I/U/S, x²/x₂ and the Number group's
 * %, ",", ".0", "0." — because the letters ARE the command's identity.
 * `homeTabIcon` returns null for them, so every caller renders `item.icon`.
 */
export const TYPOGRAPHIC_ITEM_IDS: ReadonlySet<string> = new Set([
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "superscript",
  "subscript",
  "percentFormat",
  "commaFormat",
  "increaseDecimal",
  "decreaseDecimal",
]);

/** SVG icon for a Home tab item, or null for text-glyph items (B, I, U...). */
export function homeTabIcon(itemId: string, size?: number): React.ReactNode | null {
  if (TYPOGRAPHIC_ITEM_IDS.has(itemId)) return null;
  const Icon = ICONS[itemId];
  return Icon ? <Icon size={size} /> : null;
}

// ============================================================================
// Group launcher glyphs
// ============================================================================

/** Size a group glyph renders at: the launcher's 24px icon (the Clusters
 *  LAUNCHER_ICON_SIZE), the same icon a sidebar section header shows. */
export const LAUNCHER_ICON_SIZE = API_LAUNCHER_ICON_SIZE;

/** Glyph id -> icon component. The persisted layout stores only the ID
 *  (`HomeTabGroup.iconId`); React elements must never enter localStorage.
 *
 *  KEYS ONLY GROW: a saved layout names one of these ids, and an id that
 *  disappears silently turns that user's launcher into the fallback glyph. */
const GROUP_ICON_COMPONENTS: Record<string, React.ComponentType<RibbonIconProps>> = {
  clipboard: RibbonIcon.Paste,
  // The Font group was a bare "A" text glyph. It is the "Aa" drawing now: still
  // letters (the group's buttons are letters), but in the set's own language,
  // at the launcher's 24px like every other group.
  font: RibbonIcon.Fonts,
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

/** Glyph used when a group names no icon and its id matches nothing. */
export const GROUP_ICON_FALLBACK_ID = "format";

/** Every glyph a group may choose, in menu order. */
export const GROUP_ICON_IDS: string[] = Object.keys(GROUP_ICON_COMPONENTS).sort();

/** Launcher glyph for a group icon id, or null when the id is unknown. */
export function groupIcon(iconId: string | undefined, size?: number): React.ReactNode | null {
  if (!iconId) return null;
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

/** Gear glyph for the "Customize Home Tab..." View-menu entry: the set's own
 *  Settings drawing, so the menu item matches every other icon in the app. */
export function HomeTabCustomizeIcon({ size = 14 }: RibbonIconProps): React.ReactElement {
  return <RibbonIcon.Settings size={size} />;
}
