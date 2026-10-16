//! FILENAME: app/extensions/Controls/lib/controlContainer.ts
// PURPOSE: Every floating control's RESOLVED visual container (WP-C
//          D-FORMAT), held synchronously for the region publisher, the
//          renderers' content rect, the zone and the Format pane -- plus the
//          Format pane's PREVIEW of a container patch.
// CONTEXT: A control's container lives in its flat property keys
//          (lib/controlContainerDefaults.ts), and those reach the frontend
//          ONLY through the renderers' async `resolve_control_properties` reads
//          (the shape, button, picture and navigator caches). So each of those
//          reads hands its answer here (`noteControlProperties`), and this
//          module resolves the container -- WITHOUT a binding overlay (ruling
//          R5: Rust already overlaid every bound `/properties/<key>`) -- and
//          asks the floating store to re-publish when it CHANGED, so Core paints
//          the band round exactly the rect the renderer lays out in.
//
//          PREVIEW = the transient-write pattern: the would-be flat writes are
//          laid over the last read in memory only (no write, no undo, no dirty
//          flag), the region re-published, and dropped by `endPreview`. A
//          family-painted fill or outline (a shape, a button) previews through
//          `getControlPaintPreview`, which those two renderers lay over their
//          own cached keys.
//
//          Keyed by control id (`control-<sheet>-<row>-<col>`): a re-anchor
//          migrates the entry, a delete forgets it, File > New / Open and a
//          deactivate drop them all.

import { resolveVisualContainer, type ResolvedVisualContainer, type VisualContainerFormat } from "@api/visualContainer";
import {
  controlContainerDefaults,
  controlContainerKind,
  readControlContainer,
  type ControlContainerKind,
} from "./controlContainerDefaults";

/** What one read of a control says about its container. */
export interface ControlContainerEntry {
  controlType: string;
  kind: ControlContainerKind;
  /** The resolved properties the read returned (flat keys, every value a string). */
  props: Readonly<Record<string, string>>;
  /** The STORED container (the literal, sparse) read from those keys. */
  stored: VisualContainerFormat;
  /** What paints: stored over the kind's defaults. */
  resolved: ResolvedVisualContainer;
}

interface PreviewEntry {
  writes: Readonly<Record<string, string>>;
  resolved: ResolvedVisualContainer;
}

const entries = new Map<string, ControlContainerEntry>();
const previews = new Map<string, PreviewEntry>();
let resync: (() => void) | null = null;

function build(controlType: string, props: Readonly<Record<string, string>>): ControlContainerEntry | null {
  const kind = controlContainerKind(controlType, props.shapeType);
  if (!kind) return null;
  const stored = readControlContainer(kind, props);
  return {
    controlType,
    kind,
    props,
    stored,
    resolved: resolveVisualContainer(stored, controlContainerDefaults(kind)),
  };
}

function signatureOf(c: ResolvedVisualContainer | undefined): string {
  return c === undefined ? "" : JSON.stringify(c);
}

function announce(): void {
  try {
    resync?.();
  } catch (err) {
    console.error("[Controls] Re-publishing the control containers failed:", err);
  }
}

/**
 * Install the re-publish the cache calls when a control's container changed
 * (Controls' activate: the floating store's region sync + a redraw). `null`
 * uninstalls.
 */
export function setControlContainerResync(fn: (() => void) | null): void {
  resync = fn;
}

/**
 * A renderer's properties read landed: resolve the control's container and
 * re-publish the regions when what PAINTS changed. A control kind with no
 * container (a checkbox) keeps none.
 */
export function noteControlProperties(
  controlId: string,
  controlType: string,
  resolvedProps: Readonly<Record<string, string>>,
): void {
  const before = signatureOf(getControlContainer(controlId));
  const entry = build(controlType, { ...resolvedProps });
  if (entry) entries.set(controlId, entry);
  else entries.delete(controlId);
  // A preview laid over the previous read is laid over this one instead.
  const preview = previews.get(controlId);
  if (preview) {
    if (entry) setControlContainerPreview(controlId, preview.writes, false);
    else previews.delete(controlId);
  }
  if (signatureOf(getControlContainer(controlId)) !== before) announce();
}

/** The container a control PAINTS with right now (its preview while one is shown), or undefined (not read yet). */
export function getControlContainer(controlId: string): ResolvedVisualContainer | undefined {
  return previews.get(controlId)?.resolved ?? entries.get(controlId)?.resolved;
}

/** The last read of a control (never the preview), or undefined. */
export function getControlContainerEntry(controlId: string): ControlContainerEntry | undefined {
  return entries.get(controlId);
}

/**
 * Show `writes` (flat key -> value, what a commit would write) on the control
 * WITHOUT persisting them; `null` ends the preview. Re-publishes when the
 * painted container changed (`announceChange` false: the caller re-publishes).
 */
export function setControlContainerPreview(
  controlId: string,
  writes: Readonly<Record<string, string>> | null,
  announceChange = true,
): void {
  const before = signatureOf(getControlContainer(controlId));
  const entry = entries.get(controlId);
  if (writes === null || !entry) {
    previews.delete(controlId);
  } else {
    const previewed = build(entry.controlType, { ...entry.props, ...writes });
    if (previewed) previews.set(controlId, { writes: { ...writes }, resolved: previewed.resolved });
    else previews.delete(controlId);
  }
  if (announceChange && signatureOf(getControlContainer(controlId)) !== before) announce();
}

/**
 * The flat keys a preview lays over a control's own cached keys (a shape's or
 * a button's fill / stroke / strokeWidth / borderColor), or undefined.
 */
export function getControlPaintPreview(controlId: string): Readonly<Record<string, string>> | undefined {
  return previews.get(controlId)?.writes;
}

/** A re-anchor renamed a control: its entry follows it. */
export function migrateControlContainer(oldId: string, newId: string): void {
  if (oldId === newId) return;
  const entry = entries.get(oldId);
  entries.delete(oldId);
  if (entry) entries.set(newId, entry);
  else entries.delete(newId);
  const preview = previews.get(oldId);
  previews.delete(oldId);
  if (preview) previews.set(newId, preview);
  else previews.delete(newId);
}

/** A control is gone: forget its container. */
export function forgetControlContainer(controlId: string): void {
  entries.delete(controlId);
  previews.delete(controlId);
}

/** File > New / Open, deactivate and tests: forget every container and preview. */
export function resetControlContainers(): void {
  entries.clear();
  previews.clear();
}
