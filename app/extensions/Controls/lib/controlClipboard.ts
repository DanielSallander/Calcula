//! FILENAME: app/extensions/Controls/lib/controlClipboard.ts
// PURPOSE: Clipboard (copy/paste) and duplicate operations for floating controls.
// CONTEXT: Works with the floating store and backend control metadata.
//
//          SEVERAL AT ONCE. Ctrl+C / Ctrl+D act on EVERY selected control
//          (lib/controlKeys.ts): the clipboard holds a list, a paste creates
//          every entry, and a paste or duplicate of more than one is ONE undo
//          step (each creation records "Add control" on the backend; the
//          frontend transaction of @api/objectGeometry groups them). Before,
//          the keys handed over the FIRST selected control only, and the other
//          selected controls were silently left out (wave A review).
//
//          ONE CLIPBOARD FOR OBJECTS (W25). The copied controls live on the
//          feature-neutral OBJECT clipboard (@api/objectClipboard), not in a
//          list of this module's own: a canvas multi-selection copies charts
//          and controls together through that clipboard (each family's
//          provider snapshots and re-creates its own objects -- this module is
//          Controls' half: `snapshotControls` / `pasteControlSnapshots`), and
//          with two clipboards the LAST copy would not win -- a chart copied
//          on a canvas after a shape was copied here would lose to the shape
//          at the next Ctrl+V, or the other way round. So a copy here puts
//          Controls' snapshots on the object clipboard, and a paste here
//          pastes the object clipboard (whatever was copied last, a chart
//          included) through each family's own paste.

import { AppEvents } from "@api";
import { emitAppEvent } from "@api/events";
import { canvasObjectRef } from "@api/canvasSheet";
import type { CanvasObjectRef } from "@api";
import type { ObjectPasteResult, ObjectPasteTarget } from "@api/objectSelection";
import { hasObjectClipboard, pasteObjectClipboard, putOnObjectClipboard } from "@api/objectClipboard";
import {
  getFloatingControl,
  addFloatingControl,
  syncFloatingControlRegions,
  makeFloatingControlId,
} from "./floatingStore";
import {
  getControlMetadata,
  setControlMetadata,
} from "./controlApi";
import { findFreeAnchorCell, runControlCreation } from "./controlAnchors";
import {
  selectFloatingControl,
} from "../Button/floatingSelection";
import {
  invalidateFloatingButtonCache,
} from "../Button/floatingRenderer";
import {
  invalidateShapeCache,
} from "../Shape/shapeRenderer";
import {
  invalidateImageCache,
} from "../Image/imageRenderer";
import type { ControlMetadata } from "./types";
import { runInUndoTransaction } from "@api/objectGeometry";
import { FLOATING_CONTROL_REGION_TYPE } from "./controlHitTest";

// ============================================================================
// Snapshots
// ============================================================================

/**
 * What a copied control is: its metadata (a deep copy) and its size -- enough
 * to create an identical new control later, after the original moved, changed
 * or was deleted. Tagged, so a paste never mistakes another family's snapshot
 * for a control's.
 */
export interface ControlSnapshot {
  kind: "control";
  /** The control metadata (deep copy); its x / y properties are where it stood. */
  metadata: ControlMetadata;
  /** Original width */
  width: number;
  /** Original height */
  height: number;
}

/** Whether `value` is a snapshot `snapshotControls` made. */
export function isControlSnapshot(value: unknown): value is ControlSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const md = v.metadata as Record<string, unknown> | undefined;
  return (
    v.kind === "control" &&
    typeof v.width === "number" &&
    typeof v.height === "number" &&
    typeof md === "object" &&
    md !== null &&
    typeof md.controlType === "string" &&
    typeof md.properties === "object" &&
    md.properties !== null
  );
}

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The generic word for a control of `controlType` (a paste refusal names it). */
function controlKindLabel(controlType: string): string {
  if (controlType === "image") return "Picture";
  if (controlType === "") return "Control";
  return controlType.charAt(0).toUpperCase() + controlType.slice(1);
}

/**
 * Snapshot each of these controls (reading its backend metadata), in order;
 * null for a control that no longer exists or has no metadata.
 */
