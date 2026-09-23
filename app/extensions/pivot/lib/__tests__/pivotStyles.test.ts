//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotStyles.test.ts
// PURPOSE: The pivot style DATA module after its move out of the gallery
//          component: every name the gallery used to export still resolves,
//          the style -> PivotTheme mapping is byte-for-byte what the gallery
//          computed before the move (an oracle copied verbatim from the old
//          PivotTableStylesGallery.tsx), the thumbnail geometry matches the
//          old canvas drawing, and the live-preview seam is transient.

import { describe, it, expect, vi, beforeEach } from "vitest";

const redraw = vi.hoisted(() => ({ requestOverlayRedraw: vi.fn() }));
vi.mock("@api/gridOverlays", () => redraw);

import {
  DEFAULT_EXCEL_PIVOT_STYLE,
  DEFAULT_PIVOT_STYLE_ID,
  EXCEL_PIVOT_STYLES,
  EXCEL_PIVOT_STYLES_BY_NAME,
  PIVOT_STYLES,
  PIVOT_STYLES_BY_ID,
  PIVOT_STYLE_CATEGORIES,
  PIVOT_THUMB_COLS,
  PIVOT_THUMB_ROWS,
  getPivotStylePreview,
  getPivotThumbColors,
  getThemeOverridesForStyle,
  orderedPivotStyles,
  pivotStyleDisplayName,
  pivotThumbnailRects,
  setPivotStylePreview,
  subscribePivotStylePreview,
  type ExcelPivotStyle,
} from "../pivotStyles";
import type { PivotTheme } from "../../rendering/pivot";

// ============================================================================
// ORACLE — the pre-move implementation, verbatim (PivotTableStylesGallery.tsx
// as of 2026-07-01). Do not "tidy" it: it is the reference the move must match.
// ============================================================================

function legacyLighten(hex: string, ratio: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lr = Math.round(r + (255 - r) * ratio);
  const lg = Math.round(g + (255 - g) * ratio);
  const lb = Math.round(b + (255 - b) * ratio);
  return `#${lr.toString(16).padStart(2, '0')}${lg.toString(16).padStart(2, '0')}${lb.toString(16).padStart(2, '0')}`;
}

function legacyLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const srgb = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
}

function legacyIsDark(hex: string): boolean {
  return legacyLuminance(hex) < 0.35;
}

function legacyOverrides(style: ExcelPivotStyle): Partial<PivotTheme> {
  const headerBg = style.headerRow?.bg || '';
  const headerFg = style.headerRow?.fg || style.wholeTable?.fg || '#000000';
  const hasColoredHeader = !!headerBg && headerBg !== '#FFFFFF' && headerBg !== '#ffffff';
  const bodyBg = style.wholeTable?.bg || '#ffffff';
  const bodyFg = style.wholeTable?.fg || '#000000';
  const isDarkBody = !!bodyBg && bodyBg !== '#ffffff' && bodyBg !== '#FFFFFF' && legacyIsDark(bodyBg);
  const bandBg = style.rowStripe1?.bg || '';
  const headerTextColor = hasColoredHeader
    ? (legacyIsDark(headerBg) ? '#ffffff' : '#000000')
    : headerFg;
  const labelText = isDarkBody ? (bodyFg || '#e0e0e0') : (bodyFg || '#1f2937');
  const valueText = isDarkBody ? (bodyFg || '#d0d0d0') : (bodyFg || '#374151');
  const totalBg = style.totalRow?.bg || '';
  const totalFg = style.totalRow?.fg || '';
  const grandTotalBg = totalBg || (hasColoredHeader ? headerBg : (isDarkBody ? legacyLighten(bodyBg, -0.1) : ''));
  const grandTotalFg = totalFg || (hasColoredHeader && !totalBg ? headerTextColor : bodyFg);
  const subtotalBg = style.subtotalRow1?.bg || '';
  const subtotalFg = style.subtotalRow1?.fg || bodyFg;
  const subtotalResultBg = subtotalBg || (totalBg ? legacyLighten(totalBg, 0.3) : '');
  const pageLabels = style.pageFieldLabels;
  const filterLabelBg = pageLabels?.bg || (hasColoredHeader ? headerBg : '');
  const filterLabelFg = pageLabels?.fg || (filterLabelBg && legacyIsDark(filterLabelBg) ? '#ffffff' : headerFg);
  const borderColor = isDarkBody
    ? legacyLighten(bodyBg, 0.15)
    : (bandBg && bandBg !== '#ffffff' ? legacyLighten(bandBg, 0.3) : '#e8e8e8');
  const filterBtnBaseBg = filterLabelBg || (hasColoredHeader ? headerBg : '');
  const filterButtonBorder = filterBtnBaseBg ? legacyLighten(filterBtnBaseBg, 0.3) : '#C5CDE0';
  const filterButtonHoverBg = filterBtnBaseBg ? legacyLighten(filterBtnBaseBg, 0.2) : '#E8EEF7';
  const filterDropdownArrow = filterBtnBaseBg && legacyIsDark(filterBtnBaseBg) ? '#ffffff' : '#4b5563';

  const overrides: Partial<PivotTheme> = {};
  overrides.headerBackground = hasColoredHeader ? headerBg : bodyBg;
  overrides.headerBorderColor = hasColoredHeader ? headerBg : borderColor;
  overrides.headerText = headerTextColor;
  overrides.headerFontWeight = style.headerRow?.b ? '700' : '400';
  overrides.valueBackground = bodyBg;
  overrides.labelBackground = bodyBg;
  overrides.labelText = labelText;
  overrides.valueText = valueText;
  overrides.alternateRowBackground = bandBg || bodyBg;
  overrides.grandTotalBackground = grandTotalBg || bodyBg;
  overrides.grandTotalText = grandTotalFg;
  overrides.totalBackground = subtotalResultBg || bodyBg;
  overrides.totalText = subtotalFg;
  overrides.borderColor = borderColor;
  overrides.filterRowBackground = filterLabelBg || bodyBg;
  overrides.filterText = filterLabelFg;
  overrides.filterButtonBackground = filterBtnBaseBg || '#ffffff';
  overrides.filterButtonBorder = filterButtonBorder;
  overrides.filterButtonHoverBackground = filterButtonHoverBg;
  overrides.filterDropdownArrow = filterDropdownArrow;
  overrides.iconColor = isDarkBody ? '#cccccc' : '#6b7280';
  overrides.iconHoverColor = isDarkBody ? '#ffffff' : '#1f2937';
  return overrides;
}

