//! FILENAME: app/extensions/Sorting/lib/__tests__/sortStore-idempotent.test.ts
// PURPOSE: Tests for idempotency and reversibility of the sort store.
// CONTEXT: Verifies that repeated operations and round-trip state changes
//          produce stable, predictable results.

import { describe, it, expect, beforeEach } from "vitest";
import { useSortStore } from "../../hooks/useSortState";

// ============================================================================
// Helpers
// ============================================================================

function resetStore() {
  useSortStore.getState().reset();
}

function initStore(headers = ["Name", "Age", "City"]) {
  useSortStore.getState().initialize(0, 0, 10, headers.length - 1, headers, true);
}

/** Extract the structural state (excluding level IDs which are auto-generated). */
function structuralState() {
  const s = useSortStore.getState();
  return {
    levelCount: s.levels.length,
    levelColumns: s.levels.map((l) => l.columnKey),
    levelAscending: s.levels.map((l) => l.ascending),
    levelSortOn: s.levels.map((l) => l.sortOn),
    hasHeaders: s.hasHeaders,
    caseSensitive: s.caseSensitive,
    orientation: s.orientation,
    rangeStartRow: s.rangeStartRow,
    rangeStartCol: s.rangeStartCol,
    rangeEndRow: s.rangeEndRow,
    rangeEndCol: s.rangeEndCol,
    columnHeaders: s.columnHeaders,
  };
}

// ============================================================================
// Double-apply same operation = same result
// ============================================================================

describe("sortStore - double-apply idempotency", () => {
  beforeEach(() => {
    resetStore();
    initStore();
  });

  it("double setHasHeaders(false) produces same state as single call", () => {
    useSortStore.getState().setHasHeaders(false);
    const after1 = useSortStore.getState().hasHeaders;
    useSortStore.getState().setHasHeaders(false);
    const after2 = useSortStore.getState().hasHeaders;
    expect(after1).toBe(after2);
    expect(after2).toBe(false);
  });

  it("double setCaseSensitive(true) produces same state", () => {
    useSortStore.getState().setCaseSensitive(true);
    const after1 = useSortStore.getState().caseSensitive;
    useSortStore.getState().setCaseSensitive(true);
    const after2 = useSortStore.getState().caseSensitive;
    expect(after1).toBe(after2);
  });

  it("double setOrientation('columns') produces same state", () => {
    useSortStore.getState().setOrientation("columns");
    const after1 = useSortStore.getState().orientation;
    useSortStore.getState().setOrientation("columns");
    const after2 = useSortStore.getState().orientation;
    expect(after1).toBe(after2);
  });

  it("double setRange with same values produces same state", () => {
    useSortStore.getState().setRange(5, 2, 20, 8);
    const after1 = { ...useSortStore.getState() };
    useSortStore.getState().setRange(5, 2, 20, 8);
    const after2 = { ...useSortStore.getState() };
    expect(after1.rangeStartRow).toBe(after2.rangeStartRow);
    expect(after1.rangeEndCol).toBe(after2.rangeEndCol);
  });

  it("double setColumnHeaders with same values produces same state", () => {
    useSortStore.getState().setColumnHeaders(["X", "Y"]);
    const after1 = useSortStore.getState().columnHeaders;
    useSortStore.getState().setColumnHeaders(["X", "Y"]);
    const after2 = useSortStore.getState().columnHeaders;
    expect(after1).toEqual(after2);
  });

  it("double updateLevel with same patch produces same state", () => {
    const id = useSortStore.getState().levels[0].id;
    useSortStore.getState().updateLevel(id, { ascending: false, columnKey: 2 });
    const after1 = { ...useSortStore.getState().levels[0] };
    useSortStore.getState().updateLevel(id, { ascending: false, columnKey: 2 });
    const after2 = { ...useSortStore.getState().levels[0] };
    expect(after1).toEqual(after2);
  });
});

// ============================================================================
// Initialize -> modify -> reset -> initialize = same as fresh initialize
// ============================================================================

