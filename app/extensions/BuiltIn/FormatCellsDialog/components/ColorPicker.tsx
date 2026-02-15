//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/components/ColorPicker.tsx
// PURPOSE: Reusable color picker component for the Format Cells dialog.

import React, { useState, useRef, useEffect, useCallback } from "react";
import styled from "styled-components";

const v = (name: string) => `var(${name})`;

// Standard color palette (Excel-like)
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

interface ColorPickerProps {
  value: string;
  onChange: (color: string) => void;
  label?: string;
}

export function ColorPicker({
  value,
  onChange,
  label,
}: ColorPickerProps): React.ReactElement {
  const [isExpanded, setIsExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      setIsExpanded(false);
    }
  }, []);

  useEffect(() => {
    if (isExpanded) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isExpanded, handleClickOutside]);

  return (
    <Container ref={containerRef}>
      {label && <Label>{label}</Label>}
      <SwatchButton
        onClick={() => setIsExpanded(!isExpanded)}
        title={value}
      >
        <Swatch style={{ backgroundColor: value }} />
        <Arrow>{isExpanded ? "\u25B2" : "\u25BC"}</Arrow>
      </SwatchButton>

      {isExpanded && (
        <Dropdown onClick={(e) => e.stopPropagation()}>
          <PaletteGrid>
            {PALETTE_COLORS.map((color) => (
              <PaletteCell
                key={color}
                $color={color}
                $selected={value.toLowerCase() === color.toLowerCase()}
                onClick={() => {
                  onChange(color);
                  setIsExpanded(false);
                }}
                title={color}
              />
            ))}
          </PaletteGrid>
          <CustomColorRow>
            <CustomLabel>Custom:</CustomLabel>
            <CustomInput
              type="color"
              value={value}
              onChange={(e) => onChange(e.target.value)}
            />
            <HexInput
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
                  setIsExpanded(false);
                }
              }}
              maxLength={7}
            />
          </CustomColorRow>
        </Dropdown>
      )}
    </Container>
  );
}

// Styled Components
const Container = styled.div`
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
`;

const Label = styled.span`
  font-size: 12px;
  color: ${v("--text-secondary")};
`;

const SwatchButton = styled.button`
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px;
  background: ${v("--grid-bg")};
  border: 1px solid ${v("--border-default")};
  border-radius: 3px;
  cursor: pointer;

  &:hover {
    border-color: ${v("--accent-primary")};
  }
`;

const Swatch = styled.div`
  width: 20px;
  height: 14px;
  border: 1px solid ${v("--border-default")};
  border-radius: 2px;
`;

const Arrow = styled.span`
  font-size: 8px;
  color: ${v("--text-secondary")};
`;

const Dropdown = styled.div`
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 1100;
  margin-top: 4px;
  padding: 8px;
  background: ${v("--panel-bg")};
  border: 1px solid ${v("--border-default")};
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  min-width: 220px;
`;

const PaletteGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: 2px;
  margin-bottom: 8px;
`;

const PaletteCell = styled.button<{ $color: string; $selected: boolean }>`
  width: 16px;
  height: 16px;
  border: ${(p) =>
    p.$selected
      ? `2px solid ${v("--accent-primary")}`
      : `1px solid ${v("--border-default")}`};
  border-radius: 2px;
  background-color: ${(p) => p.$color};
  cursor: pointer;
  padding: 0;

  &:hover {
    border: 2px solid ${v("--text-primary")};
    transform: scale(1.2);
  }
`;

const CustomColorRow = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 6px;
  border-top: 1px solid ${v("--border-default")};
`;

const CustomLabel = styled.span`
  font-size: 11px;
  color: ${v("--text-secondary")};
`;

const CustomInput = styled.input`
  width: 24px;
  height: 20px;
  padding: 0;
  border: 1px solid ${v("--border-default")};
  border-radius: 3px;
  cursor: pointer;
`;

const HexInput = styled.input`
  flex: 1;
  padding: 2px 4px;
  font-size: 11px;
  font-family: "Consolas", monospace;
  background: ${v("--grid-bg")};
  border: 1px solid ${v("--border-default")};
  border-radius: 3px;
  color: ${v("--text-primary")};
  outline: none;

  &:focus {
    border-color: ${v("--accent-primary")};
  }
`;
