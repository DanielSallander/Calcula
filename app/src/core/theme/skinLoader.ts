//! FILENAME: app/src/core/theme/skinLoader.ts
// PURPOSE: Runtime theme loader for the App Skin system. Holds the active skin,
//          computes the merged token map + merged GridTheme, injects/updates the
//          :root CSS variables imperatively (live, no React remount), exposes the
//          active GridTheme to the canvas, and notifies subscribers on change.
//          Also owns the two app-global appearance preferences that ride on the
//          same apply/notify cycle: the ribbon group-label mode and the user's
//          own token overrides.
// CONTEXT: Core/pure. Replaces ThemeRoot's static injection. Imports only Core
//          token/grid concepts — never shell/api/extensions. The API facade
//          (api/appearance.ts) bridges this to the AppEvents bus + extensions.
//
//          THE MERGE ORDER, lowest to highest precedence:
//            baseline (light/dark) -> skin tokens -> density/font
//              -> user token overrides -> accessibility transforms
//          The user beats the skin because it is their machine; accessibility
//          beats the user because it is the one layer that must never be
//          defeated by a preference someone set and forgot.

import { THEME_TOKENS } from "./tokens";
import { pointsToPixels } from "../lib/gridRenderer/fonts";
import { defaultTheme } from "./defaultTheme";
import { darkTheme } from "./darkTheme";
import { DEFAULT_THEME, type GridTheme } from "../lib/gridRenderer/types";
import { DARK_GRID_THEME } from "./darkGridTheme";
import { BUILTIN_SKINS, BUILTIN_DEFAULT_SKIN_ID, lightSkin } from "./builtInSkins";
import type { AccessibilityOverride, Skin, SkinBase, SkinDensity } from "./skin";

/** localStorage key for the user's chosen skin id (app-global, read at boot). */
export const SKIN_STORAGE_KEY = "calcula.appearance.skinId";

/**
 * localStorage key for the ribbon group-label preference.
 *
 * Holds the literal `"hide"` or is ABSENT. "show" is never written: absent is
 * the factory state, and the E2E residue guard (e2e/volatilePersistedState.ts)
 * treats an absent key as clean — so turning labels back on must leave the
 * storage exactly as a fresh install has it, not holding a value that merely
 * happens to mean the default.
 */
export const RIBBON_LABELS_STORAGE_KEY = "calcula.appearance.ribbonLabels";

/**
 * localStorage key for the user's own token overrides: a JSON object of
 * `{ "--token-name": "value" }`. Absent when there are none (same reasoning as
 * the label key — an empty override set is removed, never stored as `{}`).
 */
export const USER_TOKENS_STORAGE_KEY = "calcula.appearance.userTokens";

/** Whether the ribbon draws the caption under each group (cluster). */
export type RibbonLabelMode = "show" | "hide";

/** Id of the persistent <style> element holding the injected CSS variables. */
const STYLE_EL_ID = "calcula-skin-vars";

/** Cell font-size (POINTS) per density preset. Feeds the grid cellFontSize
 *  directly; the CSS --font-size-cell token is the px equivalent (see cellSizeToken). */
const DENSITY_FONT_SIZE: Record<SkinDensity, number> = {
  comfortable: 13,
  compact: 11,
};

/** Build the --font-size-cell token (CSS px) from a point size, so the DOM
 *  editor overlay matches the canvas (which converts the same points to px). */
function cellSizeToken(points: number): string {
  return `${pointsToPixels(points)}px`;
}

const TOKEN_BASELINES: Record<SkinBase, Record<string, string>> = {
  light: defaultTheme,
  dark: darkTheme,
};

const GRID_BASELINES: Record<SkinBase, GridTheme> = {
  light: DEFAULT_THEME,
  dark: DARK_GRID_THEME,
};

// --- Module-singleton state ----------------------------------------------------

