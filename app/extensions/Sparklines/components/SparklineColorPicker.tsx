//! FILENAME: app/extensions/Sparklines/components/SparklineColorPicker.tsx
// PURPOSE: Lightweight inline color picker for the sparkline ribbon tab.
// CONTEXT: Shows a small color swatch + label, with a dropdown palette on click.
//          Uses @emotion/css for styling (matching PivotDesignTab pattern).

import React, { useState, useRef, useEffect, useCallback } from "react";
import { css } from "@emotion/css";

// Standard color palette (same as FormatCellsDialog ColorPicker)
const PALETTE_COLORS = [
  // Row 1 - Theme colors
  "#000000", "#1a1a2e", "#16213e", "#0f3460", "#533483", "#7c3aed",
  "#dc2626", "#ea580c", "#d97706", "#65a30d", "#059669", "#0284c7",
  // Row 2 - Lighter shades
  "#404040", "#4a4a6a", "#3a5a8e", "#3f6fa0", "#7354a3", "#9d6dfd",
  "#ef4444", "#f97316", "#eab308", "#84cc16", "#10b981", "#38bdf8",
  // Row 3 - Even lighter
  "#808080", "#8a8aaa", "#6a8abe", "#6f9fd0", "#9374c3", "#bd8dff",
  "#f87171", "#fb923c", "#facc15", "#a3e635", "#34d399", "#7dd3fc",
  // Row 4 - Light pastel
  "#bfbfbf", "#babade", "#9abaee", "#9fcff0", "#b394e3", "#ddbdff",
  "#fca5a5", "#fdba74", "#fde047", "#bef264", "#6ee7b7", "#bae6fd",
  // Row 5 - Very light
  "#ffffff", "#e0e0f0", "#d0e0ff", "#d0efff", "#e0d0ff", "#f0e0ff",
  "#fee2e2", "#fed7aa", "#fef08a", "#d9f99d", "#a7f3d0", "#e0f2fe",
];

// ============================================================================
// Styles
// ============================================================================

const styles = {
  container: css`
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  `,
  label: css`
    font-size: 11px;
    color: #333;
    white-space: nowrap;
  `,
  swatchButton: css`
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 2px 5px;
    background: #fff;
    border: 1px solid #d0d0d0;
    border-radius: 3px;
    cursor: pointer;

    &:hover {
      border-color: #999;
    }
  `,
  swatch: css`
    width: 16px;
    height: 12px;
    border: 1px solid #ccc;
    border-radius: 2px;
  `,
  arrow: css`
    font-size: 7px;
    color: #666;
  `,
  dropdown: css`
    position: fixed;
    z-index: 1100;
    padding: 8px;
    background: #fff;
    border: 1px solid #d0d0d0;
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
    min-width: 220px;
  `,
  paletteGrid: css`
    display: grid;
    grid-template-columns: repeat(12, 1fr);
    gap: 2px;
    margin-bottom: 8px;
  `,
  customRow: css`
    display: flex;
    align-items: center;
    gap: 6px;
    padding-top: 6px;
    border-top: 1px solid #e0e0e0;
  `,
  customLabel: css`
    font-size: 11px;
    color: #666;
  `,
  customInput: css`
    width: 24px;
    height: 20px;
    padding: 0;
    border: 1px solid #d0d0d0;
    border-radius: 3px;
    cursor: pointer;
  `,
  hexInput: css`
    flex: 1;
    padding: 2px 4px;
    font-size: 11px;
    font-family: "Consolas", monospace;
    background: #fff;
    border: 1px solid #d0d0d0;
    border-radius: 3px;
    color: #1a1a1a;
    outline: none;

    &:focus {
      border-color: #005fb8;
    }
  `,
};

function paletteCellStyle(color: string, selected: boolean): string {
  return css`
    width: 16px;
    height: 16px;
    border: ${selected ? "2px solid #005fb8" : "1px solid #d0d0d0"};
    border-radius: 2px;
    background-color: ${color};
    cursor: pointer;
    padding: 0;

    &:hover {
      border: 2px solid #333;
      transform: scale(1.2);
    }
  `;
}

// ============================================================================
// Component
// ============================================================================

interface SparklineColorPickerProps {
  label: string;
  value: string;
  onChange: (color: string) => void;
}

export function SparklineColorPicker({
  label,
  value,
  onChange,
}: SparklineColorPickerProps): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (
      containerRef.current && !containerRef.current.contains(e.target as Node) &&
      dropdownRef.current && !dropdownRef.current.contains(e.target as Node)
    ) {
      setIsOpen(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, handleClickOutside]);

  // Position the dropdown below the swatch button using fixed positioning
  const [dropdownPos, setDropdownPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const handleToggle = useCallback(() => {
    if (!isOpen && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setDropdownPos({ x: rect.left, y: rect.bottom + 4 });
    }
    setIsOpen(!isOpen);
  }, [isOpen]);

  return (
    <div ref={containerRef} className={styles.container}>
      <button
        className={styles.swatchButton}
        onClick={handleToggle}
        title={`${label}: ${value}`}
      >
        <span className={styles.swatch} style={{ backgroundColor: value }} />
        <span className={styles.label}>{label}</span>
        <span className={styles.arrow}>{isOpen ? "\u25B2" : "\u25BC"}</span>
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className={styles.dropdown}
          style={{ left: dropdownPos.x, top: dropdownPos.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className={styles.paletteGrid}>
            {PALETTE_COLORS.map((color) => (
              <button
                key={color}
                className={paletteCellStyle(
                  color,
                  value.toLowerCase() === color.toLowerCase(),
                )}
                onClick={() => {
                  onChange(color);
                  setIsOpen(false);
                }}
                title={color}
              />
            ))}
          </div>
          <div className={styles.customRow}>
            <span className={styles.customLabel}>Custom:</span>
            <input
              className={styles.customInput}
              type="color"
              value={value}
              onChange={(e) => onChange(e.target.value)}
            />
            <input
              className={styles.hexInput}
              type="text"
              value={value}
              onChange={(e) => {
                const val = e.target.value;
                if (/^#[0-9a-fA-F]{0,6}$/.test(val)) {
                  onChange(val);
                }
              }}
              onBlur={(e) => {
                const val = e.target.value;
                if (/^#[0-9a-fA-F]{6}$/.test(val)) {
                  onChange(val);
                  setIsOpen(false);
                }
              }}
              maxLength={7}
            />
          </div>
        </div>
      )}
    </div>
  );
}
