//! FILENAME: app/src/api/objectSelection.ts
// PURPOSE: The OBJECT SELECTION seam: select, deselect and ask about floating
//          objects (charts, slicers, timelines, controls, floating ranges,
//          canvas pivot boxes) without going through a mouse press -- and, on a
//          canvas, the ONE selection SET that spans every family.
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
//
// THE SELECTION SET (M8). A canvas selects SEVERAL objects across families
//          (Ctrl/Shift+click, the marquee), and arrange commands act on all of
//          them. The set is the union of two things:
//            - what each FAMILY holds in its own selection (the provider's
//              `isSelected`) -- the family paints its own chrome, shows its
//              contextual tab and co-moves its own members;
//            - what the SET holds because the family cannot: Chart, Floating
//              Range and the pivot box are single-select, so a second chart in
//              the set is "set-held" (`getSetHeldObjectRegions`), and its
//              chrome is painted by the canvas, not by Charts.
//          Every family that has members holds at least one of them itself
//          (the set routes the rest through `addToSelection` where the family
//          has it, and holds them otherwise). The set is read in PAINT order.
//
//          Families announce every change of their own selection through
//          `notifyObjectSelectionChanged()` at their selection chokepoints, so
//          the set reflects a selection made by a mouse press inside a family.
//
//          DELETE acts on the WHOLE set (`deleteSelectedObjects`): each
//          family's share -- set-held members included -- goes to its
//          provider's `deleteObjects`, inside ONE undo transaction. A family's
//          own Delete door hands over a selection for which
//          `shouldActOnWholeObjectSelection` answers yes (a selection that
//          spans families, on a canvas or a worksheet), because the keybinding
//          dispatcher runs one winner per key and a family's door only knows
//          its own objects. One family's objects stay with its own door.
//
//          COPY / PASTE / DUPLICATE act on the whole set as well, through the
//          feature-neutral OBJECT CLIPBOARD (@api/objectClipboard): each
//          family's share is snapshotted by its provider's `copyObjects` and
//          re-created by its `pasteObjects`; a paste or duplicate of several is
//          ONE undo step, and the copies become the selection.
//
// PRESS PARITY. On a canvas, Core calls `noteObjectPress` BEFORE it dispatches
//          `floatingObject:selected`: a plain press on an object that is not in
//          a multi-selection deselects every OTHER family (today only the pivot
//          box did that, so a chart and a slicer could both be "selected"); a
//          Ctrl/Shift press keeps the rest of the set; a plain press on a member
//          of a multi-selection keeps the set until mouseup (the user may be
//          starting a group drag) and narrows to that object only if nothing
//          moved -- the rule Slicer already follows for its own multi-select.
//
//          ON A WORKSHEET (BUG-0270 review) Core calls
//          `noteWorksheetObjectPress` instead: the plain rule only -- a plain
//          press deselects every OTHER family, a Ctrl/Shift press keeps them.
//          A worksheet has no cross-family group drag (CanvasSheet
//          lib/groupDrag.ts is canvas-only) and no set built by presses, so
//          nothing is armed. Without it a chart clicked before a slicer stayed
//          selected beside it, Charts' own door owned Delete, and Delete
//          removed the chart clicked EARLIER and left the slicer just clicked.

import { getGridRegions, stackedFloatingRegions, type GridRegion } from "./gridOverlays";
import { getGridStateSnapshot } from "../core/state/GridContext";
import { runInUndoTransaction } from "./objectGeometry";
import { getLayoutSurface } from "./layoutSurface";
import { SIZE_POSITION_SUBSCRIBED } from "./objectPosition";
import { showToast } from "./notifications";
import type { CanvasObjectRef } from "./lib";
import type { CanvasObjectKind } from "./canvasSheet";

/**
 * Keys an INNER selection can claim (a chart's series, a floating range's
 * cell). "Arrow" stands for all four arrow keys, with or without Shift -- the
 * canvas nudge asks it before moving the selected objects. "Clipboard" stands
 * for Copy, Paste and Duplicate (Ctrl+C / Ctrl+V / Ctrl+D) -- the canvas's
 * object clipboard (@api/objectClipboard) asks it before copying OBJECTS, so
 * a floating range with a selected cell keeps those keys for its cells.
 * "Delete" stands for bare Delete and Backspace: a family whose OWN door, or
 * an inner keyboard, takes them right now (a chart -- its door deletes the
 * smallest thing selected, the title before the chart; a floating grid,
 * whose door clears a selected cell; the keyboard inside a slicer, where the
 * key is refused) owns them, and the generic Delete of a selected object
 * (BUG-0270) stands down.
 */