const registry = new Map<string, Skin>();
const subscribers = new Set<() => void>();
let activeSkinId = BUILTIN_DEFAULT_SKIN_ID;
let cachedGridTheme: GridTheme = DEFAULT_THEME;
let styleEl: HTMLStyleElement | null = null;
let initialized = false;
let a11y: AccessibilityOverride = {};
/**
 * In-memory copies of the two preferences. `null` = not read from storage yet.
 * Held in memory (not re-read on every apply) so that a choice still takes
 * effect for the session when storage refuses the write — a private window,
 * a full quota — instead of silently reverting on the next skin change.
 */
let ribbonLabelMode: RibbonLabelMode | null = null;
let userTokens: Record<string, string> | null = null;

// --- Persistence (direct localStorage, app-global like calcula.locale) ---------

function readPersistedId(): string | null {
  return readKey(SKIN_STORAGE_KEY);
}

function persistId(id: string): void {
  writeKey(SKIN_STORAGE_KEY, id);
}

/** Read one raw key; null when absent OR when storage is unavailable. */
function readKey(key: string): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

/** Write one raw key, or remove it when `value` is null. Never throws. */
function writeKey(key: string, value: string | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — the in-memory copy still carries the session */
  }
}

// --- User token overrides: what is allowed in ----------------------------------

/** Every token name the theme declares; an override for anything else is dropped. */
const KNOWN_TOKENS: ReadonlySet<string> = new Set(Object.values(THEME_TOKENS));

/**
 * CSS functions a token value may call. Every token in the theme is a colour,
 * a length, a shadow, a timing or a font stack, and these are the functions
 * those are written with. Notably ABSENT: `url()`, `image-set()` and friends —
 * a custom property is inert until something paints with it, and the first
 * `background: var(--x)` would then FETCH whatever the value named.
 */
const ALLOWED_VALUE_FUNCTIONS: ReadonlySet<string> = new Set([
  "rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color",
  "color-mix", "var", "calc", "min", "max", "clamp", "cubic-bezier", "steps",
]);

/** Characters that end a declaration, a rule or the <style> element, or escape. */
const STRUCTURAL_CHARS: ReadonlySet<string> = new Set([";", "{", "}", "<", ">", "\\", "!", "@", "`"]);

/**
 * True when `value` is safe to write into the injected `:root { ... }` rule.
 *
 * NOT a nicety. `injectTokens` builds the stylesheet as TEXT, one line, every
 * token in sequence — and the accessibility tokens are in that same line. A
 * value that closes the rule (`}`), ends the declaration early (`;`), opens a
 * comment (`/*`), or leaves a parenthesis or a quote open swallows every
 * declaration after it, which would let a stored override silently defeat
 * High contrast. So the check is structural: a conservative character set,
 * balanced brackets and quotes, and only the functions listed above.
 */
function isSafeTokenValue(value: string): boolean {
  if (value.trim().length === 0 || value.length > 256) return false;
  if (value.includes("/*") || value.includes("*/")) return false;

  let depth = 0;
  let quote: string | null = null;
  for (const ch of value) {
    // Control characters (a newline ends an unterminated CSS string early and
    // the parser recovers somewhere unpredictable) and every character with a
    // structural meaning in a stylesheet or in the <style> element around it.
    // Rejected even inside quotes: no font name needs them.
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || STRUCTURAL_CHARS.has(ch)) return false;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return false;
  }
  if (quote !== null || depth !== 0) return false;

  for (const m of value.matchAll(/([a-z_][a-z0-9_-]*)\s*\(/gi)) {
    if (!ALLOWED_VALUE_FUNCTIONS.has(m[1].toLowerCase())) return false;
  }
  return true;
}

/**
 * Keep only entries whose key is a declared theme token and whose value is a
 * safe string. Applied on the way IN (the setter) and on the way OUT of
 * storage, because storage is writable by anything running in the page.
 */
