//! FILENAME: app/extensions/Table/components/TableStylesGallery.tsx
// PURPOSE: The Table Styles gallery of the Table Design panel.
// CONTEXT: The @api StyleGallery (docs/design/ribbon-design-system.md) around
//          SVG thumbnails of Excel's Light / Medium / Dark table styles. In the
//          ribbon band it is one 61px strip of thumbnails plus an expand button
//          that opens every style as a grouped grid; in the sidebar or a
//          launcher flyout it is that grid inline. Keyboard, focus, Escape and
//          outside-click all belong to the primitive — this file used to carry
//          its own `position: fixed` portal, a document keydown listener, a
//          ResizeObserver and a "Quick Styles" fallback button, all of which
//          the primitive and the shell's width demotion now own.
//
//          The style DATA lives in ../lib/tableStyles.ts (this file is under the
//          chrome hex-ban). The thumbnails paint that data; StyleGallery wraps
//          every thumbnail in a `data-colour-data` box, so no colour here is
//          chrome.
//
//          "None" is the first Light tile, as in Excel. It replaces the old
//          dropdown's "Clear" footer (the same act: the table keeps its data and
//          loses its style) and routes to `onStyleClear`. The old footer's
//          "New Table Style..." was a permanently disabled placeholder and is
//          not carried over.

import React from "react";
import { StyleGallery, type StyleGalleryItem } from "@api/layout";
import {
  TABLE_STYLES,
  TABLE_STYLE_CATEGORY_LABELS,
  TABLE_STYLE_NONE_ID,
  TABLE_STYLE_NONE_THUMB,
  tableStyleDisplayName,
  type TableStyleThumbColors,
} from "../lib/tableStyles";

// The data used to live here; its names still resolve from this module.
export {
  TABLE_STYLES,
  TABLE_STYLES_BY_ID,
  DEFAULT_TABLE_STYLE_ID,
  TABLE_STYLE_NONE_ID,
} from "../lib/tableStyles";
export type { TableStyleDef, TableStyleThumbColors } from "../lib/tableStyles";

// ============================================================================
// Thumbnail
// ============================================================================

const THUMB_ROWS = 5;
const THUMB_COLS = 4;
const BORDER_W = 1;
const DASH_MARGIN_X = 3;
const DASH_H = 1.5;
const HEADER_DASH_H = 2;

export interface TableStyleThumbnailProps {
  thumb: TableStyleThumbColors;
  width: number;
  height: number;
}

/** One rectangle as a closed sub-path, so a row's dashes are ONE element. */
function rectPath(x: number, y: number, w: number, h: number): string {
  return `M${x} ${y}h${w}v${h}h${-w}z`;
}

function hasRule(colour: string | undefined): colour is string {
  return !!colour && colour !== "transparent";
}

/**
 * A miniature table in a style's colours: a header row and four body rows of
 * "text" dashes, the style's banding, its row and column rules and its outer
 * border. Drawn as SVG (crisp at every device-pixel ratio, and no canvas to
 * size by hand) in a handful of elements per thumbnail, because the expanded
 * gallery shows all seventy-eight at once.
 */