function legacyThumbColors(style: ExcelPivotStyle) {
  const headerBg = style.headerRow?.bg || '#ffffff';
  const headerFg = style.headerRow?.fg || style.wholeTable?.fg || '#000000';
  const baseBg = style.wholeTable?.bg || '#ffffff';
  const bandBg = style.rowStripe1?.bg || style.rowStripe2?.bg || baseBg;
  const accentColor = (headerBg !== '#ffffff' && headerBg !== '#FFFFFF' && headerBg)
    || style.subtotalRow1?.bg
    || style.totalRow?.bg
    || style.pageFieldLabels?.bg
    || bandBg
    || '#d0d0d0';
  const borderColor = (baseBg !== '#ffffff' && baseBg !== '#FFFFFF')
    ? legacyLighten(baseBg, 0.15)
    : (bandBg !== baseBg ? legacyLighten(bandBg, 0.3) : '#e0e0e0');
  return {
    headerBg,
    headerFg: (headerBg !== '#ffffff' && headerBg !== '#FFFFFF')
      ? (legacyIsDark(headerBg) ? '#ffffff' : '#333333')
      : headerFg,
    bandBg,
    baseBg,
    borderColor,
    accentColor,
    // The old canvas computed this inline, per body row.
    bodyDash: baseBg !== '#ffffff' && baseBg !== '#FFFFFF' ? legacyLighten(baseBg, 0.6) : '#999999',
  };
}

/** The old canvas drawing, recorded as fillRect calls instead of painted. */
function legacyCanvasFills(thumb: ReturnType<typeof legacyThumbColors>, w: number, h: number) {
  const fills: Array<{ x: number; y: number; w: number; h: number; fill: string }> = [];
  const borderW = 1;
  const rowH = Math.floor((h - borderW * (5 - 1)) / 5);
  const colW = Math.floor(w / 4);
  const dashMarginX = 3;
  const dashH = 1.5;
  const headerDashH = 2;
  let y = 0;
  for (let r = 0; r < 5; r++) {
    const isHeader = r === 0;
    const isBanded = r > 0 && r % 2 === 0;
    let bg = isBanded ? thumb.bandBg : thumb.baseBg;
    if (isHeader) bg = thumb.headerBg;
    fills.push({ x: 0, y, w, h: rowH, fill: bg });
    const fg = isHeader ? thumb.headerFg : thumb.bodyDash;
    for (let c = 0; c < 4; c++) {
      const x = c * colW + dashMarginX;
      const dw = colW - dashMarginX * 2;
      const dy = y + (rowH - (isHeader ? headerDashH : dashH)) / 2;
      fills.push({ x, y: dy, w: dw, h: isHeader ? headerDashH : dashH, fill: fg });
    }
    y += rowH;
    if (r < 5 - 1) {
      fills.push({ x: 0, y, w, h: borderW, fill: thumb.borderColor });
      y += borderW;
    }
  }
  return fills;
}

// ============================================================================
// Tests
// ============================================================================

describe("pivotStyles — the names importers use", () => {
  it("keeps every name the gallery component used to export", () => {
    expect(PIVOT_STYLES).toBe(EXCEL_PIVOT_STYLES);
    expect(PIVOT_STYLES_BY_ID).toBe(EXCEL_PIVOT_STYLES_BY_NAME);
    expect(DEFAULT_PIVOT_STYLE_ID).toBe(DEFAULT_EXCEL_PIVOT_STYLE);
    expect(DEFAULT_PIVOT_STYLE_ID).toBe("PivotStyleLight16");
    expect(typeof getThemeOverridesForStyle).toBe("function");
  });
});