export type ObjectSelectionKey = "Tab" | "Escape" | "Arrow" | "Clipboard" | "Delete";

/**
 * Where a family creates the copies a paste or a duplicate makes
 * (`ObjectSelectionProvider.pasteObjects`, @api/objectClipboard).
 */
export interface ObjectPasteTarget {
  /** The sheet the copies are created on. */
  sheetIndex: number;
  /**
   * Where the copy of an object whose snapshot stood at `rect` lands: offset
   * from it (the paste cascade, or a duplicate's one step) and, on a canvas,
   * kept on the page. The family says where its object was; the seam decides
   * where the copy goes, so every family's copies land alike.
   */
  place(rect: { x: number; y: number; width: number; height: number }): { x: number; y: number };
}

/** What a family's `pasteObjects` made. */
export interface ObjectPasteResult {
  /** The IDENTITY (see `refOf`) of every object created, in snapshot order. */
  created: readonly CanvasObjectRef[];
  /**
   * Why snapshots could NOT be created -- one entry per refused copy, in the
   * words the user should read (the backend's refusal). Empty or absent when
   * every one was.
   */
  refused?: readonly string[];
}

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
  /**
   * The object's stable IDENTITY -- `{ kind, id }` in the convention of
   * `CANVAS_OBJECT_KINDS` (@api/canvasSheet) -- or null when the region does
   * not name one of this family's objects. This is how a canvas's layout
   * (zOrder, locked) refers to the object across reloads; a region id is a
   * paint handle, not an identity.
   */
  refOf?(region: GridRegion): CanvasObjectRef | null;
  /**
   * ADD the object behind `region` to this family's own selection, keeping
   * what it already holds -- present only on families that can hold several
   * (Controls, Slicer, Timeline). Same no-click contract as `select`. A family
   * without it holds one object; the selection set holds its other members.
   */
  addToSelection?(region: GridRegion): void;
  /**
   * Remove the object behind `region` from this family's own selection,
   * keeping the rest. Present only alongside `addToSelection`.
   */
  removeFromSelection?(region: GridRegion): void;
  /**
   * What the Name Box calls this object ("Sales by Region", "Slicer_Region",
   * "Button"), or null when it has no name to show.
   */
  labelOf?(region: GridRegion): string | null;
  /**
   * DELETE the objects behind `regions` -- all of them this family's, all of
   * them selected -- the way the family's own Delete does (its cleanup, its
   * undo record, its refusal message). The canvas-wide Delete
   * ({@link deleteSelectedObjects}) calls it for the family's share of a
   * multi-selection, inside ONE undo transaction, so it must resolve when the
   * deletions have LANDED (and its backend recorders must join an open
   * transaction). Rejects when the family refused (the objects stay).
   * Optional: a family without it keeps its members through a canvas-wide
   * Delete, and the user is told which.
   */
  deleteObjects?(regions: readonly GridRegion[]): Promise<void> | void;
  /**
   * COPY: a SNAPSHOT of each object behind `regions` (all of them this
   * family's) from which `pasteObjects` can later create a new object -- after
   * the original was moved, edited or even deleted, so a deep copy, never a
   * live reference. Opaque to the seam (@api/objectClipboard): only this
   * family ever reads it back. One entry per region, in order; null for an
   * object that could not be read (it is named as not copied).
   * Optional, and only meaningful together with `pasteObjects`: a family
   * without the pair cannot be copied or duplicated -- a Copy / Duplicate of a
   * selection that holds its objects leaves them out and names them in one
   * toast.
   */
  copyObjects?(regions: readonly GridRegion[]): Promise<ReadonlyArray<unknown>> | ReadonlyArray<unknown>;
  /**
   * PASTE: create one NEW object from each snapshot this family's
   * `copyObjects` made, on `target.sheetIndex`, at `target.place(rect)` where
   * `rect` is the snapshot's own position and size. The seam runs a paste or
   * duplicate of several objects inside ONE undo transaction, so this must
   * resolve when every creation has LANDED (its backend recorders join an
   * open transaction). A refused creation is reported in `refused`, not
   * thrown, and shows no dialog of its own (the seam's one toast names it).
   * The family does NOT select what it created: the seam makes every created
   * object, across families, the selection afterwards.
   */
  pasteObjects?(snapshots: ReadonlyArray<unknown>, target: ObjectPasteTarget): Promise<ObjectPasteResult>;
}

const providers = new Map<string, ObjectSelectionProvider>();

