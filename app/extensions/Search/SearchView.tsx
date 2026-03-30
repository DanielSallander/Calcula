//! FILENAME: app/extensions/Search/SearchView.tsx
// PURPOSE: Search panel for the Activity Bar side panel
// CONTEXT: Provides search/replace UI as a persistent side panel view
// NOTE: Shares useFindStore with FindReplaceDialog - they can coexist

import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  useGridDispatch,
  setSelection,
  scrollToCell,
  findAll,
  replaceAll,
  replaceSingle,
  cellEvents,
  columnToLetter,
} from "../../src/api";
import type { ActivityViewProps } from "../../src/api/uiTypes";
import { useFindStore } from "../BuiltIn/FindReplaceDialog/useFindStore";

// SVG micro-icons for the search panel
const ChevronUp = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 10l4-4 4 4" />
  </svg>
);

const ChevronDown = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 6l4 4 4-4" />
  </svg>
);

const ChevronRight = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 4l4 4-4 4" />
  </svg>
);

/**
 * Search View - panel-oriented search and replace.
 */
export function SearchView(_props: ActivityViewProps): React.ReactElement {
  const dispatch = useGridDispatch();
  const {
    matches,
    currentIndex,
    options,
    setMatches,
    setCurrentIndex,
    setOptions,
    clearResults,
    nextMatch,
    previousMatch,
  } = useFindStore();

  const [searchValue, setSearchValue] = useState("");
  const [replaceValue, setReplaceValue] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [isSearching, setIsSearching] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchValueRef = useRef(searchValue);

  useEffect(() => {
    searchValueRef.current = searchValue;
  }, [searchValue]);

  // Focus search input on mount
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  // Perform search
  const performSearch = useCallback(
    async (query: string, preserveIndex = false) => {
      if (!query.trim()) {
        clearResults();
        return;
      }

      setIsSearching(true);
      try {
        const result = await findAll(query, {
          caseSensitive: options.caseSensitive,
          matchEntireCell: options.matchEntireCell,
          searchFormulas: options.searchFormulas,
        });

        setMatches(result.matches, query);

        if (result.matches.length > 0 && !preserveIndex) {
          const [row, col] = result.matches[0];
          dispatch(setSelection(row, col, row, col, "cells"));
          dispatch(scrollToCell(row, col, false));
        }
      } catch (error) {
        console.error("[Search] Search failed:", error);
      } finally {
        setIsSearching(false);
      }
    },
    [dispatch, options, setMatches, clearResults]
  );

  // Debounced live search
  useEffect(() => {
    if (!searchValue.trim()) {
      clearResults();
      return;
    }

    const timer = setTimeout(() => {
      performSearch(searchValue);
    }, 300);

    return () => clearTimeout(timer);
  }, [searchValue, options.caseSensitive, options.matchEntireCell, options.searchFormulas]);

  // Re-search when cells change
  useEffect(() => {
    const unsubscribe = cellEvents.subscribe(() => {
      const current = searchValueRef.current;
      if (current.trim()) {
        setTimeout(() => performSearch(current, true), 500);
      }
    });
    return unsubscribe;
  }, [performSearch]);

  // Navigate to match
  const navigateToMatch = useCallback(
    (index: number) => {
      if (index >= 0 && index < matches.length) {
        setCurrentIndex(index);
        const [row, col] = matches[index];
        dispatch(setSelection(row, col, row, col, "cells"));
        dispatch(scrollToCell(row, col, false));
      }
    },
    [matches, dispatch, setCurrentIndex]
  );

  const handleNext = useCallback(() => {
    if (matches.length === 0) return;
    const next = (currentIndex + 1) % matches.length;
    navigateToMatch(next);
  }, [matches, currentIndex, navigateToMatch]);

  const handlePrev = useCallback(() => {
    if (matches.length === 0) return;
    const prev = currentIndex <= 0 ? matches.length - 1 : currentIndex - 1;
    navigateToMatch(prev);
  }, [matches, currentIndex, navigateToMatch]);

  const handleReplaceCurrent = useCallback(async () => {
    if (currentIndex < 0 || currentIndex >= matches.length) return;
    const [row, col] = matches[currentIndex];
    try {
      await replaceSingle(row, col, searchValue, replaceValue, options.caseSensitive);
      performSearch(searchValue, true);
    } catch (error) {
      console.error("[Search] Replace failed:", error);
    }
  }, [matches, currentIndex, searchValue, replaceValue, options.caseSensitive, performSearch]);

  const handleReplaceAll = useCallback(async () => {
    if (!searchValue.trim()) return;
    try {
      const result = await replaceAll(searchValue, replaceValue, {
        caseSensitive: options.caseSensitive,
        matchEntireCell: options.matchEntireCell,
      });
      console.log(`[Search] Replaced ${result.replacementCount} occurrences`);
      performSearch(searchValue);
    } catch (error) {
      console.error("[Search] Replace all failed:", error);
    }
  }, [searchValue, replaceValue, options, performSearch]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) {
          handlePrev();
        } else {
          handleNext();
        }
      } else if (e.key === "Escape") {
        clearResults();
        setSearchValue("");
      }
    },
    [handleNext, handlePrev, clearResults]
  );

  const matchDisplay = matches.length === 0
    ? searchValue.trim() ? "No results" : ""
    : `${currentIndex + 1} of ${matches.length}`;

  return (
    <div style={styles.container}>
      {/* Search input */}
      <div style={styles.inputGroup}>
        <div style={styles.inputRow}>
          <input
            ref={searchInputRef}
            type="text"
            style={styles.input}
            placeholder="Search"
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div style={styles.navButtons}>
            <button style={styles.navButton} onClick={handlePrev} disabled={matches.length === 0} title="Previous (Shift+Enter)"><ChevronUp /></button>
            <button style={styles.navButton} onClick={handleNext} disabled={matches.length === 0} title="Next (Enter)"><ChevronDown /></button>
          </div>
        </div>

        {/* Match count */}
        {matchDisplay && (
          <div style={styles.matchCount}>{matchDisplay}</div>
        )}
      </div>

      {/* Replace toggle + input */}
      <div style={styles.inputGroup}>
        <button
          style={styles.toggleReplace}
          onClick={() => setShowReplace(!showReplace)}
        >
          <span style={{ display: "inline-flex", transform: showReplace ? "rotate(90deg)" : "none", transition: "transform 0.15s ease" }}>
            <ChevronRight />
          </span>
          Replace
        </button>

        {showReplace && (
          <>
            <div style={styles.inputRow}>
              <input
                type="text"
                style={styles.input}
                placeholder="Replace"
                value={replaceValue}
                onChange={(e) => setReplaceValue(e.target.value)}
              />
            </div>
            <div style={styles.replaceActions}>
              <button
                style={styles.actionButton}
                onClick={handleReplaceCurrent}
                disabled={currentIndex < 0}
              >
                Replace
              </button>
              <button
                style={styles.actionButton}
                onClick={handleReplaceAll}
                disabled={matches.length === 0}
              >
                Replace All
              </button>
            </div>
          </>
        )}
      </div>

      {/* Options */}
      <div style={styles.optionsSection}>
        <label style={styles.checkbox}>
          <input
            type="checkbox"
            style={styles.checkboxInput}
            checked={options.caseSensitive}
            onChange={(e) => setOptions({ caseSensitive: e.target.checked })}
          />
          <span>Match case</span>
        </label>
        <label style={styles.checkbox}>
          <input
            type="checkbox"
            style={styles.checkboxInput}
            checked={options.matchEntireCell}
            onChange={(e) => setOptions({ matchEntireCell: e.target.checked })}
          />
          <span>Match entire cell</span>
        </label>
        <label style={styles.checkbox}>
          <input
            type="checkbox"
            style={styles.checkboxInput}
            checked={options.searchFormulas}
            onChange={(e) => setOptions({ searchFormulas: e.target.checked })}
          />
          <span>Search in formulas</span>
        </label>
      </div>

      {/* Results list */}
      {matches.length > 0 && (
        <div style={styles.resultsList}>
          <div style={styles.resultsHeader}>Results</div>
          <div style={styles.resultsScroll}>
            {matches.map(([row, col], idx) => (
              <div
                key={`${row}-${col}`}
                style={{
                  ...styles.resultItem,
                  backgroundColor: idx === currentIndex ? "#e3f2fd" : "transparent",
                }}
                onClick={() => navigateToMatch(idx)}
              >
                {columnToLetter(col)}{row + 1}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    padding: 12,
    gap: 12,
    overflow: "hidden",
  },
  inputGroup: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  inputRow: {
    display: "flex",
    gap: 4,
  },
  input: {
    flex: 1,
    padding: "5px 8px",
    border: "1px solid #d0d0d0",
    borderRadius: 3,
    fontSize: 12,
    outline: "none",
    fontFamily: "inherit",
    backgroundColor: "#fff",
    color: "#333",
  },
  navButtons: {
    display: "flex",
    gap: 2,
  },
  navButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 24,
    height: 26,
    padding: 0,
    border: "1px solid transparent",
    borderRadius: 3,
    background: "transparent",
    cursor: "pointer",
    fontSize: 10,
    color: "#555",
  },
  matchCount: {
    fontSize: 11,
    color: "#666",
    paddingLeft: 2,
  },
  toggleReplace: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "2px 0",
    border: "none",
    background: "transparent",
    fontSize: 12,
    color: "#555",
    cursor: "pointer",
    fontFamily: "inherit",
  },
  replaceActions: {
    display: "flex",
    gap: 4,
    marginTop: 2,
  },
  actionButton: {
    padding: "4px 12px",
    border: "1px solid #d0d0d0",
    borderRadius: 3,
    background: "#fafafa",
    fontSize: 11,
    cursor: "pointer",
    color: "#333",
    fontFamily: "inherit",
  },
  optionsSection: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    paddingTop: 4,
    borderTop: "1px solid #e8e8e8",
  },
  checkbox: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    color: "#444",
    cursor: "pointer",
  },
  checkboxInput: {
    accentColor: "#0078d4",
    width: 14,
    height: 14,
    margin: 0,
    cursor: "pointer",
  } as React.CSSProperties,
  resultsList: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    borderTop: "1px solid #e8e8e8",
    paddingTop: 8,
  },
  resultsHeader: {
    fontSize: 11,
    fontWeight: 600,
    color: "#666",
    textTransform: "uppercase" as const,
    letterSpacing: "0.5px",
    marginBottom: 4,
  },
  resultsScroll: {
    flex: 1,
    overflowY: "auto",
  },
  resultItem: {
    padding: "3px 8px",
    fontSize: 12,
    color: "#333",
    cursor: "pointer",
    borderRadius: 2,
  },
};
