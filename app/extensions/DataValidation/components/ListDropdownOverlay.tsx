//! FILENAME: app/extensions/DataValidation/components/ListDropdownOverlay.tsx
// PURPOSE: Dropdown overlay for selecting from list validation values.
// CONTEXT: Shown when the user clicks a dropdown chevron on a list-validated cell.

import React, { useEffect, useState, useRef } from "react";
import type { OverlayProps } from "../../../src/api";
import {
  getValidationListValues,
  getCell,
  updateCellsBatch,
  cellEvents,
} from "../../../src/api";
import { setOpenDropdownCell } from "../lib/validationStore";
import type { ListDropdownData } from "../types";

// ============================================================================
// Styles
// ============================================================================

const containerStyle: React.CSSProperties = {
  backgroundColor: "#fff",
  border: "1px solid #c0c0c0",
  boxShadow: "0 2px 8px rgba(0, 0, 0, 0.15)",
  minWidth: 120,
  maxWidth: 300,
  maxHeight: 200,
  overflowY: "auto",
  fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
  fontSize: 13,
  zIndex: 9000,
};

const itemStyle: React.CSSProperties = {
  padding: "4px 8px",
  cursor: "pointer",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const itemHoverStyle: React.CSSProperties = {
  ...itemStyle,
  backgroundColor: "#e8f0fe",
};

const selectedItemStyle: React.CSSProperties = {
  ...itemStyle,
  backgroundColor: "#cce5ff",
  fontWeight: 600,
};

// ============================================================================
// Component
// ============================================================================

export default function ListDropdownOverlay(props: OverlayProps) {
  const { onClose, data, anchorRect } = props;
  const dropdownData = data as unknown as ListDropdownData | undefined;
  const containerRef = useRef<HTMLDivElement>(null);
  const [values, setValues] = useState<string[]>([]);
  const [currentValue, setCurrentValue] = useState<string>("");
  const [hoveredIndex, setHoveredIndex] = useState<number>(-1);
  const [loading, setLoading] = useState(true);

  const row = dropdownData?.row ?? 0;
  const col = dropdownData?.col ?? 0;

  // Load values on mount
  useEffect(() => {
    let cancelled = false;

    async function loadValues() {
      try {
        // Get list values from backend
        const listValues = await getValidationListValues(row, col);
        if (cancelled) return;
        setValues(listValues || []);

        // Get current cell value
        const cell = await getCell(row, col);
        if (cancelled) return;
        setCurrentValue(cell?.display || "");
      } catch (error) {
        console.error("[DataValidation] Failed to load list values:", error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadValues();
    return () => { cancelled = true; };
  }, [row, col]);

  // Focus the container on mount for keyboard handling
  useEffect(() => {
    containerRef.current?.focus();
  }, [loading]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        handleClose();
      }
    };
    // Use setTimeout to avoid immediately closing from the click that opened it
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 50);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  function handleClose() {
    setOpenDropdownCell(null);
    onClose();
  }

  async function handleSelect(value: string) {
    try {
      const updatedCells = await updateCellsBatch([{ row, col, value }]);
      // Emit cell change event so the grid refreshes
      if (updatedCells.length > 0) {
        cellEvents.emit({
          row: updatedCells[0].row,
          col: updatedCells[0].col,
          oldValue: currentValue,
          newValue: updatedCells[0].display,
          formula: updatedCells[0].formula ?? null,
        });
      }
    } catch (error) {
      console.error("[DataValidation] Failed to set cell value:", error);
    }
    handleClose();
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      handleClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHoveredIndex((prev) => Math.min(prev + 1, values.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHoveredIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (hoveredIndex >= 0 && hoveredIndex < values.length) {
        handleSelect(values[hoveredIndex]);
      }
    }
  };

  // Position based on anchor
  const positionStyle: React.CSSProperties = anchorRect
    ? {
        position: "fixed",
        left: anchorRect.x,
        top: anchorRect.y + anchorRect.height,
      }
    : {
        position: "fixed",
        left: 100,
        top: 100,
      };

  if (loading) {
    return (
      <div
        ref={containerRef}
        style={{ ...containerStyle, ...positionStyle, padding: "8px" }}
      >
        Loading...
      </div>
    );
  }

  if (values.length === 0) {
    return (
      <div
        ref={containerRef}
        style={{ ...containerStyle, ...positionStyle, padding: "8px", color: "#999" }}
      >
        No items
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{ ...containerStyle, ...positionStyle }}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {values.map((value, index) => {
        const isSelected = value === currentValue;
        const isHovered = index === hoveredIndex;
        const style = isSelected
          ? selectedItemStyle
          : isHovered
            ? itemHoverStyle
            : itemStyle;

        return (
          <div
            key={index}
            style={style}
            onClick={() => handleSelect(value)}
            onMouseEnter={() => setHoveredIndex(index)}
            onMouseLeave={() => setHoveredIndex(-1)}
          >
            {value}
          </div>
        );
      })}
    </div>
  );
}
