//! FILENAME: app/extensions/Charts/lib/__tests__/chartRangeBinding.test.ts
// PURPOSE: M4 (canvas sheets) -- the Insert/Edit Chart dialog's range text binds
//          to the sheet it NAMES. The dialog used to throw the "Sheet!" prefix
//          away and store the active sheet's index, which on a canvas is a sheet
//          with no cells. Pinned:
//            - "Sheet2!A1:B5" binds to Sheet2's index AND id, from any sheet;
//            - no prefix on a worksheet: the current sheet, as before;
//            - no prefix on a canvas: refused, telling the user to include the
//              sheet; a prefix naming a canvas: refused likewise; an unknown
//              sheet: refused by name;
//            - before the sheet list arrives, only the active sheet's own name
//              binds (the auto-detected range), anything else waits silently;
//            - edit mode shows the stored ref qualified by ITS sheet, found by id.

import { describe, it, expect } from "vitest";
import {
  bindRangeText,
  rangeRefDisplayText,
  splitSheetQualifiedRange,
  formatSheetQualifiedRange,
  CANVAS_NEEDS_SHEET_MESSAGE,
  RANGE_FORMAT_MESSAGE,
  canvasSourceMessage,
  unknownSheetMessage,
  type RangeBindingContext,
} from "../chartRangeBinding";
import type { SheetInfo } from "@api/lib";

const SHEETS: SheetInfo[] = [
  { index: 0, name: "Sheet1", sheetId: "id-0", visibility: "visible", kind: "worksheet" },
  { index: 1, name: "Sales Data", sheetId: "id-1", visibility: "visible" },
  { index: 2, name: "Page 1", sheetId: "id-2", visibility: "visible", kind: "canvas" },
  { index: 3, name: "Bob's", sheetId: "id-3", visibility: "visible" },
];

const onWorksheet: RangeBindingContext = { sheets: SHEETS, currentSheetIndex: 0, currentSheetName: "Sheet1", currentIsCanvas: false };
const onCanvas: RangeBindingContext = { sheets: SHEETS, currentSheetIndex: 2, currentSheetName: "Page 1", currentIsCanvas: true };

describe("a sheet prefix binds the data to THAT sheet", () => {
  it("stores the named sheet's index and id, even from another sheet", () => {
    const b = bindRangeText("'Sales Data'!B2:C9", onWorksheet);
    expect(b).toEqual({
      ok: true,
      ref: { sheetIndex: 1, sheetId: "id-1", startRow: 1, startCol: 1, endRow: 8, endCol: 2 },
      sheet: SHEETS[1],
    });
  });

  it("is how a canvas chart names its data sheet", () => {
    const b = bindRangeText("Sheet1!$A$1:$B$5", onCanvas);
    expect(b.ok && b.ref).toEqual({ sheetIndex: 0, sheetId: "id-0", startRow: 0, startCol: 0, endRow: 4, endCol: 1 });
  });

  it("matches the name case-insensitively and understands '' escapes", () => {
    expect(bindRangeText("sheet1!A1:B2", onWorksheet).ok).toBe(true);
    const b = bindRangeText("'Bob''s'!A1:B2", onWorksheet);
    expect(b.ok && b.ref.sheetIndex).toBe(3);
  });

  it("refuses a name no sheet has, by name", () => {
    expect(bindRangeText("Nope!A1:B2", onWorksheet)).toEqual({ ok: false, message: unknownSheetMessage("Nope") });
  });

  it("refuses a range on a CANVAS sheet (it has no cells)", () => {
    expect(bindRangeText("'Page 1'!A1:B2", onWorksheet)).toEqual({ ok: false, message: canvasSourceMessage("Page 1") });
    expect(bindRangeText("'Page 1'!A1:B2", onCanvas)).toEqual({ ok: false, message: canvasSourceMessage("Page 1") });
  });
});

