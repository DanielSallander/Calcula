//! FILENAME: app/extensions/AutoFilter/lib/__tests__/filterStoreReapplyRefresh.test.ts
// PURPOSE: Data > Reapply re-SORTS as well as re-filters (BUG-0740: the
//          filter's remembered sort), which moves cells in the backend. Both
//          reapply routes must therefore fetch the cells again -- the bare
//          `grid:refresh` window event, not `app:grid-refresh`, which only
//          redraws what the canvas already cached (the canvas kept showing the
//          old order, and a user could type over a cell that no longer held
//          what it showed). A reapply that re-filtered but could not re-sort
//          says why (wave-4 verifier findings, tabxlsx-verify-15).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockReapplyAutoFilter = vi.fn();
const mockShowToast = vi.fn();

vi.mock("@api", () => ({
  applyAutoFilter: vi.fn(),
  removeAutoFilter: vi.fn(),
  clearAutoFilterCriteria: vi.fn(),
  reapplyAutoFilter: (...args: unknown[]) => mockReapplyAutoFilter(...args),
  clearColumnCriteria: vi.fn(),
  getAutoFilter: vi.fn(),
  getHiddenRows: vi.fn(),
  setColumnFilterValues: vi.fn(),
  getFilterUniqueValues: vi.fn(),
  detectDataRegion: vi.fn(),
  setHiddenRows: (rows: number[]) => ({ type: "SET_HIDDEN_ROWS", payload: rows }),
  dispatchGridAction: vi.fn(),
  emitAppEvent: vi.fn(),
  AppEvents: { GRID_REFRESH: "app:grid-refresh" },
  addGridRegions: vi.fn(),
  removeGridRegionsByType: vi.fn(),
  showToast: (...args: unknown[]) => mockShowToast(...args),
}));

vi.mock("@api/lib", () => ({
  sortRangeByColumn: vi.fn(),
  sortRange: vi.fn(),
  getViewportCells: vi.fn(),
  getStyle: vi.fn(),
  setColumnCustomFilter: vi.fn(),
  beginUndoTransaction: vi.fn().mockResolvedValue(undefined),
  commitUndoTransaction: vi.fn().mockResolvedValue(undefined),
  cancelUndoTransaction: vi.fn().mockResolvedValue(undefined),
}));

import { reapplyFilter, reapplyFilterCriteria, resetState } from "../filterStore";

function result(over: Record<string, unknown> = {}) {
  return {
    success: true,
    autoFilter: {
      id: "af",
      startRow: 0,
      startCol: 0,
      endRow: 6,
      endCol: 1,
      enabled: true,
      isDataFiltered: true,
      criteria: [null, null],
    },
    hiddenRows: [4],
    visibleRows: [1, 2, 3, 5, 6],
    error: null,
    ...over,
  };
}

let refetches = 0;
const onRefetch = () => {
  refetches += 1;
};

describe("Data > Reapply fetches the re-sorted cells again", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
    refetches = 0;
    window.addEventListener("grid:refresh", onRefetch);
  });
  afterEach(() => {
    window.removeEventListener("grid:refresh", onRefetch);
  });

  it("the Data menu's reapply refetches the cells", async () => {
    mockReapplyAutoFilter.mockResolvedValue(result());
    await reapplyFilter();
    expect(refetches).toBe(1);
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it("the command / controller reapply refetches the cells", async () => {
    mockReapplyAutoFilter.mockResolvedValue(result());
    await reapplyFilterCriteria();
    expect(refetches).toBe(1);
  });

  it("a reapply whose re-sort was refused says why", async () => {
    const why = "Cannot sort a range that partially overlaps with merged cells";
    mockReapplyAutoFilter.mockResolvedValue(result({ error: why }));
    await reapplyFilterCriteria();
    expect(mockShowToast).toHaveBeenCalledWith(why, { variant: "warning" });
    mockShowToast.mockClear();
    await reapplyFilter();
    expect(mockShowToast).toHaveBeenCalledWith(why, { variant: "warning" });
  });

  it("a refused reapply fetches nothing", async () => {
    mockReapplyAutoFilter.mockResolvedValue(result({ success: false, autoFilter: null, error: "no" }));
    await reapplyFilter();
    expect(refetches).toBe(0);
  });
});
