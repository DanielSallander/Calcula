//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/tabs/NumberTab.tsx
// PURPOSE: Number format tab for the Format Cells dialog.

import React, { useState } from "react";
import styled from "styled-components";
import { useFormatCellsStore } from "../hooks/useFormatCellsState";
import {
  NUMBER_FORMAT_CATEGORIES,
  type NumberFormatCategory,
} from "../utils/numberFormats";

const v = (name: string) => `var(${name})`;

export function NumberTab(): React.ReactElement {
  const { numberFormat, setNumberFormat } = useFormatCellsStore();

  // Find which category the current format belongs to
  const findCurrentCategory = (): string => {
    for (const cat of NUMBER_FORMAT_CATEGORIES) {
      for (const fmt of cat.formats) {
        if (fmt.value === numberFormat || fmt.value === numberFormat.toLowerCase()) {
          return cat.id;
        }
      }
    }
    return "general";
  };

  const [selectedCategory, setSelectedCategory] = useState(findCurrentCategory);

  const currentCategory = NUMBER_FORMAT_CATEGORIES.find(
    (c) => c.id === selectedCategory
  );

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

              <SectionLabel>Format:</SectionLabel>
              <FormatList>
                {currentCategory.formats.map((fmt) => (
                  <FormatItem
                    key={fmt.value}
                    $selected={numberFormat === fmt.value ||
                      numberFormat.toLowerCase() === fmt.value}
                    onClick={() => setNumberFormat(fmt.value)}
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
