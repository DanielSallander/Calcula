//! FILENAME: app/src/core/lib/__tests__/shownCellText.test.ts
// PURPOSE: BUG-0355 -- the text a General number SHOWS at its column's width,
//          which Increase / Decrease Decimal counts its decimals from. Excel 16
//          [LIVE, 2026-11-04, lane multiarea probe3]: 1234.5678 in a default
//          column shows `1234,568` (Increase -> 0.0000, Decrease -> 0.00).
//          The ladder is the grid's own (rendering/overflowMarker.ts); a
//          measuring double makes the widths exact: 7px per character.

import { describe, it, expect } from "vitest";
import { shownGeneralText } from "../shownCellText";
import type { StyleData } from "../../types";

function ctx(): CanvasRenderingContext2D {
  return { font: "", measureText: (t: string) => ({ width: t.length * 7 }) } as unknown as CanvasRenderingContext2D;
}

const THEME = { cellFontFamily: "Calibri", cellFontSize: 11 };
const GENERAL = { numberFormat: "General", textAlign: "general" } as unknown as StyleData;

describe("shownGeneralText", () => {
  it("BUG-0355 a General number too wide for its column shows fewer decimals", () => {
    // 64px column, 3px inset each side: 58px for 1234.5678 (63px) -> 1234.568 (56px).
    expect(shownGeneralText("1234.5678", GENERAL, 64, THEME, ctx())).toBe("1234.568");
    // The locale's decimal comma is kept.
    expect(shownGeneralText("1234,5678", GENERAL, 64, THEME, ctx())).toBe("1234,568");
  });

  it("a column wide enough shows the full rendering; a narrow one a whole number", () => {
    expect(shownGeneralText("1234.5678", GENERAL, 100, THEME, ctx())).toBe("1234.5678");
    expect(shownGeneralText("1234.5678", GENERAL, 40, THEME, ctx())).toBe("1235");
  });

  it("an indent narrows the room the number has", () => {
    const indented = { ...GENERAL, textAlign: "left", indent: 1 } as unknown as StyleData;
    // The indent takes room from the 70px column: 1234.5678 (63px) no longer fits in 64 - indent.
    expect(shownGeneralText("1234.5678", GENERAL, 70, THEME, ctx())).toBe("1234.5678");
    expect(shownGeneralText("1234.5678", indented, 70, THEME, ctx())).not.toBe("1234.5678");
  });

  it("not a General number: no answer", () => {
    expect(shownGeneralText("1234.57", { ...GENERAL, numberFormat: "Number (2 decimals)" } as StyleData, 40, THEME, ctx())).toBeNull();
    expect(shownGeneralText("Total", GENERAL, 40, THEME, ctx())).toBeNull();
  });
});
