//! FILENAME: app/extensions/Slicer/lib/slicerKeys.ts
// PURPOSE: The keyboard INSIDE a selected slicer (M8 S7; BUG-0258 design part
//          2, "Enter goes into a selected slicer and the arrow keys move
//          between items"). Before this a selected slicer lost every key: on
//          a worksheet an arrow moved the cell cursor and the selection change
//          deselected the slicer; on a canvas the arrows nudged it.
// CONTEXT: Calcula's choices, labelled as such (Excel's own route is Tab to
//          the item, Down, Enter, and Alt+C clears):
//
//            - Enter goes in only when exactly ONE object is selected and it
//              is a slicer (KD1). With several selected, Enter is left alone.
//            - Inside (KD3): the arrows, Home, End, PageUp and PageDown move a
//              focus ring between the items (row-major in grid layouts, as
//              painted: rendering/slicerRenderer.ts `slicerSlotStep`); Space
//              or Enter applies the focused item with the slicer's OWN click
//              rules (`clickSlicerItem`, the selection modes in
//              slicerClickSelection.ts); Ctrl toggles; Shift selects the run
//              from the item last applied to the focus as ONE queued commit
//              (`clickSlicerItemRun`, the drag's rule: Ctrl+Shift adds it);
//              on "Select all" Space clears the filter; Escape leaves and the
//              slicer stays selected. Alt+C clears the filter -- also without
//              going in -- only while the slicer filters (the timeline's rule:
//              with nothing to clear the key is not the slicer's). Tab is NOT
//              claimed: it goes on to the next object (a canvas) or cell (a
//              worksheet), and that selection change ends the focus.
//            - The focus is VIEW state (lib/slicerKeyFocus.ts, KD2).
//            - Every focus move and every filter change is announced through
//              the polite live region (@api/announce); a Shift run by its
//              extent ("North to West, 3 of 3 selected"). DOM focus never
//              moves: the grid keeps it, and Tab order is unchanged.
//
//          THE CELL BEHIND. On a WORKSHEET Core's active cell stays where it
//          was, hidden behind the slicer, and Core's own doors act on it: a
//          typed character (what a listbox user tries for type-ahead), F2 or
//          Backspace opened an edit there, Delete cleared it (the
//          dispatcher's Clear Contents, which runs before this listener),
//          Alt+Down opened its validation list -- all under the focus ring,
//          announced nowhere (M8 review, finding 1). So while the keyboard is
//          inside, the slicer CLAIMS the selection (@api/selectionOwner, the
//          floating grid's seam, FloatingRange/lib/frKeyRouting.ts): every
//          door that writes Core's selection refuses with one sentence, and
//          nothing of the slicer takes typing (`receivesTyping` false). Not on
//          a canvas: it has no cell to protect, and its own doors (object copy
//          and paste) stay the canvas's.
//
//          A FOCUS THAT LOST ITS GROUND -- a refresh that removed every item --
//          ends AT ONCE, announced ("Left <name>"): the store says when what it
//          holds changed (SlicerEvents.SLICER_DATA_CHANGED). Ending it lazily,
//          at the next key, left ownsKey claiming the arrow meanwhile, so on a
//          canvas that arrow was lost (M8 review, findings 4 and 9). A key that
//          still finds the focus stale (a change no refresh announced) ends it
//          the same way and is CONSUMED -- it was typed for the inside, never
//          for the cell behind -- except Tab, and Enter or Alt+C when they act
//          outside.
//
//          THE LISTENER. One WINDOW-CAPTURE keydown, installed for the
//          extension's life (`installSlicerKeys`, from index.ts activate). It
//          claims NOTHING until Enter has gone in -- except Alt+C on a single
//          selected, filtered slicer -- and it stands down, in this order, when:
//            1. the key is claimed by a surface stacked on the grid
//               (`isKeyClaimed`, core/lib/pointerClaims.ts);
//            2. `defaultPrevented`: the keybinding dispatcher (a window-capture
//               listener installed earlier, on the same target and phase)
//               already took it;
//            3. the target is an INPUT, a TEXTAREA or contentEditable;
//            4. a cell edit is live (`isCellEditInProgress`): Core's own, or
//               a floating grid's -- an EXTERNAL session, parked on another
//               sheet with the keyboard on the grid container -- whose Enter
//               commits the edit and is never the slicer's;
//            5. the grid is not focused (`isGridFocused`: a dialog, a task
//               pane, the ribbon, a menu that took focus);
//            6. a slicer content gesture is live (a held item drag owns
//               Escape: slicerItemDrag.ts);
//            7. the slicer's right-click menu is open (it listens on DOCUMENT
//               capture -- after this -- and its Escape is its own);
//            8. an object's grip menu is open (@api/objectPosition
//               `isObjectGripMenuOpen`; it listens on DOCUMENT capture too).
//          1-4 are the floating grid's gates (FloatingRange/index.ts
//          `handleFrKeyDown`, whose 4 pairs Core's edit with the range's OWN
//          editor -- here any external session counts, M8 S9 census pass), 5
//          the canvas bindings' (objectNudge.ts, objectCycling.ts).
//
//          Every key it claims gets preventDefault AND stopPropagation, EVEN
//          when the focus has nowhere to go (an arrow at the edge): the
//          grid's own keyboard listens on the focus container (bubble) and
//          would otherwise move the cell cursor -- the Charts CI-10 rule
//          (`handleChartNavKey`). stopPropagation does NOT stop another
//          listener on the same target and phase (the floating grid's, a
//          timeline's); those stand down on `defaultPrevented`.
//
//          On a canvas the dispatcher's Escape and arrow-nudge bindings run
//          BEFORE this listener; they stand down because the slicer's
//          object-selection provider owns 'Escape' and 'Arrow' while the focus
//          lives (slicerObjectSelection.ts `ownsKey`).
//
//          THE FOCUS ENDS on Escape; on any change that leaves the selection
//          other than exactly this one slicer (a deselect, another object
//          selected or added, Tab, a click on a cell, the slicer deleted:
//          every family's chokepoint notifies @api/objectSelection); on the
//          next pointer press on an object (`floatingObject:selected`,
//          `floatingObject:bodyDragStart`); on a RIGHT press anywhere but
//          this slicer (another object's menu -- a timeline's, a chart's --
//          or the grid's opens without changing the selection, and its keys
//          are then the menu's; M8 review, finding 7); on a sheet switch
//          (index.ts). A refresh that removes the focused item moves the
//          focus to the nearest item, or ends it -- at once -- when none is
//          left (`resolveSlicerFocusSlot`).

