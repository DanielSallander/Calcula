//! FILENAME: app/extensions/Controls/__tests__/controlZoneAt.test.ts
// PURPOSE: The floating control's ONE zone answer (lib/controlZoneAt.ts,
//          BUG-0258 design phases 2 and 4c), through Core's rule
//          (`resolveFloatingZone`): a RUN-MODE button is CONTENT with a hand
//          and part 'button' -- its press is the button's, run at the release
//          inside it (lib/buttonPress.ts) -- on every surface, locked and
//          subscribed included; a Page Navigator answers per ITEM (content in
//          run mode, frame with the item part in Design Mode); everything else
//          is whole-body frame.
// CONTEXT: A run-mode button is published `movable: false`. As FRAME (phase 2)
//          its press selected it and `floatingObject:selected` RAN it on the
//          press; as content Core hands the press to `bodyDragStart` and never
//          moves the button. The registration lives in index.ts, whose one line
//          is pinned by reading the source (the Charts wiring tests' precedent).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  registerGridOverlay,
  resolveFloatingZone,
  type GridRegion,
  type OverlayHitTestContext,
} from "@api/gridOverlays";
import { registerLayoutSurfaceProvider, type LayoutSurface } from "@api/layoutSurface";
import { floatingControlZoneAt } from "../lib/controlZoneAt";
import type { ReportPagesSnapshot } from "@api/reportPages";

// The live page list a Page Navigator derives its items from (two pages).
const h = vi.hoisted(() => ({ snapshot: null as unknown }));
vi.mock("@api/reportPages", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getReportPagesSnapshot: () => h.snapshot,
}));
const TWO_PAGES: ReportPagesSnapshot = {
  pages: [
    { sheetId: "id-1", name: "Overview", index: 1, visibility: "visible", isTooltipPage: false },
    { sheetId: "id-2", name: "Sales", index: 2, visibility: "visible", isTooltipPage: false },
  ],
  sheetIdByIndex: new Map([
    [1, "id-1"],
    [2, "id-2"],
  ]),
  activeIndex: 1,
  version: 1,
};
h.snapshot = TWO_PAGES;

/** A control's region exactly as floatingStore.syncFloatingControlRegions publishes it. */
function control(controlType: string, designMode: boolean): OverlayHitTestContext {
  const movable = designMode || controlType === "shape" || controlType === "image";
  const region: GridRegion = {
    id: `ctl-${controlType}`,
    type: "floating-control",
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 100, y: 50, width: 120, height: 40 },
    data: { sheetIndex: 0, row: 2, col: 1, controlType, movable, resizable: movable },
  };
  return { region, canvasX: 150, canvasY: 70, row: 0, col: 0, floatingCanvasBounds: { x: 100, y: 50, width: 120, height: 40 } };
}

/**
 * A Page Navigator region at canvas (100, 50), 120 x 40, pressed at (x, 70).
 * With the defaults (gap 8, no padding) its two items are x 100..156 and
 * 164..220; 156..164 is the gap.
 */
function navigator(designMode: boolean, x: number): OverlayHitTestContext {
  const ctx = control("pageNavigator", designMode);
  return { ...ctx, region: { ...ctx.region, id: "control-0-2-1" }, canvasX: x, canvasY: 70 };
}

let cleanups: Array<() => void> = [];

function useSurface(s: Partial<LayoutSurface>): void {
  const surface: LayoutSurface = {
    snapToGrid: false,
    gridSize: 25,
    showGrid: false,
    page: { width: 1280, height: 720 },
    editable: true,
    ...s,
  };
  cleanups.push(registerLayoutSurfaceProvider({ get: () => surface }));
}

beforeEach(() => {
  cleanups.push(registerGridOverlay({ type: "floating-control", render: () => {}, zoneAt: floatingControlZoneAt }));
});

afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
});

