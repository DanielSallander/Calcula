//! FILENAME: app/extensions/Controls/lib/__tests__/shapePathToSvg.test.ts
// PURPOSE: Tests for the shape path to SVG conversion utility.

import { describe, it, expect } from "vitest";
import { shapePathToSvgD } from "../../Shape/shapePathToSvg";
import type { ShapePathCommand } from "../../Shape/shapeCatalog";

// ============================================================================
// Tests
// ============================================================================

describe("shapePathToSvgD", () => {
  it("converts M and L commands", () => {
    const cmds: ShapePathCommand[] = [
      { op: "M", x: 0, y: 0 },
      { op: "L", x: 1, y: 0 },
      { op: "L", x: 1, y: 1 },
      { op: "Z" },
    ];
    expect(shapePathToSvgD(cmds)).toBe("M 0 0 L 1 0 L 1 1 Z");
  });

  it("converts cubic bezier (C) commands", () => {
    const cmds: ShapePathCommand[] = [
      { op: "M", x: 0, y: 0 },
      { op: "C", x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4, x: 0.5, y: 0.6 },
    ];
    expect(shapePathToSvgD(cmds)).toBe("M 0 0 C 0.1 0.2 0.3 0.4 0.5 0.6");
  });

  it("converts quadratic bezier (Q) commands", () => {
    const cmds: ShapePathCommand[] = [
      { op: "M", x: 0, y: 0 },
      { op: "Q", x1: 0.5, y1: 0, x: 1, y: 1 },
    ];
    expect(shapePathToSvgD(cmds)).toBe("M 0 0 Q 0.5 0 1 1");
  });

  it("returns empty string for empty array", () => {
    expect(shapePathToSvgD([])).toBe("");
  });

  it("handles Z-only (degenerate)", () => {
    expect(shapePathToSvgD([{ op: "Z" }])).toBe("Z");
  });

  it("handles a full rectangle path", () => {
    const rect: ShapePathCommand[] = [
      { op: "M", x: 0, y: 0 },
      { op: "L", x: 1, y: 0 },
      { op: "L", x: 1, y: 1 },
      { op: "L", x: 0, y: 1 },
      { op: "Z" },
    ];
    const result = shapePathToSvgD(rect);
    expect(result).toContain("M 0 0");
    expect(result).toContain("Z");
    expect(result.split(" L ").length).toBe(4); // "M 0 0" + 3 "L" segments
  });
});