function sanitizeUserTokens(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (KNOWN_TOKENS.has(k) && typeof v === "string" && isSafeTokenValue(v)) out[k] = v;
  }
  return out;
}

function readPersistedUserTokens(): Record<string, string> {
  const raw = readKey(USER_TOKENS_STORAGE_KEY);
  if (raw === null) return {};
  try {
    return sanitizeUserTokens(JSON.parse(raw));
  } catch {
    return {}; // unparseable — treated as no overrides, never as a crash at boot
  }
}

function currentUserTokens(): Record<string, string> {
  if (userTokens === null) userTokens = readPersistedUserTokens();
  return userTokens;
}

function currentRibbonLabelMode(): RibbonLabelMode {
  if (ribbonLabelMode === null) {
    // Anything but the one written value reads as the default; an unknown
    // string from an older or newer build must not hide the captions.
    ribbonLabelMode = readKey(RIBBON_LABELS_STORAGE_KEY) === "hide" ? "hide" : "show";
  }
  return ribbonLabelMode;
}

/** Stamp the label mode on <html> so CSS and the ribbon can both key off it. */
function stampRibbonLabelMode(): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.ribbonLabels = currentRibbonLabelMode();
}

// --- Merge (pure) --------------------------------------------------------------

/** Compute the full merged token map for a skin: baseline -> tokens -> density/font. */
export function getMergedTokens(skin: Skin): Record<string, string> {
  const merged: Record<string, string> = { ...TOKEN_BASELINES[skin.base], ...(skin.tokens ?? {}) };
  if (skin.density) merged[THEME_TOKENS.FONT_SIZE_CELL] = cellSizeToken(DENSITY_FONT_SIZE[skin.density]);
  if (skin.fontFamily) {
    merged[THEME_TOKENS.FONT_FAMILY_SANS] = skin.fontFamily;
    // Keep the editor overlay font in lockstep with the grid cell font.
    merged[THEME_TOKENS.FONT_FAMILY_CELL] = skin.fontFamily;
  }
  return merged;
}

/** Compute the full merged GridTheme for a skin: baseline -> grid -> density/font. */
export function getMergedGridTheme(skin: Skin): GridTheme {
  const merged: GridTheme = { ...GRID_BASELINES[skin.base], ...(skin.grid ?? {}) };
  if (skin.fontFamily) merged.cellFontFamily = skin.fontFamily;
  if (skin.density) merged.cellFontSize = DENSITY_FONT_SIZE[skin.density];
  return merged;
}

// --- DOM injection (imperative, no remount) ------------------------------------

function ensureStyleEl(): HTMLStyleElement | null {
  if (typeof document === "undefined") return null;
  if (styleEl && styleEl.isConnected) return styleEl;
  let el = document.getElementById(STYLE_EL_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_EL_ID;
    document.head.appendChild(el);
  }
  styleEl = el;
  return el;
}

function injectTokens(tokens: Record<string, string>): void {
  const el = ensureStyleEl();
  if (!el) return;
  const body = Object.entries(tokens)
    .map(([k, v]) => `${k}: ${v};`)
    .join(" ");
  el.textContent = `:root { ${body} }`;
}

// --- Accessibility transforms (always applied last; never suppressible) --------

/**
 * High-contrast token/grid deltas per effective base.
 *
 * The Clusters rows (cluster edge on hover, control edges, group captions, the
 * soft icon channel, activity-bar glyphs, the tab indicator) exist because the
 * redesign moved chrome OFF the tokens this table already strengthened. A
 * control edge used to be BORDER_DEFAULT, which High contrast blackens; it is
 * now CONTROL_BORDER, and without a row here High contrast would have left
 * every control in the ribbon at a pale grey edge. The soft icon channel gets
 * a SOLID mid-grey rather than a darker tint: a 30% tint of black-on-white is
 * the one ground High contrast must not leave translucent.
 */
