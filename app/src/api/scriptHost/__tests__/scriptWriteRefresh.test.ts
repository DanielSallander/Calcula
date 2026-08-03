//! FILENAME: app/src/api/scriptHost/__tests__/scriptWriteRefresh.test.ts
// PURPOSE: Every broker method that writes CELL VALUES must end in a grid
//          refresh. A script write that the canvas never re-fetches is a write
//          the user cannot see.
// CONTEXT: This is the guard for the bug that produced "I click the button I
//          made and nothing happens", twice.
//
//          The backend was fine. `update_cell` recalculated, `update_cells_batch`
//          returned the changed cells, the .cala was dirtied. What never
//          happened was `grid:refresh` — the ONLY window event that makes
//          GridCanvas re-read cell data (`app:grid-refresh` merely repaints what
//          it already cached). `api.setCellValue` and `api.updateCellsBatch`
//          were the two cell-writing handlers in the whole broker that returned
//          without calling it, and those two are precisely what a recorded macro
//          emits. The document changed; the screen did not; the feature looked
//          dead.
//
//          The e2e test that was supposed to cover this asserted the result with
//          `invoke("get_cell")` — evidence about the BACKEND, which was never
//          the broken part. So the guard is written against the source: it reads
//          host.ts, isolates each cell-writing case body, and requires a refresh
//          to be reachable from it. Adding a new cell-writing method without one
//          fails here rather than in a bug report.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { ALLOWLIST } from "../allowlist";

const hostSrc = fs.readFileSync(path.resolve(__dirname, "../host.ts"), "utf8");

/**
 * Broker methods that write cell VALUES.
 *
 * Listed explicitly rather than pattern-matched on the allowlist, because
 * "mutate" also covers formatting, structure and sheet CRUD — each of which has
 * its own, different refresh obligation (dimensions, sheet list, styles). This
 * file is about the one class that was broken.
 */
const CELL_WRITING_METHODS = [
  "api.setCellValue",
  "api.updateCellsBatch",
  "api.setCellFormula",
  "sheet.setCellValue",
  "sheet.setRangeValues",
  "sheet.setCellFormula",
  "table.setCellValue",
  "table.setRangeValues",
  "namedRange.setValues",
  "range.setValues",
] as const;

/**
 * Host helpers that are known to end in a canvas re-fetch.
 *
 * Each one is verified below, so a case body may satisfy the rule by calling
 * any of them rather than by inlining the refresh.
 */
const REFRESHING_HELPERS = [
  "afterCellDataChange",
  "scheduleGridDataRefresh",
  "writeCellsOnSheet",
  "writeCellOnSheet",
  "writeCellFormula",
  "refreshGridData",
] as const;

/** The body of `case "<method>":` up to the next `case "` label. */
function caseBody(method: string): string {
  const start = hostSrc.indexOf(`case "${method}":`);
  expect(start, `no host executor for ${method}`).toBeGreaterThan(-1);
  const rest = hostSrc.slice(start + method.length + 8);
  const next = rest.search(/\n\s{4}case "/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** The body of a top-level `function` / `async function <name>(` declaration. */
function functionBody(name: string): string {
  let start = hostSrc.indexOf(`async function ${name}(`);
  if (start === -1) start = hostSrc.indexOf(`function ${name}(`);
  expect(start, `no host helper named ${name}`).toBeGreaterThan(-1);
  const rest = hostSrc.slice(start);
  const next = rest.slice(1).search(/\n(?:async )?function /);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("script cell writes reach the canvas", () => {
  it.each(CELL_WRITING_METHODS)(
    "%s refreshes the grid after writing",
    (method) => {
      const body = caseBody(method);
      const refreshers = REFRESHING_HELPERS.filter((h) => body.includes(`${h}(`));
      expect(
        refreshers,
        `${method} writes cells but never reaches a grid refresh — the write ` +
          `will land in the document and stay invisible on screen. Call ` +
          `afterCellDataChange(cells) with what the write returned.`,
      ).not.toHaveLength(0);
    },
  );

  it.each(["afterCellDataChange", "writeCellsOnSheet", "writeCellOnSheet"])(
    "%s really does dispatch a canvas re-fetch on every path",
    (helper) => {
      const body = functionBody(helper);
      // `refreshGridData()` is what dispatches the window `grid:refresh` event
      // GridCanvas listens to; the coalescer calls it, and the writers either
      // delegate to afterCellDataChange or schedule it directly.
      const reaches =
        body.includes("scheduleGridDataRefresh()") ||
        body.includes("afterCellDataChange(");
      expect(reaches, `${helper} does not reach a grid data refresh`).toBe(true);
    },
  );

  it("afterCellDataChange announces the per-cell changes AND schedules a refetch", () => {
    const body = functionBody("afterCellDataChange");
    // CELL_VALUES_CHANGED is what Charts / Conditional Formatting / formula-
    // driven control properties react to. Dropping it makes script writes
    // invisible to every downstream feature, not just to the canvas.
    expect(body).toContain("cellEvents.emitBatch");
    expect(body).toContain("scheduleGridDataRefresh()");
  });

  it("the refresh is COALESCED, so a write loop cannot flood the canvas", () => {
    const body = functionBody("scheduleGridDataRefresh");
    // A per-write refetch would turn "make the write visible" into "make the
    // script unusable": 10k awaited setCellValue calls = 10k viewport fetches.
    expect(body).toContain("gridRefreshScheduled");
    expect(body).toContain("MUTATION_REFRESH");
    expect(body).toContain("refreshGridData()");
    // Trailing, so the LAST state is always the one drawn.
    expect(body).toMatch(/requestAnimationFrame|setTimeout/);
  });

  it("the broker-addressed writers here are real, mutate-classed allowlist rows", () => {
    // Keeps the list honest: a renamed or removed method must be noticed here
    // rather than silently dropping out of the guard's coverage. The
    // own-object writers (table.*, namedRange.*, range.*) are NOT allowlist
    // rows — the worker reaches them through the single `object.setState`
    // aspect — so they are pinned by their host case labels above instead.
    const brokerAddressed = CELL_WRITING_METHODS.filter(
      (m) => m.startsWith("api.") || m.startsWith("sheet."),
    );
    expect(brokerAddressed.length).toBeGreaterThan(0);
    for (const method of brokerAddressed) {
      const row = ALLOWLIST[method as keyof typeof ALLOWLIST];
      expect(row, `${method} is not in the ALLOWLIST`).toBeDefined();
      expect(row.class, `${method} should be class "mutate"`).toBe("mutate");
    }
    expect(ALLOWLIST["object.setState"].class).toBe("mutate");
  });

  it("api.setActiveSheet announces the switch instead of moving only the backend", () => {
    // The first statement a recorded macro emits. When the backend's active
    // sheet moved and Core's did not, every following write went to a sheet the
    // user was not looking at.
    expect(caseBody("api.setActiveSheet")).toContain("announceSheetsChanged(");
  });
});
