//! FILENAME: app/extensions/CanvasSheet/components/tabParts.tsx
// PURPOSE: Two small pictures the Canvas-tab groups share: a RibbonIcon drawn
//          by its KEY (the visual catalogue names pictures by key), and a
//          shape's picture drawn from the shape catalog's own geometry.

import React from "react";
import { RibbonIcon, type RibbonIconKey } from "@api/ribbonIcons";
import type { ShapeCatalogEntry } from "@api/controlsService";

/** A RibbonIcon named by its key, at `size` px. */
export function IconByKey({ name, size }: { name: RibbonIconKey; size: number }): React.ReactElement {
  const Icon = RibbonIcon[name] as React.ComponentType<{ size?: number }>;
  return <Icon size={size} />;
}

/** The thinnest a shape's picture gets, as a share of the square (a very
 *  flat shape stays visible as a shape, not a hairline). */
const THUMBNAIL_MIN_SHARE = 0.25;

/**
 * A shape's picture for a menu row: the catalog's OWN normalized path
 * (`ShapeCatalogEntry.thumbnail`, @api/controlsService), drawn as the seam
 * says -- filled unless it is a line, with a hairline that does not scale --
 * in the menu's text colour, so it follows every skin. Null when the provider
 * gave no picture (the caller keeps the row's icon column blank).
 *
 * PROPORTIONS. The path is the shape at a SQUARE box; its own proportions are
 * the catalog's `defaultWidth` x `defaultHeight`. Drawn in a square, a 2:1
 * right arrow looked as tall as it is wide (review finding 2026-10-08), so the
 * picture is stretched to those proportions with `preserveAspectRatio="none"`
 * (the seam's own recipe) and centred in a square slot the size of the icon
 * column. A line stays square: its box is its direction, not a shape.
 */
export function ShapeThumbnail({
  entry,
  size = 20,
}: {
  entry: Pick<ShapeCatalogEntry, "thumbnail" | "isLine"> &
    Partial<Pick<ShapeCatalogEntry, "defaultWidth" | "defaultHeight">>;
  size?: number;
}): React.ReactElement | null {
  const t = entry.thumbnail;
  if (!t) return null;
  const { width, height } = thumbnailBox(entry, size);
  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: size, height: size }}
    >
      <svg
        data-shape-thumbnail=""
        width={width}
        height={height}
        viewBox={t.viewBox}
        preserveAspectRatio={width === height ? undefined : "none"}
        aria-hidden="true"
        focusable="false"
        style={{ overflow: "visible" }}
      >
        <path
          d={t.d}
          fill={entry.isLine ? "none" : "currentColor"}
          fillOpacity={entry.isLine ? undefined : 0.16}
          stroke="currentColor"
          strokeWidth={1.25}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </span>
  );
}

/** The drawing's box inside a `size` square: the shape's proportions, the
 *  longer side the full square (see ShapeThumbnail). */
function thumbnailBox(
  entry: { isLine?: boolean; defaultWidth?: number; defaultHeight?: number },
  size: number,
): { width: number; height: number } {
  const w = entry.defaultWidth ?? 0;
  const h = entry.defaultHeight ?? 0;
  if (entry.isLine || !(w > 0) || !(h > 0) || w === h) return { width: size, height: size };
  const short = (n: number) => Math.round(Math.max(THUMBNAIL_MIN_SHARE, n) * size * 100) / 100;
  return w > h ? { width: size, height: short(h / w) } : { width: short(w / h), height: size };
}