const HIGH_CONTRAST: Record<SkinBase, { tokens: Record<string, string>; grid: Partial<GridTheme> }> = {
  light: {
    tokens: {
      [THEME_TOKENS.TEXT_PRIMARY]: "#000000",
      [THEME_TOKENS.TEXT_SECONDARY]: "#1a1a1a",
      [THEME_TOKENS.GRID_TEXT]: "#000000",
      [THEME_TOKENS.GRID_LINE]: "#000000",
      [THEME_TOKENS.BORDER_DEFAULT]: "#000000",
      [THEME_TOKENS.GRID_HEADER_TEXT]: "#000000",
      [THEME_TOKENS.RIBBON_CLUSTER_BORDER_HOVER]: "#000000",
      [THEME_TOKENS.CONTROL_BORDER]: "#000000",
      [THEME_TOKENS.RIBBON_GROUP_LABEL_FG]: "#1a1a1a",
      [THEME_TOKENS.ICON_FILL_SOFT]: "#767676",
      [THEME_TOKENS.ACTIVITY_BAR_FG]: "#000000",
      [THEME_TOKENS.RIBBON_TAB_INDICATOR]: "#000000",
    },
    grid: { cellText: "#000000", cellTextNumber: "#000000", gridLine: "#7a7a7a", headerText: "#000000" },
  },
  dark: {
    tokens: {
      [THEME_TOKENS.TEXT_PRIMARY]: "#ffffff",
      [THEME_TOKENS.TEXT_SECONDARY]: "#e8e8e8",
      [THEME_TOKENS.GRID_TEXT]: "#ffffff",
      [THEME_TOKENS.GRID_LINE]: "#ffffff",
      [THEME_TOKENS.BORDER_DEFAULT]: "#ffffff",
      [THEME_TOKENS.GRID_HEADER_TEXT]: "#ffffff",
      [THEME_TOKENS.RIBBON_CLUSTER_BORDER_HOVER]: "#ffffff",
      [THEME_TOKENS.CONTROL_BORDER]: "#ffffff",
      [THEME_TOKENS.RIBBON_GROUP_LABEL_FG]: "#e8e8e8",
      [THEME_TOKENS.ICON_FILL_SOFT]: "#9d9d9d",
      [THEME_TOKENS.ACTIVITY_BAR_FG]: "#ffffff",
      [THEME_TOKENS.RIBBON_TAB_INDICATOR]: "#ffffff",
    },
    grid: { cellText: "#ffffff", cellTextNumber: "#ffffff", gridLine: "#8a8a8a", headerText: "#ffffff" },
  },
};

/**
 * Apply the active accessibility override on top of an already-merged
 * (tokens, grid). Returns possibly-new objects. Pure aside from `a11y` read.
 *
 * `tokens` arrives with the user's token overrides already merged in, so every
 * transform here beats them. `forcedBase` goes further and DISCARDS them along
 * with the skin's deltas: an override is authored against the base it was
 * chosen on, and a light-base colour laid over a forced dark base is exactly
 * the light-on-light result forcedBase exists to prevent.
 */
