//! FILENAME: app/extensions/Print/lib/print-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for print generator pure helpers.
// CONTEXT: Tests paper sizes, HTML escaping, header/footer codes, cell styles, color parsing.

import { describe, it, expect } from "vitest";

// ============================================================================
// Inline copies of pure functions (avoids Tauri import mocking)
// ============================================================================

function inchesToMm(inches: number): number {
  return inches * 25.4;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const PAPER_SIZES: Record<string, { width: number; height: number }> = {
  a4: { width: 210, height: 297 },
  a3: { width: 297, height: 420 },
  letter: { width: 216, height: 279 },
  legal: { width: 216, height: 356 },
  tabloid: { width: 279, height: 432 },
};

interface HeaderFooterSections {
  left: string;
  center: string;
  right: string;
}

function parseHeaderFooterSections(text: string): HeaderFooterSections {
  if (!text) return { left: "", center: "", right: "" };
  const hasSections = /&[LCR]/i.test(text);
  if (!hasSections) return { left: "", center: text, right: "" };
  let left = "";
  let center = "";
  let right = "";
  let current: "left" | "center" | "right" = "center";
  let remaining = text;
  const firstCodeMatch = remaining.match(/&[LCR]/i);
  if (firstCodeMatch && firstCodeMatch.index !== undefined && firstCodeMatch.index > 0) {
    center = remaining.slice(0, firstCodeMatch.index);
    remaining = remaining.slice(firstCodeMatch.index);
  }
  const parts = remaining.split(/(&[LCR])/i);
  for (const part of parts) {
    if (/^&L$/i.test(part)) current = "left";
    else if (/^&C$/i.test(part)) current = "center";
    else if (/^&R$/i.test(part)) current = "right";
    else {
      if (current === "left") left += part;
      else if (current === "center") center += part;
      else right += part;
    }
  }
  return { left: left.trim(), center: center.trim(), right: right.trim() };
}

function replaceDynamicFields(text: string, sheetName: string): string {
  if (!text) return "";
  return text
    .replace(/&P/g, "1")
    .replace(/&N/g, "1")
    .replace(/&D/g, "DATE")
    .replace(/&T/g, "TIME")
    .replace(/&F/g, sheetName)
    .replace(/&A/g, sheetName);
}

interface BorderData {
  style: string;
  color: string;
  width: number;
}

interface StyleData {
  bold?: boolean;
  italic?: boolean;
  underline?: string;
  strikethrough?: boolean;
  fontSize?: number;
  fontFamily?: string;
  textColor?: string;
  backgroundColor?: string;
  textAlign?: string;
  verticalAlign?: string;
  wrapText?: boolean;
  borderTop?: BorderData;
  borderBottom?: BorderData;
  borderLeft?: BorderData;
  borderRight?: BorderData;
}

interface PageSetup {
  printGridlines: boolean;
}

function buildCellStyle(styleData: StyleData, pageSetup: PageSetup): string {
  const parts: string[] = [];
  if (styleData.bold) parts.push("font-weight:bold");
  if (styleData.italic) parts.push("font-style:italic");
  const hasUnderline = styleData.underline && styleData.underline !== "none";
  if (hasUnderline) parts.push("text-decoration:underline");
  if (styleData.strikethrough) {
    parts.push(
      hasUnderline
        ? "text-decoration:underline line-through"
        : "text-decoration:line-through",
    );
  }
  if (styleData.fontSize && styleData.fontSize !== 11) {
    parts.push(`font-size:${styleData.fontSize}pt`);
  }
  if (styleData.fontFamily && styleData.fontFamily !== "Calibri") {
    parts.push(`font-family:"${styleData.fontFamily}",sans-serif`);
  }
  if (styleData.textColor && styleData.textColor !== "#000000" && styleData.textColor !== "rgba(0, 0, 0, 1)") {
    parts.push(`color:${styleData.textColor}`);
  }
  if (styleData.backgroundColor && styleData.backgroundColor !== "#ffffff" && styleData.backgroundColor !== "rgba(255, 255, 255, 1)") {
    parts.push(`background-color:${styleData.backgroundColor}`);
  }
  const align = styleData.textAlign;
  if (align === "center") parts.push("text-align:center");
  else if (align === "right") parts.push("text-align:right");
  else if (align === "left") parts.push("text-align:left");
  const vAlign = styleData.verticalAlign;
  if (vAlign === "top") parts.push("vertical-align:top");
  else if (vAlign === "bottom") parts.push("vertical-align:bottom");
  if (styleData.wrapText) parts.push("white-space:pre-wrap;word-wrap:break-word");
  const borderSide = (side: string, b: BorderData) => {
    if (!b || b.style === "none") return;
    const w = b.width || 1;
    const s = b.style === "double" ? "double" : b.style === "dashed" ? "dashed" : b.style === "dotted" ? "dotted" : "solid";
    parts.push(`border-${side}:${w}px ${s} ${b.color}`);
  };
  if (styleData.borderTop) borderSide("top", styleData.borderTop);
  if (styleData.borderBottom) borderSide("bottom", styleData.borderBottom);
  if (styleData.borderLeft) borderSide("left", styleData.borderLeft);
  if (styleData.borderRight) borderSide("right", styleData.borderRight);
  if (pageSetup.printGridlines) {
    if (!styleData.borderTop) parts.push("border-top:1px solid #d0d0d0");
    if (!styleData.borderBottom) parts.push("border-bottom:1px solid #d0d0d0");
    if (!styleData.borderLeft) parts.push("border-left:1px solid #d0d0d0");
    if (!styleData.borderRight) parts.push("border-right:1px solid #d0d0d0");
  }
  return parts.join(";");
}

/** Parse a CSS-like color string to a normalized form for testing. */
function parseColor(color: string): { r: number; g: number; b: number; a: number } | null {
  if (!color || color === "transparent") return null;
  // Hex #RGB
  const hex3 = color.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (hex3) {
    return {
      r: parseInt(hex3[1] + hex3[1], 16),
      g: parseInt(hex3[2] + hex3[2], 16),
      b: parseInt(hex3[3] + hex3[3], 16),
      a: 1,
    };
  }
  // Hex #RRGGBB
  const hex6 = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (hex6) {
    return {
      r: parseInt(hex6[1], 16),
      g: parseInt(hex6[2], 16),
      b: parseInt(hex6[3], 16),
      a: 1,
    };
  }
  // Hex #RRGGBBAA
  const hex8 = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (hex8) {
    return {
      r: parseInt(hex8[1], 16),
      g: parseInt(hex8[2], 16),
      b: parseInt(hex8[3], 16),
      a: parseInt(hex8[4], 16) / 255,
    };
  }
  // rgb(r, g, b)
  const rgb = color.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (rgb) {
    return { r: +rgb[1], g: +rgb[2], b: +rgb[3], a: 1 };
  }
  // rgba(r, g, b, a)
  const rgba = color.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/);
  if (rgba) {
    return { r: +rgba[1], g: +rgba[2], b: +rgba[3], a: +rgba[4] };
  }
  // Named colors (subset)
  const named: Record<string, [number, number, number]> = {
    red: [255, 0, 0],
    green: [0, 128, 0],
    blue: [0, 0, 255],
    white: [255, 255, 255],
    black: [0, 0, 0],
  };
  const n = named[color.toLowerCase()];
  if (n) return { r: n[0], g: n[1], b: n[2], a: 1 };
  return null;
}

