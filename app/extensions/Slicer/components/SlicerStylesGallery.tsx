//! FILENAME: app/extensions/Slicer/components/SlicerStylesGallery.tsx
// PURPOSE: Slicer Styles gallery for the Slicer Options ribbon tab.
// CONTEXT: Provides predefined slicer styles matching Excel's Slicer Styles gallery.
// Shows a collapsed strip in the ribbon with a dropdown for the full gallery.

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import ReactDOM from "react-dom";
import { css } from "@emotion/css";

// ============================================================================
// Types
// ============================================================================

interface SlicerThumbColors {
  headerBg: string;
  headerFg: string;
  selectedBg: string;
  selectedFg: string;
  itemBg: string;
  itemFg: string;
  bg: string;
  border: string;
}

export interface SlicerStyleDef {
  id: string;
  category: "light" | "dark";
  group: number;
  accentIndex: number;
  thumb: SlicerThumbColors;
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
  styles: SlicerStyleDef[],
  category: SlicerStyleDef["category"],
  group: number,
  accentIndex: number,
  thumb: SlicerThumbColors,
): void {
  const num = group * 7 + accentIndex + 1;
  styles.push({ id: `slicer-${category}-${num}`, category, group, accentIndex, thumb });
}

function generateSlicerStyles(): SlicerStyleDef[] {
  const styles: SlicerStyleDef[] = [];

  STYLE_ACCENTS.forEach((accent, i) => {
    // --- LIGHT Group 0 (Light 1-7): White bg, colored header, light item bg ---
    addStyle(styles, "light", 0, i, {
      headerBg: accent.base,
      headerFg: "#ffffff",
      selectedBg: accent.base,
      selectedFg: "#ffffff",
      itemBg: accent.lighter,
      itemFg: "#333333",
      bg: "#ffffff",
      border: accent.medium,
    });
    // --- LIGHT Group 1 (Light 8-14): White bg, subtle header, bordered items ---
    addStyle(styles, "light", 1, i, {
      headerBg: accent.light,
      headerFg: accent.dark,
      selectedBg: accent.base,
      selectedFg: "#ffffff",
      itemBg: "#ffffff",
      itemFg: "#333333",
      bg: "#ffffff",
      border: accent.medium,
    });
    // --- LIGHT Group 2 (Light 15-21): Clean white, no item bg, accent selected ---
    addStyle(styles, "light", 2, i, {
      headerBg: "#ffffff",
      headerFg: accent.dark,
      selectedBg: accent.light,
      selectedFg: accent.dark,
      itemBg: "#ffffff",
      itemFg: "#666666",
      bg: "#ffffff",
      border: accent.medium,
    });
    // --- LIGHT Group 3 (Light 22-28): Banded look, accent header border ---
    addStyle(styles, "light", 3, i, {
      headerBg: accent.base,
      headerFg: "#ffffff",
      selectedBg: accent.medium,
      selectedFg: "#ffffff",
      itemBg: accent.light,
      itemFg: "#333333",
      bg: accent.lighter,
      border: accent.base,
    });

    // --- DARK Group 0 (Dark 1-7): Dark bg, accent header, lighter items ---
    addStyle(styles, "dark", 0, i, {
      headerBg: accent.dark,
      headerFg: "#ffffff",
      selectedBg: accent.base,
      selectedFg: "#ffffff",
      itemBg: "#444444",
      itemFg: "#eeeeee",
      bg: "#333333",
      border: "#555555",
    });
    // --- DARK Group 1 (Dark 8-14): Full accent dark ---
    addStyle(styles, "dark", 1, i, {
      headerBg: accent.dark,
      headerFg: "#ffffff",
      selectedBg: accent.medium,
      selectedFg: "#ffffff",
      itemBg: accent.dark,
      itemFg: "#eeeeee",
      bg: "#2a2a2a",
      border: accent.dark,
    });
  });

  // Sort by category order (light, dark), then by id number
  const catOrder = { light: 0, dark: 1 };
  styles.sort((a, b) => {
    const catDiff = catOrder[a.category] - catOrder[b.category];
    if (catDiff !== 0) return catDiff;
    const aNum = parseInt(a.id.split("-").pop()!);
    const bNum = parseInt(b.id.split("-").pop()!);
    return aNum - bNum;
  });

  return styles;
}

export const SLICER_STYLES = generateSlicerStyles();
export const SLICER_STYLES_BY_ID = new Map(SLICER_STYLES.map((s) => [s.id, s]));

// Default style
export const DEFAULT_SLICER_STYLE_ID = "slicer-light-2"; // Blue accent, colored header

// ============================================================================
// Canvas Thumbnail Rendering
// ============================================================================

const THUMB_ITEMS = 4;

