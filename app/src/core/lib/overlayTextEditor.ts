//! FILENAME: app/src/core/lib/overlayTextEditor.ts
// PURPOSE: THE in-place text editor over the grid canvas. One <textarea>
//          mounted into the canvas layer, repositioned every frame from a rect
//          the CALLER computes, committed or cancelled by the rules Excel uses.
//          Any surface stacked on the grid — a chart title, an object caption, a
//          floating cell — asks for one of these instead of building its own.
//
// CONTEXT: This is the generalisation of
//          `app/extensions/FloatingRange/editor/frEditor.ts`, which solved the
//          same problem once inside one extension. Charts cannot reuse that:
//          an extension may import only `@api`, and `@api` may never import an
//          extension. So the machinery moves to Core and both the DOM layer and
//          the traps below are stated ONCE. A second implementation is a second
//          set of these bugs.
//
// WHAT THE SEAM OWNS, AND WHY EACH ONE IS HERE RATHER THAN IN THE CALLER
// ----------------------------------------------------------------------
//  1. THE CANVAS LAYER. `[data-grid-canvas-layer]` is a DO-NOT-BREAK test
//     contract (Spreadsheet.tsx; `takeGridScreenshot` frames it, and
//     `owner-decisions.spec.ts` asserts there is exactly one). Five files
//     already re-type that selector. Callers of this seam do not: they get
//     {@link getGridCanvasLayer} or nothing at all.
//
//  2. THE POINTER CLAIM, WHICH IS NOT OPTIONAL. Core binds its pointer entry to
//     `S.GridArea`, an ANCESTOR of the canvas layer, so a `stopPropagation` on
//     this element claims nothing: the press bubbles into Core, which
//     `preventDefault()`s it and moves the cell cursor to the cell UNDER the
//     editor. The KEYBOARD is the same rule and is the worse half — the grid's
//     two key handlers stand down only for an `INPUT`/`TEXTAREA`/contenteditable
//     tag list (`useMouseSelection/layout/overlayMoveHandlers.ts`, the
//     `target.tagName === "INPUT" || ...` bail), and `api/keybindings.ts` is a
//     window-CAPTURE keydown that pre-empts every Core door and consults no tag
//     list at all. A `<textarea>` is on that list TODAY, which is exactly the
//     trap: the list is a census of the widgets that existed when it was
//     written, `<select>` was missing from it, and Delete inside an on-grid
//     dropdown cleared the user's cells. This seam therefore calls
//     {@link claimPointer} and never relies on its own tag name.
//
//  3. PER-FRAME LAYOUT. The rect is re-read every animation frame and written
//     as `logical px * zoom`, the `updateHtmlOverlay`/InlineEditor precedent.
//     Positioning once on open and listening for scroll/zoom/resize is the
//     version that drifts: there is no event for "a column above you was
//     resized", and every missed one leaves the editor over the wrong pixels.
//
//  4. THE BLUR RULES, which are where the shipped bugs were. See below.
//
// THE THREE TRAPS, COPIED FROM frEditor.ts WITH THEIR REASONS
// -----------------------------------------------------------
//  A. BLUR COMMITS LATE. A blur is not proof the user left: a reference pick
//     refocuses within the same interaction. The commit is deferred
//     {@link BLUR_COMMIT_DELAY_MS} and re-checks `document.activeElement` FIRST,
//     so a refocus needs no flag at all.
//
//  B. THE SUPPRESS FLAG IS BOUNDED. It used to latch. The picking click lands
//     inside the grid, where Core `preventDefault()`s the mousedown, so NO blur
//     is fired and the flag's only reader never runs to clear it; it then
//     survived until the user's next genuine focus departure — a click on the
//     ribbon — where it swallowed the commit for an edit that had nothing to do
//     with the pick, leaving the editor open over an uncommitted value. The
//     window only has to outlive the deferred blur, hence
//     {@link SUPPRESS_BLUR_MS} > {@link BLUR_COMMIT_DELAY_MS}.
//
//  C. TEARDOWN IS IDENTITY-CHECKED. A commit can run while a NEWER session has
//     already opened (a double-click on a second title). A teardown that clears
//     the module slot unconditionally kills the live editor and leaves a
//     `<textarea>` the user is typing into orphaned from every handler. Every
//     close path here compares the session object before touching shared state,
//     the same rule `registerExternalFormulaTarget` applies to its own slot.
//
// WHY A WINDOW MOUSEDOWN LISTENER EXISTS (and is in the census next door)
// ----------------------------------------------------------------------
// Trap B says it: a press on the grid is `preventDefault()`ed, so the editor
// never loses focus and NO blur fires. Without a listener above that
// preventDefault, "click outside to commit" — the only commit gesture a
// chart-title editor has, since Enter types a newline there — simply never
// happens. It is registered for the life of one session, ends only that
// session, and stands down while the session is expecting a formula reference,
// because that press is a PICK and not a departure.
//
// KNOWN CONSEQUENCE OF CLIPPING (inherited from frEditor, stated not hidden)
// --------------------------------------------------------------------------
// A session scrolled behind the headers or off the canvas is hidden with
// `display: none`, which drops focus, which fires the deferred blur, which
// COMMITS what the user has typed so far. Committing is the non-destructive
// direction — the text reaches the caller rather than vanishing — but it is a
// behaviour, not an accident.

