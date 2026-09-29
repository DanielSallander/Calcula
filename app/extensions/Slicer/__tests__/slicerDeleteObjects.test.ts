//! FILENAME: app/extensions/Slicer/__tests__/slicerDeleteObjects.test.ts
// PURPOSE: A4 (wave B). A canvas-wide Delete (@api/objectSelection
//          `deleteSelectedObjects`) hands every family its share through the
//          provider's `deleteObjects`. The Slicer's provider had none, so a
//          canvas multi-selection Delete kept the slicers and named them. It
//          now deletes them -- resolving once the deletes LANDED (the store and
//          its regions re-read) and REJECTING with the backend's reason on a
//          refusal, so the seam keeps the refused slicer selected and names it.
//          The real seam, store and provider run here over a Tauri-shaped
//          backend double; the undo transaction is the real one.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  backend: [] as Array<Record<string, unknown>>,
  refuse: {} as Record<string, string>,
  deleted: [] as string[],
  log: [] as string[],
  toasts: [] as string[],
}));

vi.mock("../../../src/core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/lib/tauri-api")>()),
  beginUndoTransaction: async (label: string) => {
    h.log.push(`begin:${label}`);
  },
  commitUndoTransaction: async () => {
    h.log.push("commit");
  },
}));
vi.mock("../lib/slicer-api", () => ({
  getAllSlicers: async () => h.backend.map((s) => ({ ...s })),
  getSlicerItems: async () => [],
  deleteSlicer: async (id: string) => {
    if (h.refuse[id]) throw new Error(h.refuse[id]);
    h.deleted.push(id);
    h.log.push(`delete:${id}`);
    h.backend = h.backend.filter((s) => s.id !== id);
  },
}));
vi.mock("@api/state", () => ({ getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 0 } }) }));
vi.mock("@api/notifications", () => ({
  showToast: (message: string) => {
    h.toasts.push(message);
  },
}));
vi.mock("../manifest", () => ({
  SLICER_OPTIONS_TAB_ID: "slicer-options",
  SlicerOptionsPanelDefinition: { id: "slicer-options" },
}));
vi.mock("@api/ui", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
}));

import { getGridRegions, setGridRegions } from "@api/gridOverlays";
import { deleteSelectedObjects, resetObjectSelectionProviders } from "@api/objectSelection";
import { resetObjectGeometryProviders } from "@api/objectGeometry";
import { refreshCache, resetStore } from "../lib/slicerStore";
import { registerSlicerObjectSelection } from "../lib/slicerObjectSelection";
import { resetSelectionHandlerState, selectSlicer } from "../handlers/selectionHandler";

function slicer(id: string, x: number): Record<string, unknown> {
  return {
    id,
    name: `Slicer ${id}`,
    sheetIndex: 0,
    x,
    y: 10,
    width: 100,
    height: 100,
    sourceType: "pivot",
    cacheSourceId: "p1",
    fieldName: "Region",
    selectedItems: null,
    connectedSources: [{ sourceType: "pivot", sourceId: "p1" }],
  };
}

let unregister: (() => void) | null = null;

beforeEach(async () => {
  unregister?.();
  resetObjectSelectionProviders();
  resetObjectGeometryProviders();
  resetSelectionHandlerState();
  resetStore();
  setGridRegions([]);
  h.backend = [slicer("s1", 10), slicer("s2", 200)];
  h.refuse = {};
  h.deleted.length = 0;
  h.log.length = 0;
  h.toasts.length = 0;
  await refreshCache();
  unregister = registerSlicerObjectSelection();
  selectSlicer("s1", false);
  selectSlicer("s2", true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("a canvas-wide Delete of selected slicers", () => {
  it("deletes EVERY selected slicer, as ONE undo step, and resolves once they are gone", async () => {
    const outcome = await deleteSelectedObjects();

    expect(h.deleted).toEqual(["s1", "s2"]);
    expect(outcome).toMatchObject({ acted: 2, failed: 0, unsupported: 0 });
    expect(h.log.filter((l) => l.startsWith("begin") || l === "commit")).toEqual(["begin:Delete Objects", "commit"]);
    // Landed: the store re-read, so their regions are gone.
    expect(getGridRegions().filter((r) => r.type === "slicer")).toEqual([]);
    expect(h.toasts).toEqual([]);
  });

  it("a REFUSED slicer stays, stays selected, and is named with the backend's reason", async () => {
    h.refuse = { s2: "Sheet is protected: editing objects is not allowed." };

    const outcome = await deleteSelectedObjects();

    expect(h.deleted).toEqual(["s1"]);
    expect(outcome).toMatchObject({ acted: 1, failed: 1 });
    expect(getGridRegions().map((r) => r.id)).toEqual(["slicer-s2"]);
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0]).toContain("Slicer s2");
    expect(h.toasts[0]).toContain("Sheet is protected");
  });
});
