//! FILENAME: app/extensions/Charts/rendering/__tests__/errorBarOptionsOneSpelling.test.ts
// PURPOSE: "Which marks have error bars, and where do their options live?" is
//          ONE fact. It was spelled five times: a switch in `getErrorBarOptions`,
//          a hand-written `{ markOptions: { ...spec.markOptions, errorBars } }`
//          in the Delete path, another in the Format pane, a third (behind two
//          `as any` casts) in the Design tab, and a fourth mark list gating the
//          paint in chartDispatch — plus a fifth, the `spec.mark === "bar" || ...`
//          chain that decided whether the Design tab showed the section at all.
// CONTEXT: The Delete copy did not even COMPILE once error bars became deletable
//          per series: `spec.markOptions` is a nineteen-arm union and the arms
//          for pie/funnel/treemap/sunburst have no `errorBars` property, so
//          spreading the union and adding one produces an illegal arm per shape.
//          That type error is what surfaced the duplication. The fact now lives
//          in `ERROR_BAR_MARKS` / `markSupportsErrorBars` / `getErrorBarOptions`
//          / `withErrorBarOptions`, all in rendering/errorBarPainter.ts beside
//          the painter that draws them.
//
//          WHAT WOULD HAVE HAPPENED WITHOUT THIS. Give `area` error bars and the
//          old shape reads them (the reader's switch), writes them (the pane),
//          offers them (the Design tab's own chain) — and never DRAWS them,
//          because the dispatcher's private array was not updated. A setting that
//          is accepted, stored and ignored: the silent no-op this programme has
//          now paid for three times.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ChartSpec, ParsedChartData, ErrorBarOptions } from "../../types";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import {
  getErrorBarOptions,
  markSupportsErrorBars,
  withErrorBarOptions,
} from "../errorBarPainter";
import { dispatchComputeLayout, dispatchPaint } from "../chartDispatch";
import { getChartMark, listChartMarks } from "../markRegistry";
import { makeRecordingCtx } from "./dispatch-recordingCtx";
// Side-effect import: registering the built-in marks IS chartDispatch's job.
import "../chartDispatch";

const THEME = DEFAULT_CHART_THEME;
const WIDTH = 600;
const HEIGHT = 400;

const DATA: ParsedChartData = {
  categories: ["A", "B", "C", "D"],
  series: [
    { name: "S1", values: [10, 20, 30, 40], color: null },
    { name: "S2", values: [18, 26, 34, 42], color: null },
  ],
};

const BARS: ErrorBarOptions = { enabled: true, type: "percentage", direction: "both", value: 10 };

function makeSpec(mark: string, extra: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark,
    data: { startRow: 0, startCol: 0, endRow: 4, endCol: 2, sheetIndex: 0 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [
      { name: "S1", sourceIndex: 1, color: null },
      { name: "S2", sourceIndex: 2, color: null },
    ],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
    ...extra,
  } as ChartSpec;
}

const BUILTIN_MARKS: string[] = listChartMarks().filter(
  (mark) => getChartMark(mark)?.meta.builtin === true,
);

// ============================================================================
// 1. The list itself
// ============================================================================

describe("markSupportsErrorBars", () => {
  it("names the four marks whose options declare an errorBars slot", () => {
    const yes = BUILTIN_MARKS.filter(markSupportsErrorBars).sort();
    expect(yes).toEqual(["bar", "horizontalBar", "line", "scatter"]);
  });

  it("covers every built-in mark with a definite answer", () => {
    // A census rather than a spot check: the fixture cannot quietly stop
    // covering a mark the way a hand-written list can.
    expect(BUILTIN_MARKS.length).toBeGreaterThanOrEqual(18);
    for (const mark of BUILTIN_MARKS) {
      expect(typeof markSupportsErrorBars(mark)).toBe("boolean");
    }
  });
});

// ============================================================================
// 2. Reader and writer agree, mark for mark
// ============================================================================