import { isKeyClaimed } from "@api/pointerClaims";
import { isCellEditInProgress } from "@api/editing";
import { isGridFocused } from "@api/keybindings";
import { announce } from "@api/announce";
import { requestOverlayRedraw } from "@api/gridOverlays";
import { getSelectedObjectRegions, onObjectSelectionChanged } from "@api/objectSelection";
import { isObjectGripMenuOpen } from "@api/objectPosition";
import { notifySelectionOwnershipChanged, registerSelectionOwner } from "@api/selectionOwner";
import { getGridStateSnapshot } from "@api/state";
import {
  clickSlicerClearFilter,
  clickSlicerItem,
  clickSlicerItemRun,
  getCachedItems,
  getSlicerById,
} from "./slicerStore";
import { SlicerEvents } from "./slicerEvents";
import { clientToSlicerCanvas, slicerAtCanvasPoint } from "./slicerCanvasGeometry";
import {
  setScrollOffset,
  slicerScrollToShow,
  slicerSlotStep,
  type SlicerFocusKey,
} from "../rendering/slicerRenderer";
import { isSlicerContentGestureActive } from "./slicerItemDrag";
import { isSlicerContextMenuOpen } from "../handlers/slicerContextMenu";
import { isSlicerSelected } from "../handlers/selectionHandler";
import { SLICER_REGION_TYPE, slicerIdOf } from "./slicerObjectSelection";
import {
  SLICER_SELECT_ALL_FOCUS,
  getSlicerKeyFocus,
  leaveSlicerKeyFocus,
  onSlicerKeyFocusChange,
  resetSlicerKeyFocus,
  resolveSlicerFocusSlot,
  setSlicerKeyFocus,
  type SlicerFocusValue,
  type SlicerKeyFocus,
} from "./slicerKeyFocus";
import type { Slicer, SlicerItem } from "./slicerTypes";

/** What Alt+C announces once the filter is clear. */
export const SLICER_FILTER_CLEARED_SENTENCE = "Filter cleared";

/** The id the keyboard's inside claims the selection under (@api/selectionOwner). */
export const SLICER_KEY_FOCUS_OWNER_ID = "slicerKeyFocus";

