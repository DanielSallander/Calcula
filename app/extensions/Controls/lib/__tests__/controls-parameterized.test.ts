//! FILENAME: app/extensions/Controls/lib/__tests__/controls-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for control property definitions,
//          shapePathToSvg, move/resize, and z-order operations.

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock dependencies required by floatingStore
vi.mock("@api/gridOverlays", () => ({
  removeGridRegionsByType: vi.fn(),
  replaceGridRegionsByType: vi.fn(),
}));

vi.mock("../designMode", () => ({
  getDesignMode: vi.fn(() => false),
}));

import { BUTTON_PROPERTIES, getPropertyDefinitions } from "../types";
import { SHAPE_PROPERTIES } from "../../Shape/shapeProperties";
import { IMAGE_PROPERTIES } from "../../Image/imageProperties";
import { shapePathToSvgD } from "../../Shape/shapePathToSvg";
import type { ShapePathCommand } from "../../Shape/shapeCatalog";
import {
  addFloatingControl,
  getFloatingControl,
  getAllFloatingControls,
  moveFloatingControl,
  resizeFloatingControl,
  bringToFront,
  sendToBack,
  bringForward,
  sendBackward,
  resetFloatingStore,
  type FloatingControl,
} from "../floatingStore";

// ============================================================================
// Helpers
// ============================================================================

function makeCtrl(
  id: string,
  x = 0,
  y = 0,
  w = 100,
  h = 50,
): FloatingControl {
  return {
    id,
    sheetIndex: 0,
    row: 0,
    col: 0,
    x,
    y,
    width: w,
    height: h,
    controlType: "button",
  };
}

// ============================================================================
// 1. Property definitions: 4 control types x all property keys = 40+ tests
// ============================================================================

describe("property definitions parameterized", () => {
  const controlTypes: Array<{
    type: string;
    props: typeof BUTTON_PROPERTIES;
  }> = [
    { type: "button", props: BUTTON_PROPERTIES },
    { type: "shape", props: SHAPE_PROPERTIES },
    { type: "image", props: IMAGE_PROPERTIES },
  ];

  // Generate test cases for each control type x each property
  const propTestCases = controlTypes.flatMap(({ type, props }) =>
    props.map((prop) => ({
      controlType: type,
      key: prop.key,
      label: prop.label,
      inputType: prop.inputType,
      defaultValue: prop.defaultValue,
      supportsFormula: prop.supportsFormula,
    })),
  );

  it.each(propTestCases)(
    "$controlType property '$key' has valid definition",
    ({ controlType, key, label, inputType, defaultValue, supportsFormula }) => {
      expect(key).toBeTruthy();
      expect(key.length).toBeGreaterThan(0);
      expect(label).toBeTruthy();
      expect(label.length).toBeGreaterThan(0);
      expect(["text", "color", "number", "script", "code", "boolean"]).toContain(inputType);
      expect(typeof defaultValue).toBe("string");
      expect(typeof supportsFormula).toBe("boolean");

      // getPropertyDefinitions should return these
      const defs = getPropertyDefinitions(controlType);
      const found = defs.find((d) => d.key === key);
      expect(found).toBeDefined();
      expect(found!.label).toBe(label);
    },
  );

  // Unknown type returns empty
  it("unknown type returns empty array", () => {
    expect(getPropertyDefinitions("unknown")).toEqual([]);
  });

  // Verify unique keys within each control type
  it.each(controlTypes.map((ct) => ({ type: ct.type, props: ct.props })))(
    "$type has unique property keys",
    ({ props }) => {
      const keys = props.map((p) => p.key);
      expect(new Set(keys).size).toBe(keys.length);
    },
  );

  // Verify numeric defaults parse correctly
  const numericProps = propTestCases.filter((p) => p.inputType === "number");
  it.each(numericProps)(
    "$controlType.$key numeric default '$defaultValue' parses to number",
    ({ defaultValue }) => {
      const parsed = parseFloat(defaultValue);
      expect(isNaN(parsed)).toBe(false);
    },
  );

  // Verify color defaults are valid hex-ish
  const colorProps = propTestCases.filter((p) => p.inputType === "color");
  it.each(colorProps)(
    "$controlType.$key color default '$defaultValue' starts with #",
    ({ defaultValue }) => {
      expect(defaultValue.startsWith("#")).toBe(true);
    },
  );
});

// ============================================================================
// 2. shapePathToSvg: 20 path commands via it.each
// ============================================================================

