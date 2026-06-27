//! FILENAME: app/extensions/BuiltIn/HomeTab/components/CellStylesGallery.tsx
// PURPOSE: Cell Styles gallery for the Home tab ribbon and Format menu.
// CONTEXT: Provides predefined cell styles matching Excel's Cell Styles gallery.

import React, { useEffect, useRef } from "react";
import { css } from "@emotion/css";

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

const CATEGORY_LABELS: Record<string, string> = {
  "good-bad-neutral": "Good, Bad and Neutral",
  "data-model": "Data and Model",
  "titles-headings": "Titles and Headings",
  "themed": "Themed Cell Styles",
  "number-format": "Number Format",
};

const CATEGORY_ORDER = [
  "good-bad-neutral",
  "data-model",
  "titles-headings",
  "themed",
  "number-format",
];

// ============================================================================
// Gallery Styles
// ============================================================================

const galStyles = {
  container: css`
    padding: 10px 12px;
    background: var(--menu-dropdown-bg, #2b2b2b);
    width: 460px;
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

    &:first-child {
      padding-top: 0;
    }
  `,
  grid: css`
    display: grid;
    gap: 3px;
    margin-bottom: 4px;
  `,
  styleItem: css`
    display: flex;
    align-items: center;
    justify-content: center;
    height: 28px;
    padding: 2px 6px;
    border: 1px solid var(--menu-separator, #555);
    border-radius: 2px;
    cursor: pointer;
    font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    background: var(--menu-dropdown-bg, #2b2b2b);
    color: var(--text-primary, #e0e0e0);

    &:hover {
      outline: 2px solid var(--accent-primary, #0078d4);
      outline-offset: -1px;
      z-index: 1;
    }
  `,
};

// ============================================================================
// Helper: Build preview inline styles
// ============================================================================

function getItemStyle(def: CellStyleDefinition): React.CSSProperties {
  const f = def.formatting;
  const style: React.CSSProperties = {};
  if (f.bold) style.fontWeight = 700;
  if (f.italic) style.fontStyle = "italic";
  if (f.underline && f.underline !== "none") style.textDecoration = "underline";
  if (f.textColor) style.color = f.textColor;
  if (f.backgroundColor && f.backgroundColor !== "#ffffff") {
    style.backgroundColor = f.backgroundColor;
    style.borderColor = f.backgroundColor;
  }
  if (f.borderBottom) {
    const w = f.borderBottom.style === "thick" ? "2px" :
              f.borderBottom.style === "double" ? "3px" : "1px";
    const s = f.borderBottom.style === "double" ? "double" : "solid";
    style.borderBottom = `${w} ${s} ${f.borderBottom.color}`;
  }
  if (f.borderTop) {
    const w = f.borderTop.style === "thick" ? "2px" : "1px";
    style.borderTop = `${w} solid ${f.borderTop.color}`;
  }
  // Scale heading/title font sizes for preview
  if (f.fontSize) {
    if (f.fontSize >= 18) style.fontSize = "14px";
    else if (f.fontSize >= 15) style.fontSize = "13px";
    else if (f.fontSize >= 13) style.fontSize = "12px";
    else style.fontSize = `${f.fontSize}px`;
  } else {
    style.fontSize = "11px";
  }
  return style;
}

// ============================================================================
// Component
// ============================================================================

interface CellStylesGalleryProps {
  onApplyStyle: (formatting: CellStyleDefinition["formatting"]) => void;
  onClose: () => void;
  /** When true, renders without position:absolute (for use inside menu customContent) */
  inline?: boolean;
}

export function CellStylesGallery({ onApplyStyle, onClose, inline }: CellStylesGalleryProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click (only for dropdown mode, not inline)
  useEffect(() => {
    if (inline) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose, inline]);

  // Close on Escape
  useEffect(() => {
    if (inline) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose, inline]);

  const handleClick = (def: CellStyleDefinition) => {
    if (def.id === "normal") {
      onApplyStyle({
        bold: false, italic: false, underline: "none",
        fontSize: 11, textColor: "#000000", backgroundColor: "#ffffff",
        numberFormat: "General",
        borderTop: { style: "none", color: "#000000" },
        borderBottom: { style: "none", color: "#000000" },
        borderLeft: { style: "none", color: "#000000" },
        borderRight: { style: "none", color: "#000000" },
      });
    } else {
      onApplyStyle(def.formatting);
    }
    onClose();
  };

  // Group styles by category
  const grouped = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    label: CATEGORY_LABELS[cat],
    items: CELL_STYLES.filter((s) => s.category === cat),
  })).filter((g) => g.items.length > 0);

  // Determine grid columns per category
  const getGridCols = (category: string): number => {
    switch (category) {
      case "themed": return 6;       // 6 accent columns
      case "titles-headings": return 6;
      case "number-format": return 5;
      default: return 4;
    }
  };

  const wrapperClass = inline
    ? galStyles.container
    : css`
        position: absolute;
        top: 100%;
        left: 0;
        z-index: 1100;
        margin-top: 2px;
        border: 1px solid var(--menu-border, #555);
        border-radius: 4px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
        ${galStyles.container}
      `;

  return (
    <div ref={ref} className={wrapperClass}>
      {grouped.map((group) => (
        <div key={group.category}>
          <div className={galStyles.categoryLabel}>{group.label}</div>
          <div
            className={galStyles.grid}
            style={{ gridTemplateColumns: `repeat(${getGridCols(group.category)}, 1fr)` }}
          >
            {group.items.map((def) => (
              <button
                key={def.id}
                className={galStyles.styleItem}
                style={getItemStyle(def)}
                title={def.name}
                onClick={() => handleClick(def)}
              >
                {def.name}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
