//! FILENAME: app/src/core/lib/locale/localeText.ts
// PURPOSE: THE TypeScript spelling of number and date text in a given locale --
//          pure functions over an explicit LocaleSettings, mirroring the Rust
//          engine (`engine::number_format`, `custom_format`, `typed_entry`).
// CONTEXT: P2 (app locale everywhere). The app locale is owned by Rust; the
//          frontend formats and parses with the SAME settings Rust sends
//          (`get_locale_settings`). One shared corpus,
//          `core/engine/tests/fixtures/locale_text_corpus.json`, is asserted by
//          BOTH suites (Rust `locale_corpus_tests.rs`, TS
//          `__tests__/localeText.corpus.test.ts`), so a display the two
//          disagree on fails a test instead of drifting.
//
// RULES THIS FILE KEEPS:
//   * No Intl, no toLocaleString, no toFixed. Digits come from the EXACT decimal
//     expansion of the double (BigInt), so rounding is decided on the value the
//     engine sees, not on whatever a JS host's toFixed happens to do with a tie.
//   * General output mirrors `format_general` (ties to even, like Rust's
//     `{:.10}` / `{:.5e}`); code output mirrors `apply_custom_format_number`
//     (Excel's half away from zero, computed with the same float steps).
//   * The code grammar is a DECLARED SUBSET: digit placeholders (0 # ?), the
//     decimal point, grouping and scaling commas, %, quoted and escaped
//     literals, _x spacing, * fill, colour brackets, up to four sections, and
//     the date/time tokens. Anything else (conditions, elapsed [h], E+00,
//     fractions, @) renders General and reports `exact: false`.
//   * Format CODES are invariant (en-US syntax) everywhere; only the OUTPUT
//     uses the locale's separators and calendar names.

// ============================================================================
// Types
// ============================================================================

/**
 * Regional settings, exactly as Rust's `get_locale_settings` sends them
 * (`LocaleSettingsData`, camelCase). The calendar names are the engine's
 * `CalendarNames` for the locale's language.
 */
export interface LocaleSettings {
  /** BCP 47 locale ID, e.g. "en-US", "sv-SE" */
  localeId: string;
  /** Human-readable name, e.g. "Svenska (Sverige)" */
  displayName: string;
  /** Decimal separator: "." or "," */
  decimalSeparator: string;
  /** Thousands/grouping separator: ",", ".", U+00A0, "'" */
  thousandsSeparator: string;
  /** List/argument separator used in formulas: "," or ";" */
  listSeparator: string;
  /** Short date pattern (invariant code syntax), e.g. "YYYY-MM-DD" */
  dateFormat: string;
  /**
   * OS long-date pattern, e.g. `"den "d mmmm yyyy` (sv-SE) or
   * `dddd, mmmm d, yyyy` (en-US). Excel's ribbon Long Date entry is the
   * `[$-x-sysdate]` handle, which means exactly "use this".
   */
  longDateFormat: string;
  /**
   * OS long-time pattern WITH seconds, e.g. `hh:mm:ss` (sv-SE, which has no
   * AM/PM designator) or `h:mm:ss AM/PM` (en-US). Excel's ribbon Time entry is
   * the `[$-x-systime]` handle.
   */
  timeFormat: string;
  /** Default currency symbol, e.g. "$", " kr" */
  currencySymbol: string;
  /** Currency position: "before" or "after" */
  currencyPosition: "before" | "after";
  /**
   * The user's explicit choice persisted in the app settings file, or null
   * when the app follows the OS ("System default").
   */
  overrideId: string | null;
  /** Month names, January first (12). */
  monthNamesShort: string[];
  monthNamesLong: string[];
  /** Weekday names, SUNDAY first (7), as the engine's `day_of_week`. */
  dayNamesShort: string[];
  dayNamesLong: string[];
  /** Quarter labels Q1..Q4 in the locale's spelling ("Q1", "Kv1", "T1"). */
  quarterLabels: string[];
}

/** Which of the locale's date patterns to render with. */
export type DateStyle = "short" | "long" | "time" | "dateTime";

/** Options for a number rendered without a format code. */
export interface FormatNumberOptions {
  /** Exactly this many decimals (sets both min and max). */
  decimals?: number;
  /** At least this many decimals (trailing zeros kept down to it). */
  minDecimals?: number;
  /** At most this many decimals (rounded half away from zero, like Excel). */
  maxDecimals?: number;
  /** Insert the locale's group separator. Default false. */
  grouping?: boolean;
  /** Multiply by 100 and append "%". */
  percent?: boolean;
  /** Drop trailing zeros (minDecimals 0). */
  trimZeros?: boolean;
}

/** A code rendering, and whether the code was inside the supported grammar. */
export interface CodeFormatResult {
  text: string;
  /** false: the code used something outside the subset; `text` is General. */
  exact: boolean;
}

// ============================================================================
// Exact decimal expansion (no toFixed, no Intl)
// ============================================================================

/** |x| = 0.d1d2d3... scaled so the decimal point sits after `point` digits. */
interface Decimal {
  /** Significant digits, no leading or trailing zeros ("" for zero). */
  digits: string;
  /** Position of the decimal point counted from the start of `digits`. */
  point: number;
}

type RoundMode = "halfEven" | "halfAway";

const F64_VIEW = new DataView(new ArrayBuffer(8));

/** The exact decimal value of |x| (x finite). */
function exactDecimal(x: number): Decimal {
  const abs = Math.abs(x);
  if (abs === 0) return { digits: "", point: 0 };
  F64_VIEW.setFloat64(0, abs);
  const hi = F64_VIEW.getUint32(0);
  const lo = F64_VIEW.getUint32(4);
  const expBits = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << BigInt(32)) | BigInt(lo);
  let e2: number;
  if (expBits === 0) {
    e2 = -1074;
  } else {
    mant |= BigInt(1) << BigInt(52);
    e2 = expBits - 1075;
  }
  let text: string;
  let fractionDigits: number;
  if (e2 >= 0) {
    text = (mant << BigInt(e2)).toString();
    fractionDigits = 0;
  } else {
    text = (mant * BigInt(5) ** BigInt(-e2)).toString();
    fractionDigits = -e2;
  }
  return normalizeDecimal(text, text.length - fractionDigits);
}

