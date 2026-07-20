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
} from "./skinLoader";
import { LIGHT_SKIN_ID, DARK_SKIN_ID, lightSkin } from "./builtInSkins";

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
});
