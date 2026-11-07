//! FILENAME: app/extensions/ConditionalFormatting/lib/editRuleState.ts
// PURPOSE: Edit Rule (the Rules Manager's door into the New Formatting Rule
//          dialog): the dialog's controls for a STORED rule, and the rule OK
//          writes back -- with every setting the dialog does not show kept.
// CONTEXT: Excel's Rules Manager has New Rule, Edit Rule and Duplicate Rule
//          (wave-1 uiforms finding). Excel's Edit Rule shows and stores a
//          formula as the RULE holds it -- for the rule's first cell, with no
//          active-cell conversion [LIVE, Excel 16, 2026-11-06, lane uiforms
//          probe4 F4: =$C5>200 typed in Edit Rule is stored =$C5>200] -- so
//          nothing here moves a formula. The dialog offers presets where Excel
//          offers full pickers (a colour scale's colours, a format's look), so
//          a stored rule that matches no preset is shown as "the rule's own"
//          and kept as it is unless the user picks something else; a data
//          bar's minimum / maximum and an icon set's thresholds, which the
//          dialog does not show, are carried over.

import type {
  ConditionalFormat,
  ConditionalFormatDefinition,
  ConditionalFormatRule,
  CellValueOperator,
  TextRuleType,
  TopBottomType,
  AverageRuleType,
  IconSetType,
  TimePeriod,
  DataBarRule,
} from "@api";
import { PRESET_STYLES, PRESET_COLOR_SCALES, type NewRuleCategory, type NewRuleFormatStyle } from "../types";
import { DEFAULT_DATA_BAR_UI, dataBarUiOf, type DataBarUi } from "./dataBarOptions";

/** "Format only cells with:" on the New Rule dialog's second page. */
export type ContainingType = "cellValue" | "text" | "dates" | "blanks" | "noBlanks" | "errors" | "noErrors";

/** Index meaning "the rule's own" -- no preset matches what it stores. */
export const OWN_PRESET = -1;

/** Every control of the New Formatting Rule dialog an existing rule sets. */
export interface RuleEditState {
  category: NewRuleCategory;
  /** A PRESET_STYLES index, or OWN_PRESET for the rule's own format. */
  formatIndex: number;
  formatByValuesType: NewRuleFormatStyle;
  /** A PRESET_COLOR_SCALES index, or OWN_PRESET for the rule's own colours. */
  colorScalePresetIndex: number;
  dataBar: DataBarUi;
  iconSetType: IconSetType;
  iconReverse: boolean;
  iconOnly: boolean;
  containingType: ContainingType;
  cellValueOperator: CellValueOperator;
  cellValue1: string;
  cellValue2: string;
  textRuleType: TextRuleType;
  textValue: string;
  datePeriod: TimePeriod | null;
  topBottomType: TopBottomType;
  topBottomRank: string;
  averageType: AverageRuleType;
  dupUniqueType: "duplicateValues" | "uniqueValues";
  formulaExpression: string;
}

const same = (a: string | undefined, b: string | undefined) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/** The preset whose look the format IS (fill and text colour, nothing else), or OWN_PRESET. */
export function formatPresetOf(format: ConditionalFormat): number {
  const keys = Object.entries(format).filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== false);
  if (keys.some(([k]) => k !== "backgroundColor" && k !== "textColor")) return OWN_PRESET;
  if (!format.backgroundColor && !format.textColor) return OWN_PRESET;
  const i = PRESET_STYLES.findIndex((p) => same(p.backgroundColor, format.backgroundColor) && same(p.textColor, format.textColor));
  return i;
}

function colorScalePresetOf(rule: Extract<ConditionalFormatRule, { type: "colorScale" }>): number {
  return PRESET_COLOR_SCALES.findIndex(
    (p) =>
      rule.minPoint.valueType === "min" &&
      rule.maxPoint.valueType === "max" &&
      same(p.minColor, rule.minPoint.color) &&
      same(p.maxColor, rule.maxPoint.color) &&
      (p.midColor
        ? !!rule.midPoint && rule.midPoint.valueType === "percentile" && rule.midPoint.value === 50 && same(p.midColor, rule.midPoint.color)
        : !rule.midPoint),
  );
}

