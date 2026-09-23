//! FILENAME: app/extensions/Slicer/components/SlicerStylesGallery.tsx
// PURPOSE: Slicer Styles gallery hosted by the "Slicer Styles" panel section
//          (see SlicerOptionsSections.tsx).
// CONTEXT: Excel's Slicer Styles gallery on the shared @api/layout StyleGallery:
//          in the ribbon band a 61px strip of thumbnails plus an expand button
//          whose card popover shows every style grouped Light / Dark; in a
//          sidebar or launcher flyout the grouped grid inline. The popover,
//          its keyboard model, its dismissal and the collapse-when-narrow
//          behaviour all belong to the primitive and the shell's launcher
//          demotion, so this file only supplies the items and draws a
//          thumbnail.
//
//          The style DATA lives in ../lib/slicerStyles.ts, which is where the
//          canvas renderer imports it from. It is re-exported here under the
//          names this module has always exported, for older callers
//          (lib/__tests__/slicerStyles.test.ts pins that both paths agree).
//
//          Thumbnails paint with the style's own colours (categorical data);
//          StyleGallery wraps each one in a `data-colour-data` box. Nothing
//          else here names a colour.

import React, { useMemo } from "react";
import { StyleGallery, type StyleGalleryItem, type StyleThumbSize } from "@api/layout";
import {
  SLICER_STYLES,
  slicerStyleName,
  SLICER_STYLE_CATEGORY_LABELS,
  type SlicerThumbColors,
} from "../lib/slicerStyles";

export {
  SLICER_STYLES,
  SLICER_STYLES_BY_ID,
  DEFAULT_SLICER_STYLE_ID,
} from "../lib/slicerStyles";
export type { SlicerStyleDef, SlicerThumbColors } from "../lib/slicerStyles";

// ============================================================================
// Thumbnail
// ============================================================================

/** Item rows drawn in a thumbnail; the first one is shown selected. */
const THUMB_ITEMS = 4;

/** A slicer is taller than it is wide, so its thumbnail is portrait. Height
 *  48 + the option's 2x3 padding = 54, inside the band strip's 61px box. */
const SLICER_THUMB_SIZE: StyleThumbSize = { w: 40, h: 48 };

/** Thumbnails in the band strip before the expand button. */
const STRIP_VISIBLE = 4;

/** One design group per popover row: seven accents across. */
const POPOVER_COLUMNS = 7;

/**
 * A miniature slicer in a style's colours: a header bar with a caption dash,
 * then item buttons (the first selected) each with a text dash, inside the
 * style's border. Geometry is the same the former canvas thumbnail drew.
 */
export function SlicerStyleThumb({
  thumb,
  w,
  h,
}: {
  thumb: SlicerThumbColors;
  w: number;
  h: number;
}): React.ReactElement {
  const headerH = Math.floor(h * 0.22);
  const itemH = Math.floor((h - headerH) / THUMB_ITEMS);
  const itemPad = 2;
  const dashH = 1.5;
  const dashMarginX = 4;

  const items: React.ReactElement[] = [];
  for (let i = 0; i < THUMB_ITEMS; i++) {
    const y = headerH + i * itemH;
    const selected = i === 0;
    items.push(
      <g key={i}>
        <rect
          x={itemPad}
          y={y + 1}
          width={w - itemPad * 2}
          height={Math.max(0, itemH - 2)}
          fill={selected ? thumb.selectedBg : thumb.itemBg}
        />
        <rect
          x={dashMarginX + itemPad}
          y={y + (itemH - dashH) / 2}
          width={w * 0.45}
          height={dashH}
          fill={selected ? thumb.selectedFg : thumb.itemFg}
        />
      </g>,
    );
  }

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden
      focusable="false"
      style={{ display: "block" }}
    >
      <rect x={0} y={0} width={w} height={h} fill={thumb.bg} />
      <rect x={0} y={0} width={w} height={headerH} fill={thumb.headerBg} />
      <rect x={dashMarginX} y={(headerH - 2) / 2} width={w * 0.5} height={2} fill={thumb.headerFg} />
      {items}
      <rect
        x={0.5}
        y={0.5}
        width={w - 1}
        height={h - 1}
        fill="none"
        stroke={thumb.border}
        strokeWidth={1}
      />
    </svg>
  );
}

// ============================================================================
// SlicerStylesGallery
// ============================================================================

/** Every preset as a StyleGallery item, grouped by category. */
function buildItems(): StyleGalleryItem[] {
  return SLICER_STYLES.map((style) => ({
    id: style.id,
    name: slicerStyleName(style),
    group: SLICER_STYLE_CATEGORY_LABELS[style.category],
    renderThumb: ({ w, h }) => <SlicerStyleThumb thumb={style.thumb} w={w} h={h} />,
  }));
}

interface GalleryProps {
  /** The applied preset, or null when the selection is mixed / unknown. */
  selectedStyleId: string | null;
  onStyleSelect: (styleId: string) => void;
}

export function SlicerStylesGallery({ selectedStyleId, onStyleSelect }: GalleryProps): React.ReactElement {
  const items = useMemo(buildItems, []);
  return (
    <StyleGallery
      items={items}
      value={selectedStyleId}
      onChange={onStyleSelect}
      label="Slicer styles"
      expandLabel="More slicer styles"
      thumbSize={SLICER_THUMB_SIZE}
      visible={STRIP_VISIBLE}
      columns={POPOVER_COLUMNS}
      testIdPrefix="slicer-styles"
    />
  );
}
