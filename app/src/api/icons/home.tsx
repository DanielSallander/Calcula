//! FILENAME: app/src/api/icons/home.tsx
// PURPOSE: The Home tab's glyphs: the 34 FROZEN keys redrawn in place on the
//          24-unit duotone grid, plus the Home extras (Superscript, Subscript,
//          FontColor, Replace).
// CONTEXT: The 34 keys (Cut ... ClearAll) are frozen because they are a
//          contract, not a style: homeTabIcons.tsx maps persisted Home-tab item
//          ids onto them, GROUP_ICON_IDS lists them in the customize dialog,
//          and sandboxed add-ins name them as icon TOKENS through
//          AddInsRibbonSection (`keyof typeof RibbonIcon`). A key may be
//          redrawn; it may never be renamed or removed.
//
//          Most drawings are the approved mockup's (Home.dc.html) converted
//          verbatim. Three were corrected rather than copied, because the
//          correction is geometry, not taste:
//          - AlignLeft/Center/Right: the mockup's four rows ran 3.8..23.8, so
//            the glyph sat 1.8 units low (1.5px at the 20px control size).
//            Shifted up to 2..22, centred on the grid.
//          - WrapText: the return arrow's round cap reached y = 24.5 and was
//            clipped by the viewBox. Shifted up 2 units.
//          - IndentIncrease/Decrease: the rows sat one unit above the arrow
//            they are indented from; the rows moved down so the arrow points
//            at the middle row.
//
//          Percent, Comma, NumberFormat and the two Decimal glyphs had no
//          mockup drawing and were typographic (<text>) before. <text> is
//          banned in the set (it renders in whatever font the machine has), so
//          they are drawn as paths in the same language. The Home band keeps
//          these five TYPOGRAPHIC in its own buttons (the approved plan: "%",
//          "," ".0" read like "B"); these drawings are for every surface that
//          needs a picture — the customize dialog, menus, add-in tokens.

import React from "react";
import {
  IconFrame,
  SOFT,
  STRONG,
  ACCENT,
  DANGER,
  line,
  type RibbonIconProps,
} from "./frame";
import { Search } from "./generic";

// ============================================================================
// Clipboard
// ============================================================================

/** Cut: two soft blades, the accent handle is the one doing the cutting. */
function Cut({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M7 2.4a1.7 1.7 0 0 1 2.3.63l8.3 14.4a1.7 1.7 0 0 1-2.95 1.7L6.36 4.7A1.7 1.7 0 0 1 7 2.4z"
        fill={SOFT}
      />
      <path
        d="M17 2.4a1.7 1.7 0 0 0-2.3.63L6.4 17.43a1.7 1.7 0 0 0 2.95 1.7L17.64 4.7A1.7 1.7 0 0 0 17 2.4z"
        fill={SOFT}
      />
      <circle cx="6.2" cy="19" r="3.4" fill={ACCENT} />
      <circle cx="17.8" cy="19" r="3.4" fill={STRONG} />
    </IconFrame>
  );
}

/** Copy: a soft original behind its strong copy. */
function Copy({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="13.2" height="16.4" rx="3.2" fill={SOFT} />
      <rect x="8.4" y="5.2" width="13.2" height="16.4" rx="3.2" fill={STRONG} />
    </IconFrame>
  );
}

/** Paste: a soft board, strong content, the accent clip. */
function Paste({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M5.6 3.2h12.8a2.8 2.8 0 0 1 2.8 2.8v13.4a2.8 2.8 0 0 1-2.8 2.8H5.6a2.8 2.8 0 0 1-2.8-2.8V6a2.8 2.8 0 0 1 2.8-2.8z"
        fill={SOFT}
      />
      <rect x="7" y="9.4" width="10" height="3" rx="1.5" fill={STRONG} />
      <rect x="7" y="14.4" width="10" height="3" rx="1.5" fill={STRONG} />
      <rect x="7.6" y="1.4" width="8.8" height="5" rx="2.2" fill={ACCENT} />
    </IconFrame>
  );
}

/** Format Painter: a soft roller head, strong ferrule, the accent handle end
 *  that carries the format. */
