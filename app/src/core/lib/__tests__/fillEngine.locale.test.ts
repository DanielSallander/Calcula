//! FILENAME: app/src/core/lib/__tests__/fillEngine.locale.test.ts
// PURPOSE: The fill handle reads its source numbers and writes the numbers it
//          generates in the APP locale (P2 S11, the locale census sweep).
// CONTEXT: The engine reads each source cell's DISPLAY text. It used
//          `parseFloat`, which knows only the invariant spelling and stops at
//          the first character it does not know: under de-DE the cells 1,5 and
//          2,5 read as 1 and 2 and the drag filled 3, 4, 5 -- a wrong series
//          with nothing on screen to say so. It wrote `String(n)` ("3.5"),
//          which the batch write then parses in the app locale, where "3.5" is
//          a mis-grouped TEXT under de-DE. Both directions now go through the
//          locale (fillNumberOf / fillNumberText). The locales come from THE
//          shared Rust <-> TS corpus, so "de-DE" is what the backend installs.

import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";
import path from "path";

vi.mock("../tauri-api", () => ({
  shiftFormulasBatch: vi.fn(async () => []),
  getMergedRegions: vi.fn(async () => []),
  mergeCells: vi.fn(async () => undefined),
}));

import { detectPattern, generateFillValue, fillNumberOf, fillNumberText, planFillLine } from "../fillEngine";
import { normalizeLocaleSettings, resetActiveLocaleForTests, setActiveLocale, type LocaleSettings } from "../locale";

const CORPUS = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../../../../core/engine/tests/fixtures/locale_text_corpus.json"), "utf8"),
) as { locales: Record<string, LocaleSettings> };

function useLocale(id: string): void {
  setActiveLocale(normalizeLocaleSettings(CORPUS.locales[id]));
}

/** The values a drag of `source` writes into the next `count` cells. */
function dragged(source: string[], count: number): string[] {
  const pattern = detectPattern(source);
  return Array.from({ length: count }, (_, i) => generateFillValue(pattern, source, source.length + i));
}

afterEach(() => resetActiveLocaleForTests());

describe("the fill series in the app locale", () => {
  it("de-DE: 1,5 and 2,5 continue 3,5 / 4,5 (parseFloat read them as 1 and 2)", () => {
    useLocale("de-DE");
    const pattern = detectPattern(["1,5", "2,5"]);
    expect(pattern.type).toBe("series");
    expect(pattern.step).toBeCloseTo(1, 12);
    expect(dragged(["1,5", "2,5"], 2)).toEqual(["3,5", "4,5"]);
  });

  it("de-DE: a grouped source reads as thousands and writes back without grouping", () => {
    useLocale("de-DE");
    expect(dragged(["1.000", "2.000"], 2)).toEqual(["3000", "4000"]);
  });

  it("sv-SE: a decimal comma step writes the comma, with no float noise", () => {
    useLocale("sv-SE");
    expect(dragged(["0,1", "0,2"], 2)).toEqual(["0,3", "0,4"]);
  });

  it("de-DE: the foreign spelling is not a number, so it does not extrapolate", () => {
    useLocale("de-DE");
    // "1.5" / "2.5" are mis-grouped in de-DE (text), exactly as the cell itself
    // would hold them -- the fill must not invent a series the grid does not have.
    expect(detectPattern(["1.5", "2.5"]).type).not.toBe("series");
  });

  it("en-US (invariant): unchanged behaviour, and 0.1 + 0.2 lands as 0.3", () => {
    expect(dragged(["1", "2"], 3)).toEqual(["3", "4", "5"]);
    expect(dragged(["0.1", "0.2"], 1)).toEqual(["0.3"]);
    expect(dragged(["-2", "-1"], 2)).toEqual(["0", "1"]);
  });

  it("a unit suffix is TEXT, not a number with its unit dropped", () => {
    // parseFloat("10 kg") was 10: the drag filled "30" and lost the unit.
    expect(fillNumberOf("10 kg")).toBeNull();
    expect(dragged(["10 kg", "20 kg"], 1)).not.toEqual(["30"]);
  });

  it("the shared planner (drag, double-click, Fill > Series) carries the locale through", () => {
    useLocale("de-DE");
    const plan = planFillLine({
      source: [
        { row: 0, col: 0, value: "1,5", styleIndex: 0 },
        { row: 1, col: 0, value: "2,5", styleIndex: 0 },
      ],
      targets: [{ row: 2, col: 0 }],
    });
    expect(plan).toHaveLength(1);
    expect(generateFillValue(plan[0].pattern, plan[0].allSourceValues, plan[0].fillIndex)).toBe("3,5");
  });

  it("fillNumberText: fifteen significant digits, locale separator, no grouping", () => {
    useLocale("de-DE");
    expect(fillNumberText(1234567.25)).toBe("1234567,25");
    expect(fillNumberText(0.1 + 0.2)).toBe("0,3");
    expect(fillNumberText(-0.5)).toBe("-0,5");
  });
});
