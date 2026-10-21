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
// CELL TARGETS (P3, owner finding G3). A claim could only REFUSE: it could not
//   say "act on MY cells instead". An owner may now answer `cellTarget()` (the
//   cells it holds) and declare the capability KINDS a door may act on through
//   it (`actsOn`). A door that supports targets asks
//   `resolveCellTarget(action, capability)` instead of `refuseIfSelectionOwned`:
//   no owner -> the GRID target (Core's selection); an owner that admits the
//   capability and answers -> the OBJECT target; otherwise refused, announced
//   once, null. A door that has no target support keeps asking
//   `refuseIfSelectionOwned` -- that question is unchanged.
//
// NOTE: A Core primitive with no RUNTIME imports (type-only ones). It reads
// neither the DOM nor the grid state: Core registers its selection reader
// (`setGridSelectionReader`) and its editor opener (`setGridCellEditorOpener`).

import type { CellTargetRef, Selection } from "../types";

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

/**
 * A KIND of cell act a door performs through a cell target. An owner lists the
 * kinds it admits (`SelectionOwner.actsOn`) -- kinds, never door ids, so a new
 * door of a known kind needs nothing from the owner.
 */
export type CellTargetCapability =
  | "read" // Copy, ribbon state, Format Cells seed, Find, Go To Special
  | "format" // font/fill/borders/alignment/wrap/indent/orientation/cell styles/Lock Cell/Format Painter dest/super-subscript
  | "numberFormat" // Number group incl. Increase/Decrease Decimal
  | "content" // paste, fill, AutoSum, Insert Function, Fill Series, Flash Fill, Replace
  | "clear" // Clear menu + Delete
  | "sort"
  | "structure" // insert/delete sheet rows/cols (table semantics)
  | "shiftCells" // Insert/Delete Cells with a shift -- no owner admits it this round
  | "lineSize" // row height/column width/AutoFit/hide/unhide
  | "merge"
  | "conditionalFormat"
  | "table" // Format as Table -- no owner admits it
  | "filter"; // AutoFilter -- no owner admits it

/** Every capability, once (tests and censuses iterate it). */
export const CELL_TARGET_CAPABILITIES: readonly CellTargetCapability[] = [
  "read",
  "format",
  "numberFormat",
  "content",
  "clear",
  "sort",
  "structure",
  "shiftCells",
  "lineSize",
  "merge",
  "conditionalFormat",
  "table",
  "filter",
];

/**
 * The capabilities a WHOLE-OBJECT selection (the object selected, not a cell
 * of it) admits: formatting the whole window, as Excel formats every cell of a
 * selected range. Everything else needs cells.
 */
export const WHOLE_OBJECT_CAPABILITIES: readonly CellTargetCapability[] = [
  "format",
  "numberFormat",
  "conditionalFormat",
  "read",
];

/** The cells an owner holds (`SelectionOwner.cellTarget`). */
export interface OwnedCellTarget {
  /** What the backend resolves (sent as `opts.target` on a wrapper). */
  ref: CellTargetRef;
  /** Local coords == backing coords; activeRow/activeCol set; additionalRanges for multi-area. */
  selection: Selection;
  /** The write extent (rows x cols), the content extent the owner scrolls over. */
  bounds: { rows: number; cols: number };
  /** The object's own name ("Float1"), for sentences and Paste Link. */
  label: string;
  /** The OBJECT is selected, not a cell: selection = the whole window, active = (0,0). */
  wholeObject: boolean;
}

/**
 * What a door acts on. `grid`: Core's selection on the active sheet (null when
 * Core has not reported one -- the door then does what it did with no
 * selection). `object`: an owner's cells; `ownerId` names the owner that
 * answered, so `selectTargetCells` / `editTargetCell` reach the same one.
 */
