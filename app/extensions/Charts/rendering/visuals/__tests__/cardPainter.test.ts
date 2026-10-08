//! FILENAME: app/extensions/Charts/rendering/visuals/__tests__/cardPainter.test.ts
// PURPOSE: The Card visual draws what Power BI's card draws: one callout value
//          per value field, written with display units Auto, with the field's
//          name under it — and a TEXT value as its text, never as 0.

import { describe, it, expect } from "vitest";
import { visualSpec, seriesData, paintVisual, textsOf, textAt, fontPx } from "./visualTestKit";
import { getChartMarkMeta, chartMarkFurniture } from "@api/chartMarks";

describe("card: registration", () => {
  it("is a built-in mark with no axes and only a title for furniture", () => {
    const meta = getChartMarkMeta("card");
    expect(meta).toMatchObject({ label: "Card", layoutFamily: "other", builtin: true, furniture: "titleOnly" });
    expect(chartMarkFurniture("card")).toBe("titleOnly");
  });
});

describe("card: the callout", () => {
  it("one datum: the callout is 11,732 written as 12K, the label is the field name", () => {
    const { calls } = paintVisual("card", visualSpec("card"), seriesData(["Total"], [{ name: "Sales", values: [11732] }], [["11,732"]]));
    expect(textsOf(calls)).toEqual(["12K", "Sales"]);
    const callout = textAt(calls, "12K")!;
    const label = textAt(calls, "Sales")!;
    // Value over label, the callout much larger.
    expect(callout.y).toBeLessThan(label.y);
    expect(fontPx(callout.font)).toBeGreaterThan(fontPx(label.font) * 2);
  });

  it("a TEXT cell shows its text -- never the 0 the parser wrote for it", () => {
    const { calls } = paintVisual("card", visualSpec("card"), seriesData(["r"], [{ name: "Region", values: [0] }], [["North"]]));
    expect(textsOf(calls)).toContain("North");
    expect(textsOf(calls)).not.toContain("0");
  });

  it("display units 'none' keep the source's number format", () => {
    const spec = visualSpec("card", { markOptions: { displayUnits: "none" } } as never);
    const { calls } = paintVisual("card", spec, seriesData(["r"], [{ name: "Revenue", values: [1234.5] }], [["$1,234.50"]]));
    expect(textsOf(calls)).toContain("$1,234.50");
  });

  it("many rows of numbers are summed (Power BI's default for a numeric field)", () => {
    const { calls } = paintVisual("card", visualSpec("card"), seriesData(["a", "b", "c"], [{ name: "Units", values: [100, 200, 300] }]));
    expect(textsOf(calls)).toContain("600");
  });

  it("an empty field shows (Blank)", () => {
    const { calls } = paintVisual("card", visualSpec("card"), seriesData([], [{ name: "Units", values: [] }]));
    expect(textsOf(calls)).toContain("(Blank)");
  });

  it("the category label can be turned off", () => {
    const spec = visualSpec("card", { markOptions: { showCategoryLabel: false } } as never);
    const { calls } = paintVisual("card", spec, seriesData(["t"], [{ name: "Sales", values: [5] }]));
    expect(textsOf(calls)).toEqual(["5"]);
  });
});

describe("card: several value fields make several cards", () => {
  it("two series paint two callouts side by side, each with its own hit rect", () => {
    const { calls, geometry } = paintVisual(
      "card",
      visualSpec("card"),
      seriesData(["t"], [{ name: "Sales", values: [10] }, { name: "Profit", values: [3] }]),
    );
    const a = textAt(calls, "10")!;
    const b = textAt(calls, "3")!;
    expect(a.y).toBe(b.y);
    expect(b.x).toBeGreaterThan(a.x);
    expect(geometry.type).toBe("bars");
    if (geometry.type !== "bars") return;
    expect(geometry.rects.map((r) => [r.seriesIndex, r.categoryIndex, r.seriesName])).toEqual([
      [0, 0, "Sales"],
      [1, 0, "Profit"],
    ]);
    // The two cards share the plot without overlapping.
    expect(geometry.rects[0].x + geometry.rects[0].width).toBeLessThanOrEqual(geometry.rects[1].x);
  });
});

describe("card: colour", () => {
  it("a per-point override colours the callout of that card", () => {
    const spec = visualSpec("card", { dataPointOverrides: [{ seriesIndex: 1, categoryIndex: 0, color: "#FFCC00" }] });
    const { calls } = paintVisual("card", spec, seriesData(["t"], [{ name: "A", values: [1] }, { name: "B", values: [2] }]));
    expect(textAt(calls, "2")!.fill).toBe("#FFCC00");
    expect(textAt(calls, "1")!.fill).not.toBe("#FFCC00");
  });

  it("a series colour colours its callout; without one the callout is the theme's text colour", () => {
    const plain = paintVisual("card", visualSpec("card"), seriesData(["t"], [{ name: "A", values: [1] }]));
    const tinted = paintVisual("card", visualSpec("card"), seriesData(["t"], [{ name: "A", values: [1], color: "#FF00AA" }]));
    expect(textAt(plain.calls, "1")!.fill).toBe("#333333");
    expect(textAt(tinted.calls, "1")!.fill).toBe("#FF00AA");
  });
});

describe("card: dispatch draws no furniture a tile does not have", () => {
  it("stale data labels / data table / layers in the spec paint nothing extra on a card", async () => {
    const { dispatchPaint, dispatchComputeLayout } = await import("../../chartDispatch");
    const { makeRecordingCtx } = await import("../../__tests__/dispatch-recordingCtx");
    const { THEME } = await import("./visualTestKit");
    const data = seriesData(["t"], [{ name: "Sales", values: [42] }]);
    const paint = (spec: ReturnType<typeof visualSpec>): string[] => {
      const { ctx, calls } = makeRecordingCtx(600, 400);
      dispatchPaint(ctx, data, spec, dispatchComputeLayout(600, 400, spec, data, THEME), THEME);
      return calls;
    };
    const plain = paint(visualSpec("card"));
    const stale = paint(visualSpec("card", {
      dataLabels: { enabled: true },
      dataTable: { enabled: true },
      layers: [{ mark: "rule", markOptions: { y: 10, label: "ref" } }],
    } as never));
    expect(stale).toEqual(plain);
  });
});

describe("card: title", () => {
  it("paints the title above the cards and keeps the callout below it", () => {
    const { calls, layout } = paintVisual("card", visualSpec("card", { title: "Revenue" }), seriesData(["t"], [{ name: "S", values: [7] }]));
    expect(textsOf(calls)[0]).toBe("Revenue");
    expect(textAt(calls, "7")!.y).toBeGreaterThan(layout.plotArea.y);
  });
});
