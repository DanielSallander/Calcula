//! FILENAME: app/src/core/theme/darkTheme.ts
// PURPOSE: Dark token baseline for the App Skin system. Mirrors EVERY key in
//          defaultTheme.ts (the light baseline) with dark-appropriate values.
// CONTEXT: Core/pure. Keep key-for-key in sync with defaultTheme.ts.

import { THEME_TOKENS } from "./tokens";

export const darkTheme: Record<string, string> = {
  // --- Context Menu ---
  [THEME_TOKENS.CTX_MENU_BG]: "#2d2d2d",
  [THEME_TOKENS.CTX_MENU_TEXT]: "#e0e0e0",
  [THEME_TOKENS.CTX_MENU_BORDER]: "#3a3a3a",
  [THEME_TOKENS.CTX_MENU_SHADOW]: "0 4px 12px rgba(0, 0, 0, 0.5)",
  [THEME_TOKENS.CTX_MENU_ITEM_HOVER_BG]: "#3a3a3a",
  [THEME_TOKENS.CTX_MENU_SEPARATOR]: "#3a3a3a",
  [THEME_TOKENS.CTX_MENU_Z_INDEX]: "10000",

  // --- Grid ---
  [THEME_TOKENS.GRID_BG]: "#1e1e1e",
  [THEME_TOKENS.GRID_TEXT]: "#e0e0e0",
  [THEME_TOKENS.GRID_LINE]: "#3a3a3a",
  [THEME_TOKENS.GRID_HEADER_BG]: "#252526",
  [THEME_TOKENS.GRID_HEADER_TEXT]: "#cccccc",
  [THEME_TOKENS.GRID_SELECTION_BORDER]: "#10b981",
  [THEME_TOKENS.GRID_SELECTION_BG]: "rgba(16, 185, 129, 0.18)",
  [THEME_TOKENS.SPREADSHEET_BG]: "#1e1e1e",
  [THEME_TOKENS.GRID_AREA_BG]: "#1e1e1e",
  [THEME_TOKENS.CANVAS_BG]: "#1e1e1e",

  // --- Formula Bar ---
  [THEME_TOKENS.FORMULA_BAR_BG]: "#252526",
  [THEME_TOKENS.FORMULA_BAR_BORDER]: "#3a3a3a",
  [THEME_TOKENS.FORMULA_BAR_BUTTON_BORDER]: "#3a3a3a",
  [THEME_TOKENS.FORMULA_BAR_BUTTON_DISABLED]: "#2d2d2d",
  [THEME_TOKENS.FORMULA_BAR_CANCEL_COLOR]: "#f87171",
  [THEME_TOKENS.FORMULA_BAR_ENTER_COLOR]: "#34d399",
  [THEME_TOKENS.FORMULA_BAR_FUNCTION_COLOR]: "#818cf8",
  [THEME_TOKENS.FORMULA_BAR_CANCEL_HOVER_BG]: "#3a2222",
  [THEME_TOKENS.FORMULA_BAR_ENTER_HOVER_BG]: "#1f3a2e",
  [THEME_TOKENS.FORMULA_BAR_FUNCTION_HOVER_BG]: "#262a45",
  [THEME_TOKENS.FORMULA_INPUT_BG]: "#1e1e1e",
  [THEME_TOKENS.FORMULA_INPUT_BG_FOCUSED]: "#252526",
  [THEME_TOKENS.FORMULA_INPUT_BORDER]: "#3a3a3a",
  [THEME_TOKENS.FORMULA_INPUT_TEXT]: "#e0e0e0",

  // --- Name Box ---
  [THEME_TOKENS.NAMEBOX_BG]: "#252526",
  [THEME_TOKENS.NAMEBOX_BG_EDITING]: "#3a3320",
  [THEME_TOKENS.NAMEBOX_BORDER]: "#3a3a3a",
  [THEME_TOKENS.NAMEBOX_TEXT]: "#e0e0e0",

  // --- Sheet Tabs ---
  [THEME_TOKENS.SHEET_TABS_BG]: "#252526",
  [THEME_TOKENS.SHEET_TABS_BORDER]: "#3a3a3a",
  [THEME_TOKENS.SHEET_TAB_BG]: "#323236",
  [THEME_TOKENS.SHEET_TAB_BORDER]: "#47474c",
  [THEME_TOKENS.SHEET_TAB_ACTIVE_BG]: "#1e1e1e",
  [THEME_TOKENS.SHEET_TAB_FORMULA_SOURCE_BG]: "#3a2e1a",
  [THEME_TOKENS.SHEET_TAB_FORMULA_SOURCE_BORDER]: "#ff9800",
  [THEME_TOKENS.SHEET_TAB_FORMULA_TARGET_BG]: "#1a2a3a",
  [THEME_TOKENS.SHEET_TAB_FORMULA_TARGET_BORDER]: "#2196f3",
  [THEME_TOKENS.SHEET_TAB_FORMULA_INDICATOR_TEXT]: "#64b5f6",
  [THEME_TOKENS.SHEET_TAB_FORMULA_INDICATOR_BG]: "#1a2a3a",

  // --- Dialog ---
  [THEME_TOKENS.DIALOG_OVERLAY_BG]: "rgba(0, 0, 0, 0.6)",
  [THEME_TOKENS.DIALOG_BG]: "#252526",
  [THEME_TOKENS.DIALOG_SHADOW]:
    "0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.3)",
  [THEME_TOKENS.DIALOG_BORDER]: "#3a3a3a",
  [THEME_TOKENS.DIALOG_TITLE_TEXT]: "#e0e0e0",
  [THEME_TOKENS.DIALOG_CLOSE_BUTTON]: "#9ca3af",
  [THEME_TOKENS.DIALOG_CLOSE_BUTTON_HOVER]: "#e0e0e0",
  [THEME_TOKENS.DIALOG_INPUT_BORDER]: "#3a3a3a",
  [THEME_TOKENS.DIALOG_INPUT_BG]: "#1e1e1e",
  [THEME_TOKENS.DIALOG_INPUT_TEXT]: "#e0e0e0",
  [THEME_TOKENS.DIALOG_INPUT_BORDER_FOCUS]: "#10b981",
  [THEME_TOKENS.DIALOG_CATEGORY_BORDER]: "#3a3a3a",
  [THEME_TOKENS.DIALOG_CATEGORY_BG]: "#252526",
  [THEME_TOKENS.DIALOG_CATEGORY_ACTIVE_BG]: "#10b981",
  [THEME_TOKENS.DIALOG_CATEGORY_TEXT]: "#9ca3af",
  [THEME_TOKENS.DIALOG_CATEGORY_ACTIVE_TEXT]: "#ffffff",
  [THEME_TOKENS.DIALOG_CATEGORY_HOVER_BG]: "#3a3a3a",
  [THEME_TOKENS.DIALOG_LOADING_TEXT]: "#9ca3af",
  [THEME_TOKENS.DIALOG_EMPTY_TEXT]: "#6b7280",
  [THEME_TOKENS.DIALOG_FUNCTION_SELECTED_BG]: "#1e3a5f",
  [THEME_TOKENS.DIALOG_FUNCTION_SELECTED_BORDER]: "#3b82f6",
  [THEME_TOKENS.DIALOG_FUNCTION_HOVER_BG]: "#3a3a3a",
  [THEME_TOKENS.DIALOG_FUNCTION_NAME]: "#60a5fa",
  [THEME_TOKENS.DIALOG_FUNCTION_DESCRIPTION]: "#9ca3af",
  [THEME_TOKENS.DIALOG_DETAILS_BG]: "#1e1e1e",
  [THEME_TOKENS.DIALOG_FUNCTION_SIGNATURE]: "#34d399",
  [THEME_TOKENS.DIALOG_FUNCTION_FULL_DESCRIPTION]: "#cccccc",
  [THEME_TOKENS.DIALOG_BUTTON_BORDER]: "#3a3a3a",
  [THEME_TOKENS.DIALOG_BUTTON_BG]: "#2d2d2d",
  [THEME_TOKENS.DIALOG_BUTTON_TEXT]: "#e0e0e0",
  [THEME_TOKENS.DIALOG_BUTTON_HOVER_BG]: "#3a3a3a",
  [THEME_TOKENS.DIALOG_INSERT_DISABLED_BG]: "#2d2d2d",
  [THEME_TOKENS.DIALOG_INSERT_BG]: "#10b981",
  [THEME_TOKENS.DIALOG_INSERT_TEXT]: "#ffffff",
  [THEME_TOKENS.DIALOG_INSERT_HOVER_BG]: "#059669",

  // --- Menu Bar ---
  [THEME_TOKENS.MENU_BAR_BG]: "#2d2d2d",
  [THEME_TOKENS.MENU_BAR_BORDER]: "#1e1e1e",
  [THEME_TOKENS.MENU_DROPDOWN_BG]: "#252526",
  [THEME_TOKENS.MENU_BORDER]: "#3a3a3a",
  [THEME_TOKENS.MENU_TEXT]: "#cccccc",
  [THEME_TOKENS.MENU_TEXT_DISABLED]: "#6c6c6c",
  [THEME_TOKENS.MENU_BUTTON_HOVER_BG]: "#3a3a3a",
  [THEME_TOKENS.MENU_BUTTON_ACTIVE_BG]: "#505050",
  [THEME_TOKENS.MENU_ITEM_HOVER_BG]: "#094771",
  [THEME_TOKENS.MENU_SHORTCUT_TEXT]: "#888888",
  [THEME_TOKENS.MENU_SEPARATOR]: "#3a3a3a",
  [THEME_TOKENS.MENU_SHADOW]: "rgba(0, 0, 0, 0.5)",

  // --- General ---
  [THEME_TOKENS.TEXT_PRIMARY]: "#e0e0e0",
  [THEME_TOKENS.TEXT_SECONDARY]: "#9ca3af",
  [THEME_TOKENS.TEXT_TERTIARY]: "#6b7280",
  [THEME_TOKENS.TEXT_ERROR]: "#f87171",
  [THEME_TOKENS.TEXT_DISABLED]: "#6b7280",
  [THEME_TOKENS.ACCENT_PRIMARY]: "#10b981",
  [THEME_TOKENS.ACCENT_COLOR]: "#3b82f6",
  [THEME_TOKENS.BG_SURFACE]: "#252526",
  [THEME_TOKENS.BG_SURFACE_DISABLED]: "#2d2d2d",
  [THEME_TOKENS.BORDER_DEFAULT]: "#3a3a3a",
  [THEME_TOKENS.BORDER_DISABLED]: "#2d2d2d",
  [THEME_TOKENS.PANEL_BG]: "#252526",
  [THEME_TOKENS.FONT_FAMILY_SANS]: "system-ui, -apple-system, sans-serif",
  // Cell/editor font (Excel default body font). Keeps the inline editor overlay
  // in the same family as the canvas cell text.
  [THEME_TOKENS.FONT_FAMILY_CELL]: 'Calibri, "Segoe UI", Arial, sans-serif',
  // px equivalent of the default 11pt cell text (11 * 96/72). Fallback for the
  // inline editor overlay when a cell carries no explicit size.
  [THEME_TOKENS.FONT_SIZE_CELL]: "14.667px",
  [THEME_TOKENS.Z_INDEX_EDITOR]: "10",

  // --- Semantic tones ---
  // INVERTED, not reused. The light foregrounds (#b42318 and friends) are
  // 2-3:1 on a #252526 surface — the same defect that forced ICON_DANGER to be
  // lightened for dark. Foreground is the light tint, background the dark one,
  // and `tone_pairs_are_legible` in tokens.test.ts asserts both directions
  // rather than trusting this comment.
  [THEME_TOKENS.TONE_DANGER_FG]: "#fda29b",
  [THEME_TOKENS.TONE_DANGER_BG]: "#55160c",
  [THEME_TOKENS.TONE_WARN_FG]: "#fec84b",
  [THEME_TOKENS.TONE_WARN_BG]: "#4e1d09",
  [THEME_TOKENS.TONE_OK_FG]: "#6ce9a6",
  [THEME_TOKENS.TONE_OK_BG]: "#053321",
  [THEME_TOKENS.TONE_INFO_FG]: "#84caff",
  [THEME_TOKENS.TONE_INFO_BG]: "#102a56",

  // --- Scrollbar ---
  [THEME_TOKENS.SCROLLBAR_TRACK_BG]: "#1e1e1e",
  [THEME_TOKENS.SCROLLBAR_BORDER_COLOR]: "#3a3a3a",
  [THEME_TOKENS.SCROLLBAR_THUMB_BG_DEFAULT]: "#4a4a4a",
  [THEME_TOKENS.SCROLLBAR_THUMB_BG_HOVER]: "#5a5a5a",
  [THEME_TOKENS.SCROLLBAR_THUMB_BG_ACTIVE]: "#6a6a6a",
  [THEME_TOKENS.SCROLLBAR_THUMB_BORDER_COLOR]: "#3a3a3a",

  // --- Ribbon ---
  [THEME_TOKENS.RIBBON_BUTTON_ACTIVE_BG]: "rgba(255, 255, 255, 0.11)",
  [THEME_TOKENS.RIBBON_BUTTON_HOVER_BG]: "rgba(255, 255, 255, 0.07)",

  // --- Shared control atoms (@api/layout) ---
  [THEME_TOKENS.BUTTON_BG]: "transparent",
  [THEME_TOKENS.BUTTON_HOVER_BG]: "rgba(255, 255, 255, 0.08)",
  [THEME_TOKENS.BUTTON_ACTIVE_BG]: "rgba(255, 255, 255, 0.13)",
  // Pressed = accent tint: derived from --accent-primary so skin accent
  // overrides cascade to toggle states without retuning these.
  [THEME_TOKENS.BUTTON_PRESSED_BG]: "color-mix(in srgb, var(--accent-primary) 28%, transparent)",
  [THEME_TOKENS.BUTTON_PRESSED_BORDER]: "color-mix(in srgb, var(--accent-primary) 55%, transparent)",

  // --- Ribbon icon accents (@api ribbonIcons) ---
  // Follows the state colour, as in the light baseline (see defaultTheme.ts).
  [THEME_TOKENS.ICON_ACCENT]: "var(--state-accent)",
  // Lightened like TEXT_ERROR: #c42b1c is only ~2.7:1 on the dark panel bg.
  [THEME_TOKENS.ICON_DANGER]: "#f87171",

  // --- Calcula Clusters: shape + motion (identical to light — geometry is not
  //     a colour and does not change with the base) ---
  [THEME_TOKENS.RADIUS_CONTROL]: "8px",
  [THEME_TOKENS.RADIUS_CLUSTER]: "12px",
  [THEME_TOKENS.RADIUS_POPOVER]: "12px",
  [THEME_TOKENS.RADIUS_PILL]: "999px",
  [THEME_TOKENS.MOTION_HOVER]: "120ms cubic-bezier(0.2, 0, 0, 1)",
  [THEME_TOKENS.MOTION_POPOVER]: "140ms cubic-bezier(0.2, 0, 0, 1)",
  [THEME_TOKENS.MOTION_PANEL]: "180ms cubic-bezier(0.2, 0, 0, 1)",

  // --- Calcula Clusters: elevation ---
  // Much heavier alphas than light: a 6% shadow is invisible on #252526, and
  // elevation on a dark ground reads through darkness, not through a tint.
  [THEME_TOKENS.SHADOW_CLUSTER_HOVER]: "0 1px 2px rgba(0, 0, 0, 0.45)",
  [THEME_TOKENS.SHADOW_POPOVER]: "0 8px 24px rgba(0, 0, 0, 0.55), 0 1px 3px rgba(0, 0, 0, 0.4)",
  [THEME_TOKENS.SHADOW_TOOLBAR]: "0 4px 16px rgba(0, 0, 0, 0.6)",
  [THEME_TOKENS.SHADOW_RAISED]: "0 6px 16px rgba(0, 0, 0, 0.5)",

  // --- Calcula Clusters: state colour ---
  // Lightened, never reused: the light value #047857 is under 3:1 on the dark
  // surface — the same trap ICON_DANGER and the tone foregrounds fell into.
  [THEME_TOKENS.STATE_ACCENT]: "#34d399",
  [THEME_TOKENS.FOCUS_RING_COLOR]: "var(--state-accent)",
  [THEME_TOKENS.FOCUS_RING]: "0 0 0 2px var(--bg-surface), 0 0 0 4px var(--focus-ring-color)",

  // --- Calcula Clusters: ribbon surfaces ---
  [THEME_TOKENS.RIBBON_FRAME_BG]: "#1f1f20",
  [THEME_TOKENS.RIBBON_BAND_BG]: "#252526",
  [THEME_TOKENS.RIBBON_CLUSTER_BG]: "#2b2b2e",
  [THEME_TOKENS.RIBBON_CLUSTER_BORDER]: "#38383b",
  [THEME_TOKENS.RIBBON_CLUSTER_BORDER_HOVER]: "#4a4a4f",
  [THEME_TOKENS.RIBBON_GROUP_LABEL_FG]: "#9ca3af",
  [THEME_TOKENS.RIBBON_TAB_INDICATOR]: "var(--state-accent)",

  // --- Calcula Clusters: controls ---
  [THEME_TOKENS.CONTROL_BORDER]: "#3f3f46",
  [THEME_TOKENS.CONTROL_DIVIDER]: "#3a3a3d",
  [THEME_TOKENS.CONTROL_TRACK]: "#3f3f46",
  [THEME_TOKENS.CHIP_BG]: "#303033",
  [THEME_TOKENS.CHIP_BORDER]: "#3f3f46",
  // The tooltip INVERTS with the base (light chip on a dark app), which is why
  // it is a token pair rather than "always dark".
  [THEME_TOKENS.TOOLTIP_BG]: "#f3f4f6",
  [THEME_TOKENS.TOOLTIP_FG]: "#111827",
  [THEME_TOKENS.KBD_BG]: "rgba(17, 24, 39, 0.10)",
  [THEME_TOKENS.BADGE_BG]: "var(--accent-color)",
  [THEME_TOKENS.BADGE_FG]: "#ffffff",

  // --- Calcula Clusters: duotone icon ground ---
  // LESS ink than light (45% vs 50%), because the contrast budget is smaller:
  // soft-vs-cluster times strong-vs-soft equals strong-vs-cluster, 10.7:1
  // here against 16.1:1 in light. 45% renders #7c7c7e (3.4:1 on the cluster,
  // 3.0:1 under hover) and keeps STRONG 3.2:1 above it; 50% flattens the
  // small strong details that sit on a soft ground.
  [THEME_TOKENS.ICON_FILL_SOFT]: "color-mix(in srgb, currentColor 45%, transparent)",

  // --- Calcula Clusters: contextual tab accents (each >= 4.5:1 on the frame) ---
  [THEME_TOKENS.TAB_ACCENT_CHART]: "#7aa7ff",
  [THEME_TOKENS.TAB_ACCENT_TABLE]: "#4fd1c0",
  [THEME_TOKENS.TAB_ACCENT_PIVOT]: "#5fd08a",
  [THEME_TOKENS.TAB_ACCENT_SLICER]: "#b39cff",
  [THEME_TOKENS.TAB_ACCENT_SPARKLINE]: "#fb923c",
  [THEME_TOKENS.TAB_ACCENT_REPORT]: "#fbbf24",

  // --- Calcula Clusters: sidebar activity bar + status bar ---
  [THEME_TOKENS.ACTIVITY_BAR_BG]: "#1b1b1c",
  [THEME_TOKENS.ACTIVITY_BAR_FG]: "#a1a1aa",
  [THEME_TOKENS.ACTIVITY_BAR_FG_ACTIVE]: "#f5f5f5",
  [THEME_TOKENS.ACTIVITY_BAR_ITEM_HOVER_BG]: "rgba(255, 255, 255, 0.07)",
  [THEME_TOKENS.ACTIVITY_BAR_ITEM_ACTIVE_BG]: "color-mix(in srgb, var(--state-accent) 24%, transparent)",
  [THEME_TOKENS.ACTIVITY_BAR_INDICATOR]: "var(--state-accent)",
  [THEME_TOKENS.SIDE_PANEL_HEADER_BG]: "var(--panel-bg)",
  [THEME_TOKENS.STATUS_BAR_BG]: "#1b5e3a",
  [THEME_TOKENS.STATUS_BAR_FG]: "#ffffff",
  [THEME_TOKENS.BORDER_SUBTLE]: "#303033",

  // --- Aliases for names callers already spelled (see tokens.ts) ---
  [THEME_TOKENS.BORDER_COLOR]: "var(--border-default)",
  [THEME_TOKENS.INPUT_BG]: "var(--bg-surface)",
};
