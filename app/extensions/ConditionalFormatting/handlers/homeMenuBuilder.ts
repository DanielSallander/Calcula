//! FILENAME: app/extensions/ConditionalFormatting/handlers/homeMenuBuilder.ts
// PURPOSE: Registers Conditional Formatting menu items in the Format menu.
// CONTEXT: Adds "Conditional Formatting" submenu with quick-apply actions and management options.

import {
  registerMenuItem,
  showDialog,
  addConditionalFormat,
  clearConditionalFormatsInRange,
} from "../../../src/api";

import type {
  ConditionalFormatRule,
  ConditionalFormat,
  ConditionalFormatRange,
  AddCFParams,
} from "../../../src/api";

import { invalidateAndRefresh } from "../lib/cfStore";
import {
  PRESET_STYLES,
  PRESET_COLOR_SCALES,
  PRESET_DATA_BAR_COLORS,
} from "../types";

export const QUICK_CF_DIALOG_ID = "cf-quick-dialog";
export const RULES_MANAGER_DIALOG_ID = "cf-rules-manager";
export const NEW_RULE_DIALOG_ID = "cf-new-rule-dialog";

// Module-level selection cache (updated by index.ts via onSelectionChange)
let currentSelection: {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
} | null = null;

/** Update the cached selection (called from index.ts) */
export function setMenuSelection(sel: {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
} | null): void {
  currentSelection = sel;
}

/** Get the current selection as a CF range */
function getSelectionRange(): ConditionalFormatRange | null {
  if (!currentSelection) return null;
  const minRow = Math.min(currentSelection.startRow, currentSelection.endRow);
  const maxRow = Math.max(currentSelection.startRow, currentSelection.endRow);
  const minCol = Math.min(currentSelection.startCol, currentSelection.endCol);
  const maxCol = Math.max(currentSelection.startCol, currentSelection.endCol);
  return { startRow: minRow, startCol: minCol, endRow: maxRow, endCol: maxCol };
}

/** Add a quick rule with the current selection and given rule + format */
async function addQuickRule(
  rule: ConditionalFormatRule,
  format: ConditionalFormat
): Promise<void> {
  const range = getSelectionRange();
  if (!range) return;

  const params: AddCFParams = {
    rule,
    format,
    ranges: [range],
    stopIfTrue: false,
  };

  await addConditionalFormat(params);
  await invalidateAndRefresh();
}

/** Show a quick dialog for threshold-based rules */
function showQuickDialog(ruleType: string): void {
  showDialog(QUICK_CF_DIALOG_ID, { ruleType, selection: getSelectionRange() });
}

/** Clear rules from the current selection */
async function handleClearRulesFromSelection(): Promise<void> {
  const range = getSelectionRange();
  if (!range) return;

  await clearConditionalFormatsInRange(
    range.startRow,
    range.startCol,
    range.endRow,
    range.endCol
  );
  await invalidateAndRefresh();
}

/** Clear all rules from the entire sheet */
async function handleClearAllRules(): Promise<void> {
  await clearConditionalFormatsInRange(0, 0, 999999, 999999);
  await invalidateAndRefresh();
}

/**
 * Register Conditional Formatting menu items into the Format menu.
 */
