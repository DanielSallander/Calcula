//! FILENAME: app/src/core/lib/gridRenderer/rendering/accountingLayout.test.ts
// PURPOSE: Survey defect A -- symbol-AFTER accounting was laid out backwards:
//          the number at the LEFT edge and the symbol at the right edge, so a
//          column of sv-SE amounts did not line up its decimals at all.
// CONTEXT: Excel's accounting code is three runs: [left-edge run][fill]
//          [right-edge run]. Measured live on sv-SE (number.md, 2026-10-04):
//            1234.5 -> "   1 234,50 kr "   (fill first, number against "kr")
//            -42    -> "-         42,00 kr "  (the minus pinned LEFT)
//            0      -> "-" ?? " kr "  (a dash and a digit-wide space per decimal)
//          The backend's `AccountingLayout` carries the runs' TEXT (see its doc
//          in core/types/types.ts); this function decides where each one goes.

import { describe, it, expect } from "vitest";
import { layoutAccountingRuns } from "./accountingLayout";

/** 6px per character. */
const measure = (text: string): number => text.length * 6;
const LEFT = 103;
const RIGHT = 297;
const NBSP = " ";
const FIG = " ";

describe("layoutAccountingRuns: symbol BEFORE (en-US, Comma Style)", () => {
  it("symbol at the left edge, value right-aligned (unchanged behaviour)", () => {
    const { runs, width } = layoutAccountingRuns(
      { symbol: "$", symbolBefore: true, value: "1,234.50 " },
      LEFT,
      RIGHT,
      measure,
    );
    expect(runs).toEqual([
      { text: "$", x: LEFT },
      { text: "1,234.50 ", x: RIGHT - 9 * 6 },
    ]);
    expect(width).toBe(10 * 6);
  });

  it("a minus-style negative carries its minus in the left-edge run", () => {
    const { runs } = layoutAccountingRuns(
      { symbol: "-£", symbolBefore: true, value: "1,234.50 " },
      LEFT,
      RIGHT,
      measure,
    );
    expect(runs[0]).toEqual({ text: "-£", x: LEFT });
  });

  it("Comma Style (no symbol) paints no empty left-edge run", () => {
    const { runs } = layoutAccountingRuns(
      { symbol: "", symbolBefore: true, value: `1${NBSP}234,50 ` },
      LEFT,
      RIGHT,
      measure,
    );
    expect(runs).toEqual([{ text: `1${NBSP}234,50 `, x: RIGHT - 9 * 6 }]);
  });
});

describe("layoutAccountingRuns: symbol AFTER (sv-SE kr, Euro 123 €)", () => {
  it("a positive is ONE right-edge run, the number against the symbol: '1 234,50 kr '", () => {
    const { runs, width } = layoutAccountingRuns(
      { symbol: "kr", symbolBefore: false, value: `1${NBSP}234,50 ` },
      LEFT,
      RIGHT,
      measure,
    );
    const text = `1${NBSP}234,50 kr `;
    expect(runs).toEqual([{ text, x: RIGHT - text.length * 6 }]);
    expect(width).toBe(text.length * 6);
  });

  it("a minus-style negative pins its minus to the LEFT edge: '-' ... '42,00 kr '", () => {
    const { runs } = layoutAccountingRuns(
      { symbol: "kr", symbolBefore: false, value: "-42,00 " },
      LEFT,
      RIGHT,
      measure,
    );
    expect(runs).toEqual([
      { text: "-", x: LEFT },
      { text: "42,00 kr ", x: RIGHT - 9 * 6 },
    ]);
  });

  it("zero keeps its dash in the right-edge run (the dash is not a minus)", () => {
    const value = `-${FIG}${FIG} `;
    const { runs } = layoutAccountingRuns({ symbol: "kr", symbolBefore: false, value }, LEFT, RIGHT, measure);
    const text = `-${FIG}${FIG} kr `;
    expect(runs).toEqual([{ text, x: RIGHT - text.length * 6 }]);
  });

  it("a parenthesised negative keeps its brackets around the number", () => {
    const { runs } = layoutAccountingRuns(
      { symbol: "€", symbolBefore: false, value: "(1,234.50)" },
      LEFT,
      RIGHT,
      measure,
    );
    expect(runs).toEqual([{ text: "(1,234.50) €", x: RIGHT - 12 * 6 }]);
  });

  it("the value is NEVER drawn from the left edge any more (defect A)", () => {
    const { runs } = layoutAccountingRuns(
      { symbol: "kr", symbolBefore: false, value: "5,00 " },
      LEFT,
      RIGHT,
      measure,
    );
    expect(runs.some((r) => r.x === LEFT)).toBe(false);
  });
});
