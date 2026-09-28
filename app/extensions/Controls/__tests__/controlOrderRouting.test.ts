//! FILENAME: app/extensions/Controls/__tests__/controlOrderRouting.test.ts
// PURPOSE: Controls' right-click "Order" submenu on a CANVAS (M8 part C): the
//          page owns every object's paint order there (the layout's zOrder),
//          so Bring to Front & co. are routed to the page's stacking service
//          (@api/objectStacking) -- with the control's group members as one
//          block -- instead of reordering Controls' own session-only store
//          array, which the canvas does not paint by. On a worksheet (no
//          service answers) the store's own order still moves, as before.

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
    // The paint/hit view of the same list (empty only in cross-sheet point mode).
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
  getAllFloatingControls,
  groupControls,
  resetFloatingStore,
  syncFloatingControlRegions,
  type FloatingControl,
} from "../lib/floatingStore";
import {
  registerObjectStackingService,
  resetObjectStackingService,
  type ObjectStackingService,
} from "@api/objectStacking";
import type { GridRegion } from "@api/gridOverlays";

function control(row: number): FloatingControl {
  return {
    id: `control-0-${row}-0`,
    sheetIndex: 0,
    row,
    col: 0,
    x: 10,
    y: row * 50,
    width: 80,
    height: 30,
    controlType: "shape",
  } as FloatingControl;
}

function runOrderItem(controlId: string, itemId: string): void {
  const order = buildControlObjectMenu(controlId).find((i) => i.id === "controls.order");
  const item = order?.children?.find((c) => c.id === itemId);
  if (!item) throw new Error(`no ${itemId}`);
  item.run();
}

const storeOrder = () => getAllFloatingControls().map((c) => c.id);

beforeEach(() => {
  resetFloatingStore();
  resetObjectStackingService();
  for (const row of [1, 2, 3]) addFloatingControl(control(row));
  syncFloatingControlRegions();
});

afterEach(() => {
  resetObjectStackingService();
});

describe("the Order submenu", () => {
  it("on a canvas: routed to the PAGE's stacking service; the store's own order is untouched", () => {
    const restack = vi.fn(async () => true);
    const service: ObjectStackingService = { ordersRegion: () => true, restack };
    registerObjectStackingService(service);
    const before = storeOrder();

    runOrderItem("control-0-1-0", "controls.order.bringToFront");

    expect(restack).toHaveBeenCalledTimes(1);
    const [command, regions] = restack.mock.calls[0] as unknown as [string, GridRegion[]];
    expect(command).toBe("bringToFront");
    expect(regions.map((r) => r.id)).toEqual(["control-0-1-0"]);
    expect(storeOrder()).toEqual(before);
  });

  it("a grouped control restacks with its whole group, as one block", () => {
    const restack = vi.fn(async () => true);
    registerObjectStackingService({ ordersRegion: () => true, restack });
    groupControls(["control-0-1-0", "control-0-3-0"]);
    runOrderItem("control-0-3-0", "controls.order.sendBackward");
    const [command, regions] = restack.mock.calls[0] as unknown as [string, GridRegion[]];
    expect(command).toBe("sendBackward");
    expect(regions.map((r) => r.id).sort()).toEqual(["control-0-1-0", "control-0-3-0"]);
  });

  it("on a worksheet (the service does not own the order): the store's own order moves, as before", () => {
    const restack = vi.fn(async () => true);
    registerObjectStackingService({ ordersRegion: () => false, restack });
    runOrderItem("control-0-1-0", "controls.order.bringToFront");
    expect(restack).not.toHaveBeenCalled();
    expect(storeOrder()).toEqual(["control-0-2-0", "control-0-3-0", "control-0-1-0"]);
  });
});
