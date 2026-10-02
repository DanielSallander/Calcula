//! FILENAME: app/src/api/__tests__/objectSelectionReadOnlyDelete.test.ts
// PURPOSE: The whole-selection Delete (`deleteSelectedObjects`) refuses on a
//          READ-ONLY page (a subscribed canvas) -- one toast with the existing
//          sentence, nothing sent to any family, no undo step, the selection
//          kept (BUG-0270).
// CONTEXT: A subscribed canvas's layout is the publisher's: Paste and Duplicate
//          already refuse there (@api/objectClipboard `refusedOnReadOnlySheet`),
//          and Size and Position says so with SIZE_POSITION_SUBSCRIBED. Delete
//          did not ask at all -- neither the canvas's multi-select Delete nor,
//          since BUG-0270, the generic Delete of a single selected object that
//          has no family door of its own (a slicer, a timeline, a pivot box).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const log: string[] = [];
const toasts: string[] = [];
let activeSheetIndex = 3;
vi.mock("../../core/state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/state/GridContext")>()),
  getGridStateSnapshot: () => ({ surface: "canvas", sheetContext: { activeSheetIndex } }),
}));
vi.mock("../../core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginUndoTransaction: vi.fn(async (label: string) => {
    log.push(`begin:${label}`);
  }),
  commitUndoTransaction: vi.fn(async () => {
    log.push("commit");
  }),
}));
vi.mock("../notifications", () => ({
  showToast: (message: string) => {
    toasts.push(message);
  },
}));

import {
  deleteSelectedObjects,
  getSelectedObjectRegions,
  notifyObjectSelectionChanged,
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  setObjectSelectionSet,
  type ObjectSelectionProvider,
} from "../objectSelection";
import { registerLayoutSurfaceProvider, type LayoutSurface } from "../layoutSurface";
import { SIZE_POSITION_SUBSCRIBED } from "../objectPosition";
import { getGridRegions, registerGridOverlay, setGridRegions, type GridRegion } from "../gridOverlays";

function region(id: string, type: string, x = 0): GridRegion {
  return { id, type, startRow: 0, startCol: 0, endRow: 0, endCol: 0, floating: { x, y: 0, width: 10, height: 10 } };
}

const s1 = region("s1", "slicer", 0);
const deleted: string[] = [];
const cleanups: Array<() => void> = [];
let editable = false;

function slicerFamily(): ObjectSelectionProvider {
  let selected: string | null = null;
  return {
    types: ["slicer"],
    isSelected: (r) => r.id === selected,
    select: (r) => {
      selected = r.id;
      notifyObjectSelectionChanged();
    },
    deselectAll: () => {
      selected = null;
    },
    labelOf: (r) => `Slicer ${r.id}`,
    deleteObjects: async (regions) => {
      for (const r of regions) deleted.push(r.id);
      if (regions.some((r) => r.id === selected)) selected = null;
      setGridRegions(getGridRegions().filter((g) => !regions.some((r) => r.id === g.id)));
    },
  };
}

function surfaceFor(sheet: number): LayoutSurface | null {
  if (sheet !== 3) return null;
  return { snapToGrid: false, gridSize: 8, showGrid: false, page: { width: 800, height: 600 }, editable };
}

beforeEach(() => {
  log.length = 0;
  toasts.length = 0;
  deleted.length = 0;
  activeSheetIndex = 3;
  editable = false;
  resetObjectSelectionProviders();
  cleanups.push(
    registerGridOverlay({ type: "slicer", render: () => {}, priority: 10 }),
    registerObjectSelectionProvider(slicerFamily()),
    registerLayoutSurfaceProvider({ get: surfaceFor }),
  );
  setGridRegions([s1]);
  setObjectSelectionSet([s1], s1);
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetObjectSelectionProviders();
  setGridRegions([]);
});

describe("Delete on a READ-ONLY page (a subscribed canvas)", () => {
  it("refuses: nothing is sent to the family, one toast with the subscribed sentence, no undo step, the selection kept", async () => {
    const outcome = await deleteSelectedObjects();
    expect(deleted, "a subscribed page's object was deleted").toEqual([]);
    expect(log, "a refused delete opened an undo step").toEqual([]);
    expect(toasts).toEqual([`Delete Objects: ${SIZE_POSITION_SUBSCRIBED} Nothing was changed.`]);
    expect(getSelectedObjectRegions().map((r) => r.id)).toEqual(["s1"]);
    expect(outcome.acted).toBe(0);
  });

  it("control: an EDITABLE page deletes, as one undo step", async () => {
    editable = true;
    const outcome = await deleteSelectedObjects();
    expect(deleted).toEqual(["s1"]);
    expect(log).toEqual(["begin:Delete Objects", "commit"]);
    expect(toasts).toEqual([]);
    expect(outcome.acted).toBe(1);
  });

  it("control: a worksheet (no layout surface) deletes", async () => {
    activeSheetIndex = 0;
    await deleteSelectedObjects();
    expect(deleted).toEqual(["s1"]);
  });
});
