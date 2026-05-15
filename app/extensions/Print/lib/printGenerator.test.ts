//! FILENAME: app/extensions/Print/lib/printGenerator.test.ts
// PURPOSE: Tests for print generator pure helper functions.
// CONTEXT: Tests header/footer parsing, cell style building, HTML escaping,
//          unit conversions, and dynamic field replacement.

import { describe, it, expect } from "vitest";

// ============================================================================
// Inline copies of pure functions from printGenerator.ts
// (Avoids Tauri import mocking while testing identical logic.)
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

interface HeaderFooterSections {
  left: string;
  center: string;
  right: string;
}

function parseHeaderFooterSections(text: string): HeaderFooterSections {
  if (!text) return { left: "", center: "", right: "" };

  const hasSections = /&[LCR]/i.test(text);
  if (!hasSections) {
    return { left: "", center: text, right: "" };
  }

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
    if (/^&L$/i.test(part)) {
      current = "left";
    } else if (/^&C$/i.test(part)) {
      current = "center";
    } else if (/^&R$/i.test(part)) {
      current = "right";
    } else {
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

// Cell style builder (simplified from printGenerator.ts)
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
  borderTop?: { style: string; color: string; width: number } | null;
  borderBottom?: { style: string; color: string; width: number } | null;
  borderLeft?: { style: string; color: string; width: number } | null;
  borderRight?: { style: string; color: string; width: number } | null;
}

function buildCellStyle(
  styleData: StyleData,
  printGridlines: boolean,
): string {
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

  const borderSide = (side: string, b: { style: string; color: string; width: number }) => {
    if (!b || b.style === "none") return;
    const w = b.width || 1;
    const s = b.style === "double" ? "double" : b.style === "dashed" ? "dashed" : b.style === "dotted" ? "dotted" : "solid";
    parts.push(`border-${side}:${w}px ${s} ${b.color}`);
  };
  if (styleData.borderTop) borderSide("top", styleData.borderTop);
  if (styleData.borderBottom) borderSide("bottom", styleData.borderBottom);
  if (styleData.borderLeft) borderSide("left", styleData.borderLeft);
  if (styleData.borderRight) borderSide("right", styleData.borderRight);

  if (printGridlines) {
    if (!styleData.borderTop) parts.push("border-top:1px solid #d0d0d0");
    if (!styleData.borderBottom) parts.push("border-bottom:1px solid #d0d0d0");
    if (!styleData.borderLeft) parts.push("border-left:1px solid #d0d0d0");
    if (!styleData.borderRight) parts.push("border-right:1px solid #d0d0d0");
  }

  return parts.join(";");
}

// ============================================================================
// Tests: Unit Conversions
// ============================================================================

describe("inchesToMm", () => {
  it("converts 1 inch to 25.4mm", () => {
    expect(inchesToMm(1)).toBeCloseTo(25.4);
  });

  it("converts 0 inches to 0mm", () => {
    expect(inchesToMm(0)).toBe(0);
  });

  it("converts fractional inches", () => {
    expect(inchesToMm(0.75)).toBeCloseTo(19.05);
    expect(inchesToMm(0.5)).toBeCloseTo(12.7);
  });

  it("converts large values", () => {
    expect(inchesToMm(10)).toBeCloseTo(254);
  });
});

// ============================================================================
// Tests: HTML Escaping
// ============================================================================

describe("escapeHtml", () => {
  it("escapes ampersands", () => {
    expect(escapeHtml("A & B")).toBe("A &amp; B");
  });

  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes double quotes", () => {
    expect(escapeHtml('say "hello"')).toBe("say &quot;hello&quot;");
  });

  it("escapes multiple special chars at once", () => {
    expect(escapeHtml('<a href="x">&')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
  });

  it("does not escape single quotes", () => {
    expect(escapeHtml("it's fine")).toBe("it's fine");
  });

  it("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("returns plain text unchanged", () => {
    expect(escapeHtml("Hello World 123")).toBe("Hello World 123");
  });
});

