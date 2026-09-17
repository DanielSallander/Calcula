//! FILENAME: app/extensions/Charts/lib/__tests__/overlayKeys.test.ts
// PURPOSE: The keyboard's claim on the overlay is narrow: plain Left/Right
//          step, only while the selected chart shows cues; a modifier, another
//          key, or an empty overlay leave the keystroke to the grid.

import { describe, it, expect } from "vitest";
import { overlayStepDelta, isTextEntryTarget } from "../overlayKeys";

const key = (k: string, mods: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) => ({
  key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods,
});

describe("overlayStepDelta", () => {
  it("steps forward on Right and back on Left while cues are shown", () => {
    expect(overlayStepDelta(key("ArrowRight"), 3)).toBe(1);
    expect(overlayStepDelta(key("ArrowLeft"), 3)).toBe(-1);
  });

  it("leaves the arrows to the grid when the chart shows no cues", () => {
    expect(overlayStepDelta(key("ArrowRight"), 0)).toBeNull();
    expect(overlayStepDelta(key("ArrowLeft"), 0)).toBeNull();
  });

  it("never claims a modified arrow (the grid's jump) or any other key", () => {
    expect(overlayStepDelta(key("ArrowRight", { ctrlKey: true }), 3)).toBeNull();
    expect(overlayStepDelta(key("ArrowLeft", { shiftKey: true }), 3)).toBeNull();
    expect(overlayStepDelta(key("ArrowRight", { altKey: true }), 3)).toBeNull();
    expect(overlayStepDelta(key("ArrowRight", { metaKey: true }), 3)).toBeNull();
    for (const k of ["ArrowUp", "ArrowDown", "Enter", "Tab", " ", "PageDown"]) expect(overlayStepDelta(key(k), 3), k).toBeNull();
  });
});

describe("isTextEntryTarget", () => {
  it("recognises inputs, textareas and editable elements, and nothing else", () => {
    expect(isTextEntryTarget({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true);
    expect(isTextEntryTarget({ tagName: "TEXTAREA" } as unknown as EventTarget)).toBe(true);
    expect(isTextEntryTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTextEntryTarget({ tagName: "CANVAS" } as unknown as EventTarget)).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});
