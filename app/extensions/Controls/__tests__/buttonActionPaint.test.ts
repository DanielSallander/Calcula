//! FILENAME: app/extensions/Controls/__tests__/buttonActionPaint.test.ts
// PURPOSE: How a floating button shows its declarative action (Canvas contract
//          §4.4, Button/actionGlyph.ts): Back and Clear all slicers draw their
//          picture, a navigation button does not; a navigation button to the
//          page ON SCREEN is drawn selected (a page navigator's current tab);
//          and the renderer actually asks these questions.

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { ReportPagesSnapshot } from "@api/reportPages";

// The grid's sheet context and the page list the renderer reads the active
// sheet's ID from (@api/reportPages `sheetIdAt`).
const h = vi.hoisted(() => ({
  activeIndex: 0,
  activeName: "",
  snapshot: null as unknown,
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: h.activeIndex, activeSheetName: h.activeName } }),
}));
vi.mock("@api/reportPages", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getReportPagesSnapshot: () => h.snapshot,
}));
vi.mock("@api/gridOverlays", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/gridOverlays")>()),
  requestOverlayRedraw: () => {},
}));
// An empty property bag: the renderer paints its defaults and fetches nothing further.
vi.mock("../lib/controlApi", () => ({ resolveControlProperties: async () => ({}) }));
import {
  actionGlyphMetrics,
  actionGlyphOf,
  drawActionGlyph,
  isCurrentPageButton,
  type GlyphContext,
} from "../Button/actionGlyph";
import { BUTTON_PRESSED_SHADE, renderFloatingButton } from "../Button/floatingRenderer";
import { addFloatingControl, getAllFloatingControls, removeFloatingControl } from "../lib/floatingStore";

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
  it("BY ID when both the action and the active sheet have one: the id wins over a stale or shared name", () => {
    const toA = { kind: "navigate" as const, sheetId: "id-a", sheetName: "Overview" };
    expect(isCurrentPageButton(toA, { sheetId: "id-a", sheetName: "Overview" })).toBe(true);
    expect(isCurrentPageButton(toA, { sheetId: "id-a", sheetName: "Renamed while on screen" })).toBe(true);
    expect(
      isCurrentPageButton(toA, { sheetId: "id-b", sheetName: "Overview" }),
      "another sheet that took the old name was taken for the button's page",
    ).toBe(false);
  });

  it("by NAME (as sheet names compare) when either side has no id", () => {
    expect(isCurrentPageButton({ kind: "navigate", sheetName: "Overview" }, { sheetId: "id-a", sheetName: "Overview" })).toBe(true);
    expect(isCurrentPageButton({ kind: "navigate", sheetName: "overview" }, { sheetName: "Overview" })).toBe(true);
    expect(
      isCurrentPageButton({ kind: "navigate", sheetId: "id-a", sheetName: "Overview" }, { sheetId: null, sheetName: "Overview" }),
    ).toBe(true);
    expect(isCurrentPageButton({ kind: "navigate", sheetName: "Details" }, { sheetName: "Overview" })).toBe(false);
    expect(isCurrentPageButton({ kind: "navigate", sheetName: "Details" }, {})).toBe(false);
    expect(isCurrentPageButton({ kind: "back" }, { sheetId: "id-a", sheetName: "Overview" })).toBe(false);
    expect(isCurrentPageButton(undefined, { sheetName: "Overview" })).toBe(false);
  });

  // SABOTAGE: drop `|| currentPage` from the wash condition -> red.
  it("is painted with the pressed wash, and the glyph is drawn, by the renderer", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../Button/floatingRenderer.ts"), "utf8");
    expect(src).toMatch(/if \(pressed \|\| currentPage\) \{/);
    expect(src).toMatch(/drawActionGlyph\(ctx, glyph,/);
    expect(src).toMatch(/getFloatingControl\(controlId\)\?\.buttonAction/);
  });
});

describe("the renderer asks by id, through the page list's id of the ACTIVE sheet (any kind)", () => {
  const ID = "control-0-2-1";

  /** Paint the button with a context that records every fill (style + alpha). */
  function paintFills(): Array<{ style: unknown; alpha: number }> {
    const fills: Array<{ style: unknown; alpha: number }> = [];
    const target: Record<string, unknown> = {
      globalAlpha: 1,
      fillStyle: "#000",
      fill: () => fills.push({ style: target.fillStyle, alpha: target.globalAlpha as number }),
      measureText: () => ({ width: 10 }),
    };
    const ctx = new Proxy(target, {
      get: (obj, prop) => (prop in obj ? obj[prop as string] : () => undefined),
      set: (obj, prop, value) => {
        obj[prop as string] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    renderFloatingButton({
      ctx,
      canvasWidth: 2000,
      canvasHeight: 2000,
      config: { rowHeaderWidth: 50, colHeaderHeight: 24 },
      viewport: { scrollX: 0, scrollY: 0 },
      region: {
        id: ID,
        type: "floating-control",
        floating: { x: 64, y: 64, width: 160, height: 40 },
        data: { controlType: "button", sheetIndex: 0, row: 2, col: 1, movable: false },
      },
    } as never);
    return fills;
  }
  const washed = (fills: Array<{ style: unknown; alpha: number }>) =>
    fills.some((f) => f.style === "#000000" && f.alpha === BUTTON_PRESSED_SHADE);

  beforeEach(() => {
    for (const c of getAllFloatingControls()) removeFloatingControl(c.id);
    // A navigation button aimed at a WORKSHEET ("Data", id ws-1, at index 3).
    addFloatingControl({
      id: ID,
      sheetIndex: 0,
      row: 2,
      col: 1,
      x: 64,
      y: 64,
      width: 160,
      height: 40,
      controlType: "button",
      buttonAction: { kind: "navigate", sheetId: "ws-1", sheetName: "Data" },
    });
    // The page list knows every sheet's id by index -- worksheets too.
    h.snapshot = {
      pages: [],
      sheetIdByIndex: new Map([
        [0, "ws-0"],
        [3, "ws-1"],
      ]),
      activeIndex: 3,
      version: 1,
    } satisfies ReportPagesSnapshot;
  });

  // SABOTAGE: pass `sheetId: undefined` in floatingRenderer.ts -> red.
  it("a button aimed at a WORKSHEET that was renamed while active still paints current", () => {
    h.activeIndex = 3;
    h.activeName = "Data (renamed)";
    expect(washed(paintFills()), "the renamed active worksheet's button lost its current-page wash").toBe(true);
  });

  it("another sheet that took the old name does not make the button current", () => {
    h.activeIndex = 0;
    h.activeName = "Data";
    expect(washed(paintFills())).toBe(false);
  });
});
