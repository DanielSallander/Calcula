//! FILENAME: app/extensions/_shared/lib/themeTokens.ts
// PURPOSE: The theme custom properties, with their light-theme values as
//          fallbacks, for shared components to use instead of inventing names.
// CONTEXT: WRITTEN BECAUSE FOUR INVENTED NAMES SHIPPED. The design-query row
//          styled itself with `--border-color`, `--input-bg`, `--success-color`
//          and `--error-color`. None of the four exists — not in `THEME_TOKENS`,
//          not in `defaultTheme`, not in `darkTheme`, not in any skin, and
//          `src/index.css` declares no custom properties at all. Every one fell
//          through to its hardcoded literal, so that row never followed the
//          user's skin in its entire life; it only looked like it meant to. A
//          sibling was worse: `border: "1px solid var(--border-color)"` with no
//          fallback is an invalid shorthand, so three of five mounts painted no
//          border whatsoever.
//
//          (Two of the four, `--border-color` and `--input-bg`, were later
//          DECLARED in tokens.ts as aliases of `--border-default` and
//          `--bg-surface`, so the surfaces that still spell them now follow the
//          skin. This table keeps naming the real tokens; the aliases exist to
//          repair old call sites, not to be reached for.)
//
//          WHY A COPY AND NOT AN IMPORT. `FACADE_IMPORT_PATTERNS` in
//          `app/eslint.boundaries.js` bans `@core` and `src/core/**` from every
//          file under `extensions/` — `_shared` included — regardless of what
//          the element-type rule appears to allow. So `src/core/theme/tokens.ts`
//          is unreachable from here and this table is a deliberate second copy.
//          A second copy that drifts is exactly how the phantom names appeared,
//          so `themeTokenParity.test.ts` reads BOTH files and fails when a name
//          here is not declared there.

/**
 * Use these rather than typing `var(--…)`. Every entry is a real declared token
 * and every fallback is its light-theme value, so a surface degrades to the
 * light palette rather than to nothing when a skin omits one.
 */
export const TOKENS = {
  textPrimary: "var(--text-primary, #111827)",
  textSecondary: "var(--text-secondary, #6b7280)",
  textTertiary: "var(--text-tertiary, #888888)",
  accent: "var(--accent-color, #1a5fb4)",
  panelBg: "var(--panel-bg, #f9fafb)",
  surfaceBg: "var(--bg-surface, #ffffff)",
  border: "var(--border-default, #d1d5db)",
  inputBg: "var(--dialog-input-bg, #ffffff)",
  inputBorder: "var(--dialog-input-border, #d1d5db)",
  inputBorderFocus: "var(--dialog-input-border-focus, #10b981)",
  okFg: "var(--tone-ok-fg, #067647)",
  okBg: "var(--tone-ok-bg, #ecfdf3)",
  dangerFg: "var(--tone-danger-fg, #b42318)",
  dangerBg: "var(--tone-danger-bg, #fef3f2)",
  warnFg: "var(--tone-warn-fg, #b54708)",
  infoFg: "var(--tone-info-fg, #175cd3)",
  infoBg: "var(--tone-info-bg, #eff8ff)",
  warnBg: "var(--tone-warn-bg, #fffaeb)",
  monoFont: "var(--font-family-cell, ui-monospace, Consolas, monospace)",

  // ---- Calcula Clusters: shape + motion -------------------------------------
  // Extensions that draw their own chrome (a task pane, a dialog body) round
  // and animate with the same values as the @api/layout primitives, so a skin
  // that squares the ribbon off squares the extension off with it.
  radiusControl: "var(--radius-control, 8px)",
  radiusCluster: "var(--radius-cluster, 12px)",
  radiusPopover: "var(--radius-popover, 12px)",
  radiusPill: "var(--radius-pill, 999px)",
  motionHover: "var(--motion-hover, 120ms cubic-bezier(0.2, 0, 0, 1))",
  motionPopover: "var(--motion-popover, 140ms cubic-bezier(0.2, 0, 0, 1))",

  // ---- Calcula Clusters: elevation + focus ----------------------------------
  shadowPopover:
    "var(--shadow-popover, 0 8px 24px rgba(16, 24, 40, 0.12), 0 1px 3px rgba(16, 24, 40, 0.08))",
  shadowRaised: "var(--shadow-raised, 0 6px 16px rgba(16, 24, 40, 0.14))",
  // The baseline value references --bg-surface and --focus-ring-color; the
  // fallback is those two resolved to their light values, because a fallback
  // must be something that paints without the theme present.
  focusRing: "var(--focus-ring, 0 0 0 2px #ffffff, 0 0 0 4px #047857)",
  stateAccent: "var(--state-accent, #047857)",

  // ---- Calcula Clusters: ribbon surfaces ------------------------------------
  ribbonFrameBg: "var(--ribbon-frame-bg, #f9fafb)",
  ribbonBandBg: "var(--ribbon-band-bg, #ffffff)",
  clusterBg: "var(--ribbon-cluster-bg, #f3f4f6)",
  clusterBorder: "var(--ribbon-cluster-border, #e5e7eb)",
  ribbonGroupLabel: "var(--ribbon-group-label-fg, #666d7a)",

  // ---- Calcula Clusters: controls -------------------------------------------
  controlBorder: "var(--control-border, #d1d5db)",
  controlDivider: "var(--control-divider, #e5e7eb)",
  controlTrack: "var(--control-track, #e5e7eb)",
  chipBg: "var(--chip-bg, #ffffff)",
  chipBorder: "var(--chip-border, #e5e7eb)",
  borderSubtle: "var(--border-subtle, #eef0f3)",
  buttonHoverBg: "var(--button-hover-bg, rgba(0, 0, 0, 0.06))",
  buttonActiveBg: "var(--button-active-bg, rgba(0, 0, 0, 0.1))",
  // The baseline values are color-mix() tints of --accent-primary; the
  // fallbacks are those tints of the light accent (#10b981) written out.
  buttonPressedBg: "var(--button-pressed-bg, rgba(16, 185, 129, 0.14))",
  buttonPressedBorder: "var(--button-pressed-border, rgba(16, 185, 129, 0.45))",
  tooltipBg: "var(--tooltip-bg, #111827)",
  tooltipFg: "var(--tooltip-fg, #f9fafb)",
  badgeBg: "var(--badge-bg, #1a5fb4)",
  badgeFg: "var(--badge-fg, #ffffff)",

  // ---- Calcula Clusters: contextual tab accents -----------------------------
  tabAccentChart: "var(--tab-accent-chart, #1d5fd0)",
  tabAccentTable: "var(--tab-accent-table, #0b7a6b)",
  tabAccentPivot: "var(--tab-accent-pivot, #1a7a43)",
  tabAccentSlicer: "var(--tab-accent-slicer, #6a48c9)",
  tabAccentSparkline: "var(--tab-accent-sparkline, #b8410a)",
  tabAccentReport: "var(--tab-accent-report, #8a3d0b)",
} as const;

/** The bare custom-property names, for the parity guard to check. */
export const TOKEN_NAMES: readonly string[] = Object.values(TOKENS)
  .map((v) => /var\((--[a-z0-9-]+)/i.exec(v)?.[1] ?? "")
  .filter((n) => n !== "");
