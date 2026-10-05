//! FILENAME: app/extensions/ConditionalFormatting/components/NewRuleDialog.tsx
// PURPOSE: Comprehensive "New Formatting Rule" dialog modeled after Excel's dialog.
// CONTEXT: Opened from Conditional Formatting > New Rule... and from every
//          "More Rules..." row (the Format menu and the Home tab show the same
//          tree). Each door names the page it opens on (NewRuleDialogData in
//          ../types.ts), as Excel's do: the item and Highlight Cells Rules >
//          More Rules... on "Format only cells that contain", Top/Bottom Rules >
//          More Rules... on the ranked-values page, and each gallery's More
//          Rules... on "Format all cells based on their values" with the
//          gallery's own format style. It used to open on "Format only cells
//          that contain" whichever door was used.
//
//          The colour-scale / data-bar / icon-set rules come from the SAME
//          builders the galleries use (../lib/presetRules.ts), so a preset
//          written here and the same preset picked from a gallery are the same
//          rule. A refusal keeps the dialog open with the reason in an alert
//          line (it used to escape as an unhandled promise rejection).

import React, { useState, useCallback } from "react";
import type { DialogProps, TimePeriod } from "@api";
import { restoreFocusToGrid } from "@api";
import type {
  ConditionalFormatRule,
  ConditionalFormat,
  ConditionalFormatRange,
  CellValueOperator,
  TextRuleType,
  TopBottomType,
  AverageRuleType,
  IconSetType,
} from "@api";
import { tryAddRule } from "../lib/ruleWrites";
import { colorScaleRule, dataBarRule, iconSetRule } from "../lib/presetRules";
import {
  PRESET_STYLES,
  PRESET_COLOR_SCALES,
  PRESET_DATA_BARS,
  PRESET_DATA_BAR_COLORS,
  DATE_OCCURRING_PERIODS,
  ICON_SET_CATEGORIES,
  colorScaleName,
  type NewRuleCategory,
  type NewRuleFormatStyle,
} from "../types";

// ============================================================================
// Styles
// ============================================================================

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: "rgba(0, 0, 0, 0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 9500,
};

const dialogStyle: React.CSSProperties = {
  backgroundColor: "#f0f0f0",
  color: "#333",
  border: "1px solid #888",
  borderRadius: 4,
  boxShadow: "0 4px 16px rgba(0, 0, 0, 0.3)",
  width: 560,
  maxHeight: "85vh",
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 12,
  overflow: "hidden",
};

const titleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  margin: 0,
};

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#444",
  margin: 0,
};

const categoryListStyle: React.CSSProperties = {
  border: "1px solid #ccc",
  borderRadius: 3,
  backgroundColor: "#fff",
  maxHeight: 160,
  overflowY: "auto",
};

const categoryItemStyle: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: 13,
  cursor: "pointer",
  borderBottom: "1px solid #e8e8e8",
};

const selectedCategoryStyle: React.CSSProperties = {
  ...categoryItemStyle,
  backgroundColor: "#d4e8fc",
  fontWeight: 500,
};

const configPanelStyle: React.CSSProperties = {
  border: "1px solid #ccc",
  borderRadius: 3,
  backgroundColor: "#fff",
  padding: 12,
  minHeight: 80,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const selectStyle: React.CSSProperties = {
  padding: "4px 8px",
  border: "1px solid #aaa",
  borderRadius: 3,
  fontSize: 13,
  color: "#333",
  backgroundColor: "#fff",
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: "4px 8px",
  border: "1px solid #aaa",
  borderRadius: 3,
  fontSize: 13,
  color: "#333",
  backgroundColor: "#fff",
};

const buttonRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: 4,
};

const buttonStyle: React.CSSProperties = {
  padding: "5px 16px",
  border: "1px solid #aaa",
  borderRadius: 3,
  fontSize: 13,
  cursor: "pointer",
  backgroundColor: "#fff",
  color: "#333",
};

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  backgroundColor: "#0078d4",
  color: "#fff",
  borderColor: "#0060b0",
};

const errorStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#a4262c",
  backgroundColor: "#fde7e9",
  border: "1px solid #f1bbbc",
  borderRadius: 3,
  padding: "6px 8px",
};

// ============================================================================
// Category definitions
// ============================================================================

type RuleCategory = NewRuleCategory;

/** Where New Rule opens when the door names no page: Excel's default. */
const DEFAULT_CATEGORY: RuleCategory = "formatContaining";

const FORMAT_STYLES: readonly NewRuleFormatStyle[] = ["colorScale", "dataBar", "iconSet"];

const RULE_CATEGORIES: { id: RuleCategory; label: string }[] = [
  { id: "formatByValues", label: "Format all cells based on their values" },
  { id: "formatContaining", label: "Format only cells that contain" },
  { id: "topBottom", label: "Format only top or bottom ranked values" },
  { id: "aboveBelow", label: "Format only values that are above or below average" },
  { id: "uniqueDuplicate", label: "Format only unique or duplicate values" },
  { id: "formula", label: "Use a formula to determine which cells to format" },
];

const CELL_VALUE_OPERATORS: { value: CellValueOperator; label: string }[] = [
  { value: "greaterThan", label: "greater than" },
  { value: "greaterThanOrEqual", label: "greater than or equal to" },
  { value: "lessThan", label: "less than" },
  { value: "lessThanOrEqual", label: "less than or equal to" },
  { value: "equal", label: "equal to" },
  { value: "notEqual", label: "not equal to" },
  { value: "between", label: "between" },
  { value: "notBetween", label: "not between" },
];

const TEXT_RULE_TYPES: { value: TextRuleType; label: string }[] = [
  { value: "contains", label: "containing" },
  { value: "notContains", label: "not containing" },
  { value: "beginsWith", label: "beginning with" },
  { value: "endsWith", label: "ending with" },
];

const TOP_BOTTOM_TYPES: { value: TopBottomType; label: string }[] = [
  { value: "topItems", label: "Top" },
  { value: "topPercent", label: "Top %" },
  { value: "bottomItems", label: "Bottom" },
  { value: "bottomPercent", label: "Bottom %" },
];

const AVERAGE_TYPES: { value: AverageRuleType; label: string }[] = [
  { value: "aboveAverage", label: "Above Average" },
  { value: "belowAverage", label: "Below Average" },
  { value: "equalOrAboveAverage", label: "Equal or Above Average" },
  { value: "equalOrBelowAverage", label: "Equal or Below Average" },
  { value: "oneStdDevAbove", label: "1 Std Dev Above" },
  { value: "oneStdDevBelow", label: "1 Std Dev Below" },
  { value: "twoStdDevAbove", label: "2 Std Dev Above" },
  { value: "twoStdDevBelow", label: "2 Std Dev Below" },
  { value: "threeStdDevAbove", label: "3 Std Dev Above" },
  { value: "threeStdDevBelow", label: "3 Std Dev Below" },
];

/** Every icon set, by Excel's name, in the gallery's order (one list, ../types.ts). */
const ICON_SET_OPTIONS: { value: IconSetType; label: string }[] = ICON_SET_CATEGORIES.flatMap((category) =>
  category.sets.map((set) => ({ value: set.id, label: set.label })),
);

// ============================================================================
// Component
// ============================================================================

/** The page a door asked for, or Excel's default for anything else. */
function initialCategoryOf(data: Record<string, unknown> | undefined): RuleCategory {
  const asked = data?.initialCategory;
  return RULE_CATEGORIES.some((c) => c.id === asked) ? (asked as RuleCategory) : DEFAULT_CATEGORY;
}

/** The format style a gallery's More Rules... asked for, else Color Scale. */
function initialFormatStyleOf(data: Record<string, unknown> | undefined): NewRuleFormatStyle {
  const asked = data?.initialFormatStyle;
  return FORMAT_STYLES.includes(asked as NewRuleFormatStyle) ? (asked as NewRuleFormatStyle) : "colorScale";
}

