//! FILENAME: app/extensions/_shared/components/CellStylesGallery.tsx
// PURPOSE: Cell Styles gallery for the Home tab ribbon and Format menu.
// CONTEXT: Provides predefined cell styles matching Excel's Cell Styles gallery.
//
//          The catalog (CELL_STYLES) is colour DATA — each entry is the
//          formatting a style writes into cells — so its literals stay. The
//          gallery around it is the ONE @api StyleGallery: a grouped, keyboard-
//          operable listbox of thumbnails (arrows move, Enter/Space/click
//          apply), each thumbnail a small drawing of a cell in that style. It
//          used to be a hand-rolled grid of buttons on the MENU's dark
//          background (#2b2b2b fallback), so "Heading 1"'s dark blue text sat on
//          near-black; a thumbnail now shows what the cell will look like — the
//          style's own fill and text colour, and the grid's own background and
//          text where the style sets none.
//
//          The gallery always renders as a grid, never as the band strip: it is
//          hosted INSIDE a popover (the Home "Cell Styles" hero) or a menu (the
//          Format menu), and a popover portalled out of the ribbon band would
//          otherwise inherit the band's surface layout through React context.

import React, { useCallback, useMemo } from "react";
import { css } from "@emotion/css";
import {
  LT,
  FONT_FAMILY,
  StyleGallery,
  SurfaceLayoutProvider,
  popoverLayout,
} from "@api/layout";
import type { StyleGalleryItem, StyleThumbSize } from "@api/layout";

// ============================================================================
// Style Definitions
// ============================================================================

export interface CellStyleDefinition {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** Category for grouping in gallery */
  category: "good-bad-neutral" | "data-model" | "titles-headings" | "themed" | "number-format";
  /** Formatting to apply */
  formatting: {
    bold?: boolean;
    italic?: boolean;
    underline?: string;
    fontSize?: number;
    fontFamily?: string;
    textColor?: string;
    backgroundColor?: string;
    numberFormat?: string;
    borderTop?: { style: string; color: string };
    borderBottom?: { style: string; color: string };
    borderLeft?: { style: string; color: string };
    borderRight?: { style: string; color: string };
  };
}

// ---------------------------------------------------------------------------
// Accent color palette (6 theme accents)
// ---------------------------------------------------------------------------

const ACCENTS = [
  { name: "Accent1", base: "#4472c4", p20: "#d6e4f0", p40: "#b4c6e7", p60: "#8faadc", text20: "#1f4e79", text40: "#1f4e79", text60: "#1f4e79" },
  { name: "Accent2", base: "#ed7d31", p20: "#fbe5d6", p40: "#f8cbad", p60: "#f4b183", text20: "#843c0c", text40: "#843c0c", text60: "#843c0c" },
  { name: "Accent3", base: "#a5a5a5", p20: "#ededed", p40: "#dbdbdb", p60: "#c0c0c0", text20: "#3f3f3f", text40: "#3f3f3f", text60: "#3f3f3f" },
  { name: "Accent4", base: "#ffc000", p20: "#fff2cc", p40: "#ffe699", p60: "#ffd966", text20: "#806000", text40: "#806000", text60: "#806000" },
  { name: "Accent5", base: "#5b9bd5", p20: "#deeaf6", p40: "#bdd7ee", p60: "#9bc2e6", text20: "#1f4e79", text40: "#1f4e79", text60: "#1f4e79" },
  { name: "Accent6", base: "#70ad47", p20: "#e2efda", p40: "#c5e0b4", p60: "#a9d18e", text20: "#375623", text40: "#375623", text60: "#375623" },
];

// ---------------------------------------------------------------------------
// Predefined Styles Catalog
// ---------------------------------------------------------------------------

