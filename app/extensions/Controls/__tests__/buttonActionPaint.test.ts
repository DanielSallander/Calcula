//! FILENAME: app/extensions/Controls/__tests__/buttonActionPaint.test.ts
// PURPOSE: How a floating button shows its declarative action (Canvas contract
//          §4.4, Button/actionGlyph.ts): Back and Clear all slicers draw their
//          picture, a navigation button does not; a navigation button to the
//          page ON SCREEN is drawn selected (a page navigator's current tab);
//          and the renderer actually asks these questions.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  actionGlyphMetrics,
  actionGlyphOf,
  drawActionGlyph,
  isCurrentPageButton,
  type GlyphContext,
} from "../Button/actionGlyph";

describe("the action glyph", () => {
  it("is drawn for Back and Clear all slicers, not for a navigation button or none", () => {
    expect(actionGlyphOf({ kind: "back" })).toBe("back");
    expect(actionGlyphOf({ kind: "clearSlicers" })).toBe("clearSlicers");
    expect(actionGlyphOf({ kind: "navigate", sheetName: "P" })).toBeNull();
    expect(actionGlyphOf(undefined)).toBeNull();
  });

  it("strokes in the caption colour inside its square", () => {
    const points: Array<[number, number]> = [];
    let strokes = 0;
    const ctx: GlyphContext = {
      beginPath() {},
      closePath() {},
      moveTo(x: number, y: number) {
        points.push([x, y]);
      },
      lineTo(x: number, y: number) {
        points.push([x, y]);
      },
      stroke() {
        strokes++;
      },
      save() {},
      restore() {},
      lineWidth: 0,
      strokeStyle: "",
      lineCap: "butt",
      lineJoin: "miter",
    };
    for (const glyph of ["back", "clearSlicers"] as const) {
      points.length = 0;
      drawActionGlyph(ctx, glyph, 100, 50, 12, "#123456");
      expect(ctx.strokeStyle).toBe("#123456");
      expect(points.length).toBeGreaterThan(3);
      for (const [x, y] of points) {
        expect(x).toBeGreaterThanOrEqual(100);
        expect(x).toBeLessThanOrEqual(112);
        expect(y).toBeGreaterThanOrEqual(50);
        expect(y).toBeLessThanOrEqual(62);
      }
    }
    expect(strokes).toBe(2);
  });

  it("scales with the caption", () => {
    expect(actionGlyphMetrics(11).size).toBeGreaterThanOrEqual(10);
    expect(actionGlyphMetrics(24).size).toBeGreaterThan(actionGlyphMetrics(11).size);
  });
});

describe("the current page's navigation button", () => {
  it("is the one whose page is on screen (names compare as sheet names do)", () => {
    expect(isCurrentPageButton({ kind: "navigate", sheetName: "Overview" }, "Overview")).toBe(true);
    expect(isCurrentPageButton({ kind: "navigate", sheetName: "overview" }, "Overview")).toBe(true);
    expect(isCurrentPageButton({ kind: "navigate", sheetName: "Details" }, "Overview")).toBe(false);
    expect(isCurrentPageButton({ kind: "back" }, "Overview")).toBe(false);
    expect(isCurrentPageButton(undefined, "Overview")).toBe(false);
  });

  // SABOTAGE: drop `|| currentPage` from the wash condition -> red.
  it("is painted with the pressed wash, and the glyph is drawn, by the renderer", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../Button/floatingRenderer.ts"), "utf8");
    expect(src).toMatch(/if \(pressed \|\| currentPage\) \{/);
    expect(src).toMatch(/drawActionGlyph\(ctx, glyph,/);
    expect(src).toMatch(/getFloatingControl\(controlId\)\?\.buttonAction/);
  });
});
