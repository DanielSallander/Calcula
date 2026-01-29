//! FILENAME: app/src/core/components/pivot/SortDropdown.tsx
// PURPOSE: Dropdown component for sorting pivot table row/column fields
// CONTEXT: Provides A-Z, Z-A label sorting and sort by value options

import React, { useCallback, useState, useRef, useEffect } from "react";
import { css } from "@emotion/css";
import { type SortOrder, type ZoneField } from "./types";

export interface SortDropdownProps {
  /** Current sort order */
  currentSort: SortOrder;
  /** Available value fields for "sort by value" option */
  valueFields?: ZoneField[];
  /** Current "sort by value" field index (if any) */
  sortByValueIndex?: number;
  /** Callback when sort order changes */
  onSortChange: (sortOrder: SortOrder) => void;
  /** Callback when sorting by value field */
  onSortByValue?: (valueFieldIndex: number) => void;
  /** Position for the dropdown */
  position: { x: number; y: number };
  /** Callback to close the dropdown */
  onClose: () => void;
}

const dropdownStyles = {
  container: css`
    position: fixed;
    background: #fff;
    border: 1px solid #d0d0d0;
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 10000;
    min-width: 200px;
    padding: 4px 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      sans-serif;
    font-size: 12px;
  `,
  section: css`
    padding: 4px 0;
  `,
  sectionTitle: css`
    padding: 6px 12px;
    font-size: 10px;
    font-weight: 600;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  `,
  menuItem: css`
    display: flex;
    align-items: center;
    width: 100%;
    padding: 8px 12px;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    color: #333;
    gap: 8px;

    &:hover {
      background: #f0f0f0;
    }

    &.selected {
      background: #e8f4fc;
      color: #0078d4;
    }
  `,
  icon: css`
    width: 16px;
    text-align: center;
    color: #666;
    font-size: 12px;
  `,
  checkmark: css`
    width: 16px;
    text-align: center;
    color: #0078d4;
    font-size: 14px;
  `,
  label: css`
    flex: 1;
  `,
  separator: css`
    height: 1px;
    background: #e0e0e0;
    margin: 4px 0;
  `,
  subMenuItem: css`
    display: flex;
    align-items: center;
    width: 100%;
    padding: 6px 12px 6px 28px;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    color: #555;
    gap: 8px;
    font-size: 11px;

    &:hover {
      background: #f0f0f0;
    }

    &.selected {
      background: #e8f4fc;
      color: #0078d4;
    }
  `,
};

export function SortDropdown({
  currentSort,
  valueFields,
  sortByValueIndex,
  onSortChange,
  onSortByValue,
  position,
  onClose,
}: SortDropdownProps): React.ReactElement {
  const menuRef = useRef<HTMLDivElement>(null);
  const [showValueOptions, setShowValueOptions] = useState(false);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    const timeoutId = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleKeyDown);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const handleSortAsc = useCallback(() => {
    onSortChange("asc");
    onClose();
  }, [onSortChange, onClose]);

  const handleSortDesc = useCallback(() => {
    onSortChange("desc");
    onClose();
  }, [onSortChange, onClose]);

  const handleSortByValue = useCallback(
    (index: number) => {
      if (onSortByValue) {
        onSortByValue(index);
      }
      onClose();
    },
    [onSortByValue, onClose]
  );

  // Adjust position to keep menu in viewport
  const adjustedPosition = {
    x: Math.min(position.x, window.innerWidth - 220),
    y: Math.min(position.y, window.innerHeight - 250),
  };

  const hasValueFields = valueFields && valueFields.length > 0 && onSortByValue;

  return (
    <div
      ref={menuRef}
      className={dropdownStyles.container}
      style={{
        left: adjustedPosition.x,
        top: adjustedPosition.y,
      }}
    >
      <div className={dropdownStyles.section}>
        <div className={dropdownStyles.sectionTitle}>Sort Order</div>
        <button
          className={`${dropdownStyles.menuItem} ${
            currentSort === "asc" ? "selected" : ""
          }`}
          onClick={handleSortAsc}
        >
          <span className={dropdownStyles.checkmark}>
            {currentSort === "asc" ? "\u2713" : ""}
          </span>
          <span className={dropdownStyles.icon}>\u2191</span>
          <span className={dropdownStyles.label}>Sort A to Z</span>
        </button>
        <button
          className={`${dropdownStyles.menuItem} ${
            currentSort === "desc" ? "selected" : ""
          }`}
          onClick={handleSortDesc}
        >
          <span className={dropdownStyles.checkmark}>
            {currentSort === "desc" ? "\u2713" : ""}
          </span>
          <span className={dropdownStyles.icon}>\u2193</span>
          <span className={dropdownStyles.label}>Sort Z to A</span>
        </button>
      </div>

      {hasValueFields && (
        <>
          <div className={dropdownStyles.separator} />
          <div className={dropdownStyles.section}>
            <button
              className={dropdownStyles.menuItem}
              onClick={() => setShowValueOptions(!showValueOptions)}
            >
              <span className={dropdownStyles.checkmark}>
                {sortByValueIndex !== undefined ? "\u2713" : ""}
              </span>
              <span className={dropdownStyles.icon}>#</span>
              <span className={dropdownStyles.label}>Sort by Value</span>
              <span style={{ fontSize: 10 }}>
                {showValueOptions ? "\u25B2" : "\u25BC"}
              </span>
            </button>
            {showValueOptions &&
              valueFields.map((field, idx) => (
                <button
                  key={field.sourceIndex}
                  className={`${dropdownStyles.subMenuItem} ${
                    sortByValueIndex === idx ? "selected" : ""
                  }`}
                  onClick={() => handleSortByValue(idx)}
                >
                  <span className={dropdownStyles.checkmark}>
                    {sortByValueIndex === idx ? "\u2713" : ""}
                  </span>
                  <span className={dropdownStyles.label}>
                    {field.aggregation
                      ? `${field.aggregation.charAt(0).toUpperCase()}${field.aggregation.slice(1)} of ${field.name}`
                      : field.name}
                  </span>
                </button>
              ))}
          </div>
        </>
      )}

      <div className={dropdownStyles.separator} />
      <div className={dropdownStyles.section}>
        <button
          className={`${dropdownStyles.menuItem} ${
            currentSort === "source" ? "selected" : ""
          }`}
          onClick={() => {
            onSortChange("source");
            onClose();
          }}
        >
          <span className={dropdownStyles.checkmark}>
            {currentSort === "source" ? "\u2713" : ""}
          </span>
          <span className={dropdownStyles.icon}>\u21C5</span>
          <span className={dropdownStyles.label}>Data Source Order</span>
        </button>
      </div>
    </div>
  );
}
