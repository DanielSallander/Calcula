//! FILENAME: app/extensions/Table/components/TableStylesGallery.tsx
// PURPOSE: Table Styles gallery for the Table Design ribbon tab.
// CONTEXT: Provides predefined table styles matching Excel's Table Styles gallery.
// Shows a collapsed strip in the ribbon with a dropdown for the full gallery.

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import ReactDOM from "react-dom";
import { css } from "@emotion/css";

// ============================================================================
// Types
// ============================================================================

interface ThumbColors {
  headerBg: string;
  headerFg: string;
  bandBg: string;
  baseBg: string;
  borderH: string;
  borderV: string;
  outerBorder: string;
  dashColor: string;
  headerBorderBottom?: string;
}

export interface TableStyleDef {
  id: string;
  category: "light" | "medium" | "dark";
  group: number;
  accentIndex: number;
  thumb: ThumbColors;
}

// ============================================================================
// Accent Color Palette (matches Excel Office theme)
// ============================================================================

interface AccentColor {
  base: string;
  light: string;
  lighter: string;
  medium: string;
  dark: string;
}

const STYLE_ACCENTS: AccentColor[] = [
  // 0: No accent (gray/neutral)
  { base: "#999999", light: "#f2f2f2", lighter: "#f8f8f8", medium: "#d9d9d9", dark: "#595959" },
  // 1: Blue (Accent 1)
  { base: "#4472c4", light: "#d6e4f0", lighter: "#edf2f9", medium: "#8faadc", dark: "#2f5496" },
  // 2: Orange (Accent 2)
  { base: "#ed7d31", light: "#fbe5d6", lighter: "#fdf2eb", medium: "#f4b183", dark: "#c55a11" },
  // 3: Gray (Accent 3)
  { base: "#a5a5a5", light: "#ededed", lighter: "#f6f6f6", medium: "#c9c9c9", dark: "#7f7f7f" },
  // 4: Gold (Accent 4)
  { base: "#ffc000", light: "#fff2cc", lighter: "#fff9e5", medium: "#ffd966", dark: "#bf9000" },
  // 5: Light Blue (Accent 5)
  { base: "#5b9bd5", light: "#deeaf6", lighter: "#eff5fb", medium: "#9bc2e6", dark: "#2e75b6" },
  // 6: Green (Accent 6)
  { base: "#70ad47", light: "#e2efda", lighter: "#f0f7ec", medium: "#a9d18e", dark: "#548235" },
];

// ============================================================================
// Style Generation
// ============================================================================

function addStyle(
  styles: TableStyleDef[],
  category: TableStyleDef["category"],
  group: number,
  accentIndex: number,
  thumb: ThumbColors,
): void {
  const num = group * 7 + accentIndex + 1;
  styles.push({ id: `table-${category}-${num}`, category, group, accentIndex, thumb });
}

