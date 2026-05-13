//! FILENAME: app/extensions/Charts/components/ChartFilterDropdown.tsx
// PURPOSE: Dropdown for toggling series and category visibility on a chart.
// CONTEXT: Rendered inline in the ChartDesignTab ribbon. Shows checkboxes for
//          each series and category, with Select All / Deselect All controls.

import React, { useState, useRef, useEffect, useCallback } from "react";
import { css } from "@emotion/css";
import type { ChartFilters, ParsedChartData, ChartSpec } from "../types";

// ============================================================================
// Styles
// ============================================================================

const styles = {
  container: css`
    position: relative;
    display: inline-block;
  `,
  trigger: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 4px 8px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
    color: #333;
    white-space: nowrap;
    min-width: 50px;

    &:hover {
      background: #e8e8e8;
      border-color: #d0d0d0;
    }
  `,
  triggerActive: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 4px 8px;
    background: #d6e4f0;
    border: 1px solid #a0c0e0;
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
    color: #1a1a1a;
    white-space: nowrap;
    min-width: 50px;

    &:hover {
      background: #c0d8ec;
    }
  `,
  triggerIcon: css`
    font-size: 16px;
    line-height: 1;
  `,
  badge: css`
    display: inline-block;
    background: #005fb8;
    color: #fff;
    font-size: 9px;
    border-radius: 6px;
    padding: 0 4px;
    min-width: 14px;
    text-align: center;
    margin-left: 2px;
  `,
  dropdown: css`
    position: fixed;
    z-index: 10000;
    background: #fff;
    border: 1px solid #ccc;
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    min-width: 200px;
    max-height: 320px;
    overflow-y: auto;
    padding: 4px 0;
    font-size: 12px;
    font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
  `,
  section: css`
    padding: 4px 12px;
  `,
  sectionTitle: css`
    font-weight: 600;
    font-size: 11px;
    color: #555;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    margin-bottom: 2px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  `,
  selectAll: css`
    font-size: 10px;
    color: #005fb8;
    cursor: pointer;
    font-weight: normal;
    text-transform: none;
    letter-spacing: normal;

    &:hover {
      text-decoration: underline;
    }
  `,
  divider: css`
    border-top: 1px solid #e8e8e8;
    margin: 4px 0;
  `,
  item: css`
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 12px;
    cursor: pointer;
    white-space: nowrap;

    &:hover {
      background: #f0f0f0;
    }

    input {
      cursor: pointer;
      margin: 0;
    }

    label {
      cursor: pointer;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `,
  colorSwatch: css`
    width: 10px;
    height: 10px;
    border-radius: 2px;
    flex-shrink: 0;
  `,
};

// ============================================================================
// Props
// ============================================================================

interface ChartFilterDropdownProps {
  spec: ChartSpec;
  unfilteredData: ParsedChartData | undefined;
  onFiltersChange: (filters: ChartFilters) => void;
}

// ============================================================================
// Component
// ============================================================================

