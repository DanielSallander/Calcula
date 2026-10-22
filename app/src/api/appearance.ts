//! FILENAME: app/src/api/appearance.ts
// PURPOSE: Public API facade for the App Appearance / Skin system. Thin wrapper
//          over the Core skinLoader, plus the AppEvents bridge for extensions.
// CONTEXT: This is the ONLY surface extensions touch to read/set/contribute
//          skins. DISTINCT from api/theme.ts (Office-style Document Theme).

import * as skinLoader from "../core/theme/skinLoader";
import type { Skin, ThemeTokenName } from "../core/theme/skin";
import type { RibbonLabelMode } from "../core/theme/skinLoader";
import { AppEvents, emitAppEvent, onAppEvent } from "./events";
import { THEME_TOKENS } from "../core/theme/tokens";
import { defaultTheme } from "../core/theme/defaultTheme";
import { darkTheme } from "../core/theme/darkTheme";

export type {
  Skin,
  SkinBase,
  SkinDensity,
  SkinAssets,
  ThemeTokenName,
  AccessibilityOverride,
} from "../core/theme/skin";
export {
  LIGHT_SKIN_ID,
  DARK_SKIN_ID,
  SOFT_SKIN_ID,
  CONTRAST_SKIN_ID,
  BUILTIN_DEFAULT_SKIN_ID,
} from "../core/theme/builtInSkins";
export type { RibbonLabelMode } from "../core/theme/skinLoader";

/**
 * Payload emitted with AppEvents.APPEARANCE_CHANGED.
 *
 * `skinId` is always present (the active skin, even when it did not change),
 * so a listener that only cares about skins keeps working. The optional fields
 * say WHICH other preference moved, so a listener can ignore what it does not
 * render: `ribbonLabels` carries the new label mode, `userTokens` is `true`
 * when the user's token overrides were replaced.
 */
export interface AppearanceChangedPayload {
  skinId: string;
  ribbonLabels?: RibbonLabelMode;
  userTokens?: boolean;
}

/** All registered skins (built-ins + extension/org-contributed). */
export function listAvailableSkins(): Skin[] {
  return skinLoader.getRegisteredSkins();
}

/** The currently-active skin (falls back to Light if the active id is unknown). */
export function getActiveSkin(): Skin {
  return skinLoader.getActiveSkin();
}

/** The currently-active skin id (may name a not-yet-registered org/extension skin). */
export function getActiveSkinId(): string {
  return skinLoader.getActiveSkinId();
}

/**
 * Switch the active skin. Persists the choice, re-injects CSS variables, updates
 * the canvas GridTheme, and emits APPEARANCE_CHANGED for extensions. No-op for an
 * unknown id.
 */
export function setActiveSkin(id: string): void {
  skinLoader.setActiveSkin(id);
  emitAppEvent<AppearanceChangedPayload>(AppEvents.APPEARANCE_CHANGED, { skinId: id });
}

/**
 * Contribute a skin (dogfooding — built-in or third-party extensions call this in
 * their activate()). If the registered id is the active one, it re-applies.
 */
export function registerSkin(skin: Skin): void {
  skinLoader.registerSkin(skin);
}

/**
 * Whether the ribbon draws the caption under each group. "show" unless the
 * user chose "hide".
 */
export function getRibbonLabelMode(): RibbonLabelMode {
  return skinLoader.getRibbonLabelMode();
}

/**
 * Show or hide the ribbon group captions. `"show"` and `null` both return to
 * the factory state (the preference is removed, not stored). Stamps
 * `<html data-ribbon-labels>`, notifies appearance subscribers and emits
 * APPEARANCE_CHANGED with `{ skinId, ribbonLabels }`.
 */
export function setRibbonLabelMode(mode: RibbonLabelMode | null): void {
  skinLoader.setRibbonLabelMode(mode);
  emitAppEvent<AppearanceChangedPayload>(AppEvents.APPEARANCE_CHANGED, {
    skinId: skinLoader.getActiveSkinId(),
    ribbonLabels: skinLoader.getRibbonLabelMode(),
  });
}

/**
 * The user's own theme-token overrides, keyed by CSS name
 * (`{ "--state-accent": "#b91c1c" }`). Layered over the active skin and under
 * the accessibility transforms.
 */
export function getUserTokenOverrides(): Record<string, string> {
  return skinLoader.getUserTokenOverrides();
}

/**
 * REPLACE the user's token overrides and re-apply the active skin. Names that
 * are not declared theme tokens, and values that could break out of the
 * injected stylesheet, are dropped. `null` or `{}` clears them. Emits
 * APPEARANCE_CHANGED with `{ skinId, userTokens: true }`.
 */
export function setUserTokenOverrides(overrides: Record<string, string> | null): void {
  skinLoader.setUserTokenOverrides(overrides);
  emitAppEvent<AppearanceChangedPayload>(AppEvents.APPEARANCE_CHANGED, {
    skinId: skinLoader.getActiveSkinId(),
    userTokens: true,
  });
}

