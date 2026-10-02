//! FILENAME: app/extensions/Slicer/__tests__/slicerMenuSizePosition.test.ts
// PURPOSE: A slicer's right-click menu carries "Size and Position..." (BUG-0258
//          design phase 5b) -- the no-drag route every object menu offers --
//          just above "Remove Slicer", and choosing it opens the dialog for
//          THIS slicer's published region (@api/objectPosition's opener).
//          Greyed, with the reason as its tooltip, when no dialog is installed.
//          Driven through the real handler and the real DOM menu.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@api/state", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGridStateSnapshot: () => ({ zoom: 1, surface: "sheet", sheetContext: { activeSheetIndex: 0 } }),
}));
vi.mock("../lib/slicerCanvasGeometry", () => ({
  slicerAtCanvasPoint: () => ({ id: "s1" }),
}));
vi.mock("../lib/slicerStore", () => ({
  getSlicerById: (id: string) =>
    id === "s1" ? { id: "s1", name: "Region", selectedItems: null, selectionMode: "standard" } : undefined,
  getCachedItems: () => [],
  clickSlicerClearFilter: vi.fn(async () => undefined),
  updateSlicerAsync: vi.fn(async () => undefined),
  deleteSlicerAsync: vi.fn(async () => true),
}));

import { setGridRegions, type GridRegion } from "@api/gridOverlays";
import { registerObjectGeometryProvider, resetObjectGeometryProviders } from "@api/objectGeometry";
import {
  SIZE_AND_POSITION_LABEL,
  SIZE_POSITION_NOT_INSTALLED,
  registerSizeAndPositionOpener,
  resetObjectPosition,
} from "@api/objectPosition";
import { closeSlicerContextMenu, handleSlicerContextMenu } from "../handlers/slicerContextMenu";

const REGION: GridRegion = {
  id: "slicer-s1",
  type: "slicer",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { x: 40, y: 40, width: 180, height: 240 },
  data: { slicerId: "s1" },
};
const OTHER: GridRegion = { ...REGION, id: "slicer-s2", data: { slicerId: "s2" } };

let gridContainer: HTMLDivElement;
const cleanups: Array<() => void> = [];

function openMenu(): void {
  const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 60 });
  expect(handleSlicerContextMenu(e, gridContainer), "fixture: the right-click opened the slicer's menu").toBe(true);
}

/** The menu's rows (label text), separators left out. */
function rowLabels(): string[] {
  const menu = document.body.lastElementChild as HTMLElement;
  return Array.from(menu.children)
    .map((r) => (r as HTMLElement).textContent ?? "")
    .filter((t) => t !== "");
}

function row(label: string): HTMLElement {
  const menu = document.body.lastElementChild as HTMLElement;
  const found = Array.from(menu.children).find((r) => (r as HTMLElement).textContent === label);
  if (!found) throw new Error(`no menu row "${label}"`);
  return found as HTMLElement;
}

beforeEach(() => {
  resetObjectPosition();
  resetObjectGeometryProviders();
  cleanups.push(registerObjectGeometryProvider({ types: ["slicer"], commit: async () => {} }));
  setGridRegions([OTHER, REGION]);
  gridContainer = document.createElement("div");
  document.body.appendChild(gridContainer);
});

afterEach(() => {
  closeSlicerContextMenu();
  while (cleanups.length) cleanups.pop()!();
  setGridRegions([]);
  document.body.innerHTML = "";
});

describe("the slicer menu's Size and Position...", () => {
  it("sits just above Remove Slicer and opens the dialog for THIS slicer's region", () => {
    const opened: GridRegion[] = [];
    cleanups.push(registerSizeAndPositionOpener((r) => opened.push(r)));
    openMenu();
    const labels = rowLabels();
    expect(labels.slice(-2)).toEqual([SIZE_AND_POSITION_LABEL, "Remove Slicer"]);
    row(SIZE_AND_POSITION_LABEL).click();
    expect(opened.map((r) => r.id)).toEqual([REGION.id]);
  });

  it("with no dialog installed it is greyed, says why, and does nothing", () => {
    openMenu();
    const sizePos = row(SIZE_AND_POSITION_LABEL);
    expect(sizePos.style.cursor).toBe("default");
    expect(sizePos.title).toBe(SIZE_POSITION_NOT_INSTALLED);
    sizePos.click();
    expect(document.body.lastElementChild, "a greyed row closed the menu").toBe(sizePos.parentElement);
  });

  it("a slicer that is not published offers no row", () => {
    setGridRegions([OTHER]);
    cleanups.push(registerSizeAndPositionOpener(() => {}));
    openMenu();
    expect(rowLabels()).not.toContain(SIZE_AND_POSITION_LABEL);
  });
});
