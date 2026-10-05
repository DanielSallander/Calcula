//! FILENAME: app/extensions/ConditionalFormatting/lib/presetRules.ts
// PURPOSE: The rule each gallery preset writes -- ONE builder per kind, shared
//          by the galleries (homeMenuBuilder) and New Rule's "Format all cells
//          based on their values" page.
// CONTEXT: The two doors used to build the same rules side by side, and both
//          wrote a colour scale's midpoint as 50 PERCENT of the range with
//          automatic ends. Excel writes the lowest value, the 50th PERCENTILE
//          and the highest value (ColorScaleCriteria types 1 / 5 / 2, read from
//          live Excel on 2026-10-04): on skewed data the two midpoints are far
//          apart, so the same preset coloured the same numbers differently in
//          Calcula and in Excel -- and a copy kept in two places would drift
//          again on the next correction.

import type { ConditionalFormatRule, IconSetType } from "@api";
import type { PresetColorScale } from "../types";

/** A Color Scales preset as a rule: lowest value, (50th percentile,) highest value. */
export function colorScaleRule(preset: PresetColorScale): ConditionalFormatRule {
  return {
    type: "colorScale",
    minPoint: { valueType: "min", color: preset.minColor },
    ...(preset.midColor
      ? { midPoint: { valueType: "percentile", value: 50, color: preset.midColor } }
      : {}),
    maxPoint: { valueType: "max", color: preset.maxColor },
  } as ConditionalFormatRule;
}

/** A Data Bars preset as a rule: automatic shortest / longest bar. */
export function dataBarRule(color: string, gradientFill: boolean): ConditionalFormatRule {
  return {
    type: "dataBar",
    minValueType: "autoMin",
    maxValueType: "autoMax",
    fillColor: color,
    axisPosition: "automatic",
    direction: "context",
    showValue: true,
    gradientFill,
  } as ConditionalFormatRule;
}

/**
 * An Icon Sets preset as a rule: one threshold fewer than the icons, evenly
 * spaced in percent of the range (Excel's 33/67, 25/50/75, 20/40/60/80).
 */
export function iconSetRule(iconSet: IconSetType, iconCount: number): ConditionalFormatRule {
  const thresholds = [];
  for (let i = 1; i < iconCount; i++) {
    thresholds.push({
      valueType: "percent" as const,
      value: Math.round((100 * i) / iconCount),
      operator: "greaterThanOrEqual" as const,
    });
  }
  return {
    type: "iconSet",
    iconSet,
    thresholds,
    reverseIcons: false,
    showIconOnly: false,
  } as ConditionalFormatRule;
}
