//! FILENAME: app/extensions/Sorting/lib/__tests__/sortStore.test.ts
// PURPOSE: Tests for the Sorting extension Zustand store logic.
// CONTEXT: Tests level management, options, and lifecycle of the sort dialog state.

import { describe, it, expect, beforeEach } from "vitest";
import { useSortStore } from "../../hooks/useSortState";

// ============================================================================
// Helpers
// ============================================================================

/** Reset store to a clean state before each test. */
function resetStore() {
  useSortStore.getState().reset();
}

/** Initialize store with a sample range and headers. */
function initStore(headers = ["Name", "Age", "City"]) {
  useSortStore.getState().initialize(0, 0, 10, headers.length - 1, headers, true);
}

// ============================================================================
// Initialization & Reset
// ============================================================================

describe("useSortStore - initialization", () => {
  beforeEach(resetStore);

  it("starts with empty default state after reset", () => {
    const state = useSortStore.getState();
    expect(state.levels).toEqual([]);
    expect(state.hasHeaders).toBe(true);
    expect(state.caseSensitive).toBe(false);
    expect(state.orientation).toBe("rows");
    expect(state.columnHeaders).toEqual([]);
    expect(state.selectedLevelId).toBeNull();
  });

  it("initializes with range, headers, and one default level", () => {
    initStore();
    const state = useSortStore.getState();

    expect(state.rangeStartRow).toBe(0);
    expect(state.rangeStartCol).toBe(0);
    expect(state.rangeEndRow).toBe(10);
    expect(state.rangeEndCol).toBe(2);
    expect(state.columnHeaders).toEqual(["Name", "Age", "City"]);
    expect(state.hasHeaders).toBe(true);
    expect(state.levels).toHaveLength(1);
    expect(state.levels[0].columnKey).toBe(0);
    expect(state.levels[0].ascending).toBe(true);
    expect(state.levels[0].sortOn).toBe("value");
    expect(state.levels[0].dataOption).toBe("normal");
    expect(state.selectedLevelId).toBe(state.levels[0].id);
  });

  it("initializes without headers", () => {
    useSortStore.getState().initialize(0, 0, 5, 2, ["A", "B", "C"], false);
    const state = useSortStore.getState();
    expect(state.hasHeaders).toBe(false);
  });
});

// ============================================================================
// Level Management
// ============================================================================

describe("useSortStore - addLevel", () => {
  beforeEach(() => {
    resetStore();
    initStore();
  });

  it("adds a level with an unused column key", () => {
    useSortStore.getState().addLevel();
    const state = useSortStore.getState();
    expect(state.levels).toHaveLength(2);
    // First level uses column 0, second should pick column 1
    expect(state.levels[1].columnKey).toBe(1);
    expect(state.selectedLevelId).toBe(state.levels[1].id);
  });

  it("adds levels up to unused columns", () => {
    useSortStore.getState().addLevel(); // col 1
    useSortStore.getState().addLevel(); // col 2
    const state = useSortStore.getState();
    expect(state.levels).toHaveLength(3);
    expect(state.levels[0].columnKey).toBe(0);
    expect(state.levels[1].columnKey).toBe(1);
    expect(state.levels[2].columnKey).toBe(2);
  });

  it("falls back to column 0 when all columns are used", () => {
    useSortStore.getState().addLevel(); // col 1
    useSortStore.getState().addLevel(); // col 2
    useSortStore.getState().addLevel(); // all used, defaults to 0
    const state = useSortStore.getState();
    expect(state.levels).toHaveLength(4);
    expect(state.levels[3].columnKey).toBe(0);
  });
});

describe("useSortStore - deleteLevel", () => {
  beforeEach(() => {
    resetStore();
    initStore();
  });

  it("removes a level by id", () => {
    useSortStore.getState().addLevel();
    const state = useSortStore.getState();
    const firstId = state.levels[0].id;
    useSortStore.getState().deleteLevel(firstId);
    const after = useSortStore.getState();
    expect(after.levels).toHaveLength(1);
    expect(after.levels[0].id).not.toBe(firstId);
  });

  it("selects adjacent level after deletion", () => {
    useSortStore.getState().addLevel();
    useSortStore.getState().addLevel();
    const state = useSortStore.getState();
    // Delete the middle one
    const middleId = state.levels[1].id;
    useSortStore.getState().deleteLevel(middleId);
    const after = useSortStore.getState();
    expect(after.levels).toHaveLength(2);
    // Should select the level now at index 1
    expect(after.selectedLevelId).toBe(after.levels[1].id);
  });

  it("sets selectedLevelId to null when last level is deleted", () => {
    const id = useSortStore.getState().levels[0].id;
    useSortStore.getState().deleteLevel(id);
    expect(useSortStore.getState().levels).toHaveLength(0);
    expect(useSortStore.getState().selectedLevelId).toBeNull();
  });

  it("does nothing for a non-existent id", () => {
    useSortStore.getState().deleteLevel("non-existent");
    expect(useSortStore.getState().levels).toHaveLength(1);
  });
});

