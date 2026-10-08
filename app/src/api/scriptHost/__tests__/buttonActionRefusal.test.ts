//! FILENAME: app/src/api/scriptHost/__tests__/buttonActionRefusal.test.ts
// PURPOSE: A script may not WRITE a button's declarative action (Canvas
//          contract §3: "added to SCRIPT_REFUSED_SHAPE_PROPERTY_KEYS-
//          equivalents so scripts cannot write them").
// CONTEXT: The action keys are NOT code -- they do not belong in Rust's
//          EXECUTABLE_CONTROL_PROPERTIES, which a pull STRIPS, and a subscribed
//          report's Back button must keep working. So they get their OWN
//          refused list rather than a place in SCRIPT_REFUSED_SHAPE_PROPERTY_KEYS
//          (which controls.rs pins to EXECUTABLE + HELD exactly, and would fail
//          the moment a non-executable key joined it).
//
//          Why refuse at all, when nothing runs: an action is the AUTHOR's
//          decision about where a reader is taken. A sandboxed script that
//          could re-aim it would redirect every reader's click without the
//          author ever seeing the change -- the same "decide what a click does
//          with someone else's authority" shape the executable refusal exists
//          for, minus the code. And without a refusal the custom-key regex
//          would admit all three spellings.

import { describe, it, expect } from "vitest";
import {
  SCRIPT_REFUSED_BUTTON_ACTION_KEYS,
  SCRIPT_REFUSED_SHAPE_PROPERTY_KEYS,
  checkShapeSetProperty,
  vSetState,
} from "../validators";
import { BUTTON_ACTION_PROPERTY_KEYS } from "../../buttonControlService";

describe("the declarative button-action keys are refused to scripts", () => {
  it("are the seam's own spellings, not a copy", () => {
    expect([...SCRIPT_REFUSED_BUTTON_ACTION_KEYS].sort()).toEqual([...BUTTON_ACTION_PROPERTY_KEYS].sort());
  });

  // SABOTAGE: drop the SCRIPT_REFUSED_BUTTON_ACTION_KEY_SET check from
  // checkShapeSetProperty -> the custom-key regex admits "action".
  it("refuses each through both setState doors, saying why", () => {
    for (const key of BUTTON_ACTION_PROPERTY_KEYS) {
      const direct = checkShapeSetProperty([key, "navigate"]);
      expect(direct, key).not.toBe(true);
      expect(String(direct)).toMatch(/where a click takes the reader/);
      expect(vSetState(["shape.setProperty", [key, "back"]]), key).not.toBe(true);
    }
  });

  it("stays OUT of the executable list that Rust pins and a pull strips", () => {
    for (const key of BUTTON_ACTION_PROPERTY_KEYS) {
      expect(SCRIPT_REFUSED_SHAPE_PROPERTY_KEYS).not.toContain(key);
    }
  });

  it("leaves an ordinary custom key alone", () => {
    expect(checkShapeSetProperty(["actionCount", "3"])).toBe(true);
    expect(checkShapeSetProperty(["fill", "#ff0000"])).toBe(true);
  });
});