function FormatPainter({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.6" y="2.4" width="16.8" height="7.4" rx="2.4" fill={SOFT} />
      <path
        d="M13 10.6v1.6a1.7 1.7 0 0 0 1.7 1.7h2.6a1.7 1.7 0 0 1 1.7 1.7v1.2h-9v-1.2a1.7 1.7 0 0 1 1.7-1.7h.9z"
        fill={STRONG}
      />
      <rect x="10" y="17.4" width="5" height="5.2" rx="1.8" fill={ACCENT} />
    </IconFrame>
  );
}

// ============================================================================
// Font
// ============================================================================

const LETTER_A = "M2.2 19L7.4 6.2h2.4L15 19";

/** Grow Font: a strong A, the accent arrow is the verb. */
function FontSizeUp({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d={LETTER_A} {...line(STRONG)} />
      <path d="M4.8 14.8h7.2" {...line(STRONG, 2.8)} />
      <path d="M19.4 20V8.6M16 11.8l3.4-3.6 3.4 3.6" {...line(ACCENT, 2.8)} />
    </IconFrame>
  );
}

/** Shrink Font: FontSizeUp with the arrow turned down. */
function FontSizeDown({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d={LETTER_A} {...line(STRONG)} />
      <path d="M4.8 14.8h7.2" {...line(STRONG, 2.8)} />
      <path d="M19.4 8.2v11.4M16 16.4l3.4 3.6 3.4-3.6" {...line(ACCENT, 2.8)} />
    </IconFrame>
  );
}

/** Font Color: the strong A alone. The colour itself is the 4px data bar the
 *  host control paints under the icon (ColorSwatch variant="bar"), so the
 *  glyph carries no accent that could be mistaken for the chosen colour. */
function FontColor({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M4 19.6L10.4 4.4h3.2L20 19.6" {...line(STRONG, 3.2)} />
      <path d="M7.6 14.4h8.8" {...line(STRONG)} />
    </IconFrame>
  );
}

/** Fill Color: a soft bucket and a strong drop; like FontColor, the chosen
 *  colour is the host's data bar, not a channel of the glyph. */
function FillColor({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M11 2.2a1.8 1.8 0 0 1 2.55 0l7.5 7.5a2.6 2.6 0 0 1 0 3.68l-6.6 6.6a2.6 2.6 0 0 1-3.68 0l-6.6-6.6a2.6 2.6 0 0 1 0-3.68z"
        fill={SOFT}
      />
      <path
        d="M20.2 16s2.6 2.8 2.6 4.4a2.6 2.6 0 0 1-5.2 0c0-1.6 2.6-4.4 2.6-4.4z"
        fill={STRONG}
      />
    </IconFrame>
  );
}

/** Format Cells: a soft dialog, a strong title bar, accent fields. */
function FormatCells({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.8" width="19.2" height="18.4" rx="3.4" fill={SOFT} />
      <rect x="2.4" y="2.8" width="19.2" height="5.6" rx="2.8" fill={STRONG} />
      <rect x="5.4" y="11" width="6" height="3.2" rx="1.6" fill={ACCENT} />
      <rect x="5.4" y="15.8" width="10" height="3.2" rx="1.6" fill={ACCENT} />
    </IconFrame>
  );
}

/** Superscript: a strong x, the accent block raised to the exponent slot. */
function Superscript({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M3.6 8.6l8.4 11M12 8.6l-8.4 11" {...line(STRONG)} />
      <rect x="15" y="2.6" width="6.4" height="6.4" rx="2" fill={ACCENT} />
    </IconFrame>
  );
}

/** Subscript: Superscript with the x raised and the block lowered. */
function Subscript({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M3.6 4.4l8.4 11M12 4.4l-8.4 11" {...line(STRONG)} />
      <rect x="15" y="15" width="6.4" height="6.4" rx="2" fill={ACCENT} />
    </IconFrame>
  );
}

// ============================================================================
// Alignment
// ============================================================================

/** Vertical alignment: the accent rule is the edge the soft content hugs. */
function AlignTop({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.5" y="2.4" width="19" height="3.2" rx="1.6" fill={ACCENT} />
      <rect x="8.4" y="7.8" width="7.2" height="13.8" rx="2.4" fill={SOFT} />
    </IconFrame>
  );
}