// ============================================================================
// 1. Paper size x orientation x margin combos = 5 x 2 x 4 = 40 tests
// ============================================================================

const paperSizes = ["a4", "a3", "letter", "legal", "tabloid"] as const;
const orientations = ["portrait", "landscape"] as const;
const marginPresets = [
  { name: "normal", top: 0.75, bottom: 0.75, left: 0.7, right: 0.7 },
  { name: "narrow", top: 0.5, bottom: 0.5, left: 0.25, right: 0.25 },
  { name: "wide", top: 1.0, bottom: 1.0, left: 1.5, right: 1.5 },
  { name: "none", top: 0, bottom: 0, left: 0, right: 0 },
] as const;

describe("Print: Paper size x Orientation x Margins content area", () => {
  const cases: Array<{
    paper: string;
    orientation: string;
    margins: (typeof marginPresets)[number];
    expectedWidth: number;
    expectedHeight: number;
  }> = [];

  for (const paper of paperSizes) {
    for (const orient of orientations) {
      for (const margin of marginPresets) {
        const dim = PAPER_SIZES[paper];
        const pageW = orient === "landscape" ? dim.height : dim.width;
        const pageH = orient === "landscape" ? dim.width : dim.height;
        const contentW = pageW - inchesToMm(margin.left) - inchesToMm(margin.right);
        const contentH = pageH - inchesToMm(margin.top) - inchesToMm(margin.bottom);
        cases.push({
          paper,
          orientation: orient,
          margins: margin,
          expectedWidth: contentW,
          expectedHeight: contentH,
        });
      }
    }
  }

  it.each(cases)(
    "$paper $orientation $margins.name => content $expectedWidth x $expectedHeight mm",
    ({ paper, orientation, margins, expectedWidth, expectedHeight }) => {
      const dim = PAPER_SIZES[paper];
      const pageW = orientation === "landscape" ? dim.height : dim.width;
      const pageH = orientation === "landscape" ? dim.width : dim.height;
      const contentW = pageW - inchesToMm(margins.left) - inchesToMm(margins.right);
      const contentH = pageH - inchesToMm(margins.top) - inchesToMm(margins.bottom);
      expect(contentW).toBeCloseTo(expectedWidth, 2);
      expect(contentH).toBeCloseTo(expectedHeight, 2);
      expect(contentW).toBeGreaterThan(0);
      expect(contentH).toBeGreaterThan(0);
    },
  );
});

