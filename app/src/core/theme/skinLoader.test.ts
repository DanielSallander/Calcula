//! FILENAME: app/src/core/theme/skinLoader.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { THEME_TOKENS } from "./tokens";
import { defaultTheme } from "./defaultTheme";
import { DEFAULT_THEME } from "../lib/gridRenderer/types";
import type { Skin } from "./skin";
import {
  __resetSkinLoaderForTests,
  initSkinLoader,
  registerSkin,
  setActiveSkin,
  getActiveSkin,
  getActiveSkinId,
  getActiveGridTheme,
  getMergedTokens,
  getMergedGridTheme,
  subscribe,
  hasUserChosenSkin,
  setAccessibility,
  SKIN_STORAGE_KEY,
  RIBBON_LABELS_STORAGE_KEY,
  USER_TOKENS_STORAGE_KEY,
  getRibbonLabelMode,
  setRibbonLabelMode,
  getUserTokenOverrides,
  setUserTokenOverrides,
  getRegisteredSkins,
} from "./skinLoader";
import {
  LIGHT_SKIN_ID,
  DARK_SKIN_ID,
  SOFT_SKIN_ID,
  CONTRAST_SKIN_ID,
  BUILTIN_SKINS,
  lightSkin,
  softSkin,
  contrastSkin,
} from "./builtInSkins";
import { contrast } from "./__tests__/wcag";

/** The value a token was actually INJECTED with — what the page will paint. */
function injected(token: string): string | undefined {
  const text = document.getElementById("calcula-skin-vars")?.textContent ?? "";
  const escaped = token.replace(/[-]/g, "\\-");
  return new RegExp(`(?:^|[\\s{])${escaped}:\\s*([^;]*);`).exec(text)?.[1];
}

beforeEach(() => {
  __resetSkinLoaderForTests();
  localStorage.clear();
});

describe("skinLoader merge", () => {
  it("light skin merges to the light baseline", () => {
    const tokens = getMergedTokens(lightSkin);
    expect(tokens[THEME_TOKENS.GRID_BG]).toBe(defaultTheme[THEME_TOKENS.GRID_BG]);
  });

  it("token deltas override the baseline", () => {
    const skin: Skin = { id: "x", name: "X", base: "light", tokens: { [THEME_TOKENS.ACCENT_PRIMARY]: "#ff6600" } };
    const tokens = getMergedTokens(skin);
    expect(tokens[THEME_TOKENS.ACCENT_PRIMARY]).toBe("#ff6600");
    // untouched tokens still come from the baseline
    expect(tokens[THEME_TOKENS.GRID_BG]).toBe(defaultTheme[THEME_TOKENS.GRID_BG]);
  });

  it("density maps to the cell font-size token AND the grid cellFontSize", () => {
    const skin: Skin = { id: "x", name: "X", base: "light", density: "compact" };
    // Grid cellFontSize stays in POINTS (11); the CSS token is its px equivalent.
    expect(getMergedTokens(skin)[THEME_TOKENS.FONT_SIZE_CELL]).toBe(`${11 * 96 / 72}px`);
    expect(getMergedGridTheme(skin).cellFontSize).toBe(11);
  });

  it("fontFamily maps to the font token AND the grid cellFontFamily", () => {
    const skin: Skin = { id: "x", name: "X", base: "light", fontFamily: "Comic Sans" };
    expect(getMergedTokens(skin)[THEME_TOKENS.FONT_FAMILY_SANS]).toBe("Comic Sans");
    expect(getMergedGridTheme(skin).cellFontFamily).toBe("Comic Sans");
  });

  it("grid deltas override the grid baseline", () => {
    const skin: Skin = { id: "x", name: "X", base: "light", grid: { gridLine: "#123456" } };
    const grid = getMergedGridTheme(skin);
    expect(grid.gridLine).toBe("#123456");
    expect(grid.cellBackground).toBe(DEFAULT_THEME.cellBackground);
  });
});

