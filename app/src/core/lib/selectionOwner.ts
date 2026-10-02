//! FILENAME: app/src/core/lib/selectionOwner.ts
// PURPOSE: The ONE store of "something other than Core's grid owns the
//          selection" -- and the one question every door that acts on Core's
//          selection asks before it writes.
// CONTEXT: BUG-0185. A floating grid's cell can be selected on a WORKSHEET
//          while Core's own selection stays where it was (say Sheet1!A1), out
//          of sight under the floating grid. Keys and grid commands were
//          refused one by one, but every formatting DOOR -- the Home tab's
//          buttons and pickers, Format Cells, the Format menu's cell styles,
//          the mini toolbar, Format Painter, Paste Special, Conditional
//          Formatting -- read Core's selection itself and wrote to it: Bold on
//          the ribbon turned the HIDDEN cell bold. There was no single choke
//          point to refuse at, so this is it.
//
// THE SEAM, FEATURE-NEUTRAL. An owner (a floating grid today) registers a
//   predicate that says whether it holds the selection RIGHT NOW. It is asked
//   at the moment a door acts, never cached, so a claim cannot outlive the
//   selection it describes. Core never learns what kind of object the owner
//   is; the owner supplies the sentence the refusal shows.
//
// THE DOORS ask `refuseIfSelectionOwned(action)`: true means "refused, and the
//   user has been told once" -- the door returns without writing. The
//   announcer is registered by @api (api/selectionOwner.ts wires it to the
//   toast) because Core cannot import the API layer; without one the refusal
//   still refuses and says so on the console.
//
// NOTE: A Core primitive with NO imports. It reads neither the DOM nor the
// grid state.

/**
 * A KIND of door a claim may let through (`SelectionOwner.admits`). A door of
 * a kind passes it as `refuseIfSelectionOwned(action, kind)`; a door that
 * passes no kind is asked by every owner, as before.
 *
 *   "objectInsert" -- a door that ADDS a new floating object at Core's active
 *     cell and writes no cell: Insert Shape, Insert > Controls > Button and
 *     Insert Image. Excel inserts a shape, a form button or a picture while a
 *     slicer or a shape is selected (owner call 25, 2026-10-02), so the
 *     generic "an object is selected" claim (BUG-0270) admits it; a floating
 *     grid's selected CELL (wave-B B8) does not.
 */
export type SelectionDoorKind = "objectInsert";

/** Something that can hold the selection instead of Core's grid. */
export interface SelectionOwner {
  /** Stable id ("floatingRange"). Re-registering an id replaces the owner. */
  id: string;
  /**
   * What holds the selection, as the refusal names it ("a floating grid's
   * cells"). Used by the default sentence when `refusal` is absent.
   */
  label: string;
  /**
   * Whether this owner holds the selection right now. Asked at every door,
   * every time. A throw counts as "does not": a broken extension must not be
   * able to take formatting away from the whole app by failing.
   */
  ownsSelection: () => boolean;
  /** The sentence a refused door shows, given the action's name ("Bold"). */
  refusal?: (action: string) => string;
  /**
   * Whether a character typed right now lands in the OWNER's own cell -- its
   * own type-to-edit takes it (a floating grid with one of its CELLS
   * selected). Asked only while the owner claims the selection. Absent,
   * false, or a throw: nothing of the owner's takes typing (a floating grid
   * selected as a whole OBJECT). Core's cell is hidden while the claim lasts
   * and its type-to-edit refuses, so no cell would receive the character --
   * and the keybinding dispatcher then reads a Ctrl+Alt character as the
   * shortcut it collides with rather than as typing (W17, review C).
   */
  receivesTyping?: () => boolean;
  /**
   * A claim that stands BEHIND every other owner: asked only when no
   * non-fallback owner holds the selection. For a GENERIC claim ("an object is
   * selected", BUG-0270) that must never speak over a specific one -- a
   * floating grid's selected cell (whose own cell takes typing) or the
   * keyboard inside a slicer (its own sentence) each speak for their own
   * object. Without it, registration order -- an accident of the extension
   * manifest -- would decide. Absent or false: an ordinary owner. Between two
   * fallbacks, registration order decides.
   */
  fallback?: boolean;
  /**
   * Whether a refusal with `sentence` -- the exact text the door would show
   * -- is ANNOUNCED. Asked only by `refuseIfSelectionOwned`, only while this
   * owner holds the selection. False: the door STILL refuses (nothing reaches
   * the cell), it only says nothing -- for an owner that has already said it
   * (the generic "an object is selected" claim says each sentence once while
   * the same object stays selected: typing a word is one toast, not one per
   * character, BUG-0270 review). Absent, true, or a throw: announced.
   */
  shouldAnnounce?: (sentence: string) => boolean;
  /**
   * The door KINDS this claim does not stand in front of
   * (`SelectionDoorKind`): a door asking as one of them is not refused by
   * THIS owner -- it is skipped, and any other owner holding the selection
   * still answers. Every door that passes no kind, and every other kind, is
   * refused as before. Absent or empty: the claim stands in front of every
   * door.
   */
  admits?: readonly SelectionDoorKind[];
}

const owners = new Map<string, SelectionOwner>();

/** Where a refusal is announced (the toast, wired by @api). */
let announcer: ((message: string) => void) | null = null;

