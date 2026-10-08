//! FILENAME: app/extensions/Charts/rendering/visuals/__tests__/multiRowCardPainter.test.ts
// PURPOSE: The Multi-row card draws Power BI's legacy multi-row card: one row
//          per category, the category as the row's title, each value field as
//          a value-over-label pair, an accent bar on the row's left edge.

import { describe, it, expect } from "vitest";
import { visualSpec, seriesData, paintVisual, textsOf, textAt } from "./visualTestKit";
import { getChartMarkMeta } from "@api/chartMarks";

const DATA = seriesData(
  ["North", "South"],
  [
    { name: "Sales", values: [11732, 950] },
    { name: "Manager", values: [0, 0] },
  ],
  [
    ["11,732", "950"],
    ["Ann", "Bo"],
  ],
);

describe("multiRowCard", () => {
  it("is registered as a title-only tile", () => {
    expect(getChartMarkMeta("multiRowCard")).toMatchObject({ label: "Multi-row card", layoutFamily: "other", furniture: "titleOnly" });
  });

  it("paints one row per category: title, then value over label for each field", () => {
    const { calls } = paintVisual("multiRowCard", visualSpec("multiRowCard"), DATA);
    expect(textsOf(calls)).toEqual([
      "North", "12K", "Sales", "Ann", "Manager",
      "South", "950", "Sales", "Bo", "Manager",
    ]);
    // value over label, in the same column
    const v = textAt(calls, "12K")!;
    const l = calls.indexOf(`fillText(Sales,${v.x},${textAt(calls, "Sales")!.y})`);
    expect(l).toBeGreaterThan(-1);
    expect(textAt(calls, "Sales")!.y).toBeGreaterThan(v.y);
    // second field to the right of the first
    expect(textAt(calls, "Ann")!.x).toBeGreaterThan(v.x);
    // second row below the first
    expect(textAt(calls, "South")!.y).toBeGreaterThan(textAt(calls, "North")!.y);
  });

  it("a text field shows its text, never 0", () => {
    const { calls } = paintVisual("multiRowCard", visualSpec("multiRowCard"), DATA);
    expect(textsOf(calls)).not.toContain("0");
  });

  it("draws an accent bar per row in the first series' colour, and none when switched off", () => {
    const tinted = seriesData(["A", "B"], [{ name: "S", values: [1, 2], color: "#FF00AA" }]);
    const on = paintVisual("multiRowCard", visualSpec("multiRowCard"), tinted);
    const bars = on.calls.filter((c, i) => c.startsWith("fillRect(") && on.calls[i - 1] === "fillStyle=#FF00AA");
    expect(bars).toHaveLength(2);
    const off = paintVisual("multiRowCard", visualSpec("multiRowCard", { markOptions: { showAccentBar: false } } as never), tinted);
    expect(off.calls).not.toContain("fillStyle=#FF00AA");
  });

  it("hit-tests each value cell as its own datum (series, category)", () => {
    const { geometry } = paintVisual("multiRowCard", visualSpec("multiRowCard"), DATA);
    expect(geometry.type).toBe("bars");
    if (geometry.type !== "bars") return;
    expect(geometry.rects.map((r) => [r.seriesIndex, r.categoryIndex])).toEqual([[0, 0], [1, 0], [0, 1], [1, 1]]);
  });

  it("a per-point override colours that one value", () => {
    const spec = visualSpec("multiRowCard", { dataPointOverrides: [{ seriesIndex: 0, categoryIndex: 1, color: "#FFCC00" }] });
    const { calls } = paintVisual("multiRowCard", spec, DATA);
    expect(textAt(calls, "950")!.fill).toBe("#FFCC00");
    expect(textAt(calls, "12K")!.fill).not.toBe("#FFCC00");
  });

  it("rows that do not fit are not painted over each other", () => {
    const many = seriesData(
      Array.from({ length: 30 }, (_v, i) => `R${i}`),
      [{ name: "S", values: Array.from({ length: 30 }, (_v, i) => i + 1) }],
    );
    const { calls, layout } = paintVisual("multiRowCard", visualSpec("multiRowCard"), many, 300, 200);
    const titles = textsOf(calls).filter((t) => /^R\d+$/.test(t));
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.length).toBeLessThan(30);
    const lastTitle = textAt(calls, titles[titles.length - 1])!;
    expect(lastTitle.y).toBeLessThan(layout.plotArea.y + layout.plotArea.height);
  });
});