describe("skinLoader active state", () => {
  it("init applies the built-in default and injects a style element", () => {
    initSkinLoader();
    expect(getActiveSkinId()).toBe(LIGHT_SKIN_ID);
    expect(document.getElementById("calcula-skin-vars")).not.toBeNull();
  });

  it("init respects a persisted skin id", () => {
    localStorage.setItem(SKIN_STORAGE_KEY, DARK_SKIN_ID);
    initSkinLoader();
    expect(getActiveSkinId()).toBe(DARK_SKIN_ID);
    expect(getActiveSkin().base).toBe("dark");
  });

  it("setActiveSkin changes the grid theme reference and persists", () => {
    initSkinLoader();
    const before = getActiveGridTheme();
    setActiveSkin(DARK_SKIN_ID);
    const after = getActiveGridTheme();
    expect(after).not.toBe(before);
    expect(after.cellBackground).toBe("#1e1e1e");
    expect(localStorage.getItem(SKIN_STORAGE_KEY)).toBe(DARK_SKIN_ID);
    expect(hasUserChosenSkin()).toBe(true);
  });

  it("setActiveSkin with persist:false does NOT record a user choice", () => {
    initSkinLoader();
    setActiveSkin(DARK_SKIN_ID, { persist: false });
    expect(getActiveSkinId()).toBe(DARK_SKIN_ID);
    expect(hasUserChosenSkin()).toBe(false);
  });

  it("unknown skin id is a no-op", () => {
    initSkinLoader();
    setActiveSkin("does.not.exist");
    expect(getActiveSkinId()).toBe(LIGHT_SKIN_ID);
  });

  it("subscribe fires once per setActiveSkin", () => {
    initSkinLoader();
    let count = 0;
    const unsub = subscribe(() => {
      count++;
    });
    setActiveSkin(DARK_SKIN_ID);
    expect(count).toBe(1);
    unsub();
    setActiveSkin(LIGHT_SKIN_ID);
    expect(count).toBe(1);
  });

  it("late-registered skin matching the active id re-applies", () => {
    localStorage.setItem(SKIN_STORAGE_KEY, "org.brand");
    initSkinLoader(); // active id is org.brand, but it isn't registered yet
    expect(getActiveSkin().id).toBe(LIGHT_SKIN_ID); // fallback skin object
    registerSkin({ id: "org.brand", name: "Org", base: "dark" });
    expect(getActiveSkin().id).toBe("org.brand");
    expect(getActiveGridTheme().cellBackground).toBe("#1e1e1e");
  });
});

describe("accessibility transforms", () => {
  it("high contrast forces strong text color over the active skin", () => {
    initSkinLoader();
    setAccessibility({ highContrast: true });
    expect(getActiveGridTheme().cellText).toBe("#000000");
  });

  it("minFontScale raises the cell font size", () => {
    initSkinLoader();
    setAccessibility({ minFontScale: 1.5 });
    // Default baseline cellFontSize is now 11pt (Excel default).
    expect(getActiveGridTheme().cellFontSize).toBe(Math.round(11 * 1.5));
  });

  it("forcedBase=dark applies the dark baseline even on the light skin", () => {
    initSkinLoader();
    expect(getActiveSkin().base).toBe("light");
    setAccessibility({ forcedBase: "dark" });
    expect(getActiveGridTheme().cellBackground).toBe("#1e1e1e");
  });

  it("high contrast also strengthens the Clusters chrome, not only text", () => {
    // The redesign moved control edges off BORDER_DEFAULT (which High
    // contrast always blackened) onto CONTROL_BORDER. Without its own row
    // the toggle would have left every ribbon control at a pale grey edge.
    initSkinLoader();
    setAccessibility({ highContrast: true });
    expect(injected(THEME_TOKENS.CONTROL_BORDER)).toBe("#000000");
    expect(injected(THEME_TOKENS.RIBBON_GROUP_LABEL_FG)).toBe("#1a1a1a");
    expect(injected(THEME_TOKENS.ICON_FILL_SOFT)).toBe("#767676");
    expect(injected(THEME_TOKENS.RIBBON_TAB_INDICATOR)).toBe("#000000");
    setActiveSkin(DARK_SKIN_ID);
    expect(injected(THEME_TOKENS.CONTROL_BORDER)).toBe("#ffffff");
    expect(injected(THEME_TOKENS.ICON_FILL_SOFT)).toBe("#9d9d9d");
  });
});

