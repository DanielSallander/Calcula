//! FILENAME: app/extensions/Charts/lib/__tests__/chartSheetIdStampParity.test.ts
// PURPOSE: BUG-0204. The load-time sheet-id stamp moved into the BACKEND
//          (`open_file` -> persistence.rs `restore_charts` ->
//          chart_commands.rs `stamp_chart_record_sheet_ids`), where the sheet
//          list is still the FILE's own; the chart store's stamp ran ~300 ms
//          later against whatever the list had become. That is a SECOND copy of
//          the walk in chartSheetRefs.ts, and a copied walk drifts -- so both
//          are pinned to ONE fixture. This file is the TypeScript half; the Rust
//          half is `the_backend_stamp_walk_matches_the_shared_fixture`.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { stampStoredChartJson } from "../chartSheetRefs";

interface StampCase {
  name: string;
  record: unknown;
  expected: unknown;
}

const fixture = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "fixtures/chartSheetIdStamp.json"), "utf8"),
) as { sheetIds: string[]; cases: StampCase[] };

describe("chartSheetRefs.stampStoredChartJson against the shared stamp fixture", () => {
  it("has every case (the Rust half reads the same file)", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(9);
  });

  for (const c of fixture.cases) {
    it(c.name, () => {
      const out = stampStoredChartJson(JSON.stringify(c.record), (i) => fixture.sheetIds[i]);
      if (c.expected === null) {
        expect(out).toBeNull();
      } else {
        expect(out).not.toBeNull();
        expect(JSON.parse(out as string)).toEqual(c.expected);
      }
    });
  }
});
