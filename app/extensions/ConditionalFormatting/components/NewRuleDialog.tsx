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
//
//          The data-bar page offers every option the painter honours
//          (BUG-0728, DataBarRuleOptions.tsx), the icon-set page Reverse Icon
//          Order and Show Icon Only; a formula typed on any page is relative to
//          the selection's ACTIVE cell and is stored for the rule's first cell
//          (BUG-0748, ../lib/ruleFormulaAnchor.ts) -- Excel's rule.
//
//          EDIT RULE (the Rules Manager's door, data.editRule): the same
//          dialog shows a STORED rule (../lib/editRuleState.ts) and OK
//          writes it back over the rule -- its formula as typed, for the
//          rule's first cell, as Excel's Edit Rule stores it [LIVE].
//
//          Opened from the Rules Manager with `data.onBuilt`, OK writes NOTHING:
//          it hands the rule to the Manager, which keeps it until its own OK or
//          Apply (Excel's Manager buffers New Rule and Edit Rule with the rest;
//          its Cancel drops them -- lane cfdvfix).

import React, { useState, useCallback } from "react";
import type { DialogProps, TimePeriod, ConditionalFormatDefinition } from "@api";
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
import { tryAddRule, tryUpdateRule, reasonOf } from "../lib/ruleWrites";
import { editStateOf, mergeEditedRule, OWN_PRESET, type RuleEditState } from "../lib/editRuleState";
import { ruleForAnchor, UNMOVABLE_FORMULA_REFUSAL, type CellPos } from "../lib/ruleFormulaAnchor";
import { DIALOG_THEME as DT } from "../../_shared/lib/dialogTheme";
import type { CellTargetRef } from "@api/cellTarget";
import { colorScaleRule, iconSetRule } from "../lib/presetRules";
import { DEFAULT_DATA_BAR_UI, dataBarRuleFromUi, type DataBarUi } from "../lib/dataBarOptions";
import { DataBarRuleOptions, DataBarPreview } from "./DataBarRuleOptions";
import {
  PRESET_STYLES,
  PRESET_COLOR_SCALES,
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
  backgroundColor: DT.overlay,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 9500,
};

const dialogStyle: React.CSSProperties = {
  backgroundColor: DT.bg,
  color: DT.text,
  border: `1px solid ${DT.border}`,
  borderRadius: 4,
  boxShadow: DT.shadow,
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
  color: DT.textSecondary,
  margin: 0,
};

const categoryListStyle: React.CSSProperties = {
  border: `1px solid ${DT.divider}`,
  borderRadius: 3,
  backgroundColor: DT.panelBg,
  maxHeight: 160,
  overflowY: "auto",
};

const categoryItemStyle: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: 13,
  cursor: "pointer",
  borderBottom: `1px solid ${DT.divider}`,
};

const selectedCategoryStyle: React.CSSProperties = {
  ...categoryItemStyle,
  backgroundColor: DT.selectedBg,
  fontWeight: 500,
};

const configPanelStyle: React.CSSProperties = {
  border: `1px solid ${DT.divider}`,
  borderRadius: 3,
  backgroundColor: DT.panelBg,
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
  border: `1px solid ${DT.inputBorder}`,
  borderRadius: 3,
  fontSize: 13,
  color: DT.inputText,
  backgroundColor: DT.inputBg,
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: "4px 8px",
  border: `1px solid ${DT.inputBorder}`,
  borderRadius: 3,
  fontSize: 13,
  color: DT.inputText,
  backgroundColor: DT.inputBg,
};

const buttonRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: 4,
};

const buttonStyle: React.CSSProperties = {
  padding: "5px 16px",
  border: `1px solid ${DT.buttonBorder}`,
  borderRadius: 3,
  fontSize: 13,
  cursor: "pointer",
  backgroundColor: DT.buttonBg,
  color: DT.buttonText,
};

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  backgroundColor: DT.primaryBg,
  color: DT.primaryText,
  borderColor: DT.primaryBg,
};