describe("the four built-in skins", () => {
  it("registers Light, Dark, Soft and Contrast, in that order, all marked built-in", () => {
    initSkinLoader();
    const ids = getRegisteredSkins().map((s) => s.id);
    expect(ids.slice(0, 4)).toEqual([LIGHT_SKIN_ID, DARK_SKIN_ID, SOFT_SKIN_ID, CONTRAST_SKIN_ID]);
    expect(BUILTIN_SKINS.every((s) => s.builtIn === true)).toBe(true);
  });

  it("Calcula Soft merges its delta over the light baseline and nothing else", () => {
    const tokens = getMergedTokens(softSkin);
    expect(tokens[THEME_TOKENS.RADIUS_CONTROL]).toBe("10px");
    expect(tokens[THEME_TOKENS.RADIUS_CLUSTER]).toBe("16px");
    expect(tokens[THEME_TOKENS.STATE_ACCENT]).toBe("#4f46e5");
    expect(tokens[THEME_TOKENS.RIBBON_CLUSTER_BG]).toBe("#eef0f7");
    // Untouched tokens are the light baseline's, including the ones that
    // REFERENCE the state accent — they recolour through the reference.
    expect(tokens[THEME_TOKENS.RIBBON_BAND_BG]).toBe(defaultTheme[THEME_TOKENS.RIBBON_BAND_BG]);
    expect(tokens[THEME_TOKENS.ICON_ACCENT]).toBe("var(--state-accent)");
    expect(getMergedGridTheme(softSkin)).toEqual(DEFAULT_THEME);
  });

  it("Calcula Contrast squares the chrome and blackens its edges", () => {
    const tokens = getMergedTokens(contrastSkin);
    expect(tokens[THEME_TOKENS.RADIUS_CONTROL]).toBe("2px");
    expect(tokens[THEME_TOKENS.RADIUS_CLUSTER]).toBe("2px");
    expect(tokens[THEME_TOKENS.RADIUS_POPOVER]).toBe("2px");
    expect(tokens[THEME_TOKENS.CONTROL_BORDER]).toBe("#000000");
    expect(tokens[THEME_TOKENS.RIBBON_CLUSTER_BORDER]).toBe("#000000");
    expect(tokens[THEME_TOKENS.STATE_ACCENT]).toBe("#00543a");
    expect(tokens[THEME_TOKENS.TEXT_PRIMARY]).toBe(defaultTheme[THEME_TOKENS.TEXT_PRIMARY]);
  });

  it("switching to a delta skin injects its values into the page", () => {
    initSkinLoader();
    setActiveSkin(SOFT_SKIN_ID);
    expect(injected(THEME_TOKENS.STATE_ACCENT)).toBe("#4f46e5");
    setActiveSkin(CONTRAST_SKIN_ID);
    expect(injected(THEME_TOKENS.STATE_ACCENT)).toBe("#00543a");
    expect(injected(THEME_TOKENS.RADIUS_CLUSTER)).toBe("2px");
  });

  // Measured on the MERGED tokens, not on the skin's delta: a skin inherits
  // most of its colours, and an inherited foreground on a background the skin
  // DID change is exactly where a legibility regression hides. (The first
  // group-label value passed the light baseline and failed Soft's card.)
  for (const skin of BUILTIN_SKINS) {
    it(`${skin.name}: the ribbon stays legible after merging`, () => {
      const t = getMergedTokens(skin);
      const card = t[THEME_TOKENS.RIBBON_CLUSTER_BG];
      expect(contrast(t[THEME_TOKENS.STATE_ACCENT], card)).toBeGreaterThanOrEqual(3);
      expect(contrast(t[THEME_TOKENS.STATE_ACCENT], t[THEME_TOKENS.BG_SURFACE])).toBeGreaterThanOrEqual(3);
      const label = t[THEME_TOKENS.RIBBON_GROUP_LABEL_FG];
      expect(contrast(label, card)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(label, t[THEME_TOKENS.RIBBON_BAND_BG])).toBeGreaterThanOrEqual(4.5);
      for (const tab of [
        THEME_TOKENS.TAB_ACCENT_CHART,
        THEME_TOKENS.TAB_ACCENT_TABLE,
        THEME_TOKENS.TAB_ACCENT_PIVOT,
        THEME_TOKENS.TAB_ACCENT_SLICER,
        THEME_TOKENS.TAB_ACCENT_SPARKLINE,
        THEME_TOKENS.TAB_ACCENT_REPORT,
      ]) {
        expect(contrast(t[tab], t[THEME_TOKENS.RIBBON_FRAME_BG]), tab).toBeGreaterThanOrEqual(4.5);
      }
      expect(
        contrast(t[THEME_TOKENS.ACTIVITY_BAR_FG], t[THEME_TOKENS.ACTIVITY_BAR_BG]),
      ).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe("ribbon group-label preference", () => {
  it("absent storage reads as show", () => {
    expect(localStorage.getItem(RIBBON_LABELS_STORAGE_KEY)).toBeNull();
    expect(getRibbonLabelMode()).toBe("show");
  });

  it("an unrecognised stored value reads as show, never as hide", () => {
    localStorage.setItem(RIBBON_LABELS_STORAGE_KEY, "sometimes");
    expect(getRibbonLabelMode()).toBe("show");
  });

  it("init stamps the mode on <html> even when nothing is stored", () => {
    initSkinLoader();
    expect(document.documentElement.dataset.ribbonLabels).toBe("show");
  });

  it("hide persists, stamps the dataset and notifies subscribers", () => {
    initSkinLoader();
    let calls = 0;
    subscribe(() => {
      calls++;
    });
    setRibbonLabelMode("hide");
    expect(localStorage.getItem(RIBBON_LABELS_STORAGE_KEY)).toBe("hide");
    expect(document.documentElement.dataset.ribbonLabels).toBe("hide");
    expect(getRibbonLabelMode()).toBe("hide");
    expect(calls).toBe(1);
  });

  it("hide survives a reload (fresh module state reads it back at init)", () => {
    initSkinLoader();
    setRibbonLabelMode("hide");
    __resetSkinLoaderForTests(); // what a reload does to the module
    expect(document.documentElement.dataset.ribbonLabels).toBeUndefined();
    initSkinLoader();
    expect(getRibbonLabelMode()).toBe("hide");
    expect(document.documentElement.dataset.ribbonLabels).toBe("hide");
  });

  it("show REMOVES the key rather than storing the default", () => {
    // Absent is the state the E2E residue guard calls clean. Writing "show"
    // would leave a key a fresh install never has.
    initSkinLoader();
    setRibbonLabelMode("hide");
    setRibbonLabelMode("show");
    expect(localStorage.getItem(RIBBON_LABELS_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.dataset.ribbonLabels).toBe("show");
  });

  it("null also removes the key", () => {
    initSkinLoader();
    setRibbonLabelMode("hide");
    setRibbonLabelMode(null);
    expect(localStorage.getItem(RIBBON_LABELS_STORAGE_KEY)).toBeNull();
    expect(getRibbonLabelMode()).toBe("show");
  });

  it("a skin change keeps the label mode stamped", () => {
    initSkinLoader();
    setRibbonLabelMode("hide");
    setActiveSkin(DARK_SKIN_ID);
    expect(document.documentElement.dataset.ribbonLabels).toBe("hide");
  });
});

/** Names that are NOT theme tokens (constants: a quoted `--x` key trips the
 *  naming convention). The second is a real token spelled without its dashes. */
const NOT_A_TOKEN = "--not-a-token";
const NO_DASHES = "state-accent";

describe("user token overrides", () => {
  it("absent storage means no overrides", () => {
    expect(getUserTokenOverrides()).toEqual({});
  });

  it("user beats skin: an override replaces the active skin's value", () => {
    initSkinLoader();
    setActiveSkin(SOFT_SKIN_ID);
    expect(injected(THEME_TOKENS.STATE_ACCENT)).toBe("#4f46e5");
    setUserTokenOverrides({ [THEME_TOKENS.STATE_ACCENT]: "#b91c1c" });
    expect(injected(THEME_TOKENS.STATE_ACCENT)).toBe("#b91c1c");
    // ...and survives the next skin switch, because it is the user's, not the skin's.
    setActiveSkin(CONTRAST_SKIN_ID);
    expect(injected(THEME_TOKENS.STATE_ACCENT)).toBe("#b91c1c");
    // Tokens the user did not touch still come from the skin.
    expect(injected(THEME_TOKENS.RADIUS_CLUSTER)).toBe("2px");
  });

  it("accessibility beats user: high contrast overrides an overridden token", () => {
    initSkinLoader();
    setUserTokenOverrides({
      [THEME_TOKENS.TEXT_PRIMARY]: "#9ca3af",
      [THEME_TOKENS.CONTROL_BORDER]: "#eeeeee",
    });
    expect(injected(THEME_TOKENS.TEXT_PRIMARY)).toBe("#9ca3af");
    setAccessibility({ highContrast: true });
    expect(injected(THEME_TOKENS.TEXT_PRIMARY)).toBe("#000000");
    expect(injected(THEME_TOKENS.CONTROL_BORDER)).toBe("#000000");
  });

  it("forcedBase discards the overrides along with the skin's deltas", () => {
    initSkinLoader();
    setUserTokenOverrides({ [THEME_TOKENS.RIBBON_BAND_BG]: "#fafafa" });
    setAccessibility({ forcedBase: "dark" });
    expect(injected(THEME_TOKENS.RIBBON_BAND_BG)).toBe("#252526");
  });

  it("persists as JSON and is read back after a reload", () => {
    initSkinLoader();
    setUserTokenOverrides({ [THEME_TOKENS.RADIUS_CONTROL]: "4px" });
    expect(JSON.parse(localStorage.getItem(USER_TOKENS_STORAGE_KEY) ?? "null")).toEqual({
      [THEME_TOKENS.RADIUS_CONTROL]: "4px",
    });
    __resetSkinLoaderForTests();
    initSkinLoader();
    expect(getUserTokenOverrides()).toEqual({ [THEME_TOKENS.RADIUS_CONTROL]: "4px" });
    expect(injected(THEME_TOKENS.RADIUS_CONTROL)).toBe("4px");
  });

  it("unknown token names and non-string values are ignored", () => {
    initSkinLoader();
    setUserTokenOverrides({
      [NOT_A_TOKEN]: "#123456",
      [NO_DASHES]: "#123456",
      [THEME_TOKENS.RADIUS_PILL]: 12 as unknown as string,
      [THEME_TOKENS.CHIP_BG]: "#fafafa",
    });
    expect(getUserTokenOverrides()).toEqual({ [THEME_TOKENS.CHIP_BG]: "#fafafa" });
    expect(injected(NOT_A_TOKEN)).toBeUndefined();
  });

  it("values that could break out of the injected rule are ignored", () => {
    // The stylesheet is built as ONE line of text with the accessibility
    // tokens in it. Each of these would end the declaration, the rule or the
    // element, or leave something open that swallows every token after it.
    initSkinLoader();
    const hostile = [
      "red; } body { display: none } :root {",
      "#fff /* swallow the rest",
      "rgb(1, 2, 3",
      '"Segoe UI',
      "url(https://example.invalid/x.png)",
      "#fff !important",
      "</style><script>",
      "#fff\n",
      "",
    ];
    for (const value of hostile) {
      setUserTokenOverrides({ [THEME_TOKENS.CHIP_BG]: value });
      expect(getUserTokenOverrides(), JSON.stringify(value)).toEqual({});
      expect(injected(THEME_TOKENS.CHIP_BG)).toBe(defaultTheme[THEME_TOKENS.CHIP_BG]);
    }
  });

  it("the ordinary shapes a token value takes are all accepted", () => {
    initSkinLoader();
    const ok: Record<string, string> = {
      [THEME_TOKENS.STATE_ACCENT]: "#b91c1c",
      [THEME_TOKENS.SHADOW_POPOVER]: "0 8px 24px rgba(0, 0, 0, 0.2), 0 1px 3px rgba(0, 0, 0, 0.1)",
      [THEME_TOKENS.ICON_FILL_SOFT]: "color-mix(in srgb, currentColor 40%, transparent)",
      [THEME_TOKENS.FOCUS_RING]: "0 0 0 2px var(--bg-surface), 0 0 0 4px var(--focus-ring-color)",
      [THEME_TOKENS.MOTION_HOVER]: "90ms cubic-bezier(0.2, 0, 0, 1)",
      [THEME_TOKENS.FONT_FAMILY_SANS]: "'Segoe UI Variable', \"Segoe UI\", system-ui, sans-serif",
      [THEME_TOKENS.RADIUS_CONTROL]: "calc(4px + 2px)",
    };
    setUserTokenOverrides(ok);
    expect(getUserTokenOverrides()).toEqual(ok);
  });

  it("null clears the overrides and removes the key", () => {
    initSkinLoader();
    setUserTokenOverrides({ [THEME_TOKENS.CHIP_BG]: "#fafafa" });
    expect(localStorage.getItem(USER_TOKENS_STORAGE_KEY)).not.toBeNull();
    setUserTokenOverrides(null);
    expect(localStorage.getItem(USER_TOKENS_STORAGE_KEY)).toBeNull();
    expect(getUserTokenOverrides()).toEqual({});
    expect(injected(THEME_TOKENS.CHIP_BG)).toBe(defaultTheme[THEME_TOKENS.CHIP_BG]);
  });

  it("an empty map, or one where nothing survives, also removes the key", () => {
    initSkinLoader();
    setUserTokenOverrides({ [THEME_TOKENS.CHIP_BG]: "#fafafa" });
    setUserTokenOverrides({});
    expect(localStorage.getItem(USER_TOKENS_STORAGE_KEY)).toBeNull();
    setUserTokenOverrides({ [THEME_TOKENS.CHIP_BG]: "#fafafa" });
    setUserTokenOverrides({ [NOT_A_TOKEN]: "#000000" });
    expect(localStorage.getItem(USER_TOKENS_STORAGE_KEY)).toBeNull();
  });

  it("the setter REPLACES the set rather than merging into it", () => {
    initSkinLoader();
    setUserTokenOverrides({ [THEME_TOKENS.CHIP_BG]: "#fafafa" });
    setUserTokenOverrides({ [THEME_TOKENS.CHIP_BORDER]: "#cccccc" });
    expect(getUserTokenOverrides()).toEqual({ [THEME_TOKENS.CHIP_BORDER]: "#cccccc" });
  });

  it("tampered storage is sanitised on the way out, and junk JSON is no overrides", () => {
    localStorage.setItem(
      USER_TOKENS_STORAGE_KEY,
      JSON.stringify({ [THEME_TOKENS.CHIP_BG]: "red; }", [THEME_TOKENS.CHIP_BORDER]: "#cccccc" }),
    );
    expect(getUserTokenOverrides()).toEqual({ [THEME_TOKENS.CHIP_BORDER]: "#cccccc" });
    __resetSkinLoaderForTests();
    localStorage.setItem(USER_TOKENS_STORAGE_KEY, "{not json");
    expect(() => initSkinLoader()).not.toThrow();
    expect(getUserTokenOverrides()).toEqual({});
  });

  it("a storage that throws never breaks the setters (the session still applies)", () => {
    initSkinLoader();
    const proto = Object.getPrototypeOf(localStorage) as Storage;
    const originalSet = proto.setItem;
    const originalRemove = proto.removeItem;
    proto.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    proto.removeItem = () => {
      throw new Error("SecurityError");
    };
    try {
      expect(() => setUserTokenOverrides({ [THEME_TOKENS.CHIP_BG]: "#fafafa" })).not.toThrow();
      expect(injected(THEME_TOKENS.CHIP_BG)).toBe("#fafafa");
      expect(() => setRibbonLabelMode("hide")).not.toThrow();
      expect(getRibbonLabelMode()).toBe("hide");
      expect(() => setRibbonLabelMode(null)).not.toThrow();
    } finally {
      proto.setItem = originalSet;
      proto.removeItem = originalRemove;
    }
  });
});
