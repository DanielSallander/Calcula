//! FILENAME: app/src/api/scriptHost/embeddedFormPlacements.ts
// PURPOSE: The IDENTITY of a form embedded on a sheet (M3c part 1) — the
//          document-resident record that says "a form of script X is placed
//          HERE", separately from any live session painting it.
// CONTEXT: Leaf module. It imports `../events` and nothing else from the script
//          host, so the registry that owns sessions (scriptPanes.ts), the
//          trusted renderer (extensions/ScriptableObjects) and the transparency
//          panel can all read it without an import cycle and without a second
//          copy of the rules.
//
// WHY AN IDENTITY MODULE AT ALL, AND WHY THIS ONE. Every other on-grid object
// in Calcula derives its id from its ANCHOR CELL: a floating control's id is
// literally `control-{sheet}-{row}-{col}` (`extensions/Controls/lib/
// floatingStore.ts`, `makeFloatingControlId`). That is the defect M3 exists to
// close. An id that IS a position means:
//   - COPY LOSES THE SCRIPT. Paste the object two rows down and it is a
//     different id, so every id-keyed side table — the object script bound to
//     it above all — points at the original and the copy is inert. This is the
//     documented reason a form's identity is a minted UUID in the first place
//     (`extensions/ScriptableObjects/lib/createForm.ts`, its CONTEXT note).
//   - A STRUCTURAL EDIT RENAMES IT. Insert a row above and the anchor moves, so
//     the id moves, so every consumer has to be told to re-key
//     (`reanchorFloatingControls`' `onRename` hook exists only for that).
//   - DELETING THE ANCHOR DELETES THE OBJECT, silently: `reanchorFloatingControls`
//     drops a control whose row was deleted, and nothing tells the user that a
//     surface they built is gone.
//
// So this module adopts the model CELL BEHAVIORS already use (`app/src/api/
// cellBehaviors.ts`): a minted UUID identity, geometry carried BESIDE it and
// shifted on its own, and an `orphaned` flag when the anchor goes away. The
// three consequences invert:
//   - a COPY is a new placement with a NEW id and the SAME `scriptId` — a
//     second instance of the same form, which is what a user copying a form
//     onto another row means;
//   - a STRUCTURAL EDIT moves `anchorRow` / `anchorCol` and touches nothing
//     else, so no consumer re-keys and no session is interrupted;
//   - DELETING THE ANCHOR sets `orphaned` and keeps the record, so the surface
//     paints as an orphan the user can see, re-place or delete, instead of
//     disappearing with their work in it.
//
// WHAT IS NOT HERE. This module holds no pixels and paints nothing: the
// renderer turns a placement into a grid region. It also holds no SESSION —
// which script is running, what the user has typed, which cells are bound —
// because a placement outlives every session it hosts (the script can be
// stopped and restarted under it) and a session can be refused while the
// placement stands (an orphan, or a script that is not mounted).

import { emitAppEvent } from "../events";

// ============================================================================
// Limits
// ============================================================================

/**
 * Most embedded forms one SHEET may carry. Each is a live widget tree with its
 * own session, its own bound cells and its own live cell watch, so this is a
 * real resource bound and not a tidiness rule — and it is the bound that stands
 * in for the pane registry's per-script cap, which the embedded path
 * deliberately does not use (see `dockScriptPane`). A user placing the
 * twenty-first is refused by name rather than given a surface that never opens.
 */
export const MAX_EMBEDDED_FORMS_PER_SHEET = 20;

/** Smallest embedded form, in sheet pixels. Below this nothing readable fits. */
export const MIN_EMBEDDED_FORM_WIDTH = 120;
export const MIN_EMBEDDED_FORM_HEIGHT = 80;

/** Largest embedded form, in sheet pixels — finite, so no arithmetic on it reaches CSS as `Infinity`. */
export const MAX_EMBEDDED_FORM_EDGE = 4000;