describe("shapePathToSvgD parameterized", () => {
  const pathCases: Array<{
    label: string;
    commands: ShapePathCommand[];
    expected: string;
  }> = [
    { label: "empty", commands: [], expected: "" },
    { label: "single M", commands: [{ op: "M", x: 0, y: 0 }], expected: "M 0 0" },
    { label: "single L", commands: [{ op: "L", x: 1, y: 1 }], expected: "L 1 1" },
    { label: "single Z", commands: [{ op: "Z" }], expected: "Z" },
    {
      label: "M + L + Z (triangle)",
      commands: [{ op: "M", x: 0, y: 0 }, { op: "L", x: 1, y: 0 }, { op: "L", x: 0.5, y: 1 }, { op: "Z" }],
      expected: "M 0 0 L 1 0 L 0.5 1 Z",
    },
    {
      label: "quadratic Q",
      commands: [{ op: "Q", x1: 0.5, y1: 0, x: 1, y: 1 }],
      expected: "Q 0.5 0 1 1",
    },
    {
      label: "cubic C",
      commands: [{ op: "C", x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4, x: 0.5, y: 0.6 }],
      expected: "C 0.1 0.2 0.3 0.4 0.5 0.6",
    },
    {
      label: "rectangle (4 lines)",
      commands: [
        { op: "M", x: 0, y: 0 },
        { op: "L", x: 1, y: 0 },
        { op: "L", x: 1, y: 1 },
        { op: "L", x: 0, y: 1 },
        { op: "Z" },
      ],
      expected: "M 0 0 L 1 0 L 1 1 L 0 1 Z",
    },
    {
      label: "M + C + Z (curved shape)",
      commands: [
        { op: "M", x: 0, y: 0.5 },
        { op: "C", x1: 0, y1: 0, x2: 1, y2: 0, x: 1, y: 0.5 },
        { op: "C", x1: 1, y1: 1, x2: 0, y2: 1, x: 0, y: 0.5 },
        { op: "Z" },
      ],
      expected: "M 0 0.5 C 0 0 1 0 1 0.5 C 1 1 0 1 0 0.5 Z",
    },
    {
      label: "decimal coords",
      commands: [{ op: "M", x: 0.123, y: 0.456 }, { op: "L", x: 0.789, y: 0.012 }],
      expected: "M 0.123 0.456 L 0.789 0.012",
    },
    {
      label: "negative coords",
      commands: [{ op: "M", x: -1, y: -2 }, { op: "L", x: -3, y: -4 }],
      expected: "M -1 -2 L -3 -4",
    },
    {
      label: "many moves",
      commands: [{ op: "M", x: 0, y: 0 }, { op: "M", x: 1, y: 1 }, { op: "M", x: 2, y: 2 }],
      expected: "M 0 0 M 1 1 M 2 2",
    },
    {
      label: "Q then L",
      commands: [{ op: "M", x: 0, y: 0 }, { op: "Q", x1: 0.5, y1: 1, x: 1, y: 0 }, { op: "L", x: 1, y: 1 }],
      expected: "M 0 0 Q 0.5 1 1 0 L 1 1",
    },
    {
      label: "star point",
      commands: [
        { op: "M", x: 0.5, y: 0 },
        { op: "L", x: 0.6, y: 0.4 },
        { op: "L", x: 1, y: 0.4 },
        { op: "L", x: 0.7, y: 0.6 },
        { op: "L", x: 0.8, y: 1 },
        { op: "L", x: 0.5, y: 0.75 },
        { op: "Z" },
      ],
      expected: "M 0.5 0 L 0.6 0.4 L 1 0.4 L 0.7 0.6 L 0.8 1 L 0.5 0.75 Z",
    },
    {
      label: "multiple Z",
      commands: [{ op: "M", x: 0, y: 0 }, { op: "L", x: 1, y: 1 }, { op: "Z" }, { op: "M", x: 2, y: 2 }, { op: "L", x: 3, y: 3 }, { op: "Z" }],
      expected: "M 0 0 L 1 1 Z M 2 2 L 3 3 Z",
    },
    {
      label: "zero coords",
      commands: [{ op: "M", x: 0, y: 0 }, { op: "L", x: 0, y: 0 }],
      expected: "M 0 0 L 0 0",
    },
    {
      label: "large coords",
      commands: [{ op: "M", x: 1000, y: 2000 }, { op: "L", x: 3000, y: 4000 }],
      expected: "M 1000 2000 L 3000 4000",
    },
    {
      label: "C followed by Q",
      commands: [
        { op: "C", x1: 0, y1: 0, x2: 0.5, y2: 0.5, x: 1, y: 0 },
        { op: "Q", x1: 0.5, y1: 1, x: 0, y: 0 },
      ],
      expected: "C 0 0 0.5 0.5 1 0 Q 0.5 1 0 0",
    },
    {
      label: "single point path",
      commands: [{ op: "M", x: 0.5, y: 0.5 }, { op: "Z" }],
      expected: "M 0.5 0.5 Z",
    },
    {
      label: "line shape (M + L)",
      commands: [{ op: "M", x: 0, y: 0.5 }, { op: "L", x: 1, y: 0.5 }],
      expected: "M 0 0.5 L 1 0.5",
    },
  ];

  it.each(pathCases)("$label", ({ commands, expected }) => {
    expect(shapePathToSvgD(commands)).toBe(expected);
  });
});

