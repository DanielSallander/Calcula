//! FILENAME: app/src/api/__tests__/canvasToneColors.test.ts
// PURPOSE: getCanvasToneColors follows the ACTIVE skin (Dark included), the
//          user's token overrides, and is cached per skin apply.
// CONTEXT: Canvas painters (the writeback markers and outline) cannot read CSS
//          variables; this is their only route to the --tone-* tokens.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DARK_SKIN_ID,
  LIGHT_SKIN_ID,
  getCanvasToneColors,
  setActiveSkin,
  setUserTokenOverrides,
} from "../appearance";
import { __resetSkinLoaderForTests, initSkinLoader } from "../../core/theme/skinLoader";
import { THEME_TOKENS } from "../../core/theme/tokens";
import { defaultTheme } from "../../core/theme/defaultTheme";
import { darkTheme } from "../../core/theme/darkTheme";

beforeEach(() => {
  __resetSkinLoaderForTests();
  initSkinLoader(LIGHT_SKIN_ID);
});
afterEach(() => {
  __resetSkinLoaderForTests();
});

describe("getCanvasToneColors", () => {
  it("answers the light tones on the light skin", () => {
    const t = getCanvasToneColors();
    expect(t.warnFg).toBe(defaultTheme[THEME_TOKENS.TONE_WARN_FG]);
    expect(t.dangerFg).toBe(defaultTheme[THEME_TOKENS.TONE_DANGER_FG]);
    expect(t.infoFg).toBe(defaultTheme[THEME_TOKENS.TONE_INFO_FG]);
  });

  it("follows a switch to the dark skin", () => {
    setActiveSkin(DARK_SKIN_ID);
    const t = getCanvasToneColors();
    expect(t.warnFg).toBe(darkTheme[THEME_TOKENS.TONE_WARN_FG]);
    expect(t.infoFg).toBe(darkTheme[THEME_TOKENS.TONE_INFO_FG]);
    expect(t.warnFg).not.toBe(defaultTheme[THEME_TOKENS.TONE_WARN_FG]);
  });

  it("honours the user's token overrides", () => {
    setUserTokenOverrides({ [THEME_TOKENS.TONE_WARN_FG]: "#123456" });
    expect(getCanvasToneColors().warnFg).toBe("#123456");
  });

  it("returns the same object until the skin is re-applied", () => {
    const a = getCanvasToneColors();
    expect(getCanvasToneColors()).toBe(a);
    setActiveSkin(DARK_SKIN_ID);
    expect(getCanvasToneColors()).not.toBe(a);
  });
});