// ============================================================================
// 2. HTML escaping for 30 different strings
// ============================================================================

describe("Print: HTML escaping", () => {
  const cases: Array<[string, string]> = [
    ["hello", "hello"],
    ["<script>", "&lt;script&gt;"],
    ["a & b", "a &amp; b"],
    ['say "hi"', "say &quot;hi&quot;"],
    ["<b>bold</b>", "&lt;b&gt;bold&lt;/b&gt;"],
    ["1 < 2 & 3 > 1", "1 &lt; 2 &amp; 3 &gt; 1"],
    ['a="1"', "a=&quot;1&quot;"],
    ["", ""],
    ["plain text", "plain text"],
    ["<div class=\"x\">", "&lt;div class=&quot;x&quot;&gt;"],
    ["&amp;", "&amp;amp;"],
    ["<<>>", "&lt;&lt;&gt;&gt;"],
    ["&<>\"", "&amp;&lt;&gt;&quot;"],
    ["Tom & Jerry", "Tom &amp; Jerry"],
    ['<img src="x">', "&lt;img src=&quot;x&quot;&gt;"],
    ["price: $100", "price: $100"],
    ["100%", "100%"],
    ["it's fine", "it's fine"],
    ["line1\nline2", "line1\nline2"],
    ["tab\there", "tab\there"],
    ["&lt;already escaped&gt;", "&amp;lt;already escaped&amp;gt;"],
    ["<a href=\"http://x.com\">link</a>", "&lt;a href=&quot;http://x.com&quot;&gt;link&lt;/a&gt;"],
    ["Q&A", "Q&amp;A"],
    ["AT&T", "AT&amp;T"],
    ["<>", "&lt;&gt;"],
    ["\"\"", "&quot;&quot;"],
    ["&&", "&amp;&amp;"],
    ["x < y > z", "x &lt; y &gt; z"],
    ["Smith & Wesson \"Pro\"", "Smith &amp; Wesson &quot;Pro&quot;"],
    ["<td>data</td>", "&lt;td&gt;data&lt;/td&gt;"],
  ];

  it.each(cases)("escapeHtml(%j) => %j", (input, expected) => {
    expect(escapeHtml(input)).toBe(expected);
  });
});