export const CELL_STYLES: CellStyleDefinition[] = [
  // --- Good / Bad / Neutral ---
  {
    id: "normal", name: "Normal", category: "good-bad-neutral",
    formatting: { textColor: "#000000", backgroundColor: "#ffffff" },
  },
  {
    id: "bad", name: "Bad", category: "good-bad-neutral",
    formatting: { textColor: "#9c0006", backgroundColor: "#ffc7ce" },
  },
  {
    id: "good", name: "Good", category: "good-bad-neutral",
    formatting: { textColor: "#006100", backgroundColor: "#c6efce" },
  },
  {
    id: "neutral", name: "Neutral", category: "good-bad-neutral",
    formatting: { textColor: "#9c5700", backgroundColor: "#ffeb9c" },
  },

  // --- Data & Model ---
  {
    id: "calculation", name: "Calculation", category: "data-model",
    formatting: {
      bold: true, textColor: "#fa7d00", backgroundColor: "#f2f2f2",
      borderTop: { style: "thin", color: "#7f7f7f" }, borderBottom: { style: "thin", color: "#7f7f7f" },
      borderLeft: { style: "thin", color: "#7f7f7f" }, borderRight: { style: "thin", color: "#7f7f7f" },
    },
  },
  {
    id: "check-cell", name: "Check Cell", category: "data-model",
    formatting: {
      bold: true, textColor: "#ffffff", backgroundColor: "#a5a5a5",
      borderTop: { style: "thin", color: "#3f3f3f" }, borderBottom: { style: "thin", color: "#3f3f3f" },
      borderLeft: { style: "thin", color: "#3f3f3f" }, borderRight: { style: "thin", color: "#3f3f3f" },
    },
  },
  {
    id: "explanatory", name: "Explanatory...", category: "data-model",
    formatting: { italic: true, textColor: "#7f7f7f" },
  },
  {
    id: "input", name: "Input", category: "data-model",
    formatting: {
      textColor: "#3f3f76", backgroundColor: "#ffcc99",
      borderTop: { style: "thin", color: "#7f7f7f" }, borderBottom: { style: "thin", color: "#7f7f7f" },
      borderLeft: { style: "thin", color: "#7f7f7f" }, borderRight: { style: "thin", color: "#7f7f7f" },
    },
  },
  {
    id: "linked-cell", name: "Linked Cell", category: "data-model",
    formatting: {
      textColor: "#fa7d00",
      borderBottom: { style: "thin", color: "#ff8001" },
    },
  },
  {
    id: "note", name: "Note", category: "data-model",
    formatting: {
      textColor: "#3f3f3f", backgroundColor: "#ffffcc",
      borderTop: { style: "thin", color: "#b2b2b2" }, borderBottom: { style: "thin", color: "#b2b2b2" },
      borderLeft: { style: "thin", color: "#b2b2b2" }, borderRight: { style: "thin", color: "#b2b2b2" },
    },
  },
  {
    id: "output", name: "Output", category: "data-model",
    formatting: {
      bold: true, textColor: "#3f3f3f", backgroundColor: "#f2f2f2",
      borderTop: { style: "thin", color: "#3f3f3f" }, borderBottom: { style: "thin", color: "#3f3f3f" },
      borderLeft: { style: "thin", color: "#3f3f3f" }, borderRight: { style: "thin", color: "#3f3f3f" },
    },
  },
  {
    id: "warning", name: "Warning Text", category: "data-model",
    formatting: { textColor: "#ff0000" },
  },

  // --- Titles & Headings ---
  {
    id: "heading1", name: "Heading 1", category: "titles-headings",
    formatting: {
      bold: true, fontSize: 15, textColor: "#1f4e79",
      borderBottom: { style: "thick", color: "#4472c4" },
    },
  },
  {
    id: "heading2", name: "Heading 2", category: "titles-headings",
    formatting: {
      bold: true, fontSize: 13, textColor: "#1f4e79",
      borderBottom: { style: "thin", color: "#4472c4" },
    },
  },
  {
    id: "heading3", name: "Heading 3", category: "titles-headings",
    formatting: { bold: true, textColor: "#1f4e79" },
  },
  {
    id: "heading4", name: "Heading 4", category: "titles-headings",
    formatting: { bold: true, italic: true, textColor: "#1f4e79" },
  },
  {
    id: "title", name: "Title", category: "titles-headings",
    formatting: { bold: true, fontSize: 18, textColor: "#1f4e79" },
  },
  {
    id: "total", name: "Total", category: "titles-headings",
    formatting: {
      bold: true, textColor: "#1f4e79",
      borderTop: { style: "thin", color: "#4472c4" },
      borderBottom: { style: "double", color: "#4472c4" },
    },
  },

  // --- Themed Accent Styles (generated from ACCENTS palette) ---
  ...ACCENTS.flatMap((a, i) => [
    { id: `20pct-accent${i + 1}`, name: `20% - ${a.name}`, category: "themed" as const,
      formatting: { textColor: a.text20, backgroundColor: a.p20 } },
  ]),
  ...ACCENTS.flatMap((a, i) => [
    { id: `40pct-accent${i + 1}`, name: `40% - ${a.name}`, category: "themed" as const,
      formatting: { textColor: a.text40, backgroundColor: a.p40 } },
  ]),
  ...ACCENTS.flatMap((a, i) => [
    { id: `60pct-accent${i + 1}`, name: `60% - ${a.name}`, category: "themed" as const,
      formatting: { textColor: a.text60, backgroundColor: a.p60 } },
  ]),
  ...ACCENTS.flatMap((a, i) => [
    { id: `accent${i + 1}`, name: a.name, category: "themed" as const,
      formatting: { textColor: "#ffffff", backgroundColor: a.base } },
  ]),

  // --- Number Format Styles ---
  {
    id: "comma", name: "Comma", category: "number-format",
    formatting: { numberFormat: "#,##0.00" },
  },
  {
    id: "comma-0", name: "Comma [0]", category: "number-format",
    formatting: { numberFormat: "#,##0" },
  },
  {
    id: "currency", name: "Currency", category: "number-format",
    formatting: { numberFormat: "$#,##0.00" },
  },
  {
    id: "currency-0", name: "Currency [0]", category: "number-format",
    formatting: { numberFormat: "$#,##0" },
  },
  {
    id: "percent", name: "Percent", category: "number-format",
    formatting: { numberFormat: "0%" },
  },
];