export function registerCFMenuItems(): void {
  // Separator before CF items
  registerMenuItem("format", {
    id: "format:cf-separator",
    label: "",
    separator: true,
  });

  // Main Conditional Formatting menu with submenus
  registerMenuItem("format", {
    id: "format:conditionalFormatting",
    label: "Conditional Formatting",
    children: [
      // ---- Highlight Cells Rules ----
      {
        id: "cf:highlightCells",
        label: "Highlight Cells Rules",
        children: [
          {
            id: "cf:greaterThan",
            label: "Greater Than...",
            action: () => showQuickDialog("greaterThan"),
          },
          {
            id: "cf:lessThan",
            label: "Less Than...",
            action: () => showQuickDialog("lessThan"),
          },
          {
            id: "cf:between",
            label: "Between...",
            action: () => showQuickDialog("between"),
          },
          {
            id: "cf:equalTo",
            label: "Equal To...",
            action: () => showQuickDialog("equalTo"),
          },
          {
            id: "cf:textContains",
            label: "Text that Contains...",
            action: () => showQuickDialog("textContains"),
          },
          {
            id: "cf:duplicateValues",
            label: "Duplicate Values...",
            action: () => showQuickDialog("duplicateValues"),
          },
          {
            id: "cf:uniqueValues",
            label: "Unique Values...",
            action: () => showQuickDialog("uniqueValues"),
          },
        ],
      },

      // ---- Top/Bottom Rules ----
      {
        id: "cf:topBottomRules",
        label: "Top/Bottom Rules",
        children: [
          {
            id: "cf:top10Items",
            label: "Top 10 Items...",
            action: () => showQuickDialog("top10Items"),
          },
          {
            id: "cf:top10Percent",
            label: "Top 10%...",
            action: () => showQuickDialog("top10Percent"),
          },
          {
            id: "cf:bottom10Items",
            label: "Bottom 10 Items...",
            action: () => showQuickDialog("bottom10Items"),
          },
          {
            id: "cf:bottom10Percent",
            label: "Bottom 10%...",
            action: () => showQuickDialog("bottom10Percent"),
          },
          {
            id: "cf:aboveAverage",
            label: "Above Average...",
            action: () => showQuickDialog("aboveAverage"),
          },
          {
            id: "cf:belowAverage",
            label: "Below Average...",
            action: () => showQuickDialog("belowAverage"),
          },
        ],
      },

      // ---- Color Scales ----
      {
        id: "cf:colorScales",
        label: "Color Scales",
        children: PRESET_COLOR_SCALES.map((preset, idx) => ({
          id: `cf:colorScale-${idx}`,
          label: preset.label,
          action: () => {
            const rule: ConditionalFormatRule = {
              type: "colorScale",
              minPoint: { valueType: "autoMin", color: preset.minColor },
              ...(preset.midColor
                ? {
                    midPoint: {
                      valueType: "percent",
                      value: 50,
                      color: preset.midColor,
                    },
                  }
                : {}),
              maxPoint: { valueType: "autoMax", color: preset.maxColor },
            } as ConditionalFormatRule;
            addQuickRule(rule, {});
          },
        })),
      },

      // ---- Data Bars ----
      {
        id: "cf:dataBars",
        label: "Data Bars",
        children: PRESET_DATA_BAR_COLORS.map((color, idx) => ({
          id: `cf:dataBar-${idx}`,
          label: `Data Bar (${color})`,
          action: () => {
            const rule: ConditionalFormatRule = {
              type: "dataBar",
              minValueType: "autoMin",
              maxValueType: "autoMax",
              fillColor: color,
              axisPosition: "automatic",
              direction: "context",
              showValue: true,
              gradientFill: true,
            } as ConditionalFormatRule;
            addQuickRule(rule, {});
          },
        })),
      },

      // ---- Icon Sets ----
      {
        id: "cf:iconSets",
        label: "Icon Sets",
        children: [
          {
            id: "cf:iconSet-trafficLights",
            label: "Traffic Lights",
            action: () => {
              const rule: ConditionalFormatRule = {
                type: "iconSet",
                iconSet: "threeTrafficLights1",
                thresholds: [
                  { valueType: "percent", value: 33, operator: "greaterThanOrEqual" },
                  { valueType: "percent", value: 67, operator: "greaterThanOrEqual" },
                ],
                reverseIcons: false,
                showIconOnly: false,
              } as ConditionalFormatRule;
              addQuickRule(rule, {});
            },
          },
          {
            id: "cf:iconSet-arrows",
            label: "Arrows",
            action: () => {
              const rule: ConditionalFormatRule = {
                type: "iconSet",
                iconSet: "threeArrows",
                thresholds: [
                  { valueType: "percent", value: 33, operator: "greaterThanOrEqual" },
                  { valueType: "percent", value: 67, operator: "greaterThanOrEqual" },
                ],
                reverseIcons: false,
                showIconOnly: false,
              } as ConditionalFormatRule;
              addQuickRule(rule, {});
            },
          },
          {
            id: "cf:iconSet-flags",
            label: "Flags",
            action: () => {
              const rule: ConditionalFormatRule = {
                type: "iconSet",
                iconSet: "threeFlags",
                thresholds: [
                  { valueType: "percent", value: 33, operator: "greaterThanOrEqual" },
                  { valueType: "percent", value: 67, operator: "greaterThanOrEqual" },
                ],
                reverseIcons: false,
                showIconOnly: false,
              } as ConditionalFormatRule;
              addQuickRule(rule, {});
            },
          },
          {
            id: "cf:iconSet-stars",
            label: "Stars",
            action: () => {
              const rule: ConditionalFormatRule = {
                type: "iconSet",
                iconSet: "threeStars",
                thresholds: [
                  { valueType: "percent", value: 33, operator: "greaterThanOrEqual" },
                  { valueType: "percent", value: 67, operator: "greaterThanOrEqual" },
                ],
                reverseIcons: false,
                showIconOnly: false,
              } as ConditionalFormatRule;
              addQuickRule(rule, {});
            },
          },
        ],
      },

      // ---- Separator ----
      { id: "cf:separator-mgmt", label: "", separator: true },

      // ---- New Rule ----
      {
        id: "cf:newRule",
        label: "New Rule...",
        action: () => showDialog(NEW_RULE_DIALOG_ID, { selection: getSelectionRange() }),
      },

      // ---- Clear Rules ----
      {
        id: "cf:clearRules",
        label: "Clear Rules",
        children: [
          {
            id: "cf:clearFromSelection",
            label: "Clear Rules from Selected Cells",
            action: handleClearRulesFromSelection,
          },
          {
            id: "cf:clearFromSheet",
            label: "Clear Rules from Entire Sheet",
            action: handleClearAllRules,
          },
        ],
      },

      // ---- Manage Rules ----
      {
        id: "cf:manageRules",
        label: "Manage Rules...",
        action: () => showDialog(RULES_MANAGER_DIALOG_ID),
      },
    ],
  });
}