function drawSlicerThumbnail(
  ctx: CanvasRenderingContext2D,
  thumb: SlicerThumbColors,
  w: number,
  h: number,
): void {
  const headerH = Math.floor(h * 0.22);
  const itemAreaH = h - headerH;
  const itemH = Math.floor(itemAreaH / THUMB_ITEMS);
  const itemPad = 2;
  const dashH = 1.5;
  const dashMarginX = 4;

  ctx.clearRect(0, 0, w, h);

  // Background
  ctx.fillStyle = thumb.bg;
  ctx.fillRect(0, 0, w, h);

  // Header bar
  ctx.fillStyle = thumb.headerBg;
  ctx.fillRect(0, 0, w, headerH);

  // Header text dash
  ctx.fillStyle = thumb.headerFg;
  ctx.fillRect(dashMarginX, (headerH - 2) / 2, w * 0.5, 2);

  // Items
  for (let i = 0; i < THUMB_ITEMS; i++) {
    const y = headerH + i * itemH;
    const isSelected = i === 0; // First item is "selected"

    ctx.fillStyle = isSelected ? thumb.selectedBg : thumb.itemBg;
    ctx.fillRect(itemPad, y + 1, w - itemPad * 2, itemH - 2);

    // Item text dash
    ctx.fillStyle = isSelected ? thumb.selectedFg : thumb.itemFg;
    ctx.fillRect(dashMarginX + itemPad, y + (itemH - dashH) / 2, w * 0.45, dashH);
  }

  // Border
  ctx.strokeStyle = thumb.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
}

// ============================================================================
// SlicerStyleThumbnail Component
// ============================================================================

const THUMB_W = 56;
const THUMB_H = 56;

interface ThumbnailProps {
  style: SlicerStyleDef;
  selected?: boolean;
  onClick?: () => void;
  width?: number;
  height?: number;
}

function SlicerStyleThumbnail({ style, selected, onClick, width = THUMB_W, height = THUMB_H }: ThumbnailProps) {
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

    drawSlicerThumbnail(ctx, style.thumb, width, height);
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
    align-self: stretch;
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
  dark: "Dark",
};

const CATEGORY_ORDER = ["light", "dark"] as const;

// ============================================================================
// SlicerStylesDropdown Component (full gallery)
// ============================================================================

interface DropdownProps {
  anchorRect: DOMRect;
  selectedStyleId: string | null;
  onSelect: (styleId: string) => void;
  onClose: () => void;
}

function SlicerStylesDropdown({ anchorRect, selectedStyleId, onSelect, onClose }: DropdownProps) {
  const ref = useRef<HTMLDivElement>(null);

  const pos = useMemo(() => {
    const dropdownW = 460;
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
        items: SLICER_STYLES.filter((s) => s.category === cat),
      })),
    [],
  );

  return ReactDOM.createPortal(
    <>
      <div className={galleryStyles.dropdownOverlay} onClick={onClose} />
      <div
        ref={ref}
        className={galleryStyles.dropdown}
        style={{ top: pos.top, left: pos.left, width: 460 }}
      >
        {grouped.map((group) => (
          <div key={group.category}>
            <div className={galleryStyles.categoryLabel}>{group.label}</div>
            <div className={galleryStyles.styleGrid}>
              {group.items.map((styleDef) => (
                <SlicerStyleThumbnail
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
          New Slicer Style...
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
function QuickStyleIcon({ style }: { style: SlicerStyleDef }) {
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
    drawSlicerThumbnail(ctx, style.thumb, size, size);
  }, [style, dpr]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size, borderRadius: 2 }}
    />
  );
}

// ============================================================================
// SlicerStylesGallery Component
// ============================================================================

interface GalleryProps {
  selectedStyleId: string | null;
  onStyleSelect: (styleId: string) => void;
  collapsed?: boolean;
}

// Show Light Group 0 (styles 1-7) in the collapsed strip by default
const STRIP_STYLES = SLICER_STYLES.filter(
  (s) => s.category === "light" && s.group === 0,
);

/** Width of one thumbnail + gap in the strip */
const THUMB_STRIP_W = THUMB_W + 3;
/** Minimum width to show at least one thumbnail + dropdown button */
const MIN_STRIP_W = THUMB_W + 18 + 12;
/** Width threshold below which we collapse to the Quick Styles button */
const COLLAPSE_THRESHOLD = MIN_STRIP_W;

export function SlicerStylesGallery({ selectedStyleId, onStyleSelect, collapsed = false }: GalleryProps) {
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

  const selectedDef = (selectedStyleId ? SLICER_STYLES_BY_ID.get(selectedStyleId) : undefined) ?? STRIP_STYLES[0];

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
              <SlicerStyleThumbnail
                key={styleDef.id}
                style={styleDef}
                width={50}
                height={50}
                selected={styleDef.id === selectedStyleId}
                onClick={() => onStyleSelect(styleDef.id)}
              />
            ))}
          </div>
          <button
            className={galleryStyles.dropdownButton}
            onClick={handleOpenDropdown}
            title="More Slicer Styles"
          >
            &#9660;
          </button>
        </div>
      )}
      <div className={galleryStyles.groupLabel}>Slicer Styles</div>

      {isOpen && anchorRect && (
        <SlicerStylesDropdown
          anchorRect={anchorRect}
          selectedStyleId={selectedStyleId}
          onSelect={onStyleSelect}
          onClose={handleClose}
        />
      )}
    </div>
  );
}
