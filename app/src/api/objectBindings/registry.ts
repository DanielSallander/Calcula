//! FILENAME: app/src/api/objectBindings/registry.ts
// PURPOSE: Which properties of an object the UI offers to bind, and THE way any
//          consumer turns a grid region (or a script instance id) into a
//          binding ref.
// CONTEXT: Inversion of Control. Each family that owns a kind registers ONE
//          `BindablePropertiesRegistration` for it (Charts: chart, Controls:
//          control, Slicer: slicer, ...); the Format pane, the Bound
//          Properties view and the script host ask HERE and never learn which
//          extension answered. WP-C appends its container descriptors through
//          the family's own `properties(ref, region)` -- a second registration
//          for the same kind REPLACES the first and says so loudly, because
//          two owners of one kind is a wiring defect, not a feature.
//
//          A control's binding id is its `uid`, which the floating store does
//          not hold: `refOf` may be async and read it from the backend by
//          anchor. Nothing here parses a region id into a ref.
//
//          Every offered pointer must pass the catalog mirror. A descriptor
//          that does not is DROPPED with a console.error naming it, so a
//          family can never offer an fx button Rust would refuse.

import type { GridRegion } from "../gridOverlays";
import type { ObjectBindingKind, ObjectBindingRef } from "../types";
import { isBindablePath, isObjectBindingKind } from "./catalog";

/** One property the UI offers to bind. */
export interface BindablePropertyDescriptor {
  /** A concrete JSON Pointer (no `*`), e.g. "/spec/series/0/name". */
  pointer: string;
  /** What the pane calls it ("Title", "Series 1 name"). */
  label: string;
  /** Optional pane group ("Title", "Axes", "Colors"). */
  group?: string;
}

/** A family's registration for ONE kind of object. */
export interface BindablePropertiesRegistration {
  kind: ObjectBindingKind;
  /** The `GridRegion.type` values this kind is drawn as. */
  regionTypes: readonly string[];
  /** May be async: a CONTROL's uid is read from the backend by anchor. */
  refOf(region: GridRegion): ObjectBindingRef | null | Promise<ObjectBindingRef | null>;
  /**
   * The script object types (`objectType` of a script instance) this kind
   * answers for, e.g. ["shape"] for controls. Defaults to `[kind]`.
   */
  instanceTypes?: readonly string[];
  /** Script instance id ("control-0-5-2", a chart id, ...) -> binding ref. */
  refForInstance?(instanceId: string): ObjectBindingRef | null | Promise<ObjectBindingRef | null>;
  /** The properties to offer for this object (WP-C appends container rows here). */
  properties(ref: ObjectBindingRef, region: GridRegion | null): BindablePropertyDescriptor[];
}

const registrations = new Map<ObjectBindingKind, BindablePropertiesRegistration>();

/**
 * Register a kind's bindable properties. ONE per kind: a second registration
 * for the same kind replaces the first and logs an error. Returns the
 * unregister function (which removes only THIS registration).
 */
export function registerBindableProperties(reg: BindablePropertiesRegistration): () => void {
  if (!isObjectBindingKind(reg.kind)) {
    console.error(`[objectBindings] '${String(reg.kind)}' is not a binding kind; registration ignored.`);
    return () => {};
  }
  if (registrations.has(reg.kind)) {
    console.error(
      `[objectBindings] A second registration for kind '${reg.kind}' replaces the first. ` +
        "One family owns a kind; another family adds its rows through that family's properties().",
    );
  }
  registrations.set(reg.kind, reg);
  return () => {
    if (registrations.get(reg.kind) === reg) registrations.delete(reg.kind);
  };
}

function registrationForRegion(region: GridRegion): BindablePropertiesRegistration | null {
  for (const reg of registrations.values()) {
    if (reg.regionTypes.includes(region.type)) return reg;
  }
  return null;
}

/** The registration that answers for a kind, or null (diagnostics and the Bound Properties view). */
export function getBindablePropertiesRegistration(kind: ObjectBindingKind): BindablePropertiesRegistration | null {
  return registrations.get(kind) ?? null;
}

/** A ref the registration produced, checked for shape (a family bug must not reach the wire). */
function checkedRef(ref: ObjectBindingRef | null | undefined, reg: BindablePropertiesRegistration): ObjectBindingRef | null {
  if (!ref) return null;
  if (ref.kind !== reg.kind || typeof ref.id !== "string" || ref.id === "") {
    console.error(
      `[objectBindings] The '${reg.kind}' registration produced a malformed ref ${JSON.stringify(ref)}; ignored.`,
    );
    return null;
  }
  return { kind: ref.kind, id: ref.id };
}

/** THE way any consumer (Format pane, Bound Properties, scripts) turns a region into a ref. */
export async function bindingRefForRegion(region: GridRegion): Promise<ObjectBindingRef | null> {
  const reg = registrationForRegion(region);
  if (!reg) return null;
  try {
    return checkedRef(await reg.refOf(region), reg);
  } catch (err) {
    console.warn(`[objectBindings] Could not identify the '${reg.kind}' object of region ${region.id}:`, err);
    return null;
  }
}

/** A script instance (objectType + instanceId) -> its binding ref, or null. */
export async function bindingRefForInstance(objectType: string, instanceId: string): Promise<ObjectBindingRef | null> {
  for (const reg of registrations.values()) {
    const types = reg.instanceTypes ?? [reg.kind];
    if (!types.includes(objectType) || !reg.refForInstance) continue;
    try {
      return checkedRef(await reg.refForInstance(instanceId), reg);
    } catch (err) {
      console.warn(`[objectBindings] Could not identify ${objectType} '${instanceId}':`, err);
      return null;
    }
  }
  return null;
}

/**
 * The object behind a region and the properties its family offers to bind,
 * or null for a region no family registered (or whose object has no ref yet).
 * Descriptors whose pointer the catalog does not know are dropped and logged.
 */
export async function getBindableProperties(
  region: GridRegion,
): Promise<{ ref: ObjectBindingRef; properties: BindablePropertyDescriptor[] } | null> {
  const reg = registrationForRegion(region);
  if (!reg) return null;
  const ref = await bindingRefForRegion(region);
  if (!ref) return null;
  let offered: BindablePropertyDescriptor[];
  try {
    offered = reg.properties(ref, region) ?? [];
  } catch (err) {
    console.warn(`[objectBindings] The '${reg.kind}' registration failed to list its properties:`, err);
    return { ref, properties: [] };
  }
  const properties: BindablePropertyDescriptor[] = [];
  for (const d of offered) {
    if (d && typeof d.pointer === "string" && !d.pointer.includes("*") && isBindablePath(ref.kind, d.pointer)) {
      properties.push(d);
    } else {
      console.error(
        `[objectBindings] The '${reg.kind}' registration offered '${d?.pointer}', which the bindable-path ` +
          "catalog does not accept; it is not offered.",
      );
    }
  }
  return { ref, properties };
}
