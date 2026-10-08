//! FILENAME: app/src/api/slicerClearService.ts
// PURPOSE: The feature-neutral seam behind a "Clear all slicers" button (Canvas
//          contract §4.4, Power BI's Clear all slicers action): clear every
//          slicer on ONE sheet without knowing which extensions draw slicers.
// CONTEXT: Inversion of Control, the buttonControlService / autoFilterService
//          shape. The Slicer extension OWNS a slicer's selection, its filter on
//          every pivot, table and chart it reaches, the one-undo-step gesture
//          that writes both (BUG-0187) and the "this would overwrite a pivot"
//          question; a button's click owns none of it. So the button asks this
//          seam, and each slicer FAMILY answers for its own: the Slicer
//          extension registers a provider (Slicer/lib/slicerClearProvider.ts),
//          and the Timeline slicer can register its own beside it -- which is
//          why this seam keeps a SET of providers where the button and control
//          seams keep one.
//
//          A caller that hand-rolled it -- `clear_slicer_filter` per id -- would
//          clear the selection and leave every pivot it filters filtered, with
//          the backend reporting success: the Seam Rule's "callers say WHAT,
//          the owner decides HOW".
//
// LOUD WHEN EMPTY. No provider means no slicer family is loaded, and "0
// slicers cleared" would read as success; the call throws instead, in a
// sentence the button can show. One family failing does not stop the others:
// every family is asked, then the first failure is thrown.

/** What a slicer family provides. */
export interface SlicerClearProvider {
  /**
   * Clear every slicer of this family on the sheet with this (state-vector)
   * index that carries a filter, each the way its own Clear button does.
   * Resolves with how many were cleared.
   */
  clearSlicersOnSheet(sheetIndex: number): Promise<number>;
}

const providers = new Set<SlicerClearProvider>();

/**
 * Register a slicer family's provider. Called by the family at activation;
 * returns the unregister function for its cleanup list (idempotent, and it
 * removes only the provider it registered).
 */
export function registerSlicerClearProvider(provider: SlicerClearProvider): () => void {
  providers.add(provider);
  return () => {
    providers.delete(provider);
  };
}

/** Whether any slicer family can be cleared. */
export function hasSlicerClearProvider(): boolean {
  return providers.size > 0;
}

/**
 * Clear every filtered slicer, of every family, on the sheet `sheetIndex`.
 * Resolves with the total cleared. THROWS when no family is registered, and
 * -- after every family has been asked -- with the first family's failure.
 */
export async function clearSlicersOnSheet(sheetIndex: number): Promise<number> {
  if (providers.size === 0) {
    throw new Error(
      "Slicers are unavailable: no slicer family is registered (the Slicer extension is not loaded), so nothing was cleared.",
    );
  }
  let total = 0;
  let firstFailure: unknown = null;
  for (const provider of [...providers]) {
    try {
      total += await provider.clearSlicersOnSheet(sheetIndex);
    } catch (err) {
      if (firstFailure === null) firstFailure = err;
    }
  }
  if (firstFailure !== null) {
    throw firstFailure instanceof Error ? firstFailure : new Error(String(firstFailure));
  }
  return total;
}

/** Test/reset hook: forget every provider. */
export function resetSlicerClearProviders(): void {
  providers.clear();
}