describe("sortStore - initialize/reset reversibility", () => {
  beforeEach(resetStore);

  it("init -> modify -> reset -> init produces structurally identical state", () => {
    initStore();
    const freshState = structuralState();

    // Modify
    useSortStore.getState().addLevel();
    useSortStore.getState().setCaseSensitive(true);
    useSortStore.getState().setOrientation("columns");

    // Reset and re-initialize
    useSortStore.getState().reset();
    initStore();
    const restoredState = structuralState();

    expect(restoredState).toEqual(freshState);
  });

  it("init -> delete all levels -> reset -> init restores one level", () => {
    initStore();
    const levelId = useSortStore.getState().levels[0].id;
    useSortStore.getState().deleteLevel(levelId);
    expect(useSortStore.getState().levels).toHaveLength(0);

    useSortStore.getState().reset();
    initStore();
    expect(useSortStore.getState().levels).toHaveLength(1);
  });

  it("init -> add many levels -> reset clears all levels", () => {
    initStore();
    useSortStore.getState().addLevel();
    useSortStore.getState().addLevel();
    expect(useSortStore.getState().levels.length).toBeGreaterThan(1);

    useSortStore.getState().reset();
    expect(useSortStore.getState().levels).toHaveLength(0);
  });

  it("reset restores all default option values", () => {
    initStore();
    useSortStore.getState().setCaseSensitive(true);
    useSortStore.getState().setOrientation("columns");
    useSortStore.getState().setHasHeaders(false);

    useSortStore.getState().reset();
    const s = useSortStore.getState();
    expect(s.caseSensitive).toBe(false);
    expect(s.orientation).toBe("rows");
    expect(s.hasHeaders).toBe(true);
  });
});

// ============================================================================
// Multiple clearAll / reset calls are idempotent
// ============================================================================

describe("sortStore - multiple reset idempotency", () => {
  beforeEach(resetStore);

  it("double reset produces same empty state", () => {
    initStore();
    useSortStore.getState().reset();
    const after1 = structuralState();
    useSortStore.getState().reset();
    const after2 = structuralState();
    expect(after1).toEqual(after2);
  });

  it("triple reset produces same empty state", () => {
    useSortStore.getState().reset();
    useSortStore.getState().reset();
    useSortStore.getState().reset();
    const s = useSortStore.getState();
    expect(s.levels).toEqual([]);
    expect(s.columnHeaders).toEqual([]);
    expect(s.selectedLevelId).toBeNull();
  });

  it("reset on already-reset store does not throw", () => {
    expect(() => {
      useSortStore.getState().reset();
      useSortStore.getState().reset();
    }).not.toThrow();
  });
});

// ============================================================================
// Options toggles: toggle twice = original state
// ============================================================================

describe("sortStore - toggle reversibility", () => {
  beforeEach(() => {
    resetStore();
    initStore();
  });

  it("hasHeaders toggle twice returns to original", () => {
    const original = useSortStore.getState().hasHeaders;
    useSortStore.getState().setHasHeaders(!original);
    useSortStore.getState().setHasHeaders(original);
    expect(useSortStore.getState().hasHeaders).toBe(original);
  });

  it("caseSensitive toggle twice returns to original", () => {
    const original = useSortStore.getState().caseSensitive;
    useSortStore.getState().setCaseSensitive(!original);
    useSortStore.getState().setCaseSensitive(original);
    expect(useSortStore.getState().caseSensitive).toBe(original);
  });

  it("orientation toggle twice returns to original", () => {
    const original = useSortStore.getState().orientation;
    useSortStore.getState().setOrientation("columns");
    useSortStore.getState().setOrientation(original);
    expect(useSortStore.getState().orientation).toBe(original);
  });

  it("ascending toggle twice on a level returns to original", () => {
    const id = useSortStore.getState().levels[0].id;
    const original = useSortStore.getState().levels[0].ascending;
    useSortStore.getState().updateLevel(id, { ascending: !original });
    useSortStore.getState().updateLevel(id, { ascending: original });
    expect(useSortStore.getState().levels[0].ascending).toBe(original);
  });

  it("moveLevelDown then moveLevelUp restores order", () => {
    useSortStore.getState().addLevel();
    useSortStore.getState().addLevel();
    const originalOrder = useSortStore.getState().levels.map((l) => l.id);

    const firstId = originalOrder[0];
    useSortStore.getState().moveLevelDown(firstId);
    useSortStore.getState().moveLevelUp(firstId);

    const restoredOrder = useSortStore.getState().levels.map((l) => l.id);
    expect(restoredOrder).toEqual(originalOrder);
  });

  it("selectLevel then selectLevel(null) returns to no selection", () => {
    const id = useSortStore.getState().levels[0].id;
    useSortStore.getState().selectLevel(null);
    expect(useSortStore.getState().selectedLevelId).toBeNull();
    useSortStore.getState().selectLevel(id);
    expect(useSortStore.getState().selectedLevelId).toBe(id);
    useSortStore.getState().selectLevel(null);
    expect(useSortStore.getState().selectedLevelId).toBeNull();
  });
});
