//! FILENAME: app/extensions/TimelineSlicer/__tests__/timelineContextMenuClear.test.ts
// PURPOSE: The review of S2 (BUG-0200, the timeline part): "Clear Timeline
//          Filter" in a timeline's right-click menu is a USER gesture, so a
//          clear that grows a pivot over the user's cells is asked about once
//          (and a decline takes it back) -- it passed no options, which is
//          the SCRIPT door's shape: never asked, the FilterDropdown class of
//          BUG-0200. The Timeline tab's Clear Filter is pinned in
//          components/__tests__/TimelineSlicerOptionsTab.test.tsx.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  updateSelection: vi.fn(async (..._a: unknown[]) => undefined),
  timeline: {
    id: "tl-1",
    name: "Date",
    sheetIndex: 0,
    x: 10,
    y: 10,
    width: 300,
    height: 120,
    selectionStart: "2026-01-01" as string | null,
    selectionEnd: "2026-01-31" as string | null,
  },
}));

vi.mock("@api/state", () => ({ getGridStateSnapshot: () => ({ zoom: 1 }) }));
vi.mock("@api", () => ({ showDialog: vi.fn() }));
vi.mock("../lib/timelineSlicerStore", () => ({
  getTimelineById: () => h.timeline,
  deleteTimelineAsync: vi.fn(async () => undefined),
  updateTimelineSelectionAsync: (...a: unknown[]) => h.updateSelection(...a),
}));
vi.mock("../handlers/selectionHandler", () => ({
  isTimelineSelected: () => true,
  selectTimeline: vi.fn(),
}));
vi.mock("../lib/timelineCanvasGeometry", () => ({ timelineAtCanvasPoint: () => h.timeline }));
vi.mock("../manifest", () => ({ TIMELINE_SETTINGS_DIALOG_ID: "timelineSlicer:settingsDialog" }));

import { closeTimelineContextMenu, handleTimelineContextMenu } from "../handlers/timelineSlicerContextMenu";

function rightClick(): void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const event = new MouseEvent("contextmenu", { clientX: 50, clientY: 50, bubbles: true, cancelable: true });
  handleTimelineContextMenu(event, container);
}

function menuRow(label: string): HTMLElement {
  const row = Array.from(document.body.querySelectorAll("div")).find(
    (d) => d.textContent === label && d.children.length === 0,
  );
  if (!row) throw new Error(`no menu row "${label}"`);
  return row as HTMLElement;
}

beforeEach(() => {
  h.updateSelection.mockClear();
});

afterEach(() => {
  closeTimelineContextMenu();
  document.body.innerHTML = "";
});

describe("the timeline context menu's Clear Timeline Filter", () => {
  it("is a USER gesture: it asks before a clear that overwrites the user's cells", async () => {
    rightClick();
    menuRow("Clear Timeline Filter").click();
    expect(h.updateSelection).toHaveBeenCalledTimes(1);
    expect(h.updateSelection.mock.calls[0], "the menu's clear never asks about an overwrite").toEqual([
      "tl-1",
      null,
      null,
      { askBeforeOverwrite: true },
    ]);
  });
});