/** The default box a newly placed form gets, in sheet pixels. */
export const DEFAULT_EMBEDDED_FORM_WIDTH = 320;
export const DEFAULT_EMBEDDED_FORM_HEIGHT = 240;

/** Emitted whenever the placement set changes (place, copy, move, shift, orphan, remove, reset). */
export const EMBEDDED_FORM_PLACEMENTS_CHANGED_EVENT = "scriptable-objects:embedded-forms-changed";

// ============================================================================
// What an orphan can be told to do — ONE sentence, three surfaces
// ============================================================================

/**
 * The two grid context-menu items that act on a placement, in the words the
 * user reads. Declared HERE and imported by the extension that registers them
 * (`extensions/ScriptableObjects/lib/embeddedFormUx.ts`), because `@api` may
 * never import from an extension and the sentence below QUOTES these words: a
 * label edited on one side only is advice naming a menu item that is not there.
 */
export const EMBEDDED_FORM_RESTORE_MENU_LABEL = "Put This Form Back Here";
export const EMBEDDED_FORM_REMOVE_MENU_LABEL = "Remove This Form From the Sheet";

/**
 * What a user can actually DO about an orphaned placement. Read by every
 * surface that says one is orphaned: the card the layer paints
 * (`components/scriptEmbed/ScriptEmbeddedFormSurface.tsx`), the inert-session
 * sentence (`lib/scriptEmbedHost.ts`'s `closedSentence`) and this module's
 * consumer in the host (`openEmbeddedScriptForm`).
 *
 * IT USED TO SAY "DRAG IT ONTO A CELL TO PUT IT BACK", in all three, and no
 * code has ever implemented that drag. `setEmbeddedFormGeometry` has exactly
 * one production caller — the context-menu item named above — and Core's move
 * path refuses an embedded form's region before it reads anything the region
 * publishes: `handleOverlayMoveMouseDown` returns early on
 * `!hit.region.floating` (`core/hooks/useMouseSelection/layout/
 * overlayMoveHandlers.ts`) and these regions are cell-anchored, with no
 * `floating` box. So a drag of the box did NOTHING in run mode (the DOM host
 * over the canvas swallows it) and became an ordinary cell range-selection in
 * Design Mode (that host is click-through there), while the one gesture that
 * works sat in the menu under the user's cursor, named nowhere. A refusal that
 * names an impossible remedy is worse
 * than one that names none; the day a drag lands, this constant is the single
 * place the promise changes.
 */
export const EMBEDDED_FORM_ORPHAN_REMEDY =
  `Right-click the cell at its top-left corner and choose "${EMBEDDED_FORM_RESTORE_MENU_LABEL}" to put it back, ` +
  `or "${EMBEDDED_FORM_REMOVE_MENU_LABEL}" to delete it.`;

// ============================================================================
// The record
// ============================================================================

/** One form of one script, placed on one sheet. */
export interface EmbeddedFormPlacement {
  /**
   * MINTED, never derived. The identity of this placement for its whole life:
   * a copy gets a different one, a structural edit does not change it, and
   * deleting the anchor does not free it (the record stays, orphaned).
   */
  id: string;
  /**
   * The form script painted here. SHARED by copies on purpose — copying a form
   * on the grid gives you a second instance of the same form, not a second
   * script — which is exactly what the anchor-derived id could not express.
   */
  scriptId: string;
  sheetIndex: number;
  /** The cell the placement hangs from. Moved by a structural edit; never part of the id. */
  anchorRow: number;
  anchorCol: number;
  /** Pixel offset from the anchor cell's top-left, so a nudge does not re-anchor. */
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  /**
   * The anchor row or column was deleted. The record is KEPT: the surface
   * paints as an orphan (see `cellBehaviorUx.ts` for the colour idiom) and no
   * session opens for it, because its cell bindings would resolve against
   * whatever now occupies those coordinates.
   */
  orphaned: boolean;
}

