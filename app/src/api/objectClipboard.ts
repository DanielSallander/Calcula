//! FILENAME: app/src/api/objectClipboard.ts
// PURPOSE: THE OBJECT CLIPBOARD -- Copy, Paste and Duplicate of floating
//          objects (shapes, buttons, pictures, charts, ...) ACROSS FAMILIES. A
//          paste or duplicate of several objects is ONE undo step; the copies
//          land offset from their originals and become the selection.
// CONTEXT: The copy/duplicate half of open-items 2.af row 1 (V1, W25). On a
//          canvas a multi-selection spans families -- a chart, a second chart
//          the selection set holds, a shape -- and only Controls had a copy at
//          all: its keys refused a selection that held anything else, and the
//          other families' objects could not be copied by any key.
//
//          Feature-neutral, the @api/objectSelection way: each family's
//          PROVIDER snapshots its own objects (`copyObjects`) and re-creates
//          them (`pasteObjects`); this module only holds the snapshots, groups
//          them by family, runs the creations inside one undo transaction
//          (`runInUndoTransaction`, @api/objectGeometry), decides WHERE the
//          copies land (`ObjectPasteTarget.place`: one step further per paste,
//          on the page of a canvas) and selects what was created. The seam
//          never reads a snapshot. A family without the pair (a slicer, a
//          timeline, a floating grid, a pivot box) cannot be copied: its
//          members are left out and named in ONE toast, and the rest is
//          copied -- the rule the canvas-wide Delete follows for a family that
//          cannot delete.
//
//          ONE clipboard for objects. Controls' own copy door (a worksheet
//          selection of shapes) puts its snapshots here too
//          (`putOnObjectClipboard`), so the LAST copy wins wherever it was
//          made: a shape copied on a worksheet after a chart was copied on a
//          canvas is what the next paste creates, on either surface. The cell
//          clipboard is separate (a canvas has no cells to paste).
//
//          Seams point one way: this module imports nothing from extensions.

import { getGridRegions, type GridRegion } from "./gridOverlays";
import { getGridStateSnapshot } from "../core/state/GridContext";
import { coMovedMemberRect, runInUndoTransaction } from "./objectGeometry";
import { getLayoutSurface } from "./layoutSurface";
import { showToast } from "./notifications";
import { canvasObjectRefKey } from "./canvasSheet";
import type { CanvasObjectRef } from "./lib";
import {
  getObjectSelectionProvider,
  getSelectedObjectRegions,
  objectLabelOf,
  objectOwnsKey,
  objectRefOf,
  setObjectSelectionSet,
  type ObjectPasteTarget,
  type ObjectSelectionProvider,
} from "./objectSelection";
import { CommandRegistry, CoreCommands } from "./commands";

/**
 * How far a copy lands from its original, in px, per paste (the cascade: the
 * first paste 20 px away, the second 40, ...) and for a duplicate (20). The
 * step Controls always used.
 */
export const OBJECT_PASTE_STEP = 20;

/** One copied object. */
interface ClipboardEntry {
  /** The region type the object was published under: its family pastes it. */
  type: string;
  /** The family's own snapshot (opaque here). */
  snapshot: unknown;
  /** What the object was called when it was copied (a refusal names it). */
  label: string;
}

/** What the last copy took, in family order (empty = nothing to paste). */
let entries: ClipboardEntry[] = [];
/** Pastes made from the current copy (the cascade). */
let pasteCount = 0;

// ============================================================================
// One action at a time
// ============================================================================

/**
 * Copy, Paste and Duplicate run ONE AT A TIME, in the order they were asked
 * for -- the order a user pressed the keys in.
 *
 * Each of them awaits backend round trips (a family's snapshot read, a
 * `save_chart`, a `set_control_metadata`). Run side by side, a second Ctrl+V
 * pressed (or key-repeated) while the first was still landing JOINED the
 * first's open undo transaction (`runInUndoTransaction` joins one that is
 * open), so one Ctrl+Z took both pastes; and a second Ctrl+D read the
 * selection before the first's copies were selected, so it duplicated the
 * ORIGINALS again and stacked a hidden copy exactly on each visible one (wave
 * C review). Queued, every keypress is its own undo step, and a second Ctrl+D
 * duplicates the first's copies (Excel's cascade: each action reads the
 * selection and the clipboard only when its turn comes).
 */
