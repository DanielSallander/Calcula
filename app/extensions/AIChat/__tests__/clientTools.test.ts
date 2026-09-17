//! FILENAME: app/extensions/AIChat/__tests__/clientTools.test.ts
// PURPOSE: `show_points_of_interest` picks its target honestly (a named chart,
//          pivot or rectangle, else the selected chart, else a refusal that
//          says what to pass), reaches the overlay through the seam, and
//          reports what it drew in words the model can relay.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  provider: { current: null as unknown },
  selected: { current: null as string | null },
}));

vi.mock("@api", () => ({
  getInsightsProvider: () => h.provider.current,
  getSelectedChartId: () => h.selected.current,
  listChartsForData: () => [{ chartId: "c1", name: "Sales by month", title: null, sheetIndex: 0, mark: "bar", sourceKind: "range" }],
}));

const { targetFromInput, runClientTool, CLIENT_TOOL_NAMES } = await import("../lib/clientTools");

beforeEach(() => {
  h.provider.current = null;
  h.selected.current = null;
});

describe("targetFromInput", () => {
  it("prefers a chart id, then a pivot id, then a rectangle, then the selected chart, else explains", () => {
    expect(targetFromInput({ chart_id: "c1", pivot_id: "p1" }, "c9")).toEqual({ kind: "chart", chartId: "c1" });
    expect(targetFromInput({ pivot_id: "p1" }, "c9")).toEqual({ kind: "pivot", pivotId: "p1" });
    expect(targetFromInput({ start_row: 1, start_col: 2, end_row: 9, end_col: 4, sheet_index: 2 }, null)).toEqual({
      kind: "range", request: { sheetIndex: 2, startRow: 1, startCol: 2, endRow: 9, endCol: 4 },
    });
    expect(targetFromInput({ start_row: 1 }, "c9")).toEqual({ kind: "chart", chartId: "c9" });
    expect(typeof targetFromInput({}, null)).toBe("string");
  });
});

describe("show_points_of_interest", () => {
  it("is the one client tool, and unknown names fall through to Rust", () => {
    expect([...CLIENT_TOOL_NAMES]).toEqual(["show_points_of_interest"]);
    expect(runClientTool("list_charts", {})).toBeNull();
  });

  it("says so when Insights is not loaded", async () => {
    await expect(runClientTool("show_points_of_interest", { chart_id: "c1" })).resolves.toContain("not loaded");
  });

  it("reports what it drew, by chart name, with the tier notice", async () => {
    const show = vi.fn().mockResolvedValue({ outcome: "shown", count: 3, notice: "3 points of interest, computed from the numbers; no strategy declares which way is good." });
    h.provider.current = { showPointsOfInterest: show };
    const text = await runClientTool("show_points_of_interest", { chart_id: "c1" });
    expect(show).toHaveBeenCalledWith({ kind: "chart", chartId: "c1" });
    expect(text).toContain("Drew 3 points of interest on chart Sales by month");
    expect(text).toContain("no strategy declares");
    expect(text).toContain("do not restate the numbers");
  });

  it("uses the selected chart when nothing is named, and reports a refusal or an empty result plainly", async () => {
    h.selected.current = "c1";
    const show = vi.fn().mockResolvedValue({ outcome: "refused", count: 0, reason: "no series" });
    h.provider.current = { showPointsOfInterest: show };
    await expect(runClientTool("show_points_of_interest", {})).resolves.toContain("Could not show points of interest on chart Sales by month: no series.");
    show.mockResolvedValue({ outcome: "shown", count: 0 });
    await expect(runClientTool("show_points_of_interest", {})).resolves.toContain("Nothing stands out");
  });
});
