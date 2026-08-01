//! FILENAME: app/extensions/AutoFilter/lib/__tests__/filterStoreController.test.ts
// PURPOSE: The AutoFilterController this extension publishes to @api — the
//          callable, UI-free path a script reaches column filtering through.
// CONTEXT: The controller exists so the SCRIPT path updates exactly what a
//          CLICK updates. What is asserted here is that equivalence, because
//          the ways it can go wrong are silent:
//            - a stale cached range makes the next chevron click filter a
//              DIFFERENT column (clicks send indexes relative to the cache);
//            - hidden rows that never reach Core leave the grid showing rows
//              the workbook believes are filtered out;
//            - a refused operation that resolves anyway tells a script the
//              filter took effect when it did not.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockApplyAutoFilter = vi.fn();
const mockRemoveAutoFilter = vi.fn();
const mockClearAutoFilterCriteria = vi.fn();
const mockReapplyAutoFilter = vi.fn();
const mockClearColumnCriteria = vi.fn();
const mockGetAutoFilter = vi.fn();
const mockGetHiddenRows = vi.fn();
const mockSetColumnFilterValues = vi.fn();
const mockGetFilterUniqueValues = vi.fn();
const mockDetectDataRegion = vi.fn();
const mockSetHiddenRows = vi.fn((rows: number[]) => ({ type: "SET_HIDDEN_ROWS", payload: rows }));
const mockDispatchGridAction = vi.fn();
const mockEmitAppEvent = vi.fn();
const mockAddGridRegions = vi.fn();
const mockRemoveGridRegionsByType = vi.fn();

vi.mock("@api", () => ({
  applyAutoFilter: (...args: unknown[]) => mockApplyAutoFilter(...args),
  removeAutoFilter: (...args: unknown[]) => mockRemoveAutoFilter(...args),
  clearAutoFilterCriteria: (...args: unknown[]) => mockClearAutoFilterCriteria(...args),
  reapplyAutoFilter: (...args: unknown[]) => mockReapplyAutoFilter(...args),
  clearColumnCriteria: (...args: unknown[]) => mockClearColumnCriteria(...args),
  getAutoFilter: (...args: unknown[]) => mockGetAutoFilter(...args),
  getHiddenRows: (...args: unknown[]) => mockGetHiddenRows(...args),
  setColumnFilterValues: (...args: unknown[]) => mockSetColumnFilterValues(...args),
  getFilterUniqueValues: (...args: unknown[]) => mockGetFilterUniqueValues(...args),
  detectDataRegion: (...args: unknown[]) => mockDetectDataRegion(...args),
  setHiddenRows: (rows: number[]) => mockSetHiddenRows(rows),
  dispatchGridAction: (...args: unknown[]) => mockDispatchGridAction(...args),
  emitAppEvent: (...args: unknown[]) => mockEmitAppEvent(...args),
  AppEvents: { GRID_REFRESH: "app:grid-refresh" },
  addGridRegions: (...args: unknown[]) => mockAddGridRegions(...args),
  removeGridRegionsByType: (...args: unknown[]) => mockRemoveGridRegionsByType(...args),
}));

const mockSetColumnCustomFilter = vi.fn();
vi.mock("@api/lib", () => ({
  sortRangeByColumn: vi.fn(),
  sortRange: vi.fn(),
  getViewportCells: vi.fn(),
  getStyle: vi.fn(),
  setColumnCustomFilter: (...args: unknown[]) => mockSetColumnCustomFilter(...args),
  beginUndoTransaction: vi.fn().mockResolvedValue(undefined),
  commitUndoTransaction: vi.fn().mockResolvedValue(undefined),
  cancelUndoTransaction: vi.fn().mockResolvedValue(undefined),
}));

import {
  createAutoFilterController,
  getAutoFilterInfo,
  resetState,
} from "../filterStore";

/** The backend's AutoFilterInfo for a filter over C1:F21 (start col 2). */
function info(over: Record<string, unknown> = {}) {
  return {
    id: "af-uuid",
    startRow: 0,
    startCol: 2,
    endRow: 20,
    endCol: 5,
    enabled: true,
    isDataFiltered: false,
    criteria: [null, null, null, null],
    ...over,
  };
}

