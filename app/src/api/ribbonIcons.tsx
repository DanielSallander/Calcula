//! FILENAME: app/src/api/ribbonIcons.tsx
// PURPOSE: Shared SVG icon set for ribbon buttons (Home tab and friends).
// CONTEXT: Ribbon controls historically used unicode text glyphs; these are
// proper two-tone icons in the flat Office-365 idiom. Main geometry uses
// currentColor so it follows the skin; the "verb" of the icon (insert, delete,
// wrap, ...) is accented via --accent-primary so it pops in both skins.
// Sized via the `size` prop (16 default, heroes pass ~26); drawn on a 16 grid.

import React from "react";

export interface RibbonIconProps {
  /** Rendered width/height in px. Defaults to 16; hero commands pass ~26. */
  size?: number;
}

/** Accent for constructive/primary verbs (insert, wrap, increase...). */
const ACCENT = "var(--icon-accent, var(--accent-primary, #10b981))";
/** Accent for destructive verbs (delete row/column). Chains through the
 *  skin-flipped error token so the red stays legible on the dark skin. */
const DANGER = "var(--icon-danger, var(--text-error, #c42b1c))";
const FONT = "'Segoe UI', system-ui, sans-serif";

function Svg({
  size = 16,
  sw = 1.3,
  children,
}: {
  size?: number;
  sw?: number;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flex: "none" }}
      aria-hidden
    >
      {children}
    </svg>
  );
}

// ============================================================================
// Clipboard
// ============================================================================

function Cut({ size }: RibbonIconProps) {
  return (
    <Svg size={size}>
      <circle cx="4.4" cy="12.4" r="2.1" />
      <circle cx="11.6" cy="12.4" r="2.1" />
      <line x1="5.7" y1="10.7" x2="10.2" y2="1.8" />
      <line x1="10.3" y1="10.7" x2="5.8" y2="1.8" />
    </Svg>
  );
}

function Copy({ size }: RibbonIconProps) {
  return (
    <Svg size={size}>
      <path d="M10.5 4.5V2.6a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7.8a1 1 0 0 0 1 1h1.9" />
      <rect x="5.5" y="4.5" width="8.5" height="10" rx="1" />
    </Svg>
  );
}

function Paste({ size }: RibbonIconProps) {
  return (
    <Svg size={size}>
      <path d="M10.8 2.7h1.2a1 1 0 0 1 1 1V5" />
      <path d="M5.2 2.7H4a1 1 0 0 0-1 1v9.6a1 1 0 0 0 1 1h3.2" />
      <rect x="5.2" y="1.2" width="5.6" height="2.9" rx="0.8" />
      <g stroke={ACCENT}>
        <path d="M9 6.4h4.1l1.4 1.4v6.4H9V6.4z" />
        <path d="M13.1 6.4v1.4h1.4" />
      </g>
    </Svg>
  );
}

function FormatPainter({ size }: RibbonIconProps) {
  return (
    <Svg size={size}>
      <line x1="13.2" y1="2.2" x2="9.4" y2="6" strokeWidth="2" />
      <path
        d="M9.1 6.1l1.8 1.8c-.9 2.7-4.1 4.8-8.3 5.4 2.1-2 3.8-4.4 4.7-6.9z"
        fill={ACCENT}
        fillOpacity="0.25"
      />
    </Svg>
  );
}

// ============================================================================
// Font
// ============================================================================

function FontSizeUp({ size }: RibbonIconProps) {
  return (
    <Svg size={size}>
      <path d="M2.2 12.5L6 3l3.8 9.5" />
      <line x1="3.6" y1="9.3" x2="8.4" y2="9.3" />
      <g stroke={ACCENT} strokeWidth="1.5">
        <line x1="13" y1="12" x2="13" y2="4.4" />
        <polyline points="10.8,6.6 13,4.2 15.2,6.6" />
      </g>
    </Svg>
  );
}

function FontSizeDown({ size }: RibbonIconProps) {
  return (
    <Svg size={size}>
      <path d="M2.2 12.5L6 3l3.8 9.5" />
      <line x1="3.6" y1="9.3" x2="8.4" y2="9.3" />
      <g stroke={ACCENT} strokeWidth="1.5">
        <line x1="13" y1="4.2" x2="13" y2="11.8" />
        <polyline points="10.8,9.6 13,12 15.2,9.6" />
      </g>
    </Svg>
  );
}

function FormatCells({ size }: RibbonIconProps) {
  return (
    <Svg size={size}>
      <rect x="1.8" y="2.5" width="12.4" height="11" rx="1.2" />
      <line x1="1.8" y1="5.4" x2="14.2" y2="5.4" />
      <line x1="4.2" y1="8" x2="11.8" y2="8" strokeWidth="1" />
      <line x1="4.2" y1="10.6" x2="8.8" y2="10.6" strokeWidth="1" />
    </Svg>
  );
}

