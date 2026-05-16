//! FILENAME: app/extensions/Search/__tests__/useFindStore.deep.test.ts
// PURPOSE: Deep tests for the Find & Replace store covering regex, options toggling,
//          replace scenarios, navigation edge cases, and special characters.

import { describe, it, expect, beforeEach } from "vitest";
import { useFindStore } from "../../BuiltIn/FindReplaceDialog/useFindStore";

// ============================================================================
// Helper
// ============================================================================

function resetStore() {
  useFindStore.getState().reset();
}

/** Shorthand to set matches simulating a search result. */
function setMatchesFor(coords: [number, number][], query: string) {
  useFindStore.getState().setMatches(coords, query);
}

// ============================================================================
// Tests
// ============================================================================

describe("useFindStore (deep)", () => {
  beforeEach(() => {
    resetStore();
  });

  // --------------------------------------------------------------------------
  // Regex-style query strings (store holds the raw query; matching is external)
  // --------------------------------------------------------------------------

  describe("regex pattern queries", () => {
    it("stores a digit-matching regex pattern", () => {
      useFindStore.getState().setQuery(".*\\d+");
      expect(useFindStore.getState().query).toBe(".*\\d+");
    });

    it("stores a formula-prefix regex", () => {
      useFindStore.getState().setQuery("^SUM\\(");
      expect(useFindStore.getState().query).toBe("^SUM\\(");
    });

    it("stores an absolute cell reference regex", () => {
      useFindStore.getState().setQuery("\\$[A-Z]+\\$\\d+");
      expect(useFindStore.getState().query).toBe("\\$[A-Z]+\\$\\d+");
    });

    it("stores matches found by an external regex search", () => {
      const matches: [number, number][] = [[0, 3], [4, 7], [10, 2]];
      setMatchesFor(matches, ".*\\d+");
      const state = useFindStore.getState();
      expect(state.matches).toHaveLength(3);
      expect(state.query).toBe(".*\\d+");
      expect(state.currentIndex).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Case sensitivity toggling mid-search
  // --------------------------------------------------------------------------

  describe("case sensitivity toggling mid-search", () => {
    it("preserves matches when toggling caseSensitive", () => {
      setMatchesFor([[0, 0], [1, 1]], "hello");
      useFindStore.getState().setOptions({ caseSensitive: true });
      // matches are still present (re-search is the caller's responsibility)
      expect(useFindStore.getState().matches).toHaveLength(2);
      expect(useFindStore.getState().options.caseSensitive).toBe(true);
    });

    it("toggling caseSensitive off then on preserves query", () => {
      useFindStore.getState().setQuery("Hello");
      useFindStore.getState().setOptions({ caseSensitive: true });
      useFindStore.getState().setOptions({ caseSensitive: false });
      expect(useFindStore.getState().query).toBe("Hello");
      expect(useFindStore.getState().options.caseSensitive).toBe(false);
    });

    it("toggling does not reset currentIndex", () => {
      setMatchesFor([[0, 0], [1, 1], [2, 2]], "test");
      useFindStore.getState().setCurrentIndex(2);
      useFindStore.getState().setOptions({ caseSensitive: true });
      expect(useFindStore.getState().currentIndex).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // matchEntireCell vs partial match
  // --------------------------------------------------------------------------

  describe("matchEntireCell vs partial match", () => {
    it("matchEntireCell defaults to false (partial)", () => {
      expect(useFindStore.getState().options.matchEntireCell).toBe(false);
    });

    it("can enable matchEntireCell independently", () => {
      useFindStore.getState().setOptions({ matchEntireCell: true });
      expect(useFindStore.getState().options.matchEntireCell).toBe(true);
      expect(useFindStore.getState().options.caseSensitive).toBe(false);
      expect(useFindStore.getState().options.searchFormulas).toBe(false);
    });

    it("external search can produce different match sets for each mode", () => {
      // Partial: "test" matches "testing", "test", "attest"
      setMatchesFor([[0, 0], [0, 1], [0, 2]], "test");
      expect(useFindStore.getState().matches).toHaveLength(3);

      // Entire cell: only "test" matches
      setMatchesFor([[0, 1]], "test");
      expect(useFindStore.getState().matches).toHaveLength(1);
      expect(useFindStore.getState().currentIndex).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Search in formulas vs values
  // --------------------------------------------------------------------------

  describe("searchFormulas option", () => {
    it("defaults to searching values (not formulas)", () => {
      expect(useFindStore.getState().options.searchFormulas).toBe(false);
    });

    it("can switch to formula search mode", () => {
      useFindStore.getState().setOptions({ searchFormulas: true });
      expect(useFindStore.getState().options.searchFormulas).toBe(true);
    });

    it("combining searchFormulas with caseSensitive", () => {
      useFindStore.getState().setOptions({ searchFormulas: true, caseSensitive: true });
      const opts = useFindStore.getState().options;
      expect(opts.searchFormulas).toBe(true);
      expect(opts.caseSensitive).toBe(true);
      expect(opts.matchEntireCell).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Replace all with empty string (deletion)
  // --------------------------------------------------------------------------

  describe("replace with empty string", () => {
    it("sets replaceText to empty string", () => {
      useFindStore.getState().setReplaceText("");
      expect(useFindStore.getState().replaceText).toBe("");
    });

    it("after replace-all the match list can be cleared", () => {
      setMatchesFor([[0, 0], [1, 1], [2, 2]], "foo");
      useFindStore.getState().setReplaceText("");
      // Simulate a replace-all operation by clearing results
      useFindStore.getState().clearResults();
      expect(useFindStore.getState().matches).toEqual([]);
      expect(useFindStore.getState().currentIndex).toBe(-1);
    });
  });

  // --------------------------------------------------------------------------
  // Replace that changes the number of matches
  // --------------------------------------------------------------------------

  describe("replace changes match count", () => {
    it("reducing matches adjusts currentIndex via setMatches", () => {
      setMatchesFor([[0, 0], [1, 1], [2, 2]], "old");
      useFindStore.getState().setCurrentIndex(2);
      // After replacing one match, only 2 remain
      setMatchesFor([[0, 0], [2, 2]], "old");
      expect(useFindStore.getState().currentIndex).toBe(0);
      expect(useFindStore.getState().matches).toHaveLength(2);
    });

    it("replacing all matches yields empty set", () => {
      setMatchesFor([[0, 0]], "target");
      setMatchesFor([], "target");
      expect(useFindStore.getState().matches).toHaveLength(0);
      expect(useFindStore.getState().currentIndex).toBe(-1);
    });

    it("replacing some matches and re-searching yields new results", () => {
      setMatchesFor([[0, 0], [1, 0], [2, 0]], "abc");
      // Simulate: replaced first match, re-searched
      setMatchesFor([[1, 0], [2, 0]], "abc");
      expect(useFindStore.getState().matches).toHaveLength(2);
      expect(useFindStore.getState().currentIndex).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Navigation with matches on multiple sheets
  // --------------------------------------------------------------------------

  describe("navigation with multi-sheet matches", () => {
    // Match tuples here represent [row, col]; sheet tracking is external,
    // but we test the store's navigation across a large flat list.

    const multiSheetMatches: [number, number][] = [
      [0, 0], [5, 3],   // Sheet 1
      [0, 1], [10, 2],  // Sheet 2
      [0, 0], [3, 7],   // Sheet 3
    ];

    beforeEach(() => {
      setMatchesFor(multiSheetMatches, "data");
    });

    it("starts at first match (sheet 1)", () => {
      expect(useFindStore.getState().currentIndex).toBe(0);
      expect(useFindStore.getState().matches[0]).toEqual([0, 0]);
    });

    it("navigates forward through all sheets", () => {
      for (let i = 0; i < 6; i++) {
        expect(useFindStore.getState().currentIndex).toBe(i);
        useFindStore.getState().nextMatch();
      }
      // wraps back to 0
      expect(useFindStore.getState().currentIndex).toBe(0);
    });

    it("navigates backward through all sheets", () => {
      useFindStore.getState().previousMatch(); // wraps to last
      expect(useFindStore.getState().currentIndex).toBe(5);
      useFindStore.getState().previousMatch();
      expect(useFindStore.getState().currentIndex).toBe(4);
    });

    it("full backward cycle returns to start", () => {
      for (let i = 0; i < 6; i++) {
        useFindStore.getState().previousMatch();
      }
      expect(useFindStore.getState().currentIndex).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Special regex characters in query
  // --------------------------------------------------------------------------

  describe("special regex characters in query", () => {
    const specials = [
      ".", "*", "+", "?", "[", "]", "(", ")", "{", "}", "^", "$", "|", "\\",
    ];

    for (const ch of specials) {
      it(`stores special char '${ch}' in query`, () => {
        useFindStore.getState().setQuery(ch);
        expect(useFindStore.getState().query).toBe(ch);
      });
    }

    it("stores a query combining many special chars", () => {
      const combined = ".*+?[](){}^$|\\";
      useFindStore.getState().setQuery(combined);
      expect(useFindStore.getState().query).toBe(combined);
    });
  });

  // --------------------------------------------------------------------------
  // Very long search query
  // --------------------------------------------------------------------------

  describe("very long search query", () => {
    it("stores a 1000-char query", () => {
      const longQuery = "a".repeat(1000);
      useFindStore.getState().setQuery(longQuery);
      expect(useFindStore.getState().query).toHaveLength(1000);
      expect(useFindStore.getState().query).toBe(longQuery);
    });

    it("stores a 1000-char replace text", () => {
      const longReplace = "x".repeat(1000);
      useFindStore.getState().setReplaceText(longReplace);
      expect(useFindStore.getState().replaceText).toHaveLength(1000);
    });
  });

  // --------------------------------------------------------------------------
  // Search with no matches then adding matches
  // --------------------------------------------------------------------------

  describe("no matches then matches appear", () => {
    it("starts with no matches", () => {
      setMatchesFor([], "xyz");
      expect(useFindStore.getState().matches).toHaveLength(0);
      expect(useFindStore.getState().currentIndex).toBe(-1);
    });

    it("navigation is no-op with no matches", () => {
      setMatchesFor([], "xyz");
      useFindStore.getState().nextMatch();
      expect(useFindStore.getState().currentIndex).toBe(-1);
      useFindStore.getState().previousMatch();
      expect(useFindStore.getState().currentIndex).toBe(-1);
    });

    it("adding matches after empty search resets index to 0", () => {
      setMatchesFor([], "xyz");
      expect(useFindStore.getState().currentIndex).toBe(-1);
      setMatchesFor([[5, 5], [10, 10]], "xyz");
      expect(useFindStore.getState().currentIndex).toBe(0);
      expect(useFindStore.getState().matches).toHaveLength(2);
    });
  });

  // --------------------------------------------------------------------------
  // Edge: single match navigation
  // --------------------------------------------------------------------------

  describe("single match navigation", () => {
    beforeEach(() => {
      setMatchesFor([[3, 7]], "only");
    });

    it("nextMatch stays on same match", () => {
      expect(useFindStore.getState().currentIndex).toBe(0);
      useFindStore.getState().nextMatch();
      expect(useFindStore.getState().currentIndex).toBe(0);
    });

    it("previousMatch stays on same match", () => {
      useFindStore.getState().previousMatch();
      expect(useFindStore.getState().currentIndex).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // setCurrentIndex edge cases
  // --------------------------------------------------------------------------

  describe("setCurrentIndex edge cases", () => {
    it("allows setting to -1", () => {
      setMatchesFor([[0, 0]], "q");
      useFindStore.getState().setCurrentIndex(-1);
      expect(useFindStore.getState().currentIndex).toBe(-1);
    });

    it("rejects negative index below -1", () => {
      setMatchesFor([[0, 0]], "q");
      useFindStore.getState().setCurrentIndex(-2);
      // should remain at 0 (initial)
      expect(useFindStore.getState().currentIndex).toBe(0);
    });

    it("rejects index equal to matches.length", () => {
      setMatchesFor([[0, 0], [1, 1]], "q");
      useFindStore.getState().setCurrentIndex(2);
      expect(useFindStore.getState().currentIndex).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Open/close preserves search state
  // --------------------------------------------------------------------------

  describe("open/close preserves search state", () => {
    it("closing does not clear matches", () => {
      useFindStore.getState().open();
      setMatchesFor([[0, 0], [1, 1]], "test");
      useFindStore.getState().close();
      expect(useFindStore.getState().matches).toHaveLength(2);
      expect(useFindStore.getState().query).toBe("test");
    });

    it("re-opening after close preserves state", () => {
      useFindStore.getState().open();
      setMatchesFor([[2, 3]], "abc");
      useFindStore.getState().setCurrentIndex(0);
      useFindStore.getState().close();
      useFindStore.getState().open();
      expect(useFindStore.getState().query).toBe("abc");
      expect(useFindStore.getState().matches).toHaveLength(1);
    });
  });
});
