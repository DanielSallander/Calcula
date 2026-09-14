//! FILENAME: app/extensions/_shared/dsl/pivotLayout/describeQuery/styles.ts
// PURPOSE: Every style object the describe-query panel uses, and the one
//          injected stylesheet inline styles cannot express.
// CONTEXT: `extensions/_shared` uses inline `React.CSSProperties` and NOT
//          styled-components — not one file here imports it — because a hashed
//          class name is unreachable from an E2E selector. What inline styles
//          genuinely cannot do (keyframes, `:focus-within`, `::placeholder`,
//          `prefers-reduced-motion`) goes in ONE id-guarded injected stylesheet,
//          which is the established pattern next door in `_shared/components`.
//
// THE TOKEN NAMES ARE THE POINT OF THIS FILE.
//
// The row this panel replaces read `--border-color`, `--input-bg`,
// `--success-color` and `--error-color`. NONE OF THE FOUR EXISTS — not in
// `THEME_TOKENS`, not in `defaultTheme`, not in `darkTheme`, not in any skin, and
// `src/index.css` declares no custom properties at all. Every one of them fell
// through to its hardcoded literal, so the row never followed the user's skin in
// its whole life; it just looked like it meant to. Worse, `DesignQueryEditor`
// wrote `border: "1px solid var(--border-color)"` with NO fallback, which
// resolves to an invalid shorthand and paints no border at all.
//
// So the names below are copied from `src/core/theme/tokens.ts` and each carries
// the light-theme value as its fallback. `_shared` cannot import `THEME_TOKENS`
// — `FACADE_IMPORT_PATTERNS` bans `@core` and `src/core/**` from everything under
// `extensions/`, whatever the element-type rule appears to allow — so the guard
// against the next phantom is a test that reads both files, not an import.

import type React from "react";
import { TOKENS } from "../../../lib/themeTokens";

/**
 * The shared token table, re-exported under the short name this file uses.
 *
 * One table for every shared surface rather than a copy per folder: a per-folder
 * copy is how `--border-color` and three siblings came to exist in the first
 * place, and `themeTokenParity.test.ts` can only guard one table.
 */
export const T = TOKENS;

const STYLE_ELEMENT_ID = "calcula-describe-query-styles";

/**
 * Inject the panel's stylesheet once per document.
 *
 * Id-guarded because five mounts can exist at once and React 18's StrictMode
 * runs effects twice in development; appending per mount would leave a stack of
 * identical sheets behind every closed dialog.
 *
 * EVERY ANIMATION IS TRANSFORM OR OPACITY ONLY. The grid behind these dialogs is
 * a canvas, and animating anything that triggers layout makes it visibly stutter
 * during a repaint. `prefers-reduced-motion` turns the lot off rather than
 * merely shortening it — a person who asked for no motion did not ask for
 * faster motion.
 */
export function ensureDescribeQueryStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ELEMENT_ID;
  el.textContent = `
@keyframes calcula-dq-rise {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: none; }
}
@keyframes calcula-dq-pulse {
  0%, 100% { opacity: 0.35; }
  50%      { opacity: 1; }
}
@keyframes calcula-dq-sweep {
  from { transform: translateX(-100%); }
  to   { transform: translateX(300%); }
}
.calcula-dq-turn { animation: calcula-dq-rise 180ms ease-out both; }
.calcula-dq-dot { animation: calcula-dq-pulse 1.1s ease-in-out infinite; }
.calcula-dq-dot:nth-child(2) { animation-delay: 0.15s; }
.calcula-dq-dot:nth-child(3) { animation-delay: 0.3s; }
.calcula-dq-sweep::after {
  content: "";
  position: absolute; inset: 0 auto 0 0; width: 33%;
  background: linear-gradient(90deg, transparent, ${T.accent}, transparent);
  opacity: 0.5;
  animation: calcula-dq-sweep 1.2s ease-in-out infinite;
}
.calcula-dq-composer:focus-within {
  border-color: ${T.inputBorderFocus};
  box-shadow: 0 0 0 3px color-mix(in srgb, ${T.inputBorderFocus} 18%, transparent);
}
.calcula-dq-input::placeholder { color: ${T.textSecondary}; opacity: 0.8; }
.calcula-dq-grip:hover { background: color-mix(in srgb, ${T.accent} 22%, transparent); }
@media (prefers-reduced-motion: reduce) {
  .calcula-dq-turn, .calcula-dq-dot, .calcula-dq-sweep::after { animation: none !important; }
  .calcula-dq-dot { opacity: 1; }
}
`;
  document.head.appendChild(el);
}

export const panel: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  marginBottom: 6,
  fontSize: 12,
  color: T.textPrimary,
};

export const transcript: React.CSSProperties = {
  overflowY: "auto",
  overflowX: "hidden",
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: "2px 1px",
};

export const turnBox: React.CSSProperties = {
  border: `1px solid ${T.border}`,
  borderRadius: 6,
  background: T.panelBg,
  padding: "6px 8px",
};

export const askLine: React.CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "baseline",
  fontWeight: 600,
  marginBottom: 4,
  wordBreak: "break-word",
};

export const meta: React.CSSProperties = {
  fontSize: 11,
  color: T.textSecondary,
  fontWeight: 400,
  whiteSpace: "nowrap",
};

export const note: React.CSSProperties = {
  fontSize: 11,
  color: T.textSecondary,
  margin: "4px 0 0",
  whiteSpace: "pre-wrap",
};

export const okNote: React.CSSProperties = { ...note, color: T.okFg };
export const badNote: React.CSSProperties = { ...note, color: T.dangerFg };

export const composer: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  border: `1px solid ${T.inputBorder}`,
  borderRadius: 8,
  background: T.inputBg,
  padding: 6,
  marginTop: 6,
  transition: "border-color 120ms ease, box-shadow 120ms ease",
};

export const textarea: React.CSSProperties = {
  border: "none",
  outline: "none",
  resize: "none",
  background: "transparent",
  color: "inherit",
  font: "inherit",
  fontSize: 12,
  lineHeight: "18px",
  padding: "2px 4px",
  maxHeight: 140,
  overflowY: "auto",
};

export const composerFooter: React.CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "center",
  justifyContent: "space-between",
  marginTop: 4,
};

export const primaryButton: React.CSSProperties = {
  padding: "5px 12px",
  fontSize: 12,
  borderRadius: 6,
  border: "none",
  background: T.accent,
  color: "#fff",
  cursor: "pointer",
  whiteSpace: "nowrap",
  transition: "opacity 120ms ease, transform 120ms ease",
};

export const quietButton: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 11,
  borderRadius: 6,
  border: `1px solid ${T.border}`,
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export const grip: React.CSSProperties = {
  height: 6,
  cursor: "ns-resize",
  borderRadius: 3,
  background: "transparent",
  flexShrink: 0,
  transition: "background 120ms ease",
};

export const diffBox: React.CSSProperties = {
  border: `1px solid ${T.border}`,
  borderRadius: 4,
  overflow: "hidden",
  marginTop: 4,
};

export const queryPre: React.CSSProperties = {
  margin: "4px 0 0",
  padding: "6px 8px",
  border: `1px solid ${T.border}`,
  borderRadius: 4,
  background: T.inputBg,
  fontFamily: "var(--font-family-cell, ui-monospace, Consolas, monospace)",
  fontSize: 11,
  lineHeight: "16px",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 160,
  overflow: "auto",
};
