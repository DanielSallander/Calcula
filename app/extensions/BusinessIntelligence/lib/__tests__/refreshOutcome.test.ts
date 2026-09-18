/**
 * FILENAME: app/extensions/BusinessIntelligence/lib/__tests__/refreshOutcome.test.ts
 * PURPOSE: The honesty of the Refresh status line, pinned.
 *
 * CONTEXT: The Connections pane used to catch and ignore every failure from
 *          `refreshConnection` (it had to: the backend returned an ERROR for
 *          the benign "this connection has no grid queries" case) and every
 *          failure from each `pivot.refreshCache`. A run in which the active
 *          "view as" role denied every single object therefore rendered as a
 *          calm blue "No queries or pivot tables to refresh." — the exact
 *          shape of silent failure this guard exists to prevent.
 */

import { describe, it, expect } from "vitest";
import { summarizeRefresh } from "../refreshOutcome";

const OLS = 'Query failed: object-level security: the active role denies access to Sales[amount]';

describe("summarizeRefresh", () => {
  it("reports a refused grid query as an ERROR naming the refusal", () => {
    const s = summarizeRefresh({
      queryCount: 0,
      totalRows: 0,
      pivotCount: 0,
      errors: [OLS],
    });
    expect(s.type).toBe("error");
    expect(s.message).toContain("object-level security");
  });

  it("reports a refused PIVOT as an error even when the grid queries succeeded", () => {
    const s = summarizeRefresh({
      queryCount: 2,
      totalRows: 40,
      pivotCount: 0,
      errors: [`Sales by region: ${OLS}`],
    });
    expect(s.type).toBe("error");
    expect(s.message).toContain("object-level security");
    // ...and still says what DID refresh: the user is looking at a partly
    // refreshed workbook and needs to know that.
    expect(s.message).toContain("2 queries (40 rows)");
  });

  it("never reports a failure as success, however many other things worked", () => {
    const s = summarizeRefresh({
      queryCount: 5,
      totalRows: 500,
      pivotCount: 9,
      errors: ["one pivot refused"],
    });
    expect(s.type).not.toBe("success");
    expect(s.type).not.toBe("info");
  });

  it("counts the failures it could not all name", () => {
    const s = summarizeRefresh({
      queryCount: 0,
      totalRows: 0,
      pivotCount: 0,
      errors: ["first", "second", "third"],
    });
    expect(s.message).toContain("first");
    expect(s.message).toContain("+2 more");
  });

  it("the quiet 'nothing to refresh' is reachable ONLY with no errors at all", () => {
    const quiet = summarizeRefresh({ queryCount: 0, totalRows: 0, pivotCount: 0, errors: [] });
    expect(quiet.type).toBe("info");
    expect(quiet.message).toBe("No queries or pivot tables to refresh.");

    // The same zero counts, but something went wrong: NOT the quiet line.
    const loud = summarizeRefresh({
      queryCount: 0,
      totalRows: 0,
      pivotCount: 0,
      errors: ["could not list pivot tables: backend unavailable"],
    });
    expect(loud.type).toBe("error");
    expect(loud.message).not.toContain("No queries or pivot tables to refresh.");
  });

  it("a clean run still reads as a success", () => {
    const s = summarizeRefresh({ queryCount: 1, totalRows: 12, pivotCount: 2, errors: [] });
    expect(s.type).toBe("success");
    expect(s.message).toBe("Refreshed 1 queries (12 rows) + 2 pivot table(s)");
  });
});
