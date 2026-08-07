//! FILENAME: app/src/api/scriptHost/__tests__/shapeScriptRows.test.ts
// PURPOSE: `api.createShape` / `api.deleteShape` sit at the same bar as every
//          other workbook-object row, take no capability, and cannot be talked
//          into carrying anything but a catalog id.
// CONTEXT: The whole reason these rows need no capability is the SHAPE of the
//          call: the only thing a script names is one of the shapes Calcula
//          already draws. There is no bytes parameter, no path parameter, no URL
//          parameter and — critically — no `onSelect` / `macroRef` parameter, so
//          the row cannot become an ingress or a privilege escalation however it
//          is called. That is a property of the validator, and it is asserted
//          here rather than argued in a comment.

import { describe, it, expect } from "vitest";
import { vCreateShape, vObjectId, MAX_SHAPE_PROPERTY_CHARS } from "../validators";
import { ALLOWLIST } from "../allowlist";
import { controlInstanceId, controlSheetFromInstanceId } from "../objectInventory";

const ANCHOR = { row: 2, col: 1 };

// ============================================================================
// 1. The allowlist rows
// ============================================================================

describe("the shape rows are ordinary workbook-object rows", () => {
  it("puts api.createShape at unlocked tier with NO capability, like createChart", () => {
    const row = ALLOWLIST["api.createShape"];
    expect(row).toBeDefined();
    expect(row.tier).toBe("unlocked");
    expect(row.capability).toBeUndefined();
    expect(row.class).toBe("mutate");
    expect(row.tier).toBe(ALLOWLIST["api.createChart"].tier);
    expect(row.class).toBe(ALLOWLIST["api.createTable"].class);
  });

  it("puts api.deleteShape on the same footing as deleteChart, reusing vObjectId", () => {
    const row = ALLOWLIST["api.deleteShape"];
    expect(row).toBeDefined();
    expect(row.tier).toBe("unlocked");
    expect(row.capability).toBeUndefined();
    expect(row.class).toBe("mutate");
    expect(row.validate).toBe(vObjectId);
    expect(row.validate).toBe(ALLOWLIST["api.deleteChart"].validate);
  });

  it("says PLAINLY in the consent text that neither is undoable", () => {
    // Control create/delete records no undo entry at all (controls.rs writes
    // metadata under a DocumentEffect and never calls record_cell_change). A
    // user consenting to "delete a shape" must not have to discover that Ctrl+Z
    // will not bring it back.
    expect(ALLOWLIST["api.createShape"].desc).toMatch(/not undoable/i);
    expect(ALLOWLIST["api.deleteShape"].desc).toMatch(/not undoable/i);
    expect(ALLOWLIST["api.deleteShape"].desc).toMatch(/Ctrl\+Z/);
  });

  it("does not enumerate 123 shape ids in the consent text", () => {
    // The catalog is discovered from the refusal (`createShape` throws with
    // every accepted id), never from a sentence a user has to read.
    const desc = ALLOWLIST["api.createShape"].desc;
    expect(desc.length).toBeLessThan(200);
    expect(desc).not.toContain("roundedRectangle");
  });

  it("says the active sheet is the target", () => {
    expect(ALLOWLIST["api.createShape"].desc).toMatch(/sheet currently shown/i);
    expect(ALLOWLIST["api.deleteShape"].desc).toMatch(/sheet currently shown/i);
  });
});

// ============================================================================
// 2. vCreateShape
// ============================================================================

