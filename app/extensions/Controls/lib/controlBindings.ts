//! FILENAME: app/extensions/Controls/lib/controlBindings.ts
// PURPOSE: Controls' half of property bindings (D-BIND, WP-D S8a):
//            * the `control` registration in `@api/objectBindings` -- how a
//              floating control's region (or a script instance id) becomes a
//              binding ref, and which of its properties the UI offers to bind;
//            * the repaint that follows `onBindingsChanged`: invalidate the
//              paint caches of exactly the controls whose bindings or values
//              changed (all of them on a reload), then `requestOverlayRedraw`.
// CONTEXT: A control's binding id is its `uid`, minted by the backend
//          (`controls::assign_uid`). It is deliberately NOT held in the
//          floating store: seven sites add store entries, and the paste site
//          builds its entry from the LOCAL copy of the source's metadata, so a
//          cached uid there would be the SOURCE's (a pasted copy re-minted by
//          the backend would then write its fx edits onto the original). The
//          uid is read from the backend BY ANCHOR at the moment a ref is
//          needed -- the only spelling that cannot go stale.
//
//          Controls are overlaid in RUST (`resolve_control_properties` applies
//          every resolved `/properties/<key>` binding), so the painters keep
//          reading one resolved string per key and there is no TS overlay here.
//          The repaint only drops the right caches.
//
//          Never GRID_REFRESH from `onBindingsChanged`: that is a mutation
//          trigger for the binding bridge, and a volatile binding would loop
//          (value changes -> repaint -> re-evaluate -> value changes ...).

import {
  escapePointerSegment,
  isBindablePath,
  onBindingsChanged,
  registerBindableProperties,
  type BindablePropertyDescriptor,
  type ObjectBindingRef,
  type ObjectBindingsChange,
} from "@api/objectBindings";
import type { GridRegion } from "@api/gridOverlays";
import { appendContainerBindableDescriptors } from "@api/objectFormat";
import { getAllControls, getControlMetadata } from "./controlApi";
import {
  getAllFloatingControls,
  makeFloatingControlId,
  parseFloatingControlId,
} from "./floatingStore";
import {
  BUTTON_PROPERTIES,
  getPropertyDefinitions,
  type ControlEntry,
  type ControlMetadata,
  type PropertyDefinition,
} from "./types";
import { SHAPE_PROPERTIES } from "../Shape/shapeProperties";
import { IMAGE_PROPERTIES } from "../Image/imageProperties";
import { PAGE_NAVIGATOR_PROPERTIES } from "../PageNavigator/pageNavigatorProperties";

/** The grid-overlay region type every floating control is published as. */
export const CONTROL_REGION_TYPES: readonly string[] = ["floating-control"];

/**
 * The script object types whose instance ids are control anchors
 * ("control-<sheet>-<row>-<col>"): a shape's script and a button's script.
 */
export const CONTROL_SCRIPT_INSTANCE_TYPES: readonly string[] = ["shape", "button"];

// ============================================================================
// Refs
// ============================================================================

/** A control's binding ref from metadata the BACKEND returned, or null without a uid. */
export function controlBindingRefOf(meta: ControlMetadata | null | undefined): ObjectBindingRef | null {
  const uid = meta?.uid;
  return typeof uid === "string" && uid !== "" ? { kind: "control", id: uid } : null;
}

/** The binding ref of the control anchored at (sheet, row, col), read from the backend. */
export async function controlBindingRefAt(
  sheetIndex: number,
  row: number,
  col: number,
): Promise<ObjectBindingRef | null> {
  return controlBindingRefOf(await getControlMetadata(sheetIndex, row, col));
}

/** The anchor a floating-control region carries in its `data`. */
function anchorOfRegion(region: GridRegion): { sheetIndex: number; row: number; col: number } | null {
  const d = region.data as { sheetIndex?: unknown; row?: unknown; col?: unknown } | undefined;
  if (d && Number.isSafeInteger(d.sheetIndex) && Number.isSafeInteger(d.row) && Number.isSafeInteger(d.col)) {
    return { sheetIndex: d.sheetIndex as number, row: d.row as number, col: d.col as number };
  }
  return parseFloatingControlId(region.id);
}

// ============================================================================
// What the UI offers to bind
// ============================================================================

/** `/properties/<key>` for a control property key (RFC 6901 escaped). */
export function controlPropertyPointer(key: string): string {
  return `/properties/${escapePointerSegment(key)}`;
}

function descriptorsOf(defs: readonly PropertyDefinition[]): BindablePropertyDescriptor[] {
  const out: BindablePropertyDescriptor[] = [];
  const seen = new Set<string>();
  for (const def of defs) {
    if (def.readOnly) continue;
    const pointer = controlPropertyPointer(def.key);
    if (seen.has(pointer) || !isBindablePath("control", pointer)) continue;
    seen.add(pointer);
    out.push({ pointer, label: def.label, ...(def.group ? { group: def.group } : {}) });
  }
  return out;
}

/**
 * The bindable properties of a control: the rows of its own definition list
 * the catalog accepts. Without a region (no control type known) the union of
 * every built-in control kind's list.
 */
