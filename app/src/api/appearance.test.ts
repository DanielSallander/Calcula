//! FILENAME: app/src/api/appearance.test.ts
// PURPOSE: The @api appearance facade announces the two new preferences on the
//          AppEvents bus with a payload a listener can tell apart.
// CONTEXT: The loader (core/theme/skinLoader.ts) owns the behaviour and has its
//          own suite; what this file pins is the CONTRACT extensions see:
//          every APPEARANCE_CHANGED still carries `skinId` (so the existing
//          onSkinChanged listeners keep working), and the new optional fields
//          say which preference moved. A facade that changed the preference
//          but forgot the emit would leave every extension showing the old
//          state until something else happened to repaint it.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONTRAST_SKIN_ID,
  SOFT_SKIN_ID,
  getRibbonLabelMode,
  getUserTokenOverrides,
  onSkinChanged,
  setActiveSkin,
  setRibbonLabelMode,
  setUserTokenOverrides,
  type AppearanceChangedPayload,
} from "./appearance";
import { AppEvents, onAppEvent } from "./events";
import { __resetSkinLoaderForTests, initSkinLoader } from "../core/theme/skinLoader";

// Token names as constants: a quoted `--name` key trips the repo's naming
// convention, and a computed key is also what the real callers write.
const STATE_ACCENT = "--state-accent";
const MADE_UP = "--made-up";

let received: AppearanceChangedPayload[] = [];
let off: () => void = () => {};

beforeEach(() => {
  __resetSkinLoaderForTests();
  localStorage.clear();
  initSkinLoader();
  received = [];
  off = onAppEvent<AppearanceChangedPayload>(AppEvents.APPEARANCE_CHANGED, (d) => {
    received.push(d);
  });
});

afterEach(() => {
  off();
});

describe("appearance facade", () => {
  it("re-exports the two new built-in skin ids, and they are switchable", () => {
    expect(SOFT_SKIN_ID).toBe("calcula.soft");
    expect(CONTRAST_SKIN_ID).toBe("calcula.contrast");
    setActiveSkin(SOFT_SKIN_ID);
    expect(received).toEqual([{ skinId: SOFT_SKIN_ID }]);
  });

  it("setRibbonLabelMode emits { skinId, ribbonLabels } with the RESOLVED mode", () => {
    setActiveSkin(CONTRAST_SKIN_ID);
    received = [];
    setRibbonLabelMode("hide");
    setRibbonLabelMode(null);
    expect(received).toEqual([
      { skinId: CONTRAST_SKIN_ID, ribbonLabels: "hide" },
      // null is reported as the mode it resolves to, never as null.
      { skinId: CONTRAST_SKIN_ID, ribbonLabels: "show" },
    ]);
    expect(getRibbonLabelMode()).toBe("show");
  });

  it("setUserTokenOverrides emits { skinId, userTokens: true } and round-trips", () => {
    setUserTokenOverrides({ [STATE_ACCENT]: "#b91c1c", [MADE_UP]: "#000000" });
    expect(received).toEqual([{ skinId: "calcula.light", userTokens: true }]);
    expect(getUserTokenOverrides()).toEqual({ [STATE_ACCENT]: "#b91c1c" });
  });

  it("an existing onSkinChanged listener still receives the skin id for the new events", () => {
    const ids: string[] = [];
    const unsub = onSkinChanged((id) => ids.push(id));
    try {
      setRibbonLabelMode("hide");
      setUserTokenOverrides(null);
    } finally {
      unsub();
    }
    expect(ids).toEqual(["calcula.light", "calcula.light"]);
  });
});
