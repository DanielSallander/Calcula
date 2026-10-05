//! FILENAME: app/extensions/ConditionalFormatting/lib/__tests__/cfPresets.test.ts
// PURPOSE: The gallery presets ARE Excel's: names, order, colours, and the
//          rule each one writes.
// CONTEXT: Measured on live Excel 16 (M365) on 2026-10-04 -- a fresh unsaved
//          workbook driven over COM + UI Automation: every Color Scales gallery
//          item was INVOKED on A1:A10 and the rule it wrote read back through
//          FormatConditions(1).ColorScaleCriteria (scratchpad
//          styles-probe/cfprobe.ps1). Two defects this pins:
//            - Calcula offered 8 colour scales; Excel has 12.
//            - every Calcula preset was UPSIDE DOWN. Excel names a scale from
//              the HIGHEST value to the lowest ("Green - Yellow - Red": high
//              values green, low values red -- the gallery icon has green on
//              top), and its rule is min=#F8696B, max=#63BE7B. Calcula wrote
//              min=green, max=red under the same name, so the first preset a
//              user picked painted their best numbers red.
//          The midpoint of a 3-colour scale is the 50th PERCENTILE in Excel
//          (ColorScaleCriteria(2).Type = 5, xlConditionValuePercentile), not
//          50 percent of the range; the ends are the lowest/highest value
//          (Type 1 / 2), which Calcula spells "min" / "max".

import { describe, it, expect } from "vitest";
import {
  PRESET_COLOR_SCALES,
  PRESET_DATA_BARS,
  PRESET_DATA_BAR_COLORS,
  ICON_SET_CATEGORIES,
  DATE_OCCURRING_PERIODS,
  colorScaleName,
} from "../../types";
import { colorScaleRule, dataBarRule, iconSetRule } from "../presetRules";

describe("Color Scales: Excel's twelve presets [LIVE 2026-10-04]", () => {
  it("are named and ordered as Excel's gallery", () => {
    expect(PRESET_COLOR_SCALES.map(colorScaleName)).toEqual([
      "Green - Yellow - Red Color Scale",
      "Red - Yellow - Green Color Scale",
      "Green - White - Red Color Scale",
      "Red - White - Green Color Scale",
      "Blue - White - Red Color Scale",
      "Red - White - Blue Color Scale",
      "White - Red Color Scale",
      "Red - White Color Scale",
      "Green - White Color Scale",
      "White - Green Color Scale",
      "Green - Yellow Color Scale",
      "Yellow - Green Color Scale",
    ]);
  });

  it("write the colours Excel writes, highest value first in the name", () => {
    const measured: Record<string, [string, string | undefined, string]> = {
      // name: [min (lowest value), mid (50th percentile), max (highest value)]
      "Green - Yellow - Red": ["#F8696B", "#FFEB84", "#63BE7B"],
      "Red - Yellow - Green": ["#63BE7B", "#FFEB84", "#F8696B"],
      "Green - White - Red": ["#F8696B", "#FCFCFF", "#63BE7B"],
      "Red - White - Green": ["#63BE7B", "#FCFCFF", "#F8696B"],
      "Blue - White - Red": ["#F8696B", "#FCFCFF", "#5A8AC6"],
      "Red - White - Blue": ["#5A8AC6", "#FCFCFF", "#F8696B"],
      "White - Red": ["#F8696B", undefined, "#FCFCFF"],
      "Red - White": ["#FCFCFF", undefined, "#F8696B"],
      "Green - White": ["#FCFCFF", undefined, "#63BE7B"],
      "White - Green": ["#63BE7B", undefined, "#FCFCFF"],
      "Green - Yellow": ["#FFEF9C", undefined, "#63BE7B"],
      "Yellow - Green": ["#63BE7B", undefined, "#FFEF9C"],
    };
    for (const preset of PRESET_COLOR_SCALES) {
      const [min, mid, max] = measured[preset.label];
      expect([preset.minColor, preset.midColor, preset.maxColor], preset.label).toEqual([min, mid, max]);
    }
  });

  it("a 3-colour scale's midpoint is the 50th PERCENTILE; the ends are the lowest and highest value", () => {
    const rule = colorScaleRule(PRESET_COLOR_SCALES[0]);
    expect(rule).toEqual({
      type: "colorScale",
      minPoint: { valueType: "min", color: "#F8696B" },
      midPoint: { valueType: "percentile", value: 50, color: "#FFEB84" },
      maxPoint: { valueType: "max", color: "#63BE7B" },
    });
  });

  it("a 2-colour scale has no midpoint", () => {
    const rule = colorScaleRule(PRESET_COLOR_SCALES[10]);
    expect(rule).toEqual({
      type: "colorScale",
      minPoint: { valueType: "min", color: "#FFEF9C" },
      maxPoint: { valueType: "max", color: "#63BE7B" },
    });
  });
});

