//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/tabs/NumberTab.tsx
// PURPOSE: Number format tab for the Format Cells dialog.

import React, { useState, useEffect, useRef, useCallback } from "react";
import styled from "styled-components";
import { useFormatCellsStore } from "../hooks/useFormatCellsState";
import {
  NUMBER_FORMAT_CATEGORIES,
  getNumberFormatCategories,
  normalizeToPresetValue,
  categoryForFormat,
} from "../utils/numberFormats";
import type { NumberFormatCategory } from "../utils/numberFormats";
import {
  previewNumberFormat,
  getCachedLocale,
  getLocaleSettings,
  onLocaleChanged,
} from "@api";
import type { LocaleSettings } from "@api";

const v = (name: string) => `var(${name})`;

/**
 * Categories with the CURRENT locale's separators baked into every label and
 * example. BUG-0064: the tab used the static US-default NUMBER_FORMAT_CATEGORIES,
 * so on a sv-SE document the dialog advertised "1,234.00" while clicking it
 * produced "1 234,00" -- the sample text lied about the result. Excel's samples
 * are locale-correct; getNumberFormatCategories(dec, thou) existed for exactly
 * this and had no production caller passing the locale.
 */
function localeCategories(loc: LocaleSettings | null): NumberFormatCategory[] {
  if (!loc) return NUMBER_FORMAT_CATEGORIES;
  return getNumberFormatCategories(loc.decimalSeparator, loc.thousandsSeparator);
}

export function NumberTab(): React.ReactElement {
  const { numberFormat, setNumberFormat } = useFormatCellsStore();

  const [categories, setCategories] = useState<NumberFormatCategory[]>(() =>
    localeCategories(getCachedLocale())
  );
  useEffect(() => {
    let live = true;
    if (!getCachedLocale()) {
      getLocaleSettings()
        .then((loc) => { if (live) setCategories(localeCategories(loc)); })
        .catch(() => { /* keep defaults if locale cannot be read */ });
    }
    const unsubscribe = onLocaleChanged((loc) => {
      if (live) setCategories(localeCategories(loc));
    });
    return () => { live = false; unsubscribe(); };
  }, []);

  // Which category the current format belongs to. categoryForFormat also
  // understands the backend DISPLAY NAMES get_style emits ("Date (yyyy-mm-dd)")
  // -- before BUG-0065 the dialog compared them against preset values, so a
  // formatted cell always reopened on General with nothing highlighted.
  const findCurrentCategory = (): string => categoryForFormat(numberFormat);

  const [selectedCategory, setSelectedCategory] = useState(findCurrentCategory);
  const [customInput, setCustomInput] = useState(() => {
    // If already a custom format, initialize with it
    if (findCurrentCategory() === "custom") return numberFormat;
    return "";
  });

  // The dialog loads the cell's style asynchronously AFTER mount
  // (FormatCellsDialog.loadCurrentStyle), so re-derive the selected category
  // when the format lands or changes. Selecting a preset maps to its own
  // category, so this never yanks the user away while browsing categories.
  useEffect(() => {
    const next = categoryForFormat(numberFormat);
    setSelectedCategory((prev) => (prev === next ? prev : next));
    if (next === "custom") setCustomInput(numberFormat);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- track the format only
  }, [numberFormat]);
  const [preview, setPreview] = useState<{ display: string; color?: string }>({ display: "Sample" });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentCategory = categories.find(
    (c) => c.id === selectedCategory
  );

  // The store may hold a preset value ("number_sep") or the backend display
  // name the dialog loaded ("Number (2 decimals, with separators)"); both
  // must light the same preset row.
  const currentPresetValue = normalizeToPresetValue(numberFormat);

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
            {categories.map((cat) => (
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
                        $selected={currentPresetValue === fmt.value}
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
                        (f) => f.value === currentPresetValue
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