// Lookup for quick access
export const CELL_STYLES_BY_ID = new Map(CELL_STYLES.map((s) => [s.id, s]));

// ---------------------------------------------------------------------------
// Category metadata
// ---------------------------------------------------------------------------

type CellStyleCategory = CellStyleDefinition["category"];

/** Heading per category, in gallery order. */
const CATEGORIES: ReadonlyArray<readonly [CellStyleCategory, string]> = [
  ["good-bad-neutral", "Good, Bad and Neutral"],
  ["data-model", "Data and Model"],
  ["titles-headings", "Titles and Headings"],
  ["themed", "Themed Cell Styles"],
  ["number-format", "Number Format"],
];

// ============================================================================
// Gallery geometry + chrome
// ============================================================================

/** One thumbnail: wide enough for "20% - Accent1" at 11px, as tall as a row. */
const THUMB_SIZE: StyleThumbSize = { w: 76, h: 26 };

/** Six columns: the themed block reads as one accent per column, one tint
 *  level per row (20%, 40%, 60%, full), exactly as Excel lays it out. */
const GALLERY_COLUMNS = 6;

/** The cell a style leaves unset looks like the grid's own cell. */
const CELL_DEFAULT_BG = "var(--grid-bg, #ffffff)";
const CELL_DEFAULT_FG = "var(--grid-text, #000000)";
/** Hairline around a thumbnail with no border of its own, so a white "Normal"
 *  cell is still visible on a white popover. */
const CELL_EDGE = "var(--grid-line, #e0e0e0)";

const galleryRoot = css`
  box-sizing: border-box;
  max-height: 520px;
  overflow-y: auto;
  font-family: ${FONT_FAMILY};
  color: ${LT.text};
`;

/** Inline (a menu's custom content): the menu draws the chrome. */
const inlineChrome = css`
  padding: 4px 8px 8px;
`;

/** Standalone (inside the Home hero's plain Popover): the card chrome every
 *  Clusters popover shares. */
const cardChrome = css`
  padding: 8px;
  background: ${LT.surface};
  border: 1px solid ${LT.clusterBorder};
  border-radius: ${LT.radiusPopover};
  box-shadow: ${LT.shadowPopover};
`;

const thumbCell = css`
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  padding: 0 4px;
  overflow: hidden;
  line-height: 1;
`;