function okResult(over: Record<string, unknown> = {}) {
  return {
    success: true,
    autoFilter: info(),
    hiddenRows: [],
    visibleRows: [],
    ...over,
  };
}

beforeEach(() => {
  resetState();
  vi.clearAllMocks();
});

describe("the controller drives the SAME state a click drives", () => {
  it("apply() adopts the range into the cache and paints the chevron region", async () => {
    mockApplyAutoFilter.mockResolvedValue(okResult({ hiddenRows: [5, 6] }));
    const filter = createAutoFilterController();

    const snap = await filter.apply(0, 2, 20, 5);

    // 1. the cache the chevron click resolves column indexes against
    expect(getAutoFilterInfo()?.startCol).toBe(2);
    // 2. the overlay region that paints the buttons, on the HEADER ROW only
    expect(mockAddGridRegions).toHaveBeenCalledWith([
      expect.objectContaining({ type: "autofilter", startRow: 0, endRow: 0, startCol: 2, endCol: 5 }),
    ]);
    // 3. the hidden rows pushed into Core, or the grid shows filtered-out rows
    expect(mockSetHiddenRows).toHaveBeenCalledWith([5, 6]);
    expect(mockDispatchGridAction).toHaveBeenCalled();
    // 4. what the caller is told
    expect(snap.startCol).toBe(2);
    expect(snap.hiddenRows).toEqual([5, 6]);
  });

  it("setColumn() routes VALUES and RULES to their own backend commands", async () => {
    mockSetColumnFilterValues.mockResolvedValue(okResult({ hiddenRows: [3] }));
    mockSetColumnCustomFilter.mockResolvedValue(okResult({ hiddenRows: [4] }));
    const filter = createAutoFilterController();

    await filter.setColumn(1, { kind: "values", values: ["North"], includeBlanks: true });
    expect(mockSetColumnFilterValues).toHaveBeenCalledWith(1, ["North"], true);

    await filter.setColumn(2, { kind: "custom", criterion1: ">=100", criterion2: "<200", operator: "or" });
    expect(mockSetColumnCustomFilter).toHaveBeenCalledWith(2, ">=100", "<200", "or");
  });

  it("includeBlanks defaults to false, not undefined", async () => {
    mockSetColumnFilterValues.mockResolvedValue(okResult());
    await createAutoFilterController().setColumn(0, { kind: "values", values: ["x"] });
    expect(mockSetColumnFilterValues).toHaveBeenCalledWith(0, ["x"], false);
  });

  it("clear(null) clears EVERY column; clear(n) clears one", async () => {
    mockClearAutoFilterCriteria.mockResolvedValue(okResult());
    mockClearColumnCriteria.mockResolvedValue(okResult());
    const filter = createAutoFilterController();

    await filter.clear(null);
    expect(mockClearAutoFilterCriteria).toHaveBeenCalledTimes(1);
    expect(mockClearColumnCriteria).not.toHaveBeenCalled();

    await filter.clear(2);
    expect(mockClearColumnCriteria).toHaveBeenCalledWith(2);
  });

  it("remove() empties the cache, the region and the hidden rows", async () => {
    mockApplyAutoFilter.mockResolvedValue(okResult({ hiddenRows: [1] }));
    mockRemoveAutoFilter.mockResolvedValue({ success: true, hiddenRows: [], visibleRows: [] });
    const filter = createAutoFilterController();
    await filter.apply(0, 2, 20, 5);
    mockSetHiddenRows.mockClear();

    await filter.remove();

    expect(getAutoFilterInfo()).toBeNull();
    expect(mockRemoveGridRegionsByType).toHaveBeenCalledWith("autofilter");
    expect(mockSetHiddenRows).toHaveBeenCalledWith([]);
  });

  it("get() REPAIRS a cache that has drifted from the workbook", async () => {
    // The failure this prevents: a structural edit moved the filter, the cache
    // still says start_col 2, and the next chevron click filters the wrong
    // column because it sends an index relative to the stale start.
    mockApplyAutoFilter.mockResolvedValue(okResult());
    const filter = createAutoFilterController();
    await filter.apply(0, 2, 20, 5);
    expect(getAutoFilterInfo()?.startCol).toBe(2);

    mockGetAutoFilter.mockResolvedValue(info({ startCol: 4, endCol: 7 }));
    mockGetHiddenRows.mockResolvedValue([9, 2]);
    const snap = await filter.get();

    expect(getAutoFilterInfo()?.startCol).toBe(4);
    expect(snap?.startCol).toBe(4);
    // Sorted, so a caller can compare two reads without normalising first.
    expect(snap?.hiddenRows).toEqual([2, 9]);
  });

  it("get() returns null and clears the cache when the filter is gone", async () => {
    mockApplyAutoFilter.mockResolvedValue(okResult());
    const filter = createAutoFilterController();
    await filter.apply(0, 2, 20, 5);
    mockGetAutoFilter.mockResolvedValue(null);

    expect(await filter.get()).toBeNull();
    expect(getAutoFilterInfo()).toBeNull();
    expect(mockGetHiddenRows).not.toHaveBeenCalled();
  });

  it("projects per-column criteria at their RELATIVE index", async () => {
    mockGetAutoFilter.mockResolvedValue(
      info({
        criteria: [
          null,
          {
            filterOn: "values",
            values: ["North", "South"],
            filterOutBlanks: true,
            criterion1: null,
            criterion2: null,
            operator: null,
          },
          null,
          null,
        ],
      }),
    );
    mockGetHiddenRows.mockResolvedValue([]);
    const snap = await createAutoFilterController().get();
    expect(snap?.columns[0]).toBeNull();
    expect(snap?.columns[1]).toEqual({
      columnIndex: 1,
      filterOn: "values",
      values: ["North", "South"],
      criterion1: null,
      criterion2: null,
      operator: null,
      filterOutBlanks: true,
    });
  });

  it("listValues() surfaces a refusal instead of an empty list", async () => {
    mockGetFilterUniqueValues.mockResolvedValue({ success: false, values: [], hasBlanks: false, error: "No AutoFilter exists for this sheet" });
    await expect(createAutoFilterController().listValues(0)).rejects.toThrow(
      /No AutoFilter exists/,
    );
    mockGetFilterUniqueValues.mockResolvedValue({
      success: true,
      values: [{ value: "North", count: 4 }],
      hasBlanks: true,
    });
    await expect(createAutoFilterController().listValues(0)).resolves.toEqual({
      values: [{ value: "North", count: 4 }],
      hasBlanks: true,
    });
  });
});