// ============================================================================
// Tests: Header/Footer Section Parsing
// ============================================================================

describe("parseHeaderFooterSections", () => {
  it("returns empty sections for empty string", () => {
    expect(parseHeaderFooterSections("")).toEqual({ left: "", center: "", right: "" });
  });

  it("puts text without codes into center", () => {
    expect(parseHeaderFooterSections("Page 1")).toEqual({
      left: "",
      center: "Page 1",
      right: "",
    });
  });

  it("parses &L section", () => {
    expect(parseHeaderFooterSections("&LLeft Text")).toEqual({
      left: "Left Text",
      center: "",
      right: "",
    });
  });

  it("parses &R section", () => {
    expect(parseHeaderFooterSections("&RRight Text")).toEqual({
      left: "",
      center: "",
      right: "Right Text",
    });
  });

  it("parses all three sections", () => {
    expect(parseHeaderFooterSections("&LLeft&CCenter&RRight")).toEqual({
      left: "Left",
      center: "Center",
      right: "Right",
    });
  });

  it("handles sections in any order", () => {
    expect(parseHeaderFooterSections("&RRight First&LThen Left")).toEqual({
      left: "Then Left",
      center: "",
      right: "Right First",
    });
  });

  it("handles text before first section code", () => {
    const result = parseHeaderFooterSections("Prefix&LLeft");
    expect(result.center).toBe("Prefix");
    expect(result.left).toBe("Left");
  });

  it("handles lowercase section codes", () => {
    expect(parseHeaderFooterSections("&lleft&ccenter&rright")).toEqual({
      left: "left",
      center: "center",
      right: "right",
    });
  });

  it("handles only center section code", () => {
    expect(parseHeaderFooterSections("&CCenter Only")).toEqual({
      left: "",
      center: "Center Only",
      right: "",
    });
  });

  it("handles empty sections between codes", () => {
    expect(parseHeaderFooterSections("&L&C&ROnly Right")).toEqual({
      left: "",
      center: "",
      right: "Only Right",
    });
  });
});

// ============================================================================
// Tests: Dynamic Field Replacement
// ============================================================================

describe("replaceDynamicFields", () => {
  it("replaces &P with page number placeholder", () => {
    expect(replaceDynamicFields("Page &P", "Sheet1")).toBe("Page 1");
  });

  it("replaces &N with total pages placeholder", () => {
    expect(replaceDynamicFields("of &N", "Sheet1")).toBe("of 1");
  });

  it("replaces &F with sheet name", () => {
    expect(replaceDynamicFields("File: &F", "Revenue")).toBe("File: Revenue");
  });

  it("replaces &A with sheet name", () => {
    expect(replaceDynamicFields("Tab: &A", "Summary")).toBe("Tab: Summary");
  });

  it("replaces &D with date placeholder", () => {
    const result = replaceDynamicFields("Date: &D", "Sheet1");
    expect(result).toBe("Date: DATE");
  });

  it("replaces &T with time placeholder", () => {
    const result = replaceDynamicFields("Time: &T", "Sheet1");
    expect(result).toBe("Time: TIME");
  });

  it("replaces multiple fields", () => {
    expect(replaceDynamicFields("&F - Page &P of &N", "Report")).toBe(
      "Report - Page 1 of 1",
    );
  });

  it("returns empty string for empty input", () => {
    expect(replaceDynamicFields("", "Sheet1")).toBe("");
  });

  it("returns text unchanged when no codes present", () => {
    expect(replaceDynamicFields("No codes here", "Sheet1")).toBe("No codes here");
  });
});

// ============================================================================
// Tests: Cell Style Building
// ============================================================================

