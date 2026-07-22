//! FILENAME: app/extensions/Reports/lib/reportQueryProvider.test.ts
// PURPOSE: The Reports family hookup to the shared query-object refresh service:
//   binding extraction from DSL @params, targeted refreshes marked auto, one
//   grid refresh per pass, per-object failure isolation.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReportInfo } from "../types";

const mockListReports = vi.fn();
const mockRefreshReport = vi.fn();
const mockRefreshGridCells = vi.fn();
vi.mock("./reportRefresh", () => ({
  listReports: (...a: unknown[]) => mockListReports(...a),
  refreshReport: (...a: unknown[]) => mockRefreshReport(...a),
  refreshGridCells: (...a: unknown[]) => mockRefreshGridCells(...a),
}));

import { registerReportQueryProvider } from "./reportQueryProvider";
import { refreshBoundQueryObjects } from "../../_shared/lib/queryObjectRefresh";

function makeReport(overrides: Partial<ReportInfo> = {}): ReportInfo {
  return {
    id: "r-1",
    name: "Report 1",
    dslText: "FILTERS: x = @Region\nVALUES: [M]",
    connectionId: "conn-1",
    sheetIndex: 0,
    anchorRow: 0,
    anchorCol: 0,
    endRow: 5,
    endCol: 2,
    ...overrides,
  };
}

let unregister: (() => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  mockRefreshReport.mockResolvedValue({ ok: true });
  unregister = registerReportQueryProvider();
});

afterEach(() => {
  unregister?.();
  unregister = null;
});

describe("reportQueryProvider", () => {
  it("refreshes only reports whose @params reference a changed control (auto)", async () => {
    mockListReports.mockResolvedValue([
      makeReport({ id: "r-1", dslText: "FILTERS: x = @Region\nVALUES: [M]" }),
      makeReport({ id: "r-2", dslText: 'FILTERS: y = @"Products.Category"\nVALUES: [M]' }),
      makeReport({ id: "r-3", dslText: "ROWS: a\nVALUES: [M]" }),
    ]);

    await refreshBoundQueryObjects(["region"]); // case-insensitive

    expect(mockRefreshReport).toHaveBeenCalledTimes(1);
    expect(mockRefreshReport.mock.calls[0][0].id).toBe("r-1");
    expect(mockRefreshReport.mock.calls[0][1]).toEqual({ auto: true });
    expect(mockRefreshGridCells).toHaveBeenCalledTimes(1);
  });

  it("quoted (dotted) bindings target correctly", async () => {
    mockListReports.mockResolvedValue([
      makeReport({ id: "r-2", dslText: 'FILTERS: y = @"Products.Category"\nVALUES: [M]' }),
    ]);

    await refreshBoundQueryObjects(["Products.Category"]);

    expect(mockRefreshReport).toHaveBeenCalledTimes(1);
    expect(mockRefreshReport.mock.calls[0][0].id).toBe("r-2");
  });

  it("a failing report does not block others; grid still refreshes once", async () => {
    mockListReports.mockResolvedValue([
      makeReport({ id: "r-1" }),
      makeReport({ id: "r-2" }),
    ]);
    mockRefreshReport
      .mockResolvedValueOnce({ ok: false, message: "boom" })
      .mockResolvedValueOnce({ ok: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await refreshBoundQueryObjects(["Region"]);

    expect(mockRefreshReport).toHaveBeenCalledTimes(2);
    expect(mockRefreshGridCells).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not refresh the grid when nothing ran successfully", async () => {
    mockListReports.mockResolvedValue([makeReport({ id: "r-1" })]);
    mockRefreshReport.mockResolvedValue({ ok: false, message: "nope" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await refreshBoundQueryObjects(["Region"]);

    expect(mockRefreshGridCells).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