/** The ONE sentence every door refused while the keyboard is inside a slicer shows. */
export function slicerKeyFocusRefusal(action: string): string {
  return `${action} is not available while the keyboard is inside a slicer. Press Escape to leave it. Nothing was changed.`;
}

/**
 * The claim (see "THE CELL BEHIND" above): the keyboard is inside a slicer on
 * a WORKSHEET, whose active cell is hidden behind it. Asked by every door,
 * every time -- never cached.
 */
export function slicerKeyFocusOwnsSelection(): boolean {
  return getSlicerKeyFocus() !== null && getGridStateSnapshot()?.surface !== "canvas";
}

const FOCUS_KEYS: ReadonlySet<string> = new Set<SlicerFocusKey>([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

// ============================================================================
// Queries
// ============================================================================

/**
 * The id of the ONE selected object when it is a slicer (plan KD1) -- across
 * every family (a chart selected beside it makes two) -- or null.
 */
export function soleSelectedSlicerId(): string | null {
  const selected = getSelectedObjectRegions();
  if (selected.length !== 1 || selected[0].type !== SLICER_REGION_TYPE) return null;
  const id = slicerIdOf(selected[0]);
  return id !== null && isSlicerSelected(id) && getSlicerById(id) !== undefined ? id : null;
}

/** A slicer as the keyboard sees it: its items and its slots. */
interface SlicerSnapshot {
  slicer: Slicer;
  items: readonly SlicerItem[];
  /** 1 when "Select all" is shown (it is slot 0), else 0. */
  offset: number;
  /** Every slot: "Select all" and the items. */
  total: number;
  bounds: { width: number; height: number };
}

function snapshotOf(slicerId: string): SlicerSnapshot | null {
  const slicer = getSlicerById(slicerId);
  if (!slicer) return null;
  const items = getCachedItems(slicerId) ?? [];
  const offset = slicer.showSelectAll ? 1 : 0;
  return { slicer, items, offset, total: items.length + offset, bounds: { width: slicer.width, height: slicer.height } };
}

function valueAt(s: SlicerSnapshot, slot: number): SlicerFocusValue {
  return slot < s.offset ? SLICER_SELECT_ALL_FOCUS : s.items[slot - s.offset].value;
}

/**
 * What a screen reader hears for slot `slot`: "<item>, <n> of <total>,
 * selected" (or "not selected"; ", no data" when the slicer shows an item as
 * having none). "Select all" is selected while the slicer filters nothing.
 */
export function slicerSlotSentence(
  slicer: Pick<Slicer, "showSelectAll" | "selectedItems" | "indicateNoData">,
  items: readonly SlicerItem[],
  slot: number,
): string {
  const offset = slicer.showSelectAll ? 1 : 0;
  const total = items.length + offset;
  const position = `${slot + 1} of ${total}`;
  if (slot < offset) {
    return `Select all, ${position}, ${slicer.selectedItems === null ? "selected" : "not selected"}`;
  }
  const item = items[slot - offset];
  if (!item) return position;
  const noData = !item.hasData && slicer.indicateNoData ? ", no data" : "";
  return `${item.value}, ${position}, ${item.selected ? "selected" : "not selected"}${noData}`;
}

// ============================================================================
// The listener
// ============================================================================

function isTextTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el !== "object") return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true;
}

function isAltC(e: KeyboardEvent): boolean {
  return e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.code === "KeyC" || e.key === "c" || e.key === "C");
}

function isApplyKey(e: KeyboardEvent): boolean {
  return !e.altKey && (e.key === " " || e.key === "Spacebar" || e.key === "Enter");
}

/** The key is the slicer's: nothing else -- the grid's keyboard, the dispatcher's later passes -- acts on it. */
function consume(e: KeyboardEvent): void {
  e.preventDefault();
  e.stopPropagation();
}

/**
 * The window-capture keydown (see the header for the gates and the keys).
 * Exported for the unit tier; `installSlicerKeys` binds it.
 */
export function handleSlicerKeyDown(e: KeyboardEvent): void {
  if (isKeyClaimed(e)) return;
  if (e.defaultPrevented) return;
  if (isTextTarget(e.target)) return;
  if (isCellEditInProgress()) return;
  if (!isGridFocused()) return;
  if (isSlicerContentGestureActive()) return;
  if (isSlicerContextMenuOpen()) return;
  if (isObjectGripMenuOpen()) return;

  const focus = getSlicerKeyFocus();
  if (focus !== null) {
    if (soleSelectedSlicerId() === focus.slicerId) {
      keyInside(e, focus);
      return;
    }
    // The selection moved on without a notification reaching us: the focus
    // is stale, and the key is judged as if the keyboard were outside.
    leaveSlicerKeyFocus();
  }
  keyOutside(e);
}

