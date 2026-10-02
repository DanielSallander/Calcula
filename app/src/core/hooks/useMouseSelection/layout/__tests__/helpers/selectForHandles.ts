//! FILENAME: app/src/core/hooks/useMouseSelection/layout/__tests__/helpers/selectForHandles.ts
// PURPOSE: Make stand-in floating objects SELECTED for Core's resize handles.
// CONTEXT: Since BUG-0258 design phase 3 a floating object's handles are live
//          only while it is selected (core/lib/floatingHandles.ts
//          `floatingHandlesLive` -> @api/objectSelection `isObjectInSelection`),
//          which asks the selection provider registered for the region's TYPE.
//          The resize tests drive Core's real handlers with stand-in regions
//          and no family, so they register a stand-in provider here. Each test
//          file keeps its own set; the default selects everything of the types.

import {
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
} from "../../../../../../api/objectSelection";
import type { GridRegion } from "../../../../../../api/gridOverlays";

/**
 * Register a provider for `types` whose `isSelected` is `isSelected` (default:
 * every region of those types is selected). Returns the cleanup, which also
 * forgets any selection-set state a test left behind.
 */
export function selectForHandles(
  types: readonly string[],
  isSelected: (region: GridRegion) => boolean = () => true,
): () => void {
  const off = registerObjectSelectionProvider({
    types,
    isSelected,
    select: () => {},
    deselectAll: () => {},
  });
  return () => {
    off();
    resetObjectSelectionProviders();
  };
}
