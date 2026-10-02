//! FILENAME: app/extensions/CanvasSheet/__tests__/gripMenuWiring.test.ts
// PURPOSE: The canvas's activate() puts its page verbs into the grip's menu
//          (BUG-0258 design phase 5b): with the real extension active on a
//          canvas, an object's grip menu items are Bring Forward, Send Backward
//          and Lock; after deactivate they are gone. The items' behaviour is
//          gripMenuItems.test.ts; this pins that the extension registers them.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CanvasLayout, SheetsResult } from "@api";

const getSheets = vi.fn<() => Promise<SheetsResult>>();
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  getSheets: () => getSheets(),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));
vi.mock("@api/collaboration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/collaboration")>()),
  getSheetProvenance: vi.fn(async () => []),
}));
let gridSnapshot: Record<string, unknown> | null = null;
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => gridSnapshot,
}));

import type { GridRegion } from "@api/gridOverlays";
import { defaultCanvasLayout } from "@api/canvasSheet";
import { registerObjectSelectionProvider, resetObjectSelectionProviders } from "@api/objectSelection";
import { objectGripMenuItems, resetObjectPosition } from "@api/objectPosition";
import { resetCanvasSheetStore } from "../lib/canvasSheetStore";

const CANVAS = 1;
const layout: CanvasLayout = defaultCanvasLayout();
const CHART: GridRegion = {
  id: "chart-c1",
  type: "chart",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { x: 64, y: 64, width: 320, height: 200 },
  data: { id: "c1" },
};

const cleanups: Array<() => void> = [];

beforeEach(() => {
  resetCanvasSheetStore();
  resetObjectSelectionProviders();
  resetObjectPosition();
  gridSnapshot = { surface: "canvas", sheetContext: { activeSheetIndex: CANVAS } };
  getSheets.mockResolvedValue({
    activeIndex: CANVAS,
    sheets: [
      { index: 0, name: "Data", visibility: "visible", sheetId: "ws-0" },
      { index: CANVAS, name: "Page", visibility: "visible", sheetId: "cv-1", kind: "canvas", canvasLayout: layout },
    ],
  } as SheetsResult);
  cleanups.push(
    registerObjectSelectionProvider({
      types: ["chart"],
      isSelected: () => false,
      select: () => {},
      deselectAll: () => {},
      refOf: (r) => (typeof r.data?.id === "string" ? { kind: "chart", id: r.data.id } : null),
    }),
  );
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("the canvas extension's grip-menu wiring", () => {
  it("activate() registers Bring Forward, Send Backward and Lock; deactivate() removes them", async () => {
    const { default: extension } = await import("../index");
    extension.activate({} as never);
    let active = true;
    cleanups.push(() => {
      if (active) extension.deactivate?.();
    });
    await vi.waitFor(() =>
      expect(objectGripMenuItems(CHART).map((i) => i.label)).toEqual(["Bring Forward", "Send Backward", "Lock"]),
    );
    extension.deactivate?.();
    active = false;
    expect(objectGripMenuItems(CHART)).toEqual([]);
  });
});