let actionQueue: Promise<void> = Promise.resolve();
/** Copies queued or running: their snapshots will be on the clipboard. */
let pendingCopies = 0;

/**
 * Run `task` after every Copy / Paste / Duplicate asked for before it has
 * settled (FIFO; a failed task does not stop the next). This module's own
 * Copy / Paste / Duplicate queue themselves; a family's OWN door (Controls'
 * worksheet Ctrl+C / Ctrl+D) wraps its whole act in this -- reading its
 * selection INSIDE the task, when its turn comes -- so it is ordered with the
 * rest. `copies: true` marks a copy: until it settles the clipboard counts as
 * holding something (`hasObjectClipboard`), so a Ctrl+V pressed right behind
 * the first Ctrl+C is not handed to the grid.
 *
 * The task must NOT await this module's Copy / Paste / Duplicate (they queue
 * behind it, and it would wait for itself); it calls the family's own leaf
 * functions instead.
 */
export function runObjectClipboardAction<T>(
  task: () => Promise<T>,
  opts: { copies?: boolean } = {},
): Promise<T> {
  const copies = opts.copies === true;
  if (copies) pendingCopies++;
  const run = actionQueue.then(task);
  const settle = (): void => {
    if (copies) pendingCopies = Math.max(0, pendingCopies - 1);
  };
  actionQueue = run.then(settle, settle);
  return run;
}

/** What a Copy / Paste / Duplicate did. */
export interface ObjectClipboardOutcome {
  /** Objects copied (Copy) or created (Paste, Duplicate). */
  acted: number;
  /** Objects whose family cannot be copied at all (left out, named in the toast). */
  unsupported: number;
  /** Objects whose family tried and refused (named or counted in the toast). */
  failed: number;
}

/**
 * THE rule every family's own Copy / Paste / Duplicate door asks first: is
 * the sheet on screen a CANVAS? There the canvas's door (CanvasSheet
 * lib/canvasClipboard.ts: Ctrl+C / Ctrl+V / Ctrl+D) acts on the WHOLE
 * selection through this clipboard, whatever families it holds -- so a
 * family's own binding stands aside and its command hands over, and the
 * keybinding dispatcher's one winner per key cannot pick a door that knows
 * only its own objects. A worksheet keeps each family's own door. One helper,
 * so the doors cannot disagree about where the line is.
 */
export function canvasOwnsObjectClipboard(): boolean {
  return getGridStateSnapshot()?.surface === "canvas";
}

// ============================================================================
// Which command answers Copy / Paste RIGHT NOW -- ONE rule for every door
// ============================================================================
//
// The Edit menu's Copy / Paste, the Home tab's Copy / Paste buttons and the
// canvas's Ctrl+C / Ctrl+V guards (CanvasSheet lib/canvasClipboard.ts) all ask
// the same question: does the OBJECT clipboard answer the clipboard now, or the
// grid's CELL clipboard? Each door used to spell the answer itself -- three
// copies of one rule, and three spellings of the canvas's command ids (wave E,
// Y11). The keyboard guard adds what only a key press has (the grid focused, no
// DOM text selection to yield to, something to copy); a click door adds that
// the canvas's command must be registered (its extension is on).

/** The canvas's Copy of its selected objects. CanvasSheet registers its
 *  command under this id; a door runs it through `clipboardDoorCommand`. */
export const OBJECT_COPY_COMMAND = "canvasSheet.copySelection";
/** The canvas's Paste of the object clipboard (see OBJECT_COPY_COMMAND). */
export const OBJECT_PASTE_COMMAND = "canvasSheet.pasteObjects";