// ============================================================================
// 3. Move/resize: 30 position x delta combos
// ============================================================================

describe("move and resize parameterized", () => {
  beforeEach(() => resetFloatingStore());

  const moveCases: Array<{
    label: string;
    startX: number;
    startY: number;
    newX: number;
    newY: number;
  }> = [
    { label: "origin to 10,10", startX: 0, startY: 0, newX: 10, newY: 10 },
    { label: "50,50 to 100,200", startX: 50, startY: 50, newX: 100, newY: 200 },
    { label: "no movement", startX: 30, startY: 40, newX: 30, newY: 40 },
    { label: "move left", startX: 100, startY: 100, newX: 50, newY: 100 },
    { label: "move up", startX: 100, startY: 100, newX: 100, newY: 50 },
    { label: "large move", startX: 0, startY: 0, newX: 5000, newY: 3000 },
    { label: "fractional coords", startX: 10.5, startY: 20.7, newX: 30.3, newY: 40.1 },
    { label: "zero to zero", startX: 0, startY: 0, newX: 0, newY: 0 },
    { label: "near origin", startX: 1, startY: 1, newX: 2, newY: 2 },
    { label: "diagonal", startX: 10, startY: 10, newX: 200, newY: 200 },
    { label: "x only", startX: 50, startY: 75, newX: 150, newY: 75 },
    { label: "y only", startX: 50, startY: 75, newX: 50, newY: 300 },
    { label: "tiny move", startX: 100, startY: 100, newX: 101, newY: 100 },
    { label: "boundary 999", startX: 0, startY: 0, newX: 999, newY: 999 },
    { label: "from high pos", startX: 500, startY: 500, newX: 100, newY: 100 },
  ];

  it.each(moveCases)(
    "move: $label",
    ({ startX, startY, newX, newY }) => {
      const ctrl = makeCtrl("test-move", startX, startY);
      addFloatingControl(ctrl);
      moveFloatingControl("test-move", newX, newY);
      const result = getFloatingControl("test-move");
      expect(result).not.toBeNull();
      expect(result!.x).toBe(newX);
      expect(result!.y).toBe(newY);
      // Width and height unchanged
      expect(result!.width).toBe(100);
      expect(result!.height).toBe(50);
    },
  );

  const resizeCases: Array<{
    label: string;
    startW: number;
    startH: number;
    newX: number;
    newY: number;
    newW: number;
    newH: number;
  }> = [
    { label: "grow width", startW: 100, startH: 50, newX: 0, newY: 0, newW: 200, newH: 50 },
    { label: "grow height", startW: 100, startH: 50, newX: 0, newY: 0, newW: 100, newH: 100 },
    { label: "grow both", startW: 100, startH: 50, newX: 0, newY: 0, newW: 200, newH: 100 },
    { label: "shrink width", startW: 200, startH: 100, newX: 0, newY: 0, newW: 50, newH: 100 },
    { label: "shrink height", startW: 200, startH: 100, newX: 0, newY: 0, newW: 200, newH: 30 },
    { label: "shrink both", startW: 200, startH: 100, newX: 0, newY: 0, newW: 80, newH: 40 },
    { label: "no change", startW: 100, startH: 50, newX: 0, newY: 0, newW: 100, newH: 50 },
    { label: "move + resize", startW: 100, startH: 50, newX: 20, newY: 30, newW: 150, newH: 75 },
    { label: "minimum size", startW: 100, startH: 50, newX: 0, newY: 0, newW: 1, newH: 1 },
    { label: "large resize", startW: 50, startH: 50, newX: 0, newY: 0, newW: 2000, newH: 1000 },
    { label: "square", startW: 100, startH: 50, newX: 10, newY: 10, newW: 200, newH: 200 },
    { label: "wide thin", startW: 100, startH: 100, newX: 0, newY: 0, newW: 500, newH: 10 },
    { label: "narrow tall", startW: 100, startH: 100, newX: 0, newY: 0, newW: 10, newH: 500 },
    { label: "fractional", startW: 100, startH: 50, newX: 1.5, newY: 2.5, newW: 99.9, newH: 49.9 },
    { label: "exact doubles", startW: 50, startH: 25, newX: 0, newY: 0, newW: 100, newH: 50 },
  ];

  it.each(resizeCases)(
    "resize: $label",
    ({ startW, startH, newX, newY, newW, newH }) => {
      const ctrl = makeCtrl("test-resize", 0, 0, startW, startH);
      addFloatingControl(ctrl);
      resizeFloatingControl("test-resize", newX, newY, newW, newH);
      const result = getFloatingControl("test-resize");
      expect(result).not.toBeNull();
      expect(result!.x).toBe(newX);
      expect(result!.y).toBe(newY);
      expect(result!.width).toBe(newW);
      expect(result!.height).toBe(newH);
    },
  );
});

