//! FILENAME: app/extensions/TimelineSlicer/__tests__/timelineMenuSizePosition.test.ts
// PURPOSE: A timeline's right-click menu carries "Size and Position..."
//          (BUG-0258 design phase 5b) -- the no-drag route every object menu
//          offers -- just above "Remove Timeline", and choosing it opens the
//          dialog for THIS timeline's published region (@api/objectPosition's
//          opener). Greyed, with the reason, when no dialog is installed.
//          Driven through the real handler and the real DOM menu.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  timeline: {
    id: "tl-1",
    name: "Date",
    sheetIndex: 0,
    x: 10,
    y: 10,
    width: 300,
    height: 120,
    selectionStart: null as string | null,
    selectionEnd: null as string | null,
  },
}));

vi.mock("@api/state", () => ({ getGridStateSnapshot: () => ({ zoom: 1 }) }));
vi.mock("@api", () => ({ showDialog: vi.fn() }));
vi.mock("../lib/timelineSlicerStore", () => ({
  getTimelineById: () => h.timeline,
  deleteTimelineAsync: vi.fn(async () => undefined),
  updateTimelineSelectionAsync: vi.fn(async () => undefined),
}));
vi.mock("../handlers/selectionHandler", () => ({
  isTimelineSelected: () => true,
  selectTimeline: vi.fn(),
}));
vi.mock("../lib/timelineCanvasGeometry", () => ({ timelineAtCanvasPoint: () => h.timeline }));
vi.mock("../manifest", () => ({ TIMELINE_SETTINGS_DIALOG_ID: "timelineSlicer:settingsDialog" }));

import { setGridRegions, type GridRegion } from "@api/gridOverlays";
import { registerObjectGeometryProvider, resetObjectGeometryProviders } from "@api/objectGeometry";
import {
  SIZE_AND_POSITION_LABEL,
  SIZE_POSITION_NOT_INSTALLED,
  registerSizeAndPositionOpener,
  resetObjectPosition,
} from "@api/objectPosition";
import { closeTimelineContextMenu, handleTimelineContextMenu } from "../handlers/timelineSlicerContextMenu";

const REGION: GridRegion = {
  id: "timeline-slicer-tl-1",
  type: "timeline-slicer",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { x: 10, y: 10, width: 300, height: 120 },
  data: { timelineId: "tl-1" },
};
const OTHER: GridRegion = { ...REGION, id: "timeline-slicer-tl-2", data: { timelineId: "tl-2" } };

const cleanups: Array<() => void> = [];

function rightClick(): void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  handleTimelineContextMenu(new MouseEvent("contextmenu", { clientX: 50, clientY: 50, bubbles: true, cancelable: true }), container);
}

function menuRows(): HTMLElement[] {
  const menu = document.body.lastElementChild as HTMLElement;
  return Array.from(menu.children).filter((r) => (r as HTMLElement).textContent !== "") as HTMLElement[];
}

function row(label: string): HTMLElement {
  const found = menuRows().find((r) => r.textContent === label);
  if (!found) throw new Error(`no menu row "${label}"`);
  return found;
}

beforeEach(() => {
  resetObjectPosition();
  resetObjectGeometryProviders();
  cleanups.push(registerObjectGeometryProvider({ types: ["timeline-slicer"], commit: async () => {} }));
  setGridRegions([OTHER, REGION]);
});

afterEach(() => {
  closeTimelineContextMenu();
  while (cleanups.length) cleanups.pop()!();
  setGridRegions([]);
  document.body.innerHTML = "";
});

describe("the timeline menu's Size and Position...", () => {
  it("sits just above Remove Timeline and opens the dialog for THIS timeline's region", () => {
    const opened: GridRegion[] = [];
    cleanups.push(registerSizeAndPositionOpener((r) => opened.push(r)));
    rightClick();
    expect(menuRows().map((r) => r.textContent).slice(-2)).toEqual([SIZE_AND_POSITION_LABEL, "Remove Timeline"]);
    row(SIZE_AND_POSITION_LABEL).click();
    expect(opened.map((r) => r.id)).toEqual([REGION.id]);
  });

  it("with no dialog installed it is greyed, says why, and does nothing", () => {
    rightClick();
    const sizePos = row(SIZE_AND_POSITION_LABEL);
    expect(sizePos.style.cursor).toBe("default");
    expect(sizePos.title).toBe(SIZE_POSITION_NOT_INSTALLED);
    sizePos.click();
    expect(document.body.lastElementChild, "a greyed row closed the menu").toBe(sizePos.parentElement);
  });

  it("a timeline that is not published offers no row", () => {
    setGridRegions([OTHER]);
    cleanups.push(registerSizeAndPositionOpener(() => {}));
    rightClick();
    expect(menuRows().map((r) => r.textContent)).not.toContain(SIZE_AND_POSITION_LABEL);
  });
});