/** Whether slicer `slicerId` filters anything: there is a filter for Alt+C to clear. */
function isSlicerFiltered(slicerId: string): boolean {
  const slicer = getSlicerById(slicerId);
  return slicer !== undefined && slicer.selectedItems !== null;
}

/** A modifier pressed on its own (the start of a combination): never the slicer's key. */
function isBareModifier(e: KeyboardEvent): boolean {
  return e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta" || e.key === "AltGraph";
}

/** Outside a slicer: only Enter (go in) and Alt+C (clear), on ONE selected slicer. */
function keyOutside(e: KeyboardEvent): void {
  if (isAltC(e)) {
    const id = soleSelectedSlicerId();
    // Nothing to clear: the key is not the slicer's (the timeline's rule).
    if (id === null || !isSlicerFiltered(id)) return;
    consume(e);
    clearFromKeyboard(id);
    return;
  }
  if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
  const id = soleSelectedSlicerId();
  if (id === null) return;
  if (!enterSlicer(id)) return;
  consume(e);
}

/**
 * The focus lost its ground and nothing ended it yet (a change no refresh
 * announced): end it, say so, and -- because this key was typed for the inside
 * -- let it reach nothing behind: Enter and Alt+C may still act outside (go in
 * again, clear); Tab moves on as always; every other key is consumed.
 */
function keyOnStaleFocus(e: KeyboardEvent, name: string | null): void {
  leaveSlicerKeyFocus();
  announce(`Left ${name ?? "the slicer"}`);
  if (e.key === "Tab") return;
  keyOutside(e);
  if (!e.defaultPrevented) consume(e);
}

/** Inside a slicer: move, apply, clear, leave. Every other key (Tab first) is not the slicer's. */
function keyInside(e: KeyboardEvent, focus: SlicerKeyFocus): void {
  if (isBareModifier(e)) return;
  const s = snapshotOf(focus.slicerId);
  const at = s ? resolveSlicerFocusSlot(focus, s.items.map((i) => i.value), s.offset > 0) : null;
  if (s === null || at === null) {
    // Nothing left to focus (the slicer lost every item, or is gone).
    keyOnStaleFocus(e, s?.slicer.name ?? null);
    return;
  }
  // A refresh that moved or removed the focused item: the focus follows the
  // value, or takes the nearest item (`resolveSlicerFocusSlot`).
  let current = focus;
  if (at.value !== focus.value || at.slot !== focus.slotHint) {
    current = { ...focus, value: at.value, slotHint: at.slot };
    setSlicerKeyFocus(current);
  }

  if (e.key === "Escape") {
    consume(e);
    leaveSlicerKeyFocus();
    announce(`Left ${s.slicer.name}`);
    return;
  }
  if (FOCUS_KEYS.has(e.key)) {
    // Consumed EVEN at the edge: the grid behind must never see the key.
    consume(e);
    moveFocus(s, current, at.slot, e.key as SlicerFocusKey);
    return;
  }
  if (isApplyKey(e)) {
    consume(e);
    // A held key repeats: one press applies once (a toggle must not flicker).
    if (e.repeat) return;
    applyFocused(s, current, at.slot, e.ctrlKey || e.metaKey, e.shiftKey);
    return;
  }
  if (isAltC(e) && s.slicer.selectedItems !== null) {
    consume(e);
    clearFromKeyboard(focus.slicerId);
  }
}

// ============================================================================
// What the keys do
// ============================================================================

/** Go into slicer `slicerId`: the first selected item when it filters, else the first slot. */
function enterSlicer(slicerId: string): boolean {
  const s = snapshotOf(slicerId);
  if (s === null || s.total === 0) return false;
  let slot = 0;
  if (s.slicer.selectedItems !== null) {
    const first = s.items.findIndex((i) => i.selected);
    if (first >= 0) slot = first + s.offset;
  }
  setSlicerKeyFocus({ slicerId, value: valueAt(s, slot), anchorValue: null, slotHint: slot });
  showSlot(s, slot);
  announce(`${s.slicer.name}: ${slicerSlotSentence(s.slicer, s.items, slot)}`);
  return true;
}

