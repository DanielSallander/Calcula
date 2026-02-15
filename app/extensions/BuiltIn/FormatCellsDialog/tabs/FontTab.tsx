//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/tabs/FontTab.tsx
// PURPOSE: Font tab for the Format Cells dialog.
// CONTEXT: Excel-style font picker with family, style, size, underline, color, and preview.

import React, { useState, useMemo } from "react";
import styled from "styled-components";
import { useFormatCellsStore } from "../hooks/useFormatCellsState";
import { FONT_LIST, FONT_SIZES } from "../utils/fontList";
import { ColorPicker } from "../components/ColorPicker";

const v = (name: string) => `var(${name})`;

// Font styles map bold+italic to readable labels
const FONT_STYLES = [
  { label: "Regular", bold: false, italic: false },
  { label: "Italic", bold: false, italic: true },
  { label: "Bold", bold: true, italic: false },
  { label: "Bold Italic", bold: true, italic: true },
];

export function FontTab(): React.ReactElement {
  const {
    fontFamily,
    fontSize,
    bold,
    italic,
    underline,
    strikethrough,
    textColor,
    setFontFamily,
    setFontSize,
    setBold,
    setItalic,
    setUnderline,
    setStrikethrough,
    setTextColor,
  } = useFormatCellsStore();

  // Font family filter
  const [fontFilter, setFontFilter] = useState(fontFamily);
  const filteredFonts = useMemo(() => {
    if (!fontFilter) return FONT_LIST;
    const lower = fontFilter.toLowerCase();
    return FONT_LIST.filter((f) => f.toLowerCase().includes(lower));
  }, [fontFilter]);

  // Font style index
  const currentStyleIndex = FONT_STYLES.findIndex(
    (s) => s.bold === bold && s.italic === italic
  );

  // Size filter
  const [sizeFilter, setSizeFilter] = useState(String(fontSize));

  const handleFontSelect = (font: string) => {
    setFontFamily(font);
    setFontFilter(font);
  };

  const handleStyleSelect = (style: (typeof FONT_STYLES)[number]) => {
    setBold(style.bold);
    setItalic(style.italic);
  };

  const handleSizeSelect = (size: number) => {
    setFontSize(size);
    setSizeFilter(String(size));
  };

  const handleSizeInputChange = (val: string) => {
    setSizeFilter(val);
    const num = parseFloat(val);
    if (!isNaN(num) && num > 0 && num <= 409) {
      setFontSize(num);
    }
  };

  return (
    <Container>
      {/* Top row: Font, Font Style, Size */}
      <TopRow>
        {/* Font family */}
        <FontColumn>
          <FieldLabel>Font:</FieldLabel>
          <FilterInput
            value={fontFilter}
            onChange={(e) => {
              setFontFilter(e.target.value);
            }}
            onBlur={() => {
              // If input matches a font, select it
              const match = FONT_LIST.find(
                (f) => f.toLowerCase() === fontFilter.toLowerCase()
              );
              if (match) handleFontSelect(match);
            }}
          />
          <ListBox>
            {filteredFonts.map((font) => (
              <ListItem
                key={font}
                $selected={fontFamily === font}
                onClick={() => handleFontSelect(font)}
                style={{ fontFamily: font }}
              >
                {font}
              </ListItem>
            ))}
          </ListBox>
        </FontColumn>

        {/* Font style */}
        <StyleColumn>
          <FieldLabel>Font style:</FieldLabel>
          <FilterInput
            value={
              FONT_STYLES[currentStyleIndex >= 0 ? currentStyleIndex : 0].label
            }
            readOnly
          />
          <ListBox>
            {FONT_STYLES.map((style, i) => (
              <ListItem
                key={style.label}
                $selected={currentStyleIndex === i}
                onClick={() => handleStyleSelect(style)}
                style={{
                  fontWeight: style.bold ? 700 : 400,
                  fontStyle: style.italic ? "italic" : "normal",
                }}
              >
                {style.label}
              </ListItem>
            ))}
          </ListBox>
        </StyleColumn>

        {/* Size */}
        <SizeColumn>
          <FieldLabel>Size:</FieldLabel>
          <FilterInput
            value={sizeFilter}
            onChange={(e) => handleSizeInputChange(e.target.value)}
          />
          <ListBox>
            {FONT_SIZES.map((size) => (
              <ListItem
                key={size}
                $selected={fontSize === size}
                onClick={() => handleSizeSelect(size)}
              >
                {size}
              </ListItem>
            ))}
          </ListBox>
        </SizeColumn>
      </TopRow>

      {/* Underline and Color row */}
      <MiddleRow>
        <FieldGroup>
          <FieldLabel>Underline:</FieldLabel>
          <Select
            value={underline ? "single" : "none"}
            onChange={(e) => setUnderline(e.target.value === "single")}
          >
            <option value="none">None</option>
            <option value="single">Single</option>
          </Select>
        </FieldGroup>

        <FieldGroup>
          <FieldLabel>Color:</FieldLabel>
          <ColorPicker value={textColor} onChange={setTextColor} />
        </FieldGroup>

        <CheckboxGroup>
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={strikethrough}
              onChange={(e) => setStrikethrough(e.target.checked)}
            />
            Strikethrough
          </CheckboxLabel>
        </CheckboxGroup>
      </MiddleRow>

      {/* Preview */}
      <PreviewSection>
        <FieldLabel>Preview:</FieldLabel>
        <PreviewBox>
          <PreviewText
            style={{
              fontFamily: fontFamily,
              fontSize: `${Math.min(fontSize, 28)}pt`,
              fontWeight: bold ? 700 : 400,
              fontStyle: italic ? "italic" : "normal",
              textDecoration: [
                underline ? "underline" : "",
                strikethrough ? "line-through" : "",
              ]
                .filter(Boolean)
                .join(" ") || "none",
              color: textColor,
            }}
          >
            AaBbCcYyZz
          </PreviewText>
        </PreviewBox>
      </PreviewSection>
    </Container>
  );
}