function normalizeDecimal(digits: string, point: number): Decimal {
  let start = 0;
  while (start < digits.length && digits.charCodeAt(start) === 48) start++;
  let end = digits.length;
  while (end > start && digits.charCodeAt(end - 1) === 48) end--;
  if (start === end) return { digits: "", point: 0 };
  return { digits: digits.slice(start, end), point: point - start };
}

/** Round to the first `keep` digits of `d.digits`. */
function roundDecimal(d: Decimal, keep: number, mode: RoundMode): Decimal {
  const { digits, point } = d;
  if (keep >= digits.length) return d;
  if (keep < 0) return { digits: "", point: 0 };
  const first = digits.charCodeAt(keep) - 48;
  let up: boolean;
  if (first > 5) up = true;
  else if (first < 5) up = false;
  else if (/[1-9]/.test(digits.slice(keep + 1))) up = true;
  else if (mode === "halfAway") up = true;
  else up = keep > 0 && (digits.charCodeAt(keep - 1) - 48) % 2 === 1;
  const head = digits.slice(0, keep);
  if (!up) return normalizeDecimal(head, point);
  if (keep === 0) return { digits: "1", point: point + 1 };
  const chars = head.split("");
  let i = keep - 1;
  while (i >= 0) {
    if (chars[i] === "9") {
      chars[i] = "0";
      i--;
    } else {
      chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
      break;
    }
  }
  if (i < 0) return normalizeDecimal("1" + chars.join(""), point + 1);
  return normalizeDecimal(chars.join(""), point);
}

/** Integer digits and exactly `places` fraction digits of a (rounded) decimal. */
function fixedParts(d: Decimal, places: number): { int: string; frac: string } {
  const { digits, point } = d;
  const int = point <= 0 ? "0" : digits.slice(0, point).padEnd(point, "0");
  let frac = "";
  if (places > 0) {
    const after = point < 0 ? "0".repeat(-point) + digits : digits.slice(Math.max(point, 0));
    frac = after.padEnd(places, "0").slice(0, places);
  }
  return { int, frac };
}

/** Rust's `10f64.powi(n)` for a small non-negative n: repeated multiplication. */
function powi10(n: number): number {
  let r = 1;
  for (let i = 0; i < n; i++) r *= 10;
  return r;
}

/** Rust's `f64::round` (half away from zero). */
function roundHalfAway(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/** `x as u64` for a non-negative x: saturating, exact digits. */
function u64Text(x: number): string {
  if (!(x > 0)) return "0";
  if (x >= 18446744073709551615) return "18446744073709551615";
  return BigInt(Math.floor(x)).toString();
}

// ============================================================================
// Separators
// ============================================================================

function localizeDecimal(text: string, locale: LocaleSettings): string {
  return locale.decimalSeparator === "." ? text : text.split(".").join(locale.decimalSeparator);
}

function groupDigits(digits: string, sep: string): string {
  let out = "";
  const len = digits.length;
  for (let i = 0; i < len; i++) {
    if (i > 0 && (len - i) % 3 === 0) out += sep;
    out += digits[i];
  }
  return out;
}

// ============================================================================
// General (mirrors number_format::format_general)
// ============================================================================

function formatGeneral(locale: LocaleSettings, value: number): string {
  if (value === 0) return "0";
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value < 0 ? "-inf" : "inf";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1e15 || abs < 1e-4) {
    // Rust "{:.5e}": six significant digits, ties to even; then the mantissa
    // (never the exponent) loses its trailing zeros; Excel's E+NN spelling.
    const d = roundDecimal(exactDecimal(abs), 6, "halfEven");
    const exponent = d.point - 1;
    const mantissa = d.digits.length > 1 ? d.digits[0] + "." + d.digits.slice(1) : d.digits;
    const expSign = exponent < 0 ? "-" : "+";
    const expDigits = String(Math.abs(exponent)).padStart(2, "0");
    return localizeDecimal(sign + mantissa + "E" + expSign + expDigits, locale);
  }
  if (Number.isInteger(abs)) {
    return sign + fixedParts(exactDecimal(abs), 0).int;
  }
  // Rust "{:.10}" then trailing zeros and a bare point trimmed.
  const exact = exactDecimal(abs);
  const rounded = roundDecimal(exact, exact.point + 10, "halfEven");
  const { int, frac } = fixedParts(rounded, 10);
  const trimmed = frac.replace(/0+$/, "");
  const body = trimmed ? int + "." + trimmed : int;
  return localizeDecimal(sign + body, locale);
}

// ============================================================================
// Format codes (mirrors custom_format.rs for the declared subset)
// ============================================================================

type Token =
  | { t: "zero" }
  | { t: "hash" }
  | { t: "space" }
  | { t: "point" }
  | { t: "comma" }
  | { t: "percent" }
  | { t: "lit"; s: string }
  | { t: "spaceWidth" }
  | { t: "fill" }
  | { t: "slash" }
  | { t: "sci" }
  | { t: "text" }
  | { t: "y4" }
  | { t: "y2" }
  | { t: "m1" }
  | { t: "m2" }
  | { t: "mmm" }
  | { t: "mmmm" }
  | { t: "mmmmm" }
  | { t: "d1" }
  | { t: "d2" }
  | { t: "ddd" }
  | { t: "dddd" }
  | { t: "h1" }
  | { t: "h2" }
  | { t: "min1" }
  | { t: "min2" }
  | { t: "s1" }
  | { t: "s2" }
  | { t: "ampm" };

