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
  textTertiary: "var(--text-tertiary, #9ca3af)",
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
  monoFont: "var(--font-family-cell, ui-monospace, Consolas, monospace)",
} as const;

/** The bare custom-property names, for the parity guard to check. */
export const TOKEN_NAMES: readonly string[] = Object.values(TOKENS)
  .map((v) => /var\((--[a-z0-9-]+)/i.exec(v)?.[1] ?? "")
  .filter((n) => n !== "");
