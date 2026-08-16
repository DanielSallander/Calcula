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
  withRibbonPresets,
  NEGATIVE_STYLE_OPTIONS,
  negativeSample,
  splitNegativeSuffix,
} from "../utils/numberFormats";
import type { NumberFormatCategory, RibbonResolvedFormat } from "../utils/numberFormats";
import {
  previewNumberFormat,
  getCachedLocale,
  getLocaleSettings,
  getRibbonNumberFormats,
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

  const [locale, setLocale] = useState<LocaleSettings | null>(() => getCachedLocale());
  /**
   * The ribbon's eleven entries, RESOLVED BY THE BACKEND for this locale.
   *
   * The dialog needs them for two things it cannot do on its own: recognise a
   * format the Home > Number dropdown applied (their display names are
   * regional -- `Date (YYYY-MM-DD)` on sv-SE, `Date (m/d/yyyy)` on en-US), and
   * show the locale-responsive rows Excel puts at the top of its Date, Time,
   * Currency and Accounting lists. Inverting either in TypeScript is what left
   * three of the eleven unreportable here.
   *
   * Empty until the response lands, and empty forever if it fails: every
   * fallback below is the previous behaviour, so a backend that cannot answer
   * costs the regional rows and nothing else.
   */
  const [ribbon, setRibbon] = useState<RibbonResolvedFormat[]>([]);

  const [categories, setCategories] = useState<NumberFormatCategory[]>(() =>
    localeCategories(getCachedLocale())
  );
  useEffect(() => {
    let live = true;
    if (!getCachedLocale()) {
      getLocaleSettings()
        .then((loc) => { if (live) setLocale(loc); })
        .catch(() => { /* keep defaults if locale cannot be read */ });
    }
    const unsubscribe = onLocaleChanged((loc) => {
      if (live) setLocale(loc);
    });
    return () => { live = false; unsubscribe(); };
  }, []);

  // Re-resolve the ribbon presets whenever the locale changes: their whole
  // point is that they are regional.
  useEffect(() => {
    let live = true;
    getRibbonNumberFormats()
      .then((rows) => { if (live) setRibbon(rows); })
      .catch(() => { /* regional rows are an enhancement, never a requirement */ });
    return () => { live = false; };
  }, [locale]);

  useEffect(() => {
    setCategories(withRibbonPresets(localeCategories(locale), ribbon));
  }, [locale, ribbon]);

  // Which category the current format belongs to. categoryForFormat also
  // understands the backend DISPLAY NAMES get_style emits ("Date (yyyy-mm-dd)")
  // -- before BUG-0065 the dialog compared them against preset values, so a
  // formatted cell always reopened on General with nothing highlighted.
  const findCurrentCategory = (): string => categoryForFormat(numberFormat, ribbon);

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
    const next = categoryForFormat(numberFormat, ribbon);
    setSelectedCategory((prev) => (prev === next ? prev : next));
    if (next === "custom") setCustomInput(numberFormat);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- format and the
    // resolved ribbon rows; re-running when the rows land is the point.
  }, [numberFormat, ribbon]);
  const [preview, setPreview] = useState<{ display: string; color?: string }>({ display: "Sample" });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentCategory = categories.find(
    (c) => c.id === selectedCategory
  );

  // The store may hold a preset value ("number_sep") or the backend display
  // name the dialog loaded ("Number (2 decimals, with separators)"); both
  // must light the same preset row.
  const currentPresetValue = normalizeToPresetValue(numberFormat, ribbon);

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

  // ---- Excel's "Negative numbers:" list (Currency only) -------------------
  //
  // Excel shows it for the Number and Currency categories; Calcula's Number
  // preset carries no negative axis yet, so it is offered where the format can
  // actually express it. `currentPresetValue` is the COMPOSED value, so the
  // symbol rows must be highlighted by its base and this list by its suffix --
  // comparing the whole string would light neither.
  const split = splitNegativeSuffix(currentPresetValue ?? "");

  // ...AND THE BASE ONLY COUNTS WHEN IT IS A CURRENCY.
  //
  // `currentPresetValue` is whatever the CELL already carries, which on a fresh
  // cell is `"general"` and on a formatted one might be `"number_sep"` or
  // `"accounting_usd"`. Composing a negative suffix onto that produced
  // `"general_neg_paren"` — a string the backend parses as plain General
  // (the suffix only applies to a Currency) and the dialog re-categorises as
  // General, so clicking a negative entry on any non-currency cell yanked the
  // dialog back to that cell's own category and silently discarded the choice.
  const currencyRows = selectedCategory === "currency" ? currentCategory?.formats : undefined;
  const baseIsACurrencyRow = currencyRows?.some((f) => f.value === split.base) ?? false;
  const currentSymbolValue = baseIsACurrencyRow ? split.base : "";
  const negativeSuffix = baseIsACurrencyRow ? split.suffix : "";

  const currencyPositiveSample =
    currencyRows?.find((f) => f.value === currentSymbolValue)?.example ??
    currencyRows?.[0]?.example ??
    "1,234.00";

  const handlePresetClick = (value: string) => {
    if (selectedCategory === "custom") {
      setCustomInput(value);
      setNumberFormat(value);
      return;
    }
    // Choosing a SYMBOL keeps the negative choice that is already made, exactly
    // as Excel's two list boxes behave: they are independent axes of one
    // format, not a single list of twelve.
    setNumberFormat(
      selectedCategory === "currency" ? `${value}${negativeSuffix}` : value
    );
  };

  const handleNegativeClick = (suffix: string) => {
    // A negative entry is meaningless without a symbol, so clicking one while
    // the cell carries no currency yet adopts the first symbol row -- which is
    // the row the list is already showing a sample of. `currentSymbolValue` is
    // empty in exactly that case (see above), so the fallback is reachable
    // rather than dead.
    const symbol = currentSymbolValue || currencyRows?.[0]?.value;
    if (symbol) setNumberFormat(`${symbol}${suffix}`);
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
                  <SectionLabel>
                    {selectedCategory === "currency" ? "Symbol:" : "Format:"}
                  </SectionLabel>
                  <FormatList>
                    {currentCategory.formats.map((fmt) => (
                      <FormatItem
                        key={fmt.value}
                        $selected={
                          (selectedCategory === "currency"
                            ? currentSymbolValue
                            : currentPresetValue) === fmt.value
                        }
                        onClick={() => handlePresetClick(fmt.value)}
                      >
                        <FormatLabel>{fmt.label}</FormatLabel>
                        {fmt.example && (
                          <FormatExample>{fmt.example}</FormatExample>
                        )}
                      </FormatItem>
                    ))}
                  </FormatList>

                  {selectedCategory === "currency" && (
                    <>
                      <SectionLabel>Negative numbers:</SectionLabel>
                      <FormatList>
                        {NEGATIVE_STYLE_OPTIONS.map((option) => (
                          <FormatItem
                            key={option.suffix || "default"}
                            $selected={negativeSuffix === option.suffix}
                            onClick={() => handleNegativeClick(option.suffix)}
                          >
                            <FormatLabel
                              style={option.red ? { color: "#ff0000" } : undefined}
                            >
                              {negativeSample(currencyPositiveSample, option)}
                            </FormatLabel>
                            {option.red && <FormatExample>red</FormatExample>}
                          </FormatItem>
                        ))}
                      </FormatList>
                    </>
                  )}

                  <PreviewSection>
                    <SectionLabel>Preview:</SectionLabel>
                    <PreviewBox>
                      {currentCategory.formats.find(
                        (f) =>
                          f.value ===
                          (selectedCategory === "currency"
                            ? currentSymbolValue
                            : currentPresetValue)
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
