//! FILENAME: app/extensions/ConditionalFormatting/components/NewRuleDialog.tsx
// PURPOSE: Comprehensive "New Formatting Rule" dialog modeled after Excel's dialog.
// CONTEXT: Opened from Format > Conditional Formatting > New Rule...

import React, { useState, useCallback } from "react";
import type { DialogProps } from "../../../src/api";
import {
  addConditionalFormat,
  restoreFocusToGrid,
} from "../../../src/api";
import type {
  ConditionalFormatRule,
  ConditionalFormat,
  ConditionalFormatRange,
  CellValueOperator,
  TextRuleType,
  TopBottomType,
  AverageRuleType,
  IconSetType,
} from "../../../src/api";
import { invalidateAndRefresh } from "../lib/cfStore";
import { PRESET_STYLES, PRESET_COLOR_SCALES, PRESET_DATA_BAR_COLORS } from "../types";

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

// ============================================================================
// Category definitions
// ============================================================================

type RuleCategory =
  | "formatByValues"
  | "formatContaining"
  | "topBottom"
  | "aboveBelow"
  | "uniqueDuplicate"
  | "formula";

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

const ICON_SET_OPTIONS: { value: IconSetType; label: string }[] = [
  { value: "threeTrafficLights1", label: "3 Traffic Lights" },
  { value: "threeArrows", label: "3 Arrows" },
  { value: "threeFlags", label: "3 Flags" },
  { value: "threeStars", label: "3 Stars" },
  { value: "threeTriangles", label: "3 Triangles" },
  { value: "threeSigns", label: "3 Signs" },
  { value: "threeSymbols", label: "3 Symbols" },
  { value: "fourArrows", label: "4 Arrows" },
  { value: "fourTrafficLights", label: "4 Traffic Lights" },
  { value: "fourRating", label: "4 Ratings" },
  { value: "fiveArrows", label: "5 Arrows" },
  { value: "fiveRating", label: "5 Ratings" },
  { value: "fiveQuarters", label: "5 Quarters" },
  { value: "fiveBoxes", label: "5 Boxes" },
];

// ============================================================================
// Component
// ============================================================================

export const NewRuleDialog: React.FC<DialogProps> = ({ isOpen, onClose, data }) => {
  const selection = data?.selection as ConditionalFormatRange | null;

  // Category selection
  const [selectedCategory, setSelectedCategory] = useState<RuleCategory>("formatContaining");

  // Format preset
  const [formatIndex, setFormatIndex] = useState(0);

  // --- formatByValues state ---
  const [formatByValuesType, setFormatByValuesType] = useState<"colorScale" | "dataBar" | "iconSet">("colorScale");
  const [colorScalePresetIndex, setColorScalePresetIndex] = useState(0);
  const [dataBarColorIndex, setDataBarColorIndex] = useState(0);
  const [iconSetType, setIconSetType] = useState<IconSetType>("threeTrafficLights1");

  // --- formatContaining state ---
  const [containingType, setContainingType] = useState<"cellValue" | "text" | "blanks" | "noBlanks" | "errors" | "noErrors">("cellValue");
  const [cellValueOperator, setCellValueOperator] = useState<CellValueOperator>("greaterThan");
  const [cellValue1, setCellValue1] = useState("");
  const [cellValue2, setCellValue2] = useState("");
  const [textRuleType, setTextRuleType] = useState<TextRuleType>("contains");
  const [textValue, setTextValue] = useState("");

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
        if (formatByValuesType === "colorScale") {
          const preset = PRESET_COLOR_SCALES[colorScalePresetIndex];
          rule = {
            type: "colorScale",
            minPoint: { valueType: "autoMin", color: preset.minColor },
            ...(preset.midColor
              ? { midPoint: { valueType: "percent", value: 50, color: preset.midColor } }
              : {}),
            maxPoint: { valueType: "autoMax", color: preset.maxColor },
          } as ConditionalFormatRule;
        } else if (formatByValuesType === "dataBar") {
          rule = {
            type: "dataBar",
            minValueType: "autoMin",
            maxValueType: "autoMax",
            fillColor: PRESET_DATA_BAR_COLORS[dataBarColorIndex],
            axisPosition: "automatic",
            direction: "context",
            showValue: true,
            gradientFill: true,
          } as ConditionalFormatRule;
        } else {
          // Determine threshold count based on icon set type
          const thresholdCount = iconSetType.startsWith("five") ? 4
            : iconSetType.startsWith("four") ? 3
            : 2;
          const thresholds = [];
          for (let i = 0; i < thresholdCount; i++) {
            const pct = Math.round(((i + 1) / (thresholdCount + 1)) * 100);
            thresholds.push({ valueType: "percent" as const, value: pct, operator: "greaterThanOrEqual" as const });
          }
          rule = {
            type: "iconSet",
            iconSet: iconSetType,
            thresholds,
            reverseIcons: false,
            showIconOnly: false,
          } as ConditionalFormatRule;
        }
        break;

      case "formatContaining": {
        const preset = PRESET_STYLES[formatIndex];
        format = { backgroundColor: preset.backgroundColor || undefined, textColor: preset.textColor || undefined };
        if (containingType === "cellValue") {
          rule = { type: "cellValue", operator: cellValueOperator, value1: cellValue1, value2: cellValue2 || undefined };
        } else if (containingType === "text") {
          rule = { type: "containsText", ruleType: textRuleType, text: textValue };
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

    await addConditionalFormat({
      rule,
      format,
      ranges: [selection],
      stopIfTrue: false,
    });

    await invalidateAndRefresh();
    onClose();
    restoreFocusToGrid();
  }, [
    selectedCategory, selection, onClose, formatIndex,
    formatByValuesType, colorScalePresetIndex, dataBarColorIndex, iconSetType,
    containingType, cellValueOperator, cellValue1, cellValue2, textRuleType, textValue,
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
        <div style={categoryListStyle}>
          {RULE_CATEGORIES.map((cat) => (
            <div
              key={cat.id}
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
                  onChange={(e) => setFormatByValuesType(e.target.value as "colorScale" | "dataBar" | "iconSet")}
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
                      <option key={i} value={i}>{p.label}</option>
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
                    {PRESET_DATA_BAR_COLORS.map((c, i) => (
                      <option key={i} value={i}>{c}</option>
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

        <div style={buttonRowStyle}>
          <button style={buttonStyle} onClick={handleCancel}>Cancel</button>
          <button style={primaryButtonStyle} onClick={handleOk}>OK</button>
        </div>
      </div>
    </div>
  );
};