function FillColor({ size }: RibbonIconProps) {
  return (
    <Svg size={size}>
      <path d="M12.7 7.3L7.3 2 1.6 7.7a1.35 1.35 0 0 0 0 1.9L5.1 13c.5.5 1.3.5 1.9 0l5.7-5.7z" />
      <line x1="3.3" y1="1.3" x2="6.6" y2="4.6" />
      <path
        d="M14.7 13.2a1.35 1.35 0 1 1-2.7 0c0-1.1 1.15-1.6 1.35-2.7.2 1.1 1.35 1.6 1.35 2.7z"
        fill={ACCENT}
        stroke="none"
      />
    </Svg>
  );
}

// ============================================================================
// Alignment
// ============================================================================

function AlignTop({ size }: RibbonIconProps) {
  return (
    <Svg size={size}>
      <rect x="2" y="2" width="12" height="12" rx="1" opacity="0.5" />
      <line x1="4.4" y1="5" x2="11.6" y2="5" strokeWidth="1.5" />
      <line x1="4.4" y1="7.6" x2="9.4" y2="7.6" strokeWidth="1.5" />
    </Svg>
  );
}

function AlignMiddle({ size }: RibbonIconProps) {
  return (
    <Svg size={size}>
      <rect x="2" y="2" width="12" height="12" rx="1" opacity="0.5" />
      <line x1="4.4" y1="6.7" x2="11.6" y2="6.7" strokeWidth="1.5" />
      <line x1="4.4" y1="9.3" x2="9.4" y2="9.3" strokeWidth="1.5" />
    </Svg>
  );
}

function AlignBottom({ size }: RibbonIconProps) {
  return (
    <Svg size={size}>
      <rect x="2" y="2" width="12" height="12" rx="1" opacity="0.5" />
      <line x1="4.4" y1="8.4" x2="9.4" y2="8.4" strokeWidth="1.5" />
      <line x1="4.4" y1="11" x2="11.6" y2="11" strokeWidth="1.5" />
    </Svg>
  );
}

function AlignLeft({ size }: RibbonIconProps) {
  return (
    <Svg size={size} sw={1.5}>
      <line x1="2" y1="3.2" x2="14" y2="3.2" />
      <line x1="2" y1="6.4" x2="9.5" y2="6.4" />
      <line x1="2" y1="9.6" x2="14" y2="9.6" />
      <line x1="2" y1="12.8" x2="9.5" y2="12.8" />
    </Svg>
  );
}

function AlignCenter({ size }: RibbonIconProps) {
  return (
    <Svg size={size} sw={1.5}>
      <line x1="2" y1="3.2" x2="14" y2="3.2" />
      <line x1="4.25" y1="6.4" x2="11.75" y2="6.4" />
      <line x1="2" y1="9.6" x2="14" y2="9.6" />
      <line x1="4.25" y1="12.8" x2="11.75" y2="12.8" />
    </Svg>
  );
}

function AlignRight({ size }: RibbonIconProps) {
  return (
    <Svg size={size} sw={1.5}>
      <line x1="2" y1="3.2" x2="14" y2="3.2" />
      <line x1="6.5" y1="6.4" x2="14" y2="6.4" />
      <line x1="2" y1="9.6" x2="14" y2="9.6" />
      <line x1="6.5" y1="12.8" x2="14" y2="12.8" />
    </Svg>
  );
}

function WrapText({ size }: RibbonIconProps) {
  return (
    <Svg size={size} sw={1.5}>
      <line x1="2" y1="3.8" x2="14" y2="3.8" />
      <g stroke={ACCENT}>
        <path d="M2 8h9.3a2.2 2.2 0 0 1 0 4.4H8.2" />
        <polyline points="9.9,10.5 8,12.4 9.9,14.3" />
      </g>
    </Svg>
  );
}

function IndentIncrease({ size }: RibbonIconProps) {
  return (
    <Svg size={size} sw={1.5}>
      <line x1="7.5" y1="3.2" x2="14" y2="3.2" />
      <line x1="7.5" y1="8" x2="14" y2="8" />
      <line x1="7.5" y1="12.8" x2="14" y2="12.8" />
      <g stroke={ACCENT}>
        <line x1="1.5" y1="8" x2="4.6" y2="8" />
        <polyline points="3.2,6.2 5,8 3.2,9.8" />
      </g>
    </Svg>
  );
}

function IndentDecrease({ size }: RibbonIconProps) {
  return (
    <Svg size={size} sw={1.5}>
      <line x1="7.5" y1="3.2" x2="14" y2="3.2" />
      <line x1="7.5" y1="8" x2="14" y2="8" />
      <line x1="7.5" y1="12.8" x2="14" y2="12.8" />
      <g stroke={ACCENT}>
        <line x1="2.2" y1="8" x2="5.3" y2="8" />
        <polyline points="3.8,6.2 2,8 3.8,9.8" />
      </g>
    </Svg>
  );
}

