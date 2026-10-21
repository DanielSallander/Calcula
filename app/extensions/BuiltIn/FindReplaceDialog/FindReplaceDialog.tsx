//! FILENAME: app/extensions/BuiltIn/FindReplaceDialog/FindReplaceDialog.tsx
// PURPOSE: Find and Replace dialog component
// CONTEXT: Provides UI for searching and replacing cell content
// UPDATED: Now uses extension-local useFindStore instead of Core's GridState.
//          This follows Microkernel Architecture - Find is a feature, not a kernel primitive.
//          Core only provides primitives (setSelection, scrollToCell).
//          Dialog state (isOpen, currentIndex, matches) lives in the extension.
// P3 (owner finding G3): with a floating grid's cell selected, Find searches
//          THAT object's cells (findAll with its target), selects matches in
//          the object (selectTargetCells), and Replace / Replace All write
//          there. The SCOPE is fixed by the search that produced the matches:
//          a replace never applies one scope's coordinates to another.

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
} from "@api";
import type { DialogProps } from "@api/uiTypes";
import {
  cellTargetFor,
  resolveCellTarget,
  selectTargetCells,
  type CellTarget,
  type CellTargetRef,
} from "@api/cellTarget";
import { useDialogWindow } from "@api/dialogWindow";
// Extension-local state management
import { useFindStore } from "../../_shared/lib/useFindStore";
import * as S from "./FindReplaceDialog.styles";

/**
 * What Find searches right now: an OBJECT's cells when one of its cells is
 * selected (asked silently -- a search is a read, and the dialog stays open
 * while the selection moves), else the active sheet (null).
 */
export function findScope(): Extract<CellTarget, { kind: "object" }> | null {
  const t = cellTargetFor("read", "Find");
  return "kind" in t && t.kind === "object" ? t : null;
}

