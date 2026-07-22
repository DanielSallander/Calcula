//! FILENAME: app/extensions/Reports/lib/reportRefresh.test.ts
// PURPOSE: Tests for the report refresh pipeline — error surfacing, model-cache
//   behavior, targeted control-driven refresh, failure isolation, coalescing.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReportInfo } from "../types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const controlValues: Record<string, unknown> = {};
vi.mock("@api/controlValues", () => ({
  getControlValue: (name: string) => controlValues[name],
}));

/** Count "grid:refresh" (cell REFETCH + repaint) dispatches on window. */
function gridRefreshCount(spy: ReturnType<typeof vi.spyOn>): number {
  return spy.mock.calls.filter((c) => (c[0] as Event)?.type === "grid:refresh").length;
}

// Compile is exercised by its own DSL test suite — here it's routed through a
// mock so these tests stay on reportRefresh's control flow.
const mockCompile = vi.fn();
vi.mock("../../_shared/dsl/pivotLayout/designQuery", () => ({
  compileDesignQuery: (...args: unknown[]) => mockCompile(...args),
}));

import { reportsBackend } from "./reportsBackend";
import {
  refreshReport,
  refreshControlBoundReports,
  clearReportModelCache,
} from "./reportRefresh";

const MODEL = { tables: [], measures: [] };
const COMPILED = { request: { connectionId: "conn-1" }, errors: [], warnings: [] };

function makeReport(overrides: Partial<ReportInfo> = {}): ReportInfo {
  return {
    id: "r-1",
    name: "Report 1",
    dslText: "ROWS: a\nFILTERS: x = @Region\nVALUES: [M]",
    connectionId: "conn-1",
    sheetIndex: 0,
    anchorRow: 0,
    anchorCol: 0,
    endRow: 5,
    endCol: 2,
    ...overrides,
  };
}

/** Command router the mock backend uses; tests override entries per case. */
let backend: Record<string, (args?: Record<string, unknown>) => unknown>;
const invokeLog: Array<{ command: string; args?: Record<string, unknown> }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  clearReportModelCache();
  invokeLog.length = 0;
  for (const k of Object.keys(controlValues)) delete controlValues[k];
  controlValues.Region = { kind: "text", value: "East" };
  backend = {
    get_connection_bi_model: () => MODEL,
    list_reports: () => [makeReport()],
    refresh_report: () => ({ reportId: "r-1", rowCount: 3, colCount: 2, overwrittenCellCount: 0 }),
  };
  reportsBackend.set(async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
    invokeLog.push({ command, args });
    const handler = backend[command];
    if (!handler) throw new Error(`no mock for ${command}`);
    return (await handler(args)) as T;
  });
  mockCompile.mockReturnValue(COMPILED);
});

// ---------------------------------------------------------------------------
// refreshReport
// ---------------------------------------------------------------------------