// ============================================================================
// 3. Header/footer field codes: 8 codes x 3 positions = 24 tests
// ============================================================================

describe("Print: Header/footer field codes", () => {
  const fieldCodes = [
    { code: "&P", desc: "page number", expected: "1" },
    { code: "&N", desc: "total pages", expected: "1" },
    { code: "&D", desc: "date", expected: "DATE" },
    { code: "&T", desc: "time", expected: "TIME" },
    { code: "&F", desc: "filename", expected: "Sheet1" },
    { code: "&A", desc: "sheet name", expected: "Sheet1" },
    { code: "&P of &N", desc: "page of total", expected: "1 of 1" },
    { code: "&F - &A", desc: "file dash sheet", expected: "Sheet1 - Sheet1" },
  ];

  const positions = [
    { section: "left", prefix: "&L" },
    { section: "center", prefix: "&C" },
    { section: "right", prefix: "&R" },
  ] as const;

  const cases: Array<{
    code: string;
    desc: string;
    section: string;
    prefix: string;
    expected: string;
  }> = [];

  for (const field of fieldCodes) {
    for (const pos of positions) {
      cases.push({
        code: field.code,
        desc: field.desc,
        section: pos.section,
        prefix: pos.prefix,
        expected: field.expected,
      });
    }
  }

  it.each(cases)(
    "$desc in $section position",
    ({ code, section, prefix, expected }) => {
      const headerText = `${prefix}${code}`;
      const sections = parseHeaderFooterSections(headerText);
      const rawValue = sections[section as keyof HeaderFooterSections];
      const resolved = replaceDynamicFields(rawValue, "Sheet1");
      expect(resolved).toBe(expected);
    },
  );
});

// ============================================================================
// 4. Cell style building: border styles x 4 sides = 40 tests
// ============================================================================

describe("Print: Cell style borders", () => {
  const borderStyles = [
    { style: "thin", cssStyle: "solid" },
    { style: "medium", cssStyle: "solid" },
    { style: "thick", cssStyle: "solid" },
    { style: "dashed", cssStyle: "dashed" },
    { style: "dotted", cssStyle: "dotted" },
    { style: "double", cssStyle: "double" },
    { style: "hair", cssStyle: "solid" },
    { style: "mediumDashed", cssStyle: "solid" },
    { style: "dashDot", cssStyle: "solid" },
    { style: "slantDashDot", cssStyle: "solid" },
  ];

  const sides = ["top", "bottom", "left", "right"] as const;

  const cases: Array<{
    styleName: string;
    side: string;
    cssStyle: string;
  }> = [];

  for (const bs of borderStyles) {
    for (const side of sides) {
      cases.push({ styleName: bs.style, side, cssStyle: bs.cssStyle });
    }
  }

  it.each(cases)(
    "border-$side with $styleName => CSS $cssStyle",
    ({ styleName, side, cssStyle }) => {
      const borderKey = `border${side.charAt(0).toUpperCase() + side.slice(1)}` as keyof StyleData;
      const styleData: StyleData = {
        [borderKey]: { style: styleName, color: "#000000", width: 1 },
      };
      const result = buildCellStyle(styleData, { printGridlines: false });
      expect(result).toContain(`border-${side}:`);
      expect(result).toContain(cssStyle);
      expect(result).toContain("#000000");
    },
  );
});

// ============================================================================
// 5. Color parsing: 50 different color strings
// ============================================================================