describe("no sheet prefix", () => {
  it("on a worksheet: the current sheet, exactly as before (with its id)", () => {
    const b = bindRangeText("A1:D10", { ...onWorksheet, currentSheetIndex: 1 });
    expect(b.ok && b.ref).toEqual({ sheetIndex: 1, sheetId: "id-1", startRow: 0, startCol: 0, endRow: 9, endCol: 3 });
  });

  it("on a canvas: refused with a message telling the user to include the sheet", () => {
    const b = bindRangeText("A1:D10", onCanvas);
    expect(b).toEqual({ ok: false, message: CANVAS_NEEDS_SHEET_MESSAGE });
    expect(CANVAS_NEEDS_SHEET_MESSAGE).toMatch(/Include the sheet/);
  });

  it("on a canvas the ACTIVE SURFACE alone refuses it -- before the list arrives, or when the list does not mark the kind", () => {
    const cold: RangeBindingContext = { sheets: [], currentSheetIndex: 2, currentSheetName: "Page 1", currentIsCanvas: true };
    expect(bindRangeText("A1:D10", cold)).toEqual({ ok: false, message: CANVAS_NEEDS_SHEET_MESSAGE });
    const unmarked = SHEETS.map((s) => ({ ...s, kind: undefined }));
    expect(bindRangeText("A1:D10", { ...onCanvas, sheets: unmarked })).toEqual({
      ok: false,
      message: CANVAS_NEEDS_SHEET_MESSAGE,
    });
  });

  it("and the current sheet's KIND refuses it even if the surface flag lags", () => {
    expect(bindRangeText("A1:D10", { ...onCanvas, currentIsCanvas: false })).toEqual({
      ok: false,
      message: CANVAS_NEEDS_SHEET_MESSAGE,
    });
  });
});

describe("format and emptiness", () => {
  it("an empty field says nothing", () => {
    expect(bindRangeText("   ", onCanvas)).toEqual({ ok: false, message: null });
  });

  it("a malformed range says how to write one", () => {
    expect(bindRangeText("Sheet1!A1", onWorksheet)).toEqual({ ok: false, message: RANGE_FORMAT_MESSAGE });
    expect(bindRangeText("banana", onWorksheet)).toEqual({ ok: false, message: RANGE_FORMAT_MESSAGE });
  });
});

