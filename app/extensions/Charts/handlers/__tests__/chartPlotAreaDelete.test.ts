//! FILENAME: app/extensions/Charts/handlers/__tests__/chartPlotAreaDelete.test.ts
// PURPOSE: The three correctness gaps Wave D named and deliberately left, each
//          because it was a product decision rather than a repair:
//
//            1. the PLOT AREA was keyboard-reachable and mouse-unreachable, and
//               Delete there destroyed the whole chart;
//            2. `LegendSpec.hiddenEntries` had no writer, so Delete on one
//               legend ROW hid the whole legend;
//            3. the Name Box said the chart's NAME where Excel says "Chart
//               Area" (pinned in ChartFormatPaneSelection.test.ts, next to the
//               rest of the display-name vocabulary).
//
// CONTEXT: THE LADDER IS DRIVEN THROUGH THE REAL HIT-TESTER here, not against
//          hand-written hit results. The whole of gap 1 was a disagreement
//          between what the hit-tester could NAME (`plotArea` and `chartArea`
//          are separate answers, and have been since the top and right margins
//          stopped being dead pixels) and what the ladder could REACH, so a
//          test that fed the ladder a fixture would have proved nothing about
//          the pixel the reader actually clicks.
//
//          GAP 1'S DELETE HALF IS PROVED IN TWO PLACES, on purpose. The rungs
//          themselves are a pure list (`CHART_AREA_ELEMENT_IDS`, pinned in
//          chartKeyboardNav.test.ts); that the LISTENER consults the list
//          BEFORE its destroy arm is a property of index.ts, which no unit test
//          can reach without booting the whole extension — so it is read off
//          the source, the same way `interpreterReachDrift` reads the Rust
//          manifest. Moving the destroy arm above the guard fails it.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";

import { hitTestGeometry } from "../../rendering/chartHitTesting";
import { hideLegendEntryPatch } from "../../components/ChartContextMenu";
import type { ChartLayout, ChartSpec, HitGeometry } from "../../types";

