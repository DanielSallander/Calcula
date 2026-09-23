//! FILENAME: app/src/api/layout/theme.ts
// PURPOSE: The theme custom properties every @api/layout primitive paints with,
//          each written ONCE with its light-theme value as the fallback.
// CONTEXT: THE ONE FILE IN @api/layout WHERE A COLOUR LITERAL IS CORRECT. The
//          hex ban in app/eslint.boundaries.js covers src/api/layout/** and
//          exempts exactly this file and colors.ts (categorical palette DATA),
//          the same shape the Model Editor settled on with components/theme.ts.
//
//          Why fallbacks at all when the skin loader injects every token before
//          first paint: a bare `var(--x)` inside a shorthand such as
//          `border: 1px solid var(--x)` makes the WHOLE declaration invalid when
//          `--x` is missing, so the border disappears rather than degrading.
//          That shipped once (see core/theme/__tests__/themeTokenParity.test.ts).
//          A fallback costs nothing and keeps a window that never loaded the
//          skin legible.
//
//          Every name here must be declared in core/theme/tokens.ts
//          (THEME_TOKENS) with a value in BOTH baselines; tokens.test.ts and
//          themeTokenParity.test.ts enforce that, and layoutThemeParity.test.ts
//          reads this file to check it too.

export const LT = {
  // ---- text / surfaces (existing tokens) ---------------------------------
  text: "var(--text-primary, #111827)",
  textSecondary: "var(--text-secondary, #6b7280)",
  textTertiary: "var(--text-tertiary, #888888)",
  surface: "var(--bg-surface, #ffffff)",
  panel: "var(--panel-bg, #f9fafb)",
  border: "var(--border-default, #d1d5db)",
  inputBg: "var(--input-bg, #ffffff)",

  // ---- interaction (existing tokens) ---------------------------------------
  buttonBg: "var(--button-bg, transparent)",
  hover: "var(--button-hover-bg, rgba(0, 0, 0, 0.06))",
  active: "var(--button-active-bg, rgba(0, 0, 0, 0.1))",
  pressed: "var(--button-pressed-bg, rgba(16, 185, 129, 0.14))",
  pressedBorder: "var(--button-pressed-border, rgba(16, 185, 129, 0.45))",
  menuHover: "var(--ctx-menu-item-hover-bg, rgba(0, 0, 0, 0.06))",

  // ---- state ----------------------------------------------------------------
  stateAccent: "var(--state-accent, #047857)",
  focusRing: "var(--focus-ring, 0 0 0 2px #ffffff, 0 0 0 4px #047857)",
  accentColor: "var(--accent-color, #1a5fb4)",

  // ---- shape + motion --------------------------------------------------------
  radiusControl: "var(--radius-control, 8px)",
  radiusCluster: "var(--radius-cluster, 12px)",
  radiusPopover: "var(--radius-popover, 12px)",
  radiusPill: "var(--radius-pill, 999px)",
  motionHover: "var(--motion-hover, 120ms cubic-bezier(0.2, 0, 0, 1))",
  motionPopover: "var(--motion-popover, 140ms cubic-bezier(0.2, 0, 0, 1))",
  motionPanel: "var(--motion-panel, 180ms cubic-bezier(0.2, 0, 0, 1))",

  // ---- elevation ------------------------------------------------------------
  shadowClusterHover: "var(--shadow-cluster-hover, 0 1px 2px rgba(16, 24, 40, 0.06))",
  shadowPopover:
    "var(--shadow-popover, 0 8px 24px rgba(16, 24, 40, 0.12), 0 1px 3px rgba(16, 24, 40, 0.08))",
  shadowToolbar: "var(--shadow-toolbar, 0 4px 16px rgba(16, 24, 40, 0.14))",
  shadowRaised: "var(--shadow-raised, 0 6px 16px rgba(16, 24, 40, 0.14))",

  // ---- ribbon surfaces ------------------------------------------------------
  ribbonFrame: "var(--ribbon-frame-bg, #f9fafb)",
  ribbonBand: "var(--ribbon-band-bg, #ffffff)",
  clusterBg: "var(--ribbon-cluster-bg, #f3f4f6)",
  clusterBorder: "var(--ribbon-cluster-border, #e5e7eb)",
  clusterBorderHover: "var(--ribbon-cluster-border-hover, #d1d5db)",
  groupLabel: "var(--ribbon-group-label-fg, #666d7a)",

  // ---- controls -------------------------------------------------------------
  controlBorder: "var(--control-border, #d1d5db)",
  controlDivider: "var(--control-divider, #e5e7eb)",
  controlTrack: "var(--control-track, #e5e7eb)",
  chipBg: "var(--chip-bg, #ffffff)",
  chipBorder: "var(--chip-border, #e5e7eb)",
  tooltipBg: "var(--tooltip-bg, #111827)",
  tooltipFg: "var(--tooltip-fg, #f9fafb)",
  kbdBg: "var(--kbd-bg, rgba(255, 255, 255, 0.16))",
  badgeBg: "var(--badge-bg, #1a5fb4)",
  badgeFg: "var(--badge-fg, #ffffff)",

  // ---- semantic tones (existing tokens) --------------------------------------
  dangerFg: "var(--tone-danger-fg, #b42318)",
  dangerBg: "var(--tone-danger-bg, #fef3f2)",
  warnFg: "var(--tone-warn-fg, #b54708)",
  warnBg: "var(--tone-warn-bg, #fffaeb)",
  okFg: "var(--tone-ok-fg, #067647)",
  okBg: "var(--tone-ok-bg, #ecfdf3)",
  infoFg: "var(--tone-info-fg, #175cd3)",
  infoBg: "var(--tone-info-bg, #eff8ff)",

  /** White tick / thumb on an accent-filled checkbox or switch. Not themable:
   *  it sits on --state-accent, which every skin keeps dark enough for it. */
  onAccent: "var(--badge-fg, #ffffff)",
} as const;

export type LayoutThemeKey = keyof typeof LT;
