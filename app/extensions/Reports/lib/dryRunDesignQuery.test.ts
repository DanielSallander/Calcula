//! FILENAME: app/extensions/Reports/lib/dryRunDesignQuery.test.ts
// PURPOSE: BUG-0450 -- the report editors' dry run asks the backend to answer
//          as the REPORT will (`forReport: true`: FILTERS kept as the filter
//          area, rowCount = the rows Create Report writes), never the chart
//          route. The Rust half -- that the report route counts the
//          filter-area rows -- is pinned by
//          `the_report_dry_run_counts_the_rows_create_report_writes`
//          (app/src-tauri/src/pivot/design_query_measure_only_tests.rs).
//
// SABOTAGE: drop `forReport: true` from the invoke -- the args assertion fails.

import { describe, it, expect, beforeEach } from "vitest";
import { reportsBackend } from "./reportsBackend";
import { dryRunDesignQuery } from "./dryRunDesignQuery";
import type { DesignQueryRequest } from "../../_shared/dsl/pivotLayout/designQuery";

const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];

beforeEach(() => {
  calls.length = 0;
  reportsBackend.set(async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args });
    return { rowCount: 5, colCount: 2 } as T;
  });
});

describe("dryRunDesignQuery", () => {
  it("asks run_design_query for the REPORT's shape and returns its size", async () => {
    const request = { connectionId: "conn-1" } as unknown as DesignQueryRequest;
    const summary = await dryRunDesignQuery(request);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("run_design_query");
    expect(calls[0].args).toEqual({ request, forReport: true });
    expect(summary).toEqual({ rowCount: 5, colCount: 2 });
  });
});
