//! FILENAME: app/extensions/CanvasSheet/__tests__/layoutRefsAnchors.test.ts
// PURPOSE: A new control never INHERITS a deleted control's canvas lock or
//          paint slot (wave C review of W25). A control is named on a canvas
//          by its ANCHOR (`control:<row>:<col>`); the layout keeps a deleted
//          control's `locked` / `zOrder` refs (the layout is not on the undo
//          stack, so Ctrl+Z of the delete must find them there); and the
//          anchor allocator used to hand out (0, maxCol+1) -- the deleted
//          newest control's own anchor. So copy a LOCKED shape, delete it,
//          paste (a canvas has no Cut): the copy came back locked and in the
//          dead shape's slot. The canvas now tells the families which ids its
//          layout names (lib/layoutRefs.ts, through @api/objectSelection) and
//          Controls' allocator skips them.
// CONTEXT: Real Controls clipboard, provider, anchor allocator and floating
//          store; real canvas store, layout-ref source and lock check. Only
//          the backend (controlApi, get_sheets) and the renderers are doubled.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CanvasLayout, CanvasLayoutPatch, CanvasObjectRef, SheetsResult } from "@api";

const h = vi.hoisted(() => ({
  occupied: [] as Array<{ row: number; col: number }>,
  writes: [] as string[],
}));

const getSheets = vi.fn<() => Promise<SheetsResult>>();
const setCanvasLayout = vi.fn<(patch: CanvasLayoutPatch, index?: number) => Promise<CanvasLayout>>();
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  getSheets: () => getSheets(),
  setCanvasLayout: (patch: CanvasLayoutPatch, index?: number) => setCanvasLayout(patch, index),
}));
vi.mock("@api/collaboration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/collaboration")>()),
  getSheetProvenance: async () => [],
}));
vi.mock("@api/notifications", () => ({ showToast: vi.fn() }));
vi.mock("../../Controls/lib/controlApi", () => ({
  setControlMetadata: async (_s: number, row: number, col: number) => {
    h.writes.push(`${row}:${col}`);
    h.occupied.push({ row, col });
  },
  getControlMetadata: async () => ({
    controlType: "shape",
    properties: { x: { valueType: "static", value: "300" }, y: { valueType: "static", value: "100" } },
  }),
  getAllControls: async () => h.occupied.map((c) => ({ ...c })),
}));
vi.mock("../../Controls/Button/floatingRenderer", () => ({ invalidateFloatingButtonCache: vi.fn() }));
vi.mock("../../Controls/Shape/shapeRenderer", () => ({ invalidateShapeCache: vi.fn() }));
vi.mock("../../Controls/Image/imageRenderer", () => ({ invalidateImageCache: vi.fn() }));

import { getGridRegions, registerGridOverlay, setGridRegions } from "@api/gridOverlays";
import { resetObjectSelectionProviders } from "@api/objectSelection";
import { resetObjectClipboard } from "@api/objectClipboard";
import { canvasObjectRef, canvasObjectRefKey, defaultCanvasLayout } from "@api/canvasSheet";
import { canvasAt, refreshCanvasSheets, resetCanvasSheetStore } from "../lib/canvasSheetStore";
import { installCanvasLayoutRefs } from "../lib/layoutRefs";
import { isLockedOnLayout } from "../lib/canvasLocks";
import { registerControlObjectSelection } from "../../Controls/lib/controlObjectSelection";
import {
  copyControls,
  pasteControl,
  pasteControlSnapshots,
  snapshotControls,
} from "../../Controls/lib/controlClipboard";
import { withControlAnchor } from "../../Controls/lib/controlAnchors";
import {
  addFloatingControl,
  makeFloatingControlId,
  removeFloatingControl,
  resetFloatingStore,
  syncFloatingControlRegions,
} from "../../Controls/lib/floatingStore";

const ref = (row: number, col: number): CanvasObjectRef => canvasObjectRef("control", `${row}:${col}`);

/** Sheet 0 is a canvas with `layout`; sheet 1 is a worksheet. */
async function seedCanvas(layout: Partial<CanvasLayout>): Promise<void> {
  getSheets.mockResolvedValue({
    sheets: [
      { index: 0, name: "Page", kind: "canvas", canvasLayout: { ...defaultCanvasLayout(), ...layout } },
      { index: 1, name: "Sheet1", kind: "worksheet" },
    ],
    activeIndex: 0,
  } as unknown as SheetsResult);
  expect(await refreshCanvasSheets()).toBe(true);
}