describe("the floating control's zone, through Core's rule", () => {
  it("a RUN-MODE button is CONTENT: a hand, part 'button', and it cannot move", () => {
    expect(floatingControlZoneAt(control("button", false))).toEqual({ kind: "content", cursor: "pointer", part: "button" });
    expect(resolveFloatingZone(control("button", false))).toEqual({
      kind: "content",
      part: "button",
      cursor: "pointer",
      canMove: false,
    });
  });

  it("a run-mode button stays CONTENT on a LOCKED canvas and on a SUBSCRIBED page (running a report's button is not editing it)", () => {
    useSurface({ isLocked: () => true });
    expect(resolveFloatingZone(control("button", false))).toMatchObject({ kind: "content", part: "button", cursor: "pointer" });
    cleanups.pop()?.();
    useSurface({ editable: false });
    expect(resolveFloatingZone(control("button", false))).toMatchObject({ kind: "content", part: "button", cursor: "pointer" });
  });

  it("a DESIGN-MODE button is plain frame: 'move' (moving a button still needs Design Mode)", () => {
    expect(floatingControlZoneAt(control("button", true))).toBeNull();
    expect(resolveFloatingZone(control("button", true))).toEqual({ kind: "frame", part: null, cursor: "move", canMove: true });
  });

  it("a shape and a picture are frame: they move by their body ('move'), and on a LOCKED canvas show 'default'", () => {
    for (const type of ["shape", "image"]) {
      for (const design of [false, true]) {
        expect(floatingControlZoneAt(control(type, design)), `${type} design=${design}`).toBeNull();
      }
    }
    expect(resolveFloatingZone(control("shape", false))).toMatchObject({ kind: "frame", cursor: "move", canMove: true });
    expect(resolveFloatingZone(control("image", false))).toMatchObject({ kind: "frame", cursor: "move", canMove: true });
    useSurface({ isLocked: () => true });
    expect(resolveFloatingZone(control("shape", false))).toMatchObject({ kind: "frame", cursor: "default", canMove: false });
  });
});

describe("a Page Navigator (WP-B, D-NAV): per item in run mode, frame with the item part in Design Mode", () => {
  it("RUN MODE over an item: CONTENT with a hand and part navItem:<sheetId>; it cannot move", () => {
    expect(floatingControlZoneAt(navigator(false, 120))).toEqual({ kind: "content", cursor: "pointer", part: "navItem:id-1" });
    expect(floatingControlZoneAt(navigator(false, 200))).toEqual({ kind: "content", cursor: "pointer", part: "navItem:id-2" });
    expect(resolveFloatingZone(navigator(false, 200))).toEqual({
      kind: "content",
      part: "navItem:id-2",
      cursor: "pointer",
      canMove: false,
    });
  });

  it("RUN MODE over the gap: content with the plain pointer and part navGap (never the frame)", () => {
    expect(floatingControlZoneAt(navigator(false, 160))).toEqual({ kind: "content", cursor: "default", part: "navGap" });
    expect(resolveFloatingZone(navigator(false, 160))).toMatchObject({ kind: "content", part: "navGap", cursor: "default" });
  });

  it("a run-mode item stays CONTENT on a LOCKED canvas and on a SUBSCRIBED page", () => {
    useSurface({ isLocked: () => true });
    expect(resolveFloatingZone(navigator(false, 120))).toMatchObject({ kind: "content", part: "navItem:id-1", cursor: "pointer" });
    cleanups.pop()?.();
    useSurface({ editable: false });
    expect(resolveFloatingZone(navigator(false, 120))).toMatchObject({ kind: "content", part: "navItem:id-1", cursor: "pointer" });
  });

  it("DESIGN MODE: FRAME (Core selects and moves it), carrying the item part -- or navGap -- for the second press", () => {
    expect(floatingControlZoneAt(navigator(true, 120))).toEqual({ kind: "frame", part: "navItem:id-1" });
    expect(floatingControlZoneAt(navigator(true, 160))).toEqual({ kind: "frame", part: "navGap" });
    expect(resolveFloatingZone(navigator(true, 200))).toEqual({ kind: "frame", part: "navItem:id-2", cursor: "move", canMove: true });
  });

  it("the items follow the live page list (a page added later is a new item at once)", () => {
    h.snapshot = {
      ...TWO_PAGES,
      pages: [
        ...TWO_PAGES.pages,
        { sheetId: "id-3", name: "Detail", index: 3, visibility: "visible", isTooltipPage: false },
      ],
    };
    try {
      // Three items now: 100..134.67, 142.67..177.33, 185.33..220.
      expect(floatingControlZoneAt(navigator(false, 200))).toMatchObject({ part: "navItem:id-3" });
      expect(floatingControlZoneAt(navigator(false, 160))).toMatchObject({ part: "navItem:id-2" });
    } finally {
      h.snapshot = TWO_PAGES;
    }
  });
});

describe("index.ts registers it as the floating control's zoneAt", () => {
  const src = readFileSync(resolve(__dirname, "../index.ts"), "utf8").replace(/\/\/.*$/gm, "");
  const at = src.indexOf('type: "floating-control"');
  const block = src.slice(src.lastIndexOf("register({", at), src.indexOf("});", at));

  it("zoneAt: floatingControlZoneAt, with no getCursor or claimsBodyDrag beside it", () => {
    expect(at, "the floating-control registration is gone").toBeGreaterThan(0);
    expect(block).toMatch(/zoneAt\s*:\s*floatingControlZoneAt\b/);
    expect(block).not.toMatch(/getCursor\s*:/);
    expect(block).not.toMatch(/claimsBodyDrag\s*:/);
  });
});
