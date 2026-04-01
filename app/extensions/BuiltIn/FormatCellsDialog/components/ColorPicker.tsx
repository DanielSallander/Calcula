//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/components/ColorPicker.tsx
// PURPOSE: Theme-aware color picker component for the Format Cells dialog.
// CONTEXT: Shows theme colors (10x6 grid), standard colors row, and custom color input.

import React, { useState, useRef, useEffect, useCallback } from "react";
import styled from "styled-components";
import type { ThemeColorInfo } from "../../../../src/core/types/types";
import { getThemeColorPalette } from "../../../../src/api/theme";

const v = (name: string) => `var(${name})`;

// Standard colors row (10 fixed colors, not theme-dependent)
const STANDARD_COLORS = [
  "#c00000", "#ff0000", "#ffc000", "#ffff00", "#92d050",
  "#00b050", "#00b0f0", "#0070c0", "#002060", "#7030a0",
];

interface ColorPickerProps {
  value: string;
  /** Current theme slot (e.g. "accent1") if this color is theme-based */
  themeSlot?: string;
  /** Current theme tint (permille) if theme-based */
  themeTint?: number;
  /** Called when user picks an absolute (non-theme) color */
  onChange: (color: string) => void;
  /** Called when user picks a theme color. If not provided, falls back to onChange with resolved color. */
  onThemeColorChange?: (slot: string, tint: number, resolvedColor: string) => void;
  label?: string;
}

export function ColorPicker({
  value,
  themeSlot,
  themeTint,
  onChange,
  onThemeColorChange,
  label,
}: ColorPickerProps): React.ReactElement {
  const [isExpanded, setIsExpanded] = useState(false);
  const [palette, setPalette] = useState<ThemeColorInfo[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      setIsExpanded(false);
    }
  }, []);

  useEffect(() => {
    if (isExpanded) {
      document.addEventListener("mousedown", handleClickOutside);
      // Load theme palette
      getThemeColorPalette().then(setPalette).catch(console.error);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isExpanded, handleClickOutside]);

  const handleThemeColorClick = (info: ThemeColorInfo) => {
    if (onThemeColorChange) {
      onThemeColorChange(info.slot, info.tint, info.resolvedColor);
    } else {
      onChange(info.resolvedColor);
    }
    setIsExpanded(false);
  };

  const isThemeColorSelected = (info: ThemeColorInfo): boolean => {
    if (themeSlot && themeSlot === info.slot && (themeTint ?? 0) === info.tint) {
      return true;
    }
    return false;
  };

  // Split palette into rows: first 10 = base, then 5 rows of 10 tints
  const baseColors = palette.slice(0, 10);
  const tintRows = [];
  for (let i = 10; i < palette.length; i += 10) {
    tintRows.push(palette.slice(i, i + 10));
  }

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
          {/* Theme Colors Section */}
          {baseColors.length > 0 && (
            <>
              <SectionLabel>Theme Colors</SectionLabel>
              <PaletteGrid>
                {baseColors.map((info) => (
                  <PaletteCell
                    key={`${info.slot}-${info.tint}`}
                    $color={info.resolvedColor}
                    $selected={isThemeColorSelected(info)}
                    onClick={() => handleThemeColorClick(info)}
                    title={info.label}
                  />
                ))}
              </PaletteGrid>
              {tintRows.map((row, rowIdx) => (
                <PaletteGrid key={rowIdx}>
                  {row.map((info) => (
                    <PaletteCell
                      key={`${info.slot}-${info.tint}`}
                      $color={info.resolvedColor}
                      $selected={isThemeColorSelected(info)}
                      onClick={() => handleThemeColorClick(info)}
                      title={info.label}
                    />
                  ))}
                </PaletteGrid>
              ))}
            </>
          )}

          {/* Standard Colors */}
          <SectionLabel>Standard Colors</SectionLabel>
          <PaletteGrid>
            {STANDARD_COLORS.map((color) => (
              <PaletteCell
                key={color}
                $color={color}
                $selected={!themeSlot && value.toLowerCase() === color.toLowerCase()}
                onClick={() => {
                  onChange(color);
                  setIsExpanded(false);
                }}
                title={color}
              />
            ))}
          </PaletteGrid>

          {/* Custom Color */}
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

const SectionLabel = styled.div`
  font-size: 10px;
  color: ${v("--text-secondary")};
  margin-bottom: 3px;
  margin-top: 6px;

  &:first-child {
    margin-top: 0;
  }
`;

const PaletteGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(10, 1fr);
  gap: 2px;
  margin-bottom: 1px;
`;

const PaletteCell = styled.button<{ $color: string; $selected: boolean }>`
  width: 18px;
  height: 18px;
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
  margin-top: 6px;
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