vi.mock("@api", () => ({
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));

const handler = await import("../selectionHandler");

const CHART = "c1";

// ============================================================================
// A real cartesian layout — a title, a legend of two rows, both axes
// ============================================================================

const LAYOUT: ChartLayout = {
  width: 600,
  height: 400,
  margin: { top: 40, right: 110, bottom: 60, left: 70 },
  plotArea: { x: 70, y: 40, width: 420, height: 300 },
  elements: {
    family: "cartesian",
    chartArea: { x: 0, y: 0, width: 600, height: 400 },
    title: { x: 200, y: 4, width: 200, height: 24 },
    xAxisBand: { x: 70, y: 340, width: 420, height: 28 },
    yAxisBand: { x: 30, y: 40, width: 40, height: 300 },
    legend: { x: 500, y: 100, width: 90, height: 60 },
    legendItems: [
      { seriesIndex: 0, rect: { x: 504, y: 104, width: 82, height: 20 } },
      { seriesIndex: 1, rect: { x: 504, y: 130, width: 82, height: 20 } },
    ],
    measured: ["title", "legend"],
  },
};

const GEOMETRY: HitGeometry = {
  type: "bars",
  rects: [
    { seriesIndex: 0, categoryIndex: 1, x: 120, y: 80, width: 40, height: 180, value: 500, seriesName: "Sales", categoryName: "Feb" },
    { seriesIndex: 1, categoryIndex: 1, x: 170, y: 120, width: 40, height: 140, value: 300, seriesName: "Costs", categoryName: "Feb" },
  ],
};

/** Hit-test a pixel for real, then advance the ladder with what came back. */
function clickAt(x: number, y: number): void {
  handler.advanceSelection(CHART, hitTestGeometry(x, y, GEOMETRY, LAYOUT));
}

const ON_PLOT_BACKGROUND = [400, 300] as const;
const ON_TOP_MARGIN = [300, 34] as const;
const ON_RIGHT_MARGIN = [560, 250] as const;
const ON_TITLE = [300, 12] as const;
const ON_BAR_S0 = [140, 150] as const;

beforeEach(() => {
  handler.resetSelectionHandlerState();
  handler.selectChart(CHART);
});

// ============================================================================
// GAP 1a — the plot area is CLICKABLE, and the outer margin is the way back
// ============================================================================

describe("the plot area is a rung the mouse can reach", () => {
  it("the hit-tester really does tell the two areas apart", () => {
    // Everything below leans on this. If the hit-tester answered the same thing
    // for both pixels there would be no route back to chart level at all, and
    // the ladder change would be a trap rather than a fix.
    expect(hitTestGeometry(...ON_PLOT_BACKGROUND, GEOMETRY, LAYOUT).element).toBe("plotArea");
    expect(hitTestGeometry(...ON_TOP_MARGIN, GEOMETRY, LAYOUT).element).toBe("chartArea");
    expect(hitTestGeometry(...ON_RIGHT_MARGIN, GEOMETRY, LAYOUT).element).toBe("chartArea");
  });

  it("a click on the plot background selects the PLOT AREA", () => {
    clickAt(...ON_PLOT_BACKGROUND);
    expect(handler.getSubSelection()).toEqual({ level: "element", elementId: "plotArea" });
  });

  it("a click on the outer margin selects the CHART, which is the way back out", () => {
    clickAt(...ON_PLOT_BACKGROUND);
    expect(handler.getSubSelection().level).toBe("element");
    clickAt(...ON_TOP_MARGIN);
    expect(handler.getSubSelection()).toEqual({ level: "chart" });
  });

  it("leaves the plot area for anything else the ladder already knew", () => {
    clickAt(...ON_PLOT_BACKGROUND);
    clickAt(...ON_TITLE);
    expect(handler.getSubSelection()).toEqual({ level: "element", elementId: "title" });

    clickAt(...ON_PLOT_BACKGROUND);
    clickAt(...ON_BAR_S0);
    expect(handler.getSubSelection()).toMatchObject({ level: "series", seriesIndex: 0 });
  });

  it("a datum still beats the plot area it sits on", () => {
    clickAt(...ON_BAR_S0);
    expect(handler.getSubSelection()).toMatchObject({ level: "series", seriesIndex: 0 });
  });

  it("Escape is the keyboard's way out of the plot area", () => {
    expect(handler.escapeLevelUp({ level: "element", elementId: "plotArea" })).toEqual({
      level: "chart",
    });
  });

  it("the rung the MOUSE now produces is the same one the KEYBOARD walks to", () => {
    // The point of the gap: the walk has emitted this rung all along. Now both
    // devices address the identical sub-selection, so the Format pane, the
    // selection box and the Name Box cannot see one and not the other.
    const groups = handler.buildChartNavGroups(LAYOUT, GEOMETRY);
    const walked = groups.find((g) => g.id === "plotArea")!.members[0];
    clickAt(...ON_PLOT_BACKGROUND);
    expect(handler.getSubSelection()).toEqual(walked);
    expect(handler.findChartNavPosition(groups, handler.getSubSelection())).not.toBeNull();
  });
});

// ============================================================================
// GAP 1b — Delete on either area must not destroy the chart
// ============================================================================

function chartsIndexSource(): string {
  return readFileSync(path.resolve(__dirname, "../../index.ts"), "utf8");
}

/**
 * `runChartDeleteAction`'s body, read out of index.ts at test time.
 *
 * It used to be `handleDeleteKey`'s body. The act was lifted out of the
 * listener because the listener CANNOT SEE the Delete key: `@api/keybindings`
 * installs a window-capture listener — strictly outside this file's
 * document-capture door — and consumes Delete for `core.edit.clearContents`.
 * The act is now reached from two doors (the registry command for Delete, the
 * listener for Backspace), so it is the act, not the listener, that these
 * guards read.
 */
function deleteListenerSource(): string {
  const source = chartsIndexSource();
  const start = source.indexOf("const runChartDeleteAction = (): void => {");
  const end = source.indexOf("const handleDeleteKey = (e: KeyboardEvent) => {", start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      "runChartDeleteAction was not found in app/extensions/Charts/index.ts — this guard " +
        "cannot see the act, so it is not guarding anything.",
    );
  }
  return source.slice(start, end);
}