function AlignMiddle({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.5" y="10.4" width="19" height="3.2" rx="1.6" fill={ACCENT} />
      <rect x="8.4" y="2.4" width="7.2" height="6.2" rx="2.2" fill={SOFT} />
      <rect x="8.4" y="15.4" width="7.2" height="6.2" rx="2.2" fill={SOFT} />
    </IconFrame>
  );
}

function AlignBottom({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.5" y="18.4" width="19" height="3.2" rx="1.6" fill={ACCENT} />
      <rect x="8.4" y="2.4" width="7.2" height="13.8" rx="2.4" fill={SOFT} />
    </IconFrame>
  );
}

/** Horizontal alignment: soft full-width rows, the strong short rows show
 *  which edge the text keeps. One drawing, three offsets of the short rows. */
function horizontalAlign(size: number | undefined, shortX: number): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.5" y="2" width="19" height="3.2" rx="1.6" fill={SOFT} />
      <rect x={shortX} y="7.6" width="12" height="3.2" rx="1.6" fill={STRONG} />
      <rect x="2.5" y="13.2" width="19" height="3.2" rx="1.6" fill={SOFT} />
      <rect x={shortX} y="18.8" width="12" height="3.2" rx="1.6" fill={STRONG} />
    </IconFrame>
  );
}

function AlignLeft({ size }: RibbonIconProps): React.ReactElement {
  return horizontalAlign(size, 2.5);
}

function AlignCenter({ size }: RibbonIconProps): React.ReactElement {
  return horizontalAlign(size, 6);
}

function AlignRight({ size }: RibbonIconProps): React.ReactElement {
  return horizontalAlign(size, 9.5);
}

/** Wrap Text: a soft line above, the strong line turning back, the accent
 *  head is the wrap. */
function WrapText({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.5" y="2" width="19" height="3.2" rx="1.6" fill={SOFT} />
      <path d="M2.5 9.6h13.6a4.2 4.2 0 0 1 0 8.4H12" {...line(STRONG)} />
      <path d="M14 15L10.6 18l3.4 3" {...line(ACCENT)} />
    </IconFrame>
  );
}

/** Indent: soft rows pushed right, the accent arrow is the push. */
function IndentIncrease({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="9.4" y="4.8" width="12.2" height="3.2" rx="1.6" fill={SOFT} />
      <rect x="9.4" y="10.4" width="12.2" height="3.2" rx="1.6" fill={SOFT} />
      <rect x="9.4" y="16" width="12.2" height="3.2" rx="1.6" fill={SOFT} />
      <path d="M2.2 7.4L6.8 12l-4.6 4.6z" fill={ACCENT} />
    </IconFrame>
  );
}

function IndentDecrease({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="9.4" y="4.8" width="12.2" height="3.2" rx="1.6" fill={SOFT} />
      <rect x="9.4" y="10.4" width="12.2" height="3.2" rx="1.6" fill={SOFT} />
      <rect x="9.4" y="16" width="12.2" height="3.2" rx="1.6" fill={SOFT} />
      <path d="M6.8 7.4L2.2 12l4.6 4.6z" fill={ACCENT} />
    </IconFrame>
  );
}

/** Merge: a soft range with the accent merged cell filling it. */
function MergeCells({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="4.2" width="19.2" height="15.6" rx="3" fill={SOFT} />
      <rect x="5.6" y="7.4" width="12.8" height="9.2" rx="2.2" fill={ACCENT} />
    </IconFrame>
  );
}

// ============================================================================
// Number (drawn, not typeset: see the header)
// ============================================================================

/** Percent: two strong rings and the accent slash between them. */
function Percent({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <circle cx="7" cy="7" r="3" {...line(STRONG, 2.8)} />
      <circle cx="17" cy="17" r="3" {...line(STRONG, 2.8)} />
      <path d="M18.6 4.4L5.4 19.6" {...line(ACCENT, 3.2)} />
    </IconFrame>
  );
}

