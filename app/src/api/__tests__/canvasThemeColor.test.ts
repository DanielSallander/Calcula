//! FILENAME: app/src/api/__tests__/canvasThemeColor.test.ts
// PURPOSE: getCanvasThemeColor -- ONE theme token as a colour a canvas can
//          paint with -- follows the ACTIVE skin (Dark included), the user's
//          token overrides and the accessibility transforms, resolves var()
//          references (a canvas silently ignores a var() it is handed), falls
//          back to the light baseline, and survives a reference cycle.
// CONTEXT: The generic sibling of getCanvasToneColors. Its first caller is the
//          writeback region frame, tinted with the Writeback tab's accent
//          (app/extensions/Collaboration/lib/writebackOutline.ts).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DARK_SKIN_ID,
  LIGHT_SKIN_ID,
  getBaselineToneColors,
  getCanvasThemeColor,
  getCanvasToneColors,
  registerSkin,
  setActiveSkin,
  setUserTokenOverrides,
} from "../appearance";
import { __resetSkinLoaderForTests, initSkinLoader, setAccessibility } from "../../core/theme/skinLoader";
import { THEME_TOKENS } from "../../core/theme/tokens";
import { defaultTheme } from "../../core/theme/defaultTheme";
import { darkTheme } from "../../core/theme/darkTheme";

const ACCENT = THEME_TOKENS.TAB_ACCENT_WRITEBACK;

beforeEach(() => {
  localStorage.clear();
  __resetSkinLoaderForTests();
  initSkinLoader(LIGHT_SKIN_ID);
});
afterEach(() => {
  __resetSkinLoaderForTests();
  localStorage.clear();
});

describe("getCanvasThemeColor", () => {
  it("answers the light baseline's value on the light skin", () => {
    expect(getCanvasThemeColor(ACCENT)).toBe(defaultTheme[ACCENT]);
    expect(getCanvasThemeColor(ACCENT)).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("follows a switch to the dark skin, and back", () => {
    const light = getCanvasThemeColor(ACCENT);
    setActiveSkin(DARK_SKIN_ID);
    expect(getCanvasThemeColor(ACCENT)).toBe(darkTheme[ACCENT]);
    expect(getCanvasThemeColor(ACCENT)).not.toBe(light);
    setActiveSkin(LIGHT_SKIN_ID);
    expect(getCanvasThemeColor(ACCENT)).toBe(light);
  });

  it("honours the user's token overrides", () => {
    setUserTokenOverrides({ [ACCENT]: "#123456" });
    expect(getCanvasThemeColor(ACCENT)).toBe("#123456");
    setUserTokenOverrides(null);
    expect(getCanvasThemeColor(ACCENT)).toBe(defaultTheme[ACCENT]);
  });

  it("applies the accessibility transforms, as the chrome is painted", () => {
    const plain = getCanvasThemeColor(THEME_TOKENS.GRID_LINE);
    setAccessibility({ highContrast: true });
    const contrast = getCanvasThemeColor(THEME_TOKENS.GRID_LINE);
    expect(contrast).not.toBe(plain);
    expect(contrast).toBe("#000000");
  });

  it("resolves a token written as a reference to another token", () => {
    // --focus-ring-color is `var(--state-accent)` in both baselines.
    expect(defaultTheme[THEME_TOKENS.FOCUS_RING_COLOR]).toContain("var(");
    expect(getCanvasThemeColor(THEME_TOKENS.FOCUS_RING_COLOR)).toBe(defaultTheme[THEME_TOKENS.STATE_ACCENT]);
    setActiveSkin(DARK_SKIN_ID);
    expect(getCanvasThemeColor(THEME_TOKENS.FOCUS_RING_COLOR)).toBe(darkTheme[THEME_TOKENS.STATE_ACCENT]);
  });

  it("resolves a reference inside another colour function and leaves the function for the canvas", () => {
    const written = defaultTheme[THEME_TOKENS.BUTTON_PRESSED_BG];
    expect(written).toContain("var(--accent-primary)");
    const resolved = getCanvasThemeColor(THEME_TOKENS.BUTTON_PRESSED_BG);
    expect(resolved).not.toContain("var(");
    expect(resolved).toBe(written.replace("var(--accent-primary)", defaultTheme[THEME_TOKENS.ACCENT_PRIMARY]));
  });

  it("resolves a user override that aliases another token", () => {
    setUserTokenOverrides({ [ACCENT]: `var(${THEME_TOKENS.TONE_DANGER_FG})` });
    expect(getCanvasThemeColor(ACCENT)).toBe(defaultTheme[THEME_TOKENS.TONE_DANGER_FG]);
  });

  it("takes a var() fallback when the name has no value", () => {
    setUserTokenOverrides({ [ACCENT]: "var(--no-such-token, #123456)" });
    expect(getCanvasThemeColor(ACCENT)).toBe("#123456");
  });

  it("ends a reference cycle at the baseline instead of hanging or handing the canvas a var()", () => {
    setUserTokenOverrides({ [ACCENT]: `var(${ACCENT})` });
    expect(getCanvasThemeColor(ACCENT)).toBe(defaultTheme[ACCENT]);
  });

  it("falls back to the light baseline when the active value is blank", () => {
    registerSkin({ id: "test.blank-accent", name: "Blank accent", base: "dark", tokens: { [ACCENT]: "   " } });
    setActiveSkin("test.blank-accent");
    expect(getCanvasThemeColor(ACCENT)).toBe(defaultTheme[ACCENT]);
  });

  it("starts a new cache per applied token set (a re-apply is never served a stale colour)", () => {
    expect(getCanvasThemeColor(ACCENT)).toBe(defaultTheme[ACCENT]);
    expect(getCanvasThemeColor(ACCENT)).toBe(defaultTheme[ACCENT]);
    setUserTokenOverrides({ [ACCENT]: "#654321" });
    expect(getCanvasThemeColor(ACCENT)).toBe("#654321");
  });
});

describe("getCanvasToneColors resolves references too", () => {
  it("a tone aliased to another token reaches the canvas as a colour", () => {
    setUserTokenOverrides({ [THEME_TOKENS.TONE_DANGER_FG]: `var(${ACCENT})` });
    expect(getCanvasToneColors().dangerFg).toBe(defaultTheme[ACCENT]);
  });
});

describe("getBaselineToneColors: the Light and Dark grounds' own tones", () => {
  it("are the baselines' values, whatever skin is active and whatever the user overrode", () => {
    setActiveSkin(DARK_SKIN_ID);
    setUserTokenOverrides({ [THEME_TOKENS.TONE_DANGER_FG]: "#123456" });
    expect(getCanvasToneColors().dangerFg).toBe("#123456");
    expect(getBaselineToneColors("light").dangerFg).toBe(defaultTheme[THEME_TOKENS.TONE_DANGER_FG]);
    expect(getBaselineToneColors("dark").dangerFg).toBe(darkTheme[THEME_TOKENS.TONE_DANGER_FG]);
    expect(getBaselineToneColors("light").dangerFg).not.toBe(getBaselineToneColors("dark").dangerFg);
    // Every tone is a colour a canvas can paint, never a var().
    for (const base of ["light", "dark"] as const) {
      for (const v of Object.values(getBaselineToneColors(base))) {
        expect(v).not.toBe("");
        expect(v).not.toContain("var(");
      }
    }
  });
});