describe("useSortStore - copyLevel", () => {
  beforeEach(() => {
    resetStore();
    initStore();
  });

  it("copies a level with the same properties but a new id", () => {
    const originalId = useSortStore.getState().levels[0].id;
    useSortStore.getState().updateLevel(originalId, { ascending: false, columnKey: 2 });
    useSortStore.getState().copyLevel(originalId);
    const state = useSortStore.getState();
    expect(state.levels).toHaveLength(2);
    expect(state.levels[1].id).not.toBe(originalId);
    expect(state.levels[1].ascending).toBe(false);
    expect(state.levels[1].columnKey).toBe(2);
    expect(state.selectedLevelId).toBe(state.levels[1].id);
  });

  it("inserts copy right after the source level", () => {
    useSortStore.getState().addLevel();
    const state = useSortStore.getState();
    const firstId = state.levels[0].id;
    useSortStore.getState().copyLevel(firstId);
    const after = useSortStore.getState();
    expect(after.levels).toHaveLength(3);
    // Copy should be at index 1, original add at index 2
    expect(after.levels[0].id).toBe(firstId);
    expect(after.levels[1].columnKey).toBe(after.levels[0].columnKey);
  });
});

describe("useSortStore - updateLevel", () => {
  beforeEach(() => {
    resetStore();
    initStore();
  });

  it("updates level properties", () => {
    const id = useSortStore.getState().levels[0].id;
    useSortStore.getState().updateLevel(id, {
      ascending: false,
      sortOn: "cellColor",
      color: "#ff0000",
    });
    const level = useSortStore.getState().levels[0];
    expect(level.ascending).toBe(false);
    expect(level.sortOn).toBe("cellColor");
    expect(level.color).toBe("#ff0000");
  });

  it("does not change the id when updating", () => {
    const id = useSortStore.getState().levels[0].id;
    useSortStore.getState().updateLevel(id, { ascending: false });
    expect(useSortStore.getState().levels[0].id).toBe(id);
  });
});

describe("useSortStore - moveLevelUp / moveLevelDown", () => {
  beforeEach(() => {
    resetStore();
    initStore();
    useSortStore.getState().addLevel();
    useSortStore.getState().addLevel();
  });

  it("moves a level up", () => {
    const state = useSortStore.getState();
    const secondId = state.levels[1].id;
    const firstId = state.levels[0].id;
    useSortStore.getState().moveLevelUp(secondId);
    const after = useSortStore.getState();
    expect(after.levels[0].id).toBe(secondId);
    expect(after.levels[1].id).toBe(firstId);
  });

  it("does not move the first level up", () => {
    const state = useSortStore.getState();
    const firstId = state.levels[0].id;
    useSortStore.getState().moveLevelUp(firstId);
    const after = useSortStore.getState();
    expect(after.levels[0].id).toBe(firstId);
  });

  it("moves a level down", () => {
    const state = useSortStore.getState();
    const firstId = state.levels[0].id;
    const secondId = state.levels[1].id;
    useSortStore.getState().moveLevelDown(firstId);
    const after = useSortStore.getState();
    expect(after.levels[0].id).toBe(secondId);
    expect(after.levels[1].id).toBe(firstId);
  });

  it("does not move the last level down", () => {
    const state = useSortStore.getState();
    const lastId = state.levels[2].id;
    useSortStore.getState().moveLevelDown(lastId);
    const after = useSortStore.getState();
    expect(after.levels[2].id).toBe(lastId);
  });
});

// ============================================================================
// Options
// ============================================================================

describe("useSortStore - options", () => {
  beforeEach(() => {
    resetStore();
    initStore();
  });

  it("toggles hasHeaders", () => {
    useSortStore.getState().setHasHeaders(false);
    expect(useSortStore.getState().hasHeaders).toBe(false);
    useSortStore.getState().setHasHeaders(true);
    expect(useSortStore.getState().hasHeaders).toBe(true);
  });

  it("toggles caseSensitive", () => {
    useSortStore.getState().setCaseSensitive(true);
    expect(useSortStore.getState().caseSensitive).toBe(true);
  });

  it("sets orientation", () => {
    useSortStore.getState().setOrientation("columns");
    expect(useSortStore.getState().orientation).toBe("columns");
  });
});

// ============================================================================
// Range & Headers
// ============================================================================

describe("useSortStore - range and headers", () => {
  beforeEach(resetStore);

  it("sets range coordinates", () => {
    useSortStore.getState().setRange(5, 2, 20, 8);
    const state = useSortStore.getState();
    expect(state.rangeStartRow).toBe(5);
    expect(state.rangeStartCol).toBe(2);
    expect(state.rangeEndRow).toBe(20);
    expect(state.rangeEndCol).toBe(8);
  });

  it("sets column headers", () => {
    useSortStore.getState().setColumnHeaders(["X", "Y", "Z"]);
    expect(useSortStore.getState().columnHeaders).toEqual(["X", "Y", "Z"]);
  });
});

// ============================================================================
// MAX_SORT_LEVELS
// ============================================================================

describe("useSortStore - max levels enforcement", () => {
  beforeEach(() => {
    resetStore();
    // Initialize with many columns so addLevel doesn't hit column limits
    const headers = Array.from({ length: 70 }, (_, i) => `Col${i}`);
    useSortStore.getState().initialize(0, 0, 100, 69, headers, true);
  });

  it("does not exceed 64 sort levels", () => {
    // Already have 1 from init
    for (let i = 0; i < 70; i++) {
      useSortStore.getState().addLevel();
    }
    expect(useSortStore.getState().levels.length).toBeLessThanOrEqual(64);
  });
});