/** Whether two scopes are the same place (both the sheet, or the same object). */
function sameScope(a: CellTargetRef | null, b: CellTargetRef | null): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && a.id === b.id;
}

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
  // A replace can now be REFUSED outright by the backend writeback guard (a
  // match sits inside a subscribed .calp region whose answers must not be
  // rewritten). That arrives as a rejected promise naming the region, so it has
  // to reach the user — swallowing it into console.error made Replace All look
  // like a no-op with no explanation.
  const [errorText, setErrorText] = useState<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  // The place the current matches are in (null = the active sheet).
  const scopeRef = useRef<CellTargetRef | null>(null);

  /** Select the match at (row, col) in the scope that found it. */
  const goTo = useCallback(
    (row: number, col: number) => {
      const scope = scopeRef.current;
      if (scope === null) {
        // Use Core primitives for navigation
        dispatch(setSelection(row, col, row, col, "cells"));
        dispatch(scrollToCell(row, col, false));
        return;
      }
      // Only while the same object still holds the selection: a match in an
      // object is never applied to the sheet's coordinates.
      const now = findScope();
      if (now && sameScope(now.ref, scope)) {
        selectTargetCells(now, {
          startRow: row,
          startCol: col,
          endRow: row,
          endCol: col,
          type: "cells",
          activeRow: row,
          activeCol: col,
        });
      }
    },
    [dispatch],
  );

  /**
   * The target a replace writes with: undefined for the sheet; the object's
   * when the matches are an object's AND that object still takes content
   * (asked out loud). Null: refused -- nothing may be written.
   */
  const replaceTarget = useCallback((action: string): { target: CellTargetRef | undefined } | null => {
    const scope = scopeRef.current;
    if (scope === null) return { target: undefined };
    const t = resolveCellTarget(action, "content");
    if (t === null) return null;
    if (t.kind !== "object" || !sameScope(t.ref, scope)) {
      setErrorText("The selection moved since the search. Search again. Nothing was changed.");
      return null;
    }
    return { target: t.ref };
  }, []);

  // Movable + resizable dialog window (shared @api hook)
  const win = useDialogWindow({ minWidth: 400, minHeight: 200 });

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
        // A live re-search keeps the scope its matches came from; a new
        // search asks where the selection is now.
        const scope = preserveIndex ? scopeRef.current : (findScope()?.ref ?? null);
        const result = await findAll(
          searchQuery,
          {
            caseSensitive: options.caseSensitive,
            matchEntireCell: options.matchEntireCell,
            searchFormulas: options.searchFormulas,
          },
          { target: scope ?? undefined },
        );
        scopeRef.current = scope;

        // Update extension-local state
        setMatches(result.matches, searchQuery);

        // Navigate to first match if any (unless preserving index for live updates)
        if (result.matches.length > 0 && !preserveIndex) {
          const [row, col] = result.matches[0];
          goTo(row, col);
        }
      } catch (error) {
        console.error("[FindReplaceDialog] Search failed:", error);
      } finally {
        setIsSearching(false);
      }
    },
    [goTo, options.caseSensitive, options.matchEntireCell, options.searchFormulas, setMatches, clearResults]
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
    goTo(row, col);
  }, [goTo, matches, currentIndex, setCurrentIndex]);

  // Navigate to previous match
  const handleFindPrevious = useCallback(() => {
    if (matches.length === 0) return;

    const prevIndex = currentIndex <= 0 ? matches.length - 1 : currentIndex - 1;
    setCurrentIndex(prevIndex);

    const [row, col] = matches[prevIndex];
    goTo(row, col);
  }, [goTo, matches, currentIndex, setCurrentIndex]);

  // Replace current match
  const handleReplace = useCallback(async () => {
    if (currentIndex < 0 || currentIndex >= matches.length) return;

    const [row, col] = matches[currentIndex];
    const place = replaceTarget("Replace");
    if (place === null) return;

    try {
      const result = await replaceSingle(
        row,
        col,
        searchValue,
        replaceValue,
        options.caseSensitive,
        undefined,
        { target: place.target },
      );

      if (result && place.target) {
        // An object's cell: its (row, col) would alias an active-sheet cell,
        // so no cell event -- the object re-reads its cells on grid:refresh.
        setErrorText(null);
        window.dispatchEvent(new CustomEvent("grid:refresh"));
        await performSearch(searchValue);
      } else if (result) {
        setErrorText(null);
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
      // A single replace inside a claimed writeback region now ERRORS rather
      // than returning null (null was indistinguishable from "no match"), so
      // this is the only place the user can learn why the cell did not change.
      setErrorText(String(error instanceof Error ? error.message : error));
    }
  }, [currentIndex, matches, searchValue, replaceValue, options.caseSensitive, performSearch, replaceTarget]);

  // Replace all matches
  const handleReplaceAll = useCallback(async () => {
    if (!searchValue.trim()) return;
    const place = replaceTarget("Replace All");
    if (place === null) return;

    try {
      const result = await replaceAll(
        searchValue,
        replaceValue,
        {
          caseSensitive: options.caseSensitive,
          matchEntireCell: options.matchEntireCell,
        },
        { target: place.target },
      );

      setErrorText(null);

      // Emit refresh events (an object's cells re-read on grid:refresh: their
      // coordinates would alias active-sheet cells).
      if (place.target) window.dispatchEvent(new CustomEvent("grid:refresh"));
      for (const cell of place.target ? [] : result.updatedCells) {
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
      // The backend refuses the WHOLE gesture rather than partially replacing,
      // so nothing changed — say so, and pass its message through verbatim
      // because it names the writeback region and the way out.
      setErrorText(String(error instanceof Error ? error.message : error));
    }
  }, [searchValue, replaceValue, options.caseSensitive, options.matchEntireCell, setMatches, replaceTarget]);

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
    <S.Overlay onKeyDown={handleKeyDown}>
      <S.DialogContainer ref={win.ref} style={{ position: "relative", ...win.style }}>
        {/* Header — drag handle */}
        <S.Header onMouseDown={win.onHeaderMouseDown}>
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
            onChange={(e) => {
              // A new query supersedes the previous refusal.
              setErrorText(null);
              setSearchValue(e.target.value);
            }}
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

        {/* Status row. A refusal outranks the match count: the user just asked
            for a change that did NOT happen, and must be told why. */}
        <S.StatusRow>
          {errorText ? (
            <span role="alert" style={{ color: "#A80000" }}>
              {errorText}
            </span>
          ) : isSearching ? (
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
        {win.resizeHandles}
      </S.DialogContainer>
    </S.Overlay>
  );
}

export default FindReplaceDialog;