export function controlBindableDescriptors(region: GridRegion | null): BindablePropertyDescriptor[] {
  const controlType = (region?.data as { controlType?: unknown } | undefined)?.controlType;
  if (region && typeof controlType === "string" && controlType !== "") {
    return descriptorsOf(getPropertyDefinitions(controlType, region.id));
  }
  return descriptorsOf([
    ...BUTTON_PROPERTIES,
    ...SHAPE_PROPERTIES,
    ...IMAGE_PROPERTIES,
    ...PAGE_NAVIGATOR_PROPERTIES,
  ]);
}

/**
 * Register the `control` kind with the binding seam. Returns the unregister.
 * Its properties are the control's own rows, followed by the VISUAL CONTAINER
 * fields its format provider offers to bind (WP-C D-FORMAT,
 * lib/controlObjectFormat.ts) -- without repeating a pointer the rows already
 * offer (a shape's `fill` is its background colour).
 */
export function registerControlBindableProperties(): () => void {
  return registerBindableProperties({
    kind: "control",
    regionTypes: CONTROL_REGION_TYPES,
    instanceTypes: CONTROL_SCRIPT_INSTANCE_TYPES,
    refOf: async (region) => {
      const anchor = anchorOfRegion(region);
      return anchor ? controlBindingRefAt(anchor.sheetIndex, anchor.row, anchor.col) : null;
    },
    refForInstance: async (instanceId) => {
      const anchor = parseFloatingControlId(instanceId);
      return anchor ? controlBindingRefAt(anchor.sheetIndex, anchor.row, anchor.col) : null;
    },
    properties: (_ref, region) => appendContainerBindableDescriptors(controlBindableDescriptors(region), region),
  });
}

// ============================================================================
// Repaint on binding changes
// ============================================================================

/** What the repaint needs; injectable for the unit tier. */
export interface ControlBindingRepaintDeps {
  /** The sheets whose controls are in the floating store (what is painted). */
  paintedSheets(): number[];
  /** Every control of one sheet, with the uid the backend holds. */
  listControls(sheetIndex: number): Promise<ControlEntry[]>;
  /** Drop one control's paint caches. */
  invalidate(controlId: string): void;
  /** Drop every control's paint caches. */
  invalidateAll(): void;
  /** Repaint the overlay layer (never GRID_REFRESH). */
  redraw(): void;
}

/** The store ids (`control-s-r-c`) of the painted controls whose uid is in `uids`. */
export async function controlIdsForUids(
  uids: ReadonlySet<string>,
  deps: Pick<ControlBindingRepaintDeps, "paintedSheets" | "listControls">,
): Promise<string[]> {
  if (uids.size === 0) return [];
  const ids: string[] = [];
  for (const sheetIndex of deps.paintedSheets()) {
    let entries: ControlEntry[];
    try {
      entries = await deps.listControls(sheetIndex);
    } catch (err) {
      console.warn("[Controls] Could not list controls to repaint a binding change:", err);
      continue;
    }
    for (const e of entries) {
      const uid = e.metadata?.uid;
      if (typeof uid === "string" && uids.has(uid)) ids.push(makeFloatingControlId(e.sheetIndex, e.row, e.col));
    }
  }
  return ids;
}

/**
 * The `onBindingsChanged` listener: a reload repaints every control; otherwise
 * only the controls named by the change. Lookups are serialised, and the uids
 * of changes that arrive while one runs are merged into the next.
 */
export function createControlBindingRepaint(deps: ControlBindingRepaintDeps): {
  onChange(change: ObjectBindingsChange): void;
  /** Settles when every queued repaint has run (tests). */
  idle(): Promise<void>;
} {
  let queue: Promise<void> = Promise.resolve();
  let pending: Set<string> | null = null;

  const onChange = (change: ObjectBindingsChange): void => {
    if (change.reload) {
      deps.invalidateAll();
      deps.redraw();
      return;
    }
    const uids = change.objects.filter((o) => o.kind === "control").map((o) => o.id);
    if (uids.length === 0) return;
    if (pending) {
      for (const uid of uids) pending.add(uid);
      return;
    }
    const batch = new Set(uids);
    pending = batch;
    queue = queue.then(async () => {
      pending = null;
      const ids = await controlIdsForUids(batch, deps);
      if (ids.length === 0) return;
      for (const id of ids) deps.invalidate(id);
      deps.redraw();
    }).catch((err) => {
      console.warn("[Controls] Repaint after a binding change failed:", err);
    });
  };

  return { onChange, idle: () => queue };
}

/** Install the repaint over the real store and backend. Returns the uninstall. */
export function installControlBindingRepaint(
  deps: Pick<ControlBindingRepaintDeps, "invalidate" | "invalidateAll" | "redraw">,
): () => void {
  const repaint = createControlBindingRepaint({
    paintedSheets: () => [...new Set(getAllFloatingControls().map((c) => c.sheetIndex))],
    listControls: (sheetIndex) => getAllControls(sheetIndex),
    ...deps,
  });
  return onBindingsChanged(repaint.onChange);
}
