//! FILENAME: app/extensions/Controls/__tests__/controlMenuSizePosition.test.ts
// PURPOSE: A floating control's right-click menu carries "Size and
//          Position..." (BUG-0258 design phase 5b) -- the no-drag route every
//          object menu offers -- just above Delete, and running it opens the
//          dialog for THIS control's published region (@api/objectPosition's
//          opener). A RUN-MODE button keeps the row (its dialog opens
//          read-only, saying Design Mode is what lets it move); with no dialog
//          installed the row is omitted (this menu greys nothing out).
//          Through the real item model and the real floating store's published
//          regions.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let publishedRegions: unknown[] = [];

vi.mock("@api", () => ({
  ["AppEvents"]: { GRID_REFRESH: "grid:refresh" },
  gridExtensions: {
    registerContextMenuItems: vi.fn(),
    unregisterContextMenuItem: vi.fn(),
  },
  getShapeBitmap: () => null,
  hasShapeBitmapRenderer: () => false,
}));

vi.mock("@api/events", () => ({
  emitAppEvent: vi.fn(),
  onAppEvent: vi.fn(() => () => {}),
}));

vi.mock("@api/gridOverlays", async () => {
  const actual = await vi.importActual<typeof import("@api/gridOverlays")>("@api/gridOverlays");
  return {
    getGridRegions: () => publishedRegions,
    getLiveGridRegions: () => publishedRegions,
    onPointModeViewChanged: () => () => undefined,
    floatingHitOrder: actual.floatingHitOrder,
    replaceGridRegionsByType: (_type: string, regions: unknown[]) => {
      publishedRegions = regions;
    },
    removeGridRegionsByType: () => {
      publishedRegions = [];
    },
    requestOverlayRedraw: vi.fn(),
  };
});

import { buildControlObjectMenu } from "../lib/controlContextMenu";
import {
  addFloatingControl,
  resetFloatingStore,
  syncFloatingControlRegions,
  type FloatingControl,
} from "../lib/floatingStore";
import { registerObjectGeometryProvider, resetObjectGeometryProviders } from "@api/objectGeometry";
import { SIZE_AND_POSITION_LABEL, registerSizeAndPositionOpener, resetObjectPosition } from "@api/objectPosition";
import { setDesignMode } from "@api/designMode";
import type { GridRegion } from "@api/gridOverlays";

function control(row: number, controlType: string): FloatingControl {
  return {
    id: `control-0-${row}-0`,
    sheetIndex: 0,
    row,
    col: 0,
    x: 10,
    y: row * 50,
    width: 80,
    height: 30,
    controlType,
  } as FloatingControl;
}

const cleanups: Array<() => void> = [];

beforeEach(() => {
  setDesignMode(false);
  resetFloatingStore();
  resetObjectPosition();
  resetObjectGeometryProviders();
  cleanups.push(registerObjectGeometryProvider({ types: ["floating-control"], commit: async () => {} }));
  addFloatingControl(control(1, "shape"));
  addFloatingControl(control(2, "button"));
  syncFloatingControlRegions();
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  setDesignMode(false);
});

describe("the control menu's Size and Position...", () => {
  it("sits just above Delete and opens the dialog for THIS control's region", () => {
    const opened: GridRegion[] = [];
    cleanups.push(registerSizeAndPositionOpener((r) => opened.push(r)));
    const items = buildControlObjectMenu("control-0-1-0");
    const ids = items.map((i) => i.id);
    expect(ids.slice(-2)).toEqual(["controls.sizeAndPosition", "controls.delete"]);
    const row = items.find((i) => i.id === "controls.sizeAndPosition")!;
    expect(row.label).toBe(SIZE_AND_POSITION_LABEL);
    row.run();
    expect(opened.map((r) => r.id)).toEqual(["control-0-1-0"]);
  });

  it("a RUN-MODE button keeps the row (its dialog opens read-only)", () => {
    cleanups.push(registerSizeAndPositionOpener(() => {}));
    const button = (publishedRegions as GridRegion[]).find((r) => r.id === "control-0-2-0")!;
    expect(button.data?.movable, "fixture: a button outside Design Mode is published immovable").toBe(false);
    expect(buildControlObjectMenu("control-0-2-0").map((i) => i.id)).toContain("controls.sizeAndPosition");
  });

  it("with no dialog installed the row is omitted", () => {
    expect(buildControlObjectMenu("control-0-1-0").map((i) => i.id)).not.toContain("controls.sizeAndPosition");
  });
});
