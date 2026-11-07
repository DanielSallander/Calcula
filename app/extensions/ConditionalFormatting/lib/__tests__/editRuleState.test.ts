//! FILENAME: app/extensions/ConditionalFormatting/lib/__tests__/editRuleState.test.ts
// PURPOSE: Edit Rule's read-back and write-back (lib/editRuleState.ts): the
//          dialog shows a stored rule on its own page with its own values, and
//          OK keeps what the dialog cannot show (a data bar's minimum and
//          maximum, an icon set's thresholds, a format or colour scale that is
//          no preset).

import { describe, it, expect } from "vitest";
import { editStateOf, mergeEditedRule, formatPresetOf, OWN_PRESET } from "../editRuleState";
import type { ConditionalFormatDefinition, ConditionalFormatRule } from "@api";

function def(rule: unknown, format: Record<string, unknown> = {}): ConditionalFormatDefinition {
  return { id: 1, priority: 1, rule, format, ranges: [], stopIfTrue: false, enabled: true } as unknown as ConditionalFormatDefinition;
}

describe("editStateOf: the page and the values of a stored rule", () => {
  it("a cell-value rule opens on 'Format only cells that contain' with its operator and operands", () => {
    const s = editStateOf(def({ type: "cellValue", operator: "between", value1: "1", value2: "=$B$1" }, { backgroundColor: "#C6EFCE", textColor: "#006100" }));
    expect(s).toMatchObject({ category: "formatContaining", containingType: "cellValue", cellValueOperator: "between", cellValue1: "1", cellValue2: "=$B$1" });
    expect(s.formatIndex, "the Green Fill preset").toBe(2);
  });

  it("a formula rule shows the formula AS STORED (Excel's Edit Rule)", () => {
    expect(editStateOf(def({ type: "expression", formula: "=$C2>100" })).formulaExpression).toBe("=$C2>100");
  });

  it("a format that is no preset (bold, a border) is the rule's own", () => {
    expect(formatPresetOf({ bold: true, backgroundColor: "#FFC7CE", textColor: "#9C0006" })).toBe(OWN_PRESET);
    expect(formatPresetOf({ backgroundColor: "#123456" })).toBe(-1);
    expect(formatPresetOf({ backgroundColor: "#ffc7ce" }), "Light Red Fill, any case").toBe(3);
  });

  it("other pages: top/bottom, average, duplicates, dates, icon set", () => {
    expect(editStateOf(def({ type: "topBottom", ruleType: "bottomPercent", rank: 7 }))).toMatchObject({ category: "topBottom", topBottomType: "bottomPercent", topBottomRank: "7" });
    expect(editStateOf(def({ type: "aboveAverage", ruleType: "belowAverage" }))).toMatchObject({ category: "aboveBelow", averageType: "belowAverage" });
    expect(editStateOf(def({ type: "uniqueValues" }))).toMatchObject({ category: "uniqueDuplicate", dupUniqueType: "uniqueValues" });
    expect(editStateOf(def({ type: "timePeriod", period: "lastWeek" }))).toMatchObject({ containingType: "dates", datePeriod: "lastWeek" });
    expect(editStateOf(def({ type: "iconSet", iconSet: "fiveArrows", thresholds: [], reverseIcons: true, showIconOnly: false }))).toMatchObject({
      category: "formatByValues",
      formatByValuesType: "iconSet",
      iconSetType: "fiveArrows",
      iconReverse: true,
    });
  });
});

describe("mergeEditedRule: what the dialog cannot show is kept", () => {
  it("a data bar keeps its minimum and maximum", () => {
    const original = { type: "dataBar", minValueType: "number", minValue: 5, maxValueType: "percentile", maxValue: 90, fillColor: "#638EC6", axisPosition: "automatic", direction: "context", showValue: true, gradientFill: true } as ConditionalFormatRule;
    const built = { ...original, minValueType: "autoMin", maxValueType: "autoMax", minValue: undefined, maxValue: undefined, fillColor: "#FF0000" } as ConditionalFormatRule;
    expect(mergeEditedRule(original, built, false)).toMatchObject({ fillColor: "#FF0000", minValueType: "number", minValue: 5, maxValueType: "percentile", maxValue: 90 });
  });

  it("an icon set keeps its thresholds while it stays the same set", () => {
    const thresholds = [{ valueType: "number", value: 10, operator: "greaterThanOrEqual" }];
    const original = { type: "iconSet", iconSet: "threeArrows", thresholds, reverseIcons: false, showIconOnly: false } as ConditionalFormatRule;
    const built = { type: "iconSet", iconSet: "threeArrows", thresholds: [], reverseIcons: true, showIconOnly: true } as ConditionalFormatRule;
    expect(mergeEditedRule(original, built, false)).toEqual({ ...original, reverseIcons: true, showIconOnly: true });
    const other = { ...built, iconSet: "threeFlags" } as ConditionalFormatRule;
    expect(mergeEditedRule(original, other, false), "another set is the set as built").toBe(other);
  });

  it("a colour scale left on its own colours is the stored rule", () => {
    const original = { type: "colorScale", minPoint: { valueType: "number", value: 1, color: "#000000" }, maxPoint: { valueType: "max", color: "#FFFFFF" } } as ConditionalFormatRule;
    const built = { type: "colorScale", minPoint: { valueType: "min", color: "#F8696B" }, maxPoint: { valueType: "max", color: "#63BE7B" } } as ConditionalFormatRule;
    expect(mergeEditedRule(original, built, true)).toBe(original);
    expect(mergeEditedRule(original, built, false)).toBe(built);
  });
});