// Styled Components
const Container = styled.div`
  padding: 4px 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
`;

const TopRow = styled.div`
  display: flex;
  gap: 12px;
  flex: 1;
  min-height: 0;
`;

const FontColumn = styled.div`
  flex: 2;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
`;

const StyleColumn = styled.div`
  flex: 1.2;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
`;

const SizeColumn = styled.div`
  width: 70px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
`;

const FieldLabel = styled.label`
  font-size: 12px;
  color: ${v("--text-secondary")};
  flex-shrink: 0;
`;

const FilterInput = styled.input`
  padding: 4px 8px;
  font-size: 13px;
  background: ${v("--grid-bg")};
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  color: ${v("--text-primary")};
  outline: none;
  flex-shrink: 0;

  &:focus {
    border-color: ${v("--accent-primary")};
  }
`;

const ListBox = styled.div`
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  background: ${v("--grid-bg")};
  overflow-y: auto;
  flex: 1;
  min-height: 80px;
  max-height: 160px;
`;

const ListItem = styled.div<{ $selected: boolean }>`
  padding: 3px 8px;
  cursor: pointer;
  font-size: 13px;
  background: ${(p) => (p.$selected ? v("--accent-primary") : "transparent")};
  color: ${(p) => (p.$selected ? "#ffffff" : v("--text-primary"))};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;

  &:hover {
    background: ${(p) =>
      p.$selected ? v("--accent-primary") : v("--panel-bg")};
  }
`;

const MiddleRow = styled.div`
  display: flex;
  gap: 16px;
  align-items: flex-end;
  flex-shrink: 0;
`;

const FieldGroup = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

const Select = styled.select`
  padding: 5px 8px;
  font-size: 13px;
  background: ${v("--grid-bg")};
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  color: ${v("--text-primary")};
  outline: none;
  min-width: 100px;

  &:focus {
    border-color: ${v("--accent-primary")};
  }
`;

const CheckboxGroup = styled.div`
  display: flex;
  align-items: center;
  padding-bottom: 2px;
`;

const CheckboxLabel = styled.label`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: ${v("--text-primary")};
  cursor: pointer;
`;

const PreviewSection = styled.div`
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

const PreviewBox = styled.div`
  height: 50px;
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  background: #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
`;

const PreviewText = styled.span`
  transition: all 0.15s ease;
`;
