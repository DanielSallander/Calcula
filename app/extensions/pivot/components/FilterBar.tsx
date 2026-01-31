//! FILENAME: app/src/core/components/pivot/FilterBar.tsx
// PURPOSE: Bar component displaying active filters above the pivot table
// CONTEXT: Shows filter chips that can be clicked to open filter dropdowns

import React, { useState, useCallback } from "react";
import { css } from "@emotion/css";
import { FilterDropdown } from "./FilterDropdown";
import type { ZoneField } from "./types";

export interface FilterFieldState {
  field: ZoneField;
  uniqueValues: string[];
  selectedValues: string[];
}

export interface FilterBarProps {
  /** Filter fields with their current state */
  filters: FilterFieldState[];
  /** Callback when a filter selection changes */
  onFilterChange: (
    fieldIndex: number,
    selectedValues: string[]
  ) => void;
  /** Callback when filters are applied */
  onApplyFilters: () => void;
}

const barStyles = {
  container: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 8px 12px;
    background: #f8f9fa;
    border-bottom: 1px solid #e0e0e0;
    min-height: 40px;
    align-items: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      sans-serif;
  `,
  label: css`
    font-size: 11px;
    font-weight: 600;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-right: 4px;
  `,
  filterChip: css`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: #fff;
    border: 1px solid #d0d0d0;
    border-radius: 16px;
    font-size: 12px;
    color: #333;
    cursor: pointer;
    transition: all 0.15s;

    &:hover {
      background: #f0f0f0;
      border-color: #999;
    }

    &.active {
      background: #e8f4fc;
      border-color: #0078d4;
      color: #0078d4;
    }

    &.filtered {
      background: #fff3e0;
      border-color: #ff9800;
    }
  `,
  chipLabel: css`
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  chipArrow: css`
    font-size: 8px;
    color: #888;
  `,
  chipCount: css`
    font-size: 10px;
    background: #0078d4;
    color: #fff;
    padding: 1px 5px;
    border-radius: 10px;
    min-width: 14px;
    text-align: center;
  `,
  noFilters: css`
    font-size: 12px;
    color: #888;
    font-style: italic;
  `,
};

export function FilterBar({
  filters,
  onFilterChange,
  onApplyFilters,
}: FilterBarProps): React.ReactElement | null {
  const [openFilterIndex, setOpenFilterIndex] = useState<number | null>(null);
  const [dropdownPosition, setDropdownPosition] = useState({ x: 0, y: 0 });
  const [pendingSelection, setPendingSelection] = useState<string[] | null>(null);

  const handleChipClick = useCallback(
    (index: number, event: React.MouseEvent<HTMLButtonElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      setDropdownPosition({
        x: rect.left,
        y: rect.bottom + 4,
      });
      setPendingSelection(filters[index].selectedValues);
      setOpenFilterIndex(index);
    },
    [filters]
  );

  const handleApply = useCallback(async (_fieldIndex: number, _selectedValues: string[], _hiddenItems: string[]) => {
    if (openFilterIndex !== null && pendingSelection !== null) {
      onFilterChange(openFilterIndex, pendingSelection);
      onApplyFilters();
    }
    setOpenFilterIndex(null);
    setPendingSelection(null);
  }, [openFilterIndex, pendingSelection, onFilterChange, onApplyFilters]);

  const handleCancel = useCallback(() => {
    setOpenFilterIndex(null);
    setPendingSelection(null);
  }, []);

  // Don't render if no filters
  if (filters.length === 0) {
    return null;
  }

  return (
    <div className={barStyles.container}>
      <span className={barStyles.label}>Filters:</span>

      {filters.map((filter, index) => {
        const isFiltered =
          filter.selectedValues.length < filter.uniqueValues.length;
        const isOpen = openFilterIndex === index;
        const hiddenCount =
          filter.uniqueValues.length - filter.selectedValues.length;

        return (
          <button
            key={filter.field.sourceIndex}
            className={`${barStyles.filterChip} ${isOpen ? "active" : ""} ${
              isFiltered ? "filtered" : ""
            }`}
            onClick={(e) => handleChipClick(index, e)}
          >
            <span className={barStyles.chipLabel}>{filter.field.name}</span>
            {isFiltered && (
              <span className={barStyles.chipCount}>{hiddenCount}</span>
            )}
            <span className={barStyles.chipArrow}>
              {isOpen ? "\u25B2" : "\u25BC"}
            </span>
          </button>
        );
      })}

      {openFilterIndex !== null && pendingSelection !== null && (
        <FilterDropdown
          fieldName={filters[openFilterIndex].field.name}
          fieldIndex={filters[openFilterIndex].field.sourceIndex}
          uniqueValues={filters[openFilterIndex].uniqueValues}
          selectedValues={pendingSelection}
          anchorRect={{ x: dropdownPosition.x, y: dropdownPosition.y, width: 0, height: 0 }}
          onApply={handleApply}
          onClose={handleCancel}
        />
      )}
    </div>
  );
}
