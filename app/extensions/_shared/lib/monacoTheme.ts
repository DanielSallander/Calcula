// FILENAME: app/extensions/_shared/lib/monacoTheme.ts
// PURPOSE: Give every Monaco editor in the Model Editor a theme that follows
//          the app skin.
// CONTEXT: A repo-wide grep for `defineTheme` and `theme:` found NOTHING in
//          this extension — all five Monaco mounts (ExpressionWorkspace,
//          ExpressionEditorModal, SqlEditorModal, transform/FormulaField,
//          transform/ScriptPane) ran the stock light "vs" theme. That was
//          invisible while the window was permanently light. The moment the
//          window started following the skin it became the loudest possible
//          bug: a brilliant white code editor in the middle of a dark dialog.
//
//          Monaco CANNOT read CSS custom properties — its theme wants real
//          colour values — so this resolves the `--me-*` layer against the live
//          document and re-resolves whenever the skin changes.

import type { Monaco } from "@monaco-editor/react";
// ONE definition of "is the surface dark", in _shared so BOTH command panels
// and the Model Editor share it.
import { surfaceIsDark } from "./surfaceTheme";

export const ME_THEME_LIGHT = "calcula-light";
export const ME_THEME_DARK = "calcula-dark";

/** Read a CSS custom property off the document, with a fallback. */
function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Monaco rejects a theme whose colours are not `#rgb`/`#rrggbb`/`#rrggbbaa`,
 * and throws hard enough to blank the editor. Skin values are plain hex today,
 * but a skin is user-authorable — one `rgb(...)` would take the editor down —
 * so anything unparseable falls back rather than being handed over.
 */
function hexOr(value: string, fallback: string): string {
  return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) ? value : fallback;
}

function palette(): Record<string, string> {
  const dark = surfaceIsDark();
  return {
    bg: hexOr(cssVar("--dialog-input-bg", dark ? "#1e1e1e" : "#ffffff"), dark ? "#1e1e1e" : "#ffffff"),
    fg: hexOr(cssVar("--text-primary", dark ? "#e0e0e0" : "#101828"), dark ? "#e0e0e0" : "#101828"),
    line: hexOr(cssVar("--text-tertiary", dark ? "#6b7280" : "#98a2b3"), dark ? "#6b7280" : "#98a2b3"),
    sel: hexOr(cssVar("--grid-selection-bg", dark ? "#264f78" : "#cfe3ff"), dark ? "#264f78" : "#cfe3ff"),
    border: hexOr(cssVar("--border-default", dark ? "#3a3a3a" : "#e4e7ec"), dark ? "#3a3a3a" : "#e4e7ec"),
  };
}

/** Register both themes. Idempotent — Monaco tolerates redefinition, and this
 *  is how a skin change is applied (redefine, then re-set the active theme). */
export function defineModelEditorThemes(monaco: Monaco): void {
  const p = palette();
  const common = {
    "editor.background": p.bg,
    "editor.foreground": p.fg,
    "editorLineNumber.foreground": p.line,
    "editorLineNumber.activeForeground": p.fg,
    "editor.selectionBackground": p.sel,
    "editorWidget.background": p.bg,
    "editorWidget.border": p.border,
    "editorSuggestWidget.background": p.bg,
    "editorSuggestWidget.border": p.border,
    "editorHoverWidget.background": p.bg,
    "editorHoverWidget.border": p.border,
    "input.background": p.bg,
    "dropdown.background": p.bg,
  };
  monaco.editor.defineTheme(ME_THEME_LIGHT, {
    base: "vs",
    inherit: true,
    rules: [],
    colors: common,
  });
  monaco.editor.defineTheme(ME_THEME_DARK, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: common,
  });
}

/** The theme name matching the current skin. */
export function activeModelEditorTheme(): string {
  return surfaceIsDark() ? ME_THEME_DARK : ME_THEME_LIGHT;
}

/**
 * Call from a Monaco `onMount`. Defines the themes, applies the right one, and
 * keeps it in step with later skin changes.
 *
 * Returns a disposer. Monaco's theme is GLOBAL, not per-editor, so several
 * mounted editors each register an observer and each call setTheme with the
 * same value — harmless, and far simpler than a shared singleton whose
 * lifetime would have to outlive whichever editor happened to mount first.
 */
export function applyModelEditorTheme(monaco: Monaco): () => void {
  const sync = (): void => {
    defineModelEditorThemes(monaco);
    monaco.editor.setTheme(activeModelEditorTheme());
  };
  sync();

  // The skin loader replaces the contents of ONE persistent <style> element, so
  // a mutation observer on <head> sees every skin change without this module
  // needing to import Core (an extension may not) or invent an event.
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  const observer = new MutationObserver(sync);
  const target = document.getElementById("calcula-skin-vars") ?? document.head;
  observer.observe(target, { childList: true, characterData: true, subtree: true });
  return () => observer.disconnect();
}
