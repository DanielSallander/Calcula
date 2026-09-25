//! FILENAME: app/extensions/TimelineSlicer/__tests__/timelineObjectSelection.test.ts
// PURPOSE: A keyboard (or script) selection of a timeline selects it — and
//          shows the contextual Timeline tab, as a click does — but arms NO
//          pending click and never goes through the mouse event.
// CONTEXT: The twin of Slicer's slicerObjectSelection.test.ts: the mouse route
//          arms a pending click the next mouseup ANYWHERE completes as a period
//          click under the pointer, so a Tab press must never arm it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const registerPanel = vi.fn();
const unregisterPanel = vi.fn();

vi.mock("../lib/timelineSlicerStore", () => ({
  getTimelineById: (id: string) =>
    id === "t1" || id === "t2" ? { id, name: id, sheetIndex: 0, x: 0, y: 0, width: 300, height: 110 } : undefined,
}));

vi.mock("../manifest", () => ({
  TIMELINE_OPTIONS_TAB_ID: "timeline-options",
  TimelineOptionsPanelDefinition: { id: "timeline-options" },
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
  createTimelineSelectionProvider,
  registerTimelineObjectSelection,
} from "../lib/timelineObjectSelection";
import {
  armPendingTimelineClick,
  clearPendingTimelineClick,
  peekPendingTimelineClick,
} from "../lib/timelinePendingClick";
import {
  getSelectedTimelineIds,
  isTimelineSelected,
  resetSelectionHandlerState,
} from "../handlers/selectionHandler";

function region(timelineId: string): GridRegion {
  return {
    id: `timeline-slicer-${timelineId}`,
    type: "timeline-slicer",
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 0, y: 0, width: 300, height: 110 },
    data: { timelineId },
  };
}

const domSelected: Event[] = [];
const onDomSelected = (e: Event) => domSelected.push(e);

beforeEach(() => {
  resetObjectSelectionProviders();
  resetSelectionHandlerState();
  clearPendingTimelineClick();
  registerPanel.mockClear();
  unregisterPanel.mockClear();
  domSelected.length = 0;
  window.addEventListener("floatingObject:selected", onDomSelected);
});

afterEach(() => {
  window.removeEventListener("floatingObject:selected", onDomSelected);
});

describe("keyboard selection of a timeline", () => {
  it("the observation point is live: a mouse press WOULD show up here", () => {
    armPendingTimelineClick({ timelineId: "t1" });
    expect(peekPendingTimelineClick()).toEqual({ timelineId: "t1" });
  });

  it("selects the timeline and shows its tab, arming no pending click", () => {
    registerTimelineObjectSelection();
    expect(selectObject(region("t1"))).toBe(true);

    expect(isTimelineSelected("t1")).toBe(true);
    expect(registerPanel).toHaveBeenCalledTimes(1);
    expect(peekPendingTimelineClick()).toBeNull();
    expect(domSelected).toHaveLength(0);
  });

  it("is exclusive: the next step replaces, never adds", () => {
    const p = createTimelineSelectionProvider();
    p.select(region("t1"));
    p.select(region("t2"));
    expect([...getSelectedTimelineIds()]).toEqual(["t2"]);
    expect(p.isSelected(region("t2"))).toBe(true);
    expect(p.isSelected(region("t1"))).toBe(false);
    expect(peekPendingTimelineClick()).toBeNull();
  });

  it("ignores a region without a timeline id, or with one the store lacks", () => {
    const p = createTimelineSelectionProvider();
    p.select({ ...region("t1"), data: {} });
    p.select(region("gone"));
    expect(getSelectedTimelineIds().size).toBe(0);
  });

  it("deselectAll clears the selection and removes the tab", () => {
    const p = createTimelineSelectionProvider();
    p.select(region("t1"));
    p.deselectAll();
    expect(getSelectedTimelineIds().size).toBe(0);
    expect(unregisterPanel).toHaveBeenCalledTimes(1);
  });
});