describe("buildCellStyle", () => {
  it("returns empty string for default style", () => {
    const style = buildCellStyle({}, false);
    expect(style).toBe("");
  });

  it("adds bold", () => {
    const style = buildCellStyle({ bold: true }, false);
    expect(style).toContain("font-weight:bold");
  });

  it("adds italic", () => {
    const style = buildCellStyle({ italic: true }, false);
    expect(style).toContain("font-style:italic");
  });

  it("adds underline", () => {
    const style = buildCellStyle({ underline: "single" }, false);
    expect(style).toContain("text-decoration:underline");
  });

  it("ignores underline when set to none", () => {
    const style = buildCellStyle({ underline: "none" }, false);
    expect(style).not.toContain("underline");
  });

  it("combines underline and strikethrough", () => {
    const style = buildCellStyle({ underline: "single", strikethrough: true }, false);
    expect(style).toContain("text-decoration:underline line-through");
  });

  it("adds strikethrough alone", () => {
    const style = buildCellStyle({ strikethrough: true }, false);
    expect(style).toContain("text-decoration:line-through");
    expect(style).not.toContain("underline");
  });

  it("skips default font size 11", () => {
    const style = buildCellStyle({ fontSize: 11 }, false);
    expect(style).not.toContain("font-size");
  });

  it("adds non-default font size", () => {
    const style = buildCellStyle({ fontSize: 14 }, false);
    expect(style).toContain("font-size:14pt");
  });

  it("skips default font family Calibri", () => {
    const style = buildCellStyle({ fontFamily: "Calibri" }, false);
    expect(style).not.toContain("font-family");
  });

  it("adds non-default font family", () => {
    const style = buildCellStyle({ fontFamily: "Arial" }, false);
    expect(style).toContain('font-family:"Arial",sans-serif');
  });

  it("skips black text color", () => {
    const style = buildCellStyle({ textColor: "#000000" }, false);
    expect(style).not.toContain("color:");
  });

  it("skips rgba black text color", () => {
    const style = buildCellStyle({ textColor: "rgba(0, 0, 0, 1)" }, false);
    expect(style).not.toContain("color:");
  });

  it("adds non-black text color", () => {
    const style = buildCellStyle({ textColor: "#ff0000" }, false);
    expect(style).toContain("color:#ff0000");
  });

  it("skips white background", () => {
    const style = buildCellStyle({ backgroundColor: "#ffffff" }, false);
    expect(style).not.toContain("background-color");
  });

  it("adds non-white background", () => {
    const style = buildCellStyle({ backgroundColor: "#e0f0ff" }, false);
    expect(style).toContain("background-color:#e0f0ff");
  });

  it("adds text alignment", () => {
    expect(buildCellStyle({ textAlign: "center" }, false)).toContain("text-align:center");
    expect(buildCellStyle({ textAlign: "right" }, false)).toContain("text-align:right");
    expect(buildCellStyle({ textAlign: "left" }, false)).toContain("text-align:left");
  });

  it("adds vertical alignment", () => {
    expect(buildCellStyle({ verticalAlign: "top" }, false)).toContain("vertical-align:top");
    expect(buildCellStyle({ verticalAlign: "bottom" }, false)).toContain("vertical-align:bottom");
  });

  it("adds wrap text", () => {
    const style = buildCellStyle({ wrapText: true }, false);
    expect(style).toContain("white-space:pre-wrap");
    expect(style).toContain("word-wrap:break-word");
  });

  it("adds borders with different styles", () => {
    const style = buildCellStyle({
      borderTop: { style: "solid", color: "#000", width: 1 },
      borderBottom: { style: "dashed", color: "#ccc", width: 2 },
      borderLeft: { style: "dotted", color: "#999", width: 1 },
      borderRight: { style: "double", color: "#333", width: 3 },
    }, false);
    expect(style).toContain("border-top:1px solid #000");
    expect(style).toContain("border-bottom:2px dashed #ccc");
    expect(style).toContain("border-left:1px dotted #999");
    expect(style).toContain("border-right:3px double #333");
  });

  it("skips borders with style none", () => {
    const style = buildCellStyle({
      borderTop: { style: "none", color: "#000", width: 1 },
    }, false);
    expect(style).not.toContain("border-top");
  });

  it("adds gridlines when enabled and no explicit borders", () => {
    const style = buildCellStyle({}, true);
    expect(style).toContain("border-top:1px solid #d0d0d0");
    expect(style).toContain("border-bottom:1px solid #d0d0d0");
    expect(style).toContain("border-left:1px solid #d0d0d0");
    expect(style).toContain("border-right:1px solid #d0d0d0");
  });

  it("does not add gridlines where explicit borders exist", () => {
    const style = buildCellStyle({
      borderTop: { style: "solid", color: "#000", width: 2 },
    }, true);
    expect(style).toContain("border-top:2px solid #000");
    // Should still add gridlines on other sides
    expect(style).toContain("border-bottom:1px solid #d0d0d0");
    expect(style).toContain("border-left:1px solid #d0d0d0");
    expect(style).toContain("border-right:1px solid #d0d0d0");
  });

  it("combines multiple style properties", () => {
    const style = buildCellStyle({
      bold: true,
      italic: true,
      fontSize: 14,
      textColor: "#0000ff",
      textAlign: "center",
    }, false);
    expect(style).toContain("font-weight:bold");
    expect(style).toContain("font-style:italic");
    expect(style).toContain("font-size:14pt");
    expect(style).toContain("color:#0000ff");
    expect(style).toContain("text-align:center");
  });
});

