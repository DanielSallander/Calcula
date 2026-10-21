//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotFilteredViewConsumers.test.ts
// PURPOSE: The consumer census of a canvas pivot box's PAINT-ONLY filtered view
//          (P4 S7, lib/pivotCrossFilterView.ts). While another visual's
//          selection reaches a box it shows a TRANSIENT view whose
//          coordinates, field indices and groupPaths index a cache the
//          backend built for one read -- so every reader of a pivot view must
//          say WHICH view it reads:
//            - DISPLAYED (`getDisplayedPivotView`): what the box shows -- paint,
//              the clamp of the cell selection, keyboard moves, the formula
//              bar, Copy, the cross-filter click;
//            - REAL (`getCachedPivotView`): everything that ACTS on the pivot.
//              The ones a box cell can reach REFUSE while it is filtered (the
//              chrome, the field filter menu, the value edit, the drill, the
//              cell menu, which keeps only Copy and "Clear visual selection");
//              the rest are unchanged (names only, the hidden grid, worksheet
//              regions).
//          The census greps every call site in app/extensions (tests left
//          out) and fails on one this table does not classify -- a new
//          consumer must pick a row. The refusals are exercised here (filter
//          menu, cell menu, value edit) and in pivotVisualOverlay.test.ts (the
//          chrome and the double-click drill: no invoke, the note shown).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, resolve } from "path";

const h = vi.hoisted(() => ({
  showToast: vi.fn(),
  showOverlay: vi.fn(),
  getAtCell: vi.fn(),
  getFieldUniqueValues: vi.fn(),
  /** What the grid menu registry answers for the pivot group (its service is not mounted here). */
  menuItems: [] as Array<Record<string, unknown>>,
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  showToast: h.showToast,
  OverlayExtensions: { showOverlay: h.showOverlay, hideOverlay: vi.fn() },
  gridExtensions: { getContextMenuItemsForContext: () => h.menuItems },
}));

vi.mock("@api/pivot", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pivot: { getAtCell: h.getAtCell, getFieldUniqueValues: h.getFieldUniqueValues },
}));

import type { GridMenuContext } from "@api";
import { setGridRegions, type GridRegion } from "@api/gridOverlays";
import { clearCrossFilters, getCrossFilters, setCrossFilter } from "@api/reportFilters";
import { handleOpenFilterMenu } from "../../handlers/filterMenuHandler";
import { PIVOT_BOX_CLEAR_SELECTION_ITEM_ID, pivotBoxMenuItems } from "../pivotVisualContextMenu";
import { setFilteredPivotViewForTest } from "../pivotCrossFilterView";
import { PIVOT_VISUAL_REGION_TYPE } from "../pivotVisualRegions";
import type { PivotViewResponse } from "../pivot-api";

// ============================================================================
// The census
// ============================================================================

type Reads = "DISPLAYED" | "REAL" | "SEAM";

interface Row {
  file: string;
  fn: "getCachedPivotView" | "getDisplayedPivotView";
  count: number;
  reads: Reads;
  /** What happens while a filtered view shows. */
  whileFiltered: string;
}