import { claimPointer } from "./pointerClaims";
import {
  registerExternalFormulaTarget,
  type ExternalFormulaReference,
} from "./formulaEditTarget";
import { resolveHeaderSizes } from "./gridRenderer/layout/headerVisibility";
import { rangeToReference } from "./gridRenderer/references/conversion";
import { isFormulaExpectingReference } from "../types";
import { getGridStateSnapshot } from "../state/GridContext";
import { restoreFocusToGrid } from "../../api/events";

// ============================================================================
// Contract
// ============================================================================

/**
 * The DOM element the grid canvas and every layer stacked on it live in.
 *
 * `data-grid-canvas-layer` is a DO-NOT-BREAK test contract (see
 * Spreadsheet.tsx): it marks the grid MINUS its scrollbars, which is exactly
 * the box {@link OverlayTextEditorOptions.getRect} is measured in.
 */
export const GRID_CANVAS_LAYER_SELECTOR = "[data-grid-canvas-layer]";

/** Marks the editor element, for E2E and for keyboard guards. */
export const OVERLAY_TEXT_EDITOR_ATTR = "data-overlay-text-editor";

/**
 * How long a blur waits before it is believed.
 *
 * Long enough for the refocus that follows a reference pick, short enough that
 * a real departure feels immediate. The FR editor's number, unchanged.
 */
export const BLUR_COMMIT_DELAY_MS = 150;

/**
 * How long "the next blur is not a departure" survives.
 *
 * BOUNDED on purpose — see trap B in the header. It only has to outlive
 * {@link BLUR_COMMIT_DELAY_MS}.
 */
export const SUPPRESS_BLUR_MS = 400;

/**
 * Cell font when the caller names none: Excel's Calibri 11pt in LOGICAL px
 * (11 * 96/72), the same rule as InlineEditor's own fallback. Scaled by zoom at
 * layout time, never stored pre-scaled.
 */
export const DEFAULT_FONT_LOGICAL_PX = 11 * (96 / 72);

/** Font family used when the caller names none. */
export const DEFAULT_FONT_FAMILY = "Calibri, sans-serif";

/** A rectangle in LOGICAL (pre-zoom) px, measured from the canvas layer's
 *  top-left — the same space the overlay renderers draw in. */
export interface OverlayTextEditorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Type face for the editor. `sizePx` is LOGICAL px; zoom is applied here. */
export interface OverlayTextEditorFont {
  /** LOGICAL (pre-zoom) px. Defaults to {@link DEFAULT_FONT_LOGICAL_PX}. */
  sizePx?: number;
  family?: string;
  weight?: string | number;
  italic?: boolean;
  /** Text colour. Defaults to the grid's near-black. */
  color?: string;
}

export type OverlayTextAlign = "left" | "center" | "right";

