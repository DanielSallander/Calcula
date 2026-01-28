//! FILENAME: app/src/core/components/pivot/PivotFilterOverlay.tsx
// PURPOSE: Overlay component that renders filter dropdowns within the pivot table area
// CONTEXT: Positioned absolutely over the grid canvas to show filters above the pivot data

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { css } from '@emotion/css';
import { FilterDropdown } from './FilterDropdown';
import { getPivotFieldUniqueValues, updatePivotFields } from '../../lib/pivot-api';
import type { ZoneField, PivotId } from './types';
import type { PivotRegionData } from '../../types';

// Styles
const styles = {
  overlay: css`
    position: absolute;
    pointer-events: none;
    z-index: 10;
  `,
  filterRow: css`
    position: absolute;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 4px 8px;
    background: linear-gradient(to bottom, #f8f9fa, #e9ecef);
    border-bottom: 1px solid #dee2e6;
    pointer-events: auto;
  `,
  filterButton: css`
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: #ffffff;
    border: 1px solid #ced4da;
    border-radius: 4px;
    font-size: 11px;
    cursor: pointer;
    user-select: none;
    white-space: nowrap;

    &:hover {
      background: #e9ecef;
      border-color: #adb5bd;
    }

    &.active {
      background: #e7f1ff;
      border-color: #0d6efd;
    }

    &.filtered {
      background: #fff3cd;
      border-color: #ffc107;
    }
  `,
  filterLabel: css`
    font-weight: 500;
    color: #495057;
  `,
  filterValue: css`
    color: #6c757d;
    max-width: 100px;
    overflow: hidden;
    text-overflow: ellipsis;
  `,
  dropdownIcon: css`
    font-size: 8px;
    color: #6c757d;
  `,
  dropdownContainer: css`
    position: absolute;
    z-index: 100;
    pointer-events: auto;
  `,
};

interface FilterState {
  field: ZoneField;
  uniqueValues: string[];
  selectedValues: string[];
  isLoading: boolean;
}

interface PivotFilterOverlayProps {
  /** Cached pivot regions from the grid */
  pivotRegions: PivotRegionData[];
  /** Grid viewport scroll position */
  scrollX: number;
  scrollY: number;
  /** Grid configuration for positioning */
  rowHeaderWidth: number;
  colHeaderHeight: number;
  /** Column widths for calculating positions */
  getColumnWidth: (col: number) => number;
  /** Row heights for calculating positions */
  getRowHeight: (row: number) => number;
}