/**
 * The provider registered for a region TYPE, or null. For the seam's sibling
 * modules (@api/objectClipboard creates a copy through the family that owns a
 * clipboard entry's type); callers that act on objects use the functions
 * below, which go through the same providers.
 */
export function getObjectSelectionProvider(type: string): ObjectSelectionProvider | null {
  return providers.get(type) ?? null;
}

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

// ============================================================================
// Set state
// ============================================================================

/** Region ids of members the SET holds because their family does not. */
const heldIds = new Set<string>();
/** The member pressed / added / named primary last. */
let primaryId: string | null = null;
/**
 * The members a press gesture must not lose while the pressed family runs its
 * own click handler (which may drop them: a single-select family replaces its
 * one object, the pivot box deselects itself on any other family's press).
 * While set, `notifyObjectSelectionChanged` moves every dropped one into the
 * set. Region objects from the pre-press snapshot: providers answer
 * `isSelected` from the ids in `region.data`, which a re-publication keeps.
 */
let retained: readonly GridRegion[] | null = null;

const changeListeners = new Set<() => void>();
let batchDepth = 0;
let pendingNotify = false;
let emitting = false;

/** Whether the object's own family holds it. */
function familyHolds(region: GridRegion): boolean {
  const p = providers.get(region.type);
  return !!p && guarded("isSelected", () => p.isSelected(region), false);
}

/** Whether the family behind `p` holds any of the live `regions`. */
function familyHoldsAny(p: ObjectSelectionProvider, regions: readonly GridRegion[]): boolean {
  return regions.some((r) => providers.get(r.type) === p && familyHolds(r));
}

function isMember(region: GridRegion): boolean {
  return heldIds.has(region.id) || familyHolds(region);
}

function emit(): void {
  if (emitting) {
    pendingNotify = true;
    return;
  }
  emitting = true;
  try {
    // A listener that changes the selection re-announces; bounded so a
    // listener that always does cannot spin the frame.
    for (let pass = 0; pass < 5; pass++) {
      pendingNotify = false;
      for (const l of Array.from(changeListeners)) {
        try {
          l();
        } catch (err) {
          console.error("[objectSelection] change listener threw:", err);
        }
      }
      if (!pendingNotify) break;
    }
  } finally {
    emitting = false;
    pendingNotify = false;
  }
}

function markChanged(): void {
  if (batchDepth > 0) {
    pendingNotify = true;
    return;
  }
  emit();
}

/** Run `fn` announcing at most ONE change, at the end. */
function batch<T>(fn: () => T): T {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0 && pendingNotify && !emitting) emit();
  }
}

/** While a press gesture decides: dropped members are kept by the set. */
function keepRetained(): void {
  if (!retained) return;
  for (const r of retained) {
    if (!heldIds.has(r.id) && !familyHolds(r)) heldIds.add(r.id);
  }
}

// ============================================================================
// Single-object API (keyboard, scripts)
// ============================================================================

/** Whether some provider owns this region's type. */
export function canSelectObject(region: GridRegion): boolean {
  return providers.has(region.type);
}

/**
 * Select the object behind `region` -- and ONLY it: every other family is
 * deselected first and the set drops what it held. Returns false (and changes
 * nothing) when no provider owns its type.
 */
export function selectObject(region: GridRegion): boolean {
  const owner = providers.get(region.type);
  if (!owner) return false;
  batch(() => {
    settlePress();
    heldIds.clear();
    for (const p of distinctProviders()) {
      if (p !== owner) guarded("deselectAll", () => p.deselectAll(), undefined);
    }
    guarded("select", () => owner.select(region), undefined);
    primaryId = region.id;
    markChanged();
  });
  return true;
}

/** Deselect every object in every family, and empty the set. */
export function clearObjectSelection(): void {
  batch(() => {
    settlePress();
    heldIds.clear();
    primaryId = null;
    for (const p of distinctProviders()) guarded("deselectAll", () => p.deselectAll(), undefined);
    markChanged();
  });
}

/** Deselect every object in every family (the historical name of {@link clearObjectSelection}). */
export function deselectAllObjects(): void {
  clearObjectSelection();
}

/**
 * The first region in `regions` whose object is selected -- by its family or
 * by the set -- or null.
 */
export function getSelectedObjectRegion(regions: readonly GridRegion[]): GridRegion | null {
  for (const r of regions) {
    if (!providers.has(r.type)) continue;
    if (isMember(r)) return r;
  }
  return null;
}

