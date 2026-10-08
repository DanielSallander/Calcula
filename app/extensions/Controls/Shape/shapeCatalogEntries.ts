//! FILENAME: app/extensions/Controls/Shape/shapeCatalogEntries.ts
// PURPOSE: The shape catalog, flattened out of its categories, as the
//          @api/controlsService seam lists it (`listShapeCatalog`): id, label,
//          category, default size, line flag -- and, since the Canvas contract
//          §4.3, a THUMBNAIL of each shape drawn from its own geometry.
// CONTEXT: It used to be a closure inside index.ts. It moved here so the list a
//          host actually receives can be tested by RUNNING it (importing
//          index.ts runs the whole extension), which is what pins "every shape
//          has a picture" rather than a source-text match.

import type { ShapeCatalogEntry } from "@api/controlsService";
import { getShapeCategories } from "./shapeCatalog";
import { shapeThumbnail } from "./shapePathToSvg";

/** Built once: the catalog is a module constant, so nothing about it can change
 *  during a session. */
let flattened: ShapeCatalogEntry[] | null = null;

/** Every shape the insert gallery can draw, in catalog order. */
export function listShapeCatalogEntries(): ShapeCatalogEntry[] {
  if (!flattened) {
    flattened = getShapeCategories().flatMap((cat) =>
      cat.shapes.map((s) => ({
        id: s.id,
        label: s.label,
        categoryId: cat.id,
        categoryLabel: cat.label,
        defaultWidth: s.defaultWidth,
        defaultHeight: s.defaultHeight,
        isLine: s.isLine === true,
        thumbnail: shapeThumbnail(s),
      })),
    );
  }
  return flattened;
}
