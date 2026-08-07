//! FILENAME: app/extensions/Pivot/lib/pivotViewStore.test.ts
// PURPOSE: Tests for the pivot view store (cache, operation sequencing, cancellation, loading state).

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  applyBackendProgress,
  preserveCurrentView,
  restorePreviousView,
  clearPreviousView,
} from './pivotViewStore';
import type { PivotViewResponse } from './pivot-api';

/** Minimal PivotViewResponse stub. */
function mockView(pivotId: string, version = 1): PivotViewResponse {
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

describe('Backend progress events (the stuck-overlay guard)', () => {
  const PIVOT = 'pivot-progress-guard';

  beforeEach(() => {
    clearLoading(PIVOT);
  });

  // THE DEFECT. Tauri events and command responses travel separate channels,
  // and every progress-emitting pivot command emits its last progress
  // ("Updating grid...", stage 4 of 4) immediately before returning. That event
  // routinely arrives AFTER pivot-api's `finally { clearLoading }` has run. The
  // listener used to call setLoading unconditionally, which re-created the
  // entry — arming a spinner that no code path would ever clear again.
  it('a trailing event for a finished operation does not re-arm the indicator', () => {
    setLoading(PIVOT, 'Refreshing...', 0, 4);
    expect(applyBackendProgress(PIVOT, 'Calculating...', 1, 4)).toBe(true);

    // The command returned; pivot-api cleared the indicator.
    clearLoading(PIVOT);

    // The last emitted event lands now.
    expect(applyBackendProgress(PIVOT, 'Updating grid...', 3, 4)).toBe(false);
    expect(isLoading(PIVOT)).toBe(false);
    expect(getLoadingState(PIVOT)).toBeUndefined();
  });

  // The guard must not buy the fix by dropping real progress. Every route to a
  // progress-emitting command goes through pivot-api, which sets loading BEFORE
  // the invoke — so an operation that genuinely started is always "loading" by
  // the time its first event arrives.
  it('updates the stage of an operation that is genuinely running', () => {
    setLoading(PIVOT, 'Updating...', 0, 4);
    expect(applyBackendProgress(PIVOT, 'Preparing response...', 2, 4)).toBe(true);
    const state = getLoadingState(PIVOT);
    expect(state!.stage).toBe('Preparing response...');
    expect(state!.stageIndex).toBe(2);
    expect(state!.totalStages).toBe(4);
  });

  // Two refreshes in quick succession: the first one's trailing event is
  // dropped only if the SECOND has not started. Once the second has set
  // loading, its own progress must still show — including events that arrive
  // for it while the first operation is still unwinding.
  it('does not drop progress for a second refresh that has already started', () => {
    setLoading(PIVOT, 'Refreshing...', 0, 4);   // refresh A
    clearLoading(PIVOT);                        // A's response landed
    setLoading(PIVOT, 'Refreshing...', 0, 4);   // refresh B started

    expect(applyBackendProgress(PIVOT, 'Calculating...', 1, 4)).toBe(true);
    expect(getLoadingState(PIVOT)!.stage).toBe('Calculating...');
    expect(isLoading(PIVOT)).toBe(true);
  });

  it('never starts a loading state for a pivot nothing is loading', () => {
    expect(isLoading(PIVOT)).toBe(false);
    expect(applyBackendProgress(PIVOT, 'Updating grid...', 3, 4)).toBe(false);
    expect(isLoading(PIVOT)).toBe(false);
  });

  // THE HARDER INTERLEAVING, and the one the guard made dangerous: B starts
  // BEFORE A finishes, so A's `finally` runs while B is still in flight. The
  // loading map is keyed by pivotId alone and `clearLoading` deletes
  // unconditionally, so an UNSEQUENCED clear in A wipes B's entry — and from
  // then on `applyBackendProgress` drops every one of B's real events, leaving
  // a genuinely-running refresh with no indicator at all. Before the guard an
  // unconditional `setLoading` re-created the entry and it healed itself.
  //
  // What prevents it is the `isCurrentOperation(pivotId, seq)` discipline in
  // pivot-api's `finally`, modelled here exactly as the command wrappers use it.
  it('a superseded operation clearing does not silence the newer one', () => {
    const seqA = startOperation(PIVOT);
    setLoading(PIVOT, 'Changing data source...', 0, 4); // A starts

    const seqB = startOperation(PIVOT);
    setLoading(PIVOT, 'Refreshing...', 0, 4); // B starts, A still in flight

    // A's response lands first and runs its `finally`.
    if (isCurrentOperation(PIVOT, seqA)) clearLoading(PIVOT);

    expect(isLoading(PIVOT)).toBe(true);
    expect(applyBackendProgress(PIVOT, 'Calculating...', 1, 4)).toBe(true);
    expect(getLoadingState(PIVOT)!.stage).toBe('Calculating...');

    // B's own `finally` is the one allowed to clear.
    if (isCurrentOperation(PIVOT, seqB)) clearLoading(PIVOT);
    expect(isLoading(PIVOT)).toBe(false);
  });
});

// Guards the wiring the test above models. `applyBackendProgress` is only safe
// while EVERY command that can emit `pivot:progress` clears its indicator under
// a sequence check — an unsequenced one silences whatever is running next.
describe('Every progress-emitting command is sequenced', () => {
  const SOURCE = readFileSync(join(__dirname, 'pivot-api.ts'), 'utf8');

  // The three commands that call emit_pivot_progress in
  // app/src-tauri/src/pivot/commands.rs (update_pivot_fields:832,
  // refresh_pivot_cache:1828, change_pivot_data_source:2469).
  it.each([
    ['updatePivotFields'],
    ['refreshPivotCache'],
    ['changePivotDataSource'],
  ])('%s takes a sequence number and clears under it', (fnName) => {
    const start = SOURCE.indexOf(`export async function ${fnName}(`);
    expect(start, `${fnName} not found in pivot-api.ts`).toBeGreaterThan(-1);
    const next = SOURCE.indexOf('\nexport ', start + 1);
    const body = SOURCE.slice(start, next === -1 ? undefined : next);

    expect(body, `${fnName} does not allocate a sequence number`).toContain(
      'startOperation(',
    );
    // Every clearLoading in the body must be guarded by isCurrentOperation.
    const clears = body.split('clearLoading(').length - 1;
    const guards = body.split('isCurrentOperation(').length - 1;
    expect(clears, `${fnName} never clears its loading indicator`).toBeGreaterThan(0);
    expect(
      guards,
      `${fnName} clears its loading indicator without an isCurrentOperation \
guard — a superseded operation would wipe a newer one's indicator, and \
applyBackendProgress would then drop that newer operation's real progress`,
    ).toBeGreaterThanOrEqual(clears);
  });
});
