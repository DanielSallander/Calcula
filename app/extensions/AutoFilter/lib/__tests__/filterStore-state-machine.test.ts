//! FILENAME: app/extensions/AutoFilter/lib/__tests__/filterStore-state-machine.test.ts
// PURPOSE: State machine tests for the AutoFilter store.
// CONTEXT: Models filter lifecycle, multi-column state, and sort+filter interaction.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock @api
vi.mock('@api', () => ({
  applyAutoFilter: vi.fn(),
  removeAutoFilter: vi.fn().mockResolvedValue(undefined),
  clearAutoFilterCriteria: vi.fn(),
  reapplyAutoFilter: vi.fn(),
  clearColumnCriteria: vi.fn(),
  getAutoFilter: vi.fn(),
  getHiddenRows: vi.fn().mockResolvedValue([]),
  setColumnFilterValues: vi.fn(),
  getFilterUniqueValues: vi.fn().mockResolvedValue([]),
  detectDataRegion: vi.fn(),
  setHiddenRows: vi.fn().mockReturnValue({ type: 'SET_HIDDEN_ROWS', payload: [] }),
  dispatchGridAction: vi.fn(),
  emitAppEvent: vi.fn(),
  AppEvents: { GRID_REFRESH: 'app:grid-refresh' },
  addGridRegions: vi.fn(),
  removeGridRegionsByType: vi.fn(),
}));

vi.mock('@api/lib', () => ({
  sortRangeByColumn: vi.fn(),
  sortRange: vi.fn(),
  getViewportCells: vi.fn().mockResolvedValue([]),
  getStyle: vi.fn().mockResolvedValue({}),
  setColumnCustomFilter: vi.fn(),
}));

vi.mock('../../lib/filterEvents', () => ({
  FilterEvents: {
    FILTER_TOGGLED: 'filter:toggled',
    FILTER_APPLIED: 'filter:applied',
    FILTER_CLEARED: 'filter:cleared',
    FILTER_STATE_REFRESHED: 'filter:state-refreshed',
  },
}));

// Mock window object for filterStore's window.dispatchEvent calls
vi.stubGlobal('window', {
  dispatchEvent: vi.fn(),
});
vi.stubGlobal('dispatchEvent', vi.fn());
vi.stubGlobal('CustomEvent', class CustomEvent {
  type: string;
  detail: unknown;
  constructor(type: string, opts?: { detail?: unknown }) {
    this.type = type;
    this.detail = opts?.detail;
  }
});

import {
  getFilterState,
  isFilterActive,
  toggleFilter,
  applyColumnFilter,
  clearColumnFilter,
  clearAllFilters,
  reapplyFilter,
  sortByColumn,
  setCurrentSelection,
  setOpenDropdownCol,
  getOpenDropdownCol,
  resetState,
  refreshFilterState,
} from '../../lib/filterStore';
import * as apiModule from '@api';
import * as apiLib from '@api/lib';

const api = vi.mocked(apiModule);
const lib = vi.mocked(apiLib);

function mockAutoFilterInfo(cols = 3) {
  return {
    startRow: 0,
    startCol: 0,
    endRow: 10,
    endCol: cols - 1,
    enabled: true,
    columns: Array.from({ length: cols }, (_, i) => ({
      index: i,
      criteria: null,
      hasFilter: false,
    })),
  };
}

function mockFilterResult(cols = 3) {
  return {
    success: true,
    autoFilter: mockAutoFilterInfo(cols),
    hiddenRows: [],
  };
}

