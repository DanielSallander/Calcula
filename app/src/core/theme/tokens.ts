//! FILENAME: app/src/core/theme/tokens.ts
// PURPOSE: The semantic CSS custom-property names of the application chrome.
// CONTEXT: Every name here must have a value in BOTH baselines (defaultTheme.ts
//          and darkTheme.ts) — tokens.test.ts fails on a missing value and on a
//          stray one. Skins, the user's own token overrides and the
//          accessibility transforms all key their deltas by these names.
/**
 * These are the semantic keys for your application.
 * Extensions will eventually be able to override the values of these variables.
 */
export const THEME_TOKENS = {
  // --- Context Menu ---
  CTX_MENU_BG: '--ctx-menu-bg',
  CTX_MENU_TEXT: '--ctx-menu-text',
  CTX_MENU_BORDER: '--ctx-menu-border',
  CTX_MENU_SHADOW: '--ctx-menu-shadow',
  CTX_MENU_ITEM_HOVER_BG: '--ctx-menu-item-hover-bg',
  CTX_MENU_SEPARATOR: '--ctx-menu-separator',
  CTX_MENU_Z_INDEX: '--z-context-menu',

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
  FORMULA_BAR_BUTTON_BORDER: '--formula-bar-button-border',
  FORMULA_BAR_BUTTON_DISABLED: '--formula-bar-button-disabled',
  FORMULA_BAR_CANCEL_COLOR: '--formula-bar-cancel-color',
  FORMULA_BAR_ENTER_COLOR: '--formula-bar-enter-color',
  FORMULA_BAR_FUNCTION_COLOR: '--formula-bar-function-color',
  FORMULA_BAR_CANCEL_HOVER_BG: '--formula-bar-cancel-hover-bg',
  FORMULA_BAR_ENTER_HOVER_BG: '--formula-bar-enter-hover-bg',
  FORMULA_BAR_FUNCTION_HOVER_BG: '--formula-bar-function-hover-bg',
  FORMULA_INPUT_BG: '--formula-input-bg',
  FORMULA_INPUT_BG_FOCUSED: '--formula-input-bg-focused',
  FORMULA_INPUT_BORDER: '--formula-input-border',
  FORMULA_INPUT_TEXT: '--formula-input-text',

  // --- Name Box ---
  NAMEBOX_BG: '--namebox-bg',
  NAMEBOX_BG_EDITING: '--namebox-bg-editing',
  NAMEBOX_BORDER: '--namebox-border',
  NAMEBOX_TEXT: '--namebox-text',

  // --- Sheet Tabs ---
  SHEET_TABS_BG: '--sheet-tabs-bg',
  SHEET_TABS_BORDER: '--sheet-tabs-border',
  SHEET_TAB_BG: '--sheet-tab-bg',
  SHEET_TAB_BORDER: '--sheet-tab-border',
  SHEET_TAB_ACTIVE_BG: '--sheet-tab-active-bg',
  SHEET_TAB_FORMULA_SOURCE_BG: '--sheet-tab-formula-source-bg',
  SHEET_TAB_FORMULA_SOURCE_BORDER: '--sheet-tab-formula-source-border',
  SHEET_TAB_FORMULA_TARGET_BG: '--sheet-tab-formula-target-bg',
  SHEET_TAB_FORMULA_TARGET_BORDER: '--sheet-tab-formula-target-border',
  SHEET_TAB_FORMULA_INDICATOR_TEXT: '--sheet-tab-formula-indicator-text',
  SHEET_TAB_FORMULA_INDICATOR_BG: '--sheet-tab-formula-indicator-bg',

  // --- Dialog ---
  DIALOG_OVERLAY_BG: '--dialog-overlay-bg',
  DIALOG_BG: '--dialog-bg',
  DIALOG_SHADOW: '--dialog-shadow',
  DIALOG_BORDER: '--dialog-border',
  DIALOG_TITLE_TEXT: '--dialog-title-text',
  DIALOG_CLOSE_BUTTON: '--dialog-close-button',
  DIALOG_CLOSE_BUTTON_HOVER: '--dialog-close-button-hover',
  DIALOG_INPUT_BORDER: '--dialog-input-border',
  DIALOG_INPUT_BG: '--dialog-input-bg',
  DIALOG_INPUT_TEXT: '--dialog-input-text',
  DIALOG_INPUT_BORDER_FOCUS: '--dialog-input-border-focus',
  DIALOG_CATEGORY_BORDER: '--dialog-category-border',
  DIALOG_CATEGORY_BG: '--dialog-category-bg',
  DIALOG_CATEGORY_ACTIVE_BG: '--dialog-category-active-bg',
  DIALOG_CATEGORY_TEXT: '--dialog-category-text',
  DIALOG_CATEGORY_ACTIVE_TEXT: '--dialog-category-active-text',
  DIALOG_CATEGORY_HOVER_BG: '--dialog-category-hover-bg',
  DIALOG_LOADING_TEXT: '--dialog-loading-text',
  DIALOG_EMPTY_TEXT: '--dialog-empty-text',
  DIALOG_FUNCTION_SELECTED_BG: '--dialog-function-selected-bg',
  DIALOG_FUNCTION_SELECTED_BORDER: '--dialog-function-selected-border',
  DIALOG_FUNCTION_HOVER_BG: '--dialog-function-hover-bg',
  DIALOG_FUNCTION_NAME: '--dialog-function-name',
  DIALOG_FUNCTION_DESCRIPTION: '--dialog-function-description',
  DIALOG_DETAILS_BG: '--dialog-details-bg',
  DIALOG_FUNCTION_SIGNATURE: '--dialog-function-signature',
  DIALOG_FUNCTION_FULL_DESCRIPTION: '--dialog-function-full-description',
  DIALOG_BUTTON_BORDER: '--dialog-button-border',
  DIALOG_BUTTON_BG: '--dialog-button-bg',
  DIALOG_BUTTON_TEXT: '--dialog-button-text',
  DIALOG_BUTTON_HOVER_BG: '--dialog-button-hover-bg',
  DIALOG_INSERT_DISABLED_BG: '--dialog-insert-disabled-bg',
  DIALOG_INSERT_BG: '--dialog-insert-bg',
  DIALOG_INSERT_TEXT: '--dialog-insert-text',
  DIALOG_INSERT_HOVER_BG: '--dialog-insert-hover-bg',

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
  TEXT_TERTIARY: '--text-tertiary',
  TEXT_ERROR: '--text-error',
  TEXT_DISABLED: '--text-disabled',
  ACCENT_PRIMARY: '--accent-primary',
  ACCENT_COLOR: '--accent-color',
  BG_SURFACE: '--bg-surface',
  BG_SURFACE_DISABLED: '--bg-surface-disabled',
  BORDER_DEFAULT: '--border-default',
  BORDER_DISABLED: '--border-disabled',
  PANEL_BG: '--panel-bg',
  FONT_FAMILY_SANS: '--font-family-sans',
  /** Cell/editor text font (tracks the grid's cellFontFamily) — distinct from the
   *  UI sans font, so the inline editor overlay matches the canvas (Excel: Calibri). */
  FONT_FAMILY_CELL: '--font-family-cell',
  FONT_SIZE_CELL: '--font-size-cell',
  Z_INDEX_EDITOR: '--z-index-editor',

  // --- Scrollbar ---
  SCROLLBAR_TRACK_BG: '--scrollbar-track-bg',
  SCROLLBAR_BORDER_COLOR: '--scrollbar-border-color',
  SCROLLBAR_THUMB_BG_DEFAULT: '--scrollbar-thumb-bg-default',
  SCROLLBAR_THUMB_BG_HOVER: '--scrollbar-thumb-bg-hover',
  SCROLLBAR_THUMB_BG_ACTIVE: '--scrollbar-thumb-bg-active',
  SCROLLBAR_THUMB_BORDER_COLOR: '--scrollbar-thumb-border-color',

  // --- Ribbon ---
  RIBBON_BUTTON_ACTIVE_BG: '--ribbon-button-active-bg',
  RIBBON_BUTTON_HOVER_BG: '--ribbon-button-hover-bg',

  // --- Shared control atoms (@api/layout Button/ToggleButton/Launcher) ---
  BUTTON_BG: '--button-bg',
  BUTTON_HOVER_BG: '--button-hover-bg',
  BUTTON_ACTIVE_BG: '--button-active-bg',
  BUTTON_PRESSED_BG: '--button-pressed-bg',
  BUTTON_PRESSED_BORDER: '--button-pressed-border',

  // --- Ribbon icon accents (@api ribbonIcons two-tone set) ---
  ICON_ACCENT: '--icon-accent',
  ICON_DANGER: '--icon-danger',

  // --- Semantic tones (status: danger / warn / ok / info) ---
  // The set had TEXT_ERROR and ICON_DANGER and nothing else semantic: no warn,
  // no ok, no info, and no background for any of them. That is why every
  // status badge in the app carries its own literal pair, and why the Model
  // Editor rendered validation ERRORS in the same yellow as warnings — the
  // only tone it could reach. Foreground/background pairs so a caller never
  // has to invent a readable background for a token it was given.
  TONE_DANGER_FG: '--tone-danger-fg',
  TONE_DANGER_BG: '--tone-danger-bg',
  TONE_WARN_FG: '--tone-warn-fg',
  TONE_WARN_BG: '--tone-warn-bg',
  TONE_OK_FG: '--tone-ok-fg',
  TONE_OK_BG: '--tone-ok-bg',
  TONE_INFO_FG: '--tone-info-fg',
  TONE_INFO_BG: '--tone-info-bg',

  // --- Calcula Clusters: shape + motion ---
  // Radii and motion are tokens rather than constants so a skin can change the
  // FEEL of the chrome without a line of code: Calcula Soft rounds everything a
  // step further, Calcula Contrast squares it off. The motion values carry
  // their easing so a primitive writes `transition: background LT.motionHover`
  // and never re-types a cubic-bezier.
  RADIUS_CONTROL: '--radius-control',
  RADIUS_CLUSTER: '--radius-cluster',
  RADIUS_POPOVER: '--radius-popover',
  RADIUS_PILL: '--radius-pill',
  MOTION_HOVER: '--motion-hover',
  MOTION_POPOVER: '--motion-popover',
  MOTION_PANEL: '--motion-panel',

  // --- Calcula Clusters: elevation ---
  SHADOW_CLUSTER_HOVER: '--shadow-cluster-hover',
  SHADOW_POPOVER: '--shadow-popover',
  SHADOW_TOOLBAR: '--shadow-toolbar',
  SHADOW_RAISED: '--shadow-raised',

  // --- Calcula Clusters: state colour ---
  // A NEW token, not a retune of ACCENT_PRIMARY. The brand green #10b981 is
  // only ~2.5:1 on white, which is fine for a filled selection rectangle and
  // not fine for a checkbox tick, a focus ring or a pressed-state edge — the
  // WCAG 1.4.11 non-text minimum is 3:1. Retuning ACCENT_PRIMARY would have
  // darkened the grid selection and every existing consumer with it; a
  // separate state colour darkens only the controls that need to be legible.
  STATE_ACCENT: '--state-accent',
  FOCUS_RING_COLOR: '--focus-ring-color',
  FOCUS_RING: '--focus-ring',

  // --- Calcula Clusters: ribbon surfaces ---
  RIBBON_FRAME_BG: '--ribbon-frame-bg',
  RIBBON_BAND_BG: '--ribbon-band-bg',
  RIBBON_CLUSTER_BG: '--ribbon-cluster-bg',
  RIBBON_CLUSTER_BORDER: '--ribbon-cluster-border',
  RIBBON_CLUSTER_BORDER_HOVER: '--ribbon-cluster-border-hover',
  RIBBON_GROUP_LABEL_FG: '--ribbon-group-label-fg',
  RIBBON_TAB_INDICATOR: '--ribbon-tab-indicator',

  // --- Calcula Clusters: the one control grammar (@api/layout primitives) ---
  CONTROL_BORDER: '--control-border',
  CONTROL_DIVIDER: '--control-divider',
  CONTROL_TRACK: '--control-track',
  CHIP_BG: '--chip-bg',
  CHIP_BORDER: '--chip-border',
  TOOLTIP_BG: '--tooltip-bg',
  TOOLTIP_FG: '--tooltip-fg',
  KBD_BG: '--kbd-bg',
  BADGE_BG: '--badge-bg',
  BADGE_FG: '--badge-fg',

  // --- Calcula Clusters: duotone icon ground ---
  // The SOFT channel of the icon set. A tint of currentColor rather than a
  // fixed grey, so the silhouette keeps the same separation on the band, on a
  // tinted cluster, on a pressed button and in high contrast.
  ICON_FILL_SOFT: '--icon-fill-soft',

  // --- Calcula Clusters: contextual tab accents ---
  // One per contextual tab family. Each is text on the ribbon frame, so each
  // is held to 4.5:1 against RIBBON_FRAME_BG in tokens.test.ts.
  TAB_ACCENT_CHART: '--tab-accent-chart',
  TAB_ACCENT_TABLE: '--tab-accent-table',
  TAB_ACCENT_PIVOT: '--tab-accent-pivot',
  TAB_ACCENT_SLICER: '--tab-accent-slicer',
  TAB_ACCENT_SPARKLINE: '--tab-accent-sparkline',
  TAB_ACCENT_REPORT: '--tab-accent-report',

  // --- Calcula Clusters: sidebar activity bar + status bar ---
  ACTIVITY_BAR_BG: '--activity-bar-bg',
  ACTIVITY_BAR_FG: '--activity-bar-fg',
  ACTIVITY_BAR_FG_ACTIVE: '--activity-bar-fg-active',
  ACTIVITY_BAR_ITEM_HOVER_BG: '--activity-bar-item-hover-bg',
  ACTIVITY_BAR_ITEM_ACTIVE_BG: '--activity-bar-item-active-bg',
  ACTIVITY_BAR_INDICATOR: '--activity-bar-indicator',
  SIDE_PANEL_HEADER_BG: '--side-panel-header-bg',
  STATUS_BAR_BG: '--status-bar-bg',
  STATUS_BAR_FG: '--status-bar-fg',
  BORDER_SUBTLE: '--border-subtle',

  // --- Aliases for names that were already in use ---
  // These two were INVENTED by callers long before they existed here (see
  // __tests__/themeTokenParity.test.ts for the history), so every such surface
  // silently took its literal fallback and never followed the skin. Declaring
  // them as aliases of the real tokens makes the surfaces that still spell them
  // this way theme-correct at once; new code should use BORDER_DEFAULT and
  // BG_SURFACE (or the @api/layout LT table) directly.
  BORDER_COLOR: '--border-color',
  INPUT_BG: '--input-bg',
} as const;