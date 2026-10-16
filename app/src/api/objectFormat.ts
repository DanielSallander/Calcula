//! FILENAME: app/src/api/objectFormat.ts
// PURPOSE: The OBJECT FORMAT seam (WP-C D-FORMAT): read, preview and commit
//          the VISUAL CONTAINER (@api/visualContainer -- padding, title,
//          subtitle, divider, spacing, background, border, shadow) of a
//          floating object of ANY family, as ONE undo step however many
//          families a change touches; plus the two helpers every family's
//          region publisher and bindable-properties registration need to put
//          WP-D's bindings (@api/objectBindings) on top of it.
// CONTEXT: Modelled on @api/objectGeometry: callers say WHAT (a container
//          patch), the owning extension decides HOW. Each family registers ONE
//          `ObjectFormatProvider` for the region types it owns. A provider
//          synthesises its STORED container from the family's own one-spelling
//          fields (a chart's title text lives in `spec.title`, a slicer's in
//          `headerText`), supplies its defaults and capabilities, previews a
//          patch in its local cache only (the transient-write pattern: no
//          write, no undo, no dirty flag) and COMMITS it through the family's
//          own backend door, whose undo recorder joins the transaction opened
//          here.
//
// READ = THE LITERAL. `provider.read(region)` is the STORED container (owner
//          decision R6: the Format pane shows the literal under an fx-off row
//          and WP-D's BindableField shows the resolved display under an fx-on
//          row). The RESOLVED container -- what the painter and the pane's
//          preview see -- is `ObjectFormatSnapshot.resolved` / `region.container`,
//          built by `resolveContainerForObject` with the precedence
//          bound > stored > defaults.
//
// ONE UNDO STEP. `commitObjectFormat` validates every patch, refuses a patch on
//          a subscribed page, and runs every surviving commit inside ONE
//          `runInUndoTransaction(label)`. A family whose persist is DEBOUNCED
//          (charts: `updateChartSpec` -> a 300 ms save) implements `flush`, and
//          every involved provider's flush is AWAITED INSIDE the transaction,
//          before it commits -- a debounced save that landed after the commit
//          would be a second, unlabelled undo step (review R1-4). Lock Objects
//          does NOT refuse a format: the lock is about where objects ARE.
//          Refusals are collected into ONE error toast.
//
//          Seams point one way: this module imports nothing from extensions.

import type { ComponentType } from "react";
import { requestOverlayRedraw, type GridRegion } from "./gridOverlays";
import { showToast } from "./notifications";
import { getLayoutSurface } from "./layoutSurface";
import { runInUndoTransaction } from "./objectGeometry";
import { SIZE_POSITION_SUBSCRIBED } from "./objectPosition";
import { getGridStateSnapshot } from "../core/state/GridContext";
import {
  bindingRefForRegion,
  getBinding,
  getResolved,
  onBindingsChanged,
  type BindablePropertyDescriptor,
  type ObjectBindingKind,
  type ObjectBindingRef,
} from "./objectBindings";
import { paintedValue } from "./objectBindings/overlay";
import {
  VISUAL_CONTAINER_FIELD_IDS,
  resolveVisualContainer,
  validateVisualContainerPatch,
  type ContainerFieldId,
  type ResolvedVisualContainer,
  type VisualContainerFormat,
  type VisualContainerPatch,
} from "./visualContainer";
import type { ContainerRegion } from "./visualContainerPaint";

// ============================================================================
// Names
// ============================================================================

/** The undo step a Format pane commit records (and the toast's lead). */
export const OBJECT_FORMAT_UNDO_LABEL = "Format Object";

/** Why a change was refused: no family formats this object. */
export const OBJECT_FORMAT_NO_PROVIDER = "This object has no format settings.";

/** The pane group every container descriptor carries in the bindings registry. */
export const OBJECT_FORMAT_BINDING_GROUP = "Format";

// ============================================================================
// Types
// ============================================================================