/** Whether any family's inner selection owns `key` right now. */
export function objectOwnsKey(key: ObjectSelectionKey): boolean {
  return distinctProviders().some((p) => guarded("ownsKey", () => p.ownsKey?.(key) ?? false, false));
}

/**
 * The stable identity of the object behind `region` (see
 * `ObjectSelectionProvider.refOf`), or null when no provider owns its type,
 * the provider cannot name one, or it threw.
 */
export function objectRefOf(region: GridRegion): CanvasObjectRef | null {
  const p = providers.get(region.type);
  if (!p?.refOf) return null;
  return guarded("refOf", () => p.refOf!(region) ?? null, null);
}

// ============================================================================
// Identities a sheet's layout still names
// ============================================================================

/**
 * The refs a sheet's saved LAYOUT names (a canvas's `locked` and `zOrder`
 * lists, CanvasSheet lib/layoutRefs.ts), INCLUDING refs of objects that are
 * gone: a delete does not prune a ref when its object is deleted, and must
 * not -- the delete's undo step restores the object, not the layout lists, so
 * a pruned lock (or paint slot) would not come back when Ctrl+Z restores the
 * object. (Restacking and locking are undoable steps of their own since W5.)
 */
export type LayoutRefSource = (sheetIndex: number) => readonly CanvasObjectRef[];

let layoutRefSource: LayoutRefSource | null = null;

/**
 * Register THE layout-ref source (the canvas sheet extension). Last
 * registration wins; the cleanup unregisters only if this source is still the
 * registered one.
 */
export function registerLayoutRefSource(source: LayoutRefSource): () => void {
  layoutRefSource = source;
  return () => {
    if (layoutRefSource === source) layoutRefSource = null;
  };
}

/**
 * The ids of `kind` that the layout of `sheetIndex` names, live or dead ([]
 * on a worksheet, with no source, or when the source threw).
 *
 * For a family whose ids are RECYCLED -- a control is named by its anchor
 * cell, and a new control can be handed the anchor a deleted one freed -- an
 * id named here is NOT free: a new object given it would inherit the dead
 * one's lock and its slot in the paint order (wave C review). Ids that are
 * never reused (a chart's UUID) need not ask.
 */
export function idsNamedByLayout(sheetIndex: number, kind: CanvasObjectKind): string[] {
  const source = layoutRefSource;
  if (!source) return [];
  return guarded(
    "layoutRefSource",
    () => source(sheetIndex).filter((r) => r.kind === kind).map((r) => r.id),
    [] as string[],
  );
}

/**
 * What the object behind `region` is called (see
 * `ObjectSelectionProvider.labelOf`); null when nobody can say, or an empty
 * name.
 */
export function objectLabelOf(region: GridRegion): string | null {
  const p = providers.get(region.type);
  if (!p?.labelOf) return null;
  const label = guarded("labelOf", () => p.labelOf!(region) ?? null, null);
  return typeof label === "string" && label.trim() !== "" ? label : null;
}

/**
 * The floating regions currently published, in PAINT order (bottom first) --
 * `stackedFloatingRegions` (@api/gridOverlays), the order the renderer stacks
 * them in: by overlay priority then publication order, or by the stacking
 * order when one is in force. `regions` defaults to the live list; only
 * floating regions whose type has a selection provider are returned (what
 * cannot be selected cannot be cycled to).
 */
export function selectableFloatingRegions(regions: readonly GridRegion[] = getGridRegions()): GridRegion[] {
  return stackedFloatingRegions(regions).filter((r) => providers.has(r.type));
}

// ============================================================================
// The selection SET (canvas multi-selection)
// ============================================================================

/**
 * Every selected object -- held by its family or by the set -- in PAINT
 * order (bottom first). `regions` defaults to the live list.
 */
export function getSelectedObjectRegions(regions: readonly GridRegion[] = getGridRegions()): GridRegion[] {
  return selectableFloatingRegions(regions).filter(isMember);
}

/**
 * The members the SET holds and their family does not show -- the ones whose
 * selection chrome the canvas paints. Paint order.
 */
export function getSetHeldObjectRegions(regions: readonly GridRegion[] = getGridRegions()): GridRegion[] {
  return selectableFloatingRegions(regions).filter((r) => heldIds.has(r.id) && !familyHolds(r));
}

/** Whether the object behind `region` is in the selection (family or set). */
export function isObjectInSelection(region: GridRegion): boolean {
  return providers.has(region.type) && isMember(region);
}

/**
 * The PRIMARY member: the one pressed, added or named primary last, while it
 * is still selected; otherwise the topmost member. Null when nothing is.
 */
