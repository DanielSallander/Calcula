//! FILENAME: app/extensions/Search/__tests__/useFindStore.test.ts
// PURPOSE: Tests for the Find & Replace store (shared between Search panel and FindReplaceDialog).

import { describe, it, expect, beforeEach } from "vitest";
import { useFindStore } from "../../BuiltIn/FindReplaceDialog/useFindStore";

// ============================================================================
// Helper
// ============================================================================

function resetStore() {
  useFindStore.getState().reset();
}

// ============================================================================
// Tests
// ============================================================================

describe("useFindStore", () => {
  beforeEach(() => {
    resetStore();
  });

  // --------------------------------------------------------------------------
  // Dialog control
  // --------------------------------------------------------------------------

  describe("dialog control", () => {
    it("starts closed", () => {
      expect(useFindStore.getState().isOpen).toBe(false);
    });

    it("opens the dialog", () => {
      useFindStore.getState().open();
      expect(useFindStore.getState().isOpen).toBe(true);
      expect(useFindStore.getState().showReplace).toBe(false);
    });

    it("opens with replace visible", () => {
      useFindStore.getState().open(true);
      expect(useFindStore.getState().isOpen).toBe(true);
      expect(useFindStore.getState().showReplace).toBe(true);
    });

    it("closes the dialog", () => {
      useFindStore.getState().open();
      useFindStore.getState().close();
      expect(useFindStore.getState().isOpen).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Search state
  // --------------------------------------------------------------------------

  describe("search state", () => {
    it("sets query", () => {
      useFindStore.getState().setQuery("hello");
      expect(useFindStore.getState().query).toBe("hello");
    });

    it("sets replace text", () => {
      useFindStore.getState().setReplaceText("world");
      expect(useFindStore.getState().replaceText).toBe("world");
    });

    it("sets matches and resets index to 0", () => {
      const matches: [number, number][] = [[0, 0], [1, 1], [2, 2]];
      useFindStore.getState().setMatches(matches, "test");
      const state = useFindStore.getState();
      expect(state.matches).toEqual(matches);
      expect(state.query).toBe("test");
      expect(state.currentIndex).toBe(0);
    });

    it("sets currentIndex to -1 when matches are empty", () => {
      useFindStore.getState().setMatches([], "test");
      expect(useFindStore.getState().currentIndex).toBe(-1);
    });

    it("sets current index within bounds", () => {
      useFindStore.getState().setMatches([[0, 0], [1, 1]], "q");
      useFindStore.getState().setCurrentIndex(1);
      expect(useFindStore.getState().currentIndex).toBe(1);
    });

    it("rejects out-of-bounds index", () => {
      useFindStore.getState().setMatches([[0, 0]], "q");
      useFindStore.getState().setCurrentIndex(5);
      expect(useFindStore.getState().currentIndex).toBe(0);
    });

    it("clears results", () => {
      useFindStore.getState().setMatches([[0, 0]], "q");
      useFindStore.getState().clearResults();
      expect(useFindStore.getState().matches).toEqual([]);
      expect(useFindStore.getState().currentIndex).toBe(-1);
    });
  });

  // --------------------------------------------------------------------------
  // Options
  // --------------------------------------------------------------------------

  describe("options", () => {
    it("defaults to case insensitive", () => {
      expect(useFindStore.getState().options.caseSensitive).toBe(false);
    });

    it("defaults to partial cell match", () => {
      expect(useFindStore.getState().options.matchEntireCell).toBe(false);
    });

    it("defaults to not searching formulas", () => {
      expect(useFindStore.getState().options.searchFormulas).toBe(false);
    });

    it("sets case sensitive option", () => {
      useFindStore.getState().setOptions({ caseSensitive: true });
      expect(useFindStore.getState().options.caseSensitive).toBe(true);
      // other options unchanged
      expect(useFindStore.getState().options.matchEntireCell).toBe(false);
    });

    it("sets multiple options at once", () => {
      useFindStore.getState().setOptions({ caseSensitive: true, matchEntireCell: true });
      const opts = useFindStore.getState().options;
      expect(opts.caseSensitive).toBe(true);
      expect(opts.matchEntireCell).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Navigation
  // --------------------------------------------------------------------------

  describe("navigation", () => {
    beforeEach(() => {
      useFindStore.getState().setMatches([[0, 0], [1, 1], [2, 2]], "q");
    });

    it("nextMatch advances index", () => {
      expect(useFindStore.getState().currentIndex).toBe(0);
      useFindStore.getState().nextMatch();
      expect(useFindStore.getState().currentIndex).toBe(1);
    });

    it("nextMatch wraps around", () => {
      useFindStore.getState().setCurrentIndex(2);
      useFindStore.getState().nextMatch();
      expect(useFindStore.getState().currentIndex).toBe(0);
    });

    it("previousMatch goes back", () => {
      useFindStore.getState().setCurrentIndex(2);
      useFindStore.getState().previousMatch();
      expect(useFindStore.getState().currentIndex).toBe(1);
    });

    it("previousMatch wraps to end from 0", () => {
      useFindStore.getState().previousMatch();
      expect(useFindStore.getState().currentIndex).toBe(2);
    });

    it("nextMatch does nothing with no matches", () => {
      useFindStore.getState().clearResults();
      useFindStore.getState().nextMatch();
      expect(useFindStore.getState().currentIndex).toBe(-1);
    });

    it("previousMatch does nothing with no matches", () => {
      useFindStore.getState().clearResults();
      useFindStore.getState().previousMatch();
      expect(useFindStore.getState().currentIndex).toBe(-1);
    });
  });

  // --------------------------------------------------------------------------
  // Reset
  // --------------------------------------------------------------------------

  describe("reset", () => {
    it("resets all state to defaults", () => {
      useFindStore.getState().open(true);
      useFindStore.getState().setQuery("test");
      useFindStore.getState().setMatches([[0, 0]], "test");
      useFindStore.getState().setOptions({ caseSensitive: true });

      useFindStore.getState().reset();

      const state = useFindStore.getState();
      expect(state.isOpen).toBe(false);
      expect(state.query).toBe("");
      expect(state.matches).toEqual([]);
      expect(state.currentIndex).toBe(-1);
      expect(state.options.caseSensitive).toBe(false);
    });
  });
});