/** Comma style: two soft digit groups and the accent thousands comma. */
function Comma({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="5" width="6.2" height="11" rx="2.2" fill={SOFT} />
      <rect x="15.6" y="5" width="6" height="11" rx="2.2" fill={SOFT} />
      <path
        d="M12 11.4a2.6 2.6 0 0 1 2.6 2.6c0 2.9-1.6 5.1-4.1 6.2a.9.9 0 0 1-1.1-1.4c.8-.7 1.2-1.5 1.3-2.55A2.6 2.6 0 0 1 12 11.4z"
        fill={ACCENT}
      />
    </IconFrame>
  );
}

/** Number Format: a soft card, the accent number sign, a strong digit. */
function NumberFormat({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="3.2" width="19.2" height="17.6" rx="3.4" fill={SOFT} />
      <path d="M8.8 7l-1.6 10M13 7l-1.6 10M5.6 9.8h8.6M5 14.2h8.6" {...line(ACCENT, 2.6)} />
      <rect x="16.6" y="7" width="3" height="10" rx="1.5" fill={STRONG} />
    </IconFrame>
  );
}

/** Increase Decimal: ".00" — a strong point, two soft digits, and the accent
 *  arrow pointing the way the digits grow. */
function DecimalIncrease({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M20.2 6H8.6M11.8 2.8L8.6 6l3.2 3.2" {...line(ACCENT, 2.8)} />
      <circle cx="4.6" cy="18.6" r="2" fill={STRONG} />
      <rect x="8.4" y="12.4" width="5.4" height="8.4" rx="2.2" fill={SOFT} />
      <rect x="15.4" y="12.4" width="5.4" height="8.4" rx="2.2" fill={SOFT} />
    </IconFrame>
  );
}

/** Decrease Decimal: ".0" — one digit fewer, the arrow reversed. */
function DecimalDecrease({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M3.8 6h11.6M12.2 2.8L15.4 6l-3.2 3.2" {...line(ACCENT, 2.8)} />
      <circle cx="4.6" cy="18.6" r="2" fill={STRONG} />
      <rect x="8.4" y="12.4" width="5.4" height="8.4" rx="2.2" fill={SOFT} />
    </IconFrame>
  );
}

// ============================================================================
// Styles
// ============================================================================

/** Cell Styles: a soft gallery of four swatches, accent and strong crossed. */
function CellStyles({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.8" width="19.2" height="18.4" rx="3.4" fill={SOFT} />
      <rect x="5.2" y="5.8" width="6.4" height="5.6" rx="1.8" fill={ACCENT} />
      <rect x="12.4" y="5.8" width="6.4" height="5.6" rx="1.8" fill={STRONG} />
      <rect x="5.2" y="12.6" width="6.4" height="5.6" rx="1.8" fill={STRONG} />
      <rect x="12.4" y="12.6" width="6.4" height="5.6" rx="1.8" fill={ACCENT} />
    </IconFrame>
  );
}

// ============================================================================
// Cells: insert / delete rows and columns
// ============================================================================

/** The soft neighbours are the ground; the verb (accent plus, danger minus)
 *  sits in the gap where the row or column arrives or leaves. */
function InsertRow({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.6" width="19.2" height="6.4" rx="2.2" fill={SOFT} />
      <rect x="2.4" y="15" width="19.2" height="6.4" rx="2.2" fill={SOFT} />
      <path d="M12 9.6v4.8M9.6 12h4.8" {...line(ACCENT)} />
    </IconFrame>
  );
}

function InsertColumn({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.6" y="2.4" width="6.4" height="19.2" rx="2.2" fill={SOFT} />
      <rect x="15" y="2.4" width="6.4" height="19.2" rx="2.2" fill={SOFT} />
      <path d="M12 9.6v4.8M9.6 12h4.8" {...line(ACCENT)} />
    </IconFrame>
  );
}

function DeleteRow({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.6" width="19.2" height="6.4" rx="2.2" fill={SOFT} />
      <rect x="2.4" y="15" width="19.2" height="6.4" rx="2.2" fill={SOFT} />
      <path d="M9.2 12h5.6" {...line(DANGER)} />
    </IconFrame>
  );
}