export function getPrimaryObjectRegion(regions: readonly GridRegion[] = getGridRegions()): GridRegion | null {
  const members = getSelectedObjectRegions(regions);
  return members.find((r) => r.id === primaryId) ?? members[members.length - 1] ?? null;
}

/**
 * Make `regions` THE selection. Each family with members selects one through
 * its provider's `select` (the `primary` when it is that family's, else its
 * first member) and takes the rest through `addToSelection` where it has it;
 * the set holds the others. Every family with no member is deselected. Types
 * no provider owns are ignored; `primary` defaults to the last member.
 */
export function setObjectSelectionSet(regions: readonly GridRegion[], primary?: GridRegion | null): void {
  const members: GridRegion[] = [];
  const seen = new Set<string>();
  for (const r of regions) {
    if (!providers.has(r.type) || seen.has(r.id)) continue;
    seen.add(r.id);
    members.push(r);
  }
  const lead =
    primary && members.some((m) => m.id === primary.id) ? primary : members[members.length - 1] ?? null;

  batch(() => {
    settlePress();
    heldIds.clear();
    const byProvider = new Map<ObjectSelectionProvider, GridRegion[]>();
    for (const m of members) {
      const p = providers.get(m.type)!;
      const list = byProvider.get(p);
      if (list) list.push(m);
      else byProvider.set(p, [m]);
    }
    for (const p of distinctProviders()) {
      if (!byProvider.has(p)) guarded("deselectAll", () => p.deselectAll(), undefined);
    }
    for (const [p, list] of byProvider) {
      const head = lead && list.some((m) => m.id === lead.id) ? lead : list[0];
      guarded("select", () => p.select(head), undefined);
      for (const m of list) {
        if (m.id === head.id) continue;
        if (p.addToSelection) guarded("addToSelection", () => p.addToSelection!(m), undefined);
        else heldIds.add(m.id);
      }
    }
    primaryId = lead?.id ?? null;
    markChanged();
  });
}

/**
 * Add the object behind `region` to the selection, keeping every other
 * member, and make it the primary. Its family selects it when the family holds
 * nothing yet, adds it when the family can hold several, and otherwise the set
 * holds it. Returns false when no provider owns its type.
 */
export function addToObjectSelection(region: GridRegion): boolean {
  const p = providers.get(region.type);
  if (!p) return false;
  batch(() => {
    settlePress();
    if (!isMember(region)) {
      if (!familyHoldsAny(p, getGridRegions())) {
        guarded("select", () => p.select(region), undefined);
      } else if (p.addToSelection) {
        guarded("addToSelection", () => p.addToSelection!(region), undefined);
      } else {
        heldIds.add(region.id);
      }
    }
    primaryId = region.id;
    markChanged();
  });
  return true;
}

/**
 * Take the object behind `region` out of the selection, keeping the rest. A
 * single-select family that loses its one object takes another member it has
 * in the set, if any, so its contextual UI keeps addressing a selected object.
 */
export function removeFromObjectSelection(region: GridRegion): void {
  batch(() => {
    settlePress();
    heldIds.delete(region.id);
    const p = providers.get(region.type);
    if (p && familyHolds(region)) {
      if (p.removeFromSelection) {
        guarded("removeFromSelection", () => p.removeFromSelection!(region), undefined);
      } else {
        const next = [...getSetHeldObjectRegions()]
          .reverse()
          .find((r) => providers.get(r.type) === p && r.id !== region.id);
        if (next) {
          guarded("select", () => p.select(next), undefined);
          heldIds.delete(next.id);
        } else {
          guarded("deselectAll", () => p.deselectAll(), undefined);
        }
      }
    }
    if (primaryId === region.id) primaryId = null;
    markChanged();
  });
}

/**
 * Forget what the SET holds, leaving every family's own selection alone. The
 * canvas calls it when the active sheet changes: the set's members belong to
 * the page they were chosen on, and each family already clears its own.
 */
export function clearSetHeldObjects(): void {
  if (heldIds.size === 0) return;
  batch(() => {
    heldIds.clear();
    markChanged();
  });
}

// ============================================================================
// Acting on the WHOLE selection (canvas multi-selection)
// ============================================================================

/**
 * Whether the selection is one that no single family's own door can act on
 * whole: two or more members of DIFFERENT families, or any member the SET
 * holds for a single-select family (a second chart). Several objects of ONE
 * family that holds them all itself (three controls) is not: that family's
 * own Delete already acts on all of them. `regions` defaults to the live list.
 */
