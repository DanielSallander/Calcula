//! FILENAME: app/src/core/theme/defaultTheme.ts
import { THEME_TOKENS } from './tokens';

export const defaultTheme: Record<string, string> = {
  // --- Context Menu ---
  [THEME_TOKENS.CTX_MENU_BG]: '#ffffff',
  [THEME_TOKENS.CTX_MENU_TEXT]: '#333333',
  [THEME_TOKENS.CTX_MENU_BORDER]: '#d1d5db',
  [THEME_TOKENS.CTX_MENU_SHADOW]: '0 4px 12px rgba(0, 0, 0, 0.15)',
  [THEME_TOKENS.CTX_MENU_ITEM_HOVER_BG]: '#f3f4f6',
  [THEME_TOKENS.CTX_MENU_SEPARATOR]: '#e5e7eb',
  [THEME_TOKENS.CTX_MENU_Z_INDEX]: '10000',

  // --- Grid ---
  [THEME_TOKENS.GRID_BG]: '#ffffff',
  [THEME_TOKENS.GRID_TEXT]: '#000000',
  [THEME_TOKENS.GRID_LINE]: '#e0e0e0',
  [THEME_TOKENS.GRID_HEADER_BG]: '#f9fafb',
  [THEME_TOKENS.GRID_HEADER_TEXT]: '#374151',
  [THEME_TOKENS.GRID_SELECTION_BORDER]: '#10b981',
  [THEME_TOKENS.GRID_SELECTION_BG]: 'rgba(16, 185, 129, 0.1)',
  [THEME_TOKENS.SPREADSHEET_BG]: '#ffffff',
  [THEME_TOKENS.GRID_AREA_BG]: '#ffffff',
  [THEME_TOKENS.CANVAS_BG]: '#ffffff',

  // --- Formula Bar ---
  [THEME_TOKENS.FORMULA_BAR_BG]: '#ffffff',
  [THEME_TOKENS.FORMULA_BAR_BORDER]: '#d1d5db',
  [THEME_TOKENS.FORMULA_BAR_BUTTON_BORDER]: '#d1d5db',
  [THEME_TOKENS.FORMULA_BAR_BUTTON_DISABLED]: '#e5e7eb',
  [THEME_TOKENS.FORMULA_BAR_CANCEL_COLOR]: '#dc2626',
  [THEME_TOKENS.FORMULA_BAR_ENTER_COLOR]: '#10b981',
  [THEME_TOKENS.FORMULA_BAR_FUNCTION_COLOR]: '#6366f1',
  [THEME_TOKENS.FORMULA_BAR_CANCEL_HOVER_BG]: '#fee2e2',
  [THEME_TOKENS.FORMULA_BAR_ENTER_HOVER_BG]: '#d1fae5',
  [THEME_TOKENS.FORMULA_BAR_FUNCTION_HOVER_BG]: '#e0e7ff',
  [THEME_TOKENS.FORMULA_INPUT_BG]: '#ffffff',
  [THEME_TOKENS.FORMULA_INPUT_BG_FOCUSED]: '#ffffff',
  [THEME_TOKENS.FORMULA_INPUT_BORDER]: '#d1d5db',
  [THEME_TOKENS.FORMULA_INPUT_TEXT]: '#111827',

  // --- Name Box ---
  [THEME_TOKENS.NAMEBOX_BG]: '#ffffff',
  [THEME_TOKENS.NAMEBOX_BG_EDITING]: '#fef3c7',
  [THEME_TOKENS.NAMEBOX_BORDER]: '#d1d5db',
  [THEME_TOKENS.NAMEBOX_TEXT]: '#111827',

  // --- Sheet Tabs ---
  [THEME_TOKENS.SHEET_TABS_BG]: '#f0f0f0',
  [THEME_TOKENS.SHEET_TABS_BORDER]: '#d0d0d0',
  [THEME_TOKENS.SHEET_TAB_BG]: '#e2e2e2',
  [THEME_TOKENS.SHEET_TAB_BORDER]: '#c6c6c6',
  [THEME_TOKENS.SHEET_TAB_ACTIVE_BG]: '#ffffff',
  [THEME_TOKENS.SHEET_TAB_FORMULA_SOURCE_BG]: '#fff3e0',
  [THEME_TOKENS.SHEET_TAB_FORMULA_SOURCE_BORDER]: '#ff9800',
  [THEME_TOKENS.SHEET_TAB_FORMULA_TARGET_BG]: '#e3f2fd',
  [THEME_TOKENS.SHEET_TAB_FORMULA_TARGET_BORDER]: '#2196f3',
  [THEME_TOKENS.SHEET_TAB_FORMULA_INDICATOR_TEXT]: '#1976d2',
  [THEME_TOKENS.SHEET_TAB_FORMULA_INDICATOR_BG]: '#e3f2fd',

  // --- Dialog ---
  [THEME_TOKENS.DIALOG_OVERLAY_BG]: 'rgba(0, 0, 0, 0.5)',
  [THEME_TOKENS.DIALOG_BG]: '#ffffff',
  [THEME_TOKENS.DIALOG_SHADOW]: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
  [THEME_TOKENS.DIALOG_BORDER]: '#d1d5db',
  [THEME_TOKENS.DIALOG_TITLE_TEXT]: '#111827',
  [THEME_TOKENS.DIALOG_CLOSE_BUTTON]: '#6b7280',
  [THEME_TOKENS.DIALOG_CLOSE_BUTTON_HOVER]: '#111827',
  [THEME_TOKENS.DIALOG_INPUT_BORDER]: '#d1d5db',
  [THEME_TOKENS.DIALOG_INPUT_BG]: '#ffffff',
  [THEME_TOKENS.DIALOG_INPUT_TEXT]: '#111827',
  [THEME_TOKENS.DIALOG_INPUT_BORDER_FOCUS]: '#10b981',
  [THEME_TOKENS.DIALOG_CATEGORY_BORDER]: '#e5e7eb',
  [THEME_TOKENS.DIALOG_CATEGORY_BG]: '#ffffff',
  [THEME_TOKENS.DIALOG_CATEGORY_ACTIVE_BG]: '#10b981',
  [THEME_TOKENS.DIALOG_CATEGORY_TEXT]: '#6b7280',
  [THEME_TOKENS.DIALOG_CATEGORY_ACTIVE_TEXT]: '#ffffff',
  [THEME_TOKENS.DIALOG_CATEGORY_HOVER_BG]: '#f3f4f6',
  [THEME_TOKENS.DIALOG_LOADING_TEXT]: '#6b7280',
  [THEME_TOKENS.DIALOG_EMPTY_TEXT]: '#9ca3af',
  [THEME_TOKENS.DIALOG_FUNCTION_SELECTED_BG]: '#dbeafe',
  [THEME_TOKENS.DIALOG_FUNCTION_SELECTED_BORDER]: '#3b82f6',
  [THEME_TOKENS.DIALOG_FUNCTION_HOVER_BG]: '#f3f4f6',
  [THEME_TOKENS.DIALOG_FUNCTION_NAME]: '#1e40af',
  [THEME_TOKENS.DIALOG_FUNCTION_DESCRIPTION]: '#6b7280',
  [THEME_TOKENS.DIALOG_DETAILS_BG]: '#f9fafb',
  [THEME_TOKENS.DIALOG_FUNCTION_SIGNATURE]: '#059669',
  [THEME_TOKENS.DIALOG_FUNCTION_FULL_DESCRIPTION]: '#374151',
  [THEME_TOKENS.DIALOG_BUTTON_BORDER]: '#d1d5db',
  [THEME_TOKENS.DIALOG_BUTTON_BG]: '#ffffff',
  [THEME_TOKENS.DIALOG_BUTTON_TEXT]: '#374151',
  [THEME_TOKENS.DIALOG_BUTTON_HOVER_BG]: '#f3f4f6',
  [THEME_TOKENS.DIALOG_INSERT_DISABLED_BG]: '#e5e7eb',
  [THEME_TOKENS.DIALOG_INSERT_BG]: '#10b981',
  [THEME_TOKENS.DIALOG_INSERT_TEXT]: '#ffffff',
  [THEME_TOKENS.DIALOG_INSERT_HOVER_BG]: '#059669',

  // --- Menu Bar ---
  [THEME_TOKENS.MENU_BAR_BG]: '#3c3c3c',
  [THEME_TOKENS.MENU_BAR_BORDER]: '#252526',
  [THEME_TOKENS.MENU_DROPDOWN_BG]: '#252526',
  [THEME_TOKENS.MENU_BORDER]: '#454545',
  [THEME_TOKENS.MENU_TEXT]: '#cccccc',
  [THEME_TOKENS.MENU_TEXT_DISABLED]: '#6c6c6c',
  [THEME_TOKENS.MENU_BUTTON_HOVER_BG]: '#454545',
  [THEME_TOKENS.MENU_BUTTON_ACTIVE_BG]: '#505050',
  [THEME_TOKENS.MENU_ITEM_HOVER_BG]: '#094771',
  [THEME_TOKENS.MENU_SHORTCUT_TEXT]: '#888888',
  [THEME_TOKENS.MENU_SEPARATOR]: '#454545',
  [THEME_TOKENS.MENU_SHADOW]: 'rgba(0, 0, 0, 0.3)',

  // --- General ---
  [THEME_TOKENS.TEXT_PRIMARY]: '#111827',
  [THEME_TOKENS.TEXT_SECONDARY]: '#6b7280',
  [THEME_TOKENS.TEXT_TERTIARY]: '#888888',
  [THEME_TOKENS.TEXT_ERROR]: '#dc2626',
  [THEME_TOKENS.TEXT_DISABLED]: '#9ca3af',
  [THEME_TOKENS.ACCENT_PRIMARY]: '#10b981',
  [THEME_TOKENS.ACCENT_COLOR]: '#1a5fb4',
  [THEME_TOKENS.BG_SURFACE]: '#ffffff',
  [THEME_TOKENS.BG_SURFACE_DISABLED]: '#f5f5f5',
  [THEME_TOKENS.BORDER_DEFAULT]: '#d1d5db',
  [THEME_TOKENS.BORDER_DISABLED]: '#e5e7eb',
  [THEME_TOKENS.PANEL_BG]: '#f9fafb',
  [THEME_TOKENS.FONT_FAMILY_SANS]: 'system-ui, -apple-system, sans-serif',
  // Cell/editor font (Excel default body font). Keeps the inline editor overlay
  // in the same family as the canvas cell text.
  [THEME_TOKENS.FONT_FAMILY_CELL]: 'Calibri, "Segoe UI", Arial, sans-serif',
  // px equivalent of the default 11pt cell text (11 * 96/72). Fallback for the
  // inline editor overlay when a cell carries no explicit size.
  [THEME_TOKENS.FONT_SIZE_CELL]: '14.667px',
  [THEME_TOKENS.Z_INDEX_EDITOR]: '10',

  // --- Semantic tones ---
  // Foreground/background pairs. Each fg is >= 4.5:1 on its own bg AND on
  // BG_SURFACE (#ffffff), so a tone is readable whether it is used as a filled
  // badge or as bare text on a card.
  [THEME_TOKENS.TONE_DANGER_FG]: '#b42318',
  [THEME_TOKENS.TONE_DANGER_BG]: '#fef3f2',
  [THEME_TOKENS.TONE_WARN_FG]: '#b54708',
  [THEME_TOKENS.TONE_WARN_BG]: '#fffaeb',
  [THEME_TOKENS.TONE_OK_FG]: '#067647',
  [THEME_TOKENS.TONE_OK_BG]: '#ecfdf3',
  [THEME_TOKENS.TONE_INFO_FG]: '#175cd3',
  [THEME_TOKENS.TONE_INFO_BG]: '#eff8ff',

  // --- Scrollbar ---
  [THEME_TOKENS.SCROLLBAR_TRACK_BG]: '#f5f5f5',
  [THEME_TOKENS.SCROLLBAR_BORDER_COLOR]: '#d1d5db',
  [THEME_TOKENS.SCROLLBAR_THUMB_BG_DEFAULT]: '#c0c0c0',
  [THEME_TOKENS.SCROLLBAR_THUMB_BG_HOVER]: '#a0a0a0',
  [THEME_TOKENS.SCROLLBAR_THUMB_BG_ACTIVE]: '#808080',
  [THEME_TOKENS.SCROLLBAR_THUMB_BORDER_COLOR]: '#d1d5db',
  // --- Ribbon ---
  [THEME_TOKENS.RIBBON_BUTTON_ACTIVE_BG]: 'rgba(0, 0, 0, 0.09)',
  [THEME_TOKENS.RIBBON_BUTTON_HOVER_BG]: 'rgba(0, 0, 0, 0.05)',

  // --- Shared control atoms (@api/layout) ---
  [THEME_TOKENS.BUTTON_BG]: 'transparent',
  [THEME_TOKENS.BUTTON_HOVER_BG]: 'rgba(0, 0, 0, 0.06)',
  [THEME_TOKENS.BUTTON_ACTIVE_BG]: 'rgba(0, 0, 0, 0.10)',
  // Pressed = accent tint: derived from --accent-primary so skin accent
  // overrides cascade to toggle states without retuning these.
  [THEME_TOKENS.BUTTON_PRESSED_BG]: 'color-mix(in srgb, var(--accent-primary) 14%, transparent)',
  [THEME_TOKENS.BUTTON_PRESSED_BORDER]: 'color-mix(in srgb, var(--accent-primary) 45%, transparent)',

  // --- Ribbon icon accents (@api ribbonIcons) ---
  // The accent channel of the duotone icon set follows the STATE colour, not
  // the brand green: an icon's accent is a small filled shape on the band, and
  // #10b981 is only ~2.5:1 there.
  [THEME_TOKENS.ICON_ACCENT]: 'var(--state-accent)',
  [THEME_TOKENS.ICON_DANGER]: '#c42b1c',

  // --- Calcula Clusters: shape + motion ---
  [THEME_TOKENS.RADIUS_CONTROL]: '8px',
  [THEME_TOKENS.RADIUS_CLUSTER]: '12px',
  [THEME_TOKENS.RADIUS_POPOVER]: '12px',
  [THEME_TOKENS.RADIUS_PILL]: '999px',
  [THEME_TOKENS.MOTION_HOVER]: '120ms cubic-bezier(0.2, 0, 0, 1)',
  [THEME_TOKENS.MOTION_POPOVER]: '140ms cubic-bezier(0.2, 0, 0, 1)',
  [THEME_TOKENS.MOTION_PANEL]: '180ms cubic-bezier(0.2, 0, 0, 1)',

  // --- Calcula Clusters: elevation ---
  [THEME_TOKENS.SHADOW_CLUSTER_HOVER]: '0 1px 2px rgba(16, 24, 40, 0.06)',
  [THEME_TOKENS.SHADOW_POPOVER]: '0 8px 24px rgba(16, 24, 40, 0.12), 0 1px 3px rgba(16, 24, 40, 0.08)',
  [THEME_TOKENS.SHADOW_TOOLBAR]: '0 4px 16px rgba(16, 24, 40, 0.14)',
  [THEME_TOKENS.SHADOW_RAISED]: '0 6px 16px rgba(16, 24, 40, 0.14)',

  // --- Calcula Clusters: state colour ---
  // 5.5:1 on the surface and 5.0:1 on a cluster card; tokens.test.ts holds it
  // to the 3:1 non-text minimum against both.
  [THEME_TOKENS.STATE_ACCENT]: '#047857',
  [THEME_TOKENS.FOCUS_RING_COLOR]: 'var(--state-accent)',
  // Two rings: an inner gap in the surface colour so the accent ring reads on
  // ANY control background, including a pressed (accent-tinted) one.
  [THEME_TOKENS.FOCUS_RING]: '0 0 0 2px var(--bg-surface), 0 0 0 4px var(--focus-ring-color)',

  // --- Calcula Clusters: ribbon surfaces ---
  [THEME_TOKENS.RIBBON_FRAME_BG]: '#f9fafb',
  [THEME_TOKENS.RIBBON_BAND_BG]: '#ffffff',
  [THEME_TOKENS.RIBBON_CLUSTER_BG]: '#f3f4f6',
  [THEME_TOKENS.RIBBON_CLUSTER_BORDER]: '#e5e7eb',
  [THEME_TOKENS.RIBBON_CLUSTER_BORDER_HOVER]: '#d1d5db',
  // The mockup's #6b7280 measured 4.39:1 on the cluster card (#f3f4f6) and
  // 4.25:1 on Calcula Soft's card, which inherits this value — under the 4.5:1
  // an 11px caption needs. #666d7a is the same hue one small lightness step
  // darker: the least change that clears 4.5:1 on every built-in card.
  [THEME_TOKENS.RIBBON_GROUP_LABEL_FG]: '#666d7a',
  [THEME_TOKENS.RIBBON_TAB_INDICATOR]: 'var(--state-accent)',

  // --- Calcula Clusters: controls ---
  [THEME_TOKENS.CONTROL_BORDER]: '#d1d5db',
  [THEME_TOKENS.CONTROL_DIVIDER]: '#e5e7eb',
  [THEME_TOKENS.CONTROL_TRACK]: '#e5e7eb',
  [THEME_TOKENS.CHIP_BG]: '#ffffff',
  [THEME_TOKENS.CHIP_BORDER]: '#e5e7eb',
  [THEME_TOKENS.TOOLTIP_BG]: '#111827',
  [THEME_TOKENS.TOOLTIP_FG]: '#f9fafb',
  [THEME_TOKENS.KBD_BG]: 'rgba(255, 255, 255, 0.16)',
  [THEME_TOKENS.BADGE_BG]: 'var(--accent-color)',
  [THEME_TOKENS.BADGE_FG]: '#ffffff',

  // --- Calcula Clusters: duotone icon ground ---
  [THEME_TOKENS.ICON_FILL_SOFT]: 'color-mix(in srgb, currentColor 30%, transparent)',

  // --- Calcula Clusters: contextual tab accents (each >= 4.5:1 on the frame) ---
  [THEME_TOKENS.TAB_ACCENT_CHART]: '#1d5fd0',
  [THEME_TOKENS.TAB_ACCENT_TABLE]: '#0b7a6b',
  [THEME_TOKENS.TAB_ACCENT_PIVOT]: '#1a7a43',
  [THEME_TOKENS.TAB_ACCENT_SLICER]: '#6a48c9',
  [THEME_TOKENS.TAB_ACCENT_SPARKLINE]: '#b8410a',
  [THEME_TOKENS.TAB_ACCENT_REPORT]: '#8a3d0b',

  // --- Calcula Clusters: sidebar activity bar + status bar ---
  [THEME_TOKENS.ACTIVITY_BAR_BG]: '#f3f4f6',
  [THEME_TOKENS.ACTIVITY_BAR_FG]: '#4b5563',
  [THEME_TOKENS.ACTIVITY_BAR_FG_ACTIVE]: '#111827',
  [THEME_TOKENS.ACTIVITY_BAR_ITEM_HOVER_BG]: 'rgba(17, 24, 39, 0.06)',
  [THEME_TOKENS.ACTIVITY_BAR_ITEM_ACTIVE_BG]: 'color-mix(in srgb, var(--state-accent) 14%, transparent)',
  [THEME_TOKENS.ACTIVITY_BAR_INDICATOR]: 'var(--state-accent)',
  [THEME_TOKENS.SIDE_PANEL_HEADER_BG]: 'var(--panel-bg)',
  [THEME_TOKENS.STATUS_BAR_BG]: '#217346',
  [THEME_TOKENS.STATUS_BAR_FG]: '#ffffff',
  [THEME_TOKENS.BORDER_SUBTLE]: '#eef0f3',

  // --- Aliases for names callers already spelled (see tokens.ts) ---
  [THEME_TOKENS.BORDER_COLOR]: 'var(--border-default)',
  [THEME_TOKENS.INPUT_BG]: 'var(--bg-surface)',
};