/** What the Format pane may offer for one object (the provider decides, per region). */
export interface ContainerCapabilities {
  padding: boolean;
  lockAspect: boolean;
  title: boolean;
  /** "free": a display string; "identity": renames the object (floating grid -- never bindable); "none". */
  titleText: "free" | "identity" | "none";
  subtitle: boolean;
  divider: boolean;
  /**
   * Whether the family honours `title.wrap` / `subtitle.wrap`. Absent = true.
   * False for a one-line header (slicer, timeline, floating grid), so the Title
   * card never shows a "Wrap text" row that changes nothing.
   */
  titleWrap?: boolean;
  /**
   * Whether the family honours the `spacing.*` fields at all. Absent = true
   * (then each distance shows only beside the band it follows: "Below title"
   * with a title, "Below subtitle" with a subtitle, "Below divider" with a
   * divider). False for the floating grid, whose title bar sits on its cells.
   */
  spacing?: boolean;
  background: boolean;
  backgroundTransparency: boolean;
  gradient: boolean;
  border: boolean;
  borderRadius: boolean;
  shadow: boolean;
  dataFormat: boolean;
}

/** One number format the Data format card edits. */
export interface DataFormatField {
  /** Provider-private (pivot: value-field index; chart: measure name). */
  key: string;
  /** "Revenue". */
  label: string;
  /** The USER override only (pivot: null when number_format_from_model); null = the source's. */
  format: string | null;
  /** What the source says (MeasureFieldInfo.formatString), shown as placeholder. */
  sourceFormat: string | null;
}

/** What a family's own Format card receives. */
export interface FormatCardProps {
  region: GridRegion;
  readOnly: boolean;
  readOnlyReason: string | null;
}

/** A family's own "Visual" card (chart element formatting, pivot style gallery, slicer items...). */
export interface FormatCardContribution {
  id: string;
  title: string;
  order?: number;
  Component: ComponentType<FormatCardProps>;
}

/** One family's format provider. */
export interface ObjectFormatProvider {
  /** The `GridRegion.type` values this provider owns. */
  types: readonly string[];
  /** The STORED container, synthesised from the family's one-spelling fields (title text from spec.title...). */
  read(region: GridRegion): VisualContainerFormat;
  /** The family's defaults (preset colours, today's frame look) -- the base resolveVisualContainer spreads. */
  defaults(region: GridRegion): ResolvedVisualContainer;
  capabilities(region: GridRegion): ContainerCapabilities;
  /** Transient: local cache only, no write, no undo, no dirty flag (transient-write pattern). */
  preview?(region: GridRegion, patch: VisualContainerPatch): void;
  /** Restore after a preview (called on commit, cancel, retarget and pane close). */
  endPreview?(): void;
  /**
   * Persist. Its backend recorder JOINS an open undo transaction (commitObjectFormat opens one) and records
   * an ACTUAL undo entry (controls: `set_control_appearance`, never the non-undoable `set_control_property`).
   * Rejects with the backend's sentence on refusal, after restoring. A family whose persist is debounced
   * (charts: `updateChartSpec` -> 300 ms `scheduleSave`) MUST also implement `flush`.
   */
  commit(region: GridRegion, patch: VisualContainerPatch): Promise<void>;
  /**
   * Land any debounced persist the commit scheduled. commitObjectFormat awaits every involved provider's
   * flush INSIDE its transaction, before committing it (the objectGeometry `flushProviders` precedent).
   * Chart: `flushPendingChartSaves()`. Absent = writes are immediate.
   */
  flush?(): Promise<void>;
  /**
   * The WP-D catalog pointer of this field for this object (`CONTAINER_ROOT_POINTER[kind]` +
   * `containerFieldPointer(field)`, or the existing Family row a mapped fact uses), or null = not bindable.
   * Return null for every field `capabilities` hides. Every non-null answer must pass
   * `isBindablePath(kind, path)` (the S6 test `objectFormatBindingPaths.test.ts`).
   */
  bindingPath?(region: GridRegion, field: ContainerFieldId): string | null;
  /**
   * The WP-D binding ref of this object. ASYNC (ruling R5): a control's ref is its `uid`, which only the
   * backend holds. Absent = `bindingRefForRegion(region)` (the family's WP-D registration answers).
   */
  bindingRef?(region: GridRegion): Promise<ObjectBindingRef | null>;
  dataFormats?(region: GridRegion): Promise<DataFormatField[]>;
  setDataFormat?(region: GridRegion, key: string, format: string | null): Promise<void>;
  /** The family's own "Visual" cards (chart element formatting, pivot style gallery, slicer items...). */
  visualCards?(region: GridRegion): readonly FormatCardContribution[];
}

