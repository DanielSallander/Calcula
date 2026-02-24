//! FILENAME: app/extensions/BuiltIn/StatusBarAggregation/AggregationContextMenu.tsx
// PURPOSE: Right-click context menu for toggling which aggregations are visible.
// CONTEXT: Appears above the status bar when user right-clicks the aggregation area.

import React, { useEffect, useRef } from "react";
import type { AggregationKey } from "./useAggregationPreferences";

interface AggregationContextMenuProps {
  x: number;
  y: number;
  visibleKeys: Set<AggregationKey>;
  onToggle: (key: AggregationKey) => void;
  onClose: () => void;
}

interface AggregationOption {
  key: AggregationKey;
  label: string;
}

const AGGREGATION_OPTIONS: AggregationOption[] = [
  { key: "average", label: "Average" },
  { key: "count", label: "Count" },
  { key: "numericalCount", label: "Numerical Count" },
  { key: "min", label: "Minimum" },
  { key: "max", label: "Maximum" },
  { key: "sum", label: "Sum" },
];

export function AggregationContextMenu({
  x,
  y,
  visibleKeys,
  onToggle,
  onClose,
}: AggregationContextMenuProps): React.ReactElement {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    // Use setTimeout to avoid the context menu event itself triggering close
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleKeyDown);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  // Position the menu above the click point (status bar is at the bottom)
  const menuHeight = AGGREGATION_OPTIONS.length * 32 + 8; // rough estimate
  const posY = y - menuHeight;

  return (
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        left: `${x}px`,
        top: `${Math.max(0, posY)}px`,
        backgroundColor: "#2d2d2d",
        border: "1px solid #454545",
        borderRadius: "4px",
        padding: "4px 0",
        minWidth: "200px",
        zIndex: 10000,
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.4)",
      }}
    >
      {AGGREGATION_OPTIONS.map((option) => {
        const isChecked = visibleKeys.has(option.key);
        return (
          <div
            key={option.key}
            onClick={() => onToggle(option.key)}
            style={{
              display: "flex",
              alignItems: "center",
              padding: "6px 12px",
              cursor: "pointer",
              color: "#e0e0e0",
              fontSize: "13px",
              userSelect: "none",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLDivElement).style.backgroundColor = "#3d3d3d";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLDivElement).style.backgroundColor = "transparent";
            }}
          >
            <span
              style={{
                width: "20px",
                marginRight: "8px",
                fontSize: "14px",
                opacity: isChecked ? 1 : 0,
              }}
            >
              {"\u2713"}
            </span>
            <span>{option.label}</span>
          </div>
        );
      })}
    </div>
  );
}