export async function snapshotControls(controlIds: readonly string[]): Promise<Array<ControlSnapshot | null>> {
  const out: Array<ControlSnapshot | null> = [];
  for (const controlId of controlIds) {
    const ctrl = getFloatingControl(controlId);
    if (!ctrl) {
      out.push(null);
      continue;
    }
    const metadata = await getControlMetadata(ctrl.sheetIndex, ctrl.row, ctrl.col);
    if (!metadata) {
      out.push(null);
      continue;
    }
    out.push({ kind: "control", metadata: deepCopy(metadata), width: ctrl.width, height: ctrl.height });
  }
  return out;
}

// ============================================================================
// Copy
// ============================================================================

/**
 * Copy a floating control's properties to the object clipboard.
 */
export async function copyControl(controlId: string): Promise<void> {
  await copyControls([controlId]);
}

/**
 * Copy EVERY one of these controls to the object clipboard (replacing what it
 * held). Controls that no longer exist are skipped; when none of them does,
 * the clipboard keeps what it had.
 */
export async function copyControls(controlIds: readonly string[]): Promise<void> {
  const snaps = (await snapshotControls(controlIds)).filter((s): s is ControlSnapshot => s !== null);
  if (snaps.length === 0) return;
  putOnObjectClipboard(
    FLOATING_CONTROL_REGION_TYPE,
    snaps,
    snaps.map((s) => controlKindLabel(s.metadata.controlType)),
  );
}

// ============================================================================
// Paste
// ============================================================================

/**
 * Paste the object clipboard on `sheetIndex`, one step (20 px) further from
 * the originals with each paste (@api/objectClipboard). Every entry is created
 * by its own family -- Controls' through `pasteControlSnapshots` -- as ONE
 * undo step when there are several, and the copies become the selection. A
 * refusal is named in one toast; this never rejects (both callers run it
 * unawaited).
 */
export async function pasteControl(sheetIndex: number): Promise<void> {
  try {
    await pasteObjectClipboard({ sheetIndex });
  } catch (err) {
    console.error("[Controls] Paste failed:", err);
  }
}

/**
 * Check whether there is something on the object clipboard to paste.
 */
export function hasClipboardControl(): boolean {
  return hasObjectClipboard();
}

/**
 * Controls' half of a paste or duplicate through the object clipboard (the
 * provider's `pasteObjects`, lib/controlObjectSelection.ts): create a copy of
 * each snapshot on `target.sheetIndex` at `target.place(its rect)`. Resolves
 * to the new controls' identities and the refusals' reasons (the seam names
 * them in one toast -- no toast here); never rejects. Selecting the copies is
 * the seam's.
 */
export async function pasteControlSnapshots(
  snapshots: ReadonlyArray<unknown>,
  target: ObjectPasteTarget,
): Promise<ObjectPasteResult> {
  const created: CanvasObjectRef[] = [];
  const refused: string[] = [];
  for (const snapshot of snapshots) {
    if (!isControlSnapshot(snapshot)) {
      refused.push("A copied control could not be read back.");
      continue;
    }
    // Each paste gets its OWN copy of the metadata: the copy is repositioned
    // in place, and the clipboard's snapshot must survive for the next paste.
    const metadata = deepCopy(snapshot.metadata);
    const at = target.place({
      x: parseFloat(metadata.properties.x?.value ?? "0") || 0,
      y: parseFloat(metadata.properties.y?.value ?? "0") || 0,
      width: snapshot.width,
      height: snapshot.height,
    });
    const made = await createControlCopy(metadata, snapshot.width, snapshot.height, target.sheetIndex, at, {
      select: "none",
      reportRefusal: false,
    });
    if ("refusal" in made) {
      refused.push(made.refusal);
      continue;
    }
    created.push(canvasObjectRef("control", `${made.row}:${made.col}`));
  }
  return { created, refused };
}

// ============================================================================
// Duplicate
// ============================================================================

/** Pixel offset of a duplicate from its original (the object clipboard's step). */
const DUPLICATE_OFFSET = 20;

/**
 * Duplicate EVERY one of these controls, each copy offset by 20px, as ONE
 * undo step when there is more than one; the copies become the selection.
 */