/** The dialog's defaults, for the fields a rule of another kind leaves alone. */
function defaults(): RuleEditState {
  return {
    category: "formatContaining",
    formatIndex: 0,
    formatByValuesType: "colorScale",
    colorScalePresetIndex: 0,
    dataBar: DEFAULT_DATA_BAR_UI,
    iconSetType: "threeTrafficLights1",
    iconReverse: false,
    iconOnly: false,
    containingType: "cellValue",
    cellValueOperator: "greaterThan",
    cellValue1: "",
    cellValue2: "",
    textRuleType: "contains",
    textValue: "",
    datePeriod: null,
    topBottomType: "topItems",
    topBottomRank: "10",
    averageType: "aboveAverage",
    dupUniqueType: "duplicateValues",
    formulaExpression: "",
  };
}

/** What the dialog shows for a stored rule (Edit Rule). */
export function editStateOf(def: ConditionalFormatDefinition): RuleEditState {
  const s = defaults();
  const rule = def.rule;
  s.formatIndex = formatPresetOf(def.format);
  switch (rule.type) {
    case "colorScale":
      s.category = "formatByValues";
      s.formatByValuesType = "colorScale";
      s.colorScalePresetIndex = colorScalePresetOf(rule);
      break;
    case "dataBar":
      s.category = "formatByValues";
      s.formatByValuesType = "dataBar";
      s.dataBar = dataBarUiOf(rule);
      break;
    case "iconSet":
      s.category = "formatByValues";
      s.formatByValuesType = "iconSet";
      s.iconSetType = rule.iconSet;
      s.iconReverse = rule.reverseIcons === true;
      s.iconOnly = rule.showIconOnly === true;
      break;
    case "cellValue":
      s.containingType = "cellValue";
      s.cellValueOperator = rule.operator;
      s.cellValue1 = rule.value1 ?? "";
      s.cellValue2 = rule.value2 ?? "";
      break;
    case "containsText":
      s.containingType = "text";
      s.textRuleType = rule.ruleType;
      s.textValue = rule.text ?? "";
      break;
    case "timePeriod":
      s.containingType = "dates";
      s.datePeriod = rule.period;
      break;
    case "blankCells":
      s.containingType = "blanks";
      break;
    case "noBlanks":
      s.containingType = "noBlanks";
      break;
    case "errorCells":
      s.containingType = "errors";
      break;
    case "noErrors":
      s.containingType = "noErrors";
      break;
    case "topBottom":
      s.category = "topBottom";
      s.topBottomType = rule.ruleType;
      s.topBottomRank = String(rule.rank);
      break;
    case "aboveAverage":
      s.category = "aboveBelow";
      s.averageType = rule.ruleType;
      break;
    case "duplicateValues":
    case "uniqueValues":
      s.category = "uniqueDuplicate";
      s.dupUniqueType = rule.type;
      break;
    case "expression":
      s.category = "formula";
      // As stored: for the rule's first cell (Excel's Edit Rule, [LIVE]).
      s.formulaExpression = rule.formula ?? "";
      break;
  }
  return s;
}

/**
 * The rule Edit Rule's OK writes: what the dialog built, with what the dialog
 * cannot show kept from the stored rule -- a data bar's minimum and maximum,
 * an icon set's thresholds while it stays the same set. A colour scale left on
 * the rule's own colours (`colorScaleKept`) is the stored rule itself.
 */
export function mergeEditedRule(
  original: ConditionalFormatRule,
  built: ConditionalFormatRule,
  colorScaleKept: boolean,
): ConditionalFormatRule {
  if (original.type === "colorScale" && built.type === "colorScale" && colorScaleKept) return original;
  if (original.type === "dataBar" && built.type === "dataBar") {
    const o: DataBarRule = original;
    return {
      ...built,
      minValueType: o.minValueType,
      maxValueType: o.maxValueType,
      ...(o.minValue !== undefined ? { minValue: o.minValue } : {}),
      ...(o.maxValue !== undefined ? { maxValue: o.maxValue } : {}),
      ...(o.minFormula !== undefined ? { minFormula: o.minFormula } : {}),
      ...(o.maxFormula !== undefined ? { maxFormula: o.maxFormula } : {}),
    };
  }
  if (original.type === "iconSet" && built.type === "iconSet" && original.iconSet === built.iconSet) {
    return { ...original, reverseIcons: built.reverseIcons, showIconOnly: built.showIconOnly };
  }
  return built;
}
