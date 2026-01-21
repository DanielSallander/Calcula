// FILENAME: app/src/core/components/FindReplaceDialog/FindReplaceDialog.tsx
// PURPOSE: Find and Replace dialog component
// CONTEXT: Provides UI for searching and replacing cell content

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useGridContext } from '../../state/GridContext';
import { 
  setFindResults, 
  setFindCurrentIndex, 
  closeFind, 
  setFindOptions,
  setSelection,
  scrollToCell 
} from '../../state/gridActions';
import { findAll, replaceAll, replaceSingle } from '../../lib/tauri-api';
import { cellEvents } from '../../lib/cellEvents';
import { columnToLetter } from '../../types/types';

export function FindReplaceDialog(): React.ReactElement | null {
  const { state, dispatch } = useGridContext();
  const { find } = state;
  
  const [searchValue, setSearchValue] = useState('');
  const [replaceValue, setReplaceValue] = useState('');
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
    if (find.isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
      searchInputRef.current.select();
    }
  }, [find.isOpen]);
  
  // Perform search
  const performSearch = useCallback(async (query: string, preserveIndex = false) => {
    if (!query.trim()) {
      dispatch(setFindResults([], ''));
      return;
    }
    
    setIsSearching(true);
    try {
      const result = await findAll(query, {
        caseSensitive: find.caseSensitive,
        matchEntireCell: find.matchEntireCell,
        searchFormulas: find.searchFormulas,
      });
      
      dispatch(setFindResults(result.matches, query));
      
      // Navigate to first match if any (unless preserving index for live updates)
      if (result.matches.length > 0 && !preserveIndex) {
        const [row, col] = result.matches[0];
        dispatch(setSelection(row, col, row, col, 'cells'));
        dispatch(scrollToCell(row, col, false));
      }
    } catch (error) {
      console.error('[FindReplaceDialog] Search failed:', error);
    } finally {
      setIsSearching(false);
    }
  }, [dispatch, find.caseSensitive, find.matchEntireCell, find.searchFormulas]);
  
  // Handle search input change with debounce
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchValue !== find.query) {
        performSearch(searchValue);
      }
    }, 300);
    
    return () => clearTimeout(timer);
  }, [searchValue, performSearch, find.query]);
  
  // Subscribe to cell change events for live search updates
  useEffect(() => {
    // Only subscribe when dialog is open and there's a search query
    if (!find.isOpen) {
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
  }, [find.isOpen, performSearch]);
  
  // Navigate to next match
  const handleFindNext = useCallback(() => {
    if (find.matches.length === 0) return;
    
    const nextIndex = (find.currentIndex + 1) % find.matches.length;
    dispatch(setFindCurrentIndex(nextIndex));
    
    const [row, col] = find.matches[nextIndex];
    dispatch(setSelection(row, col, row, col, 'cells'));
    dispatch(scrollToCell(row, col, false));
  }, [dispatch, find.matches, find.currentIndex]);
  
  // Navigate to previous match
  const handleFindPrevious = useCallback(() => {
    if (find.matches.length === 0) return;
    
    const prevIndex = find.currentIndex <= 0 
      ? find.matches.length - 1 
      : find.currentIndex - 1;
    dispatch(setFindCurrentIndex(prevIndex));
    
    const [row, col] = find.matches[prevIndex];
    dispatch(setSelection(row, col, row, col, 'cells'));
    dispatch(scrollToCell(row, col, false));
  }, [dispatch, find.matches, find.currentIndex]);
  
  // Replace current match
  const handleReplace = useCallback(async () => {
    if (find.currentIndex < 0 || find.currentIndex >= find.matches.length) return;
    
    const [row, col] = find.matches[find.currentIndex];
    
    try {
      const result = await replaceSingle(
        row, 
        col, 
        searchValue, 
        replaceValue, 
        find.caseSensitive
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
      console.error('[FindReplaceDialog] Replace failed:', error);
    }
  }, [find.currentIndex, find.matches, searchValue, replaceValue, find.caseSensitive, performSearch]);
  
  // Replace all matches
  const handleReplaceAll = useCallback(async () => {
    if (!searchValue.trim()) return;
    
    try {
      const result = await replaceAll(searchValue, replaceValue, {
        caseSensitive: find.caseSensitive,
        matchEntireCell: find.matchEntireCell,
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
      dispatch(setFindResults([], searchValue));
    } catch (error) {
      console.error('[FindReplaceDialog] Replace all failed:', error);
    }
  }, [searchValue, replaceValue, find.caseSensitive, find.matchEntireCell, dispatch]);
  
  // Handle close
  const handleClose = useCallback(() => {
    dispatch(closeFind());
    setSearchValue('');
    setReplaceValue('');
  }, [dispatch]);
  
  // Handle key down - stop propagation to prevent grid keyboard handler from intercepting
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Stop propagation for ALL keys to prevent grid keyboard handler from intercepting
    // This allows typing in the input fields without triggering grid navigation
    e.stopPropagation();
    
    if (e.key === 'Escape') {
      handleClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        handleFindPrevious();
      } else {
        handleFindNext();
      }
    } else if (e.key === 'F3') {
      e.preventDefault();
      if (e.shiftKey) {
        handleFindPrevious();
      } else {
        handleFindNext();
      }
    }
  }, [handleClose, handleFindNext, handleFindPrevious]);
  
  // Toggle options
  const toggleCaseSensitive = useCallback(() => {
    dispatch(setFindOptions({ caseSensitive: !find.caseSensitive }));
    if (searchValue) {
      performSearch(searchValue);
    }
  }, [dispatch, find.caseSensitive, searchValue, performSearch]);
  
  const toggleMatchEntireCell = useCallback(() => {
    dispatch(setFindOptions({ matchEntireCell: !find.matchEntireCell }));
    if (searchValue) {
      performSearch(searchValue);
    }
  }, [dispatch, find.matchEntireCell, searchValue, performSearch]);
  
  if (!find.isOpen) {
    return null;
  }
  
  const currentMatch = find.currentIndex >= 0 && find.matches.length > 0
    ? find.matches[find.currentIndex]
    : null;
  
  const currentMatchLabel = currentMatch
    ? `${columnToLetter(currentMatch[1])}${currentMatch[0] + 1}`
    : '';
  
  return (
    <div
      ref={dialogRef}
      style={styles.overlay}
      onKeyDown={handleKeyDown}
    >
      <div style={styles.dialog}>
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.title}>
            {find.showReplace ? 'Find and Replace' : 'Find'}
          </span>
          <button 
            style={styles.closeButton}
            onClick={handleClose}
            title="Close (Esc)"
          >
            X
          </button>
        </div>
        
        {/* Search row */}
        <div style={styles.row}>
          <label style={styles.label}>Find:</label>
          <input
            ref={searchInputRef}
            type="text"
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
            style={styles.input}
            placeholder="Search..."
          />
          <button 
            style={styles.button}
            onClick={handleFindPrevious}
            disabled={find.matches.length === 0}
            title="Find Previous (Shift+Enter)"
          >
            {'<'}
          </button>
          <button 
            style={styles.button}
            onClick={handleFindNext}
            disabled={find.matches.length === 0}
            title="Find Next (Enter)"
          >
            {'>'}
          </button>
        </div>
        
        {/* Replace row (if enabled) */}
        {find.showReplace && (
          <div style={styles.row}>
            <label style={styles.label}>Replace:</label>
            <input
              type="text"
              value={replaceValue}
              onChange={(e) => setReplaceValue(e.target.value)}
              style={styles.input}
              placeholder="Replace with..."
            />
            <button 
              style={styles.button}
              onClick={handleReplace}
              disabled={find.matches.length === 0}
              title="Replace current match"
            >
              Replace
            </button>
            <button 
              style={styles.button}
              onClick={handleReplaceAll}
              disabled={find.matches.length === 0}
              title="Replace all matches"
            >
              All
            </button>
          </div>
        )}
        
        {/* Options row */}
        <div style={styles.optionsRow}>
          <label style={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={find.caseSensitive}
              onChange={toggleCaseSensitive}
            />
            Match case
          </label>
          <label style={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={find.matchEntireCell}
              onChange={toggleMatchEntireCell}
            />
            Match entire cell
          </label>
        </div>
        
        {/* Status row */}
        <div style={styles.statusRow}>
          {isSearching ? (
            <span>Searching...</span>
          ) : find.matches.length > 0 ? (
            <span>
              {find.currentIndex + 1} of {find.matches.length} matches
              {currentMatchLabel && ` (${currentMatchLabel})`}
            </span>
          ) : searchValue ? (
            <span>No matches found</span>
          ) : (
            <span>Enter search text</span>
          )}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    top: 60,
    right: 20,
    zIndex: 1001,
  },
  dialog: {
    backgroundColor: '#252526',
    border: '1px solid #454545',
    borderRadius: '6px',
    padding: '12px',
    minWidth: '400px',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
    color: '#cccccc',
    fontFamily: 'Segoe UI, system-ui, sans-serif',
    fontSize: '13px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '12px',
    paddingBottom: '8px',
    borderBottom: '1px solid #454545',
  },
  title: {
    fontWeight: 600,
    fontSize: '14px',
  },
  closeButton: {
    backgroundColor: 'transparent',
    border: 'none',
    color: '#cccccc',
    cursor: 'pointer',
    padding: '4px 8px',
    borderRadius: '4px',
    fontSize: '12px',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginBottom: '8px',
  },
  label: {
    width: '60px',
    textAlign: 'right',
  },
  input: {
    flex: 1,
    padding: '6px 8px',
    backgroundColor: '#3c3c3c',
    border: '1px solid #555555',
    borderRadius: '4px',
    color: '#ffffff',
    fontSize: '13px',
    outline: 'none',
  },
  button: {
    padding: '6px 12px',
    backgroundColor: '#0e639c',
    border: 'none',
    borderRadius: '4px',
    color: '#ffffff',
    cursor: 'pointer',
    fontSize: '12px',
    minWidth: '50px',
  },
  optionsRow: {
    display: 'flex',
    gap: '16px',
    marginTop: '8px',
    marginBottom: '8px',
    paddingLeft: '68px',
  },
  checkboxLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    cursor: 'pointer',
    fontSize: '12px',
  },
  statusRow: {
    marginTop: '8px',
    paddingTop: '8px',
    borderTop: '1px solid #454545',
    fontSize: '12px',
    color: '#888888',
    textAlign: 'center',
  },
};

export default FindReplaceDialog;