export function objectSelectionSpansFamilies(regions: readonly GridRegion[] = getGridRegions()): boolean {
  const members = getSelectedObjectRegions(regions);
  if (members.length < 2) return false;
  if (members.some((r) => heldIds.has(r.id) && !familyHolds(r))) return true;
  return new Set(members.map((r) => providers.get(r.type))).size > 1;
}

/**
 * THE rule a family's own door (Delete, Copy, Duplicate) asks before acting on
 * its own share: is this a multi-selection that spans families (see
 * {@link objectSelectionSpansFamilies})? Then the door must speak for the
 * whole selection -- hand a Delete to {@link deleteSelectedObjects}, refuse a
 * copy it cannot make whole -- instead of acting on what its family holds.
 *
 * On a canvas AND a worksheet (BUG-0270 review). It used to be canvas-only:
 * a worksheet had no press parity, so a chart and a slicer clicked in turn
 * both stayed "selected" there by ACCIDENT, and a Delete on the chart's TITLE
 * must not take the chart and the slicer with it (wave A review). Press
 * parity now reaches worksheets (`noteWorksheetObjectPress`): a plain press
 * deselects every other family, so a selection that spans families is a
 * DELIBERATE one (Ctrl/Shift+click), and Excel deletes such a selection whole.
 * One family's objects alone are not a spanning selection: a chart walked to
 * its title keeps "Delete deletes the title". One helper, so the doors cannot
 * disagree about where the line is.
 */
export function shouldActOnWholeObjectSelection(regions: readonly GridRegion[] = getGridRegions()): boolean {
  return objectSelectionSpansFamilies(regions);
}

/** What an action on the whole selection did. */
export interface ObjectSelectionActionOutcome {
  /** Members whose family acted on them. */
  acted: number;
  /** Members whose family cannot do this through the seam (they stay). */
  unsupported: number;
  /** Members whose family refused (they stay; one toast said why). */
  failed: number;
}

/**
 * DELETE every selected object -- the members each family holds AND the
 * members the set holds for a single-select family -- as ONE undo step
 * labelled `label`.
 *
 * Why it exists (open-items 2.af row 1): each family's own Delete acts on what
 * that family holds, and the keybinding dispatcher runs ONE winner per key, so
 * with a chart, a second chart and a control selected on a canvas, Delete
 * removed one chart and left the rest. The families' Delete doors hand a
 * selection for which {@link shouldActOnWholeObjectSelection} answers yes to
 * this instead.
 *
 * Grouped by family, in paint order; each family's share goes to its
 * provider's `deleteObjects` inside one frontend undo transaction
 * (`runInUndoTransaction`, @api/objectGeometry). A member whose family has no
 * `deleteObjects`, or whose family refused, STAYS -- it is left as the
 * selection, and ONE toast names the ones not deleted (and the refusal).
 *
 * A READ-ONLY page (a subscribed canvas: its layout surface is not
 * `editable`) refuses the whole delete before anything is sent: one toast
 * with the subscribed sentence, no undo step, the selection kept -- the rule
 * Paste and Duplicate already follow there (@api/objectClipboard).
 */