/** One bound field as the pane shows it. */
export interface ObjectFormatBoundField {
  /** The formula as the user edits it (WP-D `displayFormula`: the workbook locale). */
  formula: string;
  /** What the binding resolves to right now ("" while pending). */
  display: string;
  /** A full sentence when the binding cannot produce a value; null otherwise. */
  error: string | null;
}

/** Everything the Format pane reads for one object, synchronously. */
export interface ObjectFormatSnapshot {
  /** The LITERAL container (provider `read`). */
  stored: VisualContainerFormat;
  /** What paints: `region.container` when the family published one, else bound > stored > defaults. */
  resolved: ResolvedVisualContainer;
  capabilities: ContainerCapabilities;
  /** Bound fields: id -> { formula, display, error } from WP-D `getBinding`/`getResolved` (empty without a ref). */
  bound: ReadonlyMap<ContainerFieldId, ObjectFormatBoundField>;
}

/** What a commit did. */
export interface ObjectFormatOutcome {
  /** Changes a provider committed. */
  applied: number;
  /** One sentence per refused change (validation, subscribed page, no provider, the backend's own). */
  refused: string[];
}

// ============================================================================
// Registry
// ============================================================================

const providers = new Map<string, ObjectFormatProvider>();

/** Providers that previewed since the last `endObjectFormatPreview`. */
const previewing = new Set<ObjectFormatProvider>();

/**
 * Register a family's provider for each of its region types. Last
 * registration wins per type; the cleanup removes only what is still this
 * provider's (a stale cleanup cannot remove a newer registration).
 */
export function registerObjectFormatProvider(provider: ObjectFormatProvider): () => void {
  for (const t of provider.types) providers.set(t, provider);
  return () => {
    for (const t of provider.types) {
      if (providers.get(t) === provider) providers.delete(t);
    }
    previewing.delete(provider);
  };
}

/** The provider for `region`'s type, or null. */
export function getObjectFormatProvider(region: GridRegion): ObjectFormatProvider | null {
  return providers.get(region.type) ?? null;
}

/** Whether some provider owns this region type. */
export function hasObjectFormatProvider(type: string): boolean {
  return providers.has(type);
}

