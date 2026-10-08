//! FILENAME: app/extensions/Charts/rendering/visuals/visualValues.ts
// PURPOSE: The one value a tile visual (Card, Multi-row card, KPI, Gauge) shows
//          and the text it is written as: Power BI's display units, the SOURCE
//          text when the value is text or the units are "none", and the
//          aggregate that turns a many-row field into one number.
// CONTEXT: Shared by the four painters so a Card and a Gauge over the same cell
//          can never write the same number two ways. Pure: no canvas, no IO.
//
//          THE SOURCE TEXT (`ParsedChartData.displayValues`) is what keeps a
//          card honest. The chart model's `values` are numbers only and the
//          readers write 0 for a cell they cannot read as one, so a Card over a
//          text cell would otherwise show a confident "0"; and a currency cell
//          would lose its "$". The rule here: text is shown as text; a number is
//          shown as the source showed it unless a display unit has to scale it,
//          and then the source's currency prefix/suffix travels with the unit.

import type { ParsedChartData, VisualAggregate, VisualDisplayUnits } from "../../types";
import { parseDisplayNumber } from "../../lib/chartFieldTypes";

/** What an empty field shows. Power BI's own word for "no value". */
export const BLANK_TEXT = "(Blank)";

/**
 * One value a visual shows. `categoryIndex` is the PAINTER-space datum it came
 * from, or -1 when it was computed over several (a sum, an average); a datum's
 * per-point formatting and its source text exist only in the first case.
 */
export interface VisualValue {
  value: number | null;
  text: string | null;
  categoryIndex: number;
  /**
   * For a value COMPUTED over several data (a sum, an average) or one the
   * visual derived (a gauge's maximum, a KPI's goal): the text of a source
   * datum it is written LIKE -- its currency, its percent sign. Never written
   * verbatim (that is `text`, the value's own source text): the sum of "45%"
   * and "30%" is "75%", not "45%".
   */
  formatSource?: string | null;
  /** True when the datum is TEXT in its source: it is written as its text. */
  isText?: boolean;
}

/** Display-unit options shared by every tile visual. */
export interface VisualFormatOptions {
  displayUnits?: VisualDisplayUnits;
  decimals?: number;
}

/** The source text of one datum, or null when the reader had none. */
export function datumText(data: ParsedChartData, si: number, ci: number): string | null {
  const t = data.displayValues?.[si]?.[ci];
  return typeof t === "string" && t !== "" ? t : null;
}

/** Is this datum BLANK in its source (an empty cell, an empty measure)? */
export function isBlankDatum(data: ParsedChartData, si: number, ci: number): boolean {
  return data.datumKinds?.[si]?.[ci] === "blank";
}

/**
 * Is this datum TEXT in its source? The reader's kind answers when it knew
 * the type (a text cell is text even when it reads "2026 budget"; a number is a
 * number whatever its format). Otherwise it is asked of the source text, never
 * of the number: the number of a text cell is the 0 the parser wrote, which is
 * the lie this module exists to keep off a card.
 */
export function isTextDatum(data: ParsedChartData, si: number, ci: number): boolean {
  const kind = data.datumKinds?.[si]?.[ci];
  if (kind === "number" || kind === "blank") return false;
  const t = datumText(data, si, ci);
  if (kind === "text") return t !== null;
  return t !== null && Number.isNaN(parseDisplayNumber(t));
}

/**
 * One datum as a visual shows it: its number (null when it is blank), its
 * source text, and where it came from.
 */
export function datumValue(data: ParsedChartData, si: number, ci: number): VisualValue {
  const raw = data.series[si]?.values[ci];
  const blank = isBlankDatum(data, si, ci) || raw === undefined || !Number.isFinite(raw);
  const text = datumText(data, si, ci);
  const isText = isTextDatum(data, si, ci);
  return { value: blank ? null : raw, text, categoryIndex: ci, ...(isText ? { isText } : {}) };
}

