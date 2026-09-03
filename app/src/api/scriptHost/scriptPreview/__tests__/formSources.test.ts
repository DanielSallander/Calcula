//! FILENAME: app/src/api/scriptHost/scriptPreview/__tests__/formSources.test.ts
// PURPOSE: Prove a preview fills a form's RANGE-FED content from the copy the
//          run used — and refuses, out loud, everything it cannot reach.
// CONTEXT: 2026-09-03 (TypeScript Forms follow-up). Before this, a dropdown fed
//          from `options: { range: "A2:A4" }` and a table fed from a range
//          painted EMPTY in the editor's form preview, which reads to the
//          author as "my range is wrong" rather than "a preview did not look".
//
//          The realm half of this rung cannot be exercised under jsdom at all
//          (there is no `Worker`), so the resolution is a pure function over a
//          `PreviewGrid` and is proved here, at the tier that can see it.

import { describe, expect, it } from "vitest";

import {
  PREVIEW_IMAGE_REASON,
  offSheetSourceReason,
  resolveFormSourcesFromPreviewGrid,
} from "../formSources";
import { PreviewGrid } from "../grid";
import { buildReport } from "../report";
import { MAX_FORM_OPTIONS, MAX_FORM_TABLE_CELLS, type FormSpec } from "../../scriptFormSpec";
import { MAX_RANGE_CELLS } from "../../validators";

/** A grid seeded row-major from A1. */
function gridOf(rows: string[][]): PreviewGrid {
  const grid = new PreviewGrid();
  rows.forEach((row, r) => row.forEach((value, c) => grid.setInput(r, c, value)));
  return grid;
}

function resolve(spec: FormSpec, grid: PreviewGrid, sheetNames = ["Sheet1"]): ReturnType<typeof resolveFormSourcesFromPreviewGrid> {
  return resolveFormSourcesFromPreviewGrid({ spec, grid, sheetNames, activeSheet: 0 });
}

describe("resolveFormSourcesFromPreviewGrid — choice lists and table rows", () => {
  it("builds a dropdown's options from the copied cells, deduplicated and in reading order", () => {
    const grid = gridOf([["Region"], ["EMEA"], ["APAC"], ["EMEA"], [""], ["AMER"]]);
    const seeds = resolve(
      { children: [{ type: "dropdown", name: "region", options: { range: "A2:A6" } }] } as unknown as FormSpec,
      grid,
    );
    expect(seeds).toEqual([
      {
        name: "region",
        kind: "options",
        options: [
          { value: "EMEA", label: "EMEA" },
          { value: "APAC", label: "APAC" },
          { value: "AMER", label: "AMER" },
        ],
      },
    ]);
  });

  it("builds a table's rows from the copied rectangle, typed as the cells are", () => {
    const grid = gridOf([
      ["Item", "Qty"],
      ["Bolt", "12"],
      ["Nut", "7"],
    ]);
    const seeds = resolve(
      { children: [{ type: "table", name: "lines", rows: { range: "A2:B3" } }] } as unknown as FormSpec,
      grid,
    );
    // NUMBERS stay numbers: the same `rowsFromCells` the production host uses.
    expect(seeds).toEqual([
      { name: "lines", kind: "rows", rows: [["Bolt", 12], ["Nut", 7]] },
    ]);
  });

  it("keeps the SAME caps a real form.show applies", () => {
    // A range read is bounded at 100,000 cells, but a choice list is bounded at
    // 500 and a table at 5,000. Without the shared helpers a preview would
    // paint a dropdown with thousands of entries the product would never show.
    const wide = new PreviewGrid();
    for (let r = 0; r < MAX_FORM_OPTIONS + 50; r++) wide.setInput(r, 0, `v${r}`);
    const options = resolve(
      { children: [{ type: "listbox", name: "many", options: { range: `A1:A${MAX_FORM_OPTIONS + 50}` } }] } as unknown as FormSpec,
      wide,
    );
    expect(options[0].options).toHaveLength(MAX_FORM_OPTIONS);

    const tall = new PreviewGrid();
    for (let r = 0; r < 3000; r++) {
      tall.setInput(r, 0, `a${r}`);
      tall.setInput(r, 1, `b${r}`);
    }
    const rows = resolve(
      { children: [{ type: "table", name: "big", rows: { range: "A1:B3000" } }] } as unknown as FormSpec,
      tall,
    );
    expect(rows[0].rows).toHaveLength(MAX_FORM_TABLE_CELLS / 2);
  });

  it("refuses a rectangle bigger than a real range read, rather than materializing it", () => {
    const seeds = resolve(
      { children: [{ type: "dropdown", name: "huge", options: { range: "A1:Z1000000" } }] } as unknown as FormSpec,
      new PreviewGrid(),
    );
    expect(seeds[0].options).toBeUndefined();
    expect(seeds[0].reason).toContain(String(MAX_RANGE_CELLS));
  });
});

