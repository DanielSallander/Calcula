//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/tabs/FillTab.tsx
// PURPOSE: Fill (background color) tab for the Format Cells dialog.

import React from "react";
import styled from "styled-components";
import { useFormatCellsStore } from "../hooks/useFormatCellsState";
import { ColorPicker } from "../components/ColorPicker";

const v = (name: string) => `var(${name})`;

// Quick-access background colors
const QUICK_COLORS = [
  "#ffffff", "#f8f9fa", "#f1f3f5", "#e9ecef", "#dee2e6",
  "#fff3bf", "#fff9db", "#fff0f6", "#f8f0fc", "#f3f0ff",
  "#e7f5ff", "#e3fafc", "#d3f9d8", "#ebfbee", "#fff4e6",
  "#ffe3e3", "#ffc9c9", "#ffa8a8", "#ff8787", "#ff6b6b",
  "#ffd43b", "#fcc419", "#fab005", "#f59f00", "#f08c00",
  "#69db7c", "#51cf66", "#40c057", "#37b24d", "#2f9e44",
  "#74c0fc", "#4dabf7", "#339af0", "#228be6", "#1c7ed6",
  "#b197fc", "#9775fa", "#845ef7", "#7950f2", "#7048e8",
];

export function FillTab(): React.ReactElement {
  const { backgroundColor, setBackgroundColor } = useFormatCellsStore();

  return (
    <Container>
      <Section>
        <SectionTitle>Background Color</SectionTitle>

        <ColorPickerRow>
          <ColorPicker
            value={backgroundColor}
            onChange={setBackgroundColor}
            label="Color:"
          />
          <NoFillButton onClick={() => setBackgroundColor("#ffffff")}>
            No Fill
          </NoFillButton>
        </ColorPickerRow>
      </Section>

      <Section>
        <SectionTitle>Quick Colors</SectionTitle>
        <QuickColorGrid>
          {QUICK_COLORS.map((color) => (
            <QuickColorCell
              key={color}
              $color={color}
              $selected={backgroundColor.toLowerCase() === color.toLowerCase()}
              onClick={() => setBackgroundColor(color)}
              title={color}
            />
          ))}
        </QuickColorGrid>
      </Section>

      <Section>
        <SectionTitle>Preview</SectionTitle>
        <PreviewBox style={{ backgroundColor }}>
          <PreviewText
            style={{
              color: isLightColor(backgroundColor) ? "#000000" : "#ffffff",
            }}
          >
            Sample Text
          </PreviewText>
        </PreviewBox>
      </Section>
    </Container>
  );
}

function isLightColor(hex: string): boolean {
  const c = hex.replace("#", "");
  if (c.length !== 6) return true;
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5;
}

// Styled Components
const Container = styled.div`
  padding: 4px 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
`;

const Section = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const SectionTitle = styled.div`
  font-size: 12px;
  font-weight: 600;
  color: ${v("--text-primary")};
  padding-bottom: 4px;
  border-bottom: 1px solid ${v("--border-default")};
`;

const ColorPickerRow = styled.div`
  display: flex;
  align-items: center;
  gap: 16px;
`;

const NoFillButton = styled.button`
  padding: 5px 14px;
  font-size: 12px;
  background: ${v("--grid-bg")};
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  color: ${v("--text-primary")};
  cursor: pointer;

  &:hover {
    border-color: ${v("--accent-primary")};
  }
`;

const QuickColorGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(10, 1fr);
  gap: 3px;
`;

const QuickColorCell = styled.button<{ $color: string; $selected: boolean }>`
  width: 100%;
  aspect-ratio: 1;
  min-width: 20px;
  border: ${(p) =>
    p.$selected
      ? `2px solid ${v("--accent-primary")}`
      : `1px solid ${v("--border-default")}`};
  border-radius: 3px;
  background-color: ${(p) => p.$color};
  cursor: pointer;
  padding: 0;

  &:hover {
    border: 2px solid ${v("--text-primary")};
    transform: scale(1.1);
  }
`;

const PreviewBox = styled.div`
  height: 60px;
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.15s ease;
`;

const PreviewText = styled.span`
  font-size: 14px;
  font-family: "Calibri", system-ui, sans-serif;
  transition: color 0.15s ease;
`;
