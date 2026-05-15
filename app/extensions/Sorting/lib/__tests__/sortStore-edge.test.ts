//! FILENAME: app/extensions/Sorting/lib/__tests__/sortStore-edge.test.ts
// PURPOSE: Edge-case tests for the sort store: MAX_SORT_LEVELS boundary, column exhaustion, rapid operations.
// CONTEXT: Complements sortStore.test.ts with stress and boundary scenarios.

import { describe, it, expect, beforeEach } from "vitest";
import { useSortStore } from "../../hooks/useSortState";
import { MAX_SORT_LEVELS } from "../../types";

// ============================================================================
// Helpers
// ============================================================================

function resetStore() {
  useSortStore.getState().reset();
}

function initWithColumns(count: number) {
  const headers = Array.from({ length: count }, (_, i) => `Col${i}`);
  useSortStore.getState().initialize(0, 0, 100, count - 1, headers, true);
}

function getState() {
  return useSortStore.getState();
}

// ============================================================================
// MAX_SORT_LEVELS Boundary
// ============================================================================

describe("MAX_SORT_LEVELS boundary testing", () => {
  beforeEach(() => {
    resetStore();
    // 100 columns so column exhaustion does not interfere
    initWithColumns(100);
  });

  it("MAX_SORT_LEVELS is 64", () => {
    expect(MAX_SORT_LEVELS).toBe(64);
  });

  it("allows exactly 64 levels (1 from init + 63 added)", () => {
    for (let i = 0; i < 63; i++) {
      getState().addLevel();
    }
    expect(getState().levels).toHaveLength(64);
  });

  it("rejects the 65th level", () => {
    for (let i = 0; i < 63; i++) {
      getState().addLevel();
    }
    expect(getState().levels).toHaveLength(64);

    getState().addLevel();
    expect(getState().levels).toHaveLength(64); // unchanged
  });

  it("copyLevel respects MAX_SORT_LEVELS", () => {
    for (let i = 0; i < 63; i++) {
      getState().addLevel();
    }
    expect(getState().levels).toHaveLength(64);

    const firstId = getState().levels[0].id;
    getState().copyLevel(firstId);
    expect(getState().levels).toHaveLength(64); // no change
  });

  it("after deleting one at max, can add one more", () => {
    for (let i = 0; i < 63; i++) {
      getState().addLevel();
    }
    expect(getState().levels).toHaveLength(64);

    const lastId = getState().levels[63].id;
    getState().deleteLevel(lastId);
    expect(getState().levels).toHaveLength(63);

    getState().addLevel();
    expect(getState().levels).toHaveLength(64);
  });

  it("all 64 levels have unique IDs", () => {
    for (let i = 0; i < 63; i++) {
      getState().addLevel();
    }
    const ids = new Set(getState().levels.map((l) => l.id));
    expect(ids.size).toBe(64);
  });
});

// ============================================================================
// All Columns Used (no unused for addLevel)
// ============================================================================

describe("all columns used", () => {
  beforeEach(() => {
    resetStore();
    // Only 3 columns
    initWithColumns(3);
  });

  it("first 3 levels get columns 0, 1, 2", () => {
    getState().addLevel(); // col 1
    getState().addLevel(); // col 2
    const levels = getState().levels;
    expect(levels[0].columnKey).toBe(0);
    expect(levels[1].columnKey).toBe(1);
    expect(levels[2].columnKey).toBe(2);
  });

  it("4th level falls back to column 0 when all used", () => {
    getState().addLevel();
    getState().addLevel();
    getState().addLevel(); // all 3 columns used, defaults to 0
    expect(getState().levels[3].columnKey).toBe(0);
  });

  it("deleting a level frees its column for the next add", () => {
    getState().addLevel(); // col 1
    getState().addLevel(); // col 2

    // Delete the level using column 1
    const col1Level = getState().levels.find((l) => l.columnKey === 1)!;
    getState().deleteLevel(col1Level.id);

    // Next add should pick column 1
    getState().addLevel();
    const newLevel = getState().levels[getState().levels.length - 1];
    expect(newLevel.columnKey).toBe(1);
  });

  it("with 0 columns, addLevel defaults to column 0", () => {
    resetStore();
    initWithColumns(0);
    // init creates 1 level with columnKey 0
    // Note: columnHeaders is empty, so the loop never finds an unused column
    getState().addLevel();
    expect(getState().levels[1].columnKey).toBe(0);
  });

  it("with 1 column, all levels use column 0", () => {
    resetStore();
    initWithColumns(1);
    getState().addLevel();
    getState().addLevel();
    for (const level of getState().levels) {
      expect(level.columnKey).toBe(0);
    }
  });
});

// ============================================================================
// Rapid Level Add/Delete/Move Sequences
// ============================================================================