describe("getErrorBarOptions / withErrorBarOptions", () => {
  it("reads back exactly what it wrote, on every supporting mark", () => {
    for (const mark of BUILTIN_MARKS.filter(markSupportsErrorBars)) {
      const patch = withErrorBarOptions(makeSpec(mark), BARS);
      expect(patch, mark).not.toBeNull();
      const written = { ...makeSpec(mark), ...patch } as ChartSpec;
      expect(getErrorBarOptions(written), mark).toEqual(BARS);
    }
  });

  it("refuses to write on a mark it refuses to read, with no exceptions", () => {
    for (const mark of BUILTIN_MARKS.filter((m) => !markSupportsErrorBars(m))) {
      expect(withErrorBarOptions(makeSpec(mark), BARS), mark).toBeNull();
      // ...and the reader agrees even when a spec carries the field anyway,
      // which is the state an older or hand-edited spec can be in.
      const sneaked = makeSpec(mark, { markOptions: { errorBars: BARS } as ChartSpec["markOptions"] });
      expect(getErrorBarOptions(sneaked), mark).toBeUndefined();
    }
  });

  it("keeps every other markOption the chart already had", () => {
    // The write is a patch to ONE slot. A writer that replaced markOptions
    // wholesale would silently reset the bar radius, the stack mode and the gap
    // width the moment a reader deleted one series' error bars.
    const spec = makeSpec("bar", {
      markOptions: { borderRadius: 7, stackMode: "stacked", gapWidth: 42 } as ChartSpec["markOptions"],
    });
    const patch = withErrorBarOptions(spec, BARS);
    expect(patch).not.toBeNull();
    const opts = patch!.markOptions as Record<string, unknown>;
    expect(opts.borderRadius).toBe(7);
    expect(opts.stackMode).toBe("stacked");
    expect(opts.gapWidth).toBe(42);
    expect(opts.errorBars).toEqual(BARS);
  });

  it("does not mutate the spec it was handed", () => {
    const spec = makeSpec("line");
    const before = JSON.stringify(spec);
    withErrorBarOptions(spec, BARS);
    expect(JSON.stringify(spec)).toBe(before);
  });
});

// ============================================================================
// 3. The DISPATCHER's gate is the same list — the drift that would be invisible
// ============================================================================

describe("dispatchPaint draws error bars on exactly the marks that can store them", () => {
  /** Paint `mark` with error bars enabled; answer how many bars were recorded. */
  function paintedErrorBarCount(mark: string): number {
    const spec = withErrorBarOptions(makeSpec(mark), BARS)
      ? ({ ...makeSpec(mark), ...withErrorBarOptions(makeSpec(mark), BARS) } as ChartSpec)
      : makeSpec(mark, { markOptions: { errorBars: BARS } as ChartSpec["markOptions"] });
    const layout = dispatchComputeLayout(WIDTH, HEIGHT, spec, DATA, THEME);
    const { ctx } = makeRecordingCtx(WIDTH, HEIGHT);
    dispatchPaint(ctx, DATA, spec, layout, THEME);
    return layout.elements?.errorBars?.length ?? 0;
  }

  it("paints them for every mark whose options can hold them", () => {
    for (const mark of BUILTIN_MARKS.filter(markSupportsErrorBars)) {
      expect(paintedErrorBarCount(mark), mark).toBeGreaterThan(0);
    }
  });

  it("paints none for the marks that cannot, even when the field is present", () => {
    // The spec is deliberately given an `errorBars` object it has no business
    // carrying. Nothing may draw from it, because nothing can read it back —
    // the alternative is a chart that shows bars the pane cannot edit.
    for (const mark of BUILTIN_MARKS.filter((m) => !markSupportsErrorBars(m))) {
      expect(paintedErrorBarCount(mark), mark).toBe(0);
    }
  });
});

// ============================================================================
// 4. ONE WRITER — the guard that keeps the collapse collapsed
// ============================================================================

describe("the errorBars slot has exactly one writer", () => {
  const CHARTS_ROOT = path.resolve(__dirname, "../..");
  /** `markOptions: { ... errorBars: ... }` — the hand-spread this file replaced. */
  const HAND_WRITE = /markOptions[\s\S]{0,120}?errorBars\s*:/;

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        sourceFiles(full, out);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  it("is rendering/errorBarPainter.ts and nothing else", () => {
    // Read at test time, the shape `interpreterReachDrift.test.ts` uses: a type
    // cannot observe "nobody else spells this", but the source can be diffed.
    // TEST fixtures are exempt — a test that builds a spec by hand is stating
    // the on-disk shape, which is exactly what it should do.
    const offenders = sourceFiles(CHARTS_ROOT)
      .filter((file) => HAND_WRITE.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(CHARTS_ROOT, file).replace(/\\/g, "/"));

    expect(offenders).toEqual(["rendering/errorBarPainter.ts"]);
  });

  it("finds the files it is supposed to be reading (parser self-check)", () => {
    // A guard whose scan silently matched nothing would pass forever. This
    // asserts the walk reaches a known file with known content, WITHOUT
    // asserting the offender list, so it fails only on a broken scan.
    const files = sourceFiles(CHARTS_ROOT).map((f) =>
      path.relative(CHARTS_ROOT, f).replace(/\\/g, "/"),
    );
    expect(files).toContain("rendering/errorBarPainter.ts");
    expect(files).toContain("components/ChartContextMenu.tsx");
    expect(files).toContain("components/tabs/DesignTab.tsx");
    expect(files.length).toBeGreaterThan(50);
    expect(HAND_WRITE.test("markOptions: { ...base, errorBars: next }")).toBe(true);
  });
});
