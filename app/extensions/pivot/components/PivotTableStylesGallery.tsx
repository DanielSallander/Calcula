//! FILENAME: app/extensions/pivot/components/PivotTableStylesGallery.tsx
// PURPOSE: PivotTable Styles gallery for the Design tab ribbon.
// CONTEXT: Provides predefined pivot table styles matching Excel's PivotTable Styles gallery.
// Shows a collapsed strip in the ribbon with a dropdown for the full gallery.

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { css } from '@emotion/css';
import type { PivotTheme } from '../rendering/pivot';
import {
  EXCEL_PIVOT_STYLES,
  EXCEL_PIVOT_STYLES_BY_NAME,
  DEFAULT_EXCEL_PIVOT_STYLE,
  type ExcelPivotStyle,
} from '../styles/excelPivotStyles';

// ============================================================================
// Re-exports (consumed by index.ts and PivotDesignTab.tsx)
// ============================================================================

export { EXCEL_PIVOT_STYLES as PIVOT_STYLES };
export const PIVOT_STYLES_BY_ID = EXCEL_PIVOT_STYLES_BY_NAME;
export const DEFAULT_PIVOT_STYLE_ID = DEFAULT_EXCEL_PIVOT_STYLE;

// ============================================================================
// Style → PivotTheme Mapping
// ============================================================================

/** Lighten a hex color by blending with white. ratio=0 is original, ratio=1 is white. */
function lighten(hex: string, ratio: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lr = Math.round(r + (255 - r) * ratio);
  const lg = Math.round(g + (255 - g) * ratio);
  const lb = Math.round(b + (255 - b) * ratio);
  return `#${lr.toString(16).padStart(2, '0')}${lg.toString(16).padStart(2, '0')}${lb.toString(16).padStart(2, '0')}`;
}

/** Relative luminance of a hex color (0=black, 1=white). */
function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const srgb = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
}

/** True if the color is "dark" (needs light text on top). */
function isDarkColor(hex: string): boolean {
  return luminance(hex) < 0.35;
}

/**
 * Convert an ExcelPivotStyle into PivotTheme overrides.
 * Returns a Partial<PivotTheme> that should be merged with DEFAULT_PIVOT_THEME.
 */
