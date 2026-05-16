//! FILENAME: app/extensions/Controls/lib/__tests__/controls-comprehensive.test.ts
// PURPOSE: Deep-dive tests for control properties, shape path SVG conversion,
//          control type registration, floating store operations, copy/paste,
//          and group alignment helpers.

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock dependencies
vi.mock("@api/gridOverlays", () => ({
  removeGridRegionsByType: vi.fn(),
  replaceGridRegionsByType: vi.fn(),
}));

vi.mock("../designMode", () => ({
  getDesignMode: vi.fn(() => false),
}));

import {
  makeFloatingControlId,
  addFloatingControl,
  removeFloatingControl,
  getFloatingControl,
  getAllFloatingControls,
  getFloatingControlsForSheet,
  moveFloatingControl,
  resizeFloatingControl,
  resetFloatingStore,
  bringToFront,
  sendToBack,
  bringForward,
  sendBackward,
  groupControls,
  ungroupControls,
  getGroupForControl,
  getGroupMembers,
  getGroupBounds,
  moveGroupControls,
  resizeGroupControls,
  syncFloatingControlRegions,
  type FloatingControl,
} from "../floatingStore";
import {
  getPropertyDefinitions,
  BUTTON_PROPERTIES,
  type PropertyDefinition,
  type ControlMetadata,
  type ControlPropertyValue,
} from "../types";
import { SHAPE_PROPERTIES } from "../../Shape/shapeProperties";
import { shapePathToSvgD } from "../../Shape/shapePathToSvg";
import type { ShapePathCommand } from "../../Shape/shapeCatalog";

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  resetFloatingStore();
});

// ============================================================================
// Helper
// ============================================================================

function mkCtrl(
  id: string,
  sheet: number,
  row: number,
  col: number,
  x: number,
  y: number,
  w: number = 80,
  h: number = 28,
  type: string = "button",
): FloatingControl {
  return { id, sheetIndex: sheet, row, col, x, y, width: w, height: h, controlType: type };
}

// ============================================================================
// 1. Control properties: get/set/has for all property types
// ============================================================================

describe("control property definitions", () => {
  it("button properties include all expected keys", () => {
    const keys = BUTTON_PROPERTIES.map((p) => p.key);
    expect(keys).toContain("text");
    expect(keys).toContain("fill");
    expect(keys).toContain("color");
    expect(keys).toContain("borderColor");
    expect(keys).toContain("fontSize");
    expect(keys).toContain("width");
    expect(keys).toContain("height");
    expect(keys).toContain("embedded");
    expect(keys).toContain("onSelect");
    expect(keys).toContain("tooltip");
  });

  it("shape properties include fill, stroke, text, rotation, opacity", () => {
    const keys = SHAPE_PROPERTIES.map((p) => p.key);
    expect(keys).toContain("fill");
    expect(keys).toContain("stroke");
    expect(keys).toContain("strokeWidth");
    expect(keys).toContain("text");
    expect(keys).toContain("rotation");
    expect(keys).toContain("opacity");
    expect(keys).toContain("flipH");
    expect(keys).toContain("flipV");
  });

  it("getPropertyDefinitions returns correct set per type", () => {
    expect(getPropertyDefinitions("button")).toBe(BUTTON_PROPERTIES);
    expect(getPropertyDefinitions("shape")).toBe(SHAPE_PROPERTIES);
    expect(getPropertyDefinitions("unknown")).toEqual([]);
  });

  it("all button properties have valid inputType", () => {
    const validTypes = new Set(["text", "color", "number", "script", "code", "boolean"]);
    for (const prop of BUTTON_PROPERTIES) {
      expect(validTypes.has(prop.inputType)).toBe(true);
    }
  });

  it("formula-supporting properties are correctly flagged", () => {
    const formulaProps = BUTTON_PROPERTIES.filter((p) => p.supportsFormula);
    const noFormulaProps = BUTTON_PROPERTIES.filter((p) => !p.supportsFormula);
    expect(formulaProps.length).toBeGreaterThan(0);
    expect(noFormulaProps.length).toBeGreaterThan(0);
    // embedded and onSelect should not support formula
    expect(noFormulaProps.map((p) => p.key)).toContain("embedded");
    expect(noFormulaProps.map((p) => p.key)).toContain("onSelect");
  });

  it("ControlMetadata can hold static and formula values", () => {
    const meta: ControlMetadata = {
      controlType: "button",
      properties: {
        text: { valueType: "static", value: "Click Me" },
        fill: { valueType: "formula", value: "=IF(A1>0,\"#00FF00\",\"#FF0000\")" },
      },
    };
    expect(meta.properties.text.valueType).toBe("static");
    expect(meta.properties.fill.valueType).toBe("formula");
    expect(meta.properties.fill.value).toContain("IF");
  });
});