export async function duplicateControls(controlIds: readonly string[]): Promise<void> {
  const sources: ControlCopySource[] = [];
  const snaps = await snapshotControls(controlIds);
  controlIds.forEach((controlId, i) => {
    const snap = snaps[i];
    const ctrl = getFloatingControl(controlId);
    if (!snap || !ctrl) return;
    sources.push({ metadata: snap.metadata, width: snap.width, height: snap.height, sheetIndex: ctrl.sheetIndex });
  });
  if (sources.length === 0) return;
  await createControlCopies(sources.length > 1 ? "Duplicate Controls" : null, sources, DUPLICATE_OFFSET);
}

/** One control to create a copy of. */
interface ControlCopySource {
  metadata: ControlMetadata;
  width: number;
  height: number;
  sheetIndex: number;
}

/**
 * Create a copy of each source, offset by `offset`; the copies replace the
 * selection. `undoLabel` non-null: all of them are ONE undo step.
 */
async function createControlCopies(
  undoLabel: string | null,
  sources: readonly ControlCopySource[],
  offset: number,
): Promise<void> {
  const run = async (): Promise<void> => {
    let first = true;
    for (const src of sources) {
      const at = {
        x: (parseFloat(src.metadata.properties.x?.value ?? "0") || 0) + offset,
        y: (parseFloat(src.metadata.properties.y?.value ?? "0") || 0) + offset,
      };
      const made = await createControlCopy(src.metadata, src.width, src.height, src.sheetIndex, at, {
        select: first ? "replace" : "add",
        reportRefusal: true,
      });
      if (!("refusal" in made)) first = false;
    }
  };
  if (undoLabel === null) await run();
  else await runInUndoTransaction(undoLabel, run);
}

// ============================================================================
// Internal: Create a control copy
// ============================================================================

// The free-anchor allocator that used to live here moved to ./controlAnchors,
// which the create seams share: a canvas insert at a pixel position needs an
// anchor for exactly the reason a pasted copy does, and two private copies of
// "which cell is free" would disagree the first time one of them changed.

/** What `createControlCopy` did. */
type ControlCopyOutcome = { controlId: string; row: number; col: number } | { refusal: string };

/** Top-left pixel of a cell (sheet coordinates), as Controls' index.ts walks it. */
type CellOrigin = (row: number, col: number) => { x: number; y: number };

let copyCellOrigin: CellOrigin | null = null;

/**
 * Install the cell-origin walk a PINNED copy measures its offsets with --
 * `cellOriginPixels` (index.ts), the one the pin reposition pass replays, so
 * the two can never disagree. Null uninstalls (deactivate, tests).
 */
export function setControlCopyCellOrigin(resolver: CellOrigin | null): void {
  copyCellOrigin = resolver;
}

/**
 * A PINNED control's copy keeps its pin -- measured against the copy's OWN
 * anchor. `metadata` is the copy's (mutated in place); returns the offsets the
 * store needs, or null for an unpinned control.
 *
 * A pinned control paints at anchorOrigin + (offsetX, offsetY) whenever the
 * grid's geometry changes, and a copy gets a NEW anchor. Copying the
 * original's offsets verbatim (measured from the ORIGINAL's anchor) made the
 * copy jump by the distance between the two anchors at the first row or
 * column resize after a reload -- and in session the store did not even know
 * the copy was pinned, while its Properties said it was (wave C review).
 *
 * With no cell-origin walk installed there is nothing to measure against, so
 * the copy is written UNPINNED (it keeps the pixels it was pasted at) rather
 * than pinned with offsets from another cell.
 */
function pinCopyToAnchor(
  metadata: ControlMetadata,
  anchor: { row: number; col: number },
  at: { x: number; y: number },
): { offsetX: number; offsetY: number } | null {
  if (metadata.properties.pinToGrid?.value !== "true") return null;
  if (!copyCellOrigin) {
    metadata.properties.pinToGrid = { valueType: "static", value: "false" };
    delete metadata.properties.offsetX;
    delete metadata.properties.offsetY;
    return null;
  }
  const origin = copyCellOrigin(anchor.row, anchor.col);
  const offsetX = at.x - origin.x;
  const offsetY = at.y - origin.y;
  metadata.properties.offsetX = { valueType: "static", value: String(offsetX) };
  metadata.properties.offsetY = { valueType: "static", value: String(offsetY) };
  return { offsetX, offsetY };
}