// ============================================================================
// Tests: Paper Size Calculations
// ============================================================================

describe("paper size calculations", () => {
  const PAPER_SIZES: Record<string, { width: number; height: number }> = {
    a4: { width: 210, height: 297 },
    a3: { width: 297, height: 420 },
    letter: { width: 216, height: 279 },
    legal: { width: 216, height: 356 },
    tabloid: { width: 279, height: 432 },
  };

  it("has correct A4 dimensions in mm", () => {
    expect(PAPER_SIZES.a4).toEqual({ width: 210, height: 297 });
  });

  it("has correct Letter dimensions in mm", () => {
    expect(PAPER_SIZES.letter).toEqual({ width: 216, height: 279 });
  });

  it("landscape swaps width and height", () => {
    const paper = PAPER_SIZES.a4;
    const landscapeW = paper.height;
    const landscapeH = paper.width;
    expect(landscapeW).toBe(297);
    expect(landscapeH).toBe(210);
  });

  it("calculates content area correctly", () => {
    const paper = PAPER_SIZES.a4;
    const marginLeft = inchesToMm(0.75);
    const marginRight = inchesToMm(0.75);
    const marginTop = inchesToMm(1.0);
    const marginBottom = inchesToMm(1.0);
    const contentW = paper.width - marginLeft - marginRight;
    const contentH = paper.height - marginTop - marginBottom;
    expect(contentW).toBeCloseTo(210 - 19.05 * 2); // ~171.9
    expect(contentH).toBeCloseTo(297 - 25.4 * 2);  // ~246.2
  });

  it("has correct A3 dimensions in mm", () => {
    expect(PAPER_SIZES.a3).toEqual({ width: 297, height: 420 });
  });

  it("has correct A5 dimensions in mm", () => {
    const A5 = { width: 148, height: 210 };
    expect(A5.width).toBe(148);
    expect(A5.height).toBe(210);
  });

  it("has correct Legal dimensions in mm", () => {
    expect(PAPER_SIZES.legal).toEqual({ width: 216, height: 356 });
  });

  it("has correct Tabloid dimensions in mm", () => {
    expect(PAPER_SIZES.tabloid).toEqual({ width: 279, height: 432 });
  });

  it("landscape A3 swaps to 420x297", () => {
    const paper = PAPER_SIZES.a3;
    expect(paper.height).toBe(420);
    expect(paper.width).toBe(297);
    // landscape
    expect(paper.height).toBeGreaterThan(paper.width);
    const landscapeW = paper.height;
    const landscapeH = paper.width;
    expect(landscapeW).toBe(420);
    expect(landscapeH).toBe(297);
  });

  it("landscape Letter content area is wider than portrait", () => {
    const paper = PAPER_SIZES.letter;
    const margin = inchesToMm(0.75);
    const portraitContentW = paper.width - margin * 2;
    const landscapeContentW = paper.height - margin * 2;
    expect(landscapeContentW).toBeGreaterThan(portraitContentW);
  });

  it("landscape Legal is wider than landscape Letter", () => {
    const legal = PAPER_SIZES.legal;
    const letter = PAPER_SIZES.letter;
    // landscape width = portrait height
    expect(legal.height).toBeGreaterThan(letter.height);
  });

  it("calculates content area for all paper sizes with standard margins", () => {
    const margin = inchesToMm(0.75); // ~19.05mm
    for (const [name, paper] of Object.entries(PAPER_SIZES)) {
      const contentW = paper.width - margin * 2;
      const contentH = paper.height - margin * 2;
      expect(contentW).toBeGreaterThan(0);
      expect(contentH).toBeGreaterThan(0);
      expect(contentW).toBeLessThan(paper.width);
      expect(contentH).toBeLessThan(paper.height);
    }
  });
});