const CENSUS: Row[] = [
  { file: "Pivot/lib/pivotVisualOverlay.ts", fn: "getDisplayedPivotView", count: 3, reads: "DISPLAYED", whileFiltered: "paints it plus the badge; clamps the cell selection to the shown grid (view update + filtered-view change)" },
  { file: "Pivot/lib/pivotCanvasCellKeys.ts", fn: "getDisplayedPivotView", count: 2, reads: "DISPLAYED", whileFiltered: "keyboard moves walk the shown grid; Copy copies what is shown (text)" },
  { file: "Pivot/lib/pivotCellFormulaBar.ts", fn: "getDisplayedPivotView", count: 1, reads: "DISPLAYED", whileFiltered: "shows the shown text, read-only" },
  { file: "Pivot/lib/pivotCrossFilterClick.ts", fn: "getDisplayedPivotView", count: 1, reads: "DISPLAYED", whileFiltered: "a click reads the member of the cell shown" },
  { file: "Pivot/lib/pivotCrossFilterView.ts", fn: "getDisplayedPivotView", count: 1, reads: "SEAM", whileFiltered: "the definition" },
  { file: "Pivot/lib/pivotCrossFilterView.ts", fn: "getCachedPivotView", count: 2, reads: "SEAM", whileFiltered: "the displayed fallback; the real version a filtered read pairs with" },
  { file: "Pivot/lib/pivotViewStore.ts", fn: "getCachedPivotView", count: 1, reads: "SEAM", whileFiltered: "the definition" },
  { file: "Pivot/lib/pivotChromeActions.ts", fn: "getCachedPivotView", count: 2, reads: "REAL", whileFiltered: "REFUSED from a box (handlePivotVisualPress, the box double-click) with the note" },
  { file: "Pivot/handlers/filterMenuHandler.ts", fn: "getCachedPivotView", count: 1, reads: "REAL", whileFiltered: "REFUSED when opened from a box cell, before any backend call; allowed from the field list, a PivotChart, the ribbon" },
  { file: "Pivot/handlers/pivotContextMenuHelpers.ts", fn: "getCachedPivotView", count: 1, reads: "REAL", whileFiltered: "the box menu offers only Copy and Clear visual selection" },
  { file: "Pivot/lib/writebackEditing.ts", fn: "getCachedPivotView", count: 1, reads: "REAL", whileFiltered: "REFUSED: resolveWritebackCell answers not-editable first" },
  { file: "Pivot/lib/valueFieldEdits.ts", fn: "getCachedPivotView", count: 1, reads: "REAL", whileFiltered: "unchanged (value field names only, no groupPath)" },
  { file: "Pivot/index.ts", fn: "getCachedPivotView", count: 6, reads: "REAL", whileFiltered: "unchanged: refresh-cache bookkeeping, autofit of the hidden grid, worksheet-region double-click and paint" },
];

const EXTENSIONS = resolve(__dirname, "../../..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      out.push(...sourceFiles(p));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/** file -> fn -> number of call sites (comments stripped). */
function callSites(): Map<string, number> {
  const found = new Map<string, number>();
  for (const file of sourceFiles(EXTENSIONS)) {
    const src = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const fn of ["getCachedPivotView", "getDisplayedPivotView"] as const) {
      const n = src.split(`${fn}(`).length - 1;
      if (n > 0) found.set(`${relative(EXTENSIONS, file).replace(/\\/g, "/")}|${fn}`, n);
    }
  }
  return found;
}

describe("the consumer census", () => {
  it("every call site of a pivot view is classified, with the counts the table states", () => {
    const found = callSites();
    const table = new Map(CENSUS.map((r) => [`${r.file}|${r.fn}`, r.count]));
    const unclassified = [...found.keys()].filter((k) => !table.has(k));
    expect(unclassified, "a new reader of a pivot view: pick a row (DISPLAYED or REAL) in CENSUS").toEqual([]);
    for (const [k, n] of table) {
      expect(found.get(k) ?? 0, `${k}: the call sites changed -- re-classify them`).toBe(n);
    }
  });

  it("no DISPLAYED reader calls getCachedPivotView, and nothing outside Pivot reads a pivot view", () => {
    const found = callSites();
    for (const r of CENSUS.filter((row) => row.reads === "DISPLAYED")) {
      expect(found.get(`${r.file}|getCachedPivotView`) ?? 0, `${r.file} reads the REAL view`).toBe(0);
    }
    expect([...found.keys()].filter((k) => !k.startsWith("Pivot/"))).toEqual([]);
  });

  it("the value edit refuses BEFORE it reads the real view", () => {
    const src = readFileSync(resolve(__dirname, "../writebackEditing.ts"), "utf8");
    const fn = src.slice(src.indexOf("export function resolveWritebackCell("));
    const guard = fn.indexOf("if (isShowingFilteredView(pivotId)) return null;");
    const read = fn.indexOf("getCachedPivotView(pivotId)");
    expect(guard, "the guard is gone").toBeGreaterThan(0);
    expect(guard).toBeLessThan(read);
  });
});

// ============================================================================
// The refusals
// ============================================================================

const NOTE = "Filtered by Sales chart -- clear the selection to change this PivotTable here";

const boxRegion: GridRegion = {
  id: "pivot-visual-p1",
  type: PIVOT_VISUAL_REGION_TYPE,
  startRow: 0,
  startCol: 1024,
  endRow: 9,
  endCol: 1027,
  floating: { x: 0, y: 0, width: 300, height: 200 },
  data: { pivotId: "p1" },
};