describe("refreshReport", () => {
  it("returns a message (and does not run) when the model is unavailable", async () => {
    backend.get_connection_bi_model = () => null;
    const result = await refreshReport(makeReport());
    expect(result.ok).toBe(false);
    expect(result.message).toContain("model");
    expect(invokeLog.some((c) => c.command === "refresh_report")).toBe(false);
  });

  it("does NOT cache a missing model (retries next time)", async () => {
    backend.get_connection_bi_model = () => null;
    await refreshReport(makeReport());
    backend.get_connection_bi_model = () => MODEL;
    const result = await refreshReport(makeReport());
    expect(result.ok).toBe(true);
    expect(invokeLog.filter((c) => c.command === "get_connection_bi_model")).toHaveLength(2);
  });

  it("caches a loaded model until clearReportModelCache", async () => {
    await refreshReport(makeReport());
    await refreshReport(makeReport());
    expect(invokeLog.filter((c) => c.command === "get_connection_bi_model")).toHaveLength(1);
    clearReportModelCache();
    await refreshReport(makeReport());
    expect(invokeLog.filter((c) => c.command === "get_connection_bi_model")).toHaveLength(2);
  });

  it("surfaces compile errors with line info", async () => {
    mockCompile.mockReturnValue({
      request: null,
      errors: [{ location: { line: 2 }, message: "Unknown field" }],
      warnings: [],
    });
    const result = await refreshReport(makeReport());
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Line 2: Unknown field");
  });

  it("surfaces backend failures instead of throwing", async () => {
    backend.refresh_report = () => {
      throw new Error("overlap with pivot");
    };
    const result = await refreshReport(makeReport());
    expect(result.ok).toBe(false);
    expect(result.message).toContain("overlap with pivot");
  });

  it("passes the auto flag through and returns the overwrite count", async () => {
    backend.refresh_report = () => ({
      reportId: "r-1",
      rowCount: 3,
      colCount: 2,
      overwrittenCellCount: 4,
    });
    const result = await refreshReport(makeReport(), { auto: true });
    expect(result).toEqual({ ok: true, overwrittenCellCount: 4 });
    const call = invokeLog.find((c) => c.command === "refresh_report");
    expect((call?.args?.request as Record<string, unknown>).auto).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// refreshControlBoundReports
// ---------------------------------------------------------------------------

describe("refreshControlBoundReports", () => {
  it("refreshes only reports referencing a changed control name", async () => {
    backend.list_reports = () => [
      makeReport({ id: "r-1", dslText: "FILTERS: x = @Region\nVALUES: [M]" }),
      makeReport({ id: "r-2", dslText: 'FILTERS: y = @"Products.Category"\nVALUES: [M]' }),
      makeReport({ id: "r-3", dslText: "ROWS: a\nVALUES: [M]" }),
    ];
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    await refreshControlBoundReports(["region"]); // case-insensitive
    const refreshed = invokeLog
      .filter((c) => c.command === "refresh_report")
      .map((c) => (c.args?.request as Record<string, unknown>).reportId);
    expect(refreshed).toEqual(["r-1"]);
    expect(gridRefreshCount(dispatchSpy)).toBe(1);
    dispatchSpy.mockRestore();
  });

  it("refreshes every @-bound report when no names are given", async () => {
    backend.list_reports = () => [
      makeReport({ id: "r-1", dslText: "FILTERS: x = @Region\nVALUES: [M]" }),
      makeReport({ id: "r-2", dslText: "ROWS: a\nVALUES: [M]" }),
    ];
    await refreshControlBoundReports();
    const refreshed = invokeLog
      .filter((c) => c.command === "refresh_report")
      .map((c) => (c.args?.request as Record<string, unknown>).reportId);
    expect(refreshed).toEqual(["r-1"]);
  });

  it("marks control-driven refreshes as auto", async () => {
    await refreshControlBoundReports(["Region"]);
    const call = invokeLog.find((c) => c.command === "refresh_report");
    expect((call?.args?.request as Record<string, unknown>).auto).toBe(true);
  });

  it("one failing report does not block the others; grid still refreshes", async () => {
    backend.list_reports = () => [
      makeReport({ id: "r-1", dslText: "FILTERS: x = @Region\nVALUES: [M]" }),
      makeReport({ id: "r-2", dslText: "FILTERS: y = @Region\nVALUES: [M]" }),
    ];
    let first = true;
    backend.refresh_report = () => {
      if (first) {
        first = false;
        throw new Error("boom");
      }
      return { reportId: "r-2", rowCount: 1, colCount: 1, overwrittenCellCount: 0 };
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    await refreshControlBoundReports(["Region"]);
    expect(invokeLog.filter((c) => c.command === "refresh_report")).toHaveLength(2);
    expect(gridRefreshCount(dispatchSpy)).toBe(1);
    expect(warn).toHaveBeenCalled();
    dispatchSpy.mockRestore();
    warn.mockRestore();
  });

  it("does not dispatch grid:refresh when nothing ran", async () => {
    backend.list_reports = () => [makeReport({ id: "r-1", dslText: "ROWS: a\nVALUES: [M]" })];
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    await refreshControlBoundReports(["Region"]);
    expect(gridRefreshCount(dispatchSpy)).toBe(0);
    dispatchSpy.mockRestore();
  });

  it("coalesces calls arriving while a pass is in flight", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let listCalls = 0;
    backend.list_reports = async () => {
      listCalls++;
      if (listCalls === 1) await gate;
      return [makeReport({ id: "r-1", dslText: "FILTERS: x = @Region\nVALUES: [M]" })];
    };

    const firstPass = refreshControlBoundReports(["Region"]);
    // Two more changes arrive mid-pass — they must merge into ONE follow-up.
    void refreshControlBoundReports(["Region"]);
    void refreshControlBoundReports(["Region"]);
    release!();
    await firstPass;

    expect(listCalls).toBe(2); // initial pass + one coalesced follow-up
    expect(invokeLog.filter((c) => c.command === "refresh_report")).toHaveLength(2);
  });
});
