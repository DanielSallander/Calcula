//! FILENAME: app/src/api/objectSelection.ts
// PURPOSE: The OBJECT SELECTION seam: select, deselect and ask about floating
//          objects (charts, slicers, timelines, controls, floating ranges)
//          without going through a mouse press.
// CONTEXT: Until now the only way an object became selected was Core's
//          `floatingObject:selected` event, and every family treats that event
//          as "a left mouse press landed here": Controls RUNS a button's script
//          in run mode and opens its Properties pane, Slicer and Timeline arm a
//          pending click that the next mouseup anywhere completes, Charts
//          advances its sub-selection on the next mouseup. So keyboard object
//          cycling on a canvas (Tab / Shift+Tab / Escape) and a background
//          click that deselects need their own route, where "select" means
//          select and nothing else.
//
//          Each family registers ONE provider for the region types it owns
//          (the controlsService precedent: the owning extension decides HOW,
//          callers say WHAT). `selectObject` deselects every OTHER family
//          first, so a chart and a slicer can never both be selected by it.
//          Seams point one way: this module imports nothing from extensions.

import { getGridRegions, getOverlayRegistration, type GridRegion } from "./gridOverlays";

/** Keys an INNER selection can claim (a chart's series, a floating range's cell). */
export type ObjectSelectionKey = "Tab" | "Escape";

export interface ObjectSelectionProvider {
  /** The `GridRegion.type` values this provider owns. */
  types: readonly string[];
  /** Whether the object behind `region` is selected now. */
  isSelected(region: GridRegion): boolean;
  /**
   * Select the object behind `region` (and only it, within this family) the
   * way a keyboard or a script would: no click semantics -- no button run, no
   * script click event, no pending click, no pane opened.
   */
  select(region: GridRegion): void;
  /** Deselect everything this family has selected. */
  deselectAll(): void;
  /**
   * True while an INNER selection owns `key` -- a chart walked down to a
   * series owns Escape (it goes up a level first), a floating range with a
   * selected cell owns Tab and Escape (they move / clear the inner cell).
   */
  ownsKey?(key: ObjectSelectionKey): boolean;
}

const providers = new Map<string, ObjectSelectionProvider>();

/**
 * Register a family's provider for each of its region types. Last
 * registration wins per type; the cleanup removes only what is still this
 * provider's (a stale cleanup cannot remove a newer registration).
 */
export function registerObjectSelectionProvider(provider: ObjectSelectionProvider): () => void {
  for (const t of provider.types) providers.set(t, provider);
  return () => {
    for (const t of provider.types) {
      if (providers.get(t) === provider) providers.delete(t);
    }
  };
}

function distinctProviders(): ObjectSelectionProvider[] {
  return Array.from(new Set(providers.values()));
}

function guarded<T>(what: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    console.error(`[objectSelection] provider ${what} threw:`, err);
    return fallback;
  }
}

/** Whether some provider owns this region's type. */
export function canSelectObject(region: GridRegion): boolean {
  return providers.has(region.type);
}

/**
 * Select the object behind `region`, deselecting every other family first.
 * Returns false (and changes nothing) when no provider owns its type.
 */
export function selectObject(region: GridRegion): boolean {
  const owner = providers.get(region.type);
  if (!owner) return false;
  for (const p of distinctProviders()) {
    if (p !== owner) guarded("deselectAll", () => p.deselectAll(), undefined);
  }
  guarded("select", () => owner.select(region), undefined);
  return true;
}

/** Deselect every object in every family. */
export function deselectAllObjects(): void {
  for (const p of distinctProviders()) guarded("deselectAll", () => p.deselectAll(), undefined);
}

/** The first region in `regions` whose object is selected, or null. */
export function getSelectedObjectRegion(regions: readonly GridRegion[]): GridRegion | null {
  for (const r of regions) {
    const p = providers.get(r.type);
    if (p && guarded("isSelected", () => p.isSelected(r), false)) return r;
  }
  return null;
}

/** Whether any family's inner selection owns `key` right now. */
export function objectOwnsKey(key: ObjectSelectionKey): boolean {
  return distinctProviders().some((p) => guarded("ownsKey", () => p.ownsKey?.(key) ?? false, false));
}

/**
 * The floating regions currently published, in PAINT order (bottom first):
 * by overlay priority, then publication order -- the order the renderer
 * stacks them in. `regions` defaults to the live list; only floating regions
 * whose type has a selection provider are returned (what cannot be selected
 * cannot be cycled to).
 */
export function selectableFloatingRegions(regions: readonly GridRegion[] = getGridRegions()): GridRegion[] {
  return regions
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => !!r.floating && providers.has(r.type))
    .sort((a, b) => {
      const pa = getOverlayRegistration(a.r.type)?.priority ?? 0;
      const pb = getOverlayRegistration(b.r.type)?.priority ?? 0;
      return pa - pb || a.i - b.i;
    })
    .map(({ r }) => r);
}

/** Test hook: forget every provider. */
export function resetObjectSelectionProviders(): void {
  providers.clear();
}