export interface OverlayTextEditorOptions {
  /**
   * Where the editor belongs, in LOGICAL px from the canvas layer's top-left.
   * Called EVERY frame, so it must be cheap and must reflect the CURRENT
   * scroll/zoom/geometry. Return null to hide the editor without ending the
   * session (the owning object is off-screen, or is being dragged).
   */
  getRect(): OverlayTextEditorRect | null;
  /** Text the session opens with. Default "". */
  initialText?: string;
  /** Wrap and keep newlines. Forced on when {@link enterInserts} is true. */
  multiline?: boolean;
  font?: OverlayTextEditorFont;
  textAlign?: OverlayTextAlign;
  /** Editor background. Default opaque white, as Excel's in-place editors. */
  background?: string;
  /**
   * Excel's CHART-TITLE rule when true: Enter inserts a newline and the edit is
   * committed by clicking outside or pressing Escape. The CELL rule when false
   * (the default): Enter commits and Escape cancels.
   *
   * Note what this does to Escape: with `enterInserts` there is no cancelling
   * KEY, because Excel has none there. A caller that needs to discard such an
   * edit calls {@link OverlayTextEditorHandle.cancel} itself.
   */
  enterInserts?: boolean;
  /**
   * Open a formula-reference session: while the text is a formula whose cursor
   * expects a reference, a click on the grid inserts `Sheet1!A1` here instead
   * of moving the cell cursor. Routed through the ONE existing seam,
   * `registerExternalFormulaTarget`.
   */
  acceptsFormulaReferences?: boolean;
  /** Select the initial text instead of placing the caret at its end. */
  selectAll?: boolean;
  /** Free-form pointer-claim label, recorded so a stray claim can be traced. */
  owner?: string;
  /** The user finished the edit. Called exactly once per session, after close. */
  onCommit(text: string): void;
  /** The user discarded the edit. Called exactly once per session, after close. */
  onCancel(): void;
}

export interface OverlayTextEditorHandle {
  /** Monotonic id — every session gets a new one. */
  readonly sessionId: number;
  /** True while this session is the live one. */
  isOpen(): boolean;
  /** The current text, or "" once the session is over. */
  getText(): string;
  /** Replace the text (and place the caret at its end). No-op when closed. */
  setText(text: string): void;
  /** Put the caret back in the editor. No-op when closed. */
  focus(): void;
  /** Finish the edit: fires `onCommit`. No-op when closed. */
  commit(): void;
  /** Discard the edit: fires `onCancel`. No-op when closed. */
  cancel(): void;
  /** The mounted element while open, null once closed. */
  getElement(): HTMLTextAreaElement | null;
}

// ============================================================================
// Session state
// ============================================================================

interface Session {
  id: number;
  opts: OverlayTextEditorOptions;
  el: HTMLTextAreaElement;
  /** Set the moment a close path starts, so re-entrant handlers stand down. */
  closing: boolean;
  /** Set once the element and listeners are gone. */
  closed: boolean;
  frame: number | null;
  blurTimer: number | null;
  suppressBlur: boolean;
  suppressTimer: number | null;
  unregisterTarget: (() => void) | null;
  onKeyDown: (e: KeyboardEvent) => void;
  onBlur: () => void;
  onWindowMouseDown: (e: MouseEvent) => void;
}

/** At most ONE editor is live. Opening a second commits the first (Excel). */
let active: Session | null = null;
let nextSessionId = 1;

/** The canvas layer, or null when the grid is not mounted. */
export function getGridCanvasLayer(): HTMLElement | null {
  return document.querySelector<HTMLElement>(GRID_CANVAS_LAYER_SELECTOR);
}

/** True while any overlay text editor session is open. */
export function isOverlayTextEditorOpen(): boolean {
  return active !== null;
}

/** The live session's handle, or null. */
export function getActiveOverlayTextEditor(): OverlayTextEditorHandle | null {
  return active ? makeHandle(active) : null;
}

/** True when this element is the live editor (for keyboard guards). */
export function isOverlayTextEditorElement(el: EventTarget | null): boolean {
  return active !== null && el === active.el;
}

// ============================================================================
// Open
// ============================================================================

/**
 * Open an in-place text editor over the grid canvas.
 *
 * Synchronous: the element exists, is claimed, is positioned and has focus
 * before this returns, so the keystroke that opened it cannot be lost.
 *
 * Returns a handle even when the grid is not mounted; that handle reports
 * `isOpen() === false` and its callbacks never fire, because an editor nobody
 * can see must not silently collect text.
 */