interface Section {
  tokens: Token[];
  /** A construct outside the declared subset was seen. */
  unsupported: boolean;
  scaleDivisor: number;
  hasPercent: boolean;
  isDatetime: boolean;
  hasDigits: boolean;
  hasText: boolean;
  hasScientific: boolean;
  hasFraction: boolean;
}

const COLOR_NAMES = new Set(["black", "blue", "cyan", "green", "magenta", "red", "white", "yellow"]);
const DATETIME_KINDS = new Set([
  "y4", "y2", "m1", "m2", "mmm", "mmmm", "mmmmm", "d1", "d2", "ddd", "dddd",
  "h1", "h2", "min1", "min2", "s1", "s2", "ampm",
]);

function splitSections(code: string): string[] {
  const sections: string[] = [];
  let current = "";
  let inQuotes = false;
  let inBracket = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"' && !inBracket) {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === "\\" && !inQuotes && !inBracket && i + 1 < code.length) {
      current += ch + code[i + 1];
      i++;
    } else if (ch === "[" && !inQuotes) {
      inBracket = true;
      current += ch;
    } else if (ch === "]" && !inQuotes) {
      inBracket = false;
      current += ch;
    } else if (ch === ";" && !inQuotes && !inBracket) {
      sections.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  sections.push(current);
  return sections;
}

function countRun(chars: string[], start: number, target: string): number {
  let n = 0;
  while (start + n < chars.length && chars[start + n].toLowerCase() === target) n++;
  return n;
}

function isFiller(tok: Token): boolean {
  return tok.t === "lit" || tok.t === "spaceWidth" || tok.t === "fill";
}

function parseSection(src: string): Section {
  const chars = Array.from(src);
  const tokens: Token[] = [];
  let unsupported = false;
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    switch (ch) {
      case "[": {
        let end = -1;
        for (let j = i + 1; j < chars.length; j++) {
          if (chars[j] === "]") {
            end = j;
            break;
          }
        }
        if (end < 0) {
          tokens.push({ t: "lit", s: "[" });
          i += 1;
          break;
        }
        const content = chars.slice(i + 1, end).join("");
        const lower = content.toLowerCase();
        if (["h", "hh", "m", "mm", "s", "ss"].includes(lower)) {
          unsupported = true; // elapsed time
        } else if (COLOR_NAMES.has(lower)) {
          // colour: no effect on text
        } else if (/^\s*(>=|<=|<>|>|<|=)/.test(content)) {
          unsupported = true; // condition
        }
        // any other bracket (locale tags, [$-x-sysdate]) is ignored, as in Rust
        i = end + 1;
        break;
      }
      case '"': {
        let lit = "";
        i += 1;
        while (i < chars.length && chars[i] !== '"') {
          lit += chars[i];
          i += 1;
        }
        if (i < chars.length) i += 1;
        if (lit) tokens.push({ t: "lit", s: lit });
        break;
      }
      case "\\":
        if (i + 1 < chars.length) {
          tokens.push({ t: "lit", s: chars[i + 1] });
          i += 2;
        } else {
          i += 1;
        }
        break;
      case "0":
        tokens.push({ t: "zero" });
        i += 1;
        break;
      case "#":
        tokens.push({ t: "hash" });
        i += 1;
        break;
      case "?":
        tokens.push({ t: "space" });
        i += 1;
        break;
      case ".":
        tokens.push({ t: "point" });
        i += 1;
        break;
      case ",":
        tokens.push({ t: "comma" });
        i += 1;
        break;
      case "%":
        tokens.push({ t: "percent" });
        i += 1;
        break;
      case "E":
      case "e":
        if (i + 1 < chars.length && (chars[i + 1] === "+" || chars[i + 1] === "-")) {
          tokens.push({ t: "sci" });
          i += 2;
        } else {
          tokens.push({ t: "lit", s: ch });
          i += 1;
        }
        break;
      case "@":
        tokens.push({ t: "text" });
        i += 1;
        break;
      case "_":
        if (i + 1 < chars.length) {
          tokens.push({ t: "spaceWidth" });
          i += 2;
        } else {
          i += 1;
        }
        break;
      case "*":
        if (i + 1 < chars.length) {
          tokens.push({ t: "fill" });
          i += 2;
        } else {
          i += 1;
        }
        break;
      case "/":
        tokens.push({ t: "slash" });
        i += 1;
        break;
      case "y":
      case "Y": {
        const n = countRun(chars, i, "y");
        tokens.push({ t: n >= 4 ? "y4" : "y2" });
        i += n;
        break;
      }
      case "m":
      case "M": {
        const n = countRun(chars, i, "m");
        tokens.push({ t: n === 1 ? "m1" : n === 2 ? "m2" : n === 3 ? "mmm" : n === 4 ? "mmmm" : "mmmmm" });
        i += n;
        break;
      }
      case "d":
      case "D": {
        const n = countRun(chars, i, "d");
        tokens.push({ t: n === 1 ? "d1" : n === 2 ? "d2" : n === 3 ? "ddd" : "dddd" });
        i += n;
        break;
      }
      case "h":
      case "H": {
        const n = countRun(chars, i, "h");
        tokens.push({ t: n >= 2 ? "h2" : "h1" });
        i += n;
        break;
      }
      case "s":
      case "S": {
        const n = countRun(chars, i, "s");
        tokens.push({ t: n >= 2 ? "s2" : "s1" });
        i += n;
        break;
      }
      case "A":
      case "a": {
        const rest = chars.slice(i).join("").toUpperCase();
        if (rest.startsWith("AM/PM")) {
          tokens.push({ t: "ampm" });
          i += 5;
        } else if (rest.startsWith("A/P")) {
          tokens.push({ t: "ampm" });
          i += 3;
        } else {
          tokens.push({ t: "lit", s: ch });
          i += 1;
        }
        break;
      }
      default:
        tokens.push({ t: "lit", s: ch });
        i += 1;
    }
  }

  // m/mm next to an hour or a second is minutes.
  const toMinutes: number[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const kind = tokens[k].t;
    if (kind !== "m1" && kind !== "m2") continue;
    let p = k - 1;
    while (p >= 0 && isFiller(tokens[p])) p--;
    let n = k + 1;
    while (n < tokens.length && isFiller(tokens[n])) n++;
    const prevHour = p >= 0 && (tokens[p].t === "h1" || tokens[p].t === "h2");
    const nextSecond = n < tokens.length && (tokens[n].t === "s1" || tokens[n].t === "s2");
    if (prevHour || nextSecond) toMinutes.push(k);
  }
  for (const k of toMinutes) tokens[k] = { t: tokens[k].t === "m1" ? "min1" : "min2" };

  // Scaling commas right after the last digit placeholder / point.
  let lastDigit = -1;
  for (let k = tokens.length - 1; k >= 0; k--) {
    const kind = tokens[k].t;
    if (kind === "zero" || kind === "hash" || kind === "space" || kind === "point") {
      lastDigit = k;
      break;
    }
  }
  let scaleDivisor = 0;
  if (lastDigit >= 0) {
    let k = lastDigit + 1;
    while (k < tokens.length && tokens[k].t === "comma") {
      scaleDivisor++;
      k++;
    }
    if (scaleDivisor > 0) tokens.splice(lastDigit + 1, scaleDivisor);
  }

  const hasDigits = tokens.some((tk) => tk.t === "zero" || tk.t === "hash" || tk.t === "space");
  const isDatetime = tokens.some((tk) => DATETIME_KINDS.has(tk.t));
  return {
    tokens,
    unsupported,
    scaleDivisor,
    hasPercent: tokens.some((tk) => tk.t === "percent"),
    isDatetime,
    hasDigits,
    hasText: tokens.some((tk) => tk.t === "text"),
    hasScientific: tokens.some((tk) => tk.t === "sci"),
    hasFraction: tokens.some((tk) => tk.t === "slash"),
  };
}