export async function deleteSelectedObjects(label = "Delete Objects"): Promise<ObjectSelectionActionOutcome> {
  const members = getSelectedObjectRegions();
  const outcome: ObjectSelectionActionOutcome = { acted: 0, unsupported: 0, failed: 0 };
  if (members.length === 0) return outcome;

  const sheetIndex = getGridStateSnapshot()?.sheetContext?.activeSheetIndex ?? 0;
  if (getLayoutSurface(sheetIndex)?.editable === false) {
    outcome.failed = members.length;
    showToast(`${label}: ${SIZE_POSITION_SUBSCRIBED} Nothing was changed.`, { type: "info" });
    return outcome;
  }

  const groups = new Map<ObjectSelectionProvider, GridRegion[]>();
  const kept: GridRegion[] = [];
  for (const m of members) {
    const p = providers.get(m.type);
    if (!p?.deleteObjects) {
      kept.push(m);
      continue;
    }
    const list = groups.get(p);
    if (list) list.push(m);
    else groups.set(p, [m]);
  }
  outcome.unsupported = kept.length;

  const reasons: string[] = [];
  const refused: GridRegion[] = [];
  if (groups.size > 0) {
    try {
      await runInUndoTransaction(label, async () => {
        for (const [p, list] of groups) {
          try {
            await p.deleteObjects!(list);
            outcome.acted += list.length;
          } catch (err) {
            refused.push(...list);
            reasons.push(err instanceof Error ? err.message : String(err));
            console.error(`[objectSelection] "${label}" refused for ${list.length} object(s):`, err);
          }
        }
      });
    } catch (err) {
      // The transaction itself could not be opened or closed; what ran is on
      // the undo stack either way.
      console.error(`[objectSelection] "${label}" transaction failed:`, err);
    }
  }

  // What is still there stays selected; what was deleted is gone from it.
  const live = new Set(getGridRegions().map((r) => r.id));
  // A family that refused may still have deleted PART of its share (two
  // charts, the second refused): what is gone was deleted, and only what is
  // still standing was refused -- it is named, and it stays selected.
  const stillThere = refused.filter((r) => live.has(r.id));
  outcome.acted += refused.length - stillThere.length;
  outcome.failed = stillThere.length;
  kept.push(...stillThere);
  if (stillThere.length === 0) reasons.length = 0;
  const remaining = kept.filter((r) => live.has(r.id));
  if (remaining.length > 0) setObjectSelectionSet(remaining);
  else clearObjectSelection();

  if (kept.length > 0) {
    const names = kept.map((r) => objectLabelOf(r) ?? r.type);
    const why = Array.from(new Set(reasons.filter((r) => r.trim() !== "")));
    const what = kept.length === 1 ? "1 selected object was" : `${kept.length} selected objects were`;
    const advice =
      why.length > 0 ? why.join(" ") : kept.length === 1 ? "Delete it on its own." : "Delete them one at a time.";
    showToast(`${label}: ${what} not deleted (${names.join(", ")}). ${advice}`, {
      type: outcome.failed > 0 ? "error" : "warning",
      duration: 8000,
    });
  }
  return outcome;
}

/**
 * Subscribe to selection changes -- a family's own, and the set's. The
 * listener reads the state back (`getSelectedObjectRegions` and friends).
 * Returns the unsubscribe.
 */
export function onObjectSelectionChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

/**
 * Announce that a family's selection changed. Families call it at their
 * selection chokepoints (select / deselect), so the set -- and everything
 * that follows it: the canvas chrome, the Name Box label -- reflects a
 * selection a mouse press made inside the family.
 */
export function notifyObjectSelectionChanged(): void {
  keepRetained();
  markChanged();
}

// ============================================================================
// Press parity (Core calls this on a canvas)
// ============================================================================

