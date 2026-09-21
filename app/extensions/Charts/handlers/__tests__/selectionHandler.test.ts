//! FILENAME: app/extensions/Charts/handlers/__tests__/selectionHandler.test.ts
// PURPOSE: The chart's selection ladder, and the one thing it owes the overlay:
//          a ring must never outlive the selection that chose it.
// CONTEXT: The ladder is chart -> series -> dataPoint, and it is the ONLY
//          selection a chart has. The overlay's "selected cue" is not a second
//          selection the reader makes; it is a note of which ring sits on the
//          datum they just clicked. So when the reader leaves the chart, the
//          note goes with it — otherwise the context menu still offers to act
//          on a point of interest nobody is looking at, which is the defect
//          the owner reported in its other form (a comment written onto a bar
//          they had already clicked away from).

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@api", () => ({
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));

const handler = await import("../selectionHandler");
const cues = await import("@api/chartCues");

function ring(factId: string, categoryIndex: number, ordinal = 0) {
  return {
    cueId: `${factId}#${ordinal}`,
    factId,
    kind: "ring" as const,
    polarity: "neutral" as const,
    anchor: { type: "datum" as const, series: "Sales", categoryIndex, categoryLabel: `C${categoryIndex}` },
  };
}

beforeEach(() => {
  handler.resetSelectionHandlerState();
  cues.clearAllChartCues();
});

describe("the selection ladder", () => {
  it("climbs chart -> series -> dataPoint on repeated clicks of one bar", () => {
    handler.selectChart("c1");
    expect(handler.getSubSelection().level).toBe("chart");

    handler.advanceSelection("c1", { type: "bar", seriesIndex: 0, categoryIndex: 3 } as never);
    expect(handler.getSubSelection()).toMatchObject({ level: "series", seriesIndex: 0 });

    handler.advanceSelection("c1", { type: "bar", seriesIndex: 0, categoryIndex: 3 } as never);
    expect(handler.getSubSelection()).toMatchObject({ level: "dataPoint", seriesIndex: 0, categoryIndex: 3 });
  });

  it("drops back to chart level on a click that is not on a datum", () => {
    handler.selectChart("c1");
    handler.advanceSelection("c1", { type: "bar", seriesIndex: 0, categoryIndex: 3 } as never);
    handler.advanceSelection("c1", { type: "plotArea" } as never);
    expect(handler.getSubSelection().level).toBe("chart");
  });
});

describe("leaving a chart", () => {
  it("takes the selected ring with it", () => {
    cues.setChartCues("c1", [ring("extremes", 4), ring("extremes", 2, 1)]);
    cues.setSelectedChartCue("c1", "extremes#1");
    handler.selectChart("c1");
    expect(cues.getSelectedChartCue("c1")).not.toBeNull();

    handler.deselectChart();

    expect(cues.getSelectedChartCue("c1"), "a ring must not outlive the chart's selection").toBeNull();
    // The cues themselves stay: the lens is still on, the reader just stepped away.
    expect(cues.getChartCues("c1")).toHaveLength(2);
  });

  it("does nothing when no chart was selected", () => {
    cues.setChartCues("c1", [ring("extremes", 4)]);
    cues.setSelectedChartCue("c1", "extremes#0");

    handler.deselectChart(); // never selected c1

    expect(cues.getSelectedChartCue("c1")?.cueId).toBe("extremes#0");
  });

  it("clears the ring of the chart being LEFT, not of some other chart", () => {
    cues.setChartCues("c1", [ring("extremes", 4)]);
    cues.setChartCues("c2", [ring("extremes", 1)]);
    cues.setSelectedChartCue("c1", "extremes#0");
    cues.setSelectedChartCue("c2", "extremes#0");

    handler.selectChart("c1");
    handler.deselectChart();

    expect(cues.getSelectedChartCue("c1")).toBeNull();
    expect(cues.getSelectedChartCue("c2")?.cueId, "another chart's ring is none of its business").toBe("extremes#0");
  });
});