/** What `placeEmbeddedForm` is given. Everything else is defaulted and bounded here. */
export interface PlaceEmbeddedFormOptions {
  scriptId: string;
  sheetIndex: number;
  anchorRow: number;
  anchorCol: number;
  offsetX?: number;
  offsetY?: number;
  width?: number;
  height?: number;
}

// ============================================================================
// State
// ============================================================================

const placements = new Map<string, EmbeddedFormPlacement>();

/** Test seam: `crypto.randomUUID` is the only id source in production. */
let mintId: () => string = () => crypto.randomUUID();

function announce(): void {
  emitAppEvent(EMBEDDED_FORM_PLACEMENTS_CHANGED_EVENT);
}

function clampEdge(v: number | undefined, fallback: number, min: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(MAX_EMBEDDED_FORM_EDGE, Math.max(min, n));
}

function clampOffset(v: number | undefined): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
  return Math.min(MAX_EMBEDDED_FORM_EDGE, Math.max(0, n));
}

// ============================================================================
// Reads
// ============================================================================

export function getEmbeddedFormPlacement(id: string): EmbeddedFormPlacement | null {
  const p = placements.get(id);
  return p ? { ...p } : null;
}

/** Every placement, in placement order (the order the user created them). */
export function listEmbeddedFormPlacements(): EmbeddedFormPlacement[] {
  return [...placements.values()].map((p) => ({ ...p }));
}

export function listEmbeddedFormPlacementsForSheet(sheetIndex: number): EmbeddedFormPlacement[] {
  return listEmbeddedFormPlacements().filter((p) => p.sheetIndex === sheetIndex);
}

/** Every placement painting a given script's form — what an unmount has to close. */
export function listEmbeddedFormPlacementsForScript(scriptId: string): EmbeddedFormPlacement[] {
  return listEmbeddedFormPlacements().filter((p) => p.scriptId === scriptId);
}

// ============================================================================
// Writes
// ============================================================================

/**
 * Place a form on a sheet. THE USER'S ACT, never a script's: nothing in the
 * worker's surface reaches this function, which is why an embedded session
 * needs no rate bucket at its entry the way `pane.dock` does.
 *
 * Refuses past MAX_EMBEDDED_FORMS_PER_SHEET by throwing, so the caller can say
 * so; returning null would make "the sheet is full" indistinguishable from
 * "something went wrong".
 */
export function placeEmbeddedForm(options: PlaceEmbeddedFormOptions): EmbeddedFormPlacement {
  const onSheet = listEmbeddedFormPlacementsForSheet(options.sheetIndex);
  if (onSheet.length >= MAX_EMBEDDED_FORMS_PER_SHEET) {
    throw new Error(
      `This sheet already holds ${MAX_EMBEDDED_FORMS_PER_SHEET} embedded forms, the most Calcula paints on one sheet. ` +
        "Delete one, or place this form on another sheet.",
    );
  }
  const placement: EmbeddedFormPlacement = {
    id: mintId(),
    scriptId: options.scriptId,
    sheetIndex: options.sheetIndex,
    anchorRow: Math.max(0, Math.round(options.anchorRow)),
    anchorCol: Math.max(0, Math.round(options.anchorCol)),
    offsetX: clampOffset(options.offsetX),
    offsetY: clampOffset(options.offsetY),
    width: clampEdge(options.width, DEFAULT_EMBEDDED_FORM_WIDTH, MIN_EMBEDDED_FORM_WIDTH),
    height: clampEdge(options.height, DEFAULT_EMBEDDED_FORM_HEIGHT, MIN_EMBEDDED_FORM_HEIGHT),
    orphaned: false,
  };
  placements.set(placement.id, placement);
  announce();
  return { ...placement };
}