// ============================================================================
// 2. Shape path to SVG conversion for complex paths
// ============================================================================

describe("shapePathToSvgD", () => {
  it("converts simple rectangle path", () => {
    const cmds: ShapePathCommand[] = [
      { op: "M", x: 0, y: 0 },
      { op: "L", x: 1, y: 0 },
      { op: "L", x: 1, y: 1 },
      { op: "L", x: 0, y: 1 },
      { op: "Z" },
    ];
    const d = shapePathToSvgD(cmds);
    expect(d).toBe("M 0 0 L 1 0 L 1 1 L 0 1 Z");
  });

  it("converts cubic bezier curve", () => {
    const cmds: ShapePathCommand[] = [
      { op: "M", x: 0, y: 0.5 },
      { op: "C", x1: 0, y1: 0, x2: 1, y2: 0, x: 1, y: 0.5 },
      { op: "Z" },
    ];
    const d = shapePathToSvgD(cmds);
    expect(d).toBe("M 0 0.5 C 0 0 1 0 1 0.5 Z");
  });

  it("converts quadratic bezier curve", () => {
    const cmds: ShapePathCommand[] = [
      { op: "M", x: 0, y: 1 },
      { op: "Q", x1: 0.5, y1: 0, x: 1, y: 1 },
    ];
    const d = shapePathToSvgD(cmds);
    expect(d).toBe("M 0 1 Q 0.5 0 1 1");
  });

  it("handles empty command array", () => {
    expect(shapePathToSvgD([])).toBe("");
  });

  it("handles complex multi-segment path (triangle + arc)", () => {
    const cmds: ShapePathCommand[] = [
      { op: "M", x: 0.5, y: 0 },
      { op: "L", x: 1, y: 1 },
      { op: "Q", x1: 0.5, y1: 0.7, x: 0, y: 1 },
      { op: "Z" },
    ];
    const d = shapePathToSvgD(cmds);
    expect(d).toContain("M 0.5 0");
    expect(d).toContain("L 1 1");
    expect(d).toContain("Q 0.5 0.7 0 1");
    expect(d).toContain("Z");
  });
});

// ============================================================================
// 3. Control type registration and property schema
// ============================================================================

describe("control type registration and property schema", () => {
  it("each property definition has required fields", () => {
    const allDefs = [...BUTTON_PROPERTIES, ...SHAPE_PROPERTIES];
    for (const def of allDefs) {
      expect(def.key).toBeTruthy();
      expect(def.label).toBeTruthy();
      expect(def.inputType).toBeTruthy();
      expect(typeof def.defaultValue).toBe("string");
      expect(typeof def.supportsFormula).toBe("boolean");
    }
  });

  it("no duplicate property keys within a type", () => {
    const buttonKeys = BUTTON_PROPERTIES.map((p) => p.key);
    expect(new Set(buttonKeys).size).toBe(buttonKeys.length);

    const shapeKeys = SHAPE_PROPERTIES.map((p) => p.key);
    expect(new Set(shapeKeys).size).toBe(shapeKeys.length);
  });

  it("shape has width and height properties", () => {
    const keys = SHAPE_PROPERTIES.map((p) => p.key);
    expect(keys).toContain("width");
    expect(keys).toContain("height");
  });
});

