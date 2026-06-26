//! FILENAME: app/extensions/Charts/lib/__tests__/seriesIndexResolve.test.ts
// PURPOSE: seriesPaletteIndex (palette-shift bug fix) — DATA-driven stable palette
//          slot: a painted series keeps its PRE-FILTER position's color via
//          data.keptSeriesIndices, so hiding a lower-index series doesn't recolor
//          survivors. Positional (not name-based), so duplicate series names stay
//          distinctly colored and a single-series small-multiple panel -> palette[0].

import { describe, it, expect } from "vitest";
import { seriesPaletteIndex } from "../encodingResolver";
import type { ParsedChartData } from "../../types";

describe("seriesPaletteIndex", () => {
  it("is identity when no filter ran (no keptSeriesIndices)", () => {
    const data = { keptSeriesIndices: undefined } as Pick<ParsedChartData, "keptSeriesIndices">;
    expect(seriesPaletteIndex(data, 0)).toBe(0);
    expect(seriesPaletteIndex(data, 1)).toBe(1);
    expect(seriesPaletteIndex(data, 2)).toBe(2);
  });

  it("returns the PRE-FILTER slot when a lower-index series is hidden (stable colors)", () => {
    // Original [A,B,C] palette 0,1,2; hide A -> painted [B,C], map = [1,2].
    const data = { keptSeriesIndices: [1, 2] } as Pick<ParsedChartData, "keptSeriesIndices">;
    expect(seriesPaletteIndex(data, 0)).toBe(1); // B keeps palette[1]
    expect(seriesPaletteIndex(data, 1)).toBe(2); // C keeps palette[2]
  });

  it("keeps duplicate-named series distinctly colored (positional, not name-based)", () => {
    // Two series share a header name but occupy distinct data positions; with no
    // filter the identity fallback gives each its own palette slot.
    const data = { keptSeriesIndices: undefined } as Pick<ParsedChartData, "keptSeriesIndices">;
    expect(seriesPaletteIndex(data, 3)).toBe(3);
    expect(seriesPaletteIndex(data, 4)).toBe(4); // NOT collapsed onto 3
  });

  it("gives a single-series panel palette[0] (uniform small-multiples color)", () => {
    // A repeat panel's subData has one series and no kept map -> painter index 0.
    const panel = { keptSeriesIndices: undefined } as Pick<ParsedChartData, "keptSeriesIndices">;
    expect(seriesPaletteIndex(panel, 0)).toBe(0);
  });

  it("falls back to the painter index for an out-of-range map entry", () => {
    const data = { keptSeriesIndices: [1] } as Pick<ParsedChartData, "keptSeriesIndices">;
    expect(seriesPaletteIndex(data, 5)).toBe(5);
  });
});