export function openOverlayTextEditor(
  opts: OverlayTextEditorOptions,
): OverlayTextEditorHandle {
  const layer = getGridCanvasLayer();
  const id = nextSessionId++;

  if (!layer) return closedHandle(id);

  // Excel's rule for starting a second edit: the first one is FINISHED, not
  // thrown away. Done before the new element exists so the old session's
  // teardown cannot see the new one. BOUNDED, because an `onCommit` that opens
  // yet another editor would otherwise leave that one mounted and orphaned.
  for (let guard = 0; active !== null && guard < 8; guard++) commitSession(active);
  if (active !== null) teardownSession(active);

  const el = document.createElement("textarea");
  el.setAttribute(OVERLAY_TEXT_EDITOR_ATTR, "");
  el.rows = 1;
  el.spellcheck = false;
  el.value = opts.initialText ?? "";

  const multiline = opts.multiline === true || opts.enterInserts === true;
  el.style.position = "absolute";
  el.style.display = "none";
  el.style.margin = "0";
  el.style.padding = "0 3px";
  el.style.border = "1px solid #217346";
  el.style.borderRadius = "0";
  el.style.outline = "none";
  el.style.resize = "none";
  el.style.overflow = "hidden";
  el.style.whiteSpace = multiline ? "pre-wrap" : "pre";
  el.style.background = opts.background ?? "#ffffff";
  el.style.color = opts.font?.color ?? "#1a1a1a";
  el.style.textAlign = opts.textAlign ?? "left";
  el.style.boxSizing = "border-box";
  el.style.zIndex = "20";
  el.style.lineHeight = "normal";
  el.style.fontFamily = opts.font?.family ?? DEFAULT_FONT_FAMILY;
  el.style.fontWeight = String(opts.font?.weight ?? "normal");
  el.style.fontStyle = opts.font?.italic ? "italic" : "normal";

  // MANDATORY, and never the tag list: see point 2 in the header.
  claimPointer(el, opts.owner ?? "overlay-text-editor");

  const session: Session = {
    id,
    opts,
    el,
    closing: false,
    closed: false,
    frame: null,
    blurTimer: null,
    suppressBlur: false,
    suppressTimer: null,
    unregisterTarget: null,
    onKeyDown: () => undefined,
    onBlur: () => undefined,
    onWindowMouseDown: () => undefined,
  };

  session.onKeyDown = (e: KeyboardEvent) => handleKeyDown(session, e);
  session.onBlur = () => handleBlur(session);
  session.onWindowMouseDown = (e: MouseEvent) => handleWindowMouseDown(session, e);

  el.addEventListener("keydown", session.onKeyDown);
  el.addEventListener("blur", session.onBlur);
  // CAPTURE, on window: it has to run above the grid's own `preventDefault`,
  // which is the reason a blur never arrives for a press on the canvas.
  window.addEventListener("mousedown", session.onWindowMouseDown, true);

  layer.appendChild(el);
  active = session;

  if (opts.acceptsFormulaReferences === true) {
    session.unregisterTarget = registerExternalFormulaTarget({
      isExpectingReference: () => expectsReference(session),
      insertReference: (ref) => insertReference(session, ref),
    });
  }

  // Positioned BEFORE focus so the caret never appears at 0,0 for one frame.
  layoutSession(session);
  el.focus();
  if (opts.selectAll === true) {
    el.setSelectionRange(0, el.value.length);
  } else {
    el.setSelectionRange(el.value.length, el.value.length);
  }
  scheduleFrame(session);

  return makeHandle(session);
}

// ============================================================================
// Per-frame layout
// ============================================================================

function scheduleFrame(session: Session): void {
  if (typeof requestAnimationFrame !== "function") return;
  session.frame = requestAnimationFrame(() => {
    session.frame = null;
    // IDENTITY: a frame queued by a session that has since closed must not
    // paint over the live one, and must not re-queue itself forever.
    if (active !== session || session.closed) return;
    layoutSession(session);
    scheduleFrame(session);
  });
}

/**
 * The logical (pre-zoom) size of the canvas layer, or null when it cannot be
 * measured — jsdom and a not-yet-laid-out layer both report 0x0, and clipping
 * against a zero box would hide every editor in every unit test.
 */
