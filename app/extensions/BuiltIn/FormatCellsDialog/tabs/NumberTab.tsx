//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/tabs/NumberTab.tsx
// PURPOSE: Number format tab for the Format Cells dialog.

import React, { useState, useEffect, useRef, useCallback } from "react";
import styled from "styled-components";
import { useFormatCellsStore } from "../hooks/useFormatCellsState";
import {
  NUMBER_FORMAT_CATEGORIES,
} from "../utils/numberFormats";
import { previewNumberFormat } from "../../../../src/api";

const v = (name: string) => `var(${name})`;

const KNOWN_PRESET_VALUES = new Set(
  NUMBER_FORMAT_CATEGORIES.flatMap((cat) =>
    cat.id !== "custom" ? cat.formats.map((f) => f.value) : []
  )
);

export function NumberTab(): React.ReactElement {
  const { numberFormat, setNumberFormat } = useFormatCellsStore();

  // Find which category the current format belongs to
  const findCurrentCategory = (): string => {
    for (const cat of NUMBER_FORMAT_CATEGORIES) {
      if (cat.id === "custom") continue;
      for (const fmt of cat.formats) {
        if (fmt.value === numberFormat || fmt.value === numberFormat.toLowerCase()) {
          return cat.id;
        }
      }
    }
    // If not in any known category, it's a custom format
    if (numberFormat && !KNOWN_PRESET_VALUES.has(numberFormat) && !KNOWN_PRESET_VALUES.has(numberFormat.toLowerCase())) {
      return "custom";
    }
    return "general";
  };

  const [selectedCategory, setSelectedCategory] = useState(findCurrentCategory);
  const [customInput, setCustomInput] = useState(() => {
    // If already a custom format, initialize with it
    if (findCurrentCategory() === "custom") return numberFormat;
    return "";
  });
  const [preview, setPreview] = useState<{ display: string; color?: string }>({ display: "Sample" });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentCategory = NUMBER_FORMAT_CATEGORIES.find(
    (c) => c.id === selectedCategory
  );

  // Fetch preview for custom format input
  const fetchPreview = useCallback(async (formatStr: string) => {
    if (!formatStr.trim()) {
      setPreview({ display: "Sample" });
      return;
    }
    try {
      const result = await previewNumberFormat(formatStr, 1234.5);
      setPreview({ display: result.display, color: result.color });
    } catch {
      setPreview({ display: "(invalid format)" });
    }
  }, []);

  // Debounced preview update for custom input
  useEffect(() => {
    if (selectedCategory !== "custom") return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchPreview(customInput);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [customInput, selectedCategory, fetchPreview]);

  const handleCustomInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setCustomInput(val);
    if (val.trim()) {
      setNumberFormat(val);
    }
  };

  const handlePresetClick = (value: string) => {
    if (selectedCategory === "custom") {
      setCustomInput(value);
      setNumberFormat(value);
    } else {
      setNumberFormat(value);
    }
  };

  return (
    <Container>
      <ColumnsLayout>
        {/* Category list */}
        <CategoryList>
          <SectionLabel>Category:</SectionLabel>
          <CategoryListBox>
            {NUMBER_FORMAT_CATEGORIES.map((cat) => (
              <CategoryItem
                key={cat.id}
                $selected={selectedCategory === cat.id}
                onClick={() => setSelectedCategory(cat.id)}
              >
                {cat.label}
              </CategoryItem>
            ))}
          </CategoryListBox>
        </CategoryList>

        {/* Format options */}
        <FormatOptions>
          {currentCategory && (
            <>
              <Description>{currentCategory.description}</Description>

              {selectedCategory === "custom" ? (
                <>
                  <SectionLabel>Type:</SectionLabel>
                  <FormatInput
                    type="text"
                    value={customInput}
                    onChange={handleCustomInputChange}
                    placeholder='e.g. #,##0.00;[Red]-#,##0.00'
                    spellCheck={false}
                    autoFocus
                  />

                  <SectionLabel>Presets:</SectionLabel>
                  <FormatList>
                    {currentCategory.formats.map((fmt) => (
                      <FormatItem
                        key={fmt.value}
                        $selected={customInput === fmt.value}
                        onClick={() => handlePresetClick(fmt.value)}
                      >
                        <FormatLabel>{fmt.label}</FormatLabel>
                        {fmt.example && (
                          <FormatExample>{fmt.example}</FormatExample>
                        )}
                      </FormatItem>
                    ))}
                  </FormatList>

                  <PreviewSection>
                    <SectionLabel>Preview:</SectionLabel>
                    <PreviewBox style={preview.color ? { color: preview.color } : undefined}>
                      {preview.display}
                    </PreviewBox>
                  </PreviewSection>
                </>
              ) : (
                <>
                  <SectionLabel>Format:</SectionLabel>
                  <FormatList>
                    {currentCategory.formats.map((fmt) => (
                      <FormatItem
                        key={fmt.value}
                        $selected={numberFormat === fmt.value ||
                          numberFormat.toLowerCase() === fmt.value}
                        onClick={() => handlePresetClick(fmt.value)}
                      >
                        <FormatLabel>{fmt.label}</FormatLabel>
                        {fmt.example && (
                          <FormatExample>{fmt.example}</FormatExample>
                        )}
                      </FormatItem>
                    ))}
                  </FormatList>

                  <PreviewSection>
                    <SectionLabel>Preview:</SectionLabel>
                    <PreviewBox>
                      {currentCategory.formats.find(
                        (f) => f.value === numberFormat || f.value === numberFormat.toLowerCase()
                      )?.example || "Sample"}
                    </PreviewBox>
                  </PreviewSection>
                </>
              )}
            </>
          )}
        </FormatOptions>
      </ColumnsLayout>
    </Container>
  );
}