describe("pivotStyles — style -> PivotTheme mapping", () => {
  it("matches the pre-move implementation for every one of the styles", () => {
    expect(EXCEL_PIVOT_STYLES.length).toBeGreaterThan(80);
    for (const style of EXCEL_PIVOT_STYLES) {
      expect(getThemeOverridesForStyle(style.name), style.name).toEqual(legacyOverrides(style));
    }
  });

  it("returns no overrides for a cleared or unknown style (the default theme applies)", () => {
    expect(getThemeOverridesForStyle("")).toEqual({});
    expect(getThemeOverridesForStyle("NoSuchStyle")).toEqual({});
  });
});

describe("pivotStyles — gallery order and names", () => {
  it("groups every style Light, then Medium, then Dark", () => {
    const ordered = orderedPivotStyles();
    expect(ordered).toHaveLength(EXCEL_PIVOT_STYLES.length);
    const categories = ordered.map((s) => s.category);
    const firstIndex = PIVOT_STYLE_CATEGORIES.map((c) => categories.indexOf(c));
    const lastIndex = PIVOT_STYLE_CATEGORIES.map((c) => categories.lastIndexOf(c));
    expect(firstIndex[0]).toBe(0);
    expect(lastIndex[0]).toBeLessThan(firstIndex[1]);
    expect(lastIndex[1]).toBeLessThan(firstIndex[2]);
    expect(new Set(ordered.map((s) => s.name)).size).toBe(ordered.length);
  });

  it("reads a style id the way Excel names it", () => {
    expect(pivotStyleDisplayName("PivotStyleMedium2")).toBe("Pivot Style Medium 2");
    expect(pivotStyleDisplayName("PivotStyleLight16")).toBe("Pivot Style Light 16");
    expect(pivotStyleDisplayName("Custom")).toBe("Custom");
  });
});

describe("pivotStyles — thumbnail geometry", () => {
  it("derives the same colours the old canvas thumbnail used", () => {
    for (const style of EXCEL_PIVOT_STYLES) {
      expect(getPivotThumbColors(style), style.name).toEqual(legacyThumbColors(style));
    }
  });

  it("draws exactly the old canvas fills (after a ground rect), at every size", () => {
    for (const [w, h] of [[56, 40], [62, 44], [72, 50]]) {
      for (const style of EXCEL_PIVOT_STYLES) {
        const thumb = getPivotThumbColors(style);
        const { rects, outline } = pivotThumbnailRects(thumb, w, h);
        expect(rects[0]).toEqual({ x: 0, y: 0, w, h, fill: thumb.baseBg });
        expect(rects.slice(1)).toEqual(legacyCanvasFills(legacyThumbColors(style), w, h));
        expect(outline).toBe(thumb.accentColor);
      }
    }
  });

  it("is a header row, a banded body and borders: ground + rows + borders + dashes", () => {
    const style = EXCEL_PIVOT_STYLES_BY_NAME.get("PivotStyleMedium2")!;
    const { rects } = pivotThumbnailRects(getPivotThumbColors(style), 56, 40);
    const expected = 1 + PIVOT_THUMB_ROWS + (PIVOT_THUMB_ROWS - 1) + PIVOT_THUMB_ROWS * PIVOT_THUMB_COLS;
    expect(rects).toHaveLength(expected);
    const headerRow = rects[1];
    expect(headerRow.fill).toBe(getPivotThumbColors(style).headerBg);
    expect(rects.every((r) => r.x + r.w <= 56 && r.y + r.h <= 40)).toBe(true);
  });
});

describe("pivotStyles — live preview seam", () => {
  beforeEach(() => {
    setPivotStylePreview(null, null);
    redraw.requestOverlayRedraw.mockClear();
  });

  it("previews a style on one pivot only, and ends", () => {
    expect(getPivotStylePreview("p1")).toBeNull();
    setPivotStylePreview("p1", "PivotStyleDark3");
    expect(getPivotStylePreview("p1")).toBe("PivotStyleDark3");
    expect(getPivotStylePreview("p2")).toBeNull();
    setPivotStylePreview("p1", null);
    expect(getPivotStylePreview("p1")).toBeNull();
  });

  it("repaints and notifies only on a real change", () => {
    const listener = vi.fn();
    const off = subscribePivotStylePreview(listener);
    setPivotStylePreview("p1", "PivotStyleLight2");
    setPivotStylePreview("p1", "PivotStyleLight2");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(redraw.requestOverlayRedraw).toHaveBeenCalledTimes(1);
    setPivotStylePreview("p1", "PivotStyleLight3");
    setPivotStylePreview(null, null);
    setPivotStylePreview(null, null);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(redraw.requestOverlayRedraw).toHaveBeenCalledTimes(3);
    off();
    setPivotStylePreview("p1", "PivotStyleLight4");
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("treats a missing pivot or an empty style as no preview", () => {
    setPivotStylePreview(null, "PivotStyleLight2");
    expect(getPivotStylePreview("")).toBeNull();
    setPivotStylePreview("p1", "");
    expect(getPivotStylePreview("p1")).toBeNull();
    expect(redraw.requestOverlayRedraw).not.toHaveBeenCalled();
  });
});