function layerLogicalSize(
  el: HTMLElement,
  zoom: number,
): { width: number; height: number } | null {
  const host = el.parentElement;
  if (!host || typeof host.getBoundingClientRect !== "function") return null;
  const rect = host.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  return { width: rect.width / zoom, height: rect.height / zoom };
}

/**
 * Write this frame's geometry. Allocation-light: a handful of style writes.
 *
 * Clipped against the HEADER GUTTERS through `resolveHeaderSizes`, the one rule
 * that knows `View > Headings` collapses both to zero — reading
 * `config.rowHeaderWidth` directly is how 93 sites once agreed on a gutter the
 * product does not have.
 */
function layoutSession(session: Session): void {
  const { el } = session;
  const rect = session.opts.getRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    el.style.display = "none";
    return;
  }

  const state = getGridStateSnapshot();
  const zoom = state?.zoom || 1;
  const { rowHeaderWidth, colHeaderHeight } = state
    ? resolveHeaderSizes(state.config, state.displayHeadings)
    : { rowHeaderWidth: 0, colHeaderHeight: 0 };

  const bounds = layerLogicalSize(el, zoom);
  const visible =
    rect.x + rect.width > rowHeaderWidth &&
    rect.y + rect.height > colHeaderHeight &&
    (bounds === null || (rect.x < bounds.width && rect.y < bounds.height));

  if (!visible) {
    el.style.display = "none";
    return;
  }

  const fontPx = session.opts.font?.sizePx ?? DEFAULT_FONT_LOGICAL_PX;
  el.style.display = "block";
  el.style.left = `${rect.x * zoom}px`;
  el.style.top = `${rect.y * zoom}px`;
  el.style.width = `${rect.width * zoom}px`;
  el.style.height = `${rect.height * zoom}px`;
  el.style.fontSize = `${fontPx * zoom}px`;
}

// ============================================================================
// Formula references
// ============================================================================

function expectsReference(session: Session): boolean {
  if (active !== session || session.closing) return false;
  if (session.opts.acceptsFormulaReferences !== true) return false;
  const value = session.el.value;
  if (!value.startsWith("=")) return false;
  return isFormulaExpectingReference(
    value,
    session.el.selectionStart ?? value.length,
  );
}

function insertReference(session: Session, ref: ExternalFormulaReference): void {
  if (active !== session || session.closing) return;
  // `currentSheet` is null on purpose: this editor's text does not live in a
  // sheet's A1 space, so the reference is ALWAYS sheet-qualified.
  const text = rangeToReference(
    ref.startRow,
    ref.startCol,
    ref.endRow,
    ref.endCol,
    ref.sheetName,
    null,
  );
  insertTextAtCursor(session, text);
}

function insertTextAtCursor(session: Session, text: string): void {
  const el = session.el;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  const pos = start + text.length;
  // The click that picked the reference is about to blur (or already blurred)
  // this element — that blur must not commit a half-typed formula.
  suppressNextBlurCommit(session);
  el.focus();
  el.setSelectionRange(pos, pos);
}

function suppressNextBlurCommit(session: Session): void {
  session.suppressBlur = true;
  if (session.suppressTimer !== null) clearTimeout(session.suppressTimer);
  session.suppressTimer = window.setTimeout(() => {
    session.suppressTimer = null;
    session.suppressBlur = false;
  }, SUPPRESS_BLUR_MS);
}

function clearSuppressBlurCommit(session: Session): void {
  session.suppressBlur = false;
  if (session.suppressTimer !== null) {
    clearTimeout(session.suppressTimer);
    session.suppressTimer = null;
  }
}

// ============================================================================
// Event handlers
// ============================================================================