/**
 * Whether the OBJECT clipboard -- not the cell clipboard -- holds the
 * clipboard keys and doors right now: the sheet on screen is a canvas
 * (`canvasOwnsObjectClipboard`) and no INNER selection claims the clipboard
 * keys (`objectOwnsKey("Clipboard")`: a floating grid with a selected cell
 * keeps Copy / Paste for its cells, and the cell command answers for them).
 */
export function objectClipboardHasClipboardKeys(): boolean {
  return canvasOwnsObjectClipboard() && !objectOwnsKey("Clipboard");
}

/**
 * The command a Copy / Paste DOOR (a menu item, a ribbon button) runs right
 * now: the canvas's object-clipboard command while the object clipboard holds
 * the clipboard keys and that command is registered; the grid's cell clipboard
 * command (CoreCommands.COPY / PASTE) otherwise. The canvas's COMMAND is run,
 * not this module's copy / paste functions, because the command also holds the
 * canvas's own refusal (a paste on a SUBSCRIBED canvas, the publisher's page).
 */
export function clipboardDoorCommand(action: "copy" | "paste"): string {
  const objectCommand = action === "copy" ? OBJECT_COPY_COMMAND : OBJECT_PASTE_COMMAND;
  if (objectClipboardHasClipboardKeys() && CommandRegistry.has(objectCommand)) return objectCommand;
  return action === "copy" ? CoreCommands.COPY : CoreCommands.PASTE;
}

/**
 * Whether the clipboard holds anything to paste -- or will, once a Copy that
 * is queued or running lands (a paste queues behind it and finds it there).
 */
export function hasObjectClipboard(): boolean {
  return entries.length > 0 || pendingCopies > 0;
}

/** How many objects the clipboard holds. */
export function objectClipboardSize(): number {
  return entries.length;
}

/**
 * A family's OWN copy door (Controls' Ctrl+C on a worksheet) puts its
 * snapshots here -- the same snapshots its provider's `copyObjects` makes,
 * pasted back by its `pasteObjects` -- REPLACING what the clipboard held, so
 * the last copy wins whichever door made it. Nothing to put keeps the
 * clipboard as it was.
 */
export function putOnObjectClipboard(
  type: string,
  snapshots: ReadonlyArray<unknown>,
  labels: ReadonlyArray<string> = [],
): void {
  if (snapshots.length === 0) return;
  entries = snapshots.map((snapshot, i) => ({ type, snapshot, label: labels[i] ?? type }));
  pasteCount = 0;
}

// ============================================================================
// Internals
// ============================================================================