// ============================================================================
// 4. Z-order: 20 operation x state combos
// ============================================================================

describe("z-order operations parameterized", () => {
  beforeEach(() => resetFloatingStore());

  // Helper to get ordered IDs
  function getOrder(): string[] {
    return getAllFloatingControls().map((c) => c.id);
  }

  const zOrderCases: Array<{
    label: string;
    controls: string[];
    operation: "bringToFront" | "sendToBack" | "bringForward" | "sendBackward";
    target: string;
    expectedOrder: string[];
  }> = [
    // bringToFront
    { label: "front: last already at front", controls: ["a", "b", "c"], operation: "bringToFront", target: "c", expectedOrder: ["a", "b", "c"] },
    { label: "front: first to front", controls: ["a", "b", "c"], operation: "bringToFront", target: "a", expectedOrder: ["b", "c", "a"] },
    { label: "front: middle to front", controls: ["a", "b", "c"], operation: "bringToFront", target: "b", expectedOrder: ["a", "c", "b"] },
    { label: "front: 2 controls", controls: ["a", "b"], operation: "bringToFront", target: "a", expectedOrder: ["b", "a"] },
    { label: "front: single control", controls: ["a"], operation: "bringToFront", target: "a", expectedOrder: ["a"] },

    // sendToBack
    { label: "back: first already at back", controls: ["a", "b", "c"], operation: "sendToBack", target: "a", expectedOrder: ["a", "b", "c"] },
    { label: "back: last to back", controls: ["a", "b", "c"], operation: "sendToBack", target: "c", expectedOrder: ["c", "a", "b"] },
    { label: "back: middle to back", controls: ["a", "b", "c"], operation: "sendToBack", target: "b", expectedOrder: ["b", "a", "c"] },
    { label: "back: 2 controls", controls: ["a", "b"], operation: "sendToBack", target: "b", expectedOrder: ["b", "a"] },
    { label: "back: single control", controls: ["a"], operation: "sendToBack", target: "a", expectedOrder: ["a"] },

    // bringForward
    { label: "forward: first +1", controls: ["a", "b", "c"], operation: "bringForward", target: "a", expectedOrder: ["b", "a", "c"] },
    { label: "forward: middle +1", controls: ["a", "b", "c"], operation: "bringForward", target: "b", expectedOrder: ["a", "c", "b"] },
    { label: "forward: last noop", controls: ["a", "b", "c"], operation: "bringForward", target: "c", expectedOrder: ["a", "b", "c"] },
    { label: "forward: 4 items first", controls: ["a", "b", "c", "d"], operation: "bringForward", target: "a", expectedOrder: ["b", "a", "c", "d"] },
    { label: "forward: 4 items second", controls: ["a", "b", "c", "d"], operation: "bringForward", target: "b", expectedOrder: ["a", "c", "b", "d"] },

    // sendBackward
    { label: "backward: last -1", controls: ["a", "b", "c"], operation: "sendBackward", target: "c", expectedOrder: ["a", "c", "b"] },
    { label: "backward: middle -1", controls: ["a", "b", "c"], operation: "sendBackward", target: "b", expectedOrder: ["b", "a", "c"] },
    { label: "backward: first noop", controls: ["a", "b", "c"], operation: "sendBackward", target: "a", expectedOrder: ["a", "b", "c"] },
    { label: "backward: 4 items last", controls: ["a", "b", "c", "d"], operation: "sendBackward", target: "d", expectedOrder: ["a", "b", "d", "c"] },
    { label: "backward: 4 items third", controls: ["a", "b", "c", "d"], operation: "sendBackward", target: "c", expectedOrder: ["a", "c", "b", "d"] },
  ];

  it.each(zOrderCases)(
    "$label",
    ({ controls, operation, target, expectedOrder }) => {
      for (const id of controls) {
        addFloatingControl(makeCtrl(id));
      }

      const ops = { bringToFront, sendToBack, bringForward, sendBackward };
      ops[operation](target);

      expect(getOrder()).toEqual(expectedOrder);
    },
  );
});
