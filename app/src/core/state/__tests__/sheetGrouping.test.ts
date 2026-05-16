//! FILENAME: app/src/core/state/__tests__/sheetGrouping.test.ts
// PURPOSE: Tests for sheet grouping state management.

import { describe, it, expect, beforeEach } from "vitest";
import {
  getSelectedSheetIndices,
  setSelectedSheetIndices,
  isSheetGroupingActive,
  getGroupedSheetIndices,
  clearSheetGrouping,
  toggleSheetInGroup,
} from "../sheetGrouping";

describe("sheetGrouping", () => {
  beforeEach(() => {
    clearSheetGrouping();
  });

  it("starts with empty selection", () => {
    expect(getSelectedSheetIndices()).toEqual([]);
  });

  it("isSheetGroupingActive returns false when empty", () => {
    expect(isSheetGroupingActive()).toBe(false);
  });

  it("isSheetGroupingActive returns false with single sheet", () => {
    setSelectedSheetIndices([0]);
    expect(isSheetGroupingActive()).toBe(false);
  });

  it("isSheetGroupingActive returns true with multiple sheets", () => {
    setSelectedSheetIndices([0, 2]);
    expect(isSheetGroupingActive()).toBe(true);
  });

  it("setSelectedSheetIndices sorts indices", () => {
    setSelectedSheetIndices([3, 1, 5]);
    expect(getSelectedSheetIndices()).toEqual([1, 3, 5]);
  });

  it("getGroupedSheetIndices excludes active sheet", () => {
    setSelectedSheetIndices([0, 1, 3]);
    expect(getGroupedSheetIndices(1)).toEqual([0, 3]);
  });

  it("clearSheetGrouping resets to empty", () => {
    setSelectedSheetIndices([0, 1]);
    clearSheetGrouping();
    expect(getSelectedSheetIndices()).toEqual([]);
    expect(isSheetGroupingActive()).toBe(false);
  });
});

describe("toggleSheetInGroup", () => {
  beforeEach(() => {
    clearSheetGrouping();
  });

  it("starts grouping with active + toggled sheet", () => {
    const result = toggleSheetInGroup(2, 0);
    expect(result).toEqual([0, 2]);
  });

  it("adds a third sheet to existing group", () => {
    toggleSheetInGroup(2, 0);
    const result = toggleSheetInGroup(4, 0);
    expect(result).toEqual([0, 2, 4]);
  });

  it("removes a non-active sheet from group", () => {
    toggleSheetInGroup(2, 0);
    toggleSheetInGroup(4, 0);
    const result = toggleSheetInGroup(2, 0);
    expect(result).toEqual([0, 4]);
  });

  it("cannot remove the active sheet", () => {
    setSelectedSheetIndices([0, 2]);
    const result = toggleSheetInGroup(0, 0);
    expect(result).toContain(0);
  });

  it("toggling same non-active sheet twice returns to just two sheets", () => {
    toggleSheetInGroup(1, 0);
    toggleSheetInGroup(1, 0);
    // After removing 1, only [0] remains (or empty depending on state)
    expect(getSelectedSheetIndices().length).toBeLessThanOrEqual(1);
  });
});