function nameOf(region: GridRegion): string {
  return objectLabelOf(region) ?? region.type;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function activeSheetIndex(): number {
  return getGridStateSnapshot()?.sheetContext?.activeSheetIndex ?? 0;
}

function distinctById(regions: readonly GridRegion[]): GridRegion[] {
  const seen = new Set<string>();
  const out: GridRegion[] = [];
  for (const r of regions) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

/** Whether a provider takes part in copy/paste (it needs BOTH halves). */
function canCopy(p: ObjectSelectionProvider | null): p is ObjectSelectionProvider {
  return !!p && typeof p.copyObjects === "function" && typeof p.pasteObjects === "function";
}

interface Snapshots {
  entries: ClipboardEntry[];
  /** Members whose family cannot be copied. */
  unsupported: GridRegion[];
  /** Members whose family could not read them (or threw). */
  failed: GridRegion[];
  /** Why, where a family said. */
  reasons: string[];
}

/** Snapshot `regions` through their families, grouped by family in first-seen order. */
async function snapshotRegions(regions: readonly GridRegion[]): Promise<Snapshots> {
  const groups = new Map<ObjectSelectionProvider, GridRegion[]>();
  const out: Snapshots = { entries: [], unsupported: [], failed: [], reasons: [] };
  for (const r of distinctById(regions)) {
    const p = getObjectSelectionProvider(r.type);
    if (!canCopy(p)) {
      out.unsupported.push(r);
      continue;
    }
    const list = groups.get(p);
    if (list) list.push(r);
    else groups.set(p, [r]);
  }
  for (const [p, list] of groups) {
    let snaps: ReadonlyArray<unknown>;
    try {
      snaps = await p.copyObjects!(list);
    } catch (err) {
      out.failed.push(...list);
      out.reasons.push(describe(err));
      console.error(`[objectClipboard] a family could not copy ${list.length} object(s):`, err);
      continue;
    }
    list.forEach((r, i) => {
      const snapshot = snaps[i];
      if (snapshot === null || snapshot === undefined) out.failed.push(r);
      else out.entries.push({ type: r.type, snapshot, label: nameOf(r) });
    });
  }
  return out;
}

interface Creation {
  /** The created objects' live regions, in creation order. */
  created: GridRegion[];
  /** Copies not created. */
  refused: number;
  /** Why (deduplicated later). */
  reasons: string[];
}

/**
 * Create a copy of every entry on `sheetIndex`, `offset` px from where its
 * snapshot stood, through each entry's family -- ONE undo step labelled
 * `label` when there is more than one (a single creation records its own
 * step). The created objects become the selection.
 */
async function createCopies(
  list: readonly ClipboardEntry[],
  sheetIndex: number,
  offset: number,
  label: string,
): Promise<Creation> {
  const result: Creation = { created: [], refused: 0, reasons: [] };
  if (list.length === 0) return result;

  const target: ObjectPasteTarget = {
    sheetIndex,
    // The co-move rule (@api/objectGeometry): start + delta, kept on a
    // canvas's page, at 0 on a worksheet. No lock check: a copy is new.
    place: (rect) => {
      const at = coMovedMemberRect(sheetIndex, rect, { dx: offset, dy: offset });
      return { x: at.x, y: at.y };
    },
  };

  const groups = new Map<ObjectSelectionProvider, ClipboardEntry[]>();
  for (const e of list) {
    const p = getObjectSelectionProvider(e.type);
    if (!canCopy(p)) {
      // The family that copied it is gone (its extension was deactivated).
      result.refused++;
      result.reasons.push(`${e.label} cannot be pasted: its kind of object is not available.`);
      continue;
    }
    const group = groups.get(p);
    if (group) group.push(e);
    else groups.set(p, [e]);
  }

  const refs: CanvasObjectRef[] = [];
  const run = async (): Promise<void> => {
    for (const [p, group] of groups) {
      try {
        const made = await p.pasteObjects!(
          group.map((e) => e.snapshot),
          target,
        );
        refs.push(...made.created);
        const refused = made.refused ?? [];
        result.refused += refused.length;
        result.reasons.push(...refused);
      } catch (err) {
        result.refused += group.length;
        result.reasons.push(describe(err));
        console.error(`[objectClipboard] "${label}" refused for ${group.length} object(s):`, err);
      }
    }
  };
  const creations = Array.from(groups.values()).reduce((n, g) => n + g.length, 0);
  try {
    if (creations > 1) await runInUndoTransaction(label, run);
    else await run();
  } catch (err) {
    // The transaction itself could not be opened or closed; what ran is on
    // the undo stack either way.
    console.error(`[objectClipboard] "${label}" transaction failed:`, err);
  }

  // The copies, by identity, among the regions now published.
  const wanted = refs.map(canvasObjectRefKey);
  const byKey = new Map<string, GridRegion>();
  for (const r of getGridRegions()) {
    const ref = objectRefOf(r);
    if (ref) byKey.set(canvasObjectRefKey(ref), r);
  }
  for (const key of wanted) {
    const r = byKey.get(key);
    if (r && !result.created.some((c) => c.id === r.id)) result.created.push(r);
  }
  if (result.created.length > 0) {
    setObjectSelectionSet(result.created, result.created[result.created.length - 1]);
  }
  return result;
}

/**
 * A page whose objects are not the user's to change (a canvas SUBSCRIBED from
 * an application -- the layout surface says so, @api/layoutSurface) takes no
 * pasted or duplicated objects: refused up front with one toast, nothing sent.
 * Every door gets this, not only the canvas's own keys.
 */
function refusedOnReadOnlySheet(verb: string, sheetIndex: number): boolean {
  if (getLayoutSurface(sheetIndex)?.editable !== false) return false;
  showToast(`${verb}: objects cannot be added to this page -- it is read-only. Nothing was changed.`, {
    type: "info",
  });
  return true;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function uniqueReasons(reasons: readonly string[]): string {
  return Array.from(new Set(reasons.map((r) => r.trim()).filter((r) => r !== ""))).join(" ");
}

/** A toast's text and weight (built first, shown ONCE per action). */
interface Report {
  text: string;
  error: boolean;
}

/** Show `reports` as ONE toast (nothing when there are none). */
function showOnce(reports: ReadonlyArray<Report | null>): void {
  const live = reports.filter((r): r is Report => r !== null);
  if (live.length === 0) return;
  const error = live.some((r) => r.error);
  showToast(live.map((r) => r.text).join(" "), { type: error ? "error" : "warning", duration: error ? 9000 : 8000 });
}

/** What to say about objects a Copy or Duplicate left out, or null. */
function leftOutReport(verb: string, snaps: Snapshots, nothingActed: boolean): Report | null {
  const left = [...snaps.unsupported, ...snaps.failed];
  if (left.length === 0) return null;
  const names = left.map(nameOf).join(", ");
  const what =
    left.length === 1 ? "1 selected object was not" : `${left.length} selected objects were not`;
  const past = verb === "Copy" ? "copied" : "duplicated";
  const why = uniqueReasons(snaps.reasons);
  const advice =
    snaps.failed.length > 0 && why !== ""
      ? why
      : snaps.unsupported.length === left.length
        ? `${plural(left.length, "It", "They")} cannot be ${past}.`
        : `Some cannot be ${past}.`;
  const tail =
    verb === "Copy" && nothingActed ? " Nothing was copied; the clipboard still holds what it held." : "";
  return { text: `${verb}: ${what} ${past} (${names}). ${advice}${tail}`, error: snaps.failed.length > 0 };
}

/** What to say about copies a Paste or Duplicate could not create, or null. */
function refusedReport(verb: string, made: Creation, total: number): Report | null {
  if (made.refused === 0) return null;
  const what =
    total === 1
      ? "The object could not be"
      : `${made.refused} of ${total} objects could not be`;
  const past = verb === "Paste" ? "pasted" : "duplicated";
  const why = uniqueReasons(made.reasons);
  return { text: `${verb}: ${what} ${past}.${why !== "" ? ` ${why}` : ""}`, error: true };
}

// ============================================================================
// Copy
// ============================================================================

async function copyNow(regions: readonly GridRegion[]): Promise<ObjectClipboardOutcome> {
  const snaps = await snapshotRegions(regions);
  if (snaps.entries.length > 0) {
    entries = snaps.entries;
    pasteCount = 0;
  }
  showOnce([leftOutReport("Copy", snaps, snaps.entries.length === 0)]);
  return { acted: snaps.entries.length, unsupported: snaps.unsupported.length, failed: snaps.failed.length };
}

/**
 * COPY the objects behind `regions` -- across families -- to the clipboard,
 * replacing what it held. A family that cannot be copied is left out and
 * named in ONE toast; when NOTHING could be copied, the clipboard keeps what
 * it had (a refused copy never empties it). Queued behind any Copy / Paste /
 * Duplicate still running.
 */
export function copyObjectsToClipboard(regions: readonly GridRegion[]): Promise<ObjectClipboardOutcome> {
  const list = regions.slice();
  return runObjectClipboardAction(() => copyNow(list), { copies: true });
}

/**
 * COPY every selected object (the canvas multi-selection, across families) --
 * the selection as it stands when this copy's turn comes (after a Duplicate
 * pressed before it has selected its copies).
 */
export function copySelectedObjects(): Promise<ObjectClipboardOutcome> {
  return runObjectClipboardAction(() => copyNow(getSelectedObjectRegions()), { copies: true });
}

// ============================================================================
// Paste
// ============================================================================

/**
 * PASTE the clipboard: a new copy of every object on it, on `sheetIndex` (the
 * sheet active when the paste was ASKED for, by default), each paste one step
 * further from the originals (20, 40, 60 px), as ONE undo step (`label`,
 * "Paste Objects") when it creates more than one. The copies become the
 * selection; a copy a family refused is counted in one toast. Queued behind
 * any Copy / Paste / Duplicate still running, so each paste is its own step
 * and pastes what the copies before it put on the clipboard.
 */
export function pasteObjectClipboard(
  opts: { sheetIndex?: number; label?: string } = {},
): Promise<ObjectClipboardOutcome> {
  const sheetIndex = opts.sheetIndex ?? activeSheetIndex();
  return runObjectClipboardAction(() => pasteNow(sheetIndex, opts.label));
}

async function pasteNow(sheetIndex: number, label: string | undefined): Promise<ObjectClipboardOutcome> {
  if (entries.length === 0) return { acted: 0, unsupported: 0, failed: 0 };
  if (refusedOnReadOnlySheet("Paste", sheetIndex)) return { acted: 0, unsupported: 0, failed: entries.length };
  pasteCount++;
  const list = entries.slice();
  const made = await createCopies(
    list,
    sheetIndex,
    OBJECT_PASTE_STEP * pasteCount,
    label ?? "Paste Objects",
  );
  showOnce([refusedReport("Paste", made, list.length)]);
  return { acted: list.length - made.refused, unsupported: 0, failed: made.refused };
}

// ============================================================================
// Duplicate
// ============================================================================

/**
 * DUPLICATE the objects behind `regions` -- across families -- one step
 * (20 px) from each original on the active sheet, as ONE undo step (`label`,
 * "Duplicate Objects") when it creates more than one; the clipboard is left
 * alone. The copies become the selection. A family that cannot be copied is
 * left out and named in one toast (with any copy a family refused). Queued
 * behind any Copy / Paste / Duplicate still running.
 */
export function duplicateObjects(
  regions: readonly GridRegion[],
  opts: { label?: string } = {},
): Promise<ObjectClipboardOutcome> {
  const list = regions.slice();
  const sheetIndex = activeSheetIndex();
  return runObjectClipboardAction(() => duplicateNow(list, sheetIndex, opts.label));
}

/**
 * DUPLICATE every selected object (the canvas multi-selection, across
 * families) -- the selection as it stands when this duplicate's turn comes,
 * so a second Ctrl+D pressed while the first is still landing duplicates the
 * first's COPIES (20 px further), never the originals a second time.
 */
export function duplicateSelectedObjects(): Promise<ObjectClipboardOutcome> {
  return runObjectClipboardAction(() => duplicateNow(getSelectedObjectRegions(), activeSheetIndex(), undefined));
}

async function duplicateNow(
  regions: readonly GridRegion[],
  sheetIndex: number,
  label: string | undefined,
): Promise<ObjectClipboardOutcome> {
  if (refusedOnReadOnlySheet("Duplicate", sheetIndex)) {
    return { acted: 0, unsupported: 0, failed: distinctById(regions).length };
  }
  const snaps = await snapshotRegions(regions);
  const made = await createCopies(
    snaps.entries,
    sheetIndex,
    OBJECT_PASTE_STEP,
    label ?? "Duplicate Objects",
  );
  // ONE toast for the whole Duplicate: what was left out AND what was refused.
  showOnce([
    leftOutReport("Duplicate", snaps, snaps.entries.length === 0),
    refusedReport("Duplicate", made, snaps.entries.length),
  ]);
  return {
    acted: snaps.entries.length - made.refused,
    unsupported: snaps.unsupported.length,
    failed: snaps.failed.length + made.refused,
  };
}

/** Test hook: empty the clipboard and restart the cascade. */
export function resetObjectClipboard(): void {
  entries = [];
  pasteCount = 0;
  actionQueue = Promise.resolve();
  pendingCopies = 0;
}