/**
 * Subscribe to appearance changes. Returns a cleanup function.
 *
 * Fires for EVERY APPEARANCE_CHANGED — including a ribbon-label or token-
 * override change, where the skin id it passes is unchanged. Re-reading the
 * skin on such a call is harmless; a caller that must distinguish should
 * listen to AppEvents.APPEARANCE_CHANGED and read the payload fields.
 */
export function onSkinChanged(cb: (skinId: string) => void): () => void {
  return onAppEvent<AppearanceChangedPayload>(AppEvents.APPEARANCE_CHANGED, (d) => cb(d.skinId));
}

/**
 * Subscribe directly to the loader (fires for ANY active-skin change, including
 * those not routed through setActiveSkin — e.g. late registerSkin re-apply).
 * Use for UI that must always reflect the active skin.
 */
export function subscribeToAppearance(cb: () => void): () => void {
  return skinLoader.subscribe(cb);
}

/** Merged token map for a skin — for building live-preview swatches. */
export function getSkinTokens(skin: Skin): Record<string, string> {
  return skinLoader.getMergedTokens(skin);
}

/** Merged GridTheme for a skin — for building live-preview swatches. */
export function getSkinGridTheme(skin: Skin) {
  return skinLoader.getMergedGridTheme(skin);
}

/**
 * The GridTheme the canvas is actually rendering with right now — includes
 * accessibility adjustments (high contrast, font scaling) on top of the
 * active skin. Use this (not getSkinGridTheme) to draw overlay chrome that
 * must match core-rendered gridlines and text.
 */
export function getActiveGridTheme() {
  return skinLoader.getActiveGridTheme();
}

// ============================================================================
// Semantic tones for CANVAS painters
// ============================================================================

/**
 * The semantic status colours (the `--tone-*` theme tokens) as concrete colour
 * strings, for code that paints on the grid canvas and therefore cannot use
 * `var(--tone-warn-fg)`. `*Fg` is the strong ink of a tone (a marker, an
 * outline); `*Bg` its quiet surface. Values follow the ACTIVE skin -- Dark
 * included -- with the user's token overrides and the accessibility transforms
 * applied, exactly as the chrome is painted. Re-read it inside each paint (it
 * is cached per skin apply, so the call is cheap); never keep a copy across
 * frames, or a skin switch leaves stale ink on the grid.
 */
export interface CanvasToneColors {
  warnFg: string;
  warnBg: string;
  dangerFg: string;
  dangerBg: string;
  infoFg: string;
  infoBg: string;
  okFg: string;
  okBg: string;
}

/** The light baseline, read only if a token is somehow absent from the active map. */
const baselineTone = (name: string): string => defaultTheme[name] ?? "";

/** A token's written value: the active map's, else the light baseline's, else "". */
function writtenTokenValue(tokens: Readonly<Record<string, string>>, name: string): string {
  const v = tokens[name];
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  return baselineTone(name).trim();
}

/** var() hops followed before giving up: a cycle ends here, never in a hang. */
const MAX_VAR_DEPTH = 8;

/**
 * `value` with every `var(--name)` / `var(--name, fallback)` replaced by what it
 * names in `tokens`, recursively; null when one cannot be resolved (a name with
 * no value and no fallback, a cycle, an unbalanced bracket).
 *
 * WHY. A canvas cannot read CSS variables: `ctx.strokeStyle = "var(--x)"` is
 * IGNORED (the previous colour stays) with no error. Several tokens are written
 * as references -- `--focus-ring-color: var(--state-accent)`, the
 * `color-mix(... var(--accent-primary) ...)` pressed states -- and a skin or a
 * user override may alias any token the same way, so the canvas route must
 * substitute them. Other CSS functions are left as written for the canvas to
 * parse itself.
 */
function substituteVars(
  value: string,
  tokens: Readonly<Record<string, string>>,
  depth: number,
): string | null {
  if (depth > MAX_VAR_DEPTH) return null;
  let out = "";
  let from = 0;
  for (;;) {
    const at = value.indexOf("var(", from);
    if (at < 0) return out + value.slice(from);
    out += value.slice(from, at);
    // The matching ")" and the first top-level comma (the fallback's start).
    let level = 0;
    let comma = -1;
    let close = -1;
    for (let i = at + 3; i < value.length; i++) {
      const ch = value[i];
      if (ch === "(") level++;
      else if (ch === ")") {
        level--;
        if (level === 0) {
          close = i;
          break;
        }
      } else if (ch === "," && level === 1 && comma < 0) comma = i;
    }
    if (close < 0) return null;
    const name = value.slice(at + 4, comma < 0 ? close : comma).trim();
    const fallback = comma < 0 ? "" : value.slice(comma + 1, close).trim();
    const named = name.startsWith("--") ? writtenTokenValue(tokens, name) : "";
    let replacement = named !== "" ? substituteVars(named, tokens, depth + 1) : null;
    if (replacement === null && fallback !== "") {
      replacement = substituteVars(fallback, tokens, depth + 1);
    }
    if (replacement === null) return null;
    out += replacement;
    from = close + 1;
  }
}

