//! FILENAME: app/extensions/BuiltIn/FindReplaceDialog/FindReplaceDialog.tsx
// PURPOSE: Find and Replace dialog component
// CONTEXT: Provides UI for searching and replacing cell content
// UPDATED: Now uses extension-local useFindStore instead of Core's GridState.
//          This follows Microkernel Architecture - Find is a feature, not a kernel primitive.
//          Core only provides primitives (setSelection, scrollToCell).
//          Dialog state (isOpen, currentIndex, matches) lives in the extension.

import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  // Core primitives only - no Find actions from Core
  useGridDispatch,
  setSelection,
  scrollToCell,
  // Backend API for search operations
  findAll,
  replaceAll,
  replaceSingle,
  // Events and utilities
  cellEvents,
  columnToLetter,
} from "../../../src/api";
import type { DialogProps } from "../../../src/api/uiTypes";
// Extension-local state management
import { useFindStore } from "./useFindStore";
import * as S from "./FindReplaceDialog.styles";

export function FindReplaceDialog(props: DialogProps): React.ReactElement | null {
  // Core dispatch for grid primitives (selection, scroll)
  const dispatch = useGridDispatch();

  // Extension-local Find state from Zustand store
  const {
    isOpen,
    showReplace,
    matches,
    currentIndex,
    query,
    options,
    setMatches,
    setCurrentIndex,
    setOptions,
    close,
    clearResults,
  } = useFindStore();

  const [searchValue, setSearchValue] = useState("");
  const [replaceValue, setReplaceValue] = useState("");
  const [isSearching, setIsSearching] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Track the current search value in a ref for use in cell event listener
  const searchValueRef = useRef(searchValue);
  useEffect(() => {
    searchValueRef.current = searchValue;
  }, [searchValue]);

  // Focus search input when dialog opens
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
      searchInputRef.current.select();
    }
  }, [isOpen]);

  // Perform search
  const performSearch = useCallback(
    async (searchQuery: string, preserveIndex = false) => {
      if (!searchQuery.trim()) {
        clearResults();
        return;
      }

      setIsSearching(true);
      try {
        const result = await findAll(searchQuery, {
          caseSensitive: options.caseSensitive,
          matchEntireCell: options.matchEntireCell,
          searchFormulas: options.searchFormulas,
        });

        // Update extension-local state
        setMatches(result.matches, searchQuery);

        // Navigate to first match if any (unless preserving index for live updates)
        if (result.matches.length > 0 && !preserveIndex) {
          const [row, col] = result.matches[0];
          // Use Core primitives for navigation
          dispatch(setSelection(row, col, row, col, "cells"));
          dispatch(scrollToCell(row, col, false));
        }
      } catch (error) {
        console.error("[FindReplaceDialog] Search failed:", error);
      } finally {
        setIsSearching(false);
      }
    },
    [dispatch, options.caseSensitive, options.matchEntireCell, options.searchFormulas, setMatches, clearResults]
  );

  // Handle search input change with debounce
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchValue !== query) {
        performSearch(searchValue);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [searchValue, performSearch, query]);

  // Subscribe to cell change events for live search updates
  useEffect(() => {
    // Only subscribe when dialog is open and there's a search query
    if (!isOpen) {
      return;
    }

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const handleCellChange = () => {
      const currentQuery = searchValueRef.current;
      if (!currentQuery.trim()) {
        return;
      }

      // Debounce to avoid excessive searches during rapid edits
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = setTimeout(() => {
        // Re-run search with preserveIndex=true to avoid jumping to first match
        performSearch(currentQuery, true);
      }, 500);
    };

    const unsubscribe = cellEvents.subscribe(handleCellChange);

    return () => {
      unsubscribe();
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    };
  }, [isOpen, performSearch]);

  // Navigate to next match
  const handleFindNext = useCallback(() => {
    if (matches.length === 0) return;

    const nextIndex = (currentIndex + 1) % matches.length;
    setCurrentIndex(nextIndex);

    const [row, col] = matches[nextIndex];
    // Use Core primitives for navigation
    dispatch(setSelection(row, col, row, col, "cells"));
    dispatch(scrollToCell(row, col, false));
  }, [dispatch, matches, currentIndex, setCurrentIndex]);

  // Navigate to previous match
  const handleFindPrevious = useCallback(() => {
    if (matches.length === 0) return;

    const prevIndex = currentIndex <= 0 ? matches.length - 1 : currentIndex - 1;
    setCurrentIndex(prevIndex);

    const [row, col] = matches[prevIndex];
    // Use Core primitives for navigation
    dispatch(setSelection(row, col, row, col, "cells"));
    dispatch(scrollToCell(row, col, false));
  }, [dispatch, matches, currentIndex, setCurrentIndex]);

  // Replace current match
  const handleReplace = useCallback(async () => {
    if (currentIndex < 0 || currentIndex >= matches.length) return;

    const [row, col] = matches[currentIndex];

    try {
      const result = await replaceSingle(
        row,
        col,
        searchValue,
        replaceValue,
        options.caseSensitive
      );

      if (result) {
        // Emit cell change event for refresh
        cellEvents.emit({
          row: result.row,
          col: result.col,
          oldValue: undefined,
          newValue: result.display,
          formula: result.formula,
        });

        // Re-search to update matches
        await performSearch(searchValue);
      }
    } catch (error) {
      console.error("[FindReplaceDialog] Replace failed:", error);
    }
  }, [currentIndex, matches, searchValue, replaceValue, options.caseSensitive, performSearch]);

  // Replace all matches
  const handleReplaceAll = useCallback(async () => {
    if (!searchValue.trim()) return;

    try {
      const result = await replaceAll(searchValue, replaceValue, {
        caseSensitive: options.caseSensitive,
        matchEntireCell: options.matchEntireCell,
      });

      console.log(`[FindReplaceDialog] Replaced ${result.replacementCount} occurrences`);

      // Emit refresh events
      for (const cell of result.updatedCells) {
        cellEvents.emit({
          row: cell.row,
          col: cell.col,
          oldValue: undefined,
          newValue: cell.display,
          formula: cell.formula,
        });
      }

      // Clear results since all replaced
      setMatches([], searchValue);
    } catch (error) {
      console.error("[FindReplaceDialog] Replace all failed:", error);
    }
  }, [searchValue, replaceValue, options.caseSensitive, options.matchEntireCell, setMatches]);

  // Handle close - sync both Zustand store and DialogExtensions registry
  const handleClose = useCallback(() => {
    close();
    props.onClose();
    setSearchValue("");
    setReplaceValue("");
  }, [close, props]);

  // Handle key down - stop propagation to prevent grid keyboard handler from intercepting
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Stop propagation for ALL keys to prevent grid keyboard handler from intercepting
      // This allows typing in the input fields without triggering grid navigation
      e.stopPropagation();

      if (e.key === "Escape") {
        handleClose();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) {
          handleFindPrevious();
        } else {
          handleFindNext();
        }
      } else if (e.key === "F3") {
        e.preventDefault();
        if (e.shiftKey) {
          handleFindPrevious();
        } else {
          handleFindNext();
        }
      }
    },
    [handleClose, handleFindNext, handleFindPrevious]
  );

  // Toggle options
  const toggleCaseSensitive = useCallback(() => {
    setOptions({ caseSensitive: !options.caseSensitive });
    if (searchValue) {
      performSearch(searchValue);
    }
  }, [options.caseSensitive, searchValue, performSearch, setOptions]);

  const toggleMatchEntireCell = useCallback(() => {
    setOptions({ matchEntireCell: !options.matchEntireCell });
    if (searchValue) {
      performSearch(searchValue);
    }
  }, [options.matchEntireCell, searchValue, performSearch, setOptions]);

  if (!isOpen) {
    return null;
  }

  const currentMatch =
    currentIndex >= 0 && matches.length > 0 ? matches[currentIndex] : null;

  const currentMatchLabel = currentMatch
    ? `${columnToLetter(currentMatch[1])}${currentMatch[0] + 1}`
    : "";

  return (
    <S.Overlay ref={dialogRef} onKeyDown={handleKeyDown}>
      <S.DialogContainer>
        {/* Header */}
        <S.Header>
          <S.Title>{showReplace ? "Find and Replace" : "Find"}</S.Title>
          <S.CloseButton onClick={handleClose} title="Close (Esc)">
            X
          </S.CloseButton>
        </S.Header>

        {/* Search row */}
        <S.Row>
          <S.Label>Find:</S.Label>
          <S.Input
            ref={searchInputRef}
            type="text"
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
            placeholder="Search..."
          />
          <S.ActionButton
            onClick={handleFindPrevious}
            disabled={matches.length === 0}
            title="Find Previous (Shift+Enter)"
          >
            {"<"}
          </S.ActionButton>
          <S.ActionButton
            onClick={handleFindNext}
            disabled={matches.length === 0}
            title="Find Next (Enter)"
          >
            {">"}
          </S.ActionButton>
        </S.Row>

        {/* Replace row (if enabled) */}
        {showReplace && (
          <S.Row>
            <S.Label>Replace:</S.Label>
            <S.Input
              type="text"
              value={replaceValue}
              onChange={(e) => setReplaceValue(e.target.value)}
              placeholder="Replace with..."
            />
            <S.ActionButton
              onClick={handleReplace}
              disabled={matches.length === 0}
              title="Replace current match"
            >
              Replace
            </S.ActionButton>
            <S.ActionButton
              onClick={handleReplaceAll}
              disabled={matches.length === 0}
              title="Replace all matches"
            >
              All
            </S.ActionButton>
          </S.Row>
        )}

        {/* Options row */}
        <S.OptionsRow>
          <S.CheckboxLabel>
            <input
              type="checkbox"
              checked={options.caseSensitive}
              onChange={toggleCaseSensitive}
            />
            Match case
          </S.CheckboxLabel>
          <S.CheckboxLabel>
            <input
              type="checkbox"
              checked={options.matchEntireCell}
              onChange={toggleMatchEntireCell}
            />
            Match entire cell
          </S.CheckboxLabel>
        </S.OptionsRow>

        {/* Status row */}
        <S.StatusRow>
          {isSearching ? (
            <span>Searching...</span>
          ) : matches.length > 0 ? (
            <span>
              {currentIndex + 1} of {matches.length} matches
              {currentMatchLabel && ` (${currentMatchLabel})`}
            </span>
          ) : searchValue ? (
            <span>No matches found</span>
          ) : (
            <span>Enter search text</span>
          )}
        </S.StatusRow>
      </S.DialogContainer>
    </S.Overlay>
  );
}

export default FindReplaceDialog;