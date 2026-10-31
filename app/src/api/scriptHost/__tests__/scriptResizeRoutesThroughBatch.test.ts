//! FILENAME: app/src/api/scriptHost/__tests__/scriptResizeRoutesThroughBatch.test.ts
// PURPOSE: api.setRowHeight / api.setColumnWidth reach the backend through the
//          Row Height / Column Width COMMAND (set_row_heights /
//          set_column_widths over one line), never the one-line drag primitive.
// CONTEXT: rev12B (round 13): a recorded macro replayed a batch resize as one
//          api.setRowHeight per row (round 15 replays it as ONE
//          api.setRowHeights over the runs, pinned below), and the one-line primitive
//          (set_row_height) never shows a hidden row -- so a replay left
//          hidden what the recorded gesture had shown. Excel's
//          Rows(n).RowHeight = h shows a hidden row ([LIVE] round 14, also
//          under a filter), which is exactly the batch command over [n, n].
//          The executor needs a mounted worker realm (jsdom cannot spawn one),
//          so the routing is pinned by source scan, as calculationControl.test
//          pins its wiring.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const hostSrc = fs.readFileSync(path.resolve(__dirname, "../host.ts"), "utf8");

function caseBody(label: string): string {
  const start = hostSrc.indexOf(`case "${label}": {`);
  expect(start, `no executor case for ${label}`).toBeGreaterThan(0);
  const rest = hostSrc.slice(start);
  return rest.slice(0, rest.indexOf("\n    case ", 10));
}

describe("the script resize goes through the batch command", () => {
  it("api.setRowHeight sends ONE run through setRowHeights, and re-reads the hidden sets", () => {
    const body = caseBody("api.setRowHeight");
    expect(body).toContain("lib.setRowHeights([[row, row]], height)");
    expect(body).not.toContain("lib.setRowHeight(");
    expect(body).toContain('syncDimensionToGrid("row", row, height, true)');
  });

  it("api.setColumnWidth sends ONE run through setColumnWidths", () => {
    const body = caseBody("api.setColumnWidth");
    expect(body).toContain("lib.setColumnWidths([[col, col]], width)");
    expect(body).not.toContain("lib.setColumnWidth(");
  });
});

// NEW-recorder-select-all (round 15): a recorded batch resize replays as ONE
// api.setRowHeights(runs, h) / api.setColumnWidths(runs, w) -- never one call
// per line (Select All was 1,048,576 api.setRowHeight calls, each giving its
// row its own height instead of setting the sheet's standard).
describe("the run-based script resize", () => {
  it("api.setRowHeights / api.setColumnWidths send the runs whole through the batch command", () => {
    expect(hostSrc).toContain('case "api.setRowHeights":\n    case "api.setColumnWidths": {');
    const body = caseBody("api.setColumnWidths");
    expect(body).toContain("lib.setRowHeights(runs, size)");
    expect(body).toContain("lib.setColumnWidths(runs, size)");
    expect(body).toContain("syncDimensionRunsToGrid(");
    expect(body).not.toMatch(/for \(let (row|col|line|i) =/);
  });
});