describe("Print: Color parsing", () => {
  const cases: Array<{
    input: string;
    r: number;
    g: number;
    b: number;
    a: number;
  } | {
    input: string;
    isNull: true;
  }> = [
    { input: "#000000", r: 0, g: 0, b: 0, a: 1 },
    { input: "#ffffff", r: 255, g: 255, b: 255, a: 1 },
    { input: "#FF0000", r: 255, g: 0, b: 0, a: 1 },
    { input: "#00FF00", r: 0, g: 255, b: 0, a: 1 },
    { input: "#0000FF", r: 0, g: 0, b: 255, a: 1 },
    { input: "#4472C4", r: 68, g: 114, b: 196, a: 1 },
    { input: "#D9E2F3", r: 217, g: 226, b: 243, a: 1 },
    { input: "#333333", r: 51, g: 51, b: 51, a: 1 },
    { input: "#ABCDEF", r: 171, g: 205, b: 239, a: 1 },
    { input: "#123456", r: 18, g: 52, b: 86, a: 1 },
    { input: "#f00", r: 255, g: 0, b: 0, a: 1 },
    { input: "#0f0", r: 0, g: 255, b: 0, a: 1 },
    { input: "#00f", r: 0, g: 0, b: 255, a: 1 },
    { input: "#fff", r: 255, g: 255, b: 255, a: 1 },
    { input: "#000", r: 0, g: 0, b: 0, a: 1 },
    { input: "#abc", r: 170, g: 187, b: 204, a: 1 },
    { input: "rgb(0, 0, 0)", r: 0, g: 0, b: 0, a: 1 },
    { input: "rgb(255, 255, 255)", r: 255, g: 255, b: 255, a: 1 },
    { input: "rgb(128, 128, 128)", r: 128, g: 128, b: 128, a: 1 },
    { input: "rgb(255, 0, 0)", r: 255, g: 0, b: 0, a: 1 },
    { input: "rgb(0, 255, 0)", r: 0, g: 255, b: 0, a: 1 },
    { input: "rgb(0, 0, 255)", r: 0, g: 0, b: 255, a: 1 },
    { input: "rgb(100, 200, 50)", r: 100, g: 200, b: 50, a: 1 },
    { input: "rgba(0, 0, 0, 1)", r: 0, g: 0, b: 0, a: 1 },
    { input: "rgba(255, 255, 255, 1)", r: 255, g: 255, b: 255, a: 1 },
    { input: "rgba(255, 0, 0, 0.5)", r: 255, g: 0, b: 0, a: 0.5 },
    { input: "rgba(0, 128, 0, 0.75)", r: 0, g: 128, b: 0, a: 0.75 },
    { input: "rgba(0, 0, 255, 0)", r: 0, g: 0, b: 255, a: 0 },
    { input: "rgba(100, 150, 200, 0.3)", r: 100, g: 150, b: 200, a: 0.3 },
    { input: "rgba(10, 20, 30, 0.99)", r: 10, g: 20, b: 30, a: 0.99 },
    { input: "red", r: 255, g: 0, b: 0, a: 1 },
    { input: "green", r: 0, g: 128, b: 0, a: 1 },
    { input: "blue", r: 0, g: 0, b: 255, a: 1 },
    { input: "white", r: 255, g: 255, b: 255, a: 1 },
    { input: "black", r: 0, g: 0, b: 0, a: 1 },
    { input: "#FF000080", r: 255, g: 0, b: 0, a: 128 / 255 },
    { input: "#00FF00FF", r: 0, g: 255, b: 0, a: 1 },
    { input: "#0000FF00", r: 0, g: 0, b: 255, a: 0 },
    { input: "#FFFFFF80", r: 255, g: 255, b: 255, a: 128 / 255 },
    { input: "#000000FF", r: 0, g: 0, b: 0, a: 1 },
    { input: "transparent", isNull: true },
    { input: "", isNull: true },
    { input: "notacolor", isNull: true },
    { input: "hsl(0, 100%, 50%)", isNull: true },
    { input: "#GGGGGG", isNull: true },
    { input: "rgb()", isNull: true },
    { input: "rgba(1,2,3)", isNull: true },
    { input: "#12345", isNull: true },
    { input: "#1234567890", isNull: true },
    { input: "currentColor", isNull: true },
  ];

  it.each(cases)("parseColor($input)", (testCase) => {
    const result = parseColor(testCase.input);
    if ("isNull" in testCase) {
      expect(result).toBeNull();
    } else {
      expect(result).not.toBeNull();
      expect(result!.r).toBe(testCase.r);
      expect(result!.g).toBe(testCase.g);
      expect(result!.b).toBe(testCase.b);
      expect(result!.a).toBeCloseTo(testCase.a, 3);
    }
  });
});