describe("resolveFormSourcesFromPreviewGrid — what a preview cannot reach", () => {
  it("declares an off-sheet range unresolved instead of answering from the copied sheet", () => {
    // The copy holds ONE sheet. Reading "Lists!A2:A4" out of Sheet1's cells at
    // the same coordinates would be a DIFFERENT range's data under the right
    // widget's label — the worst kind of wrong, because it looks right.
    const grid = gridOf([["x"], ["y"], ["z"], ["w"]]);
    const seeds = resolve(
      { children: [{ type: "dropdown", name: "region", options: { range: "Lists!A2:A4" } }] } as unknown as FormSpec,
      grid,
    );
    expect(seeds[0].options).toBeUndefined();
    expect(seeds[0].reason).toBe(offSheetSourceReason("Lists"));
  });

  it("accepts the active sheet named explicitly, ignoring case", () => {
    const grid = gridOf([["EMEA"], ["APAC"]]);
    const seeds = resolve(
      { children: [{ type: "dropdown", name: "r", options: { range: "sheet1!A1:A2" } }] } as unknown as FormSpec,
      grid,
      ["Sheet1"],
    );
    expect(seeds[0].options).toEqual([
      { value: "EMEA", label: "EMEA" },
      { value: "APAC", label: "APAC" },
    ]);
  });

  it("seeds an image with a reason and NEVER a fabricated url", () => {
    const seeds = resolve(
      { children: [{ type: "image", name: "logo", src: "media:abc123" }] } as unknown as FormSpec,
      new PreviewGrid(),
    );
    expect(seeds).toEqual([{ name: "logo", kind: "image", reason: PREVIEW_IMAGE_REASON }]);
    expect(JSON.stringify(seeds)).not.toContain("data:");
  });

  it("carries the parse error for a range that is not one", () => {
    const seeds = resolve(
      { children: [{ type: "dropdown", name: "bad", options: { range: "not a range" } }] } as unknown as FormSpec,
      new PreviewGrid(),
    );
    expect(seeds[0].options).toBeUndefined();
    expect(seeds[0].reason).toBeTruthy();
  });

  it("rides out on the report, because the grid copy never leaves the rung", () => {
    // The caller cannot resolve these for itself: the copy is the run's, and a
    // second read of the LIVE workbook would seed the widget with data the
    // script never saw. So the resolved content travels on the report.
    const base = {
      ok: true,
      durationMs: 1,
      changes: [],
      output: [],
      readBack: [],
      unexercisedHooks: [],
    };
    const withSources = buildReport({
      ...base,
      formSources: [{ name: "region", kind: "options", options: [{ value: "EMEA", label: "EMEA" }] }],
    });
    expect(withSources.formSources).toEqual([
      { name: "region", kind: "options", options: [{ value: "EMEA", label: "EMEA" }] },
    ]);
    // Omitted entirely when the layout declared none, so "there were none" and
    // "this run did not look" stay distinguishable.
    expect(buildReport({ ...base, formSources: [] })).not.toHaveProperty("formSources");
    expect(buildReport(base)).not.toHaveProperty("formSources");
  });

  it("reports nothing for a layout with no range-fed source at all", () => {
    expect(
      resolve(
        {
          children: [
            { type: "textbox", name: "a", bind: "B2" },
            { type: "dropdown", name: "inline", options: ["x", "y"] },
          ],
        } as unknown as FormSpec,
        new PreviewGrid(),
      ),
    ).toEqual([]);
  });
});