function MergeCells({ size }: RibbonIconProps) {
  return (
    <Svg size={size}>
      <rect x="1.5" y="4" width="13" height="8" rx="1" />
      <g fill={ACCENT} stroke="none">
        <path d="M4.2 6.2L6.8 8 4.2 9.8z" />
        <path d="M11.8 6.2L9.2 8 11.8 9.8z" />
      </g>
    </Svg>
  );
}

// ============================================================================
// Number
// ============================================================================

function Percent({ size }: RibbonIconProps) {
  return (
    <Svg size={size} sw={1.4}>
      <line x1="3.6" y1="12.4" x2="12.4" y2="3.6" />
      <circle cx="4.9" cy="4.9" r="2.1" />
      <circle cx="11.1" cy="11.1" r="2.1" />
    </Svg>
  );
}

function Comma({ size }: RibbonIconProps) {
  return (
    <Svg size={size}>
      <text
        x="8"
        y="10.5"
        fontSize="16"
        fontWeight="700"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontFamily={FONT}
      >
        ,
      </text>
    </Svg>
  );
}

function DecimalIncrease({ size }: RibbonIconProps) {
  return (
    <Svg size={size}>
      <text
        x="0.8"
        y="13.5"
        fontSize="7.5"
        fontWeight="700"
        fill="currentColor"
        stroke="none"
        fontFamily={FONT}
      >
        .00
      </text>
      <g stroke={ACCENT} strokeWidth="1.5">
        <line x1="11.8" y1="3.5" x2="11.8" y2="7.5" />
        <line x1="9.8" y1="5.5" x2="13.8" y2="5.5" />
      </g>
    </Svg>
  );
}

function NumberFormat({ size }: RibbonIconProps) {
  return (
    <Svg size={size}>
      <text
        x="8"
        y="9.5"
        fontSize="7.5"
        fontWeight="700"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontFamily={FONT}
      >
        123
      </text>
      <line x1="3.4" y1="12.6" x2="12.6" y2="12.6" stroke={ACCENT} strokeWidth="1.5" />
    </Svg>
  );
}

function DecimalDecrease({ size }: RibbonIconProps) {
  return (
    <Svg size={size}>
      <text
        x="2"
        y="13.5"
        fontSize="7.5"
        fontWeight="700"
        fill="currentColor"
        stroke="none"
        fontFamily={FONT}
      >
        .0
      </text>
      <line x1="9.8" y1="5.5" x2="13.8" y2="5.5" stroke={ACCENT} strokeWidth="1.5" />
    </Svg>
  );
}

// ============================================================================
// Styles
// ============================================================================

function CellStyles({ size }: RibbonIconProps) {
  return (
    <Svg size={size}>
      <rect
        x="1.8"
        y="2.2"
        width="5.6"
        height="4.8"
        rx="1"
        fill={ACCENT}
        fillOpacity="0.85"
        stroke="none"
      />
      <rect x="8.6" y="2.2" width="5.6" height="4.8" rx="1" />
      <rect x="1.8" y="9" width="5.6" height="4.8" rx="1" />
      <rect
        x="8.6"
        y="9"
        width="5.6"
        height="4.8"
        rx="1"
        fill="currentColor"
        fillOpacity="0.3"
        stroke="none"
      />
    </Svg>
  );
}

// ============================================================================
// Cells (insert / delete rows and columns)
// ============================================================================

function InsertRow({ size }: RibbonIconProps) {
  return (
    <Svg size={size}>
      <rect x="1.5" y="2.2" width="10" height="3.2" rx="0.6" />
      <rect x="1.5" y="6.4" width="10" height="3.2" rx="0.6" stroke={ACCENT} />
      <rect x="1.5" y="10.6" width="10" height="3.2" rx="0.6" />
      {/* Plus centered at 13.2 so the round caps stay inside the viewBox. */}
      <g stroke={ACCENT} strokeWidth="1.6">
        <line x1="13.2" y1="6" x2="13.2" y2="10" />
        <line x1="11.2" y1="8" x2="15.2" y2="8" />
      </g>
    </Svg>
  );
}

function InsertColumn({ size }: RibbonIconProps) {
  return (
    <Svg size={size}>
      <rect x="2.2" y="1.5" width="3.2" height="10" rx="0.6" />
      <rect x="6.4" y="1.5" width="3.2" height="10" rx="0.6" stroke={ACCENT} />
      <rect x="10.6" y="1.5" width="3.2" height="10" rx="0.6" />
      {/* Plus centered at 13.2 so the round caps stay inside the viewBox. */}
      <g stroke={ACCENT} strokeWidth="1.6">
        <line x1="8" y1="11.2" x2="8" y2="15.2" />
        <line x1="6" y1="13.2" x2="10" y2="13.2" />
      </g>
    </Svg>
  );
}