function generateTableStyles(): TableStyleDef[] {
  const styles: TableStyleDef[] = [];

  STYLE_ACCENTS.forEach((accent, i) => {
    // --- LIGHT Group 0 (Light 1-7): Very minimal, thin borders ---
    addStyle(styles, "light", 0, i, {
      headerBg: "#ffffff", headerFg: accent.dark, bandBg: "#ffffff", baseBg: "#ffffff",
      borderH: accent.medium, borderV: "", outerBorder: accent.medium, dashColor: accent.medium,
      headerBorderBottom: accent.base,
    });
    // --- LIGHT Group 1 (Light 8-14): Header accent border, subtle banding ---
    addStyle(styles, "light", 1, i, {
      headerBg: "#ffffff", headerFg: accent.dark, bandBg: accent.lighter, baseBg: "#ffffff",
      borderH: "#e8e8e8", borderV: "", outerBorder: "#cccccc", dashColor: "#999999",
      headerBorderBottom: accent.base,
    });
    // --- LIGHT Group 2 (Light 15-21): Colored header, banded rows ---
    addStyle(styles, "light", 2, i, {
      headerBg: accent.base, headerFg: "#ffffff", bandBg: accent.light, baseBg: "#ffffff",
      borderH: "transparent", borderV: "", outerBorder: accent.medium, dashColor: "#777777",
    });
    // --- LIGHT Group 3 (Light 22-28): Colored header, banded rows, grid lines ---
    addStyle(styles, "light", 3, i, {
      headerBg: accent.base, headerFg: "#ffffff", bandBg: accent.light, baseBg: "#ffffff",
      borderH: accent.medium, borderV: accent.medium, outerBorder: accent.base, dashColor: "#666666",
    });

    // --- MEDIUM Group 0 (Medium 1-7): Colored header, accent horizontal lines ---
    addStyle(styles, "medium", 0, i, {
      headerBg: accent.base, headerFg: "#ffffff", bandBg: "#ffffff", baseBg: "#ffffff",
      borderH: accent.medium, borderV: "", outerBorder: accent.base, dashColor: "#777777",
    });
    // --- MEDIUM Group 1 (Medium 8-14): Colored header, subtle banding ---
    addStyle(styles, "medium", 1, i, {
      headerBg: accent.base, headerFg: "#ffffff", bandBg: accent.lighter, baseBg: "#ffffff",
      borderH: "transparent", borderV: "", outerBorder: accent.base, dashColor: "#777777",
    });
    // --- MEDIUM Group 2 (Medium 15-21): Dark header, strong banding, borders ---
    addStyle(styles, "medium", 2, i, {
      headerBg: accent.dark, headerFg: "#ffffff", bandBg: accent.light, baseBg: "#ffffff",
      borderH: accent.medium, borderV: accent.medium, outerBorder: accent.dark, dashColor: "#555555",
    });
    // --- MEDIUM Group 3 (Medium 22-28): Dark header, full grid, strong bands ---
    addStyle(styles, "medium", 3, i, {
      headerBg: accent.dark, headerFg: "#ffffff", bandBg: accent.light, baseBg: accent.lighter,
      borderH: accent.base, borderV: accent.base, outerBorder: accent.dark, dashColor: "#555555",
    });

    // --- DARK Group 0 (Dark 1-7): Dark header, medium body ---
    addStyle(styles, "dark", 0, i, {
      headerBg: accent.dark, headerFg: "#ffffff", bandBg: accent.light, baseBg: accent.lighter,
      borderH: "transparent", borderV: "", outerBorder: accent.dark, dashColor: accent.dark,
    });
    // --- DARK Group 1 (Dark 8-14): Very dark, accent fills ---
    addStyle(styles, "dark", 1, i, {
      headerBg: accent.dark, headerFg: "#ffffff", bandBg: accent.base, baseBg: accent.medium,
      borderH: "transparent", borderV: "", outerBorder: accent.dark, dashColor: "#ffffff",
    });
    // --- DARK Group 2 (Dark 15-21): Black header, dark accent body ---
    addStyle(styles, "dark", 2, i, {
      headerBg: "#333333", headerFg: "#ffffff", bandBg: accent.dark, baseBg: accent.base,
      borderH: "transparent", borderV: "", outerBorder: "#333333", dashColor: "#ffffff",
    });
  });

  // Sort by category order (light, medium, dark), then by id number
  const catOrder = { light: 0, medium: 1, dark: 2 };
  styles.sort((a, b) => {
    const catDiff = catOrder[a.category] - catOrder[b.category];
    if (catDiff !== 0) return catDiff;
    const aNum = parseInt(a.id.split("-").pop()!);
    const bNum = parseInt(b.id.split("-").pop()!);
    return aNum - bNum;
  });

  return styles;
}

export const TABLE_STYLES = generateTableStyles();
export const TABLE_STYLES_BY_ID = new Map(TABLE_STYLES.map((s) => [s.id, s]));

// Default style (Excel's TableStyleMedium2 equivalent)
export const DEFAULT_TABLE_STYLE_ID = "table-medium-2";

// ============================================================================
// Canvas Thumbnail Rendering
// ============================================================================

const THUMB_ROWS = 5;
const THUMB_COLS = 4;

function drawTableThumbnail(
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
    const fg = isHeader ? thumb.headerFg : thumb.dashColor;
    ctx.fillStyle = fg;
    for (let c = 0; c < THUMB_COLS; c++) {
      const x = c * colW + dashMarginX;
      const dw = colW - dashMarginX * 2;
      const dy = y + (rowH - (isHeader ? headerDashH : dashH)) / 2;
      ctx.fillRect(x, dy, dw, isHeader ? headerDashH : dashH);
    }

    // Vertical borders
    if (thumb.borderV) {
      ctx.fillStyle = thumb.borderV;
      for (let c = 1; c < THUMB_COLS; c++) {
        ctx.fillRect(c * colW, y, 0.5, rowH);
      }
    }

    y += rowH;

    // Horizontal border after row
    if (r < THUMB_ROWS - 1) {
      if (isHeader && thumb.headerBorderBottom) {
        ctx.fillStyle = thumb.headerBorderBottom;
        ctx.fillRect(0, y, w, borderW);
      } else if (thumb.borderH && thumb.borderH !== "transparent") {
        ctx.fillStyle = thumb.borderH;
        ctx.fillRect(0, y, w, borderW);
      }
      y += borderW;
    }
  }

  // Outer border
  ctx.strokeStyle = thumb.outerBorder;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
}

// ============================================================================
// TableStyleThumbnail Component
// ============================================================================

const THUMB_W = 72;
const THUMB_H = 50;

interface ThumbnailProps {
  style: TableStyleDef;
  selected?: boolean;
  onClick?: () => void;
  width?: number;
  height?: number;
}

