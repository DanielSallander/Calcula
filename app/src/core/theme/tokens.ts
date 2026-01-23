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

  // --- Formula Bar ---
  FORMULA_BAR_BG: '--formula-bar-bg',
  FORMULA_BAR_BORDER: '--formula-bar-border',
  FORMULA_INPUT_BG: '--formula-input-bg',

  // --- General UI ---
  TEXT_PRIMARY: '--text-primary',
  TEXT_SECONDARY: '--text-secondary',
  TEXT_DISABLED: '--text-disabled',
  ACCENT_PRIMARY: '--accent-primary',
  BORDER_DEFAULT: '--border-default',
  PANEL_BG: '--panel-bg',
} as const;