export function TableStyleThumbnail({
  thumb,
  width,
  height,
}: TableStyleThumbnailProps): React.ReactElement {
  const rowH = Math.floor((height - BORDER_W * (THUMB_ROWS - 1)) / THUMB_ROWS);
  const colW = Math.floor(width / THUMB_COLS);

  const rows: React.ReactNode[] = [];
  const dashes: React.ReactNode[] = [];
  let vertical = "";
  let horizontal = "";
  let headerRule = "";

  let y = 0;
  for (let r = 0; r < THUMB_ROWS; r++) {
    const isHeader = r === 0;
    // The first data row is a stripe, as on the grid (Excel's first row
    // stripe): body rows 1 and 3 of the thumbnail, not 2 and 4.
    const isBanded = r % 2 === 1;
    const bg = isHeader ? thumb.headerBg : isBanded ? thumb.bandBg : thumb.baseBg;
    rows.push(<rect key={`row-${r}`} x={0} y={y} width={width} height={rowH} fill={bg} />);

    const dashHeight = isHeader ? HEADER_DASH_H : DASH_H;
    let d = "";
    for (let c = 0; c < THUMB_COLS; c++) {
      d += rectPath(
        c * colW + DASH_MARGIN_X,
        y + (rowH - dashHeight) / 2,
        colW - DASH_MARGIN_X * 2,
        dashHeight,
      );
    }
    dashes.push(
      <path key={`dash-${r}`} d={d} fill={isHeader ? thumb.headerFg : thumb.dashColor} />,
    );

    if (thumb.borderV) {
      for (let c = 1; c < THUMB_COLS; c++) vertical += rectPath(c * colW, y, 0.5, rowH);
    }

    y += rowH;
    if (r < THUMB_ROWS - 1) {
      if (isHeader && hasRule(thumb.headerBorderBottom)) {
        headerRule = rectPath(0, y, width, BORDER_W);
      } else if (hasRule(thumb.borderH)) {
        horizontal += rectPath(0, y, width, BORDER_W);
      }
      y += BORDER_W;
    }
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      shapeRendering="crispEdges"
      aria-hidden
      style={{ display: "block" }}
    >
      {rows}
      {dashes}
      {vertical && hasRule(thumb.borderV) && <path d={vertical} fill={thumb.borderV} />}
      {horizontal && hasRule(thumb.borderH) && <path d={horizontal} fill={thumb.borderH} />}
      {headerRule && hasRule(thumb.headerBorderBottom) && (
        <path d={headerRule} fill={thumb.headerBorderBottom} />
      )}
      <rect
        x={0.5}
        y={0.5}
        width={width - 1}
        height={height - 1}
        fill="none"
        stroke={thumb.outerBorder}
        strokeWidth={1}
      />
    </svg>
  );
}

// ============================================================================
// Gallery items
// ============================================================================

/** "None" first (Excel's first Light tile), then Light, Medium, Dark. */
const TABLE_STYLE_GALLERY_ITEMS: readonly StyleGalleryItem[] = [
  {
    id: TABLE_STYLE_NONE_ID,
    name: "None",
    group: TABLE_STYLE_CATEGORY_LABELS.light,
    renderThumb: ({ w, h }) => (
      <TableStyleThumbnail thumb={TABLE_STYLE_NONE_THUMB} width={w} height={h} />
    ),
  },
  ...TABLE_STYLES.map(
    (def): StyleGalleryItem => ({
      id: def.id,
      name: tableStyleDisplayName(def),
      group: TABLE_STYLE_CATEGORY_LABELS[def.category],
      renderThumb: ({ w, h }) => <TableStyleThumbnail thumb={def.thumb} width={w} height={h} />,
    }),
  ),
];

/** The band strip starts from Excel's familiar row, Medium 1-7. None and the
 *  Light family lead the full grid (as in Excel), but a strip that took the
 *  first items showed None and Light 1 before the style every table wears. */
const TABLE_STYLE_STRIP_IDS: readonly string[] = TABLE_STYLES.filter(
  (def) => def.category === "medium" && def.group === 0,
).map((def) => def.id);

// ============================================================================
// TableStylesGallery
// ============================================================================

export interface TableStylesGalleryProps {
  /** The applied style's gallery id (the None id for no style), or null when
   *  the table wears a style the gallery cannot draw. */
  selectedStyleId: string | null;
  /** A built-in style was chosen. */
  onStyleSelect: (styleId: string) => void;
  /** "None" was chosen: remove the table's style. */
  onStyleClear: () => void;
}

/** Test ids: strip thumbs `table-styles-<id>`, expand `table-styles-expand`,
 *  popover options `table-styles-option-<id>` (StyleGallery's scheme). */
const TABLE_STYLES_TEST_ID = "table-styles";

export function TableStylesGallery({
  selectedStyleId,
  onStyleSelect,
  onStyleClear,
}: TableStylesGalleryProps): React.ReactElement {
  return (
    <StyleGallery
      items={TABLE_STYLE_GALLERY_ITEMS}
      value={selectedStyleId}
      onChange={(id) => {
        if (id === TABLE_STYLE_NONE_ID) onStyleClear();
        else onStyleSelect(id);
      }}
      label="Table Styles"
      expandLabel="More Table Styles"
      stripIds={TABLE_STYLE_STRIP_IDS}
      columns={7}
      testIdPrefix={TABLE_STYLES_TEST_ID}
    />
  );
}