const thumbText = css`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

// ============================================================================
// Helper: the thumbnail drawing
// ============================================================================

/** Excel's automatic cell colours: a style that "sets" them sets nothing a
 *  thumbnail should paint over the grid's own look. */
function isAutomaticText(color: string | undefined): boolean {
  return !color || color.toLowerCase() === "#000000";
}
function isAutomaticFill(color: string | undefined): boolean {
  return !color || color.toLowerCase() === "#ffffff";
}

function borderCss(edge: { style: string; color: string } | undefined): string | undefined {
  if (!edge || edge.style === "none") return undefined;
  if (edge.style === "double") return `3px double ${edge.color}`;
  if (edge.style === "thick") return `2px solid ${edge.color}`;
  return `1px solid ${edge.color}`;
}

/**
 * Inline styles that draw a cell in the given style. Exported for tests: the
 * values are DATA (the style's own colours) plus the grid's tokens for what the
 * style leaves unset.
 */
export function cellStyleThumbStyle(def: CellStyleDefinition): React.CSSProperties {
  const f = def.formatting;
  const style: React.CSSProperties = {
    background: isAutomaticFill(f.backgroundColor) ? CELL_DEFAULT_BG : f.backgroundColor,
    color: isAutomaticText(f.textColor) ? CELL_DEFAULT_FG : f.textColor,
    fontSize: 11,
  };
  if (f.bold) style.fontWeight = 700;
  if (f.italic) style.fontStyle = "italic";
  if (f.underline && f.underline !== "none") style.textDecoration = "underline";

  const top = borderCss(f.borderTop);
  const bottom = borderCss(f.borderBottom);
  const left = borderCss(f.borderLeft);
  const right = borderCss(f.borderRight);
  if (top) style.borderTop = top;
  if (bottom) style.borderBottom = bottom;
  if (left) style.borderLeft = left;
  if (right) style.borderRight = right;
  if (!top && !bottom && !left && !right && isAutomaticFill(f.backgroundColor)) {
    style.boxShadow = `inset 0 0 0 1px ${CELL_EDGE}`;
  }

  // Scale heading/title font sizes for the thumbnail.
  if (f.fontSize) {
    if (f.fontSize >= 18) style.fontSize = 14;
    else if (f.fontSize >= 15) style.fontSize = 13;
    else if (f.fontSize >= 13) style.fontSize = 12;
    else style.fontSize = f.fontSize;
  }
  return style;
}

function renderCellThumb(def: CellStyleDefinition, size: StyleThumbSize): React.ReactNode {
  return (
    <span
      className={thumbCell}
      style={{ ...cellStyleThumbStyle(def), width: size.w, height: size.h }}
      data-colour-data=""
    >
      <span className={thumbText}>{def.name}</span>
    </span>
  );
}

/** The gallery items, grouped in category order. */
const GALLERY_ITEMS: StyleGalleryItem[] = CATEGORIES.flatMap(([cat, heading]) =>
  CELL_STYLES.filter((s) => s.category === cat).map(
    (def): StyleGalleryItem => ({
      id: def.id,
      name: def.name,
      group: heading,
      renderThumb: (size) => renderCellThumb(def, size),
    }),
  ),
);

/** What "Normal" writes: every property back to the workbook default. */
const NORMAL_RESET: CellStyleDefinition["formatting"] = {
  bold: false, italic: false, underline: "none",
  fontSize: 11, textColor: "#000000", backgroundColor: "#ffffff",
  numberFormat: "General",
  borderTop: { style: "none", color: "#000000" },
  borderBottom: { style: "none", color: "#000000" },
  borderLeft: { style: "none", color: "#000000" },
  borderRight: { style: "none", color: "#000000" },
};

// ============================================================================
// Component
// ============================================================================

interface CellStylesGalleryProps {
  onApplyStyle: (formatting: CellStyleDefinition["formatting"]) => void;
  onClose: () => void;
  /** When true, renders bare (for menu customContent); otherwise with dropdown
   *  chrome. Dismissal is the host's job in both modes — the ribbon hosts this
   *  inside an @api/layout Popover, menus inside their own dismiss logic. */
  inline?: boolean;
}

export function CellStylesGallery({ onApplyStyle, onClose, inline }: CellStylesGalleryProps) {
  const layout = useMemo(() => popoverLayout(), []);

  const handleChoose = useCallback(
    (id: string) => {
      const def = CELL_STYLES_BY_ID.get(id);
      if (!def) return;
      onApplyStyle(def.id === "normal" ? NORMAL_RESET : def.formatting);
      onClose();
    },
    [onApplyStyle, onClose],
  );

  return (
    <div
      className={`${galleryRoot} ${inline ? inlineChrome : cardChrome}`}
      data-testid="cell-styles-gallery"
    >
      <SurfaceLayoutProvider value={layout}>
        <StyleGallery
          items={GALLERY_ITEMS}
          value={null}
          onChange={handleChoose}
          label="Cell styles"
          thumbSize={THUMB_SIZE}
          columns={GALLERY_COLUMNS}
          testIdPrefix="cell-style"
        />
      </SurfaceLayoutProvider>
    </div>
  );
}
