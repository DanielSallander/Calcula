//! FILENAME: app/extensions/Pivot/components/PivotTableStylesGallery.tsx
// PURPOSE: PivotTable Styles gallery for the "Pivot Table Design" panel.
// CONTEXT: Excel's PivotTable Styles gallery, built on the @api/layout
//          StyleGallery: in the ribbon band a 61px strip of thumbnails plus an
//          expand button that opens every style as a grouped Light / Medium /
//          Dark grid; in the sidebar or a launcher flyout the grid inline.
//          Hovering or keyboard-focusing a thumbnail previews it on the pivot
//          (onStylePreview); choosing commits it. "Clear" removes the chosen
//          style, as the old gallery's footer item did.
//
//          The style DATA — the catalogue, the style -> PivotTheme mapping and
//          the thumbnail geometry — lives in ../lib/pivotStyles.ts. This file
//          is chrome and carries no colour literal (app/eslint.boundaries.js);
//          thumbnails paint from that data module inside StyleGallery's
//          `data-colour-data` box. The names this file used to export are
//          re-exported below, because Pivot/index.ts imports them from here.

import React from "react";
import { css } from "@emotion/css";
import {
  CommandButton,
  StyleGallery,
  GAP_XS,
  HERO_ICON_SIZE,
  ROW_GAP,
  useSurfaceLayout,
  type StyleGalleryItem,
} from "@api/layout";
import { RibbonIcon } from "@api/ribbonIcons";
import {
  getPivotThumbColors,
  orderedPivotStyles,
  pivotStyleDisplayName,
  pivotThumbnailRects,
  type ExcelPivotStyle,
} from "../lib/pivotStyles";

// ============================================================================
// Re-exports (consumed by index.ts and PivotDesignSections.tsx)
// ============================================================================

export {
  PIVOT_STYLES,
  PIVOT_STYLES_BY_ID,
  DEFAULT_PIVOT_STYLE_ID,
  getThemeOverridesForStyle,
} from "../lib/pivotStyles";

// ============================================================================
// Thumbnail
// ============================================================================

export interface PivotStyleThumbnailProps {
  style: ExcelPivotStyle;
  width: number;
  height: number;
}

/**
 * A miniature pivot in the style's colours, drawn as SVG from
 * `pivotThumbnailRects`. Pure DOM (no canvas, no effect), so it is crisp at any
 * device pixel ratio and renders the same in a test as on screen.
 */
export function PivotStyleThumbnail({ style, width, height }: PivotStyleThumbnailProps): React.ReactElement {
  const { rects, outline } = pivotThumbnailRects(getPivotThumbColors(style), width, height);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: "block" }}
      aria-hidden
      data-colour-data=""
      data-pivot-style={style.name}
    >
      {rects.map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={r.fill} />
      ))}
      <rect
        x={0.5}
        y={0.5}
        width={Math.max(0, width - 1)}
        height={Math.max(0, height - 1)}
        fill="none"
        stroke={outline}
        strokeWidth={1}
      />
    </svg>
  );
}

// ============================================================================
// Gallery items
// ============================================================================

/** Every style in gallery order, as StyleGallery items (built once). */
const GALLERY_ITEMS: StyleGalleryItem[] = orderedPivotStyles().map((style) => ({
  id: style.name,
  name: pivotStyleDisplayName(style.name),
  group: style.category,
  renderThumb: ({ w, h }) => <PivotStyleThumbnail style={style} width={w} height={h} />,
}));

/** Thumbnails in the band strip. */
const STRIP_VISIBLE = 3;
/** Columns of the expanded grid (the old dropdown's seven). */
const POPOVER_COLUMNS = 7;

// ============================================================================
// Styles (layout only — no colour)
// ============================================================================

/** Band: the strip and the Clear hero side by side, both 61px tall. */
const bandRow = css`
  display: flex;
  flex-direction: row;
  align-items: stretch;
  gap: ${GAP_XS}px;
  min-width: 0;
`;

/** Panel / flyout: the grid, then Clear under it. */
const panelColumn = css`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: ${ROW_GAP}px;
  min-width: 0;
`;

// ============================================================================
// PivotTableStylesGallery
// ============================================================================

export interface PivotTableStylesGalleryProps {
  /** The applied style id ("" = cleared). */
  selectedStyleId: string;
  /** Commit a style. */
  onStyleSelect: (styleId: string) => void;
  /** Remove the applied style. */
  onStyleClear: () => void;
  /** Live preview: a style id while one is hovered/focused, null when it ends. */
  onStylePreview?: (styleId: string | null) => void;
}

export function PivotTableStylesGallery({
  selectedStyleId,
  onStyleSelect,
  onStyleClear,
  onStylePreview,
}: PivotTableStylesGalleryProps): React.ReactElement {
  const layout = useSurfaceLayout();
  const band = layout.container === "band";

  return (
    <div className={band ? bandRow : panelColumn} data-testid="pivot-styles-gallery">
      <StyleGallery
        items={GALLERY_ITEMS}
        value={selectedStyleId || null}
        onChange={onStyleSelect}
        onHover={onStylePreview}
        label="PivotTable styles"
        expandLabel="More PivotTable Styles"
        visible={STRIP_VISIBLE}
        columns={POPOVER_COLUMNS}
        testIdPrefix="pivot-style"
      />
      <CommandButton
        icon={<RibbonIcon.ClearFormatting size={HERO_ICON_SIZE} />}
        label="Clear"
        tooltip="Clear the PivotTable style"
        onClick={onStyleClear}
        data-testid="pivot-style-clear"
      />
    </div>
  );
}
