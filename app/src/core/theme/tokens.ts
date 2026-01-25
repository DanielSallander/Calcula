/**
 * These are the semantic keys for your application.
 * Extensions will eventually be able to override the values of these variables.
 */
export const THEME_TOKENS = {
  // --- Context Menu ---
  CTX_MENU_BG: '--ctx-menu-bg',
  CTX_MENU_TEXT: '--ctx-menu-text',
  CTX_MENU_BORDER: '--ctx-menu-border',
  CTX_MENU_HOVER_BG: '--ctx-menu-hover-bg',
  CTX_MENU_SEPARATOR: '--ctx-menu-separator',

  // --- Grid / Spreadsheet ---
  GRID_BG: '--grid-bg',
  GRID_TEXT: '--grid-text',
  GRID_LINE: '--grid-line',
  GRID_HEADER_BG: '--grid-header-bg',
  GRID_HEADER_TEXT: '--grid-header-text',
  GRID_SELECTION_BORDER: '--grid-selection-border',
  GRID_SELECTION_BG: '--grid-selection-bg',
  SPREADSHEET_BG: '--spreadsheet-bg',
  GRID_AREA_BG: '--grid-area-bg',
  CANVAS_BG: '--canvas-bg',

  // --- Formula Bar ---
  FORMULA_BAR_BG: '--formula-bar-bg',
  FORMULA_BAR_BORDER: '--formula-bar-border',
  FORMULA_INPUT_BG: '--formula-input-bg',

  // --- Menu Bar ---
  MENU_BAR_BG: '--menu-bar-bg',
  MENU_BAR_BORDER: '--menu-bar-border',
  MENU_DROPDOWN_BG: '--menu-dropdown-bg',
  MENU_BORDER: '--menu-border',
  MENU_TEXT: '--menu-text',
  MENU_TEXT_DISABLED: '--menu-text-disabled',
  MENU_BUTTON_HOVER_BG: '--menu-button-hover-bg',
  MENU_BUTTON_ACTIVE_BG: '--menu-button-active-bg',
  MENU_ITEM_HOVER_BG: '--menu-item-hover-bg',
  MENU_SHORTCUT_TEXT: '--menu-shortcut-text',
  MENU_SEPARATOR: '--menu-separator',
  MENU_SHADOW: '--menu-shadow',

  // --- General UI ---
  TEXT_PRIMARY: '--text-primary',
  TEXT_SECONDARY: '--text-secondary',
  TEXT_DISABLED: '--text-disabled',
  ACCENT_PRIMARY: '--accent-primary',
  ACCENT_COLOR: '--accent-color',
  BG_SURFACE: '--bg-surface',
  BG_SURFACE_DISABLED: '--bg-surface-disabled',
  BORDER_DEFAULT: '--border-default',
  BORDER_DISABLED: '--border-disabled',
  PANEL_BG: '--panel-bg',
  FONT_FAMILY_SANS: '--font-family-sans',
  FONT_SIZE_CELL: '--font-size-cell',
  Z_INDEX_EDITOR: '--z-index-editor',

  // --- Scrollbar ---
  SCROLLBAR_TRACK_BG: '--scrollbar-track-bg',
  SCROLLBAR_BORDER_COLOR: '--scrollbar-border-color',
  SCROLLBAR_THUMB_BG_DEFAULT: '--scrollbar-thumb-bg-default',
  SCROLLBAR_THUMB_BG_HOVER: '--scrollbar-thumb-bg-hover',
  SCROLLBAR_THUMB_BG_ACTIVE: '--scrollbar-thumb-bg-active',
  SCROLLBAR_THUMB_BORDER_COLOR: '--scrollbar-thumb-border-color',
} as const;