const errorStyle: React.CSSProperties = {
  fontSize: 12,
  color: DT.errorFg,
  backgroundColor: DT.errorBg,
  border: `1px solid ${DT.errorFg}`,
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

/** What OK hands the Rules Manager in its buffered mode (`data.onBuilt`). */
export interface BuiltCfRule {
  rule: ConditionalFormatRule;
  format: ConditionalFormat;
  /** A NEW rule's Applies To; absent for an edited rule (its ranges stay). */
  ranges?: ConditionalFormatRange[];
}

export const NewRuleDialog: React.FC<DialogProps> = ({ isOpen, onClose, data }) => {
  const selection = data?.selection as ConditionalFormatRange | null;
  // A floating grid's cells (P3): the rule is written with the object's target.
  const target = data?.target as CellTargetRef | undefined;
  // The selection's ACTIVE cell: a formula typed here is relative to it.
  const activeCell = (data?.activeCell as CellPos | null | undefined) ?? null;
  // EDIT RULE: the stored rule this dialog shows and writes back (the Rules
  // Manager's Edit Rule...). Opened from inside the Manager (`nested`), it
  // hands the focus back to the Manager, not the grid.
  const editRule = data?.editRule as ConditionalFormatDefinition | undefined;
  const nested = data?.nested === true;
  // The Rules Manager's buffer (see the header): OK hands the rule over.
  const onBuilt = data?.onBuilt as ((built: BuiltCfRule) => void) | undefined;
  const [init] = useState<RuleEditState | null>(() => (editRule ? editStateOf(editRule) : null));

  // Category selection: the page the door asked for (the dialog mounts per
  // opening, so the data is read once, here).
  const [selectedCategory, setSelectedCategory] = useState<RuleCategory>(() => init?.category ?? initialCategoryOf(data));

  // Format preset (OWN_PRESET: an edited rule's own format, matching no preset)
  const [formatIndex, setFormatIndex] = useState(init?.formatIndex ?? 0);

  // --- formatByValues state ---
  const [formatByValuesType, setFormatByValuesType] = useState<NewRuleFormatStyle>(() => init?.formatByValuesType ?? initialFormatStyleOf(data));
  const [colorScalePresetIndex, setColorScalePresetIndex] = useState(init?.colorScalePresetIndex ?? 0);
  // Every data-bar option Excel's page offers (BUG-0728, lib/dataBarOptions.ts).
  const [dataBar, setDataBar] = useState<DataBarUi>(init?.dataBar ?? DEFAULT_DATA_BAR_UI);
  const [iconSetType, setIconSetType] = useState<IconSetType>(init?.iconSetType ?? "threeTrafficLights1");
  // Excel's Reverse Icon Order and Show Icon Only.
  const [iconReverse, setIconReverse] = useState(init?.iconReverse ?? false);
  const [iconOnly, setIconOnly] = useState(init?.iconOnly ?? false);

  // --- formatContaining state ---
  const [containingType, setContainingType] = useState<"cellValue" | "text" | "dates" | "blanks" | "noBlanks" | "errors" | "noErrors">(init?.containingType ?? "cellValue");
  const [cellValueOperator, setCellValueOperator] = useState<CellValueOperator>(init?.cellValueOperator ?? "greaterThan");
  const [cellValue1, setCellValue1] = useState(init?.cellValue1 ?? "");
  const [cellValue2, setCellValue2] = useState(init?.cellValue2 ?? "");
  const [textRuleType, setTextRuleType] = useState<TextRuleType>(init?.textRuleType ?? "contains");
  const [textValue, setTextValue] = useState(init?.textValue ?? "");
  const [datePeriod, setDatePeriod] = useState<TimePeriod>(init?.datePeriod ?? DATE_OCCURRING_PERIODS[0].value);

  // A refusal stays on screen; OK is inert while a write is in flight.
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // --- topBottom state ---
  const [topBottomType, setTopBottomType] = useState<TopBottomType>(init?.topBottomType ?? "topItems");
  const [topBottomRank, setTopBottomRank] = useState(init?.topBottomRank ?? "10");

  // --- aboveBelow state ---
  const [averageType, setAverageType] = useState<AverageRuleType>(init?.averageType ?? "aboveAverage");

  // --- uniqueDuplicate state ---
  const [dupUniqueType, setDupUniqueType] = useState<"duplicateValues" | "uniqueValues">(init?.dupUniqueType ?? "duplicateValues");

  // --- formula state ---
  const [formulaExpression, setFormulaExpression] = useState(init?.formulaExpression ?? "");

  // Whether this category uses the format preset selector
  const usesFormatPreset = selectedCategory !== "formatByValues";

  const handleOk = useCallback(async () => {
    if (!selection && !editRule) {
      onClose();
      return;
    }

    let rule: ConditionalFormatRule;
    let format: ConditionalFormat = {};
    // The chosen preset's look, or an edited rule's own format kept whole.
    const presetFormat = (): ConditionalFormat => {
      if (formatIndex === OWN_PRESET && editRule) return { ...editRule.format };
      const preset = PRESET_STYLES[Math.max(0, formatIndex)];
      return { backgroundColor: preset.backgroundColor || undefined, textColor: preset.textColor || undefined };
    };

    switch (selectedCategory) {
      case "formatByValues":
        // The galleries' own builders: one preset, one rule, whichever door.
        if (formatByValuesType === "colorScale") {
          rule =
            colorScalePresetIndex === OWN_PRESET && editRule?.rule.type === "colorScale"
              ? editRule.rule
              : colorScaleRule(PRESET_COLOR_SCALES[Math.max(0, colorScalePresetIndex)]);
        } else if (formatByValuesType === "dataBar") {
          rule = dataBarRuleFromUi(dataBar);
        } else {
          const iconCount = iconSetType.startsWith("five") ? 5
            : iconSetType.startsWith("four") ? 4
            : 3;
          rule = { ...iconSetRule(iconSetType, iconCount), reverseIcons: iconReverse, showIconOnly: iconOnly } as ConditionalFormatRule;
        }
        break;

      case "formatContaining": {
        format = presetFormat();
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
        format = presetFormat();
        rule = { type: "topBottom", ruleType: topBottomType, rank: parseInt(topBottomRank) || 10 };
        break;
      }

      case "aboveBelow": {
        format = presetFormat();
        rule = { type: "aboveAverage", ruleType: averageType };
        break;
      }

      case "uniqueDuplicate": {
        format = presetFormat();
        rule = { type: dupUniqueType };
        break;
      }

      case "formula": {
        format = presetFormat();
        rule = { type: "expression", formula: formulaExpression };
        break;
      }

      default:
        onClose();
        return;
    }

    if (busy) return;
    if (editRule && onBuilt) {
      onBuilt({ rule: mergeEditedRule(editRule.rule, rule, colorScalePresetIndex === OWN_PRESET), format });
      onClose();
      return;
    }
    if (editRule) {
      // EDIT RULE: written over the stored rule, its formula as typed (for the
      // rule's first cell -- Excel's Edit Rule does not convert it [LIVE]),
      // with what the dialog cannot show kept (lib/editRuleState.ts).
      setBusy(true);
      setRefusal(null);
      const refusedEdit = await tryUpdateRule(
        {
          ruleId: editRule.id,
          rule: mergeEditedRule(editRule.rule, rule, colorScalePresetIndex === OWN_PRESET),
          format,
        },
        target,
      );
      setBusy(false);
      if (refusedEdit !== null) {
        setRefusal(refusedEdit);
        return;
      }
      onClose();
      if (!nested) restoreFocusToGrid();
      return;
    }
    if (!selection) return;
    setBusy(true);
    setRefusal(null);
    // What was typed is relative to the ACTIVE cell; the rule stores it for its
    // first cell (BUG-0748, Excel's rule: lib/ruleFormulaAnchor.ts).
    let stated: ConditionalFormatRule | null;
    try {
      stated = await ruleForAnchor(rule, [selection], activeCell);
    } catch (err) {
      setBusy(false);
      setRefusal(reasonOf(err));
      return;
    }
    if (stated === null) {
      setBusy(false);
      setRefusal(UNMOVABLE_FORMULA_REFUSAL);
      return;
    }
    if (onBuilt) {
      setBusy(false);
      onBuilt({ rule: stated, format, ranges: [selection] });
      onClose();
      return;
    }
    const refused = await tryAddRule(
      {
        rule: stated,
        format,
        ranges: [selection],
        stopIfTrue: false,
      },
      target,
    );
    setBusy(false);
    if (refused !== null) {
      // Stay open: the user can correct the rule and press OK again.
      setRefusal(refused);
      return;
    }
    onClose();
    if (!nested) restoreFocusToGrid();
  }, [
    selectedCategory, selection, target, activeCell, onClose, formatIndex, busy, editRule, nested, onBuilt,
    formatByValuesType, colorScalePresetIndex, dataBar, iconSetType, iconReverse, iconOnly,
    containingType, cellValueOperator, cellValue1, cellValue2, textRuleType, textValue, datePeriod,
    topBottomType, topBottomRank, averageType, dupUniqueType, formulaExpression,
  ]);

  const handleCancel = useCallback(() => {
    onClose();
    if (!nested) restoreFocusToGrid();
  }, [onClose, nested]);

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
        <h3 style={titleStyle}>{editRule ? "Edit Formatting Rule" : "New Formatting Rule"}</h3>

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
                    {init?.colorScalePresetIndex === OWN_PRESET && (
                      <option value={OWN_PRESET}>The rule's own colours</option>
                    )}
                    {PRESET_COLOR_SCALES.map((p, i) => (
                      <option key={i} value={i}>{colorScaleName(p)}</option>
                    ))}
                  </select>
                </div>
              )}

              {formatByValuesType === "dataBar" && (
                <DataBarRuleOptions value={dataBar} onChange={setDataBar} />
              )}

              {formatByValuesType === "iconSet" && (
                <>
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
                  <div style={rowStyle}>
                    <label style={rowStyle}>
                      <input
                        type="checkbox"
                        checked={iconReverse}
                        onChange={(e) => setIconReverse(e.target.checked)}
                        data-testid="cf-iconset-reverse"
                      />
                      <span style={{ fontSize: 13 }}>Reverse Icon Order</span>
                    </label>
                    <label style={rowStyle}>
                      <input
                        type="checkbox"
                        checked={iconOnly}
                        onChange={(e) => setIconOnly(e.target.checked)}
                        data-testid="cf-iconset-icon-only"
                      />
                      <span style={{ fontSize: 13 }}>Show Icon Only</span>
                    </label>
                  </div>
                </>
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
                {init?.formatIndex === OWN_PRESET && <option value={OWN_PRESET}>The rule's own format</option>}
                {PRESET_STYLES.map((preset, idx) => (
                  <option key={idx} value={idx}>{preset.label}</option>
                ))}
              </select>
            </div>

            {/* Format preview: colour DATA (a cell's look), not chrome. */}
            <div
              data-colour-data
              style={{
                padding: "6px 12px",
                borderRadius: 3,
                border: `1px solid ${DT.border}`,
                fontSize: 13,
                backgroundColor:
                  (formatIndex === OWN_PRESET ? editRule?.format.backgroundColor : PRESET_STYLES[formatIndex]?.backgroundColor) || "#fff",
                color: (formatIndex === OWN_PRESET ? editRule?.format.textColor : PRESET_STYLES[formatIndex]?.textColor) || "#000",
              }}
            >
              AaBbCcYyZz
            </div>
          </>
        )}

        {/* Color scale preview for formatByValues */}
        {selectedCategory === "formatByValues" && formatByValuesType === "colorScale" && (
          <div data-colour-data style={{
            height: 20,
            borderRadius: 3,
            border: `1px solid ${DT.border}`,
            background: (() => {
              const own = colorScalePresetIndex === OWN_PRESET && editRule?.rule.type === "colorScale" ? editRule.rule : null;
              const p = own
                ? { minColor: own.minPoint.color, midColor: own.midPoint?.color, maxColor: own.maxPoint.color }
                : PRESET_COLOR_SCALES[Math.max(0, colorScalePresetIndex)];
              if (p.midColor) {
                return `linear-gradient(to right, ${p.minColor}, ${p.midColor}, ${p.maxColor})`;
              }
              return `linear-gradient(to right, ${p.minColor}, ${p.maxColor})`;
            })(),
          }} />
        )}

        {/* Data bar preview for formatByValues: the bar as its options paint it */}
        {selectedCategory === "formatByValues" && formatByValuesType === "dataBar" && (
          <DataBarPreview value={dataBar} />
        )}

        {refusal !== null && (
          <div role="alert" style={errorStyle}>
            {editRule ? "The rule was not changed" : "The rule was not added"}: {refusal}
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