function DeleteColumn({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.6" y="2.4" width="6.4" height="19.2" rx="2.2" fill={SOFT} />
      <rect x="15" y="2.4" width="6.4" height="19.2" rx="2.2" fill={SOFT} />
      <path d="M9.2 12h5.6" {...line(DANGER)} />
    </IconFrame>
  );
}

// ============================================================================
// Editing
// ============================================================================

/** Undo / Redo: a soft path back, the accent head is the verb. */
function Undo({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M4.4 9h10.2a5.8 5.8 0 0 1 0 11.6h-3.8" {...line(SOFT, 3.2)} />
      <path d="M8.6 4.4L3.2 9l5.4 4.6" {...line(ACCENT, 3.2)} />
    </IconFrame>
  );
}

function Redo({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M19.6 9H9.4a5.8 5.8 0 0 0 0 11.6h3.8" {...line(SOFT, 3.2)} />
      <path d="M15.4 4.4L20.8 9l-5.4 4.6" {...line(ACCENT, 3.2)} />
    </IconFrame>
  );
}

/** Find & Replace: a soft original, the strong replacement, the accent arrow
 *  carrying one into the other. */
function Replace({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.6" width="11" height="5.6" rx="2.4" fill={SOFT} />
      <rect x="10.6" y="15.8" width="11" height="5.6" rx="2.4" fill={STRONG} />
      <path d="M15.2 5.4h1.2a2.8 2.8 0 0 1 2.8 2.8v4.2M16.6 10l2.6 2.6 2.6-2.6" {...line(ACCENT, 2.8)} />
    </IconFrame>
  );
}

/** The clear family shares one soft cell. The X is the verb. */
const CLEAR_CELL = { x: 2.6, y: 2.6, width: 18.8, height: 18.8, rx: 3.6 } as const;

/** Clear Contents: the cell with a STRONG X — the values go, nothing that
 *  cannot be retyped. */
function ClearContents({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect {...CLEAR_CELL} fill={SOFT} />
      <path d="M8.4 8.4l7.2 7.2M15.6 8.4l-7.2 7.2" {...line(STRONG, 3.2)} />
    </IconFrame>
  );
}

/** Clear Formats: strong text rows kept, the danger stroke takes the format. */
function ClearFormatting({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect {...CLEAR_CELL} fill={SOFT} />
      <rect x="6.2" y="7" width="11.6" height="3.2" rx="1.6" fill={STRONG} />
      <rect x="6.2" y="12.4" width="7" height="3.2" rx="1.6" fill={STRONG} />
      <path d="M13.6 13.6l6.4 6.4" {...line(DANGER, 3.2)} />
    </IconFrame>
  );
}

/** Clear All: a STACK of cells (the layers — contents, formats, comments)
 *  with a DANGER X through the front one. It must differ from Clear Contents
 *  by SHAPE, not only by the X's colour: the shape-first rule in ICONS.md,
 *  because a colour difference alone vanishes in high contrast and for a
 *  red-green colour-blind reader. The back layer is a STRONG edge peeking out
 *  above and to the right, never a second soft fill (two translucent fills
 *  would darken where they overlap). */
function ClearAll({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M7.2 3h11.6a2.2 2.2 0 0 1 2.2 2.2v11.6" {...line(STRONG, 2.6)} />
      <rect x="2.6" y="7" width="14.4" height="14.4" rx="3.2" fill={SOFT} />
      <path d="M6.6 11l6.4 6.4M13 11l-6.4 6.4" {...line(DANGER, 3)} />
    </IconFrame>
  );
}

// ============================================================================
// Group export
// ============================================================================

/* eslint-disable @typescript-eslint/naming-convention -- the keys are React component names (PascalCase, which the rule already allows for functions) and a frozen public contract, not Rust-mirrored fields. */
/** The 34 frozen keys, in their historical order, then the Home extras. */
export const HOME_ICONS = {
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
  /** The magnifier is the generic Search drawing; one component, two keys. */
  Find: Search,
  ClearContents,
  ClearFormatting,
  ClearAll,
  // ---- Home extras ----------------------------------------------------------
  Superscript,
  Subscript,
  FontColor,
  Replace,
} as const;
/* eslint-enable @typescript-eslint/naming-convention */