/** Whether the section can be rendered exactly by this module. */
function sectionSupported(s: Section): boolean {
  if (s.unsupported) return false;
  if (s.isDatetime) return true;
  if (s.hasScientific || s.hasText) return false;
  if (s.hasFraction) return false;
  return true;
}

function selectSection(sections: Section[], value: number): Section {
  const [positive, negative, zero] = sections;
  if (value > 0 || (value === 0 && !zero)) return positive;
  if (value < 0) return negative ?? positive;
  return zero ?? positive;
}

function hasExplicitNegative(tokens: Token[]): boolean {
  let open = false;
  let close = false;
  let minus = false;
  for (const tk of tokens) {
    if (tk.t !== "lit") continue;
    if (tk.s === "(") open = true;
    if (tk.s === ")") close = true;
    if (tk.s === "-") minus = true;
  }
  return minus || (open && close);
}

function hasGroupingComma(tokens: Token[]): boolean {
  let sawDigit = false;
  let pastPoint = false;
  for (const tk of tokens) {
    if (tk.t === "point") pastPoint = true;
    else if (tk.t === "zero" || tk.t === "hash" || tk.t === "space") sawDigit = true;
    else if (tk.t === "comma" && sawDigit && !pastPoint) return true;
  }
  return false;
}

function isAsciiDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

/** Mirrors `insert_thousands_separators_in_result`. */
function insertGrouping(formatted: string, locale: LocaleSettings): string {
  const pointPos = formatted.indexOf(locale.decimalSeparator);
  const end = pointPos >= 0 ? pointPos : formatted.length;
  let start = 0;
  while (start < end && !isAsciiDigit(formatted[start])) start++;
  if (start >= end) return formatted;
  let digitEnd = start;
  while (digitEnd < end && isAsciiDigit(formatted[digitEnd])) digitEnd++;
  const digits = formatted.slice(start, digitEnd);
  if (digits.length <= 3) return formatted;
  let out = formatted.slice(0, start) + groupDigits(digits, locale.thousandsSeparator);
  if (pointPos >= 0) out += formatted.slice(pointPos);
  else out += formatted.slice(digitEnd);
  return out;
}