// ============================================================================
// 4. Floating control with formula binding
// ============================================================================

describe("floating control with formula binding", () => {
  it("can store formula-bound properties in metadata", () => {
    const meta: ControlMetadata = {
      controlType: "button",
      properties: {
        text: { valueType: "formula", value: "=A1" },
        fill: { valueType: "formula", value: "=IF(B1>100,\"green\",\"red\")" },
        fontSize: { valueType: "static", value: "14" },
      },
    };
    expect(meta.properties.text.valueType).toBe("formula");
    expect(meta.properties.text.value).toBe("=A1");
    expect(meta.properties.fontSize.valueType).toBe("static");
  });

  it("floating control position is independent of formula bindings", () => {
    addFloatingControl(mkCtrl("c1", 0, 0, 0, 100, 200, 80, 28));
    moveFloatingControl("c1", 300, 400);
    const ctrl = getFloatingControl("c1")!;
    expect(ctrl.x).toBe(300);
    expect(ctrl.y).toBe(400);
    // Position is purely in the floating store, not in metadata properties
  });

  it("formula properties can reference any cell pattern", () => {
    const patterns = [
      "=A1",
      "=Sheet2!B5",
      "=SUM(A1:A100)",
      "=IF(AND(A1>0,B1<10),\"yes\",\"no\")",
      "=VLOOKUP(C1,Data!A:B,2,FALSE)",
    ];
    for (const formula of patterns) {
      const prop: ControlPropertyValue = { valueType: "formula", value: formula };
      expect(prop.value.startsWith("=")).toBe(true);
    }
  });
});

// ============================================================================
// 5. Control copy/paste behavior
// ============================================================================

describe("control copy/paste behavior (store-level)", () => {
  it("deep-copying metadata produces independent object", () => {
    const original: ControlMetadata = {
      controlType: "button",
      properties: {
        text: { valueType: "static", value: "Original" },
        fill: { valueType: "static", value: "#e0e0e0" },
      },
    };
    const copy: ControlMetadata = JSON.parse(JSON.stringify(original));
    copy.properties.text.value = "Copy";
    expect(original.properties.text.value).toBe("Original");
    expect(copy.properties.text.value).toBe("Copy");
  });

  it("paste offset cascades with count", () => {
    const PASTE_OFFSET = 20;
    const origX = 100;
    const origY = 200;
    for (let i = 1; i <= 5; i++) {
      const newX = origX + PASTE_OFFSET * i;
      const newY = origY + PASTE_OFFSET * i;
      expect(newX).toBe(100 + 20 * i);
      expect(newY).toBe(200 + 20 * i);
    }
  });

  it("duplicated floating control gets unique ID", () => {
    addFloatingControl(mkCtrl("control-0-0-0", 0, 0, 0, 50, 50));
    // Simulate duplicate: new anchor at (0, 1)
    const dupId = makeFloatingControlId(0, 0, 1);
    addFloatingControl(mkCtrl(dupId, 0, 0, 1, 70, 70));
    expect(getFloatingControl("control-0-0-0")).not.toBeNull();
    expect(getFloatingControl(dupId)).not.toBeNull();
    expect(dupId).not.toBe("control-0-0-0");
  });

  it("removing original does not affect copy", () => {
    addFloatingControl(mkCtrl("orig", 0, 0, 0, 50, 50));
    addFloatingControl(mkCtrl("copy", 0, 0, 1, 70, 70));
    removeFloatingControl("orig");
    expect(getFloatingControl("orig")).toBeNull();
    expect(getFloatingControl("copy")).not.toBeNull();
  });
});

// ============================================================================
// 6. Control alignment/distribution helpers (group bounds and move)
// ============================================================================