/**
 * Copy a placement to another anchor: A DISTINCT INSTANCE WITH ITS OWN ID AND
 * THE SAME SCRIPT.
 *
 * This is the whole point of the minted identity. With an anchor-derived id the
 * copy's id was decided by where it landed, so the script bound to the original
 * id was simply not bound to the copy — the object pasted, painted nothing, and
 * nothing said why. Here the size travels, the anchor is the paste target, the
 * `scriptId` is shared (both instances run the same form) and the id is fresh
 * (they are two surfaces, with two sessions and two sets of typed values).
 *
 * An ORPHANED source copies as a LIVE placement: the copy is being anchored to
 * a cell that exists, so the condition that orphaned the original does not
 * apply to it.
 */
export function copyEmbeddedForm(
  id: string,
  to: { sheetIndex: number; anchorRow: number; anchorCol: number },
): EmbeddedFormPlacement | null {
  const source = placements.get(id);
  if (!source) return null;
  return placeEmbeddedForm({
    scriptId: source.scriptId,
    sheetIndex: to.sheetIndex,
    anchorRow: to.anchorRow,
    anchorCol: to.anchorCol,
    offsetX: source.offsetX,
    offsetY: source.offsetY,
    width: source.width,
    height: source.height,
  });
}

/**
 * Move / resize a placement (the user dragged it). GEOMETRY ONLY: the id is
 * never touched here, which is the difference from `reanchorFloatingControls`,
 * where a move rewrites the id and every consumer has to be re-keyed.
 */
export function setEmbeddedFormGeometry(
  id: string,
  geometry: {
    sheetIndex?: number;
    anchorRow?: number;
    anchorCol?: number;
    offsetX?: number;
    offsetY?: number;
    width?: number;
    height?: number;
  },
): EmbeddedFormPlacement | null {
  const p = placements.get(id);
  if (!p) return null;
  if (geometry.sheetIndex !== undefined) p.sheetIndex = geometry.sheetIndex;
  if (geometry.anchorRow !== undefined) p.anchorRow = Math.max(0, Math.round(geometry.anchorRow));
  if (geometry.anchorCol !== undefined) p.anchorCol = Math.max(0, Math.round(geometry.anchorCol));
  if (geometry.offsetX !== undefined) p.offsetX = clampOffset(geometry.offsetX);
  if (geometry.offsetY !== undefined) p.offsetY = clampOffset(geometry.offsetY);
  if (geometry.width !== undefined) p.width = clampEdge(geometry.width, p.width, MIN_EMBEDDED_FORM_WIDTH);
  if (geometry.height !== undefined) p.height = clampEdge(geometry.height, p.height, MIN_EMBEDDED_FORM_HEIGHT);
  // A user who moved an orphan onto a live cell has re-anchored it; keeping the
  // orphan flag would leave a surface permanently marked broken after the one
  // action that fixes it.
  if (p.orphaned && (geometry.anchorRow !== undefined || geometry.anchorCol !== undefined)) {
    p.orphaned = false;
  }
  announce();
  return { ...p };
}

/**
 * A structural edit moved the cells of one sheet: SHIFT the geometry, leave
 * every identity alone.
 *
 * `shift` is the caller's row/column mapping — the same shape
 * `reanchorFloatingControls` takes — and returns `null` when that cell no longer
 * exists. The two answers here are the whole model:
 *   - a NEW anchor: the record is updated in place. No id changes, so no
 *     consumer re-keys, and a session painting this placement carries on.
 *   - `null`: the record is ORPHANED, not deleted. The user placed a form on a
 *     row somebody has now deleted; dropping it would take their layout, their
 *     bindings and (through the session) whatever they had typed, with no
 *     notice anywhere. An orphan is visible, and re-placing or deleting it is
 *     the user's decision.
 *
 * Returns true when anything changed, so the caller can skip a repaint.
 */
export function shiftEmbeddedFormPlacements(
  sheetIndex: number,
  shift: (row: number, col: number) => { row: number; col: number } | null,
): boolean {
  let changed = false;
  for (const p of placements.values()) {
    if (p.sheetIndex !== sheetIndex || p.orphaned) continue;
    const moved = shift(p.anchorRow, p.anchorCol);
    if (moved === null) {
      p.orphaned = true;
      changed = true;
      continue;
    }
    if (moved.row === p.anchorRow && moved.col === p.anchorCol) continue;
    p.anchorRow = moved.row;
    p.anchorCol = moved.col;
    changed = true;
  }
  if (changed) announce();
  return changed;
}