function DeleteRow({ size }: RibbonIconProps) {
  return (
    <Svg size={size}>
      <rect x="1.5" y="2.2" width="10" height="3.2" rx="0.6" />
      <rect x="1.5" y="6.4" width="10" height="3.2" rx="0.6" opacity="0.45" />
      <rect x="1.5" y="10.6" width="10" height="3.2" rx="0.6" />
      <g stroke={DANGER} strokeWidth="1.6">
        <line x1="11.9" y1="6.3" x2="15.3" y2="9.7" />
        <line x1="15.3" y1="6.3" x2="11.9" y2="9.7" />
      </g>
    </Svg>
  );
}

function DeleteColumn({ size }: RibbonIconProps) {
  return (
    <Svg size={size}>
      <rect x="2.2" y="1.5" width="3.2" height="10" rx="0.6" />
      <rect x="6.4" y="1.5" width="3.2" height="10" rx="0.6" opacity="0.45" />
      <rect x="10.6" y="1.5" width="3.2" height="10" rx="0.6" />
      <g stroke={DANGER} strokeWidth="1.6">
        <line x1="6.3" y1="11.9" x2="9.7" y2="15.3" />
        <line x1="9.7" y1="11.9" x2="6.3" y2="15.3" />
      </g>
    </Svg>
  );
}

// ============================================================================
// Editing
// ============================================================================

function Undo({ size }: RibbonIconProps) {
  return (
    <Svg size={size} sw={1.5}>
      <path d="M4 6.2h6.8a3.6 3.6 0 0 1 0 7.2H8" />
      <polyline points="6.6,3.6 4,6.2 6.6,8.8" />
    </Svg>
  );
}

function Redo({ size }: RibbonIconProps) {
  return (
    <Svg size={size} sw={1.5}>
      <path d="M12 6.2H5.2a3.6 3.6 0 0 0 0 7.2H8" />
      <polyline points="9.4,3.6 12,6.2 9.4,8.8" />
    </Svg>
  );
}

function Find({ size }: RibbonIconProps) {
  return (
    <Svg size={size} sw={1.5}>
      <circle cx="6.7" cy="6.7" r="4.4" />
      <line x1="10.2" y1="10.2" x2="14.3" y2="14.3" strokeWidth="2" />
    </Svg>
  );
}

function ClearContents({ size }: RibbonIconProps) {
  return (
    <Svg size={size}>
      <path d="M10 2.5l3.5 3.5-6 6H4l-1.5-1.5 7.5-8z" />
      <line x1="6.5" y1="6" x2="10" y2="9.5" strokeWidth="1" />
      <line x1="2.5" y1="13.8" x2="13.5" y2="13.8" strokeWidth="1.2" />
    </Svg>
  );
}

function ClearFormatting({ size }: RibbonIconProps) {
  return (
    <Svg size={size}>
      <path d="M8.2 1.8l3.2 3.2-5.2 5.2H3.4L2 8.8l6.2-7z" />
      <line x1="5.2" y1="4.8" x2="8.2" y2="7.8" strokeWidth="1" />
      <text
        x="9.6"
        y="14.6"
        fontSize="8"
        fontWeight="700"
        fill="currentColor"
        stroke="none"
        fontFamily={FONT}
      >
        A
      </text>
    </Svg>
  );
}

function ClearAll({ size }: RibbonIconProps) {
  return (
    <Svg size={size}>
      <path d="M8.8 2.2l3.2 3.2-5.4 5.4H3.4L2 9.4l6.8-7.2z" />
      <line x1="2.2" y1="13.6" x2="9.5" y2="13.6" strokeWidth="1.2" />
      <path
        d="M12.8 8.5l.75 1.75 1.75.75-1.75.75-.75 1.75-.75-1.75-1.75-.75 1.75-.75z"
        fill={ACCENT}
        stroke="none"
      />
    </Svg>
  );
}

// ============================================================================
// Export — one namespace object so names never collide with menuIcons.
// ============================================================================

export const RibbonIcon = {
  Cut,
  Copy,
  Paste,
  FormatPainter,
  FontSizeUp,
  FontSizeDown,
  FormatCells,
  FillColor,
  AlignTop,
  AlignMiddle,
  AlignBottom,
  AlignLeft,
  AlignCenter,
  AlignRight,
  WrapText,
  IndentIncrease,
  IndentDecrease,
  MergeCells,
  Percent,
  Comma,
  NumberFormat,
  DecimalIncrease,
  DecimalDecrease,
  CellStyles,
  InsertRow,
  InsertColumn,
  DeleteRow,
  DeleteColumn,
  Undo,
  Redo,
  Find,
  ClearContents,
  ClearFormatting,
  ClearAll,
} as const;