// Styled Components
const Container = styled.div`
  padding: 4px 0;
  height: 100%;
`;

const ColumnsLayout = styled.div`
  display: flex;
  gap: 16px;
  height: 100%;
`;

const CategoryList = styled.div`
  width: 140px;
  flex-shrink: 0;
`;

const SectionLabel = styled.div`
  font-size: 12px;
  color: ${v("--text-secondary")};
  margin-bottom: 4px;
  font-weight: 500;
`;

const CategoryListBox = styled.div`
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  background: ${v("--grid-bg")};
  overflow-y: auto;
  max-height: 260px;
`;

const CategoryItem = styled.div<{ $selected: boolean }>`
  padding: 5px 10px;
  cursor: pointer;
  font-size: 13px;
  background: ${(p) => (p.$selected ? v("--accent-primary") : "transparent")};
  color: ${(p) => (p.$selected ? "#ffffff" : v("--text-primary"))};

  &:hover {
    background: ${(p) =>
      p.$selected ? v("--accent-primary") : v("--panel-bg")};
  }
`;

const FormatOptions = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const Description = styled.div`
  font-size: 11px;
  color: ${v("--text-secondary")};
  line-height: 1.4;
  padding: 8px;
  background: ${v("--grid-bg")};
  border-radius: 4px;
  border: 1px solid ${v("--border-default")};
`;

const FormatInput = styled.input`
  font-family: "Consolas", monospace;
  font-size: 13px;
  padding: 6px 8px;
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  background: ${v("--grid-bg")};
  color: ${v("--text-primary")};
  outline: none;

  &:focus {
    border-color: ${v("--accent-primary")};
  }
`;

const FormatList = styled.div`
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  background: ${v("--grid-bg")};
  overflow-y: auto;
  max-height: 140px;
`;

const FormatItem = styled.div<{ $selected: boolean }>`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 5px 10px;
  cursor: pointer;
  font-size: 13px;
  background: ${(p) => (p.$selected ? v("--accent-primary") : "transparent")};
  color: ${(p) => (p.$selected ? "#ffffff" : v("--text-primary"))};

  &:hover {
    background: ${(p) =>
      p.$selected ? v("--accent-primary") : v("--panel-bg")};
  }
`;

const FormatLabel = styled.span``;

const FormatExample = styled.span`
  font-size: 11px;
  opacity: 0.7;
  font-family: "Consolas", monospace;
`;

const PreviewSection = styled.div`
  margin-top: auto;
`;

const PreviewBox = styled.div`
  padding: 8px 12px;
  background: ${v("--grid-bg")};
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  font-family: "Consolas", monospace;
  font-size: 14px;
  color: ${v("--text-primary")};
  text-align: right;
`;