describe('AutoFilter Store - Filter Lifecycle State Machine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  // States: inactive -> toggled-on -> filter-applied -> cleared -> reapplied -> toggled-off

  it('starts inactive', () => {
    expect(isFilterActive()).toBe(false);
    expect(getFilterState().autoFilterInfo).toBeNull();
  });

  it('inactive -> toggled-on: toggleFilter creates filter', async () => {
    setCurrentSelection({ startRow: 0, startCol: 0, endRow: 5, endCol: 2 });
    api.applyAutoFilter.mockResolvedValueOnce(mockFilterResult());

    await toggleFilter();
    expect(isFilterActive()).toBe(true);
    expect(getFilterState().autoFilterInfo).not.toBeNull();
  });

  it('toggled-on -> filter-applied: applyColumnFilter', async () => {
    // First activate
    setCurrentSelection({ startRow: 0, startCol: 0, endRow: 5, endCol: 2 });
    api.applyAutoFilter.mockResolvedValueOnce(mockFilterResult());
    await toggleFilter();

    // Apply column filter
    const resultWithFilter = mockFilterResult();
    resultWithFilter.hiddenRows = [2, 4];
    api.setColumnFilterValues.mockResolvedValueOnce(resultWithFilter);
    await applyColumnFilter(0, ['A', 'B'], true);

    expect(isFilterActive()).toBe(true);
    expect(api.setColumnFilterValues).toHaveBeenCalledWith(0, ['A', 'B'], true);
  });

  it('filter-applied -> cleared: clearColumnFilter', async () => {
    setCurrentSelection({ startRow: 0, startCol: 0, endRow: 5, endCol: 2 });
    api.applyAutoFilter.mockResolvedValueOnce(mockFilterResult());
    await toggleFilter();

    api.clearColumnCriteria.mockResolvedValueOnce(mockFilterResult());
    await clearColumnFilter(0);

    expect(isFilterActive()).toBe(true);
    expect(api.clearColumnCriteria).toHaveBeenCalledWith(0);
  });

  it('cleared -> reapplied: reapplyFilter', async () => {
    setCurrentSelection({ startRow: 0, startCol: 0, endRow: 5, endCol: 2 });
    api.applyAutoFilter.mockResolvedValueOnce(mockFilterResult());
    await toggleFilter();

    api.reapplyAutoFilter.mockResolvedValueOnce(mockFilterResult());
    await reapplyFilter();

    expect(isFilterActive()).toBe(true);
    expect(api.reapplyAutoFilter).toHaveBeenCalled();
  });

  it('toggled-on -> toggled-off: toggleFilter removes filter', async () => {
    setCurrentSelection({ startRow: 0, startCol: 0, endRow: 5, endCol: 2 });
    api.applyAutoFilter.mockResolvedValueOnce(mockFilterResult());
    await toggleFilter();
    expect(isFilterActive()).toBe(true);

    // Toggle off
    await toggleFilter();
    expect(isFilterActive()).toBe(false);
    expect(getFilterState().autoFilterInfo).toBeNull();
  });

  it('full lifecycle: inactive -> on -> apply -> clear -> reapply -> off', async () => {
    // 1. inactive
    expect(isFilterActive()).toBe(false);

    // 2. toggle on
    setCurrentSelection({ startRow: 0, startCol: 0, endRow: 10, endCol: 2 });
    api.applyAutoFilter.mockResolvedValueOnce(mockFilterResult());
    await toggleFilter();
    expect(isFilterActive()).toBe(true);

    // 3. apply filter
    api.setColumnFilterValues.mockResolvedValueOnce(mockFilterResult());
    await applyColumnFilter(0, ['X'], false);

    // 4. clear filter
    api.clearColumnCriteria.mockResolvedValueOnce(mockFilterResult());
    await clearColumnFilter(0);

    // 5. reapply
    api.reapplyAutoFilter.mockResolvedValueOnce(mockFilterResult());
    await reapplyFilter();

    // 6. toggle off
    await toggleFilter();
    expect(isFilterActive()).toBe(false);
  });

  // --- Multi-column filter state ---

  it('multi-column: apply filters to different columns independently', async () => {
    setCurrentSelection({ startRow: 0, startCol: 0, endRow: 10, endCol: 4 });
    api.applyAutoFilter.mockResolvedValueOnce(mockFilterResult(5));
    await toggleFilter();

    // Apply filter to col 0
    api.setColumnFilterValues.mockResolvedValueOnce(mockFilterResult(5));
    await applyColumnFilter(0, ['A'], false);

    // Apply filter to col 2
    api.setColumnFilterValues.mockResolvedValueOnce(mockFilterResult(5));
    await applyColumnFilter(2, ['B'], true);

    expect(api.setColumnFilterValues).toHaveBeenCalledTimes(2);
    expect(isFilterActive()).toBe(true);
  });

  it('clearAllFilters clears all column criteria', async () => {
    setCurrentSelection({ startRow: 0, startCol: 0, endRow: 5, endCol: 2 });
    api.applyAutoFilter.mockResolvedValueOnce(mockFilterResult());
    await toggleFilter();

    api.clearAutoFilterCriteria.mockResolvedValueOnce(mockFilterResult());
    await clearAllFilters();

    expect(api.clearAutoFilterCriteria).toHaveBeenCalled();
    expect(isFilterActive()).toBe(true); // Filter range still active, just criteria cleared
  });

  // --- Sort + filter interaction ---

  it('sortByColumn triggers reapply after sort', async () => {
    setCurrentSelection({ startRow: 0, startCol: 0, endRow: 10, endCol: 2 });
    api.applyAutoFilter.mockResolvedValueOnce(mockFilterResult());
    await toggleFilter();

    lib.sortRangeByColumn.mockResolvedValueOnce({ success: true });
    api.reapplyAutoFilter.mockResolvedValueOnce(mockFilterResult());

    await sortByColumn(0, true);

    expect(lib.sortRangeByColumn).toHaveBeenCalled();
    expect(api.reapplyAutoFilter).toHaveBeenCalled();
  });

  it('sortByColumn is no-op when no filter is active', async () => {
    await sortByColumn(0, true);
    expect(lib.sortRangeByColumn).not.toHaveBeenCalled();
  });

  // --- Dropdown state ---

  it('dropdown column state tracks open/close', () => {
    expect(getOpenDropdownCol()).toBeNull();
    setOpenDropdownCol(2);
    expect(getOpenDropdownCol()).toBe(2);
    setOpenDropdownCol(null);
    expect(getOpenDropdownCol()).toBeNull();
  });

  it('toggle off clears dropdown state', async () => {
    setCurrentSelection({ startRow: 0, startCol: 0, endRow: 5, endCol: 2 });
    api.applyAutoFilter.mockResolvedValueOnce(mockFilterResult());
    await toggleFilter();

    setOpenDropdownCol(1);
    expect(getOpenDropdownCol()).toBe(1);

    await toggleFilter();
    expect(getOpenDropdownCol()).toBeNull();
  });

  // --- refreshFilterState ---

  it('refreshFilterState restores state from backend', async () => {
    api.getAutoFilter.mockResolvedValueOnce(mockAutoFilterInfo());
    await refreshFilterState();
    expect(isFilterActive()).toBe(true);
  });

  it('refreshFilterState clears state when backend has no filter', async () => {
    // First set up active filter
    setCurrentSelection({ startRow: 0, startCol: 0, endRow: 5, endCol: 2 });
    api.applyAutoFilter.mockResolvedValueOnce(mockFilterResult());
    await toggleFilter();
    expect(isFilterActive()).toBe(true);

    // Backend says no filter
    api.getAutoFilter.mockResolvedValueOnce(null);
    await refreshFilterState();
    expect(isFilterActive()).toBe(false);
  });

  // --- resetState ---

  it('resetState returns to initial state', async () => {
    setCurrentSelection({ startRow: 0, startCol: 0, endRow: 5, endCol: 2 });
    api.applyAutoFilter.mockResolvedValueOnce(mockFilterResult());
    await toggleFilter();
    setOpenDropdownCol(2);

    resetState();

    expect(isFilterActive()).toBe(false);
    expect(getFilterState().autoFilterInfo).toBeNull();
    expect(getOpenDropdownCol()).toBeNull();
  });

  // --- Edge cases ---

  it('toggleFilter with no selection tries detectDataRegion', async () => {
    setCurrentSelection(null);
    api.detectDataRegion.mockResolvedValueOnce([0, 0, 10, 3]);
    api.applyAutoFilter.mockResolvedValueOnce(mockFilterResult());

    await toggleFilter();
    expect(api.detectDataRegion).toHaveBeenCalledWith(0, 0);
    expect(isFilterActive()).toBe(true);
  });

  it('toggleFilter with single-cell selection uses detectDataRegion', async () => {
    setCurrentSelection({ startRow: 3, startCol: 2, endRow: 3, endCol: 2 });
    api.detectDataRegion.mockResolvedValueOnce([0, 0, 10, 5]);
    api.applyAutoFilter.mockResolvedValueOnce(mockFilterResult());

    await toggleFilter();
    expect(api.detectDataRegion).toHaveBeenCalledWith(3, 2);
    expect(isFilterActive()).toBe(true);
  });
});