function applyAccessibility(
  skin: Skin,
  tokens: Record<string, string>,
  grid: GridTheme
): { tokens: Record<string, string>; grid: GridTheme } {
  const o = a11y;
  if (!o.forcedBase && !o.highContrast && !o.minFontScale) return { tokens, grid };

  let outTokens = tokens;
  let outGrid = grid;

  // forcedBase: re-derive from the forced baseline (ignores the skin's color
  // deltas — a deliberate, strong legibility action), then re-apply density/font.
  if (o.forcedBase && o.forcedBase !== skin.base) {
    outTokens = { ...TOKEN_BASELINES[o.forcedBase] };
    outGrid = { ...GRID_BASELINES[o.forcedBase] };
    if (skin.density) {
      outTokens[THEME_TOKENS.FONT_SIZE_CELL] = cellSizeToken(DENSITY_FONT_SIZE[skin.density]);
      outGrid.cellFontSize = DENSITY_FONT_SIZE[skin.density];
    }
    if (skin.fontFamily) {
      outTokens[THEME_TOKENS.FONT_FAMILY_SANS] = skin.fontFamily;
      outTokens[THEME_TOKENS.FONT_FAMILY_CELL] = skin.fontFamily;
      outGrid.cellFontFamily = skin.fontFamily;
    }
  } else {
    outTokens = { ...tokens };
    outGrid = { ...grid };
  }

  const effectiveBase: SkinBase = o.forcedBase ?? skin.base;

  if (o.highContrast) {
    Object.assign(outTokens, HIGH_CONTRAST[effectiveBase].tokens);
    Object.assign(outGrid, HIGH_CONTRAST[effectiveBase].grid);
  }

  if (o.minFontScale && o.minFontScale > 1) {
    const scaled = Math.round(outGrid.cellFontSize * o.minFontScale);
    if (scaled > outGrid.cellFontSize) {
      outGrid.cellFontSize = scaled;
      outTokens[THEME_TOKENS.FONT_SIZE_CELL] = cellSizeToken(scaled);
    }
  }

  return { tokens: outTokens, grid: outGrid };
}

// --- Apply + notify ------------------------------------------------------------

function apply(skin: Skin): void {
  // User overrides sit AFTER the skin (and its density/font) and BEFORE
  // accessibility — see the merge order in the header.
  const withUser = { ...getMergedTokens(skin), ...currentUserTokens() };
  const merged = applyAccessibility(skin, withUser, getMergedGridTheme(skin));
  injectTokens(merged.tokens);
  cachedGridTheme = merged.grid;
  if (typeof document !== "undefined") {
    // Read by GridCanvas (marching ants) AND by the global rule in
    // src/index.css that collapses every CSS transition and animation.
    document.documentElement.dataset.reducedMotion = a11y.reducedMotion ? "true" : "false";
  }
  stampRibbonLabelMode();
  notify();
}

function notify(): void {
  subscribers.forEach((cb) => cb());
}

// --- Public API ----------------------------------------------------------------

/**
 * Register a skin (built-in or extension/org-contributed). If the registered
 * skin's id is the currently-active one (e.g. it was the persisted id but had
 * not loaded yet at boot), re-apply it now with its correct base/values.
 */
export function registerSkin(skin: Skin): void {
  registry.set(skin.id, skin);
  if (initialized && skin.id === activeSkinId) {
    apply(skin);
  }
}

export function getRegisteredSkins(): Skin[] {
  return Array.from(registry.values());
}

export function getSkin(id: string): Skin | undefined {
  return registry.get(id);
}

export function getActiveSkinId(): string {
  return activeSkinId;
}

export function getActiveSkin(): Skin {
  return registry.get(activeSkinId) ?? lightSkin;
}

/**
 * Switch the active skin. No-op for an unknown id (keeps the current skin).
 * @param opts.persist When true (default) records this as the user's explicit
 *        choice in localStorage. The enterprise resolver applies the org default
 *        with persist:false so it never masquerades as a user choice.
 */
export function setActiveSkin(id: string, opts?: { persist?: boolean }): void {
  const skin = registry.get(id);
  if (!skin) return;
  activeSkinId = id;
  if (opts?.persist ?? true) persistId(id);
  apply(skin);
}

/** True if the user has explicitly chosen a skin (vs. running a default). */
export function hasUserChosenSkin(): boolean {
  return readPersistedId() !== null;
}

/** Clear the user's explicit choice (revert to default/policy on next boot). */
export function clearUserSkinChoice(): void {
  writeKey(SKIN_STORAGE_KEY, null);
}

/** Set the accessibility override and immediately re-apply the active skin. */
export function setAccessibility(override: AccessibilityOverride): void {
  a11y = override ?? {};
  apply(getActiveSkin());
}