/** A shape at anchor (0, col) on `sheet`, known to the store and the backend. */
function addShape(col: number, x: number, sheet = 0): string {
  const id = makeFloatingControlId(sheet, 0, col);
  addFloatingControl({ id, sheetIndex: sheet, row: 0, col, x, y: 100, width: 80, height: 40, controlType: "shape" });
  h.occupied.push({ row: 0, col });
  return id;
}

/** Delete a shape the way the backend does: its anchor is freed. */
function deleteShape(id: string, col: number): void {
  removeFloatingControl(id);
  h.occupied = h.occupied.filter((c) => c.col !== col);
  syncFloatingControlRegions();
}

const cleanups: Array<() => void> = [];

beforeEach(() => {
  h.occupied = [];
  h.writes.length = 0;
  setCanvasLayout.mockReset();
  resetFloatingStore();
  resetObjectClipboard();
  resetObjectSelectionProviders();
  resetCanvasSheetStore();
  setGridRegions([]);
  cleanups.push(registerGridOverlay({ type: "floating-control", render: () => {}, priority: 20 }));
  cleanups.push(registerControlObjectSelection({ copyControls: snapshotControls, pasteControls: pasteControlSnapshots }));
  cleanups.push(installCanvasLayoutRefs());
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetObjectSelectionProviders();
  resetCanvasSheetStore();
});

describe("a new control never inherits a deleted control's canvas identity", () => {
  it("copy a LOCKED shape, delete it, paste: the copy is a new, UNLOCKED object at a fresh anchor", async () => {
    await seedCanvas({ locked: [ref(0, 1)], zOrder: [ref(0, 0), ref(0, 1)] });
    addShape(0, 10);
    const idB = addShape(1, 300);
    syncFloatingControlRegions();

    await copyControls([idB]);
    deleteShape(idB, 1);
    await pasteControl(0);

    expect(h.writes, "the paste reused the deleted, LOCKED shape's anchor").toEqual(["0:2"]);
    const layout = canvasAt(0)!.layout;
    const pasted = getGridRegions().find((r) => r.id === makeFloatingControlId(0, 0, 2));
    expect(pasted, "nothing was pasted").toBeTruthy();
    expect(isLockedOnLayout(layout, pasted!), "the pasted copy is locked").toBe(false);
    expect(
      (layout.zOrder ?? []).map(canvasObjectRefKey),
      "the pasted copy took the deleted shape's slot in the paint order",
    ).not.toContain("control:0:2");
  });

  it("an anchor only the paint ORDER still names is skipped too (the copy paints on top, not in a dead slot)", async () => {
    await seedCanvas({ zOrder: [ref(0, 1), ref(0, 0)] });
    addShape(0, 10);
    const idB = addShape(1, 300);
    syncFloatingControlRegions();

    await copyControls([idB]);
    deleteShape(idB, 1);
    await pasteControl(0);

    expect(h.writes, "the paste landed in the deleted shape's zOrder slot").toEqual(["0:2"]);
  });

  it("Insert on the page (a position, no anchor) skips a named anchor as well", async () => {
    await seedCanvas({ locked: [ref(0, 0)] });
    const anchor = await withControlAnchor({ sheetIndex: 0, x: 40, y: 40 }, async (cell) => cell);
    expect(anchor, "Insert Shape after deleting the newest locked shape inherits its lock").toEqual({ row: 0, col: 1 });
  });

  it("nothing is pruned: the deleted shape's lock is still in the layout for Ctrl+Z of the delete", async () => {
    await seedCanvas({ locked: [ref(0, 1)] });
    addShape(0, 10);
    const idB = addShape(1, 300);
    syncFloatingControlRegions();
    await copyControls([idB]);
    deleteShape(idB, 1);
    await pasteControl(0);
    expect((canvasAt(0)!.layout.locked ?? []).map(canvasObjectRefKey)).toEqual(["control:0:1"]);
    expect(setCanvasLayout).not.toHaveBeenCalled();
  });

  it("control: a WORKSHEET has no layout, so its allocator is unchanged", async () => {
    await seedCanvas({ locked: [ref(0, 1)] });
    const anchor = await withControlAnchor({ sheetIndex: 1, x: 40, y: 40 }, async (cell) => cell);
    expect(anchor).toEqual({ row: 0, col: 0 });
  });
});
