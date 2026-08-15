//! FILENAME: app/src/core/lib/gridRenderer/rendering/overflowMarker.test.ts
// PURPOSE: Pin Excel's overflow rule at the DECISION level, not through a frame.
// CONTEXT: The naive version of this feature - "replace the ellipsis with
//          '####'" - is a regression, because Excel's '####' is for numbers and
//          dates ONLY and its text behaviour is spill-then-clip. These tests
//          exist to make that distinction impossible to lose: half of them are
//          about text NOT getting the marker.

import { describe, it, expect } from "vitest";

import {
  MARKER_CHAR,
  overflowMarker,
  classifyCellContent,
  isNumericOnlyFormat,
  isTextFormat,
  classifyNumberFormat,
  isGeneralFormat,
  parseGeneralNumber,
  renderWithDecimals,
  renderScientific,
  fitNumericDisplay,
  blocksSpill,
} from "./overflowMarker";

/** A monospace measurer: every glyph is exactly 6px, like a test font. */
const CHAR_WIDTH = 6;
const measure = (text: string) => text.length * CHAR_WIDTH;

// ============================================================================
// The marker itself
// ============================================================================

describe("the marker is ASCII '#', repeated to fill the column", () => {
  it("is the ASCII number sign, U+0023 - never a Unicode glyph", () => {
    expect(MARKER_CHAR).toBe("#");
    expect(MARKER_CHAR.codePointAt(0)).toBe(0x23);
  });

  it("carries no non-ASCII character at any width", () => {
    for (const width of [0, 1, 12, 60, 240, 1200]) {
      const marker = overflowMarker(width, measure);
      // Printable ASCII only: no Unicode ellipsis, no box-drawing substitute.
      expect(/^[\x20-\x7e]*$/.test(marker)).toBe(true);
      expect(marker.replace(/#/g, "")).toBe("");
    }
  });

  it("REPEATS to fill the width rather than printing exactly four", () => {
    // 60px of room at 6px a glyph is ten hashes, not four.
    expect(overflowMarker(60, measure)).toBe("##########");
    expect(overflowMarker(120, measure)).toBe("#".repeat(20));
  });

  it("never drops below four, however narrow the column", () => {
    expect(overflowMarker(6, measure)).toBe("####");
    expect(overflowMarker(1, measure)).toBe("####");
  });

  it("survives a degenerate measurer without allocating a huge string", () => {
    expect(overflowMarker(100, () => 0)).toBe("####");
    expect(overflowMarker(1e9, measure).length).toBeLessThanOrEqual(512);
  });
});

// ============================================================================
// Which rule applies
// ============================================================================

describe("classifyCellContent: numbers and dates get the marker, text never does", () => {
  it("reads a General number as numeric", () => {
    expect(classifyCellContent("1234.5678", "General", false)).toBe("numeric");
    expect(classifyCellContent("-42", "General", false)).toBe("numeric");
  });

  it("reads General prose as text", () => {
    expect(classifyCellContent("Quarterly revenue", "General", false)).toBe("text");
    expect(classifyCellContent("Total", "General", false)).toBe("text");
  });

  it("reads a DATE display as numeric even though it parses as no number", () => {
    // This is the case a display-string heuristic alone gets wrong: the date is
    // the single most common '####' in Excel, and Number("2024-01-15") is NaN.
    expect(classifyCellContent("2024-01-15", "General", false)).toBe("text");
    expect(classifyCellContent("2024-01-15", "Date (YYYY-MM-DD)", false)).toBe("numeric");
    expect(classifyCellContent("den 15 januari 2024", "Date (den D MMMM YYYY)", false)).toBe(
      "numeric"
    );
  });

  it("reads a TIME display as numeric", () => {
    expect(classifyCellContent("13:45:00", "Time (HH:MM:SS)", false)).toBe("numeric");
  });

  it("reads sv-SE currency as numeric, which a bare number test does not", () => {
    // "1 234,00 kr" has a non-breaking thousands separator and a symbol suffix;
    // isNumericValue() alone answers NO. The format is what carries it.
    expect(classifyCellContent("1 234,00 kr", "Currency ( kr, 2 decimals)", false)).toBe(
      "numeric"
    );
  });

  it("treats the Text format '@' as text however numeric the digits look", () => {
    expect(classifyCellContent("12345", "@", false)).toBe("text");
    expect(classifyCellContent("0000123", "@", false)).toBe("text");
  });

  it("treats an error literal as numeric - it cannot spill either", () => {
    expect(classifyCellContent("#DIV/0!", "General", false)).toBe("numeric");
    expect(classifyCellContent("#N/A", "General", false)).toBe("numeric");
  });

  it("treats a Show Formulas source line as text", () => {
    expect(classifyCellContent("=SUM(A1:A9)", "Number (2 decimals)", true)).toBe("text");
  });

  it("treats an empty display as text, which is the inert answer", () => {
    expect(classifyCellContent("", "Date (YYYY-MM-DD)", false)).toBe("text");
  });

  it("does not mark a wordy value that happens to sit under a numeric format", () => {
    // No digits at all -> unambiguously not a formatted number.
    expect(classifyCellContent("n/a", "Number (2 decimals)", false)).toBe("text");
  });
});

describe("format classification", () => {
  it("knows the numeric-only display names the backend emits", () => {
    for (const fmt of [
      "Number (2 decimals)",
      "Number (0 decimals, with separators)",
      "Currency ($, 2 decimals)",
      "Accounting ($, 2 decimals)",
      "Fraction (up to 1 digits)",
      "Percentage (2 decimals)",
      "Scientific (2 decimals)",
      "Date (YYYY-MM-DD)",
      "Time (HH:MM:SS)",
    ]) {
      expect(isNumericOnlyFormat(fmt), fmt).toBe(true);
    }
  });

  it("does not claim General or the text placeholder", () => {
    expect(isNumericOnlyFormat("General")).toBe(false);
    expect(isNumericOnlyFormat("")).toBe(false);
    expect(isNumericOnlyFormat("@")).toBe(false);
    expect(isNumericOnlyFormat('0.00;-0.00;"-";@')).toBe(false);
    expect(isGeneralFormat("General")).toBe(true);
    expect(isGeneralFormat("")).toBe(true);
    expect(isGeneralFormat("Number (2 decimals)")).toBe(false);
  });

  it("separates a TEXT-only code from a multi-section one that also takes numbers", () => {
    expect(isTextFormat("@")).toBe(true);
    expect(isTextFormat('"total: "@')).toBe(true);
    // Four sections: positive/negative/zero/TEXT. Numbers render numerically.
    expect(classifyNumberFormat('0.00;-0.00;"-";@')).toBe("ambiguous");
    expect(isTextFormat("General")).toBe(false);
    // A literal containing '#' is not a digit placeholder.
    expect(classifyNumberFormat('"#"@')).toBe("text-only");
  });

  it("reads a raw custom code built from digit placeholders as numeric", () => {
    expect(isNumericOnlyFormat("#,##0.00")).toBe(true);
    expect(isNumericOnlyFormat("0.00%")).toBe(true);
  });

  it("answers the same on a repeat call (the memo cannot change the answer)", () => {
    const first = isNumericOnlyFormat("Date (YYYY-MM-DD)");
    expect(isNumericOnlyFormat("Date (YYYY-MM-DD)")).toBe(first);
  });
});

// ============================================================================
// General's number, recovered from its own display
// ============================================================================

describe("parseGeneralNumber", () => {
  it("recovers an en-US General display", () => {
    expect(parseGeneralNumber("1234.5678")).toEqual({
      value: 1234.5678,
      decimalSeparator: ".",
      decimals: 4,
    });
  });

  it("recovers an sv-SE General display and remembers the comma", () => {
    expect(parseGeneralNumber("1234,5678")).toEqual({
      value: 1234.5678,
      decimalSeparator: ",",
      decimals: 4,
    });
  });

  it("recovers integers and negatives", () => {
    expect(parseGeneralNumber("42")).toEqual({ value: 42, decimalSeparator: ".", decimals: 0 });
    expect(parseGeneralNumber("-7,5")!.value).toBeCloseTo(-7.5, 10);
  });

  it("recovers the engine's exponential General output", () => {
    expect(parseGeneralNumber("1.5e15")!.value).toBeCloseTo(1.5e15, 0);
    expect(parseGeneralNumber("1,5e-7")!.value).toBeCloseTo(1.5e-7, 20);
  });

  it("refuses anything that is not a bare General number", () => {
    expect(parseGeneralNumber("1,234.00")).toBeNull(); // thousands separator
    expect(parseGeneralNumber("$1234")).toBeNull();
    expect(parseGeneralNumber("2024-01-15")).toBeNull();
    expect(parseGeneralNumber("Total")).toBeNull();
    expect(parseGeneralNumber("")).toBeNull();
  });
});

describe("re-rendering keeps the locale separator and Excel's spelling", () => {
  it("ROUNDS when dropping decimals rather than truncating", () => {
    expect(renderWithDecimals(1234.5678, 1, ".")).toBe("1234.6");
    expect(renderWithDecimals(1234.5678, 0, ".")).toBe("1235");
  });

  it("keeps a comma decimal separator", () => {
    expect(renderWithDecimals(1234.5678, 2, ",")).toBe("1234,57");
  });

  it("spells scientific the way Excel does: uppercase E, 2-digit exponent", () => {
    expect(renderScientific(25000000, 1, ".")).toBe("2.5E+07");
    expect(renderScientific(25000000, 0, ".")).toBe("3E+07");
    expect(renderScientific(0.000000015, 1, ".")).toBe("1.5E-08");
    expect(renderScientific(25000000, 1, ",")).toBe("2,5E+07");
  });

  it("keeps a 3-digit exponent intact rather than padding it away", () => {
    expect(renderScientific(1e120, 1, ".")).toBe("1.0E+120");
  });
});

// ============================================================================
// The ladder
// ============================================================================

describe("fitNumericDisplay: Excel's ladder", () => {
  const fit = (display: string, numberFormat: string, availableWidth: number) =>
    fitNumericDisplay({ display, numberFormat, availableWidth, measure });

  it("paints the value untouched when it fits", () => {
    const r = fit("1234.57", "Number (2 decimals)", 100);
    expect(r).toMatchObject({ text: "1234.57", marker: false, rung: "fits" });
  });

  it("General DROPS DECIMALS before it gives up", () => {
    // 36px = 6 glyphs. "1234.5678" is 9; "1234.6" is 6 and fits exactly.
    const r = fit("1234.5678", "General", 36);
    expect(r).toMatchObject({ text: "1234.6", marker: false, rung: "rounded" });
  });

  it("General keeps the MOST decimals that still fit", () => {
    // 48px = 8 glyphs -> "1234.567" would be 8 but rounding gives "1234.568".
    const r = fit("1234.5678", "General", 48);
    expect(r.rung).toBe("rounded");
    expect(r.text).toBe("1234.568");
  });

  it("General then goes SCIENTIFIC when even the integer will not fit", () => {
    // 42px = 7 glyphs. 25000000 is 8 digits; "2.5E+07" is exactly 7.
    const r = fit("25000000", "General", 42);
    expect(r).toMatchObject({ text: "2.5E+07", marker: false, rung: "scientific" });
  });

  it("General only marks when even the shortest scientific form is too wide", () => {
    // 24px = 4 glyphs; the shortest form "3E+07" is 5.
    const r = fit("25000000", "General", 24);
    expect(r.marker).toBe(true);
    expect(r.rung).toBe("marker");
    expect(r.text).toBe("####");
  });

  it("an EXPLICIT format does not negotiate - it marks straight away", () => {
    // The same value and the same width that General rounded to "1234.6".
    const r = fit("1234.5678", "Number (4 decimals)", 36);
    expect(r).toMatchObject({ marker: true, rung: "marker" });
    expect(r.text).toBe("######");
  });

  it("a DATE that does not fit marks immediately - Excel will not reformat it", () => {
    const r = fit("2024-01-15", "Date (YYYY-MM-DD)", 36);
    expect(r).toMatchObject({ marker: true, rung: "marker" });
    expect(r.text).toBe("######");
  });

  it("a currency value marks rather than losing its symbol", () => {
    const r = fit("1 234,00 kr", "Currency ( kr, 2 decimals)", 30);
    expect(r.marker).toBe(true);
    expect(r.text).toBe("#####");
  });

  it("uses a caller-supplied measurement instead of measuring again", () => {
    let calls = 0;
    const counting = (t: string) => {
      calls++;
      return t.length * CHAR_WIDTH;
    };
    const r = fitNumericDisplay({
      display: "12",
      numberFormat: "General",
      availableWidth: 100,
      measure: counting,
      displayWidth: 12,
    });
    expect(r.rung).toBe("fits");
    expect(calls).toBe(0);
  });

  it("marks a value it cannot take apart rather than inventing a shorter one", () => {
    const r = fit("#DIV/0!", "General", 12);
    expect(r.marker).toBe(true);
  });
});

// ============================================================================
// Paint cost
// ============================================================================

describe("the ladder searches, it does not walk", () => {
  /** Run the ladder and report how many times it measured. */
  function measurements(display: string, numberFormat: string, availableWidth: number) {
    let calls = 0;
    const counting = (t: string) => {
      calls++;
      return t.length * CHAR_WIDTH;
    };
    const r = fitNumericDisplay({ display, numberFormat, availableWidth, measure: counting });
    return { calls, rung: r.rung, text: r.text };
  }

  // This is the guard on the hottest paint path in the product. A General value
  // carries up to 10 significant digits, so walking the decimal rung from the
  // longest form downwards cost a dozen measureText calls on a cell that was
  // never going to fit. Width is MONOTONE in the digit count, so each rung is a
  // binary search off its own cheapest candidate. Measured on a dense
  // adversarial viewport in a real browser, this took the whole frame from
  // 12.5 measureText calls per cell to 3.7.
  const CEILING = 8;

  it("costs no more than a handful of measurements on the rounding rung", () => {
    const { calls, rung } = measurements("1234.5678901234", "General", 48);
    expect(rung).toBe("rounded");
    expect(calls).toBeLessThanOrEqual(CEILING);
  });

  it("costs no more than a handful on the scientific rung", () => {
    const { calls, rung } = measurements("123456789012345", "General", 48);
    expect(rung).toBe("scientific");
    expect(calls).toBeLessThanOrEqual(CEILING);
  });

  it("costs almost nothing to give up: the two shortest forms, then the marker", () => {
    const { calls, rung } = measurements("123456789012345", "General", 18);
    expect(rung).toBe("marker");
    expect(calls).toBeLessThanOrEqual(6);
  });

  it("costs ONE measurement for a value that fits — the common case", () => {
    const { calls, rung } = measurements("42", "General", 200);
    expect(rung).toBe("fits");
    expect(calls).toBe(1);
  });

  it("an explicit format never enters the ladder at all", () => {
    // display + '#' + the marker: three, whatever the value's length.
    const { calls, rung } = measurements("1234.5678901234", "Number (10 decimals)", 48);
    expect(rung).toBe("marker");
    expect(calls).toBe(3);
  });

  it("searching finds the SAME answer walking did", () => {
    // Guards the optimisation itself: a binary search over a monotone predicate
    // must agree with an exhaustive scan, at every width.
    const display = "1234.5678901234";
    const parsed = parseGeneralNumber(display)!;
    for (let width = 6; width <= 130; width += 2) {
      const searched = fitNumericDisplay({
        display, numberFormat: "General", availableWidth: width, measure,
      });
      // Exhaustive reference: the longest rendering that fits, most decimals
      // first, then scientific, then the marker.
      let expected: string | null = null;
      for (let d = parsed.decimals; d >= 0 && expected === null; d--) {
        const c = renderWithDecimals(parsed.value, d, ".");
        if (measure(c) <= width) expected = c;
      }
      if (expected === null) {
        for (let k = 5; k >= 0 && expected === null; k--) {
          const c = renderScientific(parsed.value, k, ".");
          if (measure(c) <= width) expected = c;
        }
      }
      if (expected === null) expected = overflowMarker(width, measure);
      expect(searched.text, `width ${width}`).toBe(expected);
    }
  });
});

// ============================================================================
// Spill blocking
// ============================================================================

describe("blocksSpill: Excel's 'absolutely empty' neighbour", () => {
  it("an absent cell does not block", () => {
    expect(blocksSpill(undefined)).toBe(false);
  });

  it("a cell that exists only to carry a style does not block", () => {
    expect(blocksSpill({ display: "", formula: null })).toBe(false);
  });

  it("visible content blocks", () => {
    expect(blocksSpill({ display: "x", formula: null })).toBe(true);
  });

  it("a single SPACE blocks - Excel names spaces explicitly", () => {
    expect(blocksSpill({ display: " ", formula: null })).toBe(true);
  });

  it('a neighbour holding =""  blocks, though it displays nothing', () => {
    expect(blocksSpill({ display: "", formula: '=""' })).toBe(true);
  });
});

// ============================================================================
// The transported class (BUG-0066)
// ============================================================================

describe("the class the backend transports beats the renderer's inference", () => {
  // A monospace-ish stub: every glyph is 10px wide.
  const measure = (t: string) => t.length * 10;

  it("a NEGATIVE serial under a Date format is refused at EVERY width", () => {
    // What the engine actually renders for -1.0 under Date(YYYY-MM-DD): a
    // plausible lie. The renderer cannot tell it from a real date, which is
    // precisely why the class has to arrive from Rust.
    const display = "1900-01-01";

    for (const availableWidth of [30, 100, 400, 5000]) {
      const fit = fitNumericDisplay({
        display,
        numberFormat: "Date (YYYY-MM-DD)",
        availableWidth,
        measure,
        transported: "unrepresentable",
      });
      expect(fit.marker, `width ${availableWidth}`).toBe(true);
      expect(fit.rung, `width ${availableWidth}`).toBe("marker");
      expect(fit.text.startsWith("####"), `width ${availableWidth}`).toBe(true);
      // ASCII 0x23 only -- never a Unicode glyph.
      expect([...fit.text].every((c) => c.charCodeAt(0) === 0x23)).toBe(true);
    }
  });

  it("widening NEVER clears it - the refusal is semantic, not a layout outcome", () => {
    const wide = fitNumericDisplay({
      display: "1900-01-01",
      numberFormat: "Date (YYYY-MM-DD)",
      availableWidth: 100_000,
      measure,
      transported: "unrepresentable",
    });
    expect(wide.marker).toBe(true);
  });

  it("the SAME display at the same width renders normally when it is positive", () => {
    // The positive control: without the transported refusal, "1900-01-01" fits
    // a 400px box perfectly. So the marker above is caused by the class and by
    // nothing else.
    const fit = fitNumericDisplay({
      display: "1900-01-01",
      numberFormat: "Date (YYYY-MM-DD)",
      availableWidth: 400,
      measure,
      transported: "numeric",
    });
    expect(fit.marker).toBe(false);
    expect(fit.text).toBe("1900-01-01");
    expect(fit.rung).toBe("fits");
  });

  it("classifyCellContent takes the transported class over the inference", () => {
    // Text under an explicitly numeric format: the inference reads the digits
    // and says numeric, which would MARK a pasted header in a Date column.
    expect(classifyCellContent("2024 Q1", "Date (YYYY-MM-DD)", false)).toBe("numeric");
    expect(classifyCellContent("2024 Q1", "Date (YYYY-MM-DD)", false, "text")).toBe("text");

    // And the other direction: a value the inference would call text.
    expect(classifyCellContent("1900-01-01", "General", false)).toBe("text");
    expect(classifyCellContent("1900-01-01", "General", false, "numeric")).toBe("numeric");
    expect(classifyCellContent("1900-01-01", "General", false, "unrepresentable")).toBe("numeric");
  });

  it("an absent class leaves every existing inference exactly as it was", () => {
    // The field is optional on the wire, so every cell that predates it must
    // classify identically. Text is the fail-safe direction.
    expect(classifyCellContent("1234,5", "General", false, undefined)).toBe("numeric");
    expect(classifyCellContent("hello", "General", false, undefined)).toBe("text");
    expect(classifyCellContent("12345", "@", false, undefined)).toBe("text");
    expect(classifyCellContent("", "General", false, undefined)).toBe("text");
  });

  it("an empty display is text even when the class says otherwise", () => {
    // Nothing to overflow, and nothing to mark.
    expect(classifyCellContent("", "Date (YYYY-MM-DD)", false, "unrepresentable")).toBe("text");
  });
});