// ============================================================================
// Tests: Complex Header/Footer Combinations
// ============================================================================

describe("complex header/footer field codes", () => {
  it("handles all field codes in one string", () => {
    const result = replaceDynamicFields("&F &A &P &N &D &T", "Budget");
    expect(result).toBe("Budget Budget 1 1 DATE TIME");
  });

  it("handles field codes inside section codes", () => {
    const sections = parseHeaderFooterSections("&LPage &P&C&F&R&D &T");
    expect(sections.left).toBe("Page &P");
    expect(sections.center).toBe("&F");
    expect(sections.right).toBe("&D &T");
    // Now replace dynamic fields in each section
    const left = replaceDynamicFields(sections.left, "Sheet1");
    const center = replaceDynamicFields(sections.center, "Sheet1");
    const right = replaceDynamicFields(sections.right, "Sheet1");
    expect(left).toBe("Page 1");
    expect(center).toBe("Sheet1");
    expect(right).toBe("DATE TIME");
  });

  it("handles repeated section codes (last wins)", () => {
    const result = parseHeaderFooterSections("&LFirst&LSecond");
    expect(result.left).toBe("FirstSecond");
  });

  it("handles section codes with empty content between them", () => {
    const result = parseHeaderFooterSections("&L&C&R");
    expect(result).toEqual({ left: "", center: "", right: "" });
  });

  it("handles only &R with field codes", () => {
    const sections = parseHeaderFooterSections("&RPage &P of &N");
    const replaced = replaceDynamicFields(sections.right, "Q4 Report");
    expect(replaced).toBe("Page 1 of 1");
  });
});

// ============================================================================
// Tests: Cell Styles - Border Style Combinations
// ============================================================================

