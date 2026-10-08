//! FILENAME: app/src/api/__tests__/buttonActions.test.ts
// PURPOSE: The DECLARATIVE button actions of @api/buttonControlService (Canvas
//          contract §3/§4.4): Power BI's "Action" types Calcula renders --
//          Page navigation, Back, Clear all slicers -- as three control
//          PROPERTIES, never code.
// CONTEXT: The properties are the contract between three writers and two
//          readers that never import each other: the seam's createButton, the
//          Properties pane and a paste write them; the click and the renderer
//          read them; and the script validator refuses them by these same
//          spellings. So the spellings, the round trip and the refusals of a
//          malformed value are pinned here, once, where they are defined.

import { describe, it, expect } from "vitest";
import {
  BUTTON_ACTION_KINDS,
  BUTTON_ACTION_LABELS,
  BUTTON_ACTION_PROPERTY,
  BUTTON_ACTION_PROPERTY_KEYS,
  BUTTON_ACTION_TARGET_NAME_PROPERTY,
  BUTTON_ACTION_TARGET_PROPERTY,
  MACRO_REF_PROPERTY,
  buttonActionProperties,
  checkCreateButtonAction,
  readButtonAction,
  type ButtonAction,
} from "../buttonControlService";

/** A property bag as the backend returns it. */
function bag(values: Record<string, string>): Record<string, { valueType: "static"; value: string }> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { valueType: "static" as const, value: v }]));
}

describe("the declarative action properties", () => {
  it("are spelled as the contract names them, and are three", () => {
    expect(BUTTON_ACTION_PROPERTY).toBe("action");
    expect(BUTTON_ACTION_TARGET_PROPERTY).toBe("actionTarget");
    expect(BUTTON_ACTION_TARGET_NAME_PROPERTY).toBe("actionTargetName");
    expect([...BUTTON_ACTION_PROPERTY_KEYS].sort()).toEqual(["action", "actionTarget", "actionTargetName"]);
    expect([...BUTTON_ACTION_KINDS]).toEqual(["navigate", "back", "clearSlicers"]);
    for (const kind of BUTTON_ACTION_KINDS) expect(BUTTON_ACTION_LABELS[kind].length).toBeGreaterThan(0);
  });

  it("never overlap a slot that runs code", () => {
    for (const key of BUTTON_ACTION_PROPERTY_KEYS) {
      expect(["onSelect", MACRO_REF_PROPERTY, "heldOnSelect", "heldMacroRef", "heldFrom"]).not.toContain(key);
    }
  });

  const ROUND_TRIPS: ButtonAction[] = [
    { kind: "navigate", sheetId: "5b0c2f9e-0000-4000-8000-000000000001", sheetName: "Sales Overview" },
    { kind: "navigate", sheetName: "Page 2" },
    { kind: "back" },
    { kind: "clearSlicers" },
  ];
  for (const action of ROUND_TRIPS) {
    it(`round-trips ${JSON.stringify(action)} through the property bag`, () => {
      const written = buttonActionProperties(action);
      // ALL THREE keys are written every time, "" for the unused ones: a
      // change from "navigate" to "back" must not leave the old target behind.
      expect(Object.keys(written).sort()).toEqual([...BUTTON_ACTION_PROPERTY_KEYS].sort());
      expect(readButtonAction(bag(written))).toEqual(action);
    });
  }

  it("clears with three empty strings, which read back as no action", () => {
    const cleared = buttonActionProperties(null);
    expect(cleared).toEqual({ action: "", actionTarget: "", actionTargetName: "" });
    expect(readButtonAction(bag(cleared))).toBeNull();
  });

  it("reads NO action from a bag without one, from an unknown kind, and from a navigate with no page", () => {
    expect(readButtonAction(undefined)).toBeNull();
    expect(readButtonAction(bag({}))).toBeNull();
    expect(readButtonAction(bag({ text: "Go" }))).toBeNull();
    expect(readButtonAction(bag({ action: "openUrl", actionTarget: "https://example.com" }))).toBeNull();
    expect(readButtonAction(bag({ action: "navigate" }))).toBeNull();
    expect(readButtonAction(bag({ action: "navigate", actionTarget: "", actionTargetName: "   " }))).toBeNull();
  });

  // A FORMULA-typed property is evaluated against the grid; an action is a
  // fixed choice the author made. A formula there would let the data decide
  // where a button goes, which nothing promises.
  // The value is a valid KIND on purpose: only the value TYPE may refuse it,
  // so the guard is the type check and nothing else.
  it("ignores a formula-typed action, even one whose text is a valid kind", () => {
    expect(readButtonAction({ action: { valueType: "formula", value: "back" } })).toBeNull();
    expect(
      readButtonAction({ action: { valueType: "formula", value: "navigate" }, actionTargetName: { valueType: "static", value: "P" } }),
    ).toBeNull();
    // A formula-typed TARGET is no target either.
    expect(
      readButtonAction({ action: { valueType: "static", value: "navigate" }, actionTargetName: { valueType: "formula", value: "P" } }),
    ).toBeNull();
  });

  it("finds a navigate target by its NAME when the sheet id is absent (a subscriber's remapped page)", () => {
    expect(readButtonAction(bag({ action: "navigate", actionTargetName: "Details" }))).toEqual({
      kind: "navigate",
      sheetName: "Details",
    });
  });
});

describe("what createButton accepts beside an action", () => {
  it("accepts a lone action, or none", () => {
    expect(checkCreateButtonAction({ label: "Back", action: { kind: "back" } })).toBeNull();
    expect(checkCreateButtonAction({ label: "Plain" })).toBeNull();
    expect(checkCreateButtonAction({ label: "Code", onSelect: "Run();" })).toBeNull();
  });

  // A button does ONE thing (Power BI's model). With code beside an action,
  // which one a click runs would be a rule nobody can see.
  it("refuses an action beside code or a macro link, naming both", () => {
    const withCode = checkCreateButtonAction({ label: "X", onSelect: "Run();", action: { kind: "back" } });
    expect(withCode).toMatch(/onSelect/);
    const withMacro = checkCreateButtonAction({ label: "X", macroRef: "macro-x", action: { kind: "clearSlicers" } });
    expect(withMacro).toMatch(/macroRef/);
  });

  it("refuses a malformed action", () => {
    expect(checkCreateButtonAction({ label: "X", action: { kind: "openUrl" } as never })).toMatch(/action/);
    expect(checkCreateButtonAction({ label: "X", action: { kind: "navigate", sheetName: "" } })).toMatch(/page/);
    expect(checkCreateButtonAction({ label: "X", action: null as never })).toMatch(/action/);
  });
});
