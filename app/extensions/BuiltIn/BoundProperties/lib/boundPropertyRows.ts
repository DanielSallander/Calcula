//! FILENAME: app/extensions/BuiltIn/BoundProperties/lib/boundPropertyRows.ts
// PURPOSE: What the Bound Properties view lists -- one row per binding in the
//          workbook -- and how "Go to" reaches the bound object.
// CONTEXT: Transparency (CLAUDE.md vision): a binding is EVALUATED, never
//          executed, so it is not code and is not in Code in This File; but the
//          user must still be able to see every property that follows a formula,
//          what it reads and what it shows now. Everything here goes through the
//          `@api/objectBindings` seam (Rust owns the store, the names and the
//          locations); a property's label is the owning family's own, asked of
//          its registration, so this view never learns which extension answered.

import type { GridRegion } from "@api";
import { activateSheet } from "@api";
import { getGridStateSnapshot } from "@api/grid";
import {
  OBJECT_BINDING_KIND_LABELS,
  bindingRefForRegion,
  getBindablePropertiesRegistration,
  type ObjectBindingInfo,
  type ObjectBindingPlace,
  type ObjectBindingRef,
} from "@api/objectBindings";
import { selectObject, selectableFloatingRegions } from "@api/objectSelection";

/** One row of the view. */
export interface BoundPropertyRow {
  /** Stable React key: `kind:id path`. */
  key: string;
  binding: ObjectBindingInfo;
  /** Where the object is; null for an ORPHAN (its object no longer exists). */
  place: ObjectBindingPlace | null;
  /** "chart Revenue card" -- the Object column. */
  objectText: string;
  /** The family's label for the property, else the path. */
  propertyText: string;
}

/** `kind:id` -- the identity of an object across the seam's types. */
export function objectKey(object: ObjectBindingRef): string {
  return `${object.kind}:${object.id}`;
}

/** The objects the bindings name, once each, in first-seen order. */
export function distinctObjects(bindings: readonly ObjectBindingInfo[]): ObjectBindingRef[] {
  const seen = new Set<string>();
  const out: ObjectBindingRef[] = [];
  for (const b of bindings) {
    const k = objectKey(b.object);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ kind: b.object.kind, id: b.object.id });
  }
  return out;
}

/**
 * The owning family's label for `path` on `object`, or null. Asked of the
 * kind's registration with no region (the view has none); a family that
 * offers nothing for the pointer leaves the path as the label.
 */
export function familyLabelFor(object: ObjectBindingRef, path: string): string | null {
  const reg = getBindablePropertiesRegistration(object.kind);
  if (!reg) return null;
  try {
    const found = reg.properties({ kind: object.kind, id: object.id }, null).find((p) => p.pointer === path);
    return found?.label ?? null;
  } catch {
    return null;
  }
}

/**
 * The rows, sorted by sheet, then object, then property. Orphans (no place)
 * sort last; they stay listed so the user can see and remove them.
 */
export function buildBoundPropertyRows(
  bindings: readonly ObjectBindingInfo[],
  places: readonly ObjectBindingPlace[],
  labelOf: (object: ObjectBindingRef, path: string) => string | null = familyLabelFor,
): BoundPropertyRow[] {
  const byObject = new Map<string, ObjectBindingPlace>();
  for (const p of places) byObject.set(objectKey(p.object), p);
  const rows = bindings.map((binding): BoundPropertyRow => {
    const place = byObject.get(objectKey(binding.object)) ?? null;
    const kindText = OBJECT_BINDING_KIND_LABELS[binding.object.kind] ?? binding.object.kind;
    return {
      key: `${objectKey(binding.object)} ${binding.path}`,
      binding,
      place,
      objectText: place ? `${kindText} ${place.name}` : `${kindText} (no longer in this workbook)`,
      propertyText: labelOf(binding.object, binding.path) ?? binding.path,
    };
  });
  rows.sort((a, b) => {
    const sa = a.place?.sheetIndex ?? Number.MAX_SAFE_INTEGER;
    const sb = b.place?.sheetIndex ?? Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    const o = a.objectText.localeCompare(b.objectText);
    if (o !== 0) return o;
    return a.propertyText.localeCompare(b.propertyText);
  });
  return rows;
}

/** The Value column: what the property shows now, or why it cannot. */
export function valueText(binding: ObjectBindingInfo): { text: string; isError: boolean } {
  const r = binding.resolved;
  if (!r) return { text: "Not calculated yet", isError: false };
  if (r.pending) return { text: "Calculating...", isError: false };
  if (r.error) return { text: r.display ? `${r.display} - ${r.error}` : r.error, isError: true };
  return { text: r.display, isError: false };
}

/** How long Go to waits for the switched-to sheet's object regions to appear. */
const GO_TO_FRAMES = 30;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });
}

/** The selectable region on the current sheet whose binding ref is `object`. */
async function regionOf(object: ObjectBindingRef): Promise<GridRegion | null> {
  for (const region of selectableFloatingRegions()) {
    const ref = await bindingRefForRegion(region);
    if (ref && ref.kind === object.kind && ref.id === object.id) return region;
  }
  return null;
}

/**
 * Go to: activate the object's sheet (the same switch a tab click makes) and
 * select the object through the object-selection seam. A canvas page IS its
 * sheet, so activating it is the whole job. Resolves true when the object was
 * selected (or the page shown).
 */
export async function goToBoundObject(place: ObjectBindingPlace): Promise<boolean> {
  const active = getGridStateSnapshot()?.sheetContext.activeSheetIndex;
  if (active !== place.sheetIndex) {
    await activateSheet(place.sheetIndex);
  }
  if (place.object.kind === "canvasPage") return true;
  // The switched-to sheet's object regions are re-synced by their families
  // after the switch; wait a few frames for them.
  for (let i = 0; i < GO_TO_FRAMES; i++) {
    const region = await regionOf(place.object);
    if (region) return selectObject(region);
    await nextFrame();
  }
  return false;
}
