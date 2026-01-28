//! FILENAME: app/src/core/components/pivot/FilterDropdown.tsx
// PURPOSE: Dropdown component for filtering pivot table values
// CONTEXT: Shows checkbox list of unique values for a field with search

import React, { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { css } from "@emotion/css";

export interface FilterDropdownProps {
  /** Field name being filtered */
  fieldName: string;
  /** All unique values available for filtering */
  uniqueValues: string[];
  /** Currently selected (visible) values */
  selectedValues: string[];
  /** Callback when selection changes */
  onSelectionChange: (selectedValues: string[]) => void;
  /** Callback to apply the filter */
  onApply: () => void;
  /** Callback to cancel */
  onCancel: () => void;
  /** Position for the dropdown */
  position: { x: number; y: number };
}

const filterStyles = {
  overlay: css`
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 9999;
  `,
  container: css`
    position: fixed;
    background: #fff;
    border: 1px solid #d0d0d0;
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
    z-index: 10000;
    min-width: 240px;
    max-width: 320px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      sans-serif;
    font-size: 13px;
    display: flex;
    flex-direction: column;
    max-height: 400px;
  `,
  header: css`
    padding: 12px 14px;
    border-bottom: 1px solid #e0e0e0;
    font-weight: 600;
    color: #333;
    font-size: 13px;
  `,
  searchContainer: css`
    padding: 10px 14px;
    border-bottom: 1px solid #e0e0e0;
  `,
  searchInput: css`
    width: 100%;
    padding: 8px 10px;
    border: 1px solid #d0d0d0;
    border-radius: 4px;
    font-size: 12px;
    box-sizing: border-box;

    &:focus {
      outline: none;
      border-color: #0078d4;
      box-shadow: 0 0 0 2px rgba(0, 120, 212, 0.2);
    }

    &::placeholder {
      color: #999;
    }
  `,
  listContainer: css`
    flex: 1;
    overflow-y: auto;
    max-height: 240px;
    padding: 4px 0;
  `,
  selectAllRow: css`
    display: flex;
    align-items: center;
    padding: 8px 14px;
    cursor: pointer;
    border-bottom: 1px solid #f0f0f0;
    font-weight: 500;

    &:hover {
      background: #f5f5f5;
    }
  `,
  itemRow: css`
    display: flex;
    align-items: center;
    padding: 6px 14px;
    cursor: pointer;

    &:hover {
      background: #f5f5f5;
    }
  `,
  checkbox: css`
    margin-right: 10px;
    accent-color: #0078d4;
    width: 16px;
    height: 16px;
    cursor: pointer;
  `,
  itemLabel: css`
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #333;
  `,
  emptyLabel: css`
    color: #888;
    font-style: italic;
  `,
  noResults: css`
    padding: 20px 14px;
    text-align: center;
    color: #888;
    font-size: 12px;
  `,
  footer: css`
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 14px;
    border-top: 1px solid #e0e0e0;
    background: #f9f9f9;
    border-radius: 0 0 6px 6px;
  `,
  button: css`
    padding: 6px 14px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  `,
  cancelButton: css`
    background: #fff;
    border: 1px solid #d0d0d0;
    color: #333;

    &:hover {
      background: #f5f5f5;
    }
  `,
  applyButton: css`
    background: #0078d4;
    border: 1px solid #0078d4;
    color: #fff;

    &:hover {
      background: #106ebe;
    }
  `,
  countInfo: css`
    flex: 1;
    font-size: 11px;
    color: #888;
  `,
};

export function FilterDropdown({
  fieldName,
  uniqueValues,
  selectedValues,
  onSelectionChange,
  onApply,
  onCancel,
  position,
}: FilterDropdownProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [searchText, setSearchText] = useState("");

  // Filter values based on search
  const filteredValues = useMemo(() => {
    if (!searchText.trim()) return uniqueValues;
    const search = searchText.toLowerCase();
    return uniqueValues.filter((v) =>
      (v || "(Blank)").toLowerCase().includes(search)
    );
  }, [uniqueValues, searchText]);

  // Check states
  const allSelected = selectedValues.length === uniqueValues.length;
  const noneSelected = selectedValues.length === 0;

  const handleSelectAll = useCallback(() => {
    if (allSelected) {
      onSelectionChange([]);
    } else {
      onSelectionChange([...uniqueValues]);
    }
  }, [allSelected, uniqueValues, onSelectionChange]);

  const handleToggleValue = useCallback(
    (value: string) => {
      if (selectedValues.includes(value)) {
        onSelectionChange(selectedValues.filter((v) => v !== value));
      } else {
        onSelectionChange([...selectedValues, value]);
      }
    },
    [selectedValues, onSelectionChange]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
      } else if (event.key === "Enter") {
        onApply();
      }
    },
    [onCancel, onApply]
  );

  // Adjust position to keep in viewport
  const adjustedPosition = {
    x: Math.min(position.x, window.innerWidth - 260),
    y: Math.min(position.y, window.innerHeight - 420),
  };

  return (
    <>
      <div className={filterStyles.overlay} onClick={onCancel} />
      <div
        ref={containerRef}
        className={filterStyles.container}
        style={{
          left: adjustedPosition.x,
          top: adjustedPosition.y,
        }}
        onKeyDown={handleKeyDown}
      >
        <div className={filterStyles.header}>Filter: {fieldName}</div>

        <div className={filterStyles.searchContainer}>
          <input
            type="text"
            className={filterStyles.searchInput}
            placeholder="Search..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            autoFocus
          />
        </div>

        <div className={filterStyles.listContainer}>
          {!searchText && (
            <div className={filterStyles.selectAllRow} onClick={handleSelectAll}>
              <input
                type="checkbox"
                className={filterStyles.checkbox}
                checked={allSelected}
                ref={(el) => {
                  if (el) {
                    el.indeterminate = !allSelected && !noneSelected;
                  }
                }}
                onChange={handleSelectAll}
              />
              <span className={filterStyles.itemLabel}>(Select All)</span>
            </div>
          )}

          {filteredValues.length === 0 ? (
            <div className={filterStyles.noResults}>No matching values</div>
          ) : (
            filteredValues.map((value) => (
              <div
                key={value || "__blank__"}
                className={filterStyles.itemRow}
                onClick={() => handleToggleValue(value)}
              >
                <input
                  type="checkbox"
                  className={filterStyles.checkbox}
                  checked={selectedValues.includes(value)}
                  onChange={() => handleToggleValue(value)}
                />
                <span
                  className={`${filterStyles.itemLabel} ${
                    !value ? filterStyles.emptyLabel : ""
                  }`}
                >
                  {value || "(Blank)"}
                </span>
              </div>
            ))
          )}
        </div>

        <div className={filterStyles.footer}>
          <span className={filterStyles.countInfo}>
            {selectedValues.length} of {uniqueValues.length} selected
          </span>
          <button
            className={`${filterStyles.button} ${filterStyles.cancelButton}`}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className={`${filterStyles.button} ${filterStyles.applyButton}`}
            onClick={onApply}
          >
            Apply
          </button>
        </div>
      </div>
    </>
  );
}
