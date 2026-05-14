//! FILENAME: app/extensions/Pivot/lib/pivotViewStore.test.ts
// PURPOSE: Tests for the pivot view store (cache, operation sequencing, cancellation, loading state).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  cachePivotView,
  getCachedPivotView,
  getCachedPivotVersion,
  deleteCachedPivotView,
  isCacheFresh,
  consumeFreshFlag,
  setCachedPivotView,
  startOperation,
  isCurrentOperation,
  markUserCancelled,
  isUserCancelled,
  clearUserCancelled,
  setLoading,
  clearLoading,
  isLoading,
  getLoadingState,
  preserveCurrentView,
  restorePreviousView,
  clearPreviousView,
} from './pivotViewStore';
import type { PivotViewResponse } from './pivot-api';

/** Minimal PivotViewResponse stub. */
function mockView(pivotId: number, version = 1): PivotViewResponse {
  return {
    pivotId,
    version,
    rowCount: 5,
    colCount: 3,
    rowLabelColCount: 1,
    columnHeaderRowCount: 1,
    filterRowCount: 0,
    filterRows: [],
    rowFieldSummaries: [],
    columnFieldSummaries: [],
    rows: [],
    columns: [],
  };
}

describe('Pivot View Cache', () => {
  beforeEach(() => {
    // Clean up by deleting test pivots
    deleteCachedPivotView(999);
    deleteCachedPivotView(998);
  });

  it('caches and retrieves a pivot view', () => {
    const view = mockView(999);
    cachePivotView(999, view);
    expect(getCachedPivotView(999)).toBe(view);
  });

  it('returns undefined for non-existent pivot', () => {
    expect(getCachedPivotView(12345)).toBeUndefined();
  });

  it('getCachedPivotVersion returns -1 for unknown pivot', () => {
    expect(getCachedPivotVersion(12345)).toBe(-1);
  });

  it('getCachedPivotVersion returns version for cached pivot', () => {
    cachePivotView(999, mockView(999, 42));
    expect(getCachedPivotVersion(999)).toBe(42);
  });

  it('deleteCachedPivotView removes the cache entry', () => {
    cachePivotView(999, mockView(999));
    deleteCachedPivotView(999);
    expect(getCachedPivotView(999)).toBeUndefined();
  });
});

describe('Cache freshness', () => {
  beforeEach(() => {
    deleteCachedPivotView(999);
  });

  it('cachePivotView marks as fresh', () => {
    cachePivotView(999, mockView(999));
    expect(isCacheFresh(999)).toBe(true);
  });

  it('consumeFreshFlag clears freshness', () => {
    cachePivotView(999, mockView(999));
    consumeFreshFlag(999);
    expect(isCacheFresh(999)).toBe(false);
  });

  it('setCachedPivotView does NOT mark as fresh', () => {
    consumeFreshFlag(999); // ensure clean
    setCachedPivotView(999, mockView(999));
    expect(isCacheFresh(999)).toBe(false);
  });
});

describe('Operation sequencing', () => {
  it('startOperation returns incrementing sequence numbers', () => {
    const pivotId = 998;
    const seq1 = startOperation(pivotId);
    const seq2 = startOperation(pivotId);
    expect(seq2).toBeGreaterThan(seq1);
  });

  it('isCurrentOperation returns true for latest seq', () => {
    const pivotId = 998;
    const seq1 = startOperation(pivotId);
    expect(isCurrentOperation(pivotId, seq1)).toBe(true);
  });

  it('isCurrentOperation returns false for superseded seq', () => {
    const pivotId = 998;
    const seq1 = startOperation(pivotId);
    startOperation(pivotId); // supersedes seq1
    expect(isCurrentOperation(pivotId, seq1)).toBe(false);
  });
});

describe('User cancellation', () => {
  it('markUserCancelled / isUserCancelled / clearUserCancelled lifecycle', () => {
    expect(isUserCancelled(999)).toBe(false);
    markUserCancelled(999);
    expect(isUserCancelled(999)).toBe(true);
    clearUserCancelled(999);
    expect(isUserCancelled(999)).toBe(false);
  });
});

describe('Loading state', () => {
  beforeEach(() => {
    clearLoading(999);
  });

  it('setLoading / isLoading / clearLoading lifecycle', () => {
    expect(isLoading(999)).toBe(false);
    setLoading(999, 'Calculating...');
    expect(isLoading(999)).toBe(true);
    clearLoading(999);
    expect(isLoading(999)).toBe(false);
  });

  it('getLoadingState returns stage info', () => {
    setLoading(999, 'Stage 2', 1, 4);
    const state = getLoadingState(999);
    expect(state).toBeDefined();
    expect(state!.stage).toBe('Stage 2');
    expect(state!.stageIndex).toBe(1);
    expect(state!.totalStages).toBe(4);
  });

  it('setLoading updates stage on existing entry', () => {
    setLoading(999, 'Stage 1', 0, 3);
    setLoading(999, 'Stage 2', 1, 3);
    const state = getLoadingState(999);
    expect(state!.stage).toBe('Stage 2');
    expect(state!.stageIndex).toBe(1);
  });

  it('getLoadingState returns undefined for non-loading pivot', () => {
    expect(getLoadingState(12345)).toBeUndefined();
  });
});

describe('Previous view preservation', () => {
  beforeEach(() => {
    deleteCachedPivotView(999);
  });

  it('preserveCurrentView + restorePreviousView restores cached view', () => {
    const original = mockView(999, 1);
    cachePivotView(999, original);
    preserveCurrentView(999);

    // Replace with new view
    const updated = mockView(999, 2);
    cachePivotView(999, updated);
    expect(getCachedPivotVersion(999)).toBe(2);

    // Restore
    const restored = restorePreviousView(999);
    expect(restored).toBe(original);
    expect(getCachedPivotVersion(999)).toBe(1);
  });

  it('restorePreviousView returns undefined when no previous view', () => {
    expect(restorePreviousView(999)).toBeUndefined();
  });

  it('clearPreviousView discards the backup', () => {
    cachePivotView(999, mockView(999, 1));
    preserveCurrentView(999);
    clearPreviousView(999);
    // Now restore should return undefined
    expect(restorePreviousView(999)).toBeUndefined();
  });
});