export function PivotFilterOverlay({
  pivotRegions,
  scrollX,
  scrollY,
  rowHeaderWidth,
  colHeaderHeight,
  getColumnWidth,
  getRowHeight,
}: PivotFilterOverlayProps): React.ReactElement | null {
  const [activePivotId, setActivePivotId] = useState<PivotId | null>(null);
  const [filterStates, setFilterStates] = useState<FilterState[]>([]);
  const [openDropdownIndex, setOpenDropdownIndex] = useState<number | null>(null);
  const [dropdownPosition, setDropdownPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Listen for filter fields changes from PivotEditor
  useEffect(() => {
    const handleFilterFieldsChange = async (event: Event) => {
      const customEvent = event as CustomEvent<{
        pivotId: PivotId;
        filterFields: ZoneField[];
      }>;
      const { pivotId, filterFields } = customEvent.detail;

      console.log('[PivotFilterOverlay] Received filter fields change:', { pivotId, filterFieldsCount: filterFields.length });

      setActivePivotId(pivotId);
      setOpenDropdownIndex(null);

      if (filterFields.length === 0) {
        setFilterStates([]);
        return;
      }

      // Initialize filter states with loading state
      const initialStates: FilterState[] = filterFields.map((field) => ({
        field,
        uniqueValues: [],
        selectedValues: [],
        isLoading: true,
      }));
      setFilterStates(initialStates);

      // Fetch unique values for each filter field
      const updatedStates = await Promise.all(
        filterFields.map(async (field) => {
          try {
            console.log('[PivotFilterOverlay] Fetching unique values for field:', field.name);
            const response = await getPivotFieldUniqueValues(pivotId, field.sourceIndex);
            console.log('[PivotFilterOverlay] Got unique values:', response);
            return {
              field,
              uniqueValues: response.unique_values,
              selectedValues: field.hiddenItems
                ? response.unique_values.filter((v: string) => !field.hiddenItems!.includes(v))
                : [...response.unique_values],
              isLoading: false,
            };
          } catch (error) {
            console.error(`[PivotFilterOverlay] Failed to get unique values for field ${field.name}:`, error);
            // Even if API fails, show the filter button with empty values
            return {
              field,
              uniqueValues: ['(API not available)'],
              selectedValues: ['(API not available)'],
              isLoading: false,
            };
          }
        })
      );

      setFilterStates(updatedStates);
    };

    window.addEventListener('pivot:filterFieldsChanged', handleFilterFieldsChange);
    return () => {
      window.removeEventListener('pivot:filterFieldsChanged', handleFilterFieldsChange);
    };
  }, []);

  // Handle filter button click
  const handleFilterButtonClick = useCallback(
    (index: number, event: React.MouseEvent<HTMLButtonElement>) => {
      if (openDropdownIndex === index) {
        setOpenDropdownIndex(null);
      } else {
        const button = event.currentTarget;
        const rect = button.getBoundingClientRect();
        setOpenDropdownIndex(index);
        setDropdownPosition({
          x: rect.left,
          y: rect.bottom + 2,
        });
      }
    },
    [openDropdownIndex]
  );

  // Handle filter value change
  const handleFilterChange = useCallback((index: number, selectedValues: string[]) => {
    setFilterStates((prev) =>
      prev.map((fs, i) => (i === index ? { ...fs, selectedValues } : fs))
    );
  }, []);

  // Apply filter to pivot
  const handleApplyFilter = useCallback(
    async (index: number) => {
      if (activePivotId === null) return;

      const filterState = filterStates[index];
      const hiddenItems = filterState.uniqueValues.filter(
        (v) => !filterState.selectedValues.includes(v)
      );

      try {
        // Build filter field configs for all filters
        const filterFieldConfigs = filterStates.map((fs) => {
          const hidden = fs.uniqueValues.filter((v) => !fs.selectedValues.includes(v));
          return {
            source_index: fs.field.sourceIndex,
            name: fs.field.name,
            hidden_items: hidden.length > 0 ? hidden : undefined,
          };
        });

        await updatePivotFields({
          pivot_id: activePivotId,
          filter_fields: filterFieldConfigs,
        });

        // Dispatch event to notify that the pivot needs to be refreshed
        window.dispatchEvent(
          new CustomEvent('pivot:refresh', { detail: { pivotId: activePivotId } })
        );

        setOpenDropdownIndex(null);
      } catch (error) {
        console.error('[PivotFilterOverlay] Failed to apply filter:', error);
      }
    },
    [activePivotId, filterStates]
  );

  // Close dropdown
  const handleCloseDropdown = useCallback(() => {
    setOpenDropdownIndex(null);
  }, []);

  // Debug logging
  console.log('[PivotFilterOverlay] Render check:', {
    filterStatesLength: filterStates.length,
    activePivotId,
    pivotRegionsCount: pivotRegions.length,
    pivotRegions: pivotRegions.map(r => ({ id: r.pivotId, start: `${r.startRow},${r.startCol}` })),
  });

  // Don't render if no filters
  if (filterStates.length === 0 || activePivotId === null) {
    console.log('[PivotFilterOverlay] Not rendering: no filters or no active pivot');
    return null;
  }

  // Find the pivot region for positioning
  const pivotRegion = pivotRegions.find((r) => r.pivotId === activePivotId);
  if (!pivotRegion) {
    console.log('[PivotFilterOverlay] Not rendering: pivot region not found for id', activePivotId);
    return null;
  }

  console.log('[PivotFilterOverlay] Found pivot region:', pivotRegion);

  // Calculate position based on pivot region
  let x = rowHeaderWidth;
  for (let col = 0; col < pivotRegion.startCol; col++) {
    x += getColumnWidth(col);
  }
  x -= scrollX;

  let y = colHeaderHeight;
  for (let row = 0; row < pivotRegion.startRow; row++) {
    y += getRowHeight(row);
  }
  y -= scrollY;

  // Calculate width of the pivot region
  let width = 0;
  for (let col = pivotRegion.startCol; col <= pivotRegion.endCol; col++) {
    width += getColumnWidth(col);
  }

  // Filter row height
  const filterRowHeight = 32;

  console.log('[PivotFilterOverlay] Calculated position:', { x, y, width, filterRowHeight });

  // Get display value for a filter
  const getFilterDisplayValue = (state: FilterState): string => {
    if (state.isLoading) return 'Loading...';
    const hiddenCount = state.uniqueValues.length - state.selectedValues.length;
    if (hiddenCount === 0) return '(All)';
    if (state.selectedValues.length === 1) return state.selectedValues[0];
    if (state.selectedValues.length === 0) return '(None)';
    return `(${state.selectedValues.length} selected)`;
  };

  const isFiltered = (state: FilterState): boolean => {
    return state.uniqueValues.length !== state.selectedValues.length;
  };

  return (
    <>
      {/* Filter Row - positioned at the top of the pivot table area */}
      <div
        className={styles.filterRow}
        style={{
          left: x,
          top: y, // Position at the pivot start, not above it
          width: Math.max(width, 200), // Minimum width to ensure visibility
          minHeight: filterRowHeight,
        }}
      >
        {filterStates.map((state, index) => (
          <button
            key={`filter-${state.field.sourceIndex}`}
            ref={(el) => (buttonRefs.current[index] = el)}
            data-filter-button
            className={`${styles.filterButton} ${openDropdownIndex === index ? 'active' : ''} ${isFiltered(state) ? 'filtered' : ''}`}
            onClick={(e) => handleFilterButtonClick(index, e)}
            disabled={state.isLoading}
          >
            <span className={styles.filterLabel}>{state.field.name}:</span>
            <span className={styles.filterValue}>{getFilterDisplayValue(state)}</span>
            <span className={styles.dropdownIcon}>▼</span>
          </button>
        ))}
      </div>

      {/* Filter Dropdown */}
      {openDropdownIndex !== null && filterStates[openDropdownIndex] && (
        <FilterDropdown
          fieldName={filterStates[openDropdownIndex].field.name}
          uniqueValues={filterStates[openDropdownIndex].uniqueValues}
          selectedValues={filterStates[openDropdownIndex].selectedValues}
          onSelectionChange={(values) => handleFilterChange(openDropdownIndex, values)}
          onApply={() => handleApplyFilter(openDropdownIndex)}
          onCancel={handleCloseDropdown}
          position={dropdownPosition}
        />
      )}
    </>
  );
}