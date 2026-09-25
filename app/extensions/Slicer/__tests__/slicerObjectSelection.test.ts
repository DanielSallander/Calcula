//! FILENAME: app/extensions/Slicer/__tests__/slicerObjectSelection.test.ts
// PURPOSE: A keyboard (or script) selection of a slicer selects it — and shows
//          the contextual Slicer tab, as a click does — but arms NO pending
//          click and never goes through the mouse event.
// CONTEXT: The mouse route arms a pending click that the next mouseup ANYWHERE
//          completes as a click on the slicer item under the pointer. If a Tab
//          press armed it, the user's next unrelated mouse release would toggle
//          a filter item they never pointed at. The pending click lives in
//          lib/slicerPendingClick.ts precisely so this can be observed.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const registerPanel = vi.fn();
const unregisterPanel = vi.fn();

vi.mock("../lib/slicerStore", () => ({
  getSlicerById: (id: string) =>
    id === "s1" || id === "s2" ? { id, name: id, sheetIndex: 0, x: 0, y: 0, width: 180, height: 240 } : undefined,
}));

vi.mock("../manifest", () => ({
  SLICER_OPTIONS_TAB_ID: "slicer-options",
  SlicerOptionsPanelDefinition: { id: "slicer-options" },
}));

vi.mock("@api/ui", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerPanel: (...args: unknown[]) => registerPanel(...args),
  unregisterPanel: (...args: unknown[]) => unregisterPanel(...args),
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
}));

vi.mock("@api/gridOverlays", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestOverlayRedraw: vi.fn(),
}));

import type { GridRegion } from "@api/gridOverlays";
import { resetObjectSelectionProviders, selectObject } from "@api/objectSelection";
import {
  createSlicerSelectionProvider,
  registerSlicerObjectSelection,
} from "../lib/slicerObjectSelection";
import {
  armPendingSlicerClick,
  clearPendingSlicerClick,
  peekPendingSlicerClick,
} from "../lib/slicerPendingClick";
import {
  getSelectedSlicerIds,
  isSlicerSelected,
  resetSelectionHandlerState,
} from "../handlers/selectionHandler";

function region(slicerId: string): GridRegion {
  return {
    id: `slicer-${slicerId}`,
    type: "slicer",
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 0, y: 0, width: 180, height: 240 },
    data: { slicerId },
  };
}

const domSelected: Event[] = [];
const onDomSelected = (e: Event) => domSelected.push(e);

beforeEach(() => {
  resetObjectSelectionProviders();
  resetSelectionHandlerState();
  clearPendingSlicerClick();
  registerPanel.mockClear();
  unregisterPanel.mockClear();
  domSelected.length = 0;
  window.addEventListener("floatingObject:selected", onDomSelected);
});

afterEach(() => {
  window.removeEventListener("floatingObject:selected", onDomSelected);
});

describe("keyboard selection of a slicer", () => {
  it("the observation point is live: a mouse press WOULD show up here", () => {
    armPendingSlicerClick({ slicerId: "s1" });
    expect(peekPendingSlicerClick()).toEqual({ slicerId: "s1" });
  });

  it("selects the slicer and shows its tab, arming no pending click", () => {
    registerSlicerObjectSelection();
    expect(selectObject(region("s1"))).toBe(true);

    expect(isSlicerSelected("s1")).toBe(true);
    expect(registerPanel).toHaveBeenCalledTimes(1);
    expect(peekPendingSlicerClick()).toBeNull();
    expect(domSelected).toHaveLength(0);
  });

  it("is exclusive: the next step replaces, never adds", () => {
    const p = createSlicerSelectionProvider();
    p.select(region("s1"));
    p.select(region("s2"));
    expect([...getSelectedSlicerIds()]).toEqual(["s2"]);
    expect(p.isSelected(region("s2"))).toBe(true);
    expect(p.isSelected(region("s1"))).toBe(false);
    expect(peekPendingSlicerClick()).toBeNull();
  });

  it("ignores a region without a slicer id, or with one the store lacks", () => {
    const p = createSlicerSelectionProvider();
    p.select({ ...region("s1"), data: {} });
    p.select(region("gone"));
    expect(getSelectedSlicerIds().size).toBe(0);
  });

  it("deselectAll clears the selection and removes the tab", () => {
    const p = createSlicerSelectionProvider();
    p.select(region("s1"));
    p.deselectAll();
    expect(getSelectedSlicerIds().size).toBe(0);
    expect(unregisterPanel).toHaveBeenCalledTimes(1);
  });
});
