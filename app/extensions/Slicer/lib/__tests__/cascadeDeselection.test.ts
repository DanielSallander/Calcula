//! FILENAME: app/extensions/Slicer/lib/__tests__/cascadeDeselection.test.ts
// PURPOSE: BUG-0026. A slicer that disappears because the BACKEND CASCADED —
//          not because the user deleted it — must take the contextual Slicer
//          Options tab down with it.
//
// THE REPRODUCTION, three actions and no more:
//
//          table.create -> slicer.create -> table.delete
//
//          leaves the Slicer ribbon tab visible on a workbook with ZERO
//          slicers. The backend cascade is correct (§3bt deletes the slicers
//          bound to a deleted table), the announcement is correct (§3bn tells
//          the Slicer extension to re-read), and the store re-reads correctly.
//          What nothing did was reconcile the SELECTION: `SLICER_DELETED` was
//          dispatched from exactly one place in the repo — `deleteSlicerAsync`,
//          the route a user takes by hand — so a backend-initiated
//          disappearance emitted nothing at all and the selected id went on
//          naming an object that no longer resolved.
//
// THE FIX, and why it is in the STORE and not at the new call site. Adding an
//          announcement to the cascade path is what produced a one-caller event
//          in the first place; the next cascade route (an MCP tool, a sheet
//          delete, an undo) would have needed a fourth. `refreshCache` diffs the
//          id set and announces whatever went away, so it tells the truth about
//          every route at once — including routes that do not exist yet.
//
// VACUITY. Every "the tab is gone" assertion is paired with a case where the
//          tab must SURVIVE — a second slicer still selected, or a refresh that
//          removed nothing — so a store that simply always announced, or a
//          handler that simply always deselected, fails here rather than passes.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — the store's and the handler's whole outside world
// ---------------------------------------------------------------------------

const mockRegisterPanel = vi.fn();
const mockUnregisterPanel = vi.fn();
vi.mock("@api/ui", () => ({
  registerPanel: (...a: unknown[]) => mockRegisterPanel(...a),
  unregisterPanel: (...a: unknown[]) => mockUnregisterPanel(...a),
}));

const mockAddContextKey = vi.fn();
const mockRemoveContextKey = vi.fn();
vi.mock("@api", () => ({
  addTaskPaneContextKey: (...a: unknown[]) => mockAddContextKey(...a),
  removeTaskPaneContextKey: (...a: unknown[]) => mockRemoveContextKey(...a),
}));

vi.mock("@api/gridOverlays", () => ({
  replaceGridRegionsByType: vi.fn(),
  removeGridRegionsByType: vi.fn(),
  requestOverlayRedraw: vi.fn(),
}));

vi.mock("@api/state", () => ({
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 0 } }),
}));

const mockEmitAppEvent = vi.fn();
vi.mock("@api/events", () => ({
  emitAppEvent: (...a: unknown[]) => mockEmitAppEvent(...a),
  AppEvents: { MUTATION_REFRESH: "app:mutation-refresh" },
}));

vi.mock("../slicerFilterBridge", () => ({
  ensureBiFieldInPivotCache: vi.fn(async () => false),
}));

vi.mock("../../manifest", () => ({
  SLICER_OPTIONS_TAB_ID: "slicer-options",
  SlicerOptionsPanelDefinition: { id: "slicer-options", title: "Slicer" },
}));

/**
 * THE BACKEND, as a set of ids. `getAllSlicers` reads it, so "the backend
 * cascaded" is expressed exactly as the app experiences it: the next read
 * simply does not contain the slicer any more.
 */
let backendSlicers: string[] = [];
const deleteSlicerSpy = vi.fn(async (id: string) => {
  backendSlicers = backendSlicers.filter((s) => s !== id);
});

vi.mock("../slicer-api", () => ({
  getAllSlicers: async () =>
    backendSlicers.map((id) => ({
      id,
      name: id,
      sheetIndex: 0,
      x: 10,
      y: 10,
      width: 180,
      height: 240,
      sourceType: "table",
      cacheSourceId: "table-1",
      fieldName: "Region",
      connectedSources: [],
    })),
  getSlicerItems: async () => [],
  createSlicer: vi.fn(),
  deleteSlicer: (id: string) => deleteSlicerSpy(id),
  updateSlicer: vi.fn(),
  updateSlicerPosition: vi.fn(),
  updateSlicerSelection: vi.fn(),
}));

import { refreshCache, deleteSlicerAsync, resetStore } from "../slicerStore";
import { SlicerEvents } from "../slicerEvents";
import {
  selectSlicer,
  dropSlicerFromSelection,
  isSlicerSelected,
  getSelectedSlicerIds,
  resetSelectionHandlerState,
} from "../../handlers/selectionHandler";

// ---------------------------------------------------------------------------
// The extension's own wiring, reproduced in one line.
//
// `index.ts` registers exactly this handler on SLICER_DELETED. Reproducing it
// here (rather than importing the whole extension, which pulls in the canvas
// renderer and the ribbon) keeps the test to the seam under examination: the
// store announces, the handler reconciles.
// ---------------------------------------------------------------------------
function wireExtension(): () => void {
  const handler = (e: Event) => {
    const id = (e as CustomEvent).detail?.slicerId as string | undefined;
    if (id != null) dropSlicerFromSelection(id);
  };
  window.addEventListener(SlicerEvents.SLICER_DELETED, handler);
  return () => window.removeEventListener(SlicerEvents.SLICER_DELETED, handler);
}

