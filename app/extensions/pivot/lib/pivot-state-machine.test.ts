//! FILENAME: app/extensions/Pivot/lib/pivot-state-machine.test.ts
// PURPOSE: State machine tests for the pivot view store.
// CONTEXT: Models the store as a state machine and verifies all valid transitions.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  cachePivotView,
  getCachedPivotView,
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

const PID = 8000; // test pivot id

function mockView(version = 1): PivotViewResponse {
  return {
    pivotId: PID,
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

// State definitions:
//   idle:    !isLoading && !getCachedPivotView (no data)
//   loading: isLoading === true
//   loaded:  !isLoading && getCachedPivotView !== undefined
//   error:   simulated by clearLoading + no cache update (previous view restored)
//   cancelled: isUserCancelled === true

function assertIdle() {
  expect(isLoading(PID)).toBe(false);
  expect(getCachedPivotView(PID)).toBeUndefined();
}

function assertLoading() {
  expect(isLoading(PID)).toBe(true);
}

function assertLoaded() {
  expect(isLoading(PID)).toBe(false);
  expect(getCachedPivotView(PID)).toBeDefined();
}

describe('Pivot View Store - State Machine', () => {
  beforeEach(() => {
    deleteCachedPivotView(PID);
    clearLoading(PID);
    clearUserCancelled(PID);
    clearPreviousView(PID);
  });

  // --- Basic transitions ---

  it('starts in idle state', () => {
    assertIdle();
  });

  it('idle -> loading: setLoading transitions to loading', () => {
    assertIdle();
    setLoading(PID, 'Fetching data');
    assertLoading();
  });

  it('loading -> loaded: cachePivotView + clearLoading transitions to loaded', () => {
    setLoading(PID, 'Fetching');
    startOperation(PID);
    cachePivotView(PID, mockView(1));
    clearLoading(PID);
    assertLoaded();
  });

  it('loading -> error: clearLoading without caching keeps no data (idle-like)', () => {
    setLoading(PID, 'Fetching');
    startOperation(PID);
    // Operation fails - no cache update, just clear loading
    clearLoading(PID);
    expect(isLoading(PID)).toBe(false);
    expect(getCachedPivotView(PID)).toBeUndefined();
  });

  it('loaded -> loading: can re-enter loading from loaded', () => {
    // First: get to loaded
    setLoading(PID, 'Fetching');
    cachePivotView(PID, mockView(1));
    clearLoading(PID);
    assertLoaded();

    // Now transition back to loading
    preserveCurrentView(PID);
    setLoading(PID, 'Refreshing');
    assertLoading();
    // Previous view is still in cache
    expect(getCachedPivotView(PID)).toBeDefined();
  });

  it('loaded -> loading -> loaded: refresh cycle preserves latest data', () => {
    cachePivotView(PID, mockView(1));
    clearLoading(PID);

    preserveCurrentView(PID);
    setLoading(PID, 'Refreshing');
    cachePivotView(PID, mockView(2));
    clearLoading(PID);
    clearPreviousView(PID);

    assertLoaded();
    expect(getCachedPivotView(PID)!.version).toBe(2);
  });

  // --- Operation superseding ---

  it('loading -> loading (supersede): second startOperation invalidates first', () => {
    setLoading(PID, 'Op 1');
    const seq1 = startOperation(PID);
    expect(isCurrentOperation(PID, seq1)).toBe(true);

    // Second operation supersedes
    setLoading(PID, 'Op 2');
    const seq2 = startOperation(PID);
    expect(isCurrentOperation(PID, seq1)).toBe(false);
    expect(isCurrentOperation(PID, seq2)).toBe(true);
  });

  it('superseded operation result is rejected (only latest completes)', () => {
    setLoading(PID, 'Op 1');
    const seq1 = startOperation(PID);

    setLoading(PID, 'Op 2');
    const seq2 = startOperation(PID);

    // Op 1 completes - should be rejected
    if (isCurrentOperation(PID, seq1)) {
      cachePivotView(PID, mockView(100));
    }
    // Cache should still be empty (op1 was superseded)
    expect(getCachedPivotView(PID)).toBeUndefined();

    // Op 2 completes - should be accepted
    expect(isCurrentOperation(PID, seq2)).toBe(true);
    cachePivotView(PID, mockView(200));
    clearLoading(PID);
    expect(getCachedPivotView(PID)!.version).toBe(200);
  });

  it('triple supersede: only the last operation is current', () => {
    const seq1 = startOperation(PID);
    const seq2 = startOperation(PID);
    const seq3 = startOperation(PID);

    expect(isCurrentOperation(PID, seq1)).toBe(false);
    expect(isCurrentOperation(PID, seq2)).toBe(false);
    expect(isCurrentOperation(PID, seq3)).toBe(true);
  });

  it('sequence numbers are monotonically increasing', () => {
    const seq1 = startOperation(PID);
    const seq2 = startOperation(PID);
    const seq3 = startOperation(PID);
    expect(seq2).toBeGreaterThan(seq1);
    expect(seq3).toBeGreaterThan(seq2);
  });

  // --- Cancellation ---

  it('loading -> cancelled: markUserCancelled sets cancelled flag', () => {
    setLoading(PID, 'Fetching');
    startOperation(PID);
    markUserCancelled(PID);
    expect(isUserCancelled(PID)).toBe(true);
  });

  it('cancelled -> idle: clearUserCancelled + clearLoading returns to idle', () => {
    setLoading(PID, 'Fetching');
    startOperation(PID);
    markUserCancelled(PID);

    clearUserCancelled(PID);
    clearLoading(PID);

    expect(isUserCancelled(PID)).toBe(false);
    assertIdle();
  });

  it('cancellation restores previous view', () => {
    // Start with a loaded view
    cachePivotView(PID, mockView(1));
    clearLoading(PID);

    // Start new operation
    preserveCurrentView(PID);
    setLoading(PID, 'Refreshing');
    startOperation(PID);

    // User cancels
    markUserCancelled(PID);
    const restored = restorePreviousView(PID);
    clearLoading(PID);
    clearUserCancelled(PID);

    expect(restored).toBeDefined();
    expect(restored!.version).toBe(1);
    assertLoaded();
  });

  // --- Full lifecycle sequences ---

  it('idle -> loading -> loaded -> loading -> error -> loading -> loaded', () => {
    // 1. idle
    assertIdle();

    // 2. idle -> loading
    setLoading(PID, 'Initial load');
    const seq1 = startOperation(PID);
    assertLoading();

    // 3. loading -> loaded
    cachePivotView(PID, mockView(1));
    clearLoading(PID);
    clearPreviousView(PID);
    assertLoaded();

    // 4. loaded -> loading (refresh)
    preserveCurrentView(PID);
    setLoading(PID, 'Refresh');
    const seq2 = startOperation(PID);
    assertLoading();

    // 5. loading -> error (restore previous view)
    restorePreviousView(PID);
    clearLoading(PID);
    assertLoaded();
    expect(getCachedPivotView(PID)!.version).toBe(1); // restored v1

    // 6. error state -> loading again
    preserveCurrentView(PID);
    setLoading(PID, 'Retry');
    const seq3 = startOperation(PID);
    assertLoading();

    // 7. loading -> loaded (success this time)
    cachePivotView(PID, mockView(3));
    clearLoading(PID);
    clearPreviousView(PID);
    assertLoaded();
    expect(getCachedPivotView(PID)!.version).toBe(3);
  });

  // --- Loading state details ---

  it('setLoading updates stage info on existing loading state', () => {
    setLoading(PID, 'Stage 1', 0, 3);
    expect(getLoadingState(PID)!.stage).toBe('Stage 1');
    expect(getLoadingState(PID)!.stageIndex).toBe(0);

    setLoading(PID, 'Stage 2', 1, 3);
    expect(getLoadingState(PID)!.stage).toBe('Stage 2');
    expect(getLoadingState(PID)!.stageIndex).toBe(1);
    // startedAt should be preserved (same loading session)
  });

  it('loading state preserves startedAt timestamp across stage updates', () => {
    setLoading(PID, 'Stage 1');
    const startedAt = getLoadingState(PID)!.startedAt;

    setLoading(PID, 'Stage 2');
    expect(getLoadingState(PID)!.startedAt).toBe(startedAt);
  });

  // --- Fresh cache flag ---

  it('cachePivotView marks fresh, setCachedPivotView does not', () => {
    cachePivotView(PID, mockView(1));
    expect(isCacheFresh(PID)).toBe(true);
    consumeFreshFlag(PID);

    setCachedPivotView(PID, mockView(2));
    expect(isCacheFresh(PID)).toBe(false);
  });

  it('consumeFreshFlag clears the flag exactly once', () => {
    cachePivotView(PID, mockView(1));
    expect(isCacheFresh(PID)).toBe(true);
    consumeFreshFlag(PID);
    expect(isCacheFresh(PID)).toBe(false);
    consumeFreshFlag(PID); // no-op
    expect(isCacheFresh(PID)).toBe(false);
  });

  // --- Independent pivots ---

  it('operations on different pivotIds are independent', () => {
    const PID2 = PID + 1;
    setLoading(PID, 'A');
    const seqA = startOperation(PID);

    setLoading(PID2, 'B');
    const seqB = startOperation(PID2);

    expect(isCurrentOperation(PID, seqA)).toBe(true);
    expect(isCurrentOperation(PID2, seqB)).toBe(true);

    // Supersede only PID
    const seqA2 = startOperation(PID);
    expect(isCurrentOperation(PID, seqA)).toBe(false);
    expect(isCurrentOperation(PID, seqA2)).toBe(true);
    expect(isCurrentOperation(PID2, seqB)).toBe(true); // unaffected

    // Cleanup
    deleteCachedPivotView(PID2);
    clearLoading(PID2);
  });

  it('deleteCachedPivotView resets all state for that pivot', () => {
    cachePivotView(PID, mockView(1));
    setLoading(PID, 'Loading');

    deleteCachedPivotView(PID);

    expect(getCachedPivotView(PID)).toBeUndefined();
    expect(isLoading(PID)).toBe(false);
  });
});