export function ChartFilterDropdown({
  spec,
  unfilteredData,
  onFiltersChange,
}: ChartFilterDropdownProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number } | null>(null);

  const filters = spec.filters ?? { hiddenSeries: [], hiddenCategories: [] };
  const hiddenSeriesSet = new Set(filters.hiddenSeries ?? []);
  const hiddenCategoriesSet = new Set(filters.hiddenCategories ?? []);

  const totalHidden = hiddenSeriesSet.size + hiddenCategoriesSet.size;
  const isFiltered = totalHidden > 0;

  const allSeries = unfilteredData?.series ?? [];
  const allCategories = unfilteredData?.categories ?? [];

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick, true);
    return () => document.removeEventListener("mousedown", handleClick, true);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handleKey, true);
    return () => document.removeEventListener("keydown", handleKey, true);
  }, [open]);

  const toggleSeries = useCallback(
    (index: number) => {
      const newHidden = new Set(hiddenSeriesSet);
      if (newHidden.has(index)) {
        newHidden.delete(index);
      } else {
        newHidden.add(index);
      }
      onFiltersChange({
        hiddenSeries: Array.from(newHidden),
        hiddenCategories: filters.hiddenCategories ?? [],
      });
    },
    [hiddenSeriesSet, filters.hiddenCategories, onFiltersChange],
  );

  const toggleCategory = useCallback(
    (index: number) => {
      const newHidden = new Set(hiddenCategoriesSet);
      if (newHidden.has(index)) {
        newHidden.delete(index);
      } else {
        newHidden.add(index);
      }
      onFiltersChange({
        hiddenSeries: filters.hiddenSeries ?? [],
        hiddenCategories: Array.from(newHidden),
      });
    },
    [hiddenCategoriesSet, filters.hiddenSeries, onFiltersChange],
  );

  const selectAllSeries = useCallback(() => {
    onFiltersChange({
      hiddenSeries: [],
      hiddenCategories: filters.hiddenCategories ?? [],
    });
  }, [filters.hiddenCategories, onFiltersChange]);

  const selectAllCategories = useCallback(() => {
    onFiltersChange({
      hiddenSeries: filters.hiddenSeries ?? [],
      hiddenCategories: [],
    });
  }, [filters.hiddenSeries, onFiltersChange]);

  const clearAllFilters = useCallback(() => {
    onFiltersChange({ hiddenSeries: [], hiddenCategories: [] });
  }, [onFiltersChange]);

  return (
    <div ref={containerRef} className={styles.container}>
      <button
        ref={triggerRef}
        className={isFiltered ? styles.triggerActive : styles.trigger}
        onClick={() => {
          if (!open && triggerRef.current) {
            const rect = triggerRef.current.getBoundingClientRect();
            setDropdownPos({ top: rect.bottom + 2, left: rect.left });
          }
          setOpen(!open);
        }}
        title="Filter chart series and categories"
      >
        <span className={styles.triggerIcon}>&#9661;</span>
        Filter
        {isFiltered && <span className={styles.badge}>{totalHidden}</span>}
      </button>

      {open && dropdownPos && (
        <div className={styles.dropdown} style={{ top: dropdownPos.top, left: dropdownPos.left }}>
          {/* Series Section */}
          {allSeries.length > 0 && (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>
                <span>Series</span>
                {hiddenSeriesSet.size > 0 && (
                  <span className={styles.selectAll} onClick={selectAllSeries}>
                    Show All
                  </span>
                )}
              </div>
              {allSeries.map((series, i) => (
                <div key={`s-${i}`} className={styles.item} onClick={() => toggleSeries(i)}>
                  <input
                    type="checkbox"
                    checked={!hiddenSeriesSet.has(i)}
                    onChange={() => toggleSeries(i)}
                  />
                  {series.color && (
                    <span
                      className={styles.colorSwatch}
                      style={{ backgroundColor: series.color }}
                    />
                  )}
                  <label>{series.name || `Series ${i + 1}`}</label>
                </div>
              ))}
            </div>
          )}

          {/* Divider */}
          {allSeries.length > 0 && allCategories.length > 0 && (
            <div className={styles.divider} />
          )}

          {/* Categories Section */}
          {allCategories.length > 0 && allCategories.length <= 50 && (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>
                <span>Categories</span>
                {hiddenCategoriesSet.size > 0 && (
                  <span className={styles.selectAll} onClick={selectAllCategories}>
                    Show All
                  </span>
                )}
              </div>
              {allCategories.map((cat, i) => (
                <div key={`c-${i}`} className={styles.item} onClick={() => toggleCategory(i)}>
                  <input
                    type="checkbox"
                    checked={!hiddenCategoriesSet.has(i)}
                    onChange={() => toggleCategory(i)}
                  />
                  <label>{cat || `(empty)`}</label>
                </div>
              ))}
            </div>
          )}

          {/* Clear All */}
          {isFiltered && (
            <>
              <div className={styles.divider} />
              <div className={styles.section}>
                <span
                  className={styles.selectAll}
                  onClick={clearAllFilters}
                  style={{ fontSize: 11, fontWeight: 600 }}
                >
                  Clear All Filters
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