describe("Delete at an AREA rung is not a route to destroying the chart", () => {
  it("finds the listener at all (the guard has something to read)", () => {
    const body = deleteListenerSource();
    expect(body).toContain("performChartDelete(chartId)");
    expect(body.length).toBeGreaterThan(400);
  });

  it("guards the two areas, unconditionally, BEFORE the destroy arm", () => {
    // The defect this pins: `plotArea` fell through every element branch into
    // `performChartDelete`, so Down, Down, Down, Delete destroyed the chart
    // from the rung a reader selects in order to FORMAT the plot area.
    //
    // The guard is pinned as a WHOLE STATEMENT rather than by the presence of
    // the call, because `isChartAreaElement(...)` appearing somewhere in the
    // listener proves nothing: an `&& false &&` in front of it, or any other
    // condition bolted on, leaves the call in the source and the rung in the
    // destroy arm. Move the destroy arm above it, weaken it, or delete it, and
    // this goes red.
    const body = deleteListenerSource();
    const GUARD = 'if (sub.level === "element" && isChartAreaElement(sub.elementId)) {';
    const guard = body.indexOf(GUARD);
    const destroy = body.indexOf("performChartDelete(chartId)");
    expect(guard, "the Delete listener has no unconditional area guard").toBeGreaterThan(-1);
    expect(guard).toBeLessThan(destroy);
    // ...and the branch it opens does nothing at all. The keystroke is consumed
    // once, at the door (see the Delete-reaches-the-chart guards below), which
    // is why this branch is a bare `return` rather than a preventDefault pair.
    const branch = body.slice(guard + GUARD.length, body.indexOf("}", guard + GUARD.length));
    expect(branch.replace(/\s/g, "")).toBe("return;");
  });

  it("hides ONE legend row before the destroy arm, through the shared resolver", () => {
    const body = deleteListenerSource();
    const hide = body.indexOf("hideLegendEntryPatch(");
    const destroy = body.indexOf("performChartDelete(chartId)");
    expect(hide, "the Delete listener never asks hideLegendEntryPatch").toBeGreaterThan(-1);
    expect(hide).toBeLessThan(destroy);
    // And it moves the selection off the row it just hid, rather than leaving
    // the stale subject the cue rings already taught us about.
    expect(body).toContain("selectionAfterHidingLegendEntry(");
  });

  it("keeps the destroy arm for the chart OBJECT and nothing else", () => {
    // `performChartDelete` must be reached only after every `sub.level ===
    // "element"` branch has had its say — i.e. it is the LAST statement of the
    // listener, not a branch of its own.
    const body = deleteListenerSource();
    const after = body.slice(body.indexOf("performChartDelete(chartId)"));
    expect(after.replace(/[\s;}]/g, "")).toBe("performChartDelete(chartId)");
  });
});

// ============================================================================
// The Delete key has to REACH the act at all
// ============================================================================
//
// Measured live before this was fixed: with a chart title selected and the grid
// focused, Delete cleared the sentinel in A1 and left the title standing. The
// keybinding registry's listener is capture-phase on `window` — outside this
// extension's document-capture door — and calls stopPropagation() the moment it
// matches `core.clearContents`, so EVERY branch above sat behind a door the key
// never reached. The only honest way to take the key back is a registry binding
// with a `when` predicate, which beats the unguarded built-in.

describe("Delete reaches the chart instead of clearing the user's cells", () => {
  it("claims Delete through the keybinding registry, guarded by the selection", () => {
    const source = chartsIndexSource();
    const at = source.indexOf('id: "ext.charts.deleteSelection"');
    expect(at, "Charts does not stand in the keybinding registry for Delete").toBeGreaterThan(-1);

    const registration = source.slice(at, source.indexOf("\n  );", at));
    expect(registration).toContain('combo: "Delete"');
    expect(registration).toContain("commandId: CHART_DELETE_SELECTION_COMMAND");
    // "not-editing" is what refuses the key inside a text field OR inside a
    // pointer claim (the dispatcher's `ownsItsOwnKeys`), which is two of
    // `chartOwnsKeystroke`'s three gates.
    expect(registration).toContain('context: "not-editing"');
    // The `when` predicate is the whole mechanism: an UNGUARDED binding loses
    // the tie to the built-in, which is registered first.
    expect(registration).toContain("getCurrentChartId() !== null && isGridFocused()");
  });

  it("runs the very same act the Backspace listener runs", () => {
    const source = chartsIndexSource();
    const command = source.slice(source.indexOf("CommandRegistry.register(CHART_DELETE_SELECTION_COMMAND"));
    expect(command.slice(0, 200)).toContain("runChartDeleteAction()");
    // ...and the listener is still there for Backspace, which nothing else binds.
    expect(source).toContain('if (e.key !== "Delete" && e.key !== "Backspace") return;');
  });

  it("consumes the keystroke once, at the listener door", () => {
    const source = chartsIndexSource();
    const start = source.indexOf("const handleDeleteKey = (e: KeyboardEvent) => {");
    const door = source.slice(start, source.indexOf('document.addEventListener("keydown", handleDeleteKey', start));
    // Both gates still asked at the door (the globalInputListeners census
    // requires the claim predicate to be visible where the listener lives).
    expect(door).toContain("isKeyClaimed(e)");
    expect(door).toContain("chartOwnsKeystroke(e)");
    expect(door).toContain("e.preventDefault()");
    expect(door).toContain("e.stopPropagation()");
    expect(door).toContain("runChartDeleteAction()");
  });
});

