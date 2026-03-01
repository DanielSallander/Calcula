//! FILENAME: app/extensions/BuiltIn/CellBookmarks/rendering/bookmarkStyleInterceptor.ts
// PURPOSE: Style interceptor for bookmark background highlighting.
// CONTEXT: When highlight mode is enabled, applies a subtle background tint
//          to bookmarked cells. Follows the pattern from styleInterceptors.ts.

import type { StyleInterceptorFn } from "../../../../src/api";
import { isHighlightEnabled, hasBookmarkAt, getBookmarkAt } from "../lib/bookmarkStore";
import { BOOKMARK_TINT_COLORS } from "../lib/bookmarkTypes";

/**
 * Style interceptor that applies a subtle background tint to bookmarked cells.
 * Only active when highlight mode is toggled on.
 */
export const bookmarkStyleInterceptor: StyleInterceptorFn = (
  _cellValue,
  _baseStyle,
  coords
) => {
  if (!isHighlightEnabled()) return null;

  if (!hasBookmarkAt(coords.row, coords.col)) return null;

  const bookmark = getBookmarkAt(coords.row, coords.col);
  if (!bookmark) return null;

  return {
    backgroundColor: BOOKMARK_TINT_COLORS[bookmark.color],
  };
};