function moveFocus(s: SlicerSnapshot, focus: SlicerKeyFocus, from: number, key: SlicerFocusKey): void {
  const to = slicerSlotStep(s.slicer, s.items.length, s.bounds, from, key);
  if (to === from) return;
  setSlicerKeyFocus({ ...focus, value: valueAt(s, to), slotHint: to });
  showSlot(s, to);
  announce(slicerSlotSentence(s.slicer, s.items, to));
}

/** Scroll the items so slot `slot` shows, and repaint the ring. */
function showSlot(s: SlicerSnapshot, slot: number): void {
  setScrollOffset(s.slicer.id, slicerScrollToShow(s.slicer, s.items.length, s.bounds, slot));
  requestOverlayRedraw();
}

/**
 * The run from `anchor` to `to` in the order the keyboard swept it -- the
 * focused item LAST, as a drag's release item is (a 'single' slicer takes the
 * last one: `selectionAfterItemRun`). Just `to` when the anchor is gone.
 */
function runBetween(items: readonly SlicerItem[], anchor: string, to: string): string[] {
  const values = items.map((i) => i.value);
  const a = values.indexOf(anchor);
  const b = values.indexOf(to);
  if (a < 0 || b < 0) return [to];
  const run = values.slice(Math.min(a, b), Math.max(a, b) + 1);
  return b < a ? run.reverse() : run;
}

/**
 * Space / Enter on the focused slot -- the slicer's own click rules, ONE
 * queued commit -- and, once it has landed, the focused item's sentence.
 */
function applyFocused(s: SlicerSnapshot, focus: SlicerKeyFocus, slot: number, ctrl: boolean, shift: boolean): void {
  const slicerId = s.slicer.id;
  const value = valueAt(s, slot);
  let landed: Promise<void>;
  if (value === SLICER_SELECT_ALL_FOCUS) {
    landed = clickSlicerClearFilter(slicerId);
  } else if (shift) {
    const anchor = focus.anchorValue ?? value;
    if (focus.anchorValue === null) setSlicerKeyFocus({ ...focus, anchorValue: value });
    const run = runBetween(s.items, anchor, value);
    landed = clickSlicerItemRun(slicerId, run, ctrl);
    if (run.length > 1) {
      void landed.then(() => announceRun(slicerId, run));
      return;
    }
  } else {
    setSlicerKeyFocus({ ...focus, anchorValue: value });
    landed = clickSlicerItem(slicerId, value, ctrl);
  }
  void landed.then(() => announceFocused(slicerId));
}

/** The focused item's sentence, read AFTER a commit landed (its selected state is the new one). */
function announceFocused(slicerId: string): void {
  const focus = getSlicerKeyFocus();
  if (focus === null || focus.slicerId !== slicerId) return;
  const s = snapshotOf(slicerId);
  if (s === null) return;
  const at = resolveSlicerFocusSlot(focus, s.items.map((i) => i.value), s.offset > 0);
  if (at === null) return;
  announce(slicerSlotSentence(s.slicer, s.items, at.slot));
}

/**
 * A run's sentence, read AFTER it landed: its extent in DISPLAY order (however
 * the keys swept it) and how many of it ended up selected -- all of it, or one
 * for a 'single' slicer, which takes the run's last value. "North to West, 3 of
 * 3 selected". The timeline says the same of its ranges ("<first> to <last>
 * selected").
 */
function announceRun(slicerId: string, run: readonly string[]): void {
  const focus = getSlicerKeyFocus();
  if (focus === null || focus.slicerId !== slicerId) return;
  const s = snapshotOf(slicerId);
  if (s === null) return;
  const inRun = new Set(run);
  const shown = s.items.filter((i) => inRun.has(i.value));
  if (shown.length === 0) return;
  const selected = shown.filter((i) => i.selected).length;
  announce(`${shown[0].value} to ${shown[shown.length - 1].value}, ${selected} of ${shown.length} selected`);
}

/** Alt+C: clear the filter (queued like every user click), and say so once it is clear. */
function clearFromKeyboard(slicerId: string): void {
  void clickSlicerClearFilter(slicerId).then(() => {
    const slicer = getSlicerById(slicerId);
    if (slicer && slicer.selectedItems === null) announce(SLICER_FILTER_CLEARED_SENTENCE);
  });
}

// ============================================================================
// Installation
// ============================================================================

/**
 * The store re-read (SlicerEvents.SLICER_DATA_CHANGED): a focus with nothing
 * left to stand on -- every item gone, or the slicer -- ends NOW, announced,
 * so ownsKey stops claiming the arrows at the moment the ring disappears. A
 * focus whose item merely moved or went is left to `resolveSlicerFocusSlot`
 * (it follows the value, or takes the nearest item).
 */