const shown = { pivotId: "p1", version: 1, rows: [], columns: [] } as unknown as PivotViewResponse;

beforeEach(() => {
  vi.clearAllMocks();
  setGridRegions([boxRegion]);
  clearCrossFilters();
  setFilteredPivotViewForTest("p1", {
    view: shown,
    sources: ["Sales chart"],
    sourceRefs: [{ kind: "chart", id: "c1" }],
  });
});

afterEach(() => {
  setFilteredPivotViewForTest("p1", null);
  setGridRegions([]);
  clearCrossFilters();
  h.menuItems = [];
});

describe("refused while filtered", () => {
  it("the field filter menu from a box cell: no backend call, no menu, the note", async () => {
    await handleOpenFilterMenu({ fieldIndex: 0, fieldName: "Region", row: 2, col: 1025, anchorX: 0, anchorY: 0 });
    expect(h.getAtCell).not.toHaveBeenCalled();
    expect(h.getFieldUniqueValues).not.toHaveBeenCalled();
    expect(h.showOverlay).not.toHaveBeenCalled();
    expect(h.showToast).toHaveBeenCalledWith(NOTE, { variant: "info" });
  });

  it("control: the same menu from a PivotChart (it names its pivot) opens on the real pivot", async () => {
    h.getFieldUniqueValues.mockResolvedValue({ members: [] });
    await handleOpenFilterMenu({ fieldIndex: 0, fieldName: "Region", row: 2, col: 1025, anchorX: 0, anchorY: 0, pivotId: "p1" });
    expect(h.showOverlay).toHaveBeenCalled();
    expect(h.showToast).not.toHaveBeenCalled();
  });

  it("control: from a box cell once the selection is gone, the menu opens", async () => {
    setFilteredPivotViewForTest("p1", null);
    h.getAtCell.mockResolvedValue({ pivotId: "p1" });
    h.getFieldUniqueValues.mockResolvedValue({ members: [] });
    await handleOpenFilterMenu({ fieldIndex: 0, fieldName: "Region", row: 2, col: 1025, anchorX: 0, anchorY: 0 });
    expect(h.getAtCell).toHaveBeenCalled();
    expect(h.showOverlay).toHaveBeenCalled();
  });

  it("the cell menu keeps only Copy and 'Clear visual selection' (which clears the selection, nothing else)", () => {
    h.menuItems = [
      { id: "pivot:copy", label: "Copy", group: "pivot", order: 2, onClick: vi.fn() },
      { id: "pivot:expandField", label: "Expand Entire Field", group: "pivot", order: 30, onClick: vi.fn() },
    ];
    const context = {
      selection: { startRow: 2, startCol: 1025, endRow: 2, endCol: 1025, type: "cells" },
      clickedCell: { row: 2, col: 1025 },
      isWithinSelection: true,
      sheetIndex: 0,
      sheetName: "Canvas1",
    } as unknown as GridMenuContext;
    const pivotIds = (items: ReturnType<typeof pivotBoxMenuItems>) => items.filter((i) => i.group === "pivot" && !i.id.startsWith("pivot.box.s") && !i.id.startsWith("pivot.box.f")).map((i) => i.id);

    const items = pivotBoxMenuItems(context, boxRegion);
    expect(pivotIds(items)).toEqual(["pivot:copy", PIVOT_BOX_CLEAR_SELECTION_ITEM_ID]);

    setCrossFilter({
      source: { kind: "chart", id: "c1" },
      sourceName: "Sales chart",
      pageSheetId: "sheet-2",
      connectionId: "conn-1",
      fields: ["Geo.Region"],
      tuples: [["East"]],
    });
    items.find((i) => i.id === PIVOT_BOX_CLEAR_SELECTION_ITEM_ID)!.onClick(context);
    expect(getCrossFilters()).toEqual([]);

    // Control: not filtered, every pivot item is offered and no clear row.
    setFilteredPivotViewForTest("p1", null);
    expect(pivotIds(pivotBoxMenuItems(context, boxRegion))).toEqual(["pivot:copy", "pivot:expandField"]);
  });
});
