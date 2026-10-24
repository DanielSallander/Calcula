//! FILENAME: app/extensions/Charts/lib/__tests__/chartSpecValidate.test.ts
// PURPOSE: B8 slice A — the runtime gate in front of the broker chart-write path.
//          A sandboxed script's updateSpec/replaceSpec must reject unknown keys,
//          wrong types, and bad enums (previously a blind deep-merge accepted
//          anything), while tolerating the reserved _style_ prefix and passing a
//          valid (partial-merged or complete) spec.

import { describe, it, expect } from "vitest";
import {
  validateChartSpec,
  validateDrillThroughDefinition,
  validateMergedSpec,
  RESERVED_SPEC_PREFIX,
} from "../chartSpecValidate";
import type { ChartSpec } from "../../types";

const valid: ChartSpec = {
  mark: "bar",
  data: "Sheet1!A1:D13",
  hasHeaders: true,
  seriesOrientation: "columns",
  categoryIndex: 0,
  series: [{ name: "Revenue", sourceIndex: 1, color: null }],
  title: "Revenue",
  xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
  yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
  legend: { visible: false, position: "bottom" },
  palette: "default",
};

describe("validateChartSpec (B8 chart-write gate)", () => {
  it("accepts a complete, valid spec", () => {
    expect(validateChartSpec(valid)).toEqual([]);
  });

  it("rejects an unknown top-level property (garbage / typo key)", () => {
    const v = validateChartSpec({ ...valid, notARealKey: 42 });
    expect(v.length).toBeGreaterThan(0);
    expect(v.join(" ")).toContain("notARealKey");
  });

  it("rejects a wrong-typed property", () => {
    const v = validateChartSpec({ ...valid, hasHeaders: "yes" });
    expect(v.length).toBeGreaterThan(0);
    expect(v.join(" ")).toContain("hasHeaders");
  });

  it("rejects a bad enum value", () => {
    const v = validateChartSpec({ ...valid, seriesOrientation: "diagonal" });
    expect(v.length).toBeGreaterThan(0);
    expect(v.join(" ")).toContain("seriesOrientation");
  });

  it("rejects a nested wrong-typed property", () => {
    const v = validateChartSpec({ ...valid, legend: { visible: "no", position: "bottom" } });
    expect(v.length).toBeGreaterThan(0);
    expect(v.join(" ")).toContain("legend");
  });

  it("rejects a missing required field (full re-author with a hole)", () => {
    const { series: _omit, ...noSeries } = valid;
    const v = validateChartSpec(noSeries);
    expect(v.join(" ")).toContain("series");
  });

  it("tolerates reserved _style_ keys (setStyleProperty round-trip)", () => {
    expect(RESERVED_SPEC_PREFIX).toBe("_style_");
    expect(validateChartSpec({ ...valid, _style_backgroundColor: "#fff", _style_anything: "x" })).toEqual([]);
  });

  it("still catches a real violation alongside reserved keys", () => {
    const v = validateChartSpec({ ...valid, _style_x: "1", bogus: true });
    expect(v.join(" ")).toContain("bogus");
  });

  it("rejects a non-object spec", () => {
    expect(validateChartSpec(null).length).toBeGreaterThan(0);
    expect(validateChartSpec("not a spec").length).toBeGreaterThan(0);
    expect(validateChartSpec(42).length).toBeGreaterThan(0);
  });

  it("validateMergedSpec mirrors validateChartSpec (the merged whole is the unit)", () => {
    expect(validateMergedSpec(valid)).toEqual([]);
    // A merged result that gained a valid transform stays valid.
    const withTransform = { ...valid, transform: [{ type: "filter", field: "Revenue", predicate: "value > 100" }] } as ChartSpec;
    expect(validateMergedSpec(withTransform)).toEqual([]);
    // A merged result that gained a garbage key is rejected.
    const withGarbage = { ...valid, _injected: { evil: true } } as unknown as ChartSpec;
    expect(validateMergedSpec(withGarbage).join(" ")).toContain("_injected");
  });
});

// The chart's drill dialog validates the DEFINITION it writes, on its own,
// against the schema's DrillThroughDefinition sub-schema -- never a deep-merge
// preview of the whole spec (review: dialog-bypasses-dsl-bound).
describe("validateDrillThroughDefinition (the definition alone, against the schema's own sub-schema)", () => {
  const table = { kind: "table" };

  it("accepts a valid table and a valid chart definition", () => {
    expect(validateDrillThroughDefinition({ dslText: "ROWS: A.B", presentation: table })).toEqual([]);
    expect(
      validateDrillThroughDefinition({
        dslText: "ROWS: A.B",
        presentation: { kind: "chart", mark: "bar", markOptions: { stackMode: "stacked" } },
        name: "Detail",
        keepFilters: false,
      }),
    ).toEqual([]);
  });

  it("applies the schema's bounds, with paths that name the definition", () => {
    const tooLong = validateDrillThroughDefinition({ dslText: "x".repeat(20001), presentation: table });
    expect(tooLong.join("\n")).toContain("drillThrough.dslText: longer than 20000 characters");
    expect(validateDrillThroughDefinition({ dslText: "x".repeat(20000), presentation: table })).toEqual([]);
    expect(
      validateDrillThroughDefinition({ dslText: "ROWS: A.B", presentation: table, name: "n".repeat(81) }).join("\n"),
    ).toContain("drillThrough.name");
  });

  it("resolves the presentation's $refs and per-mark narrowing (the sub-schema carries the root's definitions)", () => {
    expect(
      validateDrillThroughDefinition({
        dslText: "ROWS: A.B",
        presentation: { kind: "chart", mark: "bar", markOptions: { innerRadius: 0.4 } },
      }).join("\n"),
    ).toContain("drillThrough.presentation.markOptions: unknown property 'innerRadius'");
    expect(
      validateDrillThroughDefinition({ dslText: "ROWS: A.B", presentation: { kind: "chart", mark: "bar-3d" } }).join(
        "\n",
      ),
    ).toContain("drillThrough.presentation.mark");
    expect(validateDrillThroughDefinition({ dslText: "ROWS: A.B", presentation: { kind: "page" } }).length).toBeGreaterThan(
      0,
    );
  });

  it("refuses an unknown key and a missing query", () => {
    expect(
      validateDrillThroughDefinition({ dslText: "ROWS: A.B", presentation: table, connectionId: "c1" }).join("\n"),
    ).toContain("unknown property 'connectionId'");
    expect(validateDrillThroughDefinition({ presentation: table }).join("\n")).toContain("missing required 'dslText'");
  });
});