/** Mirrors `apply_custom_format_number` + `render_number_tokens`. */
function renderNumberSection(value: number, section: Section, locale: LocaleSettings): string {
  const tokens = section.tokens;
  if (tokens.length === 0) return "";
  if (!section.hasDigits && !section.hasText) {
    let out = "";
    for (const tk of tokens) {
      if (tk.t === "lit") out += tk.s;
      else if (tk.t === "spaceWidth") out += " ";
      else if (tk.t === "percent") out += "%";
    }
    return out;
  }
  let num = Math.abs(value);
  if (section.scaleDivisor > 0) num /= Math.pow(1000, section.scaleDivisor);
  if (section.hasPercent) num *= 100;
  let intPlaceholders = 0;
  let decPlaceholders = 0;
  let past = false;
  for (const tk of tokens) {
    if (tk.t === "point") past = true;
    else if (tk.t === "zero" || tk.t === "hash" || tk.t === "space") {
      if (past) decPlaceholders++;
      else intPlaceholders++;
    }
  }
  const mult = powi10(decPlaceholders);
  num = roundHalfAway(num * mult) / mult;
  const intPart = Math.floor(num);
  const fracPart = num - intPart;
  const intStr = intPart === 0 && intPlaceholders === 0 ? "" : u64Text(intPart);
  const fracStr = decPlaceholders > 0 ? u64Text(roundHalfAway(fracPart * mult)).padStart(decPlaceholders, "0") : "";

  const intDigits = Array.from(intStr);
  const fracDigits = Array.from(fracStr);
  let result = value < 0 && !hasExplicitNegative(tokens) ? "-" : "";
  let intIdx = intDigits.length - intPlaceholders;
  let fracIdx = 0;
  let pastPoint = false;
  let emittedOverflow = false;
  const flushOverflow = () => {
    if (!emittedOverflow && intIdx > 0) {
      for (let k = 0; k < intIdx; k++) result += intDigits[k];
    }
    emittedOverflow = true;
  };
  const restIsZeros = (from: number) => fracDigits.slice(from).every((c) => c === "0");
  for (const tk of tokens) {
    switch (tk.t) {
      case "zero":
        if (!pastPoint) {
          flushOverflow();
          result += intIdx >= 0 && intIdx < intDigits.length ? intDigits[intIdx] : "0";
          intIdx++;
        } else {
          result += fracIdx < fracDigits.length ? fracDigits[fracIdx] : "0";
          fracIdx++;
        }
        break;
      case "hash":
        if (!pastPoint) {
          flushOverflow();
          if (intIdx >= 0 && intIdx < intDigits.length) {
            const c = intDigits[intIdx];
            const leadingZero = c === "0" && intDigits.slice(0, intIdx).every((x) => x === "0");
            if (!leadingZero) result += c;
          }
          intIdx++;
        } else {
          if (fracIdx < fracDigits.length && !restIsZeros(fracIdx)) result += fracDigits[fracIdx];
          fracIdx++;
        }
        break;
      case "space":
        if (!pastPoint) {
          flushOverflow();
          result += intIdx >= 0 && intIdx < intDigits.length ? intDigits[intIdx] : " ";
          intIdx++;
        } else {
          if (fracIdx < fracDigits.length) result += restIsZeros(fracIdx) ? " " : fracDigits[fracIdx];
          else result += " ";
          fracIdx++;
        }
        break;
      case "point":
        pastPoint = true;
        result += locale.decimalSeparator;
        break;
      case "percent":
        result += "%";
        break;
      case "lit":
        result += tk.s;
        break;
      case "spaceWidth":
      case "fill":
        result += " ";
        break;
      case "slash":
        result += "/";
        break;
      default:
        break;
    }
  }
  if (hasGroupingComma(tokens)) result = insertGrouping(result, locale);
  return result;
}