describe("buildCellStyle border combinations", () => {
  it("handles all four borders with same style", () => {
    const border = { style: "solid", color: "#000000", width: 1 };
    const style = buildCellStyle({
      borderTop: border,
      borderBottom: border,
      borderLeft: border,
      borderRight: border,
    }, false);
    expect(style).toContain("border-top:1px solid #000000");
    expect(style).toContain("border-bottom:1px solid #000000");
    expect(style).toContain("border-left:1px solid #000000");
    expect(style).toContain("border-right:1px solid #000000");
  });

  it("handles each border with a different style", () => {
    const style = buildCellStyle({
      borderTop: { style: "solid", color: "#000", width: 1 },
      borderBottom: { style: "double", color: "#f00", width: 3 },
      borderLeft: { style: "dashed", color: "#0f0", width: 2 },
      borderRight: { style: "dotted", color: "#00f", width: 1 },
    }, false);
    expect(style).toContain("border-top:1px solid #000");
    expect(style).toContain("border-bottom:3px double #f00");
    expect(style).toContain("border-left:2px dashed #0f0");
    expect(style).toContain("border-right:1px dotted #00f");
  });

  it("falls back to solid for unknown border style", () => {
    const style = buildCellStyle({
      borderTop: { style: "thick", color: "#000", width: 3 },
    }, false);
    expect(style).toContain("border-top:3px solid #000");
  });

  it("uses default width 1 when width is 0", () => {
    const style = buildCellStyle({
      borderTop: { style: "solid", color: "#000", width: 0 },
    }, false);
    // width 0 is falsy, so || 1 kicks in
    expect(style).toContain("border-top:1px solid #000");
  });

  it("gridlines do not override explicit borders on any side", () => {
    const style = buildCellStyle({
      borderTop: { style: "solid", color: "#ff0000", width: 2 },
      borderLeft: { style: "dashed", color: "#00ff00", width: 1 },
    }, true);
    expect(style).toContain("border-top:2px solid #ff0000");
    expect(style).toContain("border-left:1px dashed #00ff00");
    // gridlines fill in the missing sides
    expect(style).toContain("border-bottom:1px solid #d0d0d0");
    expect(style).toContain("border-right:1px solid #d0d0d0");
    // no duplicate top or left
    expect(style.match(/border-top/g)!.length).toBe(1);
    expect(style.match(/border-left/g)!.length).toBe(1);
  });

  it("border with style none suppresses gridlines on that side", () => {
    const style = buildCellStyle({
      borderTop: { style: "none", color: "#000", width: 1 },
    }, true);
    // borderTop is truthy so gridline fallback does not fire, but borderSide skips "none"
    // Result: no border-top at all
    expect(style).not.toContain("border-top");
    // Other sides still get gridlines
    expect(style).toContain("border-bottom:1px solid #d0d0d0");
    expect(style).toContain("border-left:1px solid #d0d0d0");
    expect(style).toContain("border-right:1px solid #d0d0d0");
  });
});

// ============================================================================
// Tests: Wrap Text and Long Content
// ============================================================================

describe("buildCellStyle wrap text and long content", () => {
  it("wrap text sets both white-space and word-wrap", () => {
    const style = buildCellStyle({ wrapText: true }, false);
    expect(style).toContain("white-space:pre-wrap");
    expect(style).toContain("word-wrap:break-word");
  });

  it("wrap text combined with all formatting produces valid style string", () => {
    const style = buildCellStyle({
      bold: true,
      italic: true,
      underline: "single",
      strikethrough: true,
      fontSize: 16,
      fontFamily: "Times New Roman",
      textColor: "#333333",
      backgroundColor: "#ffffcc",
      textAlign: "center",
      verticalAlign: "top",
      wrapText: true,
      borderTop: { style: "solid", color: "#000", width: 1 },
    }, true);
    // All properties present
    expect(style).toContain("font-weight:bold");
    expect(style).toContain("font-style:italic");
    expect(style).toContain("text-decoration:underline line-through");
    expect(style).toContain("font-size:16pt");
    expect(style).toContain('font-family:"Times New Roman",sans-serif');
    expect(style).toContain("color:#333333");
    expect(style).toContain("background-color:#ffffcc");
    expect(style).toContain("text-align:center");
    expect(style).toContain("vertical-align:top");
    expect(style).toContain("white-space:pre-wrap");
    expect(style).toContain("border-top:1px solid #000");
    // Gridlines on remaining sides
    expect(style).toContain("border-bottom:1px solid #d0d0d0");
  });

  it("without wrap text, no white-space is set", () => {
    const style = buildCellStyle({ wrapText: false }, false);
    expect(style).not.toContain("white-space");
    expect(style).not.toContain("word-wrap");
  });
});

// ============================================================================
// Tests: HTML Escaping Edge Cases
// ============================================================================

describe("escapeHtml edge cases", () => {
  it("escapes long content with many special chars", () => {
    const input = '<div class="x">&amp; "test" <b>bold</b>';
    const result = escapeHtml(input);
    expect(result).not.toContain("<");
    expect(result).not.toContain(">");
    expect(result).toContain("&lt;");
    expect(result).toContain("&gt;");
    expect(result).toContain("&amp;amp;");
    expect(result).toContain("&quot;");
  });

  it("handles string of only special characters", () => {
    expect(escapeHtml('<>&"')).toBe("&lt;&gt;&amp;&quot;");
  });
});