/** The modifiers of a press, as Core saw them. */
export interface ObjectPressModifiers {
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

type PressMode = "keep" | "add" | "toggle";

interface PressGesture {
  region: GridRegion;
  mode: PressMode;
  moved: boolean;
  released: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  detach: () => void;
}

let press: PressGesture | null = null;

/**
 * Core's hook for a LEFT press on a floating object on a CANVAS, called
 * BEFORE `floatingObject:selected` is dispatched (so the pressed family's own
 * handler still decides what the press means inside the family):
 *
 *   - plain press, object not in a multi-selection: every OTHER family is
 *     deselected and the set drops what it held -- one object selected;
 *   - Ctrl/Shift press on an object NOT in the set: the rest stays (members a
 *     family drops while handling the press are kept by the set);
 *   - Ctrl/Shift press on a member: that member leaves the set at mouseup;
 *   - plain press on a member of a multi-selection: the set is kept for a
 *     possible group drag, and narrowed to that object at mouseup only if the
 *     object did not move.
 */
export function noteObjectPress(region: GridRegion, mods: ObjectPressModifiers = {}): void {
  settlePress();
  const additive = mods.ctrlKey === true || mods.shiftKey === true;
  const before = getSelectedObjectRegions();
  const wasMember = before.some((r) => r.id === region.id);

  if (!additive && !(wasMember && before.length > 1)) {
    const owner = providers.get(region.type);
    batch(() => {
      heldIds.clear();
      for (const p of distinctProviders()) {
        if (p !== owner) guarded("deselectAll", () => p.deselectAll(), undefined);
      }
      primaryId = region.id;
      markChanged();
    });
    return;
  }

  const mode: PressMode = !additive ? "keep" : wasMember ? "toggle" : "add";
  retained = mode === "toggle" ? before.filter((r) => r.id !== region.id) : before;
  if (mode !== "toggle") primaryId = region.id;
  armPress(region, mode);
}

/**
 * Core's hook for a LEFT press on a floating object on a WORKSHEET (the
 * canvas twin is {@link noteObjectPress}), called BEFORE
 * `floatingObject:selected` is dispatched, so the pressed family's own handler
 * still decides what the press means inside the family (a group, a chart's
 * next rung, a slicer's pending click):
 *
 *   - plain press: every OTHER family is deselected and the set drops what it
 *     held -- the object pressed is the only family's selection, so Delete
 *     deletes what was just clicked (BUG-0270 review);
 *   - Ctrl/Shift press: nothing here -- the pressed family adds or toggles
 *     within itself, and the other families' objects stay: a deliberate
 *     multi-selection, which Delete removes whole
 *     ({@link shouldActOnWholeObjectSelection}).
 *
 * Nothing is armed: a worksheet has no cross-family group drag, so a plain
 * press on a member of a multi-selection simply narrows it to its family.
 * Core passes `{}` for a press on an object's CONTENT (the modifiers are the
 * content's there), which is a plain press.
 */
export function noteWorksheetObjectPress(region: GridRegion, mods: ObjectPressModifiers = {}): void {
  settlePress();
  if (mods.ctrlKey === true || mods.shiftKey === true) return;
  const owner = providers.get(region.type);
  batch(() => {
    heldIds.clear();
    for (const p of distinctProviders()) {
      if (p !== owner) guarded("deselectAll", () => p.deselectAll(), undefined);
    }
    primaryId = region.id;
    markChanged();
  });
}

function armPress(region: GridRegion, mode: PressMode): void {
  const gesture: PressGesture = { region, mode, moved: false, released: false, timer: null, detach: () => {} };
  const onMoved = (e: Event): void => {
    const d = (e as CustomEvent<{ regionId?: unknown }>).detail;
    if (d?.regionId === region.id) gesture.moved = true;
  };
  // SESSION-SCOPED: bound by the press, removed at its mouseup (or when the
  // next press settles a gesture whose mouseup never arrived). The finish is
  // deferred one task so it runs AFTER every other mouseup listener -- Core's
  // own, which dispatches the moveComplete this gesture is waiting to hear,
  // is re-bound after a press begins a drag and so runs after this one.
  const onUp = (): void => {
    window.removeEventListener("mouseup", onUp);
    gesture.released = true;
    gesture.timer = setTimeout(() => finishPress(gesture), 0);
  };
  gesture.detach = () => {
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("floatingObject:moveComplete", onMoved);
    if (gesture.timer !== null) clearTimeout(gesture.timer);
  };
  window.addEventListener("mouseup", onUp);
  window.addEventListener("floatingObject:moveComplete", onMoved);
  press = gesture;
}

/**
 * End the pending press gesture: finish it now when its mouseup already
 * arrived (a fast next press can beat the deferred finish), forget it when
 * the mouseup never came.
 */
function settlePress(): void {
  const g = press;
  if (!g) return;
  if (g.released) {
    finishPress(g);
    return;
  }
  g.detach();
  press = null;
  retained = null;
}

function liveRegion(region: GridRegion): GridRegion {
  return getGridRegions().find((r) => r.id === region.id) ?? region;
}

function finishPress(g: PressGesture): void {
  if (press !== g) return;
  g.detach();
  press = null;
  const kept = retained ?? [];
  retained = null;
  batch(() => {
    if (g.mode === "keep" && !g.moved) {
      const target = liveRegion(g.region);
      setObjectSelectionSet([target], target);
      return;
    }
    restoreMembers(kept);
    if (g.mode === "toggle") removeFromObjectSelection(liveRegion(g.region));
    markChanged();
  });
}

/**
 * Hand the members a gesture kept back to their families where a family can
 * hold them (it holds nothing, or it can hold several); the set holds the
 * rest. Runs after the gesture, outside every family's own handler.
 */
function restoreMembers(kept: readonly GridRegion[]): void {
  const live = getGridRegions();
  for (const r of kept) {
    if (familyHolds(r)) {
      heldIds.delete(r.id);
      continue;
    }
    const p = providers.get(r.type);
    if (!p) continue;
    if (!familyHoldsAny(p, live)) {
      guarded("select", () => p.select(r), undefined);
    } else if (p.addToSelection) {
      guarded("addToSelection", () => p.addToSelection!(r), undefined);
    }
    if (familyHolds(r)) heldIds.delete(r.id);
    else heldIds.add(r.id);
  }
}

/** Test hook: forget every provider and all selection-set state. */
export function resetObjectSelectionProviders(): void {
  providers.clear();
  layoutRefSource = null;
  if (press) press.detach();
  press = null;
  retained = null;
  heldIds.clear();
  primaryId = null;
  batchDepth = 0;
  pendingNotify = false;
  emitting = false;
}