/** Is the contextual tab registered right now, per the calls made? */
function tabIsRegistered(): boolean {
  const events = [
    ...mockRegisterPanel.mock.invocationCallOrder.map((n) => ({ n, on: true })),
    ...mockUnregisterPanel.mock.invocationCallOrder.map((n) => ({ n, on: false })),
  ].sort((a, b) => a.n - b.n);
  return events.length > 0 ? events[events.length - 1].on : false;
}

function deletedIds(): string[] {
  return announced.map((d) => d.slicerId);
}

let announced: Array<{ slicerId: string }> = [];
let captureDeleted: (e: Event) => void;

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  resetSelectionHandlerState();
  backendSlicers = [];
  announced = [];
  captureDeleted = (e: Event) => {
    announced.push((e as CustomEvent).detail as { slicerId: string });
  };
  window.addEventListener(SlicerEvents.SLICER_DELETED, captureDeleted);
  return () => window.removeEventListener(SlicerEvents.SLICER_DELETED, captureDeleted);
});

describe("BUG-0026 — a backend cascade takes the contextual Slicer tab down", () => {
  it("the three-action reproduction: table.create -> slicer.create -> table.delete", async () => {
    const unwire = wireExtension();

    // 1. + 2. A table exists and a slicer is created over it; the user clicks
    //    the slicer, which is what puts the contextual tab on screen.
    backendSlicers = ["slicer-1"];
    await refreshCache();
    selectSlicer("slicer-1");
    expect(tabIsRegistered(), "precondition: the Slicer tab is showing").toBe(true);
    expect(mockAddContextKey).toHaveBeenCalledWith("slicer");

    // 3. The TABLE is deleted. The backend cascade removes the slicer bound to
    //    it, and the Table extension announces the "slicer" domain — which the
    //    Shell translates into the refresh below. NOTHING calls deleteSlicer.
    backendSlicers = [];
    await refreshCache();

    expect(deleteSlicerSpy, "the slicer went via the CASCADE, not the delete route").not.toHaveBeenCalled();
    expect(deletedIds()).toEqual(["slicer-1"]);
    expect(isSlicerSelected("slicer-1")).toBe(false);
    expect(tabIsRegistered(), "the Slicer tab outlived every slicer in the workbook").toBe(false);
    expect(mockRemoveContextKey).toHaveBeenCalledWith("slicer");

    unwire();
  });

  it("a refresh that removes nothing announces nothing and keeps the tab", async () => {
    const unwire = wireExtension();
    backendSlicers = ["slicer-1", "slicer-2"];
    await refreshCache();
    selectSlicer("slicer-1");

    await refreshCache();

    expect(deletedIds()).toEqual([]);
    expect(tabIsRegistered(), "a plain re-read must not disturb the selection").toBe(true);
    expect(isSlicerSelected("slicer-1")).toBe(true);
    unwire();
  });

  it("a multi-selection keeps its survivors — one cascaded slicer is not all of them", async () => {
    const unwire = wireExtension();
    backendSlicers = ["slicer-1", "slicer-2"];
    await refreshCache();
    selectSlicer("slicer-1");
    selectSlicer("slicer-2", true); // Ctrl+click
    expect([...getSelectedSlicerIds()]).toEqual(["slicer-1", "slicer-2"]);

    // Only the first one's source table was deleted.
    backendSlicers = ["slicer-2"];
    await refreshCache();

    expect(deletedIds()).toEqual(["slicer-1"]);
    expect([...getSelectedSlicerIds()]).toEqual(["slicer-2"]);
    expect(tabIsRegistered(), "Excel keeps the tab while anything is still selected").toBe(true);
    unwire();
  });

  it("announces once, not twice, when the user deletes the slicer by hand", async () => {
    // The regression the single-announcer rule exists to prevent runs BOTH
    // ways: put the dispatch back on the delete route and this route fires
    // twice while every cascade route still fires zero times.
    const unwire = wireExtension();
    backendSlicers = ["slicer-1"];
    await refreshCache();
    selectSlicer("slicer-1");

    await deleteSlicerAsync("slicer-1");

    expect(deleteSlicerSpy).toHaveBeenCalledWith("slicer-1");
    expect(deletedIds()).toEqual(["slicer-1"]);
    expect(tabIsRegistered()).toBe(false);
    // ...and the ribbon-filter announcement the by-hand route owes is still made.
    expect(mockEmitAppEvent).toHaveBeenCalledWith(
      "app:mutation-refresh",
      expect.objectContaining({ domains: ["ribbonFilter"] }),
    );
    unwire();
  });

  it("an unselected slicer's disappearance does not touch the tab", async () => {
    const unwire = wireExtension();
    backendSlicers = ["slicer-1", "slicer-2"];
    await refreshCache();
    selectSlicer("slicer-1");

    backendSlicers = ["slicer-1"];
    await refreshCache();

    expect(deletedIds()).toEqual(["slicer-2"]);
    expect(tabIsRegistered(), "the selected slicer still exists").toBe(true);
    unwire();
  });

  it("the reconciliation is the only thing holding the tab up — remove it and the bug is back", () => {
    // THE DETECTOR, run without the extension wiring. This is the state the app
    // was actually in: the store announces (or, before the fix, did not) and
    // nothing listens. The tab stays. If this ever stops being true, the
    // assertions above have stopped measuring the reconciliation.
    backendSlicers = ["slicer-1"];
    return refreshCache().then(() => {
      selectSlicer("slicer-1");
      expect(tabIsRegistered()).toBe(true);
      backendSlicers = [];
      return refreshCache().then(() => {
        expect(deletedIds()).toEqual(["slicer-1"]);
        expect(
          tabIsRegistered(),
          "with nothing wired to SLICER_DELETED the tab survives — which is " +
            "exactly BUG-0026, and proves the passing cases above are the " +
            "reconciliation doing the work",
        ).toBe(true);
      });
    });
  });
});