export type CellTarget =
  | { kind: "grid"; selection: Selection | null }
  | ({ kind: "object"; ownerId: string } & OwnedCellTarget);

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
  /**
   * The sentence a refused door shows, given the action's name ("Bold").
   * `capability`: the kind of act a target-aware door asked for, so an owner
   * can explain WHY ("table" / "filter": the object cannot hold the concept).
   * `reason` "wholeObject": the owner admits the capability but the OBJECT,
   * not a cell, is selected -- the sentence should ask for cells.
   */
  refusal?: (action: string, capability?: CellTargetCapability, reason?: "wholeObject") => string;
  /**
   * The cells this owner holds, or null. Asked only while it owns the
   * selection, at the moment a target-aware door acts. A throw or a null is a
   * refusal: a door never falls through to Core's hidden cell.
   */
  cellTarget?: () => OwnedCellTarget | null;
  /**
   * The capability KINDS a door may act on through `cellTarget` (never door
   * ids). Absent or empty: every target-aware door refuses, as before.
   */
  actsOn?: readonly CellTargetCapability[];
  /** Replace the owner's own selection (Find, Go To Special, a paste result). */
  selectCells?: (selection: Selection) => void;
  /**
   * Open the owner's own in-cell editor on its active cell with `text`
   * (Insert Function, AutoSum's single-cell guess). False: it did not open.
   */
  editActiveCell?: (text: string) => boolean;
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
function sentenceOf(owner: SelectionOwner, action: string, capability?: CellTargetCapability): string {
  if (owner.refusal) {
    try {
      const sentence = capability === undefined ? owner.refusal(action) : owner.refusal(action, capability);
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
  announceRefusal(owner, sentenceOf(owner, action));
  return true;
}

/** Announce `sentence` once for `owner` (unless it asked for silence). */
function announceRefusal(owner: SelectionOwner, sentence: string): void {
  if (!announces(owner, sentence)) return;
  if (announcer) {
    try {
      announcer(sentence);
    } catch (err) {
      console.error("[selectionOwner] announcer threw:", err);
    }
  } else {
    console.warn(`[selectionOwner] ${sentence}`);
  }
}

/** Wire where refusals are announced (@api does, to the toast). Null unwires. */
export function setSelectionRefusalAnnouncer(fn: ((message: string) => void) | null): void {
  announcer = fn;
}

// ============================================================================
// Cell targets: the door's NEW question
// ============================================================================

/** Core's selection, as Core last reported it (registered by the Spreadsheet). */
let gridSelectionReader: (() => Selection | null) | null = null;

/** Opens Core's in-cell editor on its active cell with a text (registered by Core). */
let gridCellEditorOpener: ((text: string) => boolean) | null = null;
let gridCellTextCommitter: ((text: string) => Promise<boolean>) | null = null;

/**
 * Core registers its selection reader here: a lib cannot read React state, so
 * the Spreadsheet component hands it over where it already feeds
 * `gridCommands.setSelection`. Null unregisters.
 */
export function setGridSelectionReader(read: (() => Selection | null) | null): void {
  gridSelectionReader = read;
}

/** Core's selection right now (null when no reader is registered or it threw). */
export function readGridSelection(): Selection | null {
  if (!gridSelectionReader) return null;
  try {
    return gridSelectionReader() ?? null;
  } catch (err) {
    console.error("[selectionOwner] the grid selection reader threw:", err);
    return null;
  }
}

/**
 * Core registers how its own in-cell editor opens on the active cell with a
 * text (Insert Function's "=", AutoSum's guess). Null unregisters.
 */
export function setGridCellEditorOpener(open: ((text: string) => boolean) | null): void {
  gridCellEditorOpener = open;
}

/**
 * Core registers how a text is ENTERED into the active cell exactly as if the
 * user had typed it and pressed Enter: the editor opens with the text and
 * commits, so every commit guard runs. Null unregisters.
 *
 * The Delete key uses it for a cell whose range guard admits a one-cell EDIT
 * but refuses a bulk write (a writeback cell collects one answer at a time):
 * clearing it as an edit lets the owner's commit guard record the cleared
 * value, where a bulk clear would be refused by the backend.
 */
export function setGridCellTextCommitter(commit: ((text: string) => Promise<boolean>) | null): void {
  gridCellTextCommitter = commit;
}

/**
 * Enter `text` into the active cell through Core's editor and commit it. Resolves
 * false when no committer is registered, the edit was refused or it threw.
 */
export async function commitGridCellText(text: string): Promise<boolean> {
  if (!gridCellTextCommitter) return false;
  try {
    return (await gridCellTextCommitter(text)) === true;
  } catch (err) {
    console.error("[selectionOwner] the grid cell text committer threw:", err);
    return false;
  }
}

/** Open Core's editor with `text` (false when none is registered, it refused or threw). */
export function openGridCellEditor(text: string): boolean {
  if (!gridCellEditorOpener) return false;
  try {
    return gridCellEditorOpener(text) === true;
  } catch (err) {
    console.error("[selectionOwner] the grid cell editor opener threw:", err);
    return false;
  }
}

/** The owner registered under `id` (a target's `ownerId`), or null. */
export function getSelectionOwnerById(id: string): SelectionOwner | null {
  return owners.get(id) ?? null;
}

/** The sentence when the owner admits the act but its OBJECT, not a cell, is selected. */
export function defaultWholeObjectRefusal(action: string, label: string): string {
  return `${action} needs cells: select cells inside ${label} first. Nothing was changed.`;
}

/** Whether `owner` declares `capability` in `actsOn`. */
function actsOnCapability(owner: SelectionOwner, capability: CellTargetCapability): boolean {
  return Array.isArray(owner.actsOn) && owner.actsOn.includes(capability);
}

/** A structurally sound answer from `cellTarget` (a malformed one is a refusal). */
function isOwnedCellTarget(value: unknown): value is OwnedCellTarget {
  if (value === null || typeof value !== "object") return false;
  const t = value as { ref?: unknown; selection?: unknown; bounds?: unknown };
  if (t.ref === null || typeof t.ref !== "object") return false;
  const ref = t.ref as { kind?: unknown; id?: unknown };
  return (
    typeof ref.kind === "string" &&
    typeof ref.id === "string" &&
    ref.id !== "" &&
    t.selection !== null &&
    typeof t.selection === "object" &&
    t.bounds !== null &&
    typeof t.bounds === "object"
  );
}

type TargetAnswer = { target: CellTarget } | { refusal: string; owner: SelectionOwner };

/** The whole-object sentence: the owner's own, else the default. */
function wholeObjectSentence(owner: SelectionOwner, action: string, capability: CellTargetCapability, label: string): string {
  if (owner.refusal) {
    try {
      const own = owner.refusal(action, capability, "wholeObject");
      if (typeof own === "string" && own.trim() !== "") return own;
    } catch (err) {
      console.error(`[selectionOwner] '${owner.id}' refusal threw; using the default sentence:`, err);
    }
  }
  return defaultWholeObjectRefusal(action, label);
}

/** The one decision behind `resolveCellTarget` and `cellTargetFor`. */
function decideCellTarget(action: string, capability: CellTargetCapability): TargetAnswer {
  // Asked with NO door kind: a kind is for refuse-only doors (objectInsert),
  // and the objectInsertDoorCensus scanner must see no new kind-passing call.
  const owner = getSelectionOwner();
  if (owner === null) return { target: { kind: "grid", selection: readGridSelection() } };
  if (!actsOnCapability(owner, capability) || !owner.cellTarget) {
    return { refusal: sentenceOf(owner, action, capability), owner };
  }
  let owned: OwnedCellTarget | null = null;
  try {
    const answer = owner.cellTarget();
    if (isOwnedCellTarget(answer)) owned = answer;
    else if (answer != null) console.error(`[selectionOwner] '${owner.id}' cellTarget returned a malformed target; refusing.`);
  } catch (err) {
    console.error(`[selectionOwner] '${owner.id}' cellTarget threw; refusing:`, err);
  }
  // The owner holds the selection but names no cells: refused -- NEVER the
  // hidden Core cell under the object (BUG-0185).
  if (owned === null) return { refusal: sentenceOf(owner, action, capability), owner };
  if (owned.wholeObject === true && !WHOLE_OBJECT_CAPABILITIES.includes(capability)) {
    return { refusal: wholeObjectSentence(owner, action, capability, owned.label || owner.label), owner };
  }
  return { target: { kind: "object", ownerId: owner.id, ...owned } };
}

/**
 * THE DOOR'S NEW QUESTION, for a door that can act on an object's cells.
 * No owner: the grid target (Core's selection, from the registered reader).
 * An owner that lists `capability` in `actsOn` and answers `cellTarget()`:
 * the object target. Otherwise: refused, announced ONCE with
 * `refusal(action, capability)` (or silently, `shouldAnnounce`), and null --
 * the caller returns without writing. A whole-object selection is admitted
 * only for "format" | "numberFormat" | "conditionalFormat" | "read".
 */
export function resolveCellTarget(action: string, capability: CellTargetCapability): CellTarget | null {
  const answer = decideCellTarget(action, capability);
  if ("target" in answer) return answer.target;
  announceRefusal(answer.owner, answer.refusal);
  return null;
}

/**
 * The same answer as `resolveCellTarget` WITHOUT announcing (ribbon state,
 * enablement). A refusal comes back as `{ refusal: sentence }`; `action`
 * names the act in that sentence.
 */
export function cellTargetFor(capability: CellTargetCapability, action = "This command"): CellTarget | { refusal: string } {
  const answer = decideCellTarget(action, capability);
  return "target" in answer ? answer.target : { refusal: answer.refusal };
}