/** Current accessibility override. */
export function getAccessibility(): AccessibilityOverride {
  return a11y;
}

/** Current merged GridTheme. Stable reference until the active skin changes. */
export function getActiveGridTheme(): GridTheme {
  return cachedGridTheme;
}

// --- Ribbon group-label preference ---------------------------------------------

/** The current ribbon group-label mode. Absent or unrecognised storage = "show". */
export function getRibbonLabelMode(): RibbonLabelMode {
  return currentRibbonLabelMode();
}

/**
 * Set the ribbon group-label mode. `"hide"` is persisted; `"show"` and `null`
 * both REMOVE the key, so the default state is byte-identical to a fresh
 * install. Stamps `<html data-ribbon-labels>` and notifies subscribers; no
 * tokens change, so nothing is re-injected.
 */
export function setRibbonLabelMode(mode: RibbonLabelMode | null): void {
  const next: RibbonLabelMode = mode === "hide" ? "hide" : "show";
  ribbonLabelMode = next;
  writeKey(RIBBON_LABELS_STORAGE_KEY, next === "hide" ? "hide" : null);
  stampRibbonLabelMode();
  notify();
}

// --- User token overrides ------------------------------------------------------

/**
 * The user's own token overrides (a copy). Only declared theme tokens with
 * safe string values survive — see `sanitizeUserTokens`.
 */
export function getUserTokenOverrides(): Record<string, string> {
  return { ...currentUserTokens() };
}

/**
 * REPLACE the user's token overrides with `overrides` and re-apply the active
 * skin. Not a merge: the caller (a settings UI) holds the whole set, and a
 * merge would make removing one override impossible without a second API.
 *
 * Unknown token names and unsafe values are dropped silently; `null`, `{}`, or
 * a map in which nothing survives sanitising REMOVES the storage key.
 */
export function setUserTokenOverrides(overrides: Record<string, string> | null): void {
  const clean = sanitizeUserTokens(overrides);
  userTokens = clean;
  writeKey(
    USER_TOKENS_STORAGE_KEY,
    Object.keys(clean).length === 0 ? null : JSON.stringify(clean),
  );
  apply(getActiveSkin());
}

/** Subscribe to active-skin changes (used by the canvas + Appearance UI). */
export function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/**
 * Initialize the loader: register built-ins, read the persisted skin id
 * synchronously, and inject its CSS variables BEFORE first paint (FOUC-free).
 *
 * @param preferredId Optional id to apply instead of the persisted one (used by
 *        the enterprise resolver to seed the org default before the user has
 *        chosen). The persisted user choice still wins if present.
 */
export function initSkinLoader(preferredId?: string): void {
  if (initialized) return;
  initialized = true;

  for (const s of BUILTIN_SKINS) registry.set(s.id, s);

  const id = readPersistedId() ?? preferredId ?? BUILTIN_DEFAULT_SKIN_ID;
  const skin = registry.get(id);

  if (skin) {
    activeSkinId = id;
    apply(skin);
    return;
  }

  // Persisted/preferred id belongs to a not-yet-registered skin (extension or
  // org skin loaded later). Keep it active so registerSkin re-applies, but show
  // the light baseline now to avoid a wrong-base flash.
  activeSkinId = id;
  apply(lightSkin);
}

/** Test-only: reset module state so each test starts clean. */
export function __resetSkinLoaderForTests(): void {
  registry.clear();
  subscribers.clear();
  activeSkinId = BUILTIN_DEFAULT_SKIN_ID;
  cachedGridTheme = DEFAULT_THEME;
  initialized = false;
  a11y = {};
  ribbonLabelMode = null;
  userTokens = null;
  if (styleEl && styleEl.isConnected) styleEl.remove();
  styleEl = null;
  if (typeof document !== "undefined") delete document.documentElement.dataset.ribbonLabels;
}