describe("before the sheet list has arrived", () => {
  const cold: RangeBindingContext = { sheets: [], currentSheetIndex: 4, currentSheetName: "Sheet5", currentIsCanvas: false };

  it("the ACTIVE sheet's own name binds (to its index, id to follow)", () => {
    const b = bindRangeText("Sheet5!A1:B2", cold);
    expect(b.ok && b.ref).toEqual({ sheetIndex: 4, startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
  });

  it("any other name waits WITHOUT an error (nothing to resolve against yet)", () => {
    expect(bindRangeText("Other!A1:B2", cold)).toEqual({ ok: false, message: null });
  });

  it("and on a canvas even the active name does not bind", () => {
    expect(bindRangeText("Page!A1:B2", { ...cold, currentSheetName: "Page", currentIsCanvas: true })).toEqual({
      ok: false,
      message: null,
    });
  });
});

describe("edit mode shows the reference's OWN sheet", () => {
  it("found by id -- not the sheet the dialog is on, and not a stale index", () => {
    // The stored index (0) is stale: the ref's sheet is "Sales Data" by id.
    const text = rangeRefDisplayText(
      { sheetIndex: 0, sheetId: "id-1", startRow: 0, startCol: 0, endRow: 4, endCol: 1 },
      SHEETS,
      "Page 1",
    );
    expect(text).toBe("'Sales Data'!A1:B5");
  });

  it("by index when the ref has no id", () => {
    expect(rangeRefDisplayText({ sheetIndex: 0, startRow: 0, startCol: 0, endRow: 1, endCol: 1 }, SHEETS, null)).toBe(
      "Sheet1!A1:B2",
    );
  });

  it("a bare range when the ref's sheet was deleted (never a wrong sheet name)", () => {
    expect(
      rangeRefDisplayText({ sheetIndex: 0, sheetId: "gone", startRow: 0, startCol: 0, endRow: 1, endCol: 1 }, SHEETS, "Sheet1"),
    ).toBe("A1:B2");
  });

  it("round-trips through the binder", () => {
    const ref = { sheetIndex: 3, sheetId: "id-3", startRow: 2, startCol: 27, endRow: 10, endCol: 28 };
    const text = rangeRefDisplayText(ref, SHEETS, null);
    const b = bindRangeText(text, onCanvas);
    expect(b.ok && b.ref).toEqual(ref);
  });
});

describe("splitting and quoting", () => {
  it("splits on the LAST '!' and unquotes", () => {
    expect(splitSheetQualifiedRange("'A!B'!C1:D2")).toEqual({ sheetName: "A!B", range: "C1:D2" });
    expect(splitSheetQualifiedRange("C1:D2")).toEqual({ sheetName: null, range: "C1:D2" });
  });

  it("quotes a name that needs it and escapes its apostrophes", () => {
    expect(formatSheetQualifiedRange("Sheet1", "A1:B2")).toBe("Sheet1!A1:B2");
    expect(formatSheetQualifiedRange("Bob's data", "A1:B2")).toBe("'Bob''s data'!A1:B2");
  });
});

// X15 (wave D; wave C core fix-up, suspected): `formatSheetQualifiedRange`
// leaves `2024`, `2024Budget`, `TRUE` and `FALSE` bare, which the FORMULA
// parser would not read as sheet names. Verified NOT to matter: the text is
// the chart dialog's own display, read back only by `bindRangeText` (which
// takes any name before the LAST "!", bare or quoted) and stored as a
// DataRangeRef -- it never reaches the formula parser. Both halves are pinned
// here, so a caller that starts handing the text anywhere else is caught and
// has to use the parser's rule (`quoteSheetNameForFormula`, @api/externalEdit).
describe("X15: the display text round-trips through the dialog's own reader", () => {
  const PARSER_HOSTILE: SheetInfo[] = ["2024", "2024Budget", "TRUE", "false", "Q1.", "Q1-2026", "A1"].map(
    (name, index) => ({ index, name, sheetId: `id-${name}`, visibility: "visible" as const }),
  );
  const ctx: RangeBindingContext = {
    sheets: PARSER_HOSTILE,
    currentSheetIndex: 0,
    currentSheetName: "2024",
    currentIsCanvas: false,
  };

  for (const sheet of PARSER_HOSTILE) {
    it(`"${sheet.name}" binds back to its own sheet`, () => {
      const ref = { sheetIndex: sheet.index, sheetId: sheet.sheetId, startRow: 1, startCol: 2, endRow: 5, endCol: 3 };
      const text = rangeRefDisplayText(ref, PARSER_HOSTILE, null);
      const b = bindRangeText(text, ctx);
      expect(b.ok, `"${text}" did not bind`).toBe(true);
      expect(b.ok && b.ref).toEqual(ref);
    });
  }

  it("the formatters' only callers are the binding module and the dialog (which puts the text in its field)", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const root = path.resolve(__dirname, "../../../..");
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "__tests__") continue;
          walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const text = fs.readFileSync(full, "utf8");
          if (/\b(formatSheetQualifiedRange|rangeRefDisplayText)\b/.test(text)) {
            callers.push(path.relative(root, full).split(path.sep).join("/"));
          }
        }
      }
    };
    walk(path.join(root, "src"));
    walk(path.join(root, "extensions"));
    expect(
      callers.sort(),
      "a new caller of the chart dialog's range formatter: if its text can reach the formula parser, " +
        "quote with quoteSheetNameForFormula (@api/externalEdit) instead",
    ).toEqual(["extensions/Charts/components/CreateChartDialog.tsx", "extensions/Charts/lib/chartRangeBinding.ts"]);
  });
});