function excelStyleToThemeOverrides(style: ExcelPivotStyle): Partial<PivotTheme> {
  const headerBg = style.headerRow?.bg || style.wholeTable?.bg || '';
  const headerFg = style.headerRow?.fg || style.wholeTable?.fg || '#000000';
  const hasColoredHeader = !!headerBg && headerBg !== '#FFFFFF' && headerBg !== '#ffffff';
  const bodyBg = style.wholeTable?.bg || '#ffffff';
  const bodyFg = style.wholeTable?.fg || '#000000';
  const totalBg = style.totalRow?.bg || '';
  const totalFg = style.totalRow?.fg || bodyFg;
  const subtotalBg = style.subtotalRow1?.bg || '';
  const subtotalFg = style.subtotalRow1?.fg || bodyFg;
  const bandBg = style.rowStripe1?.bg || '';
  const isDarkBody = !!bodyBg && bodyBg !== '#ffffff' && bodyBg !== '#FFFFFF' && isDarkColor(bodyBg);

  // Determine appropriate text color for headers
  const headerTextColor = hasColoredHeader
    ? (isDarkColor(headerBg) ? '#ffffff' : '#000000')
    : headerFg;

  // For dark themes, we need light text on dark backgrounds
  const labelText = isDarkBody ? (bodyFg || '#e0e0e0') : (bodyFg || '#1f2937');
  const valueText = isDarkBody ? (bodyFg || '#d0d0d0') : (bodyFg || '#374151');

  // Grand total: use totalRow styling
  const grandTotalBg = totalBg || (isDarkBody ? lighten(bodyBg, -0.1) : '#f0f0f0');
  const grandTotalFg = totalFg;

  // Subtotal: use subtotalRow1 styling, fall back to lighter version of total
  const subtotalResultBg = subtotalBg || (totalBg ? lighten(totalBg, 0.3) : '');
  const subtotalResultFg = subtotalFg;

  // Border color: derive from the accent or banding
  const borderColor = isDarkBody
    ? lighten(bodyBg, 0.15)
    : (bandBg && bandBg !== '#ffffff' ? lighten(bandBg, 0.3) : '#e8e8e8');

  // Filter-related colors
  const filterButtonBg = hasColoredHeader ? headerBg : '#ffffff';
  const filterButtonBorder = hasColoredHeader
    ? lighten(headerBg, 0.3)
    : '#C5CDE0';
  const filterButtonHoverBg = hasColoredHeader
    ? lighten(headerBg, 0.2)
    : '#E8EEF7';
  const filterDropdownArrow = hasColoredHeader
    ? (isDarkColor(headerBg) ? '#ffffff' : '#4b5563')
    : '#4b5563';

  const overrides: Partial<PivotTheme> = {};

  // Header
  if (hasColoredHeader) {
    overrides.headerBackground = headerBg;
    overrides.headerBorderColor = headerBg;
  }
  overrides.headerText = headerTextColor;
  overrides.headerFontWeight = style.headerRow?.b ? '700' : '400';

  // Body
  if (bodyBg !== '#ffffff') {
    overrides.valueBackground = bodyBg;
    overrides.labelBackground = bodyBg;
  }
  overrides.labelText = labelText;
  overrides.valueText = valueText;
  overrides.filterText = headerTextColor;

  // Banding
  if (bandBg) {
    overrides.alternateRowBackground = bandBg;
  }

  // Totals
  if (totalBg) {
    overrides.grandTotalBackground = totalBg;
  } else if (isDarkBody) {
    overrides.grandTotalBackground = lighten(bodyBg, -0.05);
  }
  overrides.grandTotalText = grandTotalFg;

  // Subtotals
  if (subtotalResultBg) {
    overrides.totalBackground = subtotalResultBg;
  }
  overrides.totalText = subtotalResultFg;

  // Borders
  overrides.borderColor = borderColor;

  // Filter row — follows the header color to match Excel
  if (hasColoredHeader) {
    overrides.filterRowBackground = headerBg;
  }

  // Filter button
  overrides.filterButtonBackground = filterButtonBg;
  overrides.filterButtonBorder = filterButtonBorder;
  overrides.filterButtonHoverBackground = filterButtonHoverBg;
  overrides.filterDropdownArrow = filterDropdownArrow;

  // Icons
  overrides.iconColor = isDarkBody ? '#cccccc' : '#6b7280';
  overrides.iconHoverColor = isDarkBody ? '#ffffff' : '#1f2937';

  return overrides;
}

/**
 * Get PivotTheme overrides for a given style ID (e.g. "PivotStyleLight16").
 * Returns empty object if style not found (will use default theme).
 */
export function getThemeOverridesForStyle(styleId: string): Partial<PivotTheme> {
  if (!styleId) return {};
  const style = EXCEL_PIVOT_STYLES_BY_NAME.get(styleId);
  if (!style) return {};
  return excelStyleToThemeOverrides(style);
}

// ============================================================================
// Canvas Thumbnail Rendering
// ============================================================================

const THUMB_ROWS = 5;
const THUMB_COLS = 4;

interface ThumbColors {
  headerBg: string;
  headerFg: string;
  bandBg: string;
  baseBg: string;
  borderColor: string;
  accentColor: string;
}

/** Derive thumbnail colors from an ExcelPivotStyle. */
function getThumbColors(style: ExcelPivotStyle): ThumbColors {
  const headerBg = style.headerRow?.bg || '#ffffff';
  const headerFg = style.headerRow?.fg || style.wholeTable?.fg || '#000000';
  const baseBg = style.wholeTable?.bg || '#ffffff';
  const bandBg = style.rowStripe1?.bg || style.rowStripe2?.bg || baseBg;

  // Accent: use the most prominent non-white color
  const accentColor = (headerBg !== '#ffffff' && headerBg !== '#FFFFFF' && headerBg)
    || style.subtotalRow1?.bg
    || style.totalRow?.bg
    || style.pageFieldLabels?.bg
    || bandBg
    || '#d0d0d0';

  const borderColor = (baseBg !== '#ffffff' && baseBg !== '#FFFFFF')
    ? lighten(baseBg, 0.15)
    : (bandBg !== baseBg ? lighten(bandBg, 0.3) : '#e0e0e0');

  return {
    headerBg,
    headerFg: (headerBg !== '#ffffff' && headerBg !== '#FFFFFF')
      ? (isDarkColor(headerBg) ? '#ffffff' : '#333333')
      : headerFg,
    bandBg,
    baseBg,
    borderColor,
    accentColor,
  };
}

