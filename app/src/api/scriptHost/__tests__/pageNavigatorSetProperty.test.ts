//! FILENAME: app/src/api/scriptHost/__tests__/pageNavigatorSetProperty.test.ts
// PURPOSE: The script gate (`shape.setProperty`) is READY for a Page
//          Navigator (WP-B S9): its settings are admitted by name, and its
//          per-page overrides (`pageOverrides`, a JSON array) are checked
//          STRICTLY -- after the 8 KiB sandbox cap, with the seam's sentence.
// CONTEXT: The paint reads overrides TOLERANTLY (bad fields dropped, captions
//          clipped) so a damaged document still draws. A script is a WRITER,
//          though, and a writer that gets "accepted" and then silently loses
//          half of what it wrote has been lied to -- so the gate refuses what
//          the tolerant read would drop. The door that aims this aspect at a
//          navigator (Controls/index.ts) is D-BIND's to open; this file pins
//          that the validator is safe once it does.
//
//          A new LF file on purpose: shapeScriptRows.test.ts is pure CRLF, and
//          an LF edit there would make it mixed (lineEndingDrift.test.ts).

import { describe, it, expect } from "vitest";
import {
  MAX_SHAPE_PROPERTY_CHARS,
  SCRIPT_SHAPE_PROPERTY_KEYS,
  checkShapeSetProperty,
  vSetState,
} from "../validators";
import {
  BUTTON_ACTION_PROPERTY_KEYS,
  MAX_PAGE_NAVIGATOR_CAPTION,
  MAX_PAGE_NAVIGATOR_OVERRIDES,
  PAGE_NAVIGATOR_OVERRIDES_PROPERTY,
  checkPageNavigatorOverrides,
  serializePageNavigatorOverrides,
} from "../../buttonControlService";

const KEY = PAGE_NAVIGATOR_OVERRIDES_PROPERTY;

describe("a Page Navigator's settings pass the script gate", () => {
  it("admits every container setting by name", () => {
    const writes: Array<[string, string]> = [
      ["orientation", "vertical"],
      ["gap", "4"],
      ["padding", "6"],
      ["selectedFill", "#336699"],
      ["selectedColor", "#ffffff"],
      ["showHiddenPages", "true"],
      ["showTooltipPages", "false"],
      ["fill", "#eeeeee"],
      ["fontSize", "12"],
    ];
    for (const [key, value] of writes) {
      expect(SCRIPT_SHAPE_PROPERTY_KEYS, key).toContain(key);
      expect(checkShapeSetProperty([key, value]), key).toBe(true);
    }
    expect(SCRIPT_SHAPE_PROPERTY_KEYS).toContain(KEY);
  });

  it("admits a valid overrides array through both setState doors", () => {
    const value = serializePageNavigatorOverrides([
      { sheetId: "7f9c2a64-3b1e-4d5a-9c8e-0a1b2c3d4e5f", sheetName: "Sales", text: "Overview", fill: "#ffcc00" },
      { sheetId: "", sheetName: "Detail", hidden: true },
    ]);
    expect(checkShapeSetProperty([KEY, value])).toBe(true);
    expect(vSetState(["shape.setProperty", [KEY, value]])).toBe(true);
    expect(checkShapeSetProperty([KEY, "[]"])).toBe(true);
  });
});

describe("overrides are checked STRICTLY (unlike the paint's tolerant read)", () => {
  // SABOTAGE: delete the `name === PAGE_NAVIGATOR_OVERRIDES_PROPERTY` branch
  // from checkShapeSetProperty -> every case below is admitted (the key is in
  // the allowed list) and goes red.
  const refused: Array<[string, string, RegExp]> = [
    ["an unknown field", '[{"sheetId":"a","sheetName":"Sales","target":"Detail"}]', /unknown field "target"/],
    ["a bad colour", '[{"sheetId":"a","sheetName":"Sales","fill":"red"}]', /is not a colour/],
    ["a non-boolean hidden", '[{"sheetId":"a","sheetName":"Sales","hidden":"yes"}]', /hidden must be true or false/],
    [
      "an over-long caption",
      JSON.stringify([{ sheetId: "a", sheetName: "Sales", text: "x".repeat(MAX_PAGE_NAVIGATOR_CAPTION + 1) }]),
      new RegExp(`the limit is ${MAX_PAGE_NAVIGATOR_CAPTION}`),
    ],
    [
      "too many entries",
      JSON.stringify(Array.from({ length: MAX_PAGE_NAVIGATOR_OVERRIDES + 1 }, () => ({ sheetId: "a", sheetName: "" }))),
      new RegExp(`at most ${MAX_PAGE_NAVIGATOR_OVERRIDES}`),
    ],
    ["not JSON", "[{", /not valid JSON/],
    ["not an array", '{"sheetId":"a","sheetName":"Sales"}', /must be a JSON array/],
    ["an entry that names no page", '[{"sheetId":"","sheetName":""}]', /names no page/],
  ];

  for (const [what, value, why] of refused) {
    it(`refuses ${what} with a sentence`, () => {
      // Within the sandbox cap, so it is the strict check that refuses.
      expect(value.length).toBeLessThanOrEqual(MAX_SHAPE_PROPERTY_CHARS);
      const verdict = checkShapeSetProperty([KEY, value]);
      expect(verdict).not.toBe(true);
      expect(String(verdict)).toMatch(why);
      expect(String(verdict)).toBe(checkPageNavigatorOverrides(value));
      expect(vSetState(["shape.setProperty", [KEY, value]])).not.toBe(true);
    });
  }

  it("refuses a VALID array over 8 KiB by the sandbox cap first", () => {
    const list = Array.from({ length: 40 }, (_, i) => ({
      sheetId: `page-${i}`,
      sheetName: `Page ${i}`,
      text: "c".repeat(MAX_PAGE_NAVIGATOR_CAPTION - 10),
    }));
    const value = serializePageNavigatorOverrides(list);
    expect(value.length).toBeGreaterThan(MAX_SHAPE_PROPERTY_CHARS);
    expect(checkPageNavigatorOverrides(value), "the array itself is valid").toBeNull();
    const verdict = checkShapeSetProperty([KEY, value]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toMatch(new RegExp(`max ${MAX_SHAPE_PROPERTY_CHARS}`));
  });
});

describe("a navigator gives scripts no way to aim a click", () => {
  it("keeps every button-action key refused", () => {
    expect([...BUTTON_ACTION_PROPERTY_KEYS].sort()).toEqual(["action", "actionTarget", "actionTargetName"]);
    for (const key of BUTTON_ACTION_PROPERTY_KEYS) {
      const verdict = checkShapeSetProperty([key, "navigate"]);
      expect(verdict, key).not.toBe(true);
      expect(String(verdict)).toMatch(/where a click takes the reader/);
    }
  });

  it("refuses an override that tries to carry a target", () => {
    for (const field of ["action", "actionTarget", "actionTargetName", "target"]) {
      const value = JSON.stringify([{ sheetId: "a", sheetName: "Sales", [field]: "Detail" }]);
      expect(checkShapeSetProperty([KEY, value]), field).not.toBe(true);
    }
  });
});