describe("vCreateShape accepts a catalog id and an anchor, and nothing else", () => {
  it("accepts the ordinary call", () => {
    expect(vCreateShape(["rectangle", ANCHOR, undefined])).toBe(true);
    expect(vCreateShape(["roundedRectangle", ANCHOR])).toBe(true);
    expect(vCreateShape(["star5", ANCHOR, { width: 200, height: 150, text: "Hi", name: "Badge" }])).toBe(true);
  });

  it("refuses a shape id that is not shaped like one", () => {
    for (const bad of [
      "",                       // empty
      "Rectangle",              // ids start lower-case
      "rounded rectangle",      // space
      "../../etc/passwd",       // path-ish
      "rect;drop",              // punctuation
      "rect-angle",             // hyphen
      "a".repeat(65),           // over the bound
      42,
      null,
      { id: "rectangle" },
    ]) {
      expect(vCreateShape([bad, ANCHOR]), JSON.stringify(bad)).not.toBe(true);
    }
  });

  it("refuses a bad anchor", () => {
    expect(vCreateShape(["rectangle", undefined])).not.toBe(true);
    expect(vCreateShape(["rectangle", "B3"])).not.toBe(true); // resolved worker-side
    expect(vCreateShape(["rectangle", { row: -1, col: 0 }])).not.toBe(true);
    expect(vCreateShape(["rectangle", { row: 0, col: 1.5 }])).not.toBe(true);
    // A sheet cannot be smuggled in as an anchor key: the row is ACTIVE-SHEET
    // only, and an unknown key is refused rather than ignored.
    expect(vCreateShape(["rectangle", { row: 0, col: 0, sheetIndex: 3 }])).not.toBe(true);
  });

  it("refuses an option the row does not offer — including the two that hold ACTIONS", () => {
    // `onSelect` is inline source the click path feeds to the QuickJS module
    // runtime; `macroRef` re-points a control at any recorded macro. A sandboxed
    // script that could write either would be authoring code that later runs
    // with more reach than it has. They are not options here, and an unknown
    // key is a refusal rather than a silent drop.
    for (const bad of [
      { onSelect: "doEvil()" },
      { macroRef: "macro-payroll" },
      { src: "data:image/png;base64,AAAA" },
      { sheetIndex: 2 },
      { x: 0 },
      { fill: "#fff" },
    ]) {
      const verdict = vCreateShape(["rectangle", ANCHOR, bad]);
      expect(verdict, JSON.stringify(bad)).not.toBe(true);
      expect(String(verdict)).toMatch(/shape option/);
    }
  });

  it("bounds width and height exactly as a chart placement is bounded", () => {
    for (const k of ["width", "height"] as const) {
      expect(vCreateShape(["rectangle", ANCHOR, { [k]: 10 }])).toBe(true);
      expect(vCreateShape(["rectangle", ANCHOR, { [k]: 20_000 }])).toBe(true);
      expect(vCreateShape(["rectangle", ANCHOR, { [k]: 9 }])).not.toBe(true);
      expect(vCreateShape(["rectangle", ANCHOR, { [k]: 20_001 }])).not.toBe(true);
      expect(vCreateShape(["rectangle", ANCHOR, { [k]: Number.NaN }])).not.toBe(true);
      expect(vCreateShape(["rectangle", ANCHOR, { [k]: "120" }])).not.toBe(true);
    }
  });

  it("bounds the caption with the SAME number a later setProperty would use", () => {
    // One decision, not two: a shape created with `text` and a shape whose
    // `text` is set afterwards must not disagree about how much text it may
    // hold. `checkShapeSetProperty` uses MAX_SHAPE_PROPERTY_CHARS.
    expect(vCreateShape(["rectangle", ANCHOR, { text: "x".repeat(MAX_SHAPE_PROPERTY_CHARS) }])).toBe(true);
    expect(
      vCreateShape(["rectangle", ANCHOR, { text: "x".repeat(MAX_SHAPE_PROPERTY_CHARS + 1) }]),
    ).not.toBe(true);
  });

  it("bounds the name", () => {
    expect(vCreateShape(["rectangle", ANCHOR, { name: "n".repeat(255) }])).toBe(true);
    expect(vCreateShape(["rectangle", ANCHOR, { name: "n".repeat(256) }])).not.toBe(true);
    expect(vCreateShape(["rectangle", ANCHOR, { name: 7 }])).not.toBe(true);
  });
});

// ============================================================================
// 3. deleteShape reads its sheet OUT of the id
// ============================================================================

describe("a control id carries its own sheet, which is how the active-sheet rule is enforced", () => {
  it("round-trips through controlInstanceId", () => {
    expect(controlSheetFromInstanceId(controlInstanceId(3, 9, 2))).toBe(3);
    expect(controlSheetFromInstanceId(controlInstanceId(0, 0, 0))).toBe(0);
  });

  it("returns null for anything that is not a control id, so deleteShape refuses it", () => {
    for (const bad of ["", "control", "control-0-0", "chart-7", "control-x-1-1", "pane-abc"]) {
      expect(controlSheetFromInstanceId(bad), bad).toBeNull();
    }
  });

  it("takes no sheet argument at all — vObjectId is a single string", () => {
    expect(vObjectId(["control-0-2-1"])).toBe(true);
    expect(vObjectId([""])).not.toBe(true);
    expect(vObjectId([{ id: "control-0-2-1", sheetIndex: 4 }])).not.toBe(true);
  });
});