function endIfStale(): void {
  const focus = getSlicerKeyFocus();
  if (focus === null) return;
  const s = snapshotOf(focus.slicerId);
  if (s !== null && resolveSlicerFocusSlot(focus, s.items.map((i) => i.value), s.offset > 0) !== null) return;
  leaveSlicerKeyFocus();
  // A slicer that is gone was deleted: its own route ended the focus first,
  // and there is no name to say.
  if (s !== null) announce(`Left ${s.slicer.name}`);
}

/**
 * A RIGHT press anywhere but the focused slicer ends the focus (M8 review,
 * finding 7). Another object's menu (a timeline's, a chart's) or the grid's
 * opens without changing the selection, and its keys are then the menu's --
 * the inside would take its Escape first (this listener runs before a
 * document-level menu). A right press ON the slicer keeps the keyboard
 * inside: its own menu takes the keys while it is open (gate 7). Window
 * capture, so no object's handler can stop it first; it reads the press and
 * prevents nothing. Bound only while the keyboard is inside a slicer
 * (`installSlicerKeys`): activate() itself binds no mousedown, and a press's
 * modifiers are never read here (slicerPressWiring.test.ts).
 */
function endOnForeignRightPress(e: MouseEvent): void {
  if (e.button !== 2) return;
  const focus = getSlicerKeyFocus();
  if (focus === null) return;
  const point = clientToSlicerCanvas(e.clientX, e.clientY);
  const under = point ? slicerAtCanvasPoint(point.x, point.y) : null;
  if (under?.id === focus.slicerId) return;
  leaveSlicerKeyFocus();
}

/**
 * Bind the keyboard for the extension's life: the window-capture keydown, the
 * claim on the selection while inside (a worksheet), the ends of the focus (a
 * pointer press on an object; a right press anywhere else; any selection
 * change that leaves something other than exactly the focused slicer
 * selected; a refresh that leaves it nothing) and the repaint of the ring.
 * Returns the cleanup, which also drops the focus and the claim.
 */
export function installSlicerKeys(): () => void {
  const endOnPress = (): void => {
    leaveSlicerKeyFocus();
  };
  // The right-press end lives exactly as long as the inner focus does.
  let rightPressBound = false;
  const bindRightPress = (inside: boolean): void => {
    if (inside === rightPressBound) return;
    rightPressBound = inside;
    if (inside) window.addEventListener("mousedown", endOnForeignRightPress, true);
    else window.removeEventListener("mousedown", endOnForeignRightPress, true);
  };
  window.addEventListener("keydown", handleSlicerKeyDown, true);
  window.addEventListener("floatingObject:selected", endOnPress);
  window.addEventListener("floatingObject:bodyDragStart", endOnPress);
  window.addEventListener(SlicerEvents.SLICER_DATA_CHANGED, endIfStale);
  const releaseClaim = registerSelectionOwner({
    id: SLICER_KEY_FOCUS_OWNER_ID,
    label: "a slicer's items",
    ownsSelection: slicerKeyFocusOwnsSelection,
    refusal: slicerKeyFocusRefusal,
    // Nothing of the slicer takes typing: a Ctrl+Alt character is read as the
    // shortcut it collides with, never typed into the hidden cell (W17).
    receivesTyping: () => false,
  });
  const offSelection = onObjectSelectionChanged(() => {
    const focus = getSlicerKeyFocus();
    if (focus !== null && soleSelectedSlicerId() !== focus.slicerId) leaveSlicerKeyFocus();
  });
  const offRepaint = onSlicerKeyFocusChange(() => {
    bindRightPress(getSlicerKeyFocus() !== null);
    requestOverlayRedraw();
    // Going in or leaving starts or ends the claim with no selection change:
    // a surface that follows the claim (a contextual tab) re-asks.
    notifySelectionOwnershipChanged();
  });
  return () => {
    window.removeEventListener("keydown", handleSlicerKeyDown, true);
    bindRightPress(false);
    window.removeEventListener("floatingObject:selected", endOnPress);
    window.removeEventListener("floatingObject:bodyDragStart", endOnPress);
    window.removeEventListener(SlicerEvents.SLICER_DATA_CHANGED, endIfStale);
    offSelection();
    offRepaint();
    resetSlicerKeyFocus();
    releaseClaim();
  };
}
