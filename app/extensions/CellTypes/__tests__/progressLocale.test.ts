//! FILENAME: app/extensions/CellTypes/__tests__/progressLocale.test.ts
// PURPOSE: P2 S10 -- the progress cell type reads the cell's display text
//          STRICTLY in the app locale (`parseNumber`). Its old local
//          `parseDisplayNumber` stripped every space and turned the FIRST ","
//          into ".", so de-DE "1.234,5" read NaN and en-US "1,234.5" read 1.234.

import { describe, it, expect, afterEach } from "vitest";
import { progressValueOf } from "../types/progress";
import { useAppLocale, useInvariantLocale } from "../../Charts/lib/__tests__/appLocaleTestKit";

afterEach(async () => {
  await useInvariantLocale();
});

describe("progressValueOf", () => {
  it("de-DE reads its grouping and decimal comma, refuses the foreign spelling", async () => {
    await useAppLocale("de-DE");
    expect(progressValueOf("0,42")).toBe(0.42);
    expect(progressValueOf("1.234,5")).toBe(1234.5);
    expect(progressValueOf("42%")).toBeCloseTo(0.42, 12);
    expect(progressValueOf("1,234.5")).toBeNull();
  });

  it("sv-SE reads the no-break-space grouping and a spaced percent", async () => {
    await useAppLocale("sv-SE");
    expect(progressValueOf("1 234,5")).toBe(1234.5);
    expect(progressValueOf("42 %")).toBeCloseTo(0.42, 12);
  });

  it("en-US reads 1,234.5 as 1234.5 (the old reader gave 1.234)", async () => {
    await useAppLocale("en-US");
    expect(progressValueOf("1,234.5")).toBe(1234.5);
  });

  it("an empty cell is 0, text is not a number", async () => {
    await useAppLocale("de-DE");
    expect(progressValueOf("")).toBe(0);
    expect(progressValueOf("n/a")).toBeNull();
  });
});