function TableStyleThumbnail({ style, selected, onClick, width = THUMB_W, height = THUMB_H }: ThumbnailProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dpr = window.devicePixelRatio || 1;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    drawTableThumbnail(ctx, style.thumb, width, height);
  }, [style, width, height, dpr]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width,
        height,
        cursor: "pointer",
        borderRadius: 2,
        outline: selected ? "2px solid #005fb8" : "2px solid transparent",
        outlineOffset: -1,
      }}
      title={style.id}
      onClick={onClick}
      onMouseEnter={(e) => {
        if (!selected) {
          (e.currentTarget as HTMLCanvasElement).style.outline = "2px solid #80b8e0";
        }
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLCanvasElement).style.outline = selected
          ? "2px solid #005fb8"
          : "2px solid transparent";
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

  // Full dropdown gallery
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
    font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;

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
    font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
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
  light: "Light",
  medium: "Medium",
  dark: "Dark",
};

const CATEGORY_ORDER = ["light", "medium", "dark"] as const;

// ============================================================================
// TableStylesDropdown Component (full gallery)
// ============================================================================

interface DropdownProps {
  anchorRect: DOMRect;
  selectedStyleId: string;
  onSelect: (styleId: string) => void;
  onClear: () => void;
  onClose: () => void;
}

function TableStylesDropdown({ anchorRect, selectedStyleId, onSelect, onClear, onClose }: DropdownProps) {
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
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const grouped = useMemo(
    () =>
      CATEGORY_ORDER.map((cat) => ({
        category: cat,
        label: CATEGORY_LABELS[cat],
        items: TABLE_STYLES.filter((s) => s.category === cat),
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
                <TableStyleThumbnail
                  key={styleDef.id}
                  style={styleDef}
                  selected={styleDef.id === selectedStyleId}
                  onClick={() => {
                    onSelect(styleDef.id);
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
          New Table Style...
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
// Collapsed "Quick Styles" button (shown when ribbon is too narrow for strip)
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
    font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
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

/** Small icon thumbnail drawn on canvas for the collapsed Quick Styles button. */
function QuickStyleIcon({ style }: { style: TableStyleDef }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dpr = window.devicePixelRatio || 1;
  const size = 32;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);
    drawTableThumbnail(ctx, style.thumb, size, size);
  }, [style, dpr]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size, borderRadius: 2 }}
    />
  );
}

// ============================================================================
// TableStylesGallery Component (collapsed strip for ribbon, responsive)
// ============================================================================

interface GalleryProps {
  selectedStyleId: string;
  onStyleSelect: (styleId: string) => void;
  onStyleClear: () => void;
  /** When true, collapse to a compact "Quick Styles" button (driven by useRibbonCollapse). */
  collapsed?: boolean;
}

// Show Medium Group 0 (styles 1-7) in the collapsed strip by default
const STRIP_STYLES = TABLE_STYLES.filter(
  (s) => s.category === "medium" && parseInt(s.id.split("-").pop()!) >= 1 && parseInt(s.id.split("-").pop()!) <= 7,
);

/** Width of one thumbnail + gap in the strip */
const THUMB_STRIP_W = 62 + 3; // width + gap
/** Minimum width to show at least one thumbnail + dropdown button */
const MIN_STRIP_W = 62 + 18 + 12; // thumb + button + padding
/** Width threshold below which we collapse to the Quick Styles button */
const COLLAPSE_THRESHOLD = MIN_STRIP_W;

export function TableStylesGallery({ selectedStyleId, onStyleSelect, onStyleClear, collapsed = false }: GalleryProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [availableWidth, setAvailableWidth] = useState<number>(9999);

  // Observe own container width to determine how many thumbs to show
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

  // Collapse via prop (from useRibbonCollapse) or when container is too narrow
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

  // Find the selected style def for the collapsed icon
  const selectedDef = TABLE_STYLES_BY_ID.get(selectedStyleId) ?? STRIP_STYLES[0];

  return (
    <div ref={containerRef} className={galleryStyles.stripContainer}>
      {isCollapsed ? (
        // Collapsed: "Quick Styles" button
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
        // Expanded: thumbnail strip
        <div className={galleryStyles.stripRow}>
          <div className={galleryStyles.stripThumbnails}>
            {STRIP_STYLES.slice(0, visibleCount).map((styleDef) => (
              <TableStyleThumbnail
                key={styleDef.id}
                style={styleDef}
                width={62}
                height={44}
                selected={styleDef.id === selectedStyleId}
                onClick={() => onStyleSelect(styleDef.id)}
              />
            ))}
          </div>
          <button
            className={galleryStyles.dropdownButton}
            onClick={handleOpenDropdown}
            title="More Table Styles"
          >
            &#9660;
          </button>
        </div>
      )}
      <div className={galleryStyles.groupLabel}>Table Styles</div>

      {isOpen && anchorRect && (
        <TableStylesDropdown
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