// ============================================================================
// GAP 2 — hiding ONE legend entry, with the series left plotted
// ============================================================================

function legendSpec(over: Partial<ChartSpec["legend"]> = {}): ChartSpec {
  return {
    mark: "bar",
    data: { type: "range", range: "A1:C4" },
    series: [{ name: "Sales" }, { name: "Costs" }, { name: "Margin" }],
    legend: { visible: true, position: "right", ...over },
  } as unknown as ChartSpec;
}

describe("hideLegendEntryPatch", () => {
  it("writes the index nothing used to write", () => {
    const patch = hideLegendEntryPatch(legendSpec(), 1);
    expect(patch).toEqual({ legend: { visible: true, position: "right", hiddenEntries: [1] } });
  });

  it("adds to the rows already hidden instead of replacing them", () => {
    const patch = hideLegendEntryPatch(legendSpec({ hiddenEntries: [2] }), 0);
    expect(patch?.legend?.hiddenEntries).toEqual([0, 2]);
  });

  it("refuses a row that is already hidden, so the act is never a no-op item", () => {
    expect(hideLegendEntryPatch(legendSpec({ hiddenEntries: [1] }), 1)).toBeNull();
  });

  it("refuses a nonsense index rather than writing one", () => {
    expect(hideLegendEntryPatch(legendSpec(), -1)).toBeNull();
    expect(hideLegendEntryPatch(legendSpec(), 1.5)).toBeNull();
  });

  it("LEAVES THE SERIES PLOTTED — that is the whole difference from Delete Legend", () => {
    const spec = legendSpec();
    const patch = hideLegendEntryPatch(spec, 1)!;
    // The legend stays visible; only a row of it leaves. "Delete Legend" writes
    // `visible: false`, and that is the coarser act this one replaces.
    expect(patch.legend?.visible).toBe(true);
    // And nothing outside the legend is touched at all — the series list and
    // the data source are the two things a reader would call "the plot".
    expect(Object.keys(patch)).toEqual(["legend"]);
  });

  it("hands back the WHOLE legend object, which is what makes the write land", () => {
    // `deepMergeSpec` replaces arrays wholesale and merges plain objects field
    // by field, so a patch carrying the complete array replaces it; a patch
    // that tried to append would be the one that got merged away.
    const spec = legendSpec({ hiddenEntries: [2] });
    const patch = hideLegendEntryPatch(spec, 0)!;
    expect(patch.legend?.hiddenEntries).toEqual([0, 2]);
    expect(patch.legend?.position).toBe("right");
  });
});

describe("where the selection goes after a row is hidden", () => {
  const rung = (seriesIndex: number) => ({
    level: "element" as const,
    elementId: "legendEntry" as const,
    seriesIndex,
  });

  it("moves to the next surviving row, so repeated Delete peels them off", () => {
    expect(handler.selectionAfterHidingLegendEntry([0, 1, 2], 0)).toEqual(rung(1));
    expect(handler.selectionAfterHidingLegendEntry([0, 1, 2], 1)).toEqual(rung(2));
  });

  it("wraps at the last row rather than stranding the reader", () => {
    expect(handler.selectionAfterHidingLegendEntry([0, 1, 2], 2)).toEqual(rung(0));
  });

  it("follows PAINT order, not numeric order", () => {
    // The rows carry the index they had before anything was hidden, and they
    // are not obliged to be in ascending order; "the next one" must mean the
    // next one the reader can see.
    expect(handler.selectionAfterHidingLegendEntry([2, 0, 1], 2)).toEqual(rung(0));
    expect(handler.selectionAfterHidingLegendEntry([2, 0, 1], 1)).toEqual(rung(2));
  });

  it("falls back to the chart when the legend has no rows left to stand on", () => {
    // Every row hidden means the legend box is not laid out at all, so neither
    // an entry nor the whole legend is a rung that exists.
    expect(handler.selectionAfterHidingLegendEntry([1], 1)).toEqual({ level: "chart" });
    // ...and the same answer when we were never told what the rows were.
    expect(handler.selectionAfterHidingLegendEntry([], 0)).toEqual({ level: "chart" });
  });

  it("never lands on the row it just hid", () => {
    for (const rows of [[0, 1, 2], [3, 1, 0], [5]]) {
      for (const hidden of rows) {
        const next = handler.selectionAfterHidingLegendEntry(rows, hidden);
        if (next.level === "element") expect(next.seriesIndex).not.toBe(hidden);
      }
    }
  });
});