/**
 * One token as a colour string a canvas can paint with, in `tokens`; the light
 * baseline's (resolved against itself) when the active value cannot be
 * resolved; "" when neither can.
 */
function canvasColourOf(tokens: Readonly<Record<string, string>>, name: string): string {
  return (
    substituteVars(writtenTokenValue(tokens, name), tokens, 0) ??
    substituteVars(baselineTone(name).trim(), defaultTheme, 0) ??
    ""
  );
}

let toneCacheSource: Readonly<Record<string, string>> | null = null;
let toneCache: CanvasToneColors | null = null;

/** The eight tone colours of one token map, as canvas colours. */
function toneColorsOf(tokens: Readonly<Record<string, string>>): CanvasToneColors {
  const pick = (name: string): string => canvasColourOf(tokens, name);
  return Object.freeze({
    warnFg: pick(THEME_TOKENS.TONE_WARN_FG),
    warnBg: pick(THEME_TOKENS.TONE_WARN_BG),
    dangerFg: pick(THEME_TOKENS.TONE_DANGER_FG),
    dangerBg: pick(THEME_TOKENS.TONE_DANGER_BG),
    infoFg: pick(THEME_TOKENS.TONE_INFO_FG),
    infoBg: pick(THEME_TOKENS.TONE_INFO_BG),
    okFg: pick(THEME_TOKENS.TONE_OK_FG),
    okBg: pick(THEME_TOKENS.TONE_OK_BG),
  });
}

export function getCanvasToneColors(): CanvasToneColors {
  const tokens = skinLoader.getActiveTokens();
  if (toneCache && tokens === toneCacheSource) return toneCache;
  toneCache = toneColorsOf(tokens);
  toneCacheSource = tokens;
  return toneCache;
}

const baselineToneCache = new Map<"light" | "dark", CanvasToneColors>();

/**
 * The tone colours of a built-in BASELINE -- the Light or the Dark ground's own
 * values, before any skin, user override or accessibility transform -- as
 * canvas colours. For a canvas painter that draws a status ink on a cell FILL:
 * the active skin's tones ({@link getCanvasToneColors}) are made for the skin's
 * own cell background, so on an explicit fill of the opposite lightness (a dark
 * fill under the Light skin, a light one under Dark) the other ground's ink is
 * the readable one. The baselines never change at run time, so this is cached
 * for good.
 */
export function getBaselineToneColors(base: "light" | "dark"): CanvasToneColors {
  const cached = baselineToneCache.get(base);
  if (cached) return cached;
  const tones = toneColorsOf(base === "dark" ? darkTheme : defaultTheme);
  baselineToneCache.set(base, tones);
  return tones;
}

// ============================================================================
// Any theme token, for CANVAS painters
// ============================================================================

let themeColourSource: Readonly<Record<string, string>> | null = null;
const themeColourCache = new Map<string, string>();

/**
 * ONE theme token (`"--tab-accent-writeback"`, `"--grid-line"`, ...) as a
 * concrete colour string for code that paints on a canvas and therefore cannot
 * use `var(--token)`. The generic sibling of {@link getCanvasToneColors}, for a
 * painter whose colour is not a status tone -- e.g. a grid mark that should
 * read as belonging to a contextual ribbon tab paints in that tab's accent.
 *
 * Same contract as the tones: the value follows the ACTIVE skin (Dark
 * included), the user's token overrides and the accessibility transforms,
 * exactly as the chrome is painted; a token absent from the active map falls
 * back to the light baseline. A value written as a reference
 * (`var(--state-accent)`, also inside `color-mix(...)`) is resolved against
 * the same map, because a canvas silently ignores a `var()` it is handed; a
 * reference that cannot be resolved (a cycle, an unknown name with no
 * fallback) takes the baseline's value. Other CSS colour syntax is returned as
 * written for the canvas to parse -- but `currentColor` means nothing on a
 * canvas, so read a token whose value is a colour.
 *
 * Re-read it inside each paint: it is cached per applied token set (a skin
 * switch, an override or an accessibility change starts a new one), so the
 * call is a map lookup; never keep a copy across frames.
 */
export function getCanvasThemeColor(token: ThemeTokenName): string {
  const tokens = skinLoader.getActiveTokens();
  if (tokens !== themeColourSource) {
    themeColourCache.clear();
    themeColourSource = tokens;
  }
  const cached = themeColourCache.get(token);
  if (cached !== undefined) return cached;
  const colour = canvasColourOf(tokens, token);
  themeColourCache.set(token, colour);
  return colour;
}