/** The four structural edits an anchor has to survive. */
export type StructuralEditKind = "rowInsert" | "rowDelete" | "colInsert" | "colDelete";

/**
 * The anchor mapping for one structural edit — what `shiftEmbeddedFormPlacements`
 * is given. `null` means "that cell no longer exists", which is what turns into
 * an orphan.
 *
 * DUPLICATION DECLARED: `extensions/Controls/index.ts` holds the same fifteen
 * lines inline as `shiftForEvent`, for re-anchoring floating controls. That copy
 * is older and is not this slice's to move; it should be replaced by a call to
 * this function, and until it is, the two must be changed together. The rule
 * itself belongs in one place because it is grid semantics, owned by neither
 * feature.
 */
export function structuralAnchorShift(
  kind: StructuralEditKind,
  at: number,
  count: number,
): (row: number, col: number) => { row: number; col: number } | null {
  return (row, col) => {
    switch (kind) {
      case "rowInsert":
        return { row: row >= at ? row + count : row, col };
      case "colInsert":
        return { row, col: col >= at ? col + count : col };
      case "rowDelete":
        if (row >= at + count) return { row: row - count, col };
        if (row >= at) return null; // The anchor row itself was deleted.
        return { row, col };
      case "colDelete":
        if (col >= at + count) return { row, col: col - count };
        if (col >= at) return null;
        return { row, col };
    }
  };
}

/**
 * Orphan a placement outright — the sheet it lived on was deleted. Same
 * treatment as a deleted anchor row, for the same reason: the record survives
 * so the user can see what happened to it.
 */
export function orphanEmbeddedFormsForSheet(sheetIndex: number): boolean {
  let changed = false;
  for (const p of placements.values()) {
    if (p.sheetIndex !== sheetIndex || p.orphaned) continue;
    p.orphaned = true;
    changed = true;
  }
  if (changed) announce();
  return changed;
}

/** The user deleted the object. The ONE path that actually forgets a placement. */
export function removeEmbeddedFormPlacement(id: string): boolean {
  if (!placements.delete(id)) return false;
  announce();
  return true;
}

/**
 * Forget everything: THE WORKBOOK WAS REPLACED.
 *
 * Called from `installScriptEmbedHost`'s AFTER_OPEN / AFTER_NEW sweep
 * (`extensions/ScriptableObjects/lib/scriptEmbedHost.ts`, `forgetEveryPlacement`)
 * — and from nowhere else, deliberately: that sweep takes the surfaces down
 * BEFORE it calls this, because the announce below runs the renderer's reconcile
 * synchronously and a reconcile that finds a live surface without its placement
 * closes the session as "user", which FLUSHES the user's pending bound write
 * into whichever workbook is now underneath it. Read that comment before adding
 * a second caller.
 *
 * This is document scope, not lifetime: placements are session state (nothing
 * persists them), so the sweep is what makes "the boxes belong to that workbook"
 * true rather than merely intended.
 */
export function resetEmbeddedFormPlacements(): void {
  if (placements.size === 0) return;
  placements.clear();
  announce();
}

// ============================================================================
// Test support
// ============================================================================

/**
 * TEST-ONLY: make ids predictable. Production always mints with
 * `crypto.randomUUID`; passing null restores it.
 */
export function __setEmbeddedFormIdMinterForTests(minter: (() => string) | null): void {
  mintId = minter ?? ((): string => crypto.randomUUID());
}

/** TEST-ONLY: clear without announcing (the announce is itself under test). */
export function __resetEmbeddedFormPlacementsForTests(): void {
  placements.clear();
  mintId = (): string => crypto.randomUUID();
}
