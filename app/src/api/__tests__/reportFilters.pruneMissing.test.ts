//! FILENAME: app/src/api/__tests__/reportFilters.pruneMissing.test.ts
// PURPOSE: `pruneMissingCrossFilterSources(kind, liveIds, pageSheetId?)` -- a
//          visual that vanished by ANY route (undo of its creation, a
//          script/MCP/AI removal, a reload) takes its cross-filter selection
//          with it, as the explicit Delete does (DECISIONS2 P4: "cleared on
//          source delete"). Each family calls it from its store reload.
// CONTEXT: Before it existed only the Delete command cleared a selection; a
//          chart removed by Ctrl+Z kept its page filtered, and the pivot box
//          beside it refused every gesture with "Filtered by Chart A" while
//          Chart A no longer existed.

import { describe, it, expect, beforeEach } from "vitest";
import {
  clearCrossFilters,
  getCrossFilters,
  onReportFiltersChange,
  pruneMissingCrossFilterSources,
  setCrossFilter,
  type CrossFilterSelection,
  type ReportFiltersChange,
} from "../reportFilters";

function selection(kind: "chart" | "pivot", id: string, page = "sheet-2"): CrossFilterSelection {
  return {
    source: { kind, id },
    sourceName: `${kind} ${id}`,
    pageSheetId: page,
    connectionId: "conn-1",
    fields: ["Geo.Region"],
    tuples: [["East"]],
  };
}

const sources = () => getCrossFilters().map((s) => `${s.source.kind}:${s.source.id}`);

beforeEach(() => {
  clearCrossFilters();
});

describe("pruneMissingCrossFilterSources", () => {
  it("clears the selection of a source of that kind that is no longer live, and keeps the rest", () => {
    setCrossFilter(selection("chart", "c1"));
    setCrossFilter(selection("chart", "c2"));
    setCrossFilter(selection("pivot", "c1"));
    const changes: ReportFiltersChange[] = [];
    const off = onReportFiltersChange((c) => changes.push(c));
    try {
      pruneMissingCrossFilterSources("chart", ["c2"]);
    } finally {
      off();
    }
    expect(sources(), "a vanished chart kept its selection").toEqual(["chart:c2", "pivot:c1"]);
    expect(changes.length, "the prune was not announced").toBeGreaterThan(0);
    expect(changes.flatMap((c) => c.pages)).toContainEqual({ sheetId: "sheet-2", connectionId: "conn-1" });
  });

  it("scoped to a page, it leaves the same kind on other pages alone", () => {
    setCrossFilter(selection("pivot", "p1", "sheet-2"));
    setCrossFilter(selection("pivot", "p9", "sheet-3"));
    pruneMissingCrossFilterSources("pivot", [], "sheet-2");
    expect(sources()).toEqual(["pivot:p9"]);
  });

  it("announces nothing when every source is live", () => {
    setCrossFilter(selection("chart", "c1"));
    const changes: ReportFiltersChange[] = [];
    const off = onReportFiltersChange((c) => changes.push(c));
    try {
      pruneMissingCrossFilterSources("chart", new Set(["c1"]));
    } finally {
      off();
    }
    expect(changes).toEqual([]);
    expect(sources()).toEqual(["chart:c1"]);
  });
});