function handleKeyDown(session: Session, e: KeyboardEvent): void {
  if (active !== session || session.closing) return;

  // NOTHING typed in the editor may fall through to the grid. This does not
  // reach `api/keybindings.ts`, which listens in the window CAPTURE phase — the
  // pointer claim on the element is what stands that one down.
  e.stopPropagation();

  const enterInserts = session.opts.enterInserts === true;

  if (e.key === "Escape") {
    e.preventDefault();
    // Excel's chart-title rule: Escape LEAVES the title, keeping what was
    // typed. The cell rule discards. See `enterInserts`.
    if (enterInserts) commitSession(session);
    else cancelSession(session);
    return;
  }

  // Alt+Enter is a newline in every mode, as in the cell editor.
  if (e.key === "Enter" && !e.altKey) {
    if (enterInserts) return; // native: the textarea inserts the newline
    e.preventDefault();
    commitSession(session);
    return;
  }

  if (e.key === "Tab") {
    e.preventDefault();
    commitSession(session);
  }
}

function handleBlur(session: Session): void {
  if (active !== session || session.closing) return;
  if (session.blurTimer !== null) clearTimeout(session.blurTimer);
  session.blurTimer = window.setTimeout(() => {
    session.blurTimer = null;
    if (active !== session || session.closing) return;
    // FOCUS FIRST: a reference pick refocuses this element, so this alone
    // already covers the case the suppress flag was added for — and reaching it
    // first means the flag is not consumed by a blur that was never a
    // departure in the first place.
    if (document.activeElement === session.el) return;
    if (session.suppressBlur) {
      clearSuppressBlurCommit(session);
      return;
    }
    commitSession(session);
  }, BLUR_COMMIT_DELAY_MS);
}

function handleWindowMouseDown(session: Session, e: MouseEvent): void {
  if (active !== session || session.closing) return;
  const target = e.target as Node | null;
  if (target !== null && session.el.contains(target)) return;
  // A press on the grid while a reference is expected is a PICK, not a
  // departure: it is about to be routed into this very editor.
  if (expectsReference(session)) return;
  commitSession(session);
}

// ============================================================================
// Close paths — all identity-checked (trap C)
// ============================================================================

function teardownSession(session: Session): void {
  if (session.closed) return;
  session.closed = true;

  if (session.frame !== null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(session.frame);
  }
  session.frame = null;
  if (session.blurTimer !== null) {
    clearTimeout(session.blurTimer);
    session.blurTimer = null;
  }
  clearSuppressBlurCommit(session);

  // Already identity-checked inside the registry: a stale cleanup cannot clear
  // a newer session's slot.
  if (session.unregisterTarget) {
    session.unregisterTarget();
    session.unregisterTarget = null;
  }

  session.el.removeEventListener("keydown", session.onKeyDown);
  session.el.removeEventListener("blur", session.onBlur);
  window.removeEventListener("mousedown", session.onWindowMouseDown, true);
  session.el.remove();

  // THE identity check. A teardown from an older session must leave the live
  // one alone.
  if (active === session) active = null;
}

function commitSession(session: Session): void {
  if (active !== session || session.closing || session.closed) return;
  session.closing = true;
  const text = session.el.value;
  teardownSession(session);
  session.opts.onCommit(text);
  // A NEW session may have opened from inside onCommit; stealing its focus
  // would blur-commit it.
  if (active === null) restoreFocusToGrid();
}

function cancelSession(session: Session): void {
  if (active !== session || session.closing || session.closed) return;
  session.closing = true;
  teardownSession(session);
  session.opts.onCancel();
  if (active === null) restoreFocusToGrid();
}

// ============================================================================
// Handles
// ============================================================================

function makeHandle(session: Session): OverlayTextEditorHandle {
  return {
    sessionId: session.id,
    isOpen: () => active === session && !session.closed,
    getText: () => (session.closed ? "" : session.el.value),
    setText: (text: string) => {
      if (active !== session || session.closed) return;
      session.el.value = text;
      session.el.setSelectionRange(text.length, text.length);
    },
    focus: () => {
      if (active !== session || session.closed) return;
      session.el.focus();
    },
    commit: () => commitSession(session),
    cancel: () => cancelSession(session),
    getElement: () => (session.closed ? null : session.el),
  };
}

/** The handle returned when there is no canvas layer to mount into. */
function closedHandle(id: number): OverlayTextEditorHandle {
  return {
    sessionId: id,
    isOpen: () => false,
    getText: () => "",
    setText: () => undefined,
    focus: () => undefined,
    commit: () => undefined,
    cancel: () => undefined,
    getElement: () => null,
  };
}