/**
 * Register an owner. Returns the unregister function (it removes THIS owner
 * only, so a stale cleanup cannot take a newer registration with it).
 */
export function registerSelectionOwner(owner: SelectionOwner): () => void {
  owners.set(owner.id, owner);
  return () => {
    if (owners.get(owner.id) === owner) owners.delete(owner.id);
  };
}

function owns(owner: SelectionOwner): boolean {
  try {
    return owner.ownsSelection() === true;
  } catch (err) {
    console.error(`[selectionOwner] '${owner.id}' ownsSelection threw; treating as not owning:`, err);
    return false;
  }
}

/** Whether `owner` lets a door of `door` kind through (`SelectionOwner.admits`). */
function admitsDoor(owner: SelectionOwner, door: SelectionDoorKind | undefined): boolean {
  return door !== undefined && Array.isArray(owner.admits) && owner.admits.includes(door);
}

/**
 * The owner holding the selection right now, or null when Core's grid does.
 * Two passes: every ordinary owner first (registration order), then the
 * FALLBACK owners (`SelectionOwner.fallback`), so a generic claim can never
 * speak over a specific one. Asked FOR a door kind (`door`), an owner that
 * admits that kind is skipped (`SelectionOwner.admits`): null then means the
 * door may act.
 */
export function getSelectionOwner(door?: SelectionDoorKind): SelectionOwner | null {
  for (const owner of owners.values()) {
    if (owner.fallback !== true && !admitsDoor(owner, door) && owns(owner)) return owner;
  }
  for (const owner of owners.values()) {
    if (owner.fallback === true && !admitsDoor(owner, door) && owns(owner)) return owner;
  }
  return null;
}

/** Whether anything other than Core's grid holds the selection right now. */
export function isSelectionOwned(): boolean {
  return getSelectionOwner() !== null;
}

/**
 * Whether the owner holding the selection right now takes a typed character
 * in its OWN cell (`SelectionOwner.receivesTyping`). False when Core's grid
 * holds the selection (ask the grid, not this), when the owner declares no
 * such cell, and when its answer throws.
 */
export function selectionOwnerReceivesTyping(): boolean {
  const owner = getSelectionOwner();
  if (owner === null || !owner.receivesTyping) return false;
  try {
    return owner.receivesTyping() === true;
  } catch (err) {
    console.error(`[selectionOwner] '${owner.id}' receivesTyping threw; treating as taking no typing:`, err);
    return false;
  }
}

/** The generic sentence, for an owner that supplies none. */
export function defaultSelectionRefusal(action: string, label: string): string {
  return (
    `${action} was not applied: the selection belongs to ${label}, so it would change a ` +
    "sheet cell you cannot see. Click a cell of the sheet first. Nothing was changed."
  );
}

/** `owner`'s sentence for a refused `action` (its own, else the default). */
function sentenceOf(owner: SelectionOwner, action: string): string {
  if (owner.refusal) {
    try {
      const sentence = owner.refusal(action);
      if (typeof sentence === "string" && sentence.trim() !== "") return sentence;
    } catch (err) {
      console.error(`[selectionOwner] '${owner.id}' refusal threw; using the default sentence:`, err);
    }
  }
  return defaultSelectionRefusal(action, owner.label);
}

/**
 * The sentence a door refused for `action` would show, or null when Core's
 * grid holds the selection and the door may act. `door`: the door's kind, as
 * for `refuseIfSelectionOwned`. Announces nothing.
 */
export function selectionRefusalFor(action: string, door?: SelectionDoorKind): string | null {
  const owner = getSelectionOwner(door);
  return owner === null ? null : sentenceOf(owner, action);
}

/** Whether `owner` wants `sentence` announced (`SelectionOwner.shouldAnnounce`). */
function announces(owner: SelectionOwner, sentence: string): boolean {
  if (!owner.shouldAnnounce) return true;
  try {
    return owner.shouldAnnounce(sentence) !== false;
  } catch (err) {
    console.error(`[selectionOwner] '${owner.id}' shouldAnnounce threw; announcing:`, err);
    return true;
  }
}

/**
 * THE DOOR'S QUESTION. True when the selection is owned: the refusal has been
 * announced ONCE (or the owner said it already: `SelectionOwner.shouldAnnounce`)
 * and the caller must return without writing. False when Core's grid holds
 * the selection and the door may act. `door`: the door's KIND, for a door an
 * owner may let through (`SelectionDoorKind`, `SelectionOwner.admits`); a door
 * that passes none is asked by every owner.
 */
export function refuseIfSelectionOwned(action: string, door?: SelectionDoorKind): boolean {
  const owner = getSelectionOwner(door);
  if (owner === null) return false;
  const sentence = sentenceOf(owner, action);
  if (!announces(owner, sentence)) return true;
  if (announcer) {
    try {
      announcer(sentence);
    } catch (err) {
      console.error("[selectionOwner] announcer threw:", err);
    }
  } else {
    console.warn(`[selectionOwner] ${sentence}`);
  }
  return true;
}

/** Wire where refusals are announced (@api does, to the toast). Null unwires. */
export function setSelectionRefusalAnnouncer(fn: ((message: string) => void) | null): void {
  announcer = fn;
}