/**
 * Turn series `si` into the one value a Card or a Gauge shows.
 *
 * "auto" is Power BI's default: a single datum is shown as it is; a series
 * the SOURCE totals (a pivot's or a design query's grand total,
 * `seriesTotals`) shows that total, because only the source can total an
 * average or a distinct count; a text field shows its first value; other
 * numbers are SUMMED. The numeric aggregates skip text AND blank rows --
 * averaging in a 0 for "n/a" or for an empty cell would be inventing a number
 * the source never had -- and "count" counts the rows that hold something.
 */
export function aggregateSeries(
  data: ParsedChartData,
  si: number,
  how: VisualAggregate = "auto",
): VisualValue {
  const values = data.series[si]?.values ?? [];
  const n = values.length;
  if (n === 0) return { value: null, text: null, categoryIndex: -1 };

  const at = (ci: number): VisualValue => datumValue(data, si, ci);

  const numericIdx: number[] = [];
  const filledIdx: number[] = [];
  for (let ci = 0; ci < n; ci++) {
    if (isBlankDatum(data, si, ci)) continue;
    filledIdx.push(ci);
    if (!isTextDatum(data, si, ci) && Number.isFinite(values[ci])) numericIdx.push(ci);
  }
  // The text a computed value is written like: the first number's own text.
  const formatSource = numericIdx.length > 0 ? datumText(data, si, numericIdx[0]) : null;
  const withFormat = formatSource !== null ? { formatSource } : {};

  let mode = how;
  if (mode === "auto") {
    if (n === 1) return at(0);
    const total = data.seriesTotals?.[si];
    if (total) {
      return { value: total.value, text: total.text === "" ? null : total.text, categoryIndex: -1, ...withFormat };
    }
    mode = numericIdx.length === 0 ? "first" : "sum";
  }

  switch (mode) {
    case "first":
      // The first datum that HOLDS something; all blank is blank.
      return filledIdx.length > 0 ? at(filledIdx[0]) : { value: null, text: null, categoryIndex: -1 };
    case "last":
      return filledIdx.length > 0 ? at(filledIdx[filledIdx.length - 1]) : { value: null, text: null, categoryIndex: -1 };
    case "count":
      return { value: filledIdx.length, text: null, categoryIndex: -1 };
    default: {
      if (numericIdx.length === 0) return { value: null, text: null, categoryIndex: -1 };
      const nums = numericIdx.map((ci) => values[ci]);
      let value: number;
      if (mode === "sum") value = nums.reduce((a, b) => a + b, 0);
      else if (mode === "average") value = nums.reduce((a, b) => a + b, 0) / nums.length;
      else if (mode === "min") value = Math.min(...nums);
      else value = Math.max(...nums);
      return { value, text: null, categoryIndex: -1, ...withFormat };
    }
  }
}

/** Write a {@link VisualValue}: text as text, blank as (Blank), numbers through the units. */
export function formatVisualValue(v: VisualValue, opts: VisualFormatOptions): string {
  if (v.text !== null && (v.isText === true || Number.isNaN(parseDisplayNumber(v.text)))) return v.text;
  if (v.value === null || !Number.isFinite(v.value)) return BLANK_TEXT;
  return formatVisualNumber(v.value, { ...opts, sourceText: v.text, formatSource: v.formatSource ?? null });
}

/** K / M / bn / T, largest first — Power BI's auto display units. */
const AUTO_STEPS: ReadonlyArray<{ factor: number; suffix: string }> = [
  { factor: 1e12, suffix: "T" },
  { factor: 1e9, suffix: "bn" },
  { factor: 1e6, suffix: "M" },
  { factor: 1e3, suffix: "K" },
];

const FORCED_STEPS: Record<Exclude<VisualDisplayUnits, "auto" | "none">, { factor: number; suffix: string }> = {
  thousands: { factor: 1e3, suffix: "K" },
  millions: { factor: 1e6, suffix: "M" },
  billions: { factor: 1e9, suffix: "bn" },
  trillions: { factor: 1e12, suffix: "T" },
};

