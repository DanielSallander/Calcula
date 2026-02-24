//! FILENAME: app/extensions/Sorting/components/SortDialog.tsx
// PURPOSE: Main Sort dialog component with multi-level sort configuration.
// CONTEXT: Opens via Data > Custom Sort menu. Allows hierarchical sort criteria.

import React, { useEffect, useCallback, useRef, useState } from "react";
import type { DialogProps } from "../../../src/api/uiTypes";
import { useGridState } from "../../../src/api";
import { sortRange } from "../../../src/api/lib";
import type { SortField } from "../../../src/api/lib";
import type { SortRangeResult } from "../../../src/core/types";
import { useSortStore } from "../hooks/useSortState";
import {
  detectSortRange,
  getColumnDisplayNames,
  getRowDisplayNames,
} from "../lib/sortHelpers";
import { MAX_SORT_LEVELS } from "../types";
import { SortLevelRow } from "./SortLevelRow";
import { SortOptionsPopup } from "./SortOptionsPopup";
import * as S from "./SortDialog.styles";

// ============================================================================
// Component
// ============================================================================

export function SortDialog(props: DialogProps): React.ReactElement | null {
  const { onClose } = props;
  const dialogRef = useRef<HTMLDivElement>(null);

  const gridState = useGridState();
  const selection = gridState.selection;

  const store = useSortStore();
  const {
    levels,
    hasHeaders,
    caseSensitive,
    orientation,
    rangeStartRow,
    rangeStartCol,
    rangeEndRow,
    rangeEndCol,
    columnHeaders,
    selectedLevelId,
    addLevel,
    deleteLevel,
    copyLevel,
    moveLevelUp,
    moveLevelDown,
    selectLevel,
    setHasHeaders,
    setCaseSensitive,
    setOrientation,
    setColumnHeaders,
    initialize,
  } = store;

  const [error, setError] = useState<string | null>(null);
  const [showOptions, setShowOptions] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // ---- Initialize on mount ----
  useEffect(() => {
    async function init() {
      try {
        setIsLoading(true);
        const range = await detectSortRange(selection);
        if (!range) {
          setError("No data found in the selected range.");
          setIsLoading(false);
          return;
        }

        // Default: assume headers if range has more than one row
        const defaultHasHeaders = range.endRow > range.startRow;

        const headers = await getColumnDisplayNames(
          range.startRow,
          range.startCol,
          range.endCol,
          defaultHasHeaders,
        );

        initialize(
          range.startRow,
          range.startCol,
          range.endRow,
          range.endCol,
          headers,
          defaultHasHeaders,
        );

        setError(null);
      } catch (err) {
        setError(`Failed to detect data range: ${err}`);
      } finally {
        setIsLoading(false);
      }
    }

    init();
    // Only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Refresh column headers when hasHeaders or orientation changes ----
  useEffect(() => {
    if (isLoading || rangeEndRow === 0) return;

    async function refreshHeaders() {
      try {
        if (orientation === "columns") {
          const names = await getRowDisplayNames(
            rangeStartRow,
            rangeEndRow,
            rangeStartCol,
            hasHeaders,
          );
          setColumnHeaders(names);
        } else {
          const names = await getColumnDisplayNames(
            rangeStartRow,
            rangeStartCol,
            rangeEndCol,
            hasHeaders,
          );
          setColumnHeaders(names);
        }
      } catch {
        // Keep existing headers on error
      }
    }

    refreshHeaders();
  }, [hasHeaders, orientation, isLoading, rangeStartRow, rangeStartCol, rangeEndRow, rangeEndCol, setColumnHeaders]);

  // ---- Keyboard handling ----
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "Enter" && !showOptions) {
        e.stopPropagation();
        handleApply();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, showOptions, levels, caseSensitive, hasHeaders, orientation]);

  // ---- Apply sort ----
  const handleApply = useCallback(async () => {
    if (levels.length === 0) {
      setError("At least one sort level is required.");
      return;
    }

    try {
      setError(null);

      // Convert SortLevel[] to SortField[]
      const fields: SortField[] = levels.map((level) => ({
        key: level.columnKey,
        ascending: level.ascending,
        sortOn: level.sortOn,
        color: level.color,
        dataOption: level.dataOption,
      }));

      const result = await sortRange<SortRangeResult>(
        rangeStartRow,
        rangeStartCol,
        rangeEndRow,
        rangeEndCol,
        fields,
        {
          matchCase: caseSensitive,
          hasHeaders,
          orientation,
        },
      );

      if (!result.success) {
        setError(result.error || "Sort failed.");
        return;
      }

      // Refresh grid
      window.dispatchEvent(new CustomEvent("grid:refresh"));

      onClose();
    } catch (err) {
      setError(`Sort failed: ${err}`);
    }
  }, [levels, rangeStartRow, rangeStartCol, rangeEndRow, rangeEndCol, caseSensitive, hasHeaders, orientation, onClose]);

  // ---- Toolbar handlers ----
  const handleAddLevel = useCallback(() => {
    if (levels.length < MAX_SORT_LEVELS) {
      addLevel();
    }
  }, [levels.length, addLevel]);

  const handleDeleteLevel = useCallback(() => {
    if (selectedLevelId && levels.length > 1) {
      deleteLevel(selectedLevelId);
    }
  }, [selectedLevelId, levels.length, deleteLevel]);

  const handleCopyLevel = useCallback(() => {
    if (selectedLevelId && levels.length < MAX_SORT_LEVELS) {
      copyLevel(selectedLevelId);
    }
  }, [selectedLevelId, levels.length, copyLevel]);

  const handleMoveUp = useCallback(() => {
    if (selectedLevelId) {
      moveLevelUp(selectedLevelId);
    }
  }, [selectedLevelId, moveLevelUp]);

  const handleMoveDown = useCallback(() => {
    if (selectedLevelId) {
      moveLevelDown(selectedLevelId);
    }
  }, [selectedLevelId, moveLevelDown]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose],
  );

  // ---- Derived state ----
  const selectedIdx = selectedLevelId
    ? levels.findIndex((l) => l.id === selectedLevelId)
    : -1;
  const canDelete = levels.length > 1 && selectedLevelId !== null;
  const canAdd = levels.length < MAX_SORT_LEVELS;
  const canMoveUp = selectedIdx > 0;
  const canMoveDown = selectedIdx >= 0 && selectedIdx < levels.length - 1;
  const canCopy = selectedLevelId !== null && levels.length < MAX_SORT_LEVELS;

  // ---- Orientation labels ----
  const columnLabel = orientation === "rows" ? "Column" : "Row";
  const sortOnLabel = "Sort On";
  const orderLabel = "Order";

  if (isLoading) {
    return (
      <S.Backdrop>
        <S.DialogContainer ref={dialogRef}>
          <S.Header>
            <S.Title>Sort</S.Title>
          </S.Header>
          <div style={{ padding: "24px 16px", textAlign: "center" }}>
            Detecting data range...
          </div>
        </S.DialogContainer>
      </S.Backdrop>
    );
  }

  return (
    <S.Backdrop onClick={handleBackdropClick}>
      <S.DialogContainer ref={dialogRef} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <S.Header>
          <S.Title>Sort</S.Title>
          <S.CloseButton onClick={onClose} title="Close">
            x
          </S.CloseButton>
        </S.Header>

        {/* Toolbar */}
        <S.Toolbar>
          <S.ToolbarButton onClick={handleAddLevel} $disabled={!canAdd}>
            Add Level
          </S.ToolbarButton>
          <S.ToolbarButton onClick={handleDeleteLevel} $disabled={!canDelete}>
            Delete Level
          </S.ToolbarButton>
          <S.ToolbarButton onClick={handleCopyLevel} $disabled={!canCopy}>
            Copy Level
          </S.ToolbarButton>
          <S.ToolbarSeparator />
          <S.ToolbarButton onClick={handleMoveUp} $disabled={!canMoveUp}>
            Move Up
          </S.ToolbarButton>
          <S.ToolbarButton onClick={handleMoveDown} $disabled={!canMoveDown}>
            Move Down
          </S.ToolbarButton>
          <S.ToolbarSeparator />
          <S.ToolbarButton onClick={() => setShowOptions(true)}>
            Options...
          </S.ToolbarButton>
        </S.Toolbar>

        {/* Column headers */}
        <S.ColumnLabelsRow>
          <S.ColumnLabel></S.ColumnLabel>
          <S.ColumnLabel>{columnLabel}</S.ColumnLabel>
          <S.ColumnLabel>{sortOnLabel}</S.ColumnLabel>
          <S.ColumnLabel>{orderLabel}</S.ColumnLabel>
        </S.ColumnLabelsRow>

        {/* Level list */}
        <S.LevelListContainer>
          {levels.map((level, index) => (
            <SortLevelRow
              key={level.id}
              level={level}
              index={index}
              isSelected={level.id === selectedLevelId}
            />
          ))}
        </S.LevelListContainer>

        {/* Error message */}
        {error && <S.ErrorMessage>{error}</S.ErrorMessage>}

        {/* Options bar */}
        <S.OptionsBar>
          <S.Checkbox>
            <input
              type="checkbox"
              checked={hasHeaders}
              onChange={(e) => setHasHeaders(e.target.checked)}
            />
            My data has headers
          </S.Checkbox>
        </S.OptionsBar>

        {/* Footer */}
        <S.Footer>
          <S.Button onClick={onClose}>Cancel</S.Button>
          <S.Button $primary onClick={handleApply}>
            OK
          </S.Button>
        </S.Footer>

        {/* Options popup */}
        {showOptions && (
          <SortOptionsPopup
            caseSensitive={caseSensitive}
            orientation={orientation}
            onCaseSensitiveChange={setCaseSensitive}
            onOrientationChange={setOrientation}
            onClose={() => setShowOptions(false)}
          />
        )}
      </S.DialogContainer>
    </S.Backdrop>
  );
}