/**
 * Create a copy of a control with the given metadata and dimensions at `at`
 * (its new x / y) and, per `opts.select`, make it the selection ("replace"),
 * add it to the selection ("add", the 2nd..nth copy of a multi-duplicate) or
 * leave the selection to the caller ("none", the object clipboard selects
 * every family's copies itself). A refusal is shown as a toast unless
 * `opts.reportRefusal` is false (the caller names it); either way it is
 * returned, and nothing is left behind.
 */
async function createControlCopy(
  metadata: ControlMetadata,
  width: number,
  height: number,
  sheetIndex: number,
  at: { x: number; y: number },
  opts: { select: "replace" | "add" | "none"; reportRefusal: boolean },
): Promise<ControlCopyOutcome> {
  const newX = at.x;
  const newY = at.y;

  // Update position in the metadata copy
  metadata.properties.x = { valueType: "static", value: String(newX) };
  metadata.properties.y = { valueType: "static", value: String(newY) };

  // Find a free anchor cell AND claim it, as one step on the shared creation
  // queue. Allocating is a read and claiming is a later write; two creates in
  // flight (a double Ctrl+V, a paste racing a canvas insert) would otherwise
  // both be handed the same cell and the second write would silently REPLACE
  // the first control.
  //
  // Save metadata to backend.
  //
  // A refusal has to be SHOWN. The callers (the Ctrl+V/Ctrl+D key commands
  // and the context menu) invoke this from an async handler whose promise
  // nobody awaits, so a rejection here would be an unhandled rejection and the
  // user would press Ctrl+V and see nothing happen, with no reason given. The
  // object clipboard's paste shows it in its own one toast instead.
  //
  // It is reachable: `set_control_metadata` bounds every property at
  // MAX_CONTROL_PROPERTY_CHARS (64 KiB), and a control from the LEGACY corpus
  // that this build could not migrate — an SVG the old picker accepted — still
  // holds its whole image inline in `src`. It renders, so copying it is a
  // reasonable thing for a user to try; it just cannot be written back.
  //
  // Returning here (rather than after `addFloatingControl`) is the point: a
  // floating control with no backend metadata is an orphan that paints until
  // the next reload and then vanishes.
  let refusal: string | null = null;
  let pin: { offsetX: number; offsetY: number } | null = null;
  const anchor = await runControlCreation(async () => {
    const cell = await findFreeAnchorCell(sheetIndex);
    // A pinned copy's offsets are measured from ITS anchor, known only now.
    pin = pinCopyToAnchor(metadata, cell, { x: newX, y: newY });
    try {
      await setControlMetadata(sheetIndex, cell.row, cell.col, metadata);
    } catch (err) {
      refusal = err instanceof Error ? err.message : String(err);
      return null;
    }
    return cell;
  });
  if (!anchor) {
    const reason: string = refusal ?? "The control could not be created.";
    if (opts.reportRefusal) {
      const { showToast } = await import("@api/notifications");
      showToast(`The control could not be copied: ${reason}`, { type: "error", duration: 9000 });
    }
    return { refusal: reason };
  }

  // Add to floating store -- pinned (with the offsets just written) when the
  // original was, so the copy follows its anchor in THIS session too.
  const controlId = makeFloatingControlId(sheetIndex, anchor.row, anchor.col);
  const pinned = pin as { offsetX: number; offsetY: number } | null;
  addFloatingControl({
    id: controlId,
    sheetIndex,
    row: anchor.row,
    col: anchor.col,
    ...(pinned ? { pinToGrid: true, offsetX: pinned.offsetX, offsetY: pinned.offsetY } : {}),
    x: newX,
    y: newY,
    width,
    height,
    controlType: metadata.controlType,
  });

  // Select the new control
  if (opts.select !== "none") selectFloatingControl(controlId, opts.select === "add");

  // Invalidate caches and refresh
  invalidateFloatingButtonCache(controlId);
  invalidateShapeCache(controlId);
  invalidateImageCache(controlId);
  syncFloatingControlRegions();
  emitAppEvent(AppEvents.GRID_REFRESH);
  return { controlId, row: anchor.row, col: anchor.col };
}