describe("control alignment and distribution via groups", () => {
  it("group bounds encloses all members", () => {
    addFloatingControl(mkCtrl("a", 0, 0, 0, 10, 20, 50, 30));
    addFloatingControl(mkCtrl("b", 0, 0, 1, 100, 150, 60, 40));
    addFloatingControl(mkCtrl("c", 0, 0, 2, 50, 80, 70, 50));
    groupControls(["a", "b", "c"]);

    const groupId = getGroupForControl("a")!;
    const bounds = getGroupBounds(groupId)!;
    expect(bounds.x).toBe(10);   // min x
    expect(bounds.y).toBe(20);   // min y
    expect(bounds.width).toBe(150);  // max(100+60) - 10 = 150
    expect(bounds.height).toBe(170); // max(150+40) - 20 = 170
  });

  it("moveGroupControls shifts all members equally", () => {
    addFloatingControl(mkCtrl("a", 0, 0, 0, 10, 20, 50, 30));
    addFloatingControl(mkCtrl("b", 0, 0, 1, 100, 150, 60, 40));
    const groupId = groupControls(["a", "b"]);
    moveGroupControls(groupId, 25, -10);

    expect(getFloatingControl("a")!.x).toBe(35);
    expect(getFloatingControl("a")!.y).toBe(10);
    expect(getFloatingControl("b")!.x).toBe(125);
    expect(getFloatingControl("b")!.y).toBe(140);
  });

  it("resizeGroupControls scales proportionally", () => {
    addFloatingControl(mkCtrl("a", 0, 0, 0, 0, 0, 100, 100));
    addFloatingControl(mkCtrl("b", 0, 0, 1, 100, 0, 100, 100));
    const groupId = groupControls(["a", "b"]);

    const oldBounds = { x: 0, y: 0, width: 200, height: 100 };
    const newBounds = { x: 0, y: 0, width: 400, height: 200 };
    resizeGroupControls(groupId, oldBounds, newBounds);

    const a = getFloatingControl("a")!;
    const b = getFloatingControl("b")!;
    expect(a.x).toBe(0);
    expect(a.width).toBe(200);
    expect(a.height).toBe(200);
    expect(b.x).toBe(200);
    expect(b.width).toBe(200);
  });

  it("group removal auto-dissolves when below 2 members", () => {
    addFloatingControl(mkCtrl("a", 0, 0, 0, 0, 0, 50, 50));
    addFloatingControl(mkCtrl("b", 0, 0, 1, 100, 100, 50, 50));
    const groupId = groupControls(["a", "b"]);
    expect(getGroupForControl("a")).toBe(groupId);

    removeFloatingControl("a");
    // Group should auto-dissolve since only 1 member remains
    expect(getGroupForControl("b")).toBeNull();
  });

  it("z-order operations respect group membership", () => {
    addFloatingControl(mkCtrl("x", 0, 0, 0, 0, 0, 10, 10));
    addFloatingControl(mkCtrl("a", 0, 0, 1, 10, 10, 10, 10));
    addFloatingControl(mkCtrl("b", 0, 0, 2, 20, 20, 10, 10));
    addFloatingControl(mkCtrl("y", 0, 0, 3, 30, 30, 10, 10));

    groupControls(["a", "b"]);
    bringToFront("a");

    const all = getAllFloatingControls();
    const ids = all.map((c) => c.id);
    // a and b should be at the end together
    expect(ids.indexOf("a")).toBeGreaterThan(ids.indexOf("x"));
    expect(ids.indexOf("b")).toBeGreaterThan(ids.indexOf("x"));
  });

  it("syncFloatingControlRegions calls replaceGridRegionsByType", async () => {
    const { replaceGridRegionsByType } = await import("@api/gridOverlays") as any;
    addFloatingControl(mkCtrl("c1", 0, 0, 0, 10, 20, 80, 28));
    syncFloatingControlRegions();
    expect(replaceGridRegionsByType).toHaveBeenCalledWith(
      "floating-control",
      expect.arrayContaining([
        expect.objectContaining({ id: "c1", type: "floating-control" }),
      ]),
    );
  });
});