export const NewRuleDialog: React.FC<DialogProps> = ({ isOpen, onClose, data }) => {
  const selection = data?.selection as ConditionalFormatRange | null;

  // Category selection: the page the door asked for (the dialog mounts per
  // opening, so the data is read once, here).
  const [selectedCategory, setSelectedCategory] = useState<RuleCategory>(() => initialCategoryOf(data));

  // Format preset
  const [formatIndex, setFormatIndex] = useState(0);

  // --- formatByValues state ---
  const [formatByValuesType, setFormatByValuesType] = useState<NewRuleFormatStyle>(() => initialFormatStyleOf(data));
  const [colorScalePresetIndex, setColorScalePresetIndex] = useState(0);
  const [dataBarColorIndex, setDataBarColorIndex] = useState(0);
  const [iconSetType, setIconSetType] = useState<IconSetType>("threeTrafficLights1");

  // --- formatContaining state ---
  const [containingType, setContainingType] = useState<"cellValue" | "text" | "dates" | "blanks" | "noBlanks" | "errors" | "noErrors">("cellValue");
  const [cellValueOperator, setCellValueOperator] = useState<CellValueOperator>("greaterThan");
  const [cellValue1, setCellValue1] = useState("");
  const [cellValue2, setCellValue2] = useState("");
  const [textRuleType, setTextRuleType] = useState<TextRuleType>("contains");
  const [textValue, setTextValue] = useState("");
  const [datePeriod, setDatePeriod] = useState<TimePeriod>(DATE_OCCURRING_PERIODS[0].value);

  // A refusal stays on screen; OK is inert while a write is in flight.
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // --- topBottom state ---
  const [topBottomType, setTopBottomType] = useState<TopBottomType>("topItems");
  const [topBottomRank, setTopBottomRank] = useState("10");

  // --- aboveBelow state ---
  const [averageType, setAverageType] = useState<AverageRuleType>("aboveAverage");

  // --- uniqueDuplicate state ---
  const [dupUniqueType, setDupUniqueType] = useState<"duplicateValues" | "uniqueValues">("duplicateValues");

  // --- formula state ---
  const [formulaExpression, setFormulaExpression] = useState("");

  // Whether this category uses the format preset selector
  const usesFormatPreset = selectedCategory !== "formatByValues";

  const handleOk = useCallback(async () => {
    if (!selection) {
      onClose();
      return;
    }

    let rule: ConditionalFormatRule;
    let format: ConditionalFormat = {};

    switch (selectedCategory) {
      case "formatByValues":
        // The galleries' own builders: one preset, one rule, whichever door.
        if (formatByValuesType === "colorScale") {
          rule = colorScaleRule(PRESET_COLOR_SCALES[colorScalePresetIndex]);
        } else if (formatByValuesType === "dataBar") {
          rule = dataBarRule(PRESET_DATA_BAR_COLORS[dataBarColorIndex], true);
        } else {
          const iconCount = iconSetType.startsWith("five") ? 5
            : iconSetType.startsWith("four") ? 4
            : 3;
          rule = iconSetRule(iconSetType, iconCount);
        }
        break;

      case "formatContaining": {
        const preset = PRESET_STYLES[formatIndex];
        format = { backgroundColor: preset.backgroundColor || undefined, textColor: preset.textColor || undefined };
        if (containingType === "cellValue") {
          rule = { type: "cellValue", operator: cellValueOperator, value1: cellValue1, value2: cellValue2 || undefined };
        } else if (containingType === "text") {
          rule = { type: "containsText", ruleType: textRuleType, text: textValue };
        } else if (containingType === "dates") {
          rule = { type: "timePeriod", period: datePeriod };
        } else if (containingType === "blanks") {
          rule = { type: "blankCells" };
        } else if (containingType === "noBlanks") {
          rule = { type: "noBlanks" };
        } else if (containingType === "errors") {
          rule = { type: "errorCells" };
        } else {
          rule = { type: "noErrors" };
        }
        break;
      }

      case "topBottom": {
        const preset = PRESET_STYLES[formatIndex];
        format = { backgroundColor: preset.backgroundColor || undefined, textColor: preset.textColor || undefined };
        rule = { type: "topBottom", ruleType: topBottomType, rank: parseInt(topBottomRank) || 10 };
        break;
      }

      case "aboveBelow": {
        const preset = PRESET_STYLES[formatIndex];
        format = { backgroundColor: preset.backgroundColor || undefined, textColor: preset.textColor || undefined };
        rule = { type: "aboveAverage", ruleType: averageType };
        break;
      }

      case "uniqueDuplicate": {
        const preset = PRESET_STYLES[formatIndex];
        format = { backgroundColor: preset.backgroundColor || undefined, textColor: preset.textColor || undefined };
        rule = { type: dupUniqueType };
        break;
      }

      case "formula": {
        const preset = PRESET_STYLES[formatIndex];
        format = { backgroundColor: preset.backgroundColor || undefined, textColor: preset.textColor || undefined };
        rule = { type: "expression", formula: formulaExpression };
        break;
      }

      default:
        onClose();
        return;
    }

    if (busy) return;
    setBusy(true);
    setRefusal(null);
    const refused = await tryAddRule({
      rule,
      format,
      ranges: [selection],
      stopIfTrue: false,
    });
    setBusy(false);
    if (refused !== null) {
      // Stay open: the user can correct the rule and press OK again.
      setRefusal(refused);
      return;
    }
    onClose();
    restoreFocusToGrid();
  }, [
    selectedCategory, selection, onClose, formatIndex, busy,
    formatByValuesType, colorScalePresetIndex, dataBarColorIndex, iconSetType,
    containingType, cellValueOperator, cellValue1, cellValue2, textRuleType, textValue, datePeriod,
    topBottomType, topBottomRank, averageType, dupUniqueType, formulaExpression,
  ]);

  const handleCancel = useCallback(() => {
    onClose();
    restoreFocusToGrid();
  }, [onClose]);

  if (!isOpen) return null;

  const needsSecondValue = cellValueOperator === "between" || cellValueOperator === "notBetween";

  return (
    <div style={overlayStyle} onMouseDown={(e) => { if (e.target === e.currentTarget) handleCancel(); }}>
      <div
        style={dialogStyle}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") handleCancel();
          if (e.key === "Enter" && !(e.target instanceof HTMLSelectElement)) handleOk();
        }}
      >
        <h3 style={titleStyle}>New Formatting Rule</h3>

        {/* Rule type selector */}
        <p style={sectionLabelStyle}>Select a Rule Type:</p>
        <div style={categoryListStyle} role="listbox" aria-label="Select a Rule Type">
          {RULE_CATEGORIES.map((cat) => (
            <div
              key={cat.id}
              role="option"
              aria-selected={selectedCategory === cat.id}
              data-rule-category={cat.id}
              style={selectedCategory === cat.id ? selectedCategoryStyle : categoryItemStyle}
              onClick={() => setSelectedCategory(cat.id)}
            >
              {cat.label}
            </div>
          ))}
        </div>

        {/* Configuration panel */}
        <p style={sectionLabelStyle}>Edit the Rule Description:</p>
        <div style={configPanelStyle}>

          {/* ===== Format by Values ===== */}
          {selectedCategory === "formatByValues" && (
            <>
              <div style={rowStyle}>
                <span style={{ fontSize: 13 }}>Format style:</span>
                <select
                  style={selectStyle}
                  value={formatByValuesType}
                  onChange={(e) => setFormatByValuesType(e.target.value as NewRuleFormatStyle)}
                >
                  <option value="colorScale">Color Scale</option>
                  <option value="dataBar">Data Bar</option>
                  <option value="iconSet">Icon Set</option>
                </select>
              </div>

              {formatByValuesType === "colorScale" && (
                <div style={rowStyle}>
                  <span style={{ fontSize: 13 }}>Preset:</span>
                  <select
                    style={{ ...selectStyle, flex: 1 }}
                    value={colorScalePresetIndex}
                    onChange={(e) => setColorScalePresetIndex(Number(e.target.value))}
                  >
                    {PRESET_COLOR_SCALES.map((p, i) => (
                      <option key={i} value={i}>{colorScaleName(p)}</option>
                    ))}
                  </select>
                </div>
              )}

              {formatByValuesType === "dataBar" && (
                <div style={rowStyle}>
                  <span style={{ fontSize: 13 }}>Bar color:</span>
                  <select
                    style={{ ...selectStyle, flex: 1 }}
                    value={dataBarColorIndex}
                    onChange={(e) => setDataBarColorIndex(Number(e.target.value))}
                  >
                    {PRESET_DATA_BARS.map((bar, i) => (
                      <option key={i} value={i}>{bar.name}</option>
                    ))}
                  </select>
                  <div style={{
                    width: 24, height: 16, borderRadius: 2,
                    border: "1px solid #aaa",
                    backgroundColor: PRESET_DATA_BAR_COLORS[dataBarColorIndex],
                  }} />
                </div>
              )}

              {formatByValuesType === "iconSet" && (
                <div style={rowStyle}>
                  <span style={{ fontSize: 13 }}>Icon set:</span>
                  <select
                    style={{ ...selectStyle, flex: 1 }}
                    value={iconSetType}
                    onChange={(e) => setIconSetType(e.target.value as IconSetType)}
                  >
                    {ICON_SET_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}

          {/* ===== Format Containing ===== */}
          {selectedCategory === "formatContaining" && (
            <>
              <div style={rowStyle}>
                <span style={{ fontSize: 13 }}>Format only cells with:</span>
                <select
                  style={selectStyle}
                  value={containingType}
                  onChange={(e) => setContainingType(e.target.value as typeof containingType)}
                >
                  <option value="cellValue">Cell Value</option>
                  <option value="text">Specific Text</option>
                  <option value="dates">Dates Occurring</option>
                  <option value="blanks">Blanks</option>
                  <option value="noBlanks">No Blanks</option>
                  <option value="errors">Errors</option>
                  <option value="noErrors">No Errors</option>
                </select>
              </div>

              {containingType === "cellValue" && (
                <>
                  <div style={rowStyle}>
                    <select
                      style={selectStyle}
                      value={cellValueOperator}
                      onChange={(e) => setCellValueOperator(e.target.value as CellValueOperator)}
                    >
                      {CELL_VALUE_OPERATORS.map((op) => (
                        <option key={op.value} value={op.value}>{op.label}</option>
                      ))}
                    </select>
                    <input
                      type="text"
                      style={inputStyle}
                      value={cellValue1}
                      onChange={(e) => setCellValue1(e.target.value)}
                      placeholder="Value"
                    />
                  </div>
                  {needsSecondValue && (
                    <div style={rowStyle}>
                      <span style={{ fontSize: 13 }}>and</span>
                      <input
                        type="text"
                        style={inputStyle}
                        value={cellValue2}
                        onChange={(e) => setCellValue2(e.target.value)}
                        placeholder="Value"
                      />
                    </div>
                  )}
                </>
              )}

              {containingType === "text" && (
                <div style={rowStyle}>
                  <select
                    style={selectStyle}
                    value={textRuleType}
                    onChange={(e) => setTextRuleType(e.target.value as TextRuleType)}
                  >
                    {TEXT_RULE_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    style={inputStyle}
                    value={textValue}
                    onChange={(e) => setTextValue(e.target.value)}
                    placeholder="Text"
                  />
                </div>
              )}

              {containingType === "dates" && (
                <div style={rowStyle}>
                  <select
                    style={{ ...selectStyle, flex: 1 }}
                    value={datePeriod}
                    onChange={(e) => setDatePeriod(e.target.value as TimePeriod)}
                  >
                    {DATE_OCCURRING_PERIODS.map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}

          {/* ===== Top/Bottom ===== */}
          {selectedCategory === "topBottom" && (
            <div style={rowStyle}>
              <span style={{ fontSize: 13 }}>Format cells that rank in the</span>
              <select
                style={selectStyle}
                value={topBottomType}
                onChange={(e) => setTopBottomType(e.target.value as TopBottomType)}
              >
                {TOP_BOTTOM_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
              <input
                type="number"
                style={{ ...inputStyle, flex: "none", width: 60 }}
                value={topBottomRank}
                onChange={(e) => setTopBottomRank(e.target.value)}
                min={1}
              />
            </div>
          )}

          {/* ===== Above/Below Average ===== */}
          {selectedCategory === "aboveBelow" && (
            <div style={rowStyle}>
              <span style={{ fontSize: 13 }}>Format cells that are:</span>
              <select
                style={{ ...selectStyle, flex: 1 }}
                value={averageType}
                onChange={(e) => setAverageType(e.target.value as AverageRuleType)}
              >
                {AVERAGE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
          )}

          {/* ===== Unique / Duplicate ===== */}
          {selectedCategory === "uniqueDuplicate" && (
            <div style={rowStyle}>
              <span style={{ fontSize: 13 }}>Format</span>
              <select
                style={selectStyle}
                value={dupUniqueType}
                onChange={(e) => setDupUniqueType(e.target.value as "duplicateValues" | "uniqueValues")}
              >
                <option value="duplicateValues">Duplicate</option>
                <option value="uniqueValues">Unique</option>
              </select>
              <span style={{ fontSize: 13 }}>values in the selected range</span>
            </div>
          )}

          {/* ===== Formula ===== */}
          {selectedCategory === "formula" && (
            <div style={rowStyle}>
              <span style={{ fontSize: 13 }}>Format values where this formula is true:</span>
            </div>
          )}
          {selectedCategory === "formula" && (
            <div style={rowStyle}>
              <input
                type="text"
                style={inputStyle}
                value={formulaExpression}
                onChange={(e) => setFormulaExpression(e.target.value)}
                placeholder="=A1>100"
                autoFocus
              />
            </div>
          )}
        </div>

        {/* Format preset selector (not for formatByValues) */}
        {usesFormatPreset && (
          <>
            <div style={rowStyle}>
              <span style={{ fontSize: 13 }}>Format with:</span>
              <select
                style={{ ...selectStyle, flex: 1 }}
                value={formatIndex}
                onChange={(e) => setFormatIndex(Number(e.target.value))}
              >
                {PRESET_STYLES.map((preset, idx) => (
                  <option key={idx} value={idx}>{preset.label}</option>
                ))}
              </select>
            </div>

            {/* Format preview */}
            <div
              style={{
                padding: "6px 12px",
                borderRadius: 3,
                border: "1px solid #ccc",
                fontSize: 13,
                backgroundColor: PRESET_STYLES[formatIndex].backgroundColor || "#fff",
                color: PRESET_STYLES[formatIndex].textColor || "#000",
              }}
            >
              AaBbCcYyZz
            </div>
          </>
        )}

        {/* Color scale preview for formatByValues */}
        {selectedCategory === "formatByValues" && formatByValuesType === "colorScale" && (
          <div style={{
            height: 20,
            borderRadius: 3,
            border: "1px solid #ccc",
            background: (() => {
              const p = PRESET_COLOR_SCALES[colorScalePresetIndex];
              if (p.midColor) {
                return `linear-gradient(to right, ${p.minColor}, ${p.midColor}, ${p.maxColor})`;
              }
              return `linear-gradient(to right, ${p.minColor}, ${p.maxColor})`;
            })(),
          }} />
        )}

        {/* Data bar preview for formatByValues */}
        {selectedCategory === "formatByValues" && formatByValuesType === "dataBar" && (
          <div style={{
            height: 20,
            borderRadius: 3,
            border: "1px solid #ccc",
            background: `linear-gradient(to right, ${PRESET_DATA_BAR_COLORS[dataBarColorIndex]}, ${PRESET_DATA_BAR_COLORS[dataBarColorIndex]}40)`,
          }} />
        )}

        {refusal !== null && (
          <div role="alert" style={errorStyle}>
            The rule was not added: {refusal}
          </div>
        )}

        <div style={buttonRowStyle}>
          <button style={buttonStyle} onClick={handleCancel}>Cancel</button>
          <button style={primaryButtonStyle} onClick={handleOk} disabled={busy}>OK</button>
        </div>
      </div>
    </div>
  );
};