/**
 * Write a number under a display unit.
 *
 * - "none", or "auto" under a thousand: the SOURCE text when there is one and
 *   no decimals were asked for (so "$1,234.50" stays exactly that); otherwise
 *   the number with grouping.
 * - "auto" from a thousand up, or a forced unit: scaled, with the unit's
 *   suffix. Automatic decimals are 0 at ten or more of the unit and 1 below
 *   (11,732 -> "12K", 1,234 -> "1.2K"), a trailing ".0" dropped. The source's
 *   currency prefix and suffix are kept around the scaled number — but not a
 *   percent sign: a percentage scaled to thousands is not a quantity anyone
 *   means, so it is never produced.
 * - A PERCENT source (or exemplar) is written as a percent: 0.75 -> "75%".
 *
 * `sourceText` is the value's OWN source text and may be returned as it is.
 * `formatSource` is only an exemplar for a computed or derived value (a sum,
 * a KPI's goal, a gauge's maximum): its currency and percent sign are copied,
 * its digits never are.
 */
export function formatVisualNumber(
  value: number,
  opts: VisualFormatOptions & { sourceText?: string | null; formatSource?: string | null },
): string {
  const units = opts.displayUnits ?? "auto";
  const source = opts.sourceText ?? null;
  const sourceIsNumber = source !== null && !Number.isNaN(parseDisplayNumber(source));
  const exemplar = sourceIsNumber ? source : (opts.formatSource ?? null);
  const exemplarIsNumber = exemplar !== null && !Number.isNaN(parseDisplayNumber(exemplar));
  const percent = exemplarIsNumber && exemplar!.trim().endsWith("%");

  if (percent) {
    if (sourceIsNumber && opts.decimals === undefined) return source!;
    const pct = value * 100;
    const d = opts.decimals ?? (Number.isInteger(Number(pct.toFixed(9))) ? 0 : 2);
    return (pct < 0 ? "-" : "") + groupDigits(Math.abs(pct), d, opts.decimals === undefined) + "%";
  }

  let step: { factor: number; suffix: string } | null = null;
  if (units === "auto") {
    step = AUTO_STEPS.find((s) => Math.abs(value) >= s.factor) ?? null;
  } else if (units !== "none") {
    step = FORCED_STEPS[units];
  }

  if (step === null) {
    if (sourceIsNumber && opts.decimals === undefined) return source!;
    const d = opts.decimals ?? (Number.isInteger(value) ? 0 : 2);
    const body = groupDigits(Math.abs(value), d, opts.decimals === undefined);
    return wrapAffixes((value < 0 ? "-" : "") + body, exemplar, exemplarIsNumber);
  }

  const scaled = value / step.factor;
  const auto = opts.decimals === undefined;
  const d = opts.decimals ?? (Math.abs(scaled) >= 10 ? 0 : 1);
  const body = groupDigits(Math.abs(scaled), d, auto) + step.suffix;
  return wrapAffixes((scaled < 0 ? "-" : "") + body, exemplar, exemplarIsNumber);
}

/** Grouped digits with a "." decimal point; `trim` drops trailing zeros. */
function groupDigits(abs: number, decimals: number, trim: boolean): string {
  let fixed = abs.toFixed(Math.max(0, Math.min(20, Math.floor(decimals))));
  if (trim && fixed.includes(".")) fixed = fixed.replace(/\.?0+$/, "");
  const [int, frac] = fixed.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac !== undefined ? `${grouped}.${frac}` : grouped;
}

/**
 * Put the source's currency prefix/suffix around `core` (which carries its own
 * sign). "$11,732.00" gives prefix "$"; "25 000 kr" gives suffix " kr". A sign
 * or parenthesis in the source is the number's, not an affix.
 */
function wrapAffixes(core: string, source: string | null, use: boolean): string {
  if (!use || source === null) return core;
  const s = source.trim();
  const first = s.search(/\d/);
  if (first < 0) return core;
  let last = first;
  for (let i = s.length - 1; i >= 0; i--) {
    if (/\d/.test(s[i])) { last = i; break; }
  }
  const prefix = s.slice(0, first).replace(/[-(\s]+$/, "").replace(/^[-(]+/, "");
  const suffix = s.slice(last + 1).replace(/^[)]+/, "").replace(/\)$/, "");
  if (suffix.includes("%")) return core;
  const negative = core.startsWith("-");
  const unsigned = negative ? core.slice(1) : core;
  return `${negative ? "-" : ""}${prefix}${unsigned}${suffix}`;
}