// ---- dates -----------------------------------------------------------------

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  return [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** Mirrors `custom_format::serial_to_date` (Excel's 1900 leap-year fiction). */
function serialToYmd(serial: number): [number, number, number] | null {
  if (serial < 1) return null;
  let remaining = serial >= 60 ? serial - 1 : serial;
  let year = 1900;
  for (;;) {
    const len = isLeap(year) ? 366 : 365;
    if (remaining <= len) break;
    remaining -= len;
    year++;
  }
  for (let month = 1; month <= 12; month++) {
    const md = daysInMonth(year, month);
    if (remaining <= md) return [year, month, remaining];
    remaining -= md;
  }
  return null;
}

/** Mirrors `date_serial::date_to_serial` for a validated y/m/d. */
function ymdToSerial(year: number, month: number, day: number): number {
  const lotusLeap = (y: number) => y === 1900 || isLeap(y);
  let serial = 0;
  for (let y = 1900; y < year; y++) serial += lotusLeap(y) ? 366 : 365;
  const md = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  for (let m = 1; m < month; m++) {
    serial += md[m];
    if (m === 2 && lotusLeap(year)) serial += 1;
  }
  return serial + day;
}

function dayOfWeek(year: number, month: number, day: number): number {
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  const y = month < 3 ? year - 1 : year;
  return (y + Math.trunc(y / 4) - Math.trunc(y / 100) + Math.trunc(y / 400) + t[month - 1] + day) % 7;
}

function nameAt(list: readonly string[] | undefined, index: number): string {
  return list && index >= 0 && index < list.length ? list[index] : "???";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Mirrors `format_datetime_section` (without elapsed tokens). */
function renderDatetimeSection(value: number, section: Section, locale: LocaleSettings): string {
  const days = Math.floor(value);
  const fraction = Math.abs(value - Math.trunc(value));
  const totalSeconds = Math.round(fraction * 86400);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const [year, month, day] = (days >= 1 ? serialToYmd(days) : null) ?? [1900, 1, 1];
  const dow = dayOfWeek(year, month, day);
  const isPm = hours >= 12;
  const hours12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
  const hasAmPm = section.tokens.some((tk) => tk.t === "ampm");
  let out = "";
  for (const tk of section.tokens) {
    switch (tk.t) {
      case "y4":
        out += String(year).padStart(4, "0");
        break;
      case "y2":
        out += pad2(year % 100);
        break;
      case "m2":
        out += pad2(month);
        break;
      case "m1":
        out += String(month);
        break;
      case "mmm":
        out += nameAt(locale.monthNamesShort, month - 1);
        break;
      case "mmmm":
        out += nameAt(locale.monthNamesLong, month - 1);
        break;
      case "mmmmm":
        out += Array.from(nameAt(locale.monthNamesLong, month - 1))[0] ?? "";
        break;
      case "d2":
        out += pad2(day);
        break;
      case "d1":
        out += String(day);
        break;
      case "ddd":
        out += nameAt(locale.dayNamesShort, dow);
        break;
      case "dddd":
        out += nameAt(locale.dayNamesLong, dow);
        break;
      case "h2":
        out += pad2(hasAmPm ? hours12 : hours);
        break;
      case "h1":
        out += String(hasAmPm ? hours12 : hours);
        break;
      case "min2":
        out += pad2(minutes);
        break;
      case "min1":
        out += String(minutes);
        break;
      case "s2":
        out += pad2(seconds);
        break;
      case "s1":
        out += String(seconds);
        break;
      case "ampm":
        out += isPm ? "PM" : "AM";
        break;
      case "lit":
        out += tk.s;
        break;
      case "spaceWidth":
        out += " ";
        break;
      case "comma":
        out += ",";
        break;
      case "slash":
        out += "/";
        break;
      case "point":
        out += ".";
        break;
      default:
        break;
    }
  }
  return out;
}

const SECTION_CACHE = new Map<string, Section[]>();

function parsedCode(code: string): Section[] {
  let sections = SECTION_CACHE.get(code);
  if (!sections) {
    sections = splitSections(code).slice(0, 4).map(parseSection);
    if (SECTION_CACHE.size > 512) SECTION_CACHE.clear();
    SECTION_CACHE.set(code, sections);
  }
  return sections;
}

// ============================================================================
// Public: numbers
// ============================================================================

/**
 * Render `value` with an invariant (en-US syntax) format code, in `locale`.
 * "" and "General" are General. Outside the declared subset the text is
 * General and `exact` is false.
 */
export function formatNumberWithCodeIn(locale: LocaleSettings, value: number, code: string): CodeFormatResult {
  const trimmed = code.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "general") {
    return { text: formatGeneral(locale, value), exact: true };
  }
  if (!Number.isFinite(value)) return { text: formatGeneral(locale, value), exact: false };
  const sections = parsedCode(code);
  if (sections.some((s) => s.unsupported)) return { text: formatGeneral(locale, value), exact: false };
  const section = selectSection(sections, value);
  if (!sectionSupported(section)) return { text: formatGeneral(locale, value), exact: false };
  if (section.isDatetime) return { text: renderDatetimeSection(value, section, locale), exact: true };
  return { text: renderNumberSection(value, section, locale), exact: true };
}

/**
 * Render `value` in `locale`. With no options this is Excel's General (the
 * engine's `format_general`). With decimals it is the code `0.00` family:
 * half away from zero, the locale's separators, optional grouping and percent.
 */
export function formatNumberIn(locale: LocaleSettings, value: number, opts?: FormatNumberOptions): string {
  if (!Number.isFinite(value)) return formatGeneral(locale, value);
  const o = opts ?? {};
  let maxDecimals = o.decimals ?? o.maxDecimals;
  let minDecimals = o.decimals ?? o.minDecimals ?? (o.trimZeros ? 0 : maxDecimals);
  const scaled = o.percent ? value * 100 : value;
  if (maxDecimals === undefined || Math.abs(scaled) >= 1e15) {
    // General digits, with the requested grouping / percent.
    let text = formatGeneral(locale, scaled);
    if (o.grouping && !/E/.test(text)) {
      const neg = text.startsWith("-");
      const body = neg ? text.slice(1) : text;
      const sepAt = body.indexOf(locale.decimalSeparator);
      const intPart = sepAt >= 0 ? body.slice(0, sepAt) : body;
      text = (neg ? "-" : "") + groupDigits(intPart, locale.thousandsSeparator) + (sepAt >= 0 ? body.slice(sepAt) : "");
    }
    return o.percent ? text + "%" : text;
  }
  maxDecimals = Math.max(0, Math.min(30, Math.floor(maxDecimals)));
  minDecimals = Math.max(0, Math.min(maxDecimals, Math.floor(minDecimals ?? maxDecimals)));
  const code =
    (o.grouping ? "#,##0" : "0") +
    (maxDecimals > 0 ? "." + "0".repeat(minDecimals) + "#".repeat(maxDecimals - minDecimals) : "") +
    (o.percent ? "%" : "");
  let text = formatNumberWithCodeIn(locale, value, code).text;
  // "0.##" of 3 renders "3," -- a dangling separator is not a number.
  if (minDecimals === 0 && text.endsWith(locale.decimalSeparator)) text = text.slice(0, -locale.decimalSeparator.length);
  else if (minDecimals === 0 && o.percent && text.endsWith(locale.decimalSeparator + "%")) {
    text = text.slice(0, -(locale.decimalSeparator.length + 1)) + "%";
  }
  // A value that rounds to zero is not negative on screen.
  if (text.startsWith("-") && !/[1-9]/.test(text)) text = text.slice(1);
  return text;
}

// ============================================================================
// Public: parsing (mirrors number_text::parse with ParsePolicy::ENTRY)
// ============================================================================

const SPACE_GROUP = [" ", " ", " ", " "];

function isGroupChar(ch: string, locale: LocaleSettings): boolean {
  if (SPACE_GROUP.includes(locale.thousandsSeparator)) return SPACE_GROUP.includes(ch);
  return ch === locale.thousandsSeparator;
}

function isWhite(ch: string): boolean {
  return /\s/.test(ch);
}

/** The engine's typed-entry number parse: percent yes, currency and dates no. */
function parseEntryNumber(locale: LocaleSettings, text: string): number | null {
  const s = text.trim();
  if (!s) return null;
  const chars = Array.from(s);
  const n = chars.length;
  let i = 0;
  let negative = false;
  let seenSign = false;
  let percents = 0;
  for (;;) {
    if (i >= n) return null;
    const c = chars[i];
    if ((c === "+" || c === "-") && !seenSign) {
      negative = c === "-";
      seenSign = true;
      i++;
    } else if (c === "%") {
      percents++;
      i++;
    } else if (isWhite(c) && (seenSign || percents > 0)) {
      i++;
    } else {
      break;
    }
  }
  let intDigits = "";
  const groups: number[] = [0];
  while (i < n) {
    const c = chars[i];
    if (isAsciiDigit(c)) {
      intDigits += c;
      groups[groups.length - 1]++;
      i++;
    } else if (isGroupChar(c, locale) && i + 1 < n && isAsciiDigit(chars[i + 1])) {
      groups.push(0);
      i++;
    } else {
      break;
    }
  }
  if (groups.length > 1 && (groups[0] === 0 || groups[0] > 3 || groups.slice(1).some((g) => g !== 3))) {
    return null;
  }
  let fracDigits = "";
  if (i < n && chars[i] === locale.decimalSeparator) {
    i++;
    while (i < n && isAsciiDigit(chars[i])) {
      fracDigits += chars[i];
      i++;
    }
  }
  if (!intDigits && !fracDigits) return null;
  let exponent = "";
  if (i < n && (chars[i] === "e" || chars[i] === "E")) {
    let j = i + 1;
    let exp = "";
    if (j < n && (chars[j] === "+" || chars[j] === "-")) {
      exp += chars[j];
      j++;
    }
    const startDigits = j;
    while (j < n && isAsciiDigit(chars[j])) {
      exp += chars[j];
      j++;
    }
    if (j > startDigits) {
      exponent = exp;
      i = j;
    }
  }
  while (i < n) {
    const c = chars[i];
    if (c === "%") {
      percents++;
      i++;
    } else if (isWhite(c)) {
      i++;
    } else {
      return null;
    }
  }
  let normalized = (negative ? "-" : "") + (intDigits || "0");
  if (fracDigits) normalized += "." + fracDigits;
  if (exponent) normalized += "e" + exponent;
  let result = Number(normalized);
  for (let k = 0; k < percents; k++) result /= 100;
  return Number.isFinite(result) ? result : null;
}

/**
 * Read text a user typed as a number, STRICTLY in `locale`: its grouping (in
 * correctly sized groups; a plain space is accepted where the locale groups
 * with U+00A0), its decimal separator, a leading or trailing minus, percent
 * signs, and the locale's own currency symbol before or after. The foreign
 * spelling is refused ("1.5" in sv-SE is null), as Excel refuses it.
 */
export function parseNumberIn(locale: LocaleSettings, text: string): number | null {
  const direct = parseEntryNumber(locale, text);
  if (direct !== null) return direct;
  let body = text.trim();
  if (!body) return null;
  let trailingMinus = false;
  if (body.endsWith("-") && !body.startsWith("-") && !body.startsWith("+")) {
    trailingMinus = true;
    body = body.slice(0, -1).trimEnd();
  }
  const symbol = locale.currencySymbol.trim();
  if (symbol) {
    const lower = body.toLowerCase();
    const sym = symbol.toLowerCase();
    let sign = "";
    let rest = body;
    let restLower = lower;
    if (rest.startsWith("-") || rest.startsWith("+")) {
      sign = rest[0];
      rest = rest.slice(1).trimStart();
      restLower = rest.toLowerCase();
    }
    if (restLower.startsWith(sym)) {
      body = sign + rest.slice(symbol.length).trim();
    } else if (lower.endsWith(sym)) {
      body = body.slice(0, body.length - symbol.length).trim();
    }
  }
  const parsed = parseEntryNumber(locale, body);
  if (parsed === null) return null;
  if (trailingMinus) {
    if (/^[+-]/.test(body)) return null;
    return -parsed;
  }
  return parsed;
}

// ---- dates (mirrors typed_entry::parse_date_time_input) ---------------------

function twoDigit(text: string): number | null {
  if (!text || text.length > 2 || !/^[0-9]+$/.test(text)) return null;
  return Number(text);
}

function yearComponent(text: string): number | null {
  if (!/^[0-9]*$/.test(text)) return null;
  if (text.length === 4) return Number(text);
  if (text.length === 2) {
    const yy = Number(text);
    return yy <= 29 ? 2000 + yy : 1900 + yy;
  }
  return null;
}

function validYmd(year: number, month: number, day: number): boolean {
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  if (year === 1900 && month === 2 && day === 29) return true;
  return day <= daysInMonth(year, month);
}

function shortDateOrder(locale: LocaleSettings): "ymd" | "dmy" | "mdy" {
  const p = locale.dateFormat.toUpperCase();
  const y = p.indexOf("Y");
  const m = p.indexOf("M");
  const d = p.indexOf("D");
  if (y < 0 || m < 0 || d < 0) return "ymd";
  if (y < m && y < d) return "ymd";
  if (d < m) return "dmy";
  return "mdy";
}

function splitDateAndTime(text: string): [string | null, string | null] {
  const colon = text.indexOf(":");
  if (colon < 0) return [text, null];
  const head = text.slice(0, colon);
  for (let i = head.length - 1; i >= 0; i--) {
    const c = head[i];
    const prev = i > 0 ? head[i - 1] : "";
    if (isWhite(c) || ((c === "T" || c === "t") && isAsciiDigit(prev))) {
      const date = text.slice(0, i).trim();
      const time = text.slice(i + 1).trim();
      return date ? [date, time] : [null, time];
    }
  }
  return [null, text];
}

function parseNumericDate(text: string, locale: LocaleSettings): [number, number, number] | null {
  const seps = ["-", "/", "."];
  const separator = Array.from(text).find((c) => seps.includes(c));
  if (!separator) return null;
  if (Array.from(text).some((c) => seps.includes(c) && c !== separator)) return null;
  const parts = text.split(separator);
  if (parts.length !== 3) return null;
  if (parts.some((p) => !p || !/^[0-9]+$/.test(p))) return null;
  let yearText: string;
  let monthText: string;
  let dayText: string;
  if (parts[0].length === 4) {
    [yearText, monthText, dayText] = parts;
  } else {
    const order = shortDateOrder(locale);
    if (order === "mdy") [monthText, dayText, yearText] = parts;
    else if (order === "dmy") [dayText, monthText, yearText] = parts;
    else return null;
  }
  const year = yearComponent(yearText);
  const month = twoDigit(monthText);
  const day = twoDigit(dayText);
  if (year === null || month === null || day === null || !validYmd(year, month, day)) return null;
  return [year, month, day];
}

function monthIndex(locale: LocaleSettings, token: string): number | null {
  const needle = token.replace(/\.+$/, "").toLowerCase();
  if (!needle) return null;
  for (let m = 0; m < 12; m++) {
    for (const name of [locale.monthNamesLong?.[m], locale.monthNamesShort?.[m]]) {
      if (name && name.replace(/\.+$/, "").toLowerCase() === needle) return m + 1;
    }
  }
  return null;
}

function parseMonthNameDate(text: string, locale: LocaleSettings): [number, number, number] | null {
  const tokens = text.split(/[\s,.\-/]+/).filter((t) => t.length > 0);
  if (tokens.length !== 3) return null;
  const at = tokens.findIndex((t) => monthIndex(locale, t) !== null);
  if (at < 0) return null;
  const month = monthIndex(locale, tokens[at]) as number;
  let dayText: string;
  let yearText: string;
  if (at === 0) [dayText, yearText] = [tokens[1], tokens[2]];
  else if (at === 1) [dayText, yearText] = [tokens[0], tokens[2]];
  else return null;
  const day = twoDigit(dayText);
  const year = yearComponent(yearText);
  if (day === null || year === null || !validYmd(year, month, day)) return null;
  return [year, month, day];
}

function parseClockTime(text: string, locale: LocaleSettings): number | null {
  const upper = text.toUpperCase().trim();
  const hasMeridiem = locale.timeFormat.toUpperCase().includes("AM/PM");
  let body = upper;
  let pm: boolean | null = null;
  if (upper.endsWith("PM")) {
    body = upper.slice(0, -2).trimEnd();
    pm = true;
  } else if (upper.endsWith("AM")) {
    body = upper.slice(0, -2).trimEnd();
    pm = false;
  }
  if (pm !== null && !hasMeridiem) return null;
  const parts = body.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const hourTyped = twoDigit(parts[0]);
  const minute = twoDigit(parts[1]);
  const second = parts.length === 3 ? twoDigit(parts[2]) : 0;
  if (hourTyped === null || minute === null || second === null) return null;
  if (minute > 59 || second > 59) return null;
  let hour: number;
  if (pm === true) {
    if (hourTyped === 12) hour = 12;
    else if (hourTyped >= 1 && hourTyped <= 11) hour = hourTyped + 12;
    else return null;
  } else if (pm === false) {
    if (hourTyped === 12) hour = 0;
    else if (hourTyped >= 1 && hourTyped <= 11) hour = hourTyped;
    else return null;
  } else {
    if (hourTyped > 23) return null;
    hour = hourTyped;
  }
  return (hour * 3600 + minute * 60 + second) / 86400;
}

/**
 * Read a typed date, time, or date and time in `locale` as an Excel serial:
 * ISO year-first, the locale's short-date order, the locale's month names, a
 * 24-hour (or, where the locale has one, AM/PM) clock. A date with no year, an
 * impossible calendar day or a foreign order is null -- a wrong date is worse
 * than no date.
 */
export function parseDateIn(locale: LocaleSettings, text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const [dateText, timeText] = splitDateAndTime(trimmed);
  let date: [number, number, number] | null = null;
  if (dateText !== null) {
    date = parseNumericDate(dateText, locale) ?? parseMonthNameDate(dateText, locale);
    if (!date) return null;
  }
  let time: number | null = null;
  if (timeText !== null) {
    time = parseClockTime(timeText, locale);
    if (time === null) return null;
  }
  if (date && time !== null) return ymdToSerial(date[0], date[1], date[2]) + time;
  if (date) return ymdToSerial(date[0], date[1], date[2]);
  if (time !== null) return time;
  return null;
}

// ============================================================================
// Public: dates and calendar names
// ============================================================================

/** A JS Date as an Excel serial, read in its LOCAL wall time. */
export function dateToSerial(date: Date): number {
  const days = ymdToSerial(date.getFullYear(), date.getMonth() + 1, date.getDate());
  const seconds = date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds() + date.getMilliseconds() / 1000;
  return days + seconds / 86400;
}

/** The locale's pattern for a date style (invariant code syntax). */
export function datePatternFor(locale: LocaleSettings, style: DateStyle): string {
  switch (style) {
    case "long":
      return locale.longDateFormat;
    case "time":
      return locale.timeFormat;
    case "dateTime":
      return locale.dateFormat + " " + locale.timeFormat;
    case "short":
    default:
      return locale.dateFormat;
  }
}

/** Render an Excel serial (or a JS Date, in its local time) in `locale`. */
export function formatDateIn(locale: LocaleSettings, serialOrDate: number | Date, style: DateStyle = "short"): string {
  const serial = typeof serialOrDate === "number" ? serialOrDate : dateToSerial(serialOrDate);
  if (!Number.isFinite(serial)) return "";
  return formatNumberWithCodeIn(locale, serial, datePatternFor(locale, style)).text;
}

/** Month name for a 1-based month; "???" out of range, as in the engine. */
export function monthNameIn(locale: LocaleSettings, month1: number, form: "short" | "long" = "long"): string {
  return nameAt(form === "short" ? locale.monthNamesShort : locale.monthNamesLong, month1 - 1);
}

/** Weekday name, 0 = Sunday; "???" out of range. */
export function dayNameIn(locale: LocaleSettings, dow0: number, form: "short" | "long" = "long"): string {
  return nameAt(form === "short" ? locale.dayNamesShort : locale.dayNamesLong, dow0);
}

/** Quarter label for 1..4 ("Q3", "Kv3", "T3"); "???" out of range. */
export function quarterLabelIn(locale: LocaleSettings, quarter: number): string {
  return nameAt(locale.quarterLabels, quarter - 1);
}