function drawPivotThumbnail(
  ctx: CanvasRenderingContext2D,
  thumb: ThumbColors,
  w: number,
  h: number,
): void {
  const borderW = 1;
  const rowH = Math.floor((h - borderW * (THUMB_ROWS - 1)) / THUMB_ROWS);
  const colW = Math.floor(w / THUMB_COLS);
  const dashMarginX = 3;
  const dashH = 1.5;
  const headerDashH = 2;

  ctx.clearRect(0, 0, w, h);

  let y = 0;
  for (let r = 0; r < THUMB_ROWS; r++) {
    const isHeader = r === 0;
    const isBanded = r > 0 && r % 2 === 0;

    let bg = isBanded ? thumb.bandBg : thumb.baseBg;
    if (isHeader) bg = thumb.headerBg;

    ctx.fillStyle = bg;
    ctx.fillRect(0, y, w, rowH);

    // Content dashes
    const fg = isHeader ? thumb.headerFg : (thumb.baseBg !== '#ffffff' && thumb.baseBg !== '#FFFFFF'
      ? lighten(thumb.baseBg, 0.6)
      : '#999999');
    ctx.fillStyle = fg;
    for (let c = 0; c < THUMB_COLS; c++) {
      const x = c * colW + dashMarginX;
      const dw = colW - dashMarginX * 2;
      const dy = y + (rowH - (isHeader ? headerDashH : dashH)) / 2;
      ctx.fillRect(x, dy, dw, isHeader ? headerDashH : dashH);
    }

    y += rowH;

    // Horizontal border after row
    if (r < THUMB_ROWS - 1) {
      ctx.fillStyle = thumb.borderColor;
      ctx.fillRect(0, y, w, borderW);
      y += borderW;
    }
  }

  // Outer border
  ctx.strokeStyle = thumb.accentColor;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
}

// ============================================================================
// PivotStyleThumbnail Component
// ============================================================================

const THUMB_W = 72;
const THUMB_H = 50;

interface ThumbnailProps {
  style: ExcelPivotStyle;
  selected?: boolean;
  onClick?: () => void;
  width?: number;
  height?: number;
}

function PivotStyleThumbnail({ style, selected, onClick, width = THUMB_W, height = THUMB_H }: ThumbnailProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dpr = window.devicePixelRatio || 1;
  const thumb = useMemo(() => getThumbColors(style), [style]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    drawPivotThumbnail(ctx, thumb, width, height);
  }, [thumb, width, height, dpr]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width,
        height,
        cursor: 'pointer',
        borderRadius: 2,
        outline: selected ? '2px solid #005fb8' : '2px solid transparent',
        outlineOffset: -1,
      }}
      title={style.name}
      onClick={onClick}
      onMouseEnter={(e) => {
        if (!selected) {
          (e.currentTarget as HTMLCanvasElement).style.outline = '2px solid #80b8e0';
        }
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLCanvasElement).style.outline = selected
          ? '2px solid #005fb8'
          : '2px solid transparent';
      }}
    />
  );
}

// ============================================================================
// Styles
// ============================================================================