describe("rapid level operations", () => {
  beforeEach(() => {
    resetStore();
    initWithColumns(20);
  });

  it("50 add/delete cycles leave store in clean state", () => {
    for (let i = 0; i < 50; i++) {
      getState().addLevel();
      const last = getState().levels[getState().levels.length - 1];
      getState().deleteLevel(last.id);
    }
    // Should have just the initial level
    expect(getState().levels).toHaveLength(1);
  });

  it("add 10 levels then delete all in reverse order", () => {
    for (let i = 0; i < 9; i++) {
      getState().addLevel();
    }
    expect(getState().levels).toHaveLength(10);

    while (getState().levels.length > 0) {
      const last = getState().levels[getState().levels.length - 1];
      getState().deleteLevel(last.id);
    }
    expect(getState().levels).toHaveLength(0);
    expect(getState().selectedLevelId).toBeNull();
  });

  it("add 10 levels then delete all from front", () => {
    for (let i = 0; i < 9; i++) {
      getState().addLevel();
    }

    while (getState().levels.length > 0) {
      const first = getState().levels[0];
      getState().deleteLevel(first.id);
    }
    expect(getState().levels).toHaveLength(0);
  });

  it("rapid moveLevelUp on first level is a no-op", () => {
    getState().addLevel();
    getState().addLevel();
    const firstId = getState().levels[0].id;

    for (let i = 0; i < 20; i++) {
      getState().moveLevelUp(firstId);
    }
    expect(getState().levels[0].id).toBe(firstId);
  });

  it("rapid moveLevelDown on last level is a no-op", () => {
    getState().addLevel();
    getState().addLevel();
    const lastId = getState().levels[getState().levels.length - 1].id;

    for (let i = 0; i < 20; i++) {
      getState().moveLevelDown(lastId);
    }
    expect(getState().levels[getState().levels.length - 1].id).toBe(lastId);
  });

  it("move level from bottom to top step by step", () => {
    for (let i = 0; i < 9; i++) {
      getState().addLevel();
    }
    const lastId = getState().levels[9].id;

    for (let i = 0; i < 9; i++) {
      getState().moveLevelUp(lastId);
    }
    expect(getState().levels[0].id).toBe(lastId);
  });

  it("move level from top to bottom step by step", () => {
    for (let i = 0; i < 9; i++) {
      getState().addLevel();
    }
    const firstId = getState().levels[0].id;

    for (let i = 0; i < 9; i++) {
      getState().moveLevelDown(firstId);
    }
    expect(getState().levels[9].id).toBe(firstId);
  });

  it("interleaved add/copy/delete maintains consistency", () => {
    // Add 5 levels
    for (let i = 0; i < 4; i++) {
      getState().addLevel();
    }
    expect(getState().levels).toHaveLength(5);

    // Copy the 3rd level
    const thirdId = getState().levels[2].id;
    getState().copyLevel(thirdId);
    expect(getState().levels).toHaveLength(6);

    // Delete the original 3rd
    getState().deleteLevel(thirdId);
    expect(getState().levels).toHaveLength(5);

    // All remaining IDs should be unique
    const ids = new Set(getState().levels.map((l) => l.id));
    expect(ids.size).toBe(5);
  });
});

// ============================================================================
// Edge Case Column Key Assignments
// ============================================================================

describe("column key edge cases", () => {
  beforeEach(() => {
    resetStore();
    initWithColumns(5); // Col0..Col4
  });

  it("updateLevel to use a column already used by another level", () => {
    getState().addLevel(); // gets col 1
    const secondId = getState().levels[1].id;
    // Manually set column to 0 (same as first level)
    getState().updateLevel(secondId, { columnKey: 0 });
    // Store allows duplicate column keys (validation is UI-level)
    expect(getState().levels[0].columnKey).toBe(0);
    expect(getState().levels[1].columnKey).toBe(0);
  });

  it("updateLevel with out-of-range column key", () => {
    const id = getState().levels[0].id;
    getState().updateLevel(id, { columnKey: 999 });
    expect(getState().levels[0].columnKey).toBe(999);
  });

  it("updateLevel with negative column key", () => {
    const id = getState().levels[0].id;
    getState().updateLevel(id, { columnKey: -1 });
    expect(getState().levels[0].columnKey).toBe(-1);
  });

  it("update non-existent level ID is a no-op", () => {
    const before = getState().levels.map((l) => ({ ...l }));
    getState().updateLevel("nonexistent", { ascending: false });
    const after = getState().levels;
    expect(after).toEqual(before);
  });

  it("delete non-existent level ID is a no-op", () => {
    const countBefore = getState().levels.length;
    getState().deleteLevel("nonexistent");
    expect(getState().levels).toHaveLength(countBefore);
  });

  it("copy non-existent level ID is a no-op", () => {
    const countBefore = getState().levels.length;
    getState().copyLevel("nonexistent");
    expect(getState().levels).toHaveLength(countBefore);
  });

  it("moveLevelUp with non-existent ID is a no-op", () => {
    getState().addLevel();
    const before = getState().levels.map((l) => l.id);
    getState().moveLevelUp("nonexistent");
    expect(getState().levels.map((l) => l.id)).toEqual(before);
  });

  it("moveLevelDown with non-existent ID is a no-op", () => {
    getState().addLevel();
    const before = getState().levels.map((l) => l.id);
    getState().moveLevelDown("nonexistent");
    expect(getState().levels.map((l) => l.id)).toEqual(before);
  });

  it("selectLevel with non-existent ID still sets selectedLevelId", () => {
    getState().selectLevel("nonexistent");
    expect(getState().selectedLevelId).toBe("nonexistent");
  });

  it("selectLevel with null clears selection", () => {
    getState().selectLevel(null);
    expect(getState().selectedLevelId).toBeNull();
  });

  it("re-initialize resets levels completely", () => {
    for (let i = 0; i < 10; i++) {
      getState().addLevel();
    }
    expect(getState().levels.length).toBeGreaterThan(5);

    initWithColumns(3);
    expect(getState().levels).toHaveLength(1);
    expect(getState().columnHeaders).toEqual(["Col0", "Col1", "Col2"]);
  });
});