describe("a refused operation must REJECT, never resolve quietly", () => {
  // The UI paths above ignore `success: false` (a click that does nothing is
  // self-evident to a person). A script has no such feedback, so a filter that
  // was refused — a protected sheet, no filter on the sheet — must throw.
  it("apply / setColumn / clear / remove all reject on refusal", async () => {
    const refusal = { success: false, error: "This sheet is protected", hiddenRows: [], visibleRows: [] };
    mockApplyAutoFilter.mockResolvedValue(refusal);
    mockSetColumnFilterValues.mockResolvedValue(refusal);
    mockSetColumnCustomFilter.mockResolvedValue(refusal);
    mockClearColumnCriteria.mockResolvedValue(refusal);
    mockClearAutoFilterCriteria.mockResolvedValue(refusal);
    mockRemoveAutoFilter.mockResolvedValue(refusal);
    const filter = createAutoFilterController();

    await expect(filter.apply(0, 0, 5, 3)).rejects.toThrow(/protected/);
    await expect(filter.setColumn(0, { kind: "values", values: [] })).rejects.toThrow(/protected/);
    await expect(filter.setColumn(0, { kind: "custom", criterion1: ">1" })).rejects.toThrow(/protected/);
    await expect(filter.clear(0)).rejects.toThrow(/protected/);
    await expect(filter.clear(null)).rejects.toThrow(/protected/);
    await expect(filter.remove()).rejects.toThrow(/protected/);
  });

  it("a refused apply leaves the cache untouched", async () => {
    mockApplyAutoFilter.mockResolvedValue(okResult());
    const filter = createAutoFilterController();
    await filter.apply(0, 2, 20, 5);
    mockApplyAutoFilter.mockResolvedValue({ success: false, error: "nope", hiddenRows: [], visibleRows: [] });
    await expect(filter.apply(0, 0, 1, 1)).rejects.toThrow();
    expect(getAutoFilterInfo()?.startCol).toBe(2);
  });
});