/** Test hook: forget every provider and any preview in progress. */
export function resetObjectFormatProviders(): void {
  providers.clear();
  previewing.clear();
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The provider's binding pointer for a field, never throwing (a throw = not bindable). */
function safeBindingPath(p: ObjectFormatProvider, region: GridRegion, field: ContainerFieldId): string | null {
  if (!p.bindingPath) return null;
  try {
    const path = p.bindingPath(region, field);
    return typeof path === "string" && path !== "" ? path : null;
  } catch (err) {
    console.error(`[objectFormat] bindingPath threw for ${region.type} ${field}:`, err);
    return null;
  }
}

// ============================================================================
// Bindings: the resolved container, the re-publish hook, the descriptors
// ============================================================================

/**
 * For a family's region PUBLISHER: the RESOLVED container =
 * `resolveVisualContainer(stored, defaults, bound)`, where `bound` holds every
 * field whose `pathOf(field)` has a resolved WP-D binding on `ref`
 * (`getResolved(ref, path)`), read by WP-D's own paint rule (`paintedValue`,
 * the rule `overlayResolved` applies): a PENDING value is skipped, an ERROR on
 * a non-text slot is skipped, a text slot shows its display. A value that then
 * fails its leaf check (a bound `rgb(1,2,3)` colour) is ignored by
 * `resolveVisualContainer` -- the stored literal shows. Precedence
 * bound > stored > defaults. `ref` null (no WP-D ref yet, or a CONTROL, whose
 * keys Rust already overlays -- ruling R5) = no overlay.
 */
export function resolveContainerForObject(
  ref: ObjectBindingRef | null,
  stored: VisualContainerFormat | undefined,
  defaults: ResolvedVisualContainer,
  pathOf: (field: ContainerFieldId) => string | null,
): ResolvedVisualContainer {
  if (!ref) return resolveVisualContainer(stored, defaults);
  let bound: Map<ContainerFieldId, unknown> | undefined;
  for (const field of VISUAL_CONTAINER_FIELD_IDS) {
    let path: string | null;
    try {
      path = pathOf(field);
    } catch (err) {
      console.error(`[objectFormat] pathOf threw for ${field}:`, err);
      continue;
    }
    if (!path) continue;
    const r = getResolved(ref, path);
    if (!r) continue;
    const value = paintedValue(ref, r);
    if (value === undefined) continue;
    (bound ??= new Map()).set(field, value);
  }
  return resolveVisualContainer(stored, defaults, bound);
}

/**
 * Re-publish hook over WP-D `onBindingsChanged`: calls `resync(changedIds)`
 * when a binding of one of `kind`'s objects changed (`change.objects` filtered
 * by kind, de-duplicated), and `resync("all")` on a `reload` (the binding SET
 * was re-read). The family's resync MUST also drop any cache that baked a
 * container value in (charts: `invalidateChartCache(id)` BEFORE
 * `syncChartRegions`) and must not emit GRID_REFRESH (WP-D's feedback-loop
 * rule). Returns the unsubscribe.
 */
export function onContainerBindingsChanged(
  kind: ObjectBindingKind,
  resync: (ids: readonly string[] | "all") => void,
): () => void {
  return onBindingsChanged((change) => {
    let ids: readonly string[] | "all";
    if (change.reload) {
      ids = "all";
    } else {
      const own = Array.from(new Set(change.objects.filter((o) => o.kind === kind).map((o) => o.id)));
      if (own.length === 0) return;
      ids = own;
    }
    try {
      resync(ids);
    } catch (err) {
      console.error(`[objectFormat] the '${kind}' container resync threw:`, err);
    }
  });
}

const GROUP_LABELS: Readonly<Record<string, string>> = Object.freeze({
  padding: "Padding",
  title: "Title",
  subtitle: "Subtitle",
  divider: "Divider",
  spacing: "Spacing",
  background: "Background",
  border: "Border",
  shadow: "Shadow",
});

const LEAF_LABELS: Readonly<Record<string, string>> = Object.freeze({
  top: "top",
  right: "right",
  bottom: "bottom",
  left: "left",
  show: "on/off",
  text: "text",
  headingLevel: "heading level",
  fontFamily: "font",
  fontSize: "font size",
  bold: "bold",
  italic: "italic",
  underline: "underline",
  color: "color",
  background: "background color",
  align: "alignment",
  wrap: "wrap text",
  style: "line style",
  width: "width",
  ignorePadding: "ignore padding",
  custom: "custom spacing",
  belowTitle: "below title",
  belowSubtitle: "below subtitle",
  belowDivider: "below divider",
  transparency: "transparency",
  radius: "rounded corners",
  offset: "inside/outside",
  position: "position",
  blur: "blur",
  distance: "distance",
});

/**
 * What the Format card vocabulary calls a field ("Title font size",
 * "Background transparency", "Lock aspect"). The Bound Properties view and
 * `list_object_properties` show this label.
 */
export function containerFieldLabel(field: ContainerFieldId): string {
  if (field === "lockAspect") return "Lock aspect";
  const dot = field.indexOf(".");
  const group = field.slice(0, dot);
  const leaf = field.slice(dot + 1);
  return `${GROUP_LABELS[group] ?? group} ${LEAF_LABELS[leaf] ?? leaf}`;
}

/**
 * The WP-D registry descriptors for every bindable container field of a
 * region (label from the Format card vocabulary, group "Format"): exactly the
 * provider's non-null `bindingPath` answers, in field order, one per pointer.
 * A family APPENDS these to the `properties(ref, region)` of the ONE
 * `registerBindableProperties` registration its kind has (WP-D registers
 * chart, control, slicer and timelineSlicer; WP-C registers pivot and
 * floatingRange) -- `appendContainerBindableDescriptors` does that without
 * offering a pointer the family already offers. `getBindableProperties` drops
 * (and logs) any pointer the catalog refuses.
 */
export function containerBindableDescriptors(region: GridRegion): BindablePropertyDescriptor[] {
  const p = providers.get(region.type);
  if (!p) return [];
  const out: BindablePropertyDescriptor[] = [];
  const seen = new Set<string>();
  for (const field of VISUAL_CONTAINER_FIELD_IDS) {
    const pointer = safeBindingPath(p, region, field);
    if (!pointer || seen.has(pointer)) continue;
    seen.add(pointer);
    out.push({ pointer, label: containerFieldLabel(field), group: OBJECT_FORMAT_BINDING_GROUP });
  }
  return out;
}

/**
 * `base` followed by the region's container descriptors whose pointer `base`
 * does not already offer (a chart's title text IS its `/spec/title` Family
 * row, which WP-D's chart registration lists itself). `region` null (a script
 * asked by instance id) = `base` unchanged.
 */
export function appendContainerBindableDescriptors(
  base: readonly BindablePropertyDescriptor[],
  region: GridRegion | null,
): BindablePropertyDescriptor[] {
  const out = [...base];
  if (!region) return out;
  const offered = new Set(base.map((d) => d.pointer));
  for (const d of containerBindableDescriptors(region)) {
    if (offered.has(d.pointer)) continue;
    offered.add(d.pointer);
    out.push(d);
  }
  return out;
}

/** The object's WP-D binding ref: the provider's own answer, else the family's registration. */
export async function objectFormatBindingRef(region: GridRegion): Promise<ObjectBindingRef | null> {
  const p = providers.get(region.type);
  try {
    if (p?.bindingRef) return await p.bindingRef(region);
    return await bindingRefForRegion(region);
  } catch (err) {
    console.warn(`[objectFormat] could not identify the object of region ${region.id}:`, err);
    return null;
  }
}

// ============================================================================
// Read / preview
// ============================================================================

/**
 * Everything the Format pane reads for one object, or null when no provider
 * owns it (or the provider failed). SYNCHRONOUS: a control's binding ref
 * comes from the backend (ruling R5), so the caller passes the `ref` it
 * obtained once through `objectFormatBindingRef`; without one, `bound` is
 * empty and `resolved` carries no binding overlay of its own (the region's
 * published `container` already does).
 */
export function readObjectFormat(region: GridRegion, ref: ObjectBindingRef | null = null): ObjectFormatSnapshot | null {
  const p = providers.get(region.type);
  if (!p) return null;
  try {
    const stored = p.read(region) ?? {};
    const capabilities = p.capabilities(region);
    const pathOf = (field: ContainerFieldId) => safeBindingPath(p, region, field);
    // A family republishes its region from the PREVIEWED state while a preview
    // is up, so its published container then holds the preview. The snapshot
    // is the stored truth a commit compares against: read through the preview,
    // a slider dragged on an untouched field "already showed" the value it was
    // about to commit, the commit wrote nothing and the preview's end put the
    // old value back (found live, object-pane-format J7, 2026-10-16).
    const published = previewing.has(p) ? undefined : (region as ContainerRegion).container;
    const resolved = published ?? resolveContainerForObject(ref, stored, p.defaults(region), pathOf);
    const bound = new Map<ContainerFieldId, ObjectFormatBoundField>();
    if (ref) {
      for (const field of VISUAL_CONTAINER_FIELD_IDS) {
        const path = pathOf(field);
        if (!path) continue;
        const binding = getBinding(ref, path);
        if (!binding) continue;
        const r = getResolved(ref, path) ?? binding.resolved;
        bound.set(field, {
          formula: binding.displayFormula || binding.formula,
          display: r?.display ?? "",
          error: r?.error ?? null,
        });
      }
    }
    return { stored, resolved, capabilities, bound };
  } catch (err) {
    console.error(`[objectFormat] reading the format of ${region.id} failed:`, err);
    return null;
  }
}

/**
 * Show `patch` on the object WITHOUT persisting it (the family's local cache:
 * no write, no undo, no dirty flag), then repaint. An invalid patch, or a
 * family without a preview, shows nothing. Always paired with
 * `endObjectFormatPreview` (commit calls it first).
 */
export function previewObjectFormat(region: GridRegion, patch: VisualContainerPatch): void {
  const p = providers.get(region.type);
  if (!p?.preview) return;
  const invalid = validateVisualContainerPatch(patch);
  if (invalid) {
    console.warn(`[objectFormat] preview ignored: ${invalid}`);
    return;
  }
  try {
    p.preview(region, patch);
    previewing.add(p);
  } catch (err) {
    console.error("[objectFormat] provider preview threw:", err);
  }
  requestOverlayRedraw();
}

/** Restore every family that previewed since the last call, then repaint. */
export function endObjectFormatPreview(): void {
  if (previewing.size === 0) return;
  const list = Array.from(previewing);
  previewing.clear();
  for (const p of list) {
    try {
      p.endPreview?.();
    } catch (err) {
      console.error("[objectFormat] provider endPreview threw:", err);
    }
  }
  requestOverlayRedraw();
}

// ============================================================================
// Commit
// ============================================================================

function hasAnyKey(patch: VisualContainerPatch): boolean {
  return Object.values(patch ?? {}).some((v) => v !== undefined);
}

/** The one toast for a call's refusals. */
function reportRefusals(label: string, refused: readonly string[]): void {
  const what = refused.length === 1 ? "1 object" : `${refused.length} objects`;
  const unique = Array.from(new Set(refused.filter((r) => r.trim() !== "")));
  const because = unique.length > 0 ? ` ${unique.join(" ")}` : "";
  showToast(`${label}: ${what} could not be formatted.${because}`, { type: "error", duration: 8000 });
}

/**
 * Persist `changes`. Every patch is validated (`validateVisualContainerPatch`;
 * an invalid one never reaches a provider) and refused on a SUBSCRIBED page
 * (the active page's surface is not editable: SIZE_POSITION_SUBSCRIBED -- the
 * layout is the publisher's). Lock Objects does NOT refuse a format. Any
 * preview in progress is ended first. Then, inside ONE
 * `runInUndoTransaction(label)` (joined when one is already open): every
 * commit, in order, then an AWAITED `flush()` of every involved provider, and
 * only then does the transaction commit -- one Ctrl+Z labelled `label`.
 * A change with an empty patch is ignored. Refusals are collected into ONE
 * error toast and never reject this call.
 */
export async function commitObjectFormat(
  changes: ReadonlyArray<{ region: GridRegion; patch: VisualContainerPatch }>,
  label: string = OBJECT_FORMAT_UNDO_LABEL,
): Promise<ObjectFormatOutcome> {
  const refused: string[] = [];
  const work: Array<{ provider: ObjectFormatProvider; region: GridRegion; patch: VisualContainerPatch }> = [];
  const surface = getLayoutSurface(getGridStateSnapshot()?.sheetContext.activeSheetIndex ?? 0);
  const subscribed = !!surface && !surface.editable;

  for (const { region, patch } of changes) {
    if (!patch || !hasAnyKey(patch)) continue;
    const provider = providers.get(region.type);
    if (!provider) {
      refused.push(OBJECT_FORMAT_NO_PROVIDER);
      continue;
    }
    const invalid = validateVisualContainerPatch(patch);
    if (invalid) {
      refused.push(invalid);
      continue;
    }
    if (subscribed) {
      refused.push(SIZE_POSITION_SUBSCRIBED);
      continue;
    }
    work.push({ provider, region, patch });
  }

  endObjectFormatPreview();

  let applied = 0;
  if (work.length > 0) {
    let ran = 0;
    try {
      await runInUndoTransaction(label, async () => {
        /** Per provider, how many of ITS changes committed (a failed flush takes them back). */
        const committedBy = new Map<ObjectFormatProvider, number>();
        for (const { provider, region, patch } of work) {
          ran++;
          if (!committedBy.has(provider)) committedBy.set(provider, 0);
          try {
            await provider.commit(region, patch);
            applied++;
            committedBy.set(provider, (committedBy.get(provider) ?? 0) + 1);
          } catch (err) {
            refused.push(describe(err));
            console.error(`[objectFormat] "${label}" refused for ${region.id}:`, err);
          }
        }
        // Land every debounced persist INSIDE the transaction, before it commits.
        for (const [provider, count] of committedBy) {
          if (!provider.flush) continue;
          try {
            await provider.flush();
          } catch (err) {
            const reason = describe(err);
            console.error(`[objectFormat] "${label}" flush failed:`, err);
            applied -= count;
            for (let i = 0; i < count; i++) refused.push(reason);
          }
        }
      });
    } catch (err) {
      // The transaction itself could not be opened or closed. Whatever never
      // ran counts as refused; what ran is on the undo stack either way.
      const reason = describe(err);
      for (let i = ran; i < work.length; i++) refused.push(reason);
      console.error(`[objectFormat] "${label}" transaction failed:`, err);
    }
  }

  if (refused.length > 0) reportRefusals(label, refused);
  if (work.length > 0) requestOverlayRedraw();
  return { applied, refused };
}