const galleryStyles = {
  stripContainer: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    flex: 1 1 0;
    min-width: 0;
    overflow: hidden;
  `,
  stripRow: css`
    display: flex;
    align-items: center;
    gap: 2px;
    border: 1px solid #d0d0d0;
    border-radius: 3px;
    padding: 3px 2px;
    background: #f0f0f0;
  `,
  stripThumbnails: css`
    display: flex;
    gap: 3px;
    overflow: hidden;
  `,
  dropdownButton: css`
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 50px;
    border: none;
    border-left: 1px solid #d0d0d0;
    background: transparent;
    cursor: pointer;
    color: #555;
    font-size: 10px;
    padding: 0;
    margin-left: 2px;

    &:hover {
      background: #e0e0e0;
      color: #333;
    }
  `,
  groupLabel: css`
    font-size: 10px;
    color: #666;
    text-align: center;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  `,
  dropdownOverlay: css`
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 1099;
  `,
  dropdown: css`
    position: fixed;
    z-index: 1100;
    background: var(--menu-dropdown-bg, #2b2b2b);
    border: 1px solid var(--menu-border, #555);
    border-radius: 4px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    padding: 8px 10px;
    max-height: 520px;
    overflow-y: auto;

    &::-webkit-scrollbar {
      width: 6px;
    }
    &::-webkit-scrollbar-thumb {
      background: #555;
      border-radius: 3px;
    }
  `,
  categoryLabel: css`
    font-size: 11px;
    font-weight: 600;
    color: var(--text-secondary, #aaa);
    padding: 8px 0 4px 0;
    border-bottom: 1px solid var(--menu-separator, #444);
    margin-bottom: 5px;
    font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;

    &:first-child {
      padding-top: 0;
    }
  `,
  styleGrid: css`
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 4px;
    margin-bottom: 6px;
  `,
  separator: css`
    height: 1px;
    background: var(--menu-separator, #444);
    margin: 6px 0;
  `,
  footerButton: css`
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    border: none;
    background: transparent;
    color: var(--text-primary, #e0e0e0);
    font-size: 12px;
    font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
    cursor: pointer;
    border-radius: 3px;
    text-align: left;

    &:hover {
      background: var(--menu-item-hover, #3a3a3a);
    }
  `,
  footerIcon: css`
    font-size: 14px;
    width: 20px;
    text-align: center;
    color: var(--text-secondary, #aaa);
  `,
};

// ============================================================================
// Category metadata
// ============================================================================

const CATEGORY_LABELS: Record<string, string> = {
  Light: 'Light',
  Medium: 'Medium',
  Dark: 'Dark',
};

const CATEGORY_ORDER = ['Light', 'Medium', 'Dark'] as const;

// ============================================================================
// PivotStylesDropdown Component (full gallery)
// ============================================================================

interface DropdownProps {
  anchorRect: DOMRect;
  selectedStyleId: string;
  onSelect: (styleId: string) => void;
  onClear: () => void;
  onClose: () => void;
}

function PivotStylesDropdown({ anchorRect, selectedStyleId, onSelect, onClear, onClose }: DropdownProps) {
  const ref = useRef<HTMLDivElement>(null);

  const pos = useMemo(() => {
    const dropdownW = 560;
    let top = anchorRect.bottom + 2;
    let left = anchorRect.left;

    if (left + dropdownW > window.innerWidth) {
      left = window.innerWidth - dropdownW - 8;
    }
    if (left < 4) left = 4;
    if (top + 400 > window.innerHeight) {
      top = anchorRect.top - 400;
      if (top < 4) top = 4;
    }

    return { top, left };
  }, [anchorRect]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const grouped = useMemo(
    () =>
      CATEGORY_ORDER.map((cat) => ({
        category: cat,
        label: CATEGORY_LABELS[cat],
        items: EXCEL_PIVOT_STYLES.filter((s) => s.category === cat),
      })),
    [],
  );

  return ReactDOM.createPortal(
    <>
      <div className={galleryStyles.dropdownOverlay} onClick={onClose} />
      <div
        ref={ref}
        className={galleryStyles.dropdown}
        style={{ top: pos.top, left: pos.left, width: 560 }}
      >
        {grouped.map((group) => (
          <div key={group.category}>
            <div className={galleryStyles.categoryLabel}>{group.label}</div>
            <div className={galleryStyles.styleGrid}>
              {group.items.map((styleDef) => (
                <PivotStyleThumbnail
                  key={styleDef.name}
                  style={styleDef}
                  selected={styleDef.name === selectedStyleId}
                  onClick={() => {
                    onSelect(styleDef.name);
                    onClose();
                  }}
                />
              ))}
            </div>
          </div>
        ))}
        <div className={galleryStyles.separator} />
        <button className={galleryStyles.footerButton} disabled>
          <span className={galleryStyles.footerIcon}>+</span>
          New PivotTable Style...
        </button>
        <button
          className={galleryStyles.footerButton}
          onClick={() => {
            onClear();
            onClose();
          }}
        >
          <span className={galleryStyles.footerIcon}>x</span>
          Clear
        </button>
      </div>
    </>,
    document.body,
  );
}

// ============================================================================
// Collapsed "Quick Styles" button
// ============================================================================

const collapsedStyles = {
  button: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 4px 10px;
    border: 1px solid #d0d0d0;
    border-radius: 4px;
    background: #fff;
    cursor: pointer;
    font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
    min-width: 64px;

    &:hover {
      background: #e8e8e8;
      border-color: #999;
    }
  `,
  icon: css`
    width: 32px;
    height: 32px;
    position: relative;
  `,
  label: css`
    display: flex;
    align-items: center;
    gap: 3px;
    font-size: 10px;
    color: #333;
    white-space: nowrap;
  `,
  arrow: css`
    font-size: 8px;
    color: #666;
  `,
};

function QuickStyleIcon({ style }: { style: ExcelPivotStyle }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dpr = window.devicePixelRatio || 1;
  const size = 32;
  const thumb = useMemo(() => getThumbColors(style), [style]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);
    drawPivotThumbnail(ctx, thumb, size, size);
  }, [thumb, dpr]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size, borderRadius: 2 }}
    />
  );
}

// ============================================================================
// PivotTableStylesGallery Component
// ============================================================================

interface GalleryProps {
  selectedStyleId: string;
  onStyleSelect: (styleId: string) => void;
  onStyleClear: () => void;
  collapsed?: boolean;
}

// Show Medium 1-7 in the collapsed strip by default
const STRIP_STYLES = EXCEL_PIVOT_STYLES.filter(
  (s) => s.category === 'Medium' && s.name.match(/PivotStyleMedium[1-7]$/),
);

const THUMB_STRIP_W = 62 + 3;
const MIN_STRIP_W = 62 + 18 + 12;
const COLLAPSE_THRESHOLD = MIN_STRIP_W;

export function PivotTableStylesGallery({ selectedStyleId, onStyleSelect, onStyleClear, collapsed = false }: GalleryProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [availableWidth, setAvailableWidth] = useState<number>(9999);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setAvailableWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const isCollapsed = collapsed || availableWidth < COLLAPSE_THRESHOLD;
  const visibleCount = isCollapsed
    ? 0
    : Math.max(1, Math.min(STRIP_STYLES.length, Math.floor((availableWidth - 18 - 12) / THUMB_STRIP_W)));

  const handleOpenDropdown = useCallback(() => {
    if (containerRef.current) {
      setAnchorRect(containerRef.current.getBoundingClientRect());
    }
    setIsOpen(true);
  }, []);

  const handleClose = useCallback(() => {
    setIsOpen(false);
  }, []);

  const selectedDef = EXCEL_PIVOT_STYLES_BY_NAME.get(selectedStyleId) ?? STRIP_STYLES[0];

  return (
    <div ref={containerRef} className={galleryStyles.stripContainer}>
      {isCollapsed ? (
        <button
          className={collapsedStyles.button}
          onClick={handleOpenDropdown}
          title="Quick Styles"
        >
          <div className={collapsedStyles.icon}>
            {selectedDef && <QuickStyleIcon style={selectedDef} />}
          </div>
          <span className={collapsedStyles.label}>
            Quick Styles <span className={collapsedStyles.arrow}>&#9660;</span>
          </span>
        </button>
      ) : (
        <div className={galleryStyles.stripRow}>
          <div className={galleryStyles.stripThumbnails}>
            {STRIP_STYLES.slice(0, visibleCount).map((styleDef) => (
              <PivotStyleThumbnail
                key={styleDef.name}
                style={styleDef}
                width={62}
                height={44}
                selected={styleDef.name === selectedStyleId}
                onClick={() => onStyleSelect(styleDef.name)}
              />
            ))}
          </div>
          <button
            className={galleryStyles.dropdownButton}
            onClick={handleOpenDropdown}
            title="More PivotTable Styles"
          >
            &#9660;
          </button>
        </div>
      )}
      <div className={galleryStyles.groupLabel}>PivotTable Styles</div>

      {isOpen && anchorRect && (
        <PivotStylesDropdown
          anchorRect={anchorRect}
          selectedStyleId={selectedStyleId}
          onSelect={onStyleSelect}
          onClear={onStyleClear}
          onClose={handleClose}
        />
      )}
    </div>
  );
}