describe("Data Bars [LIVE 2026-10-04]", () => {
  it("offer Excel's six colours, by Excel's names, in Excel's order", () => {
    expect(PRESET_DATA_BARS.map((b) => b.name)).toEqual([
      "Blue Data Bar",
      "Green Data Bar",
      "Red Data Bar",
      "Orange Data Bar",
      "Light Blue Data Bar",
      "Purple Data Bar",
    ]);
    expect(PRESET_DATA_BAR_COLORS).toEqual(PRESET_DATA_BARS.map((b) => b.color));
  });

  it("write an automatic min/max bar in the chosen colour and fill", () => {
    expect(dataBarRule("#638EC6", false)).toEqual({
      type: "dataBar",
      minValueType: "autoMin",
      maxValueType: "autoMax",
      fillColor: "#638EC6",
      axisPosition: "automatic",
      direction: "context",
      showValue: true,
      gradientFill: false,
    });
  });
});

describe("Icon Sets [LIVE 2026-10-04]", () => {
  it("are grouped and ordered as Excel's gallery (5 Quarters is a RATING, not a shape)", () => {
    expect(
      ICON_SET_CATEGORIES.map((c) => [c.label, c.sets.map((s) => s.label)]),
    ).toEqual([
      [
        "Directional",
        [
          "3 Arrows (Colored)",
          "3 Arrows (Gray)",
          "3 Triangles",
          "4 Arrows (Gray)",
          "4 Arrows (Colored)",
          "5 Arrows (Gray)",
          "5 Arrows (Colored)",
        ],
      ],
      ["Shapes", ["3 Traffic Lights (Unrimmed)", "3 Traffic Lights (Rimmed)", "3 Signs", "4 Traffic Lights", "Red To Black"]],
      ["Indicators", ["3 Symbols (Circled)", "3 Symbols (Uncircled)", "3 Flags"]],
      ["Ratings", ["3 Stars", "4 Ratings", "5 Quarters", "5 Ratings", "5 Boxes"]],
    ]);
  });

  it("write evenly spaced percent thresholds, one fewer than the icons", () => {
    expect(iconSetRule("fiveQuarters", 5)).toEqual({
      type: "iconSet",
      iconSet: "fiveQuarters",
      thresholds: [20, 40, 60, 80].map((value) => ({
        valueType: "percent",
        value,
        operator: "greaterThanOrEqual",
      })),
      reverseIcons: false,
      showIconOnly: false,
    });
    expect(iconSetRule("threeArrows", 3).type).toBe("iconSet");
  });
});

describe("A Date Occurring: Excel's ten periods [LIVE 2026-10-04]", () => {
  it("in the order and the words of Excel's dialog (its own 'This Month' capital included), Yesterday first", () => {
    expect(DATE_OCCURRING_PERIODS.map((p) => [p.value, p.label])).toEqual([
      ["yesterday", "Yesterday"],
      ["today", "Today"],
      ["tomorrow", "Tomorrow"],
      ["last7Days", "In the last 7 days"],
      ["lastWeek", "Last week"],
      ["thisWeek", "This week"],
      ["nextWeek", "Next week"],
      ["lastMonth", "Last month"],
      ["thisMonth", "This Month"],
      ["nextMonth", "Next month"],
    ]);
  });
});
