//! FILENAME: app/extensions/Charts/lib/__tests__/chartModelVisuals.test.ts
// PURPOSE: The Charts provider for @api/modelVisuals (P4, S5): which charts
//          read a model and what part each can play -- read through the
//          PUBLIC seam (listModelVisuals / modelVisualOf), as Edit
//          interactions and the script host will.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "../../rendering/chartDispatch";

const mockGetAllCharts = vi.fn();
vi.mock("../chartStore", () => ({
  getAllCharts: (...a: unknown[]) => mockGetAllCharts(...a),
}));

// Sheet 1 is the canvas "id-1"; sheet 2 the worksheet "id-2".
vi.mock("@api/reportPages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/reportPages")>()),
  getReportPagesSnapshot: () => ({
    pages: [{ sheetId: "id-1", name: "Canvas1", index: 1, visibility: "visible", isTooltipPage: false }],
    sheetIdByIndex: new Map([
      [1, "id-1"],
      [2, "id-2"],
    ]),
    activeIndex: 1,
    version: 1,
  }),
}));

import { listModelVisuals, modelVisualOf } from "@api/modelVisuals";
import {
  MARK_NOT_SOURCE_REASON,
  PIVOT_CHART_REASON,
  RANGE_CHART_REASON,
  TRANSFORMED_SOURCE_REASON,
  WORKSHEET_SOURCE_REASON,
  registerChartModelVisuals,
} from "../chartModelVisuals";

const dq = { type: "designQuery", dslText: "ROWS: Geo.Region\nVALUES: [Revenue]", connectionId: 7 };

function chart(chartId: string, sheetIndex: number, mark: string, data: unknown, extra: Record<string, unknown> = {}) {
  return { chartId, name: `Chart ${chartId}`, sheetIndex, spec: { mark, data, ...extra } };
}

let unregister: (() => void) | null = null;
beforeEach(() => {
  unregister = registerChartModelVisuals();
  mockGetAllCharts.mockReturnValue([
    chart("bar", 1, "bar", dq),
    chart("line", 1, "line", dq),
    chart("card", 1, "card", dq),
    chart("ws", 2, "bar", dq),
    chart("tx", 1, "bar", dq, { transform: [{ type: "filter", expr: "true" }] }),
    chart("range", 1, "bar", { startRow: 0, startCol: 0, endRow: 3, endCol: 1, sheetIndex: 1 }),
    chart("pc", 1, "bar", { type: "pivot", pivotId: "p-1" }),
  ]);
});
afterEach(() => {
  unregister?.();
  unregister = null;
});

describe("the Charts provider", () => {
  it("a design-query bar on a canvas: a source and a target that can highlight, on its connection and page", () => {
    expect(modelVisualOf({ kind: "chart", id: "bar" })).toEqual({
      ref: { kind: "chart", id: "bar" },
      name: "Chart bar",
      sheetIndex: 1,
      sheetId: "id-1",
      connectionId: "7",
      role: { source: true, target: true, canHighlight: true, reason: null },
      label: "Column chart",
    });
  });

  it("a line is a source but a filter-only target; a card is never a source", () => {
    expect(modelVisualOf({ kind: "chart", id: "line" })?.role).toEqual({ source: true, target: true, canHighlight: false, reason: null });
    const card = modelVisualOf({ kind: "chart", id: "card" });
    expect(card?.label).toBe("Card");
    expect(card?.role).toEqual({ source: false, target: true, canHighlight: false, reason: MARK_NOT_SOURCE_REASON });
  });

  it("on a worksheet, or with a transform, a design-query chart is not a source (still a target)", () => {
    expect(modelVisualOf({ kind: "chart", id: "ws" })?.role).toMatchObject({ source: false, target: true, reason: WORKSHEET_SOURCE_REASON });
    expect(modelVisualOf({ kind: "chart", id: "tx" })?.role).toMatchObject({ source: false, target: true, reason: TRANSFORMED_SOURCE_REASON });
  });

  it("a range chart and a PivotChart read no model: no connection, no role, a reason each", () => {
    expect(modelVisualOf({ kind: "chart", id: "range" })).toMatchObject({
      connectionId: null,
      role: { source: false, target: false, canHighlight: false, reason: RANGE_CHART_REASON },
    });
    expect(modelVisualOf({ kind: "chart", id: "pc" })).toMatchObject({
      connectionId: null,
      role: { source: false, target: false, canHighlight: false, reason: PIVOT_CHART_REASON },
    });
  });

  it("listModelVisuals filters by connection and page", () => {
    expect(listModelVisuals({ connectionId: "7", sheetId: "id-1" }).map((v) => v.ref.id)).toEqual(["bar", "line", "card", "tx"]);
    expect(listModelVisuals({ connectionId: "7", sheetId: "id-2" }).map((v) => v.ref.id)).toEqual(["ws"]);
  });

  it("unregistered, the provider lists nothing", () => {
    unregister?.();
    unregister = null;
    expect(listModelVisuals().filter((v) => v.ref.kind === "chart")).toEqual([]);
  });
});
