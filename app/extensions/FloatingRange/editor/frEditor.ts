//! FILENAME: app/extensions/FloatingRange/editor/frEditor.ts
// PURPOSE: The extension-owned DOM cell editor for floating-range cells: one
//          absolutely positioned <textarea> over the canvas, repositioned every
//          overlay render frame (scroll/zoom drift impossible — the
//          updateHtmlOverlay precedent), with formula autocomplete and an
//          external-formula-target session for grid click-picking.
// CONTEXT: Chosen over reviving @api/cellEditors / extending InlineEditor —
//          EditingCell has no container id and commitEdit is the densest code
//          in the app (see planFrontend §3). Commit goes through
//          update_floating_range_cell (undoable backend-side); the editor
//          records nothing itself.
//
// ONE EDIT, TWO VIEWS (2026-09-27, owner findings #9/#10). The edit is a
//          SESSION (`ExternalEditSession`, @api/externalEdit) registered in
//          Core's one external-edit slot. The textarea is one view of it; the
//          FORMULA BAR is the other: it shows the same text, types into it,
//          commits and cancels it, and hosts it alone while the edit is PARKED
//          (a formula picking a reference on another sheet, where this
//          range's textarea cannot be shown). `view` says which of the two
//          owns the caret; only a FOCUS changes it. A bar-begun edit
//          (`openFrEditor(..., { focus: false, view: "bar" })`) never takes
//          focus from the bar. Every session method is token-checked, so a
//          session object the shell still holds after its edit ended can
//          never write into a newer one.
//
// V1 PARITY GAPS (accepted, documented): no F4 abs/rel toggle and no arrow-key
//          reference navigation inside the IN-CELL view (the bar view has F4).

import type { OverlayRenderContext } from "@api/gridOverlays";
import {
  overlayGetRowHeaderWidth,
  overlayGetColHeaderHeight,
  requestOverlayRedraw,
} from "@api/gridOverlays";
import { isFormulaExpectingReference, showToast } from "@api";
import {
  AutocompleteEvents,
  isFormulaAutocompleteVisible,
  type AutocompleteAcceptedPayload,
} from "@api/formulaAutocomplete";
import { restoreFocusToGrid } from "@api/events";
import { getGridStateSnapshot } from "@api/grid";
import { registerExternalFormulaTarget } from "@api/editing";
import {
  notifyExternalEditChanged,
  isExternalSessionParked,
  isFormulaBarElement,
  type ExternalEditMove,
  type ExternalEditSession,
  type ExternalEditView,
} from "@api/externalEdit";
import {
  updateFloatingRangeCell,
  getFloatingRangeCells,
} from "@api/floatingRanges";
import {
  getFloatingRangeById,
  type FloatingRangeEntry,
} from "../lib/floatingRangeStore";
import {
  localCellOrigin,
  frColWidth,
  frRowHeight,
  frRowHdrW,
  frCellsTop,
  contentWidth,
  contentHeight,
  type FrView,
} from "../lib/frDimensions";
import { getLocalSelection, moveLocalSelection } from "../lib/frSelection";
import { setFrEditingRange } from "../lib/frEditingRange";
import { invalidateFrCache } from "../rendering/frRenderer";
import { buildQualifiedRef } from "../lib/frRefs";
import { getFrView, ensureFrCellVisible } from "../lib/frView";

// ============================================================================
// State
// ============================================================================

interface FrEditorState {
  frId: string;
  row: number;
  col: number;
  /** The text was changed (typed, picked, seeded, set from the bar): the async
   *  initial load must not clobber it. */
  touched: boolean;
  /** The cell's own content arrived (or the edit was seeded). An edit that is
   *  neither touched nor loaded has NOTHING to write: committing it would
   *  write "" over a cell whose content never reached the editor. */
  loaded: boolean;
  /** Which view owns the caret: this textarea ("cell") or the formula bar. */
  view: ExternalEditView;
  /** The caret while the BAR owns it (the textarea's selection is not read
   *  then -- it may be hidden, and its selection APIs are unverified there). */
  cursor: number;
  /** TRUE workbook index of the sheet hosting the range; fixed for the edit. */
  hostSheetIndex: number;
  /** Increments per open (see the header). */
  token: number;
}

let editorState: FrEditorState | null = null;
/** The session object of the CURRENT edit (null when none is open). */
let editorSession: ExternalEditSession | null = null;
let tokenSeq = 0;
let textarea: HTMLTextAreaElement | null = null;
let unregisterExtTarget: (() => void) | null = null;
let removeAcceptedListener: (() => void) | null = null;

/**
 * Set by a reference insertion so the imminent blur does not commit.
 *
 * BOUNDED, because it used to latch: the picking click lands inside the grid,
 * where Core `preventDefault()`s the mousedown, so no blur is fired and the
 * flag's only reader never runs to clear it. It then survived until the user's
 * NEXT genuine focus departure — a click on the ribbon or the formula bar —
 * where it swallowed the commit for an edit that had nothing to do with the
 * pick, leaving the editor open over an uncommitted value. The window only has
 * to outlive handleBlur's own 150 ms defer.
 */
let suppressBlurCommit = false;
let suppressBlurTimer: number | null = null;
const SUPPRESS_BLUR_MS = 400;

function suppressNextBlurCommit(): void {
  suppressBlurCommit = true;
  if (suppressBlurTimer !== null) clearTimeout(suppressBlurTimer);
  suppressBlurTimer = window.setTimeout(() => {
    suppressBlurCommit = false;
    suppressBlurTimer = null;
  }, SUPPRESS_BLUR_MS);
}

function clearSuppressBlurCommit(): void {
  suppressBlurCommit = false;
  if (suppressBlurTimer !== null) {
    clearTimeout(suppressBlurTimer);
    suppressBlurTimer = null;
  }
}
/** Set while a commit/cancel is tearing the editor down. */
let closing = false;

export function isFrEditorOpen(): boolean {
  return editorState !== null;
}

export function getFrEditorCell(): { frId: string; row: number; col: number } | null {
  return editorState
    ? { frId: editorState.frId, row: editorState.row, col: editorState.col }
    : null;
}

/** The open edit's two-view session, or null when no edit is open. */
export function getFrEditorSession(): ExternalEditSession | null {
  return editorState ? editorSession : null;
}

/** True when this element is the FR editor's textarea (keyboard-guard check). */
export function isFrEditorElement(el: EventTarget | null): boolean {
  return textarea !== null && el === textarea;
}

/** The caret of the edit: the textarea's while it owns the caret, else the stored one. */
function caretOf(st: FrEditorState): number {
  if (!textarea) return st.cursor;
  if (st.view === "cell") return textarea.selectionStart ?? textarea.value.length;
  return Math.max(0, Math.min(st.cursor, textarea.value.length));
}

// ============================================================================
// DOM lifecycle
// ============================================================================

function ensureTextarea(): HTMLTextAreaElement | null {
  if (textarea && textarea.isConnected) return textarea;
  const layer = document.querySelector("[data-grid-canvas-layer]");
  if (!layer) return null;

  const el = document.createElement("textarea");
  el.dataset.frEditor = "";
  el.rows = 1;
  el.spellcheck = false;
  el.style.position = "absolute";
  el.style.display = "none";
  el.style.margin = "0";
  el.style.padding = "0 3px";
  el.style.border = "2px solid #217346";
  el.style.borderRadius = "0";
  el.style.outline = "none";
  el.style.resize = "none";
  el.style.overflow = "hidden";
  el.style.whiteSpace = "pre";
  el.style.background = "#ffffff";
  el.style.color = "#1a1a1a";
  el.style.boxSizing = "border-box";
  el.style.zIndex = "20";
  el.style.fontFamily = "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif";
  el.style.lineHeight = "normal";

  el.addEventListener("input", handleInput);
  el.addEventListener("keydown", handleKeyDown);
  el.addEventListener("blur", handleBlur);
  el.addEventListener("focus", handleFocus);

  layer.appendChild(el);
  textarea = el;
  return el;
}

/** Remove the DOM node entirely (deactivate). */
export function destroyFrEditor(): void {
  if (editorState) cancelFrEditor();
  if (textarea) {
    textarea.removeEventListener("input", handleInput);
    textarea.removeEventListener("keydown", handleKeyDown);
    textarea.removeEventListener("blur", handleBlur);
    textarea.removeEventListener("focus", handleFocus);
    textarea.remove();
    textarea = null;
  }
}

// ============================================================================
// Open / close
// ============================================================================

export interface FrEditorOpenOptions {
  /** Default true. false = the formula bar hosts the caret: the textarea is
   *  shown but NOT focused (a bar-begun edit must not steal the bar's focus). */
  focus?: boolean;
  /** Which view owns the caret at open. Default "cell". */
  view?: ExternalEditView;
  /** Text shown until the cell's own content loads, WITHOUT marking the edit
   *  touched or loaded (so an untouched commit still writes nothing). Only
   *  meaningful with `initialValue === null`. */
  provisional?: string | null;
}

/**
 * Open the editor on an FR cell. `initialValue` seeds type-to-edit; null loads
 * the cell's existing formula (or display value) asynchronously WITHOUT
 * clobbering anything the user typed in the meantime.
 *
 * Opens synchronously (the no-editOpenBuffer-race rule): the textarea exists,
 * is focused (unless `opts.focus === false`) and receives keystrokes before
 * this function returns, and the session is registered in Core's slot.
 */
export function openFrEditor(
  frId: string,
  row: number,
  col: number,
  initialValue: string | null,
  opts: FrEditorOpenOptions = {},
): void {
  const entry = getFloatingRangeById(frId);
  const el = ensureTextarea();
  if (!entry || !el) return;

  if (editorState) {
    // Switching cells commits the previous edit first (Excel behavior).
    void commitFrEditor(null);
  }

  const token = ++tokenSeq;
  const seeded = initialValue !== null;
  const text = initialValue ?? opts.provisional ?? "";
  editorState = {
    frId,
    row,
    col,
    touched: seeded,
    loaded: seeded,
    view: opts.view ?? "cell",
    cursor: text.length,
    hostSheetIndex: entry.sheetIndex,
    token,
  };
  clearSuppressBlurCommit();
  closing = false;

  el.value = text;
  el.style.display = "block";
  // A clip left by the previous session's last layout must not trim this one
  // for the frame before its own layout runs.
  el.style.clipPath = "";
  if (opts.focus !== false) {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }

  // The session: ONE edit that this textarea and the formula bar both show.
  // Registered as the external formula target, so while it expects a
  // reference a grid click inserts "Sheet1!A1" here instead of moving the grid
  // selection -- at the caret of whichever view owns it.
  editorSession = createSession(token, frId, row, col, entry.name, entry.sheetIndex);
  unregisterExtTarget = registerExternalFormulaTarget({
    isExpectingReference: () => {
      const st = editorState;
      if (!st || st.token !== token || !textarea) return false;
      const v = textarea.value;
      if (!v.startsWith("=")) return false;
      return isFormulaExpectingReference(v, caretOf(st));
    },
    insertReference: (ref) => {
      if (!editorState || editorState.token !== token) return;
      insertTextAtCursor(
        buildQualifiedRef(
          ref.sheetName,
          ref.startRow,
          ref.startCol,
          ref.endRow,
          ref.endCol,
        ),
      );
    },
    session: editorSession,
  });

  // Autocomplete acceptance (InlineEditor pattern). ONE owner per view:
  // ACCEPTED carries no source, and the formula bar (and every formula dialog)
  // hears it too -- so this view applies it only while IT has the focus. The
  // dropdown preventDefaults its mousedown, so a click on a suggestion keeps
  // the focus where the typing was.
  const onAccepted = (e: Event) => {
    const st = editorState;
    if (!st || st.token !== token || !textarea) return;
    if (document.activeElement !== textarea) return;
    const { newValue, newCursorPosition } = (e as CustomEvent<AutocompleteAcceptedPayload>).detail;
    textarea.value = newValue;
    st.touched = true;
    st.cursor = newCursorPosition;
    textarea.setSelectionRange(newCursorPosition, newCursorPosition);
    textarea.focus();
    notifyExternalEditChanged();
  };
  window.addEventListener(AutocompleteEvents.ACCEPTED, onAccepted);
  removeAcceptedListener = () =>
    window.removeEventListener(AutocompleteEvents.ACCEPTED, onAccepted);

  // The range's resize handles stand down while one of its cells is edited:
  // the store re-publishes `resizable` on this signal (Core's corner boxes).
  setFrEditingRange(frId);

  if (initialValue === null) {
    void loadInitialValue(frId, row, col, token);
  }

  requestOverlayRedraw();
}

/**
 * The session object of one edit (see ExternalEditSession in
 * core/lib/formulaEditTarget.ts for the contract). Every method first checks
 * that its edit is still THE edit (`token`).
 */
function createSession(
  token: number,
  frId: string,
  row: number,
  col: number,
  nameAtOpen: string,
  hostSheetIndex: number,
): ExternalEditSession {
  const live = (): FrEditorState | null =>
    editorState !== null && editorState.token === token && textarea !== null ? editorState : null;

  return {
    // A getter: a rename during the edit re-derives the Name Box text.
    get address(): string {
      return buildQualifiedRef(getFloatingRangeById(frId)?.name ?? nameAtOpen, row, col);
    },
    hostSheetIndex,
    anchor: Object.freeze({ row, col }),

    getText(): string {
      return live() && textarea ? textarea.value : "";
    },

    getCursor(): number {
      const st = live();
      return st ? caretOf(st) : 0;
    },

    getView(): ExternalEditView {
      return live()?.view ?? "bar";
    },

    setText(text: string, cursor: number): void {
      const st = live();
      if (!st || !textarea) return;
      const caret = Math.max(0, Math.min(cursor, text.length));
      const changed = textarea.value !== text;
      // No-op, and NO notify, when nothing changed: the bar feeds its own
      // value back on every select event, and a notify there would loop
      // through the bar's caret effect.
      if (!changed && st.cursor === caret) return;
      if (changed) {
        textarea.value = text;
        st.touched = true;
      }
      st.cursor = caret;
      // The view is NEVER changed here (only a focus does); while the textarea
      // owns the caret its selection IS the caret, so it follows.
      if (st.view === "cell") textarea.setSelectionRange(caret, caret);
      notifyExternalEditChanged();
    },

    setCursor(cursor: number): void {
      const st = live();
      if (!st || !textarea) return;
      st.cursor = Math.max(0, Math.min(cursor, textarea.value.length));
    },

    adoptBarView(): void {
      const st = live();
      if (!st || st.view === "bar") return;
      // Snapshot the textarea's caret before the bar takes over the edit.
      if (textarea) st.cursor = textarea.selectionStart ?? textarea.value.length;
      st.view = "bar";
      notifyExternalEditChanged();
    },

    focusCellView(): void {
      const st = live();
      if (!st || !textarea) return;
      // Parked: this range is not on screen, the bar is the only view.
      if (isExternalSessionParked()) return;
      const caret = caretOf(st);
      textarea.focus();
      const pos = Math.max(0, Math.min(caret, textarea.value.length));
      textarea.setSelectionRange(pos, pos);
    },

    commit(move: ExternalEditMove): Promise<boolean> {
      return live() ? commitFrEditor(move) : Promise.resolve(false);
    },

    cancel(): void {
      if (live()) cancelFrEditor();
    },

    onParkedChanged(parked: boolean): void {
      const st = live();
      if (!st || !textarea) return;
      if (parked) {
        // Snapshot the caret BEFORE hiding: the selection APIs of a
        // display:none textarea are unverified in WebView2.
        if (st.view === "cell") st.cursor = textarea.selectionStart ?? textarea.value.length;
        st.view = "bar";
        textarea.style.display = "none";
      } else {
        // The next overlay frame lays it out over its cell again.
        textarea.style.display = "block";
        textarea.style.clipPath = "";
        requestOverlayRedraw();
      }
    },
  };
}

async function loadInitialValue(
  frId: string,
  row: number,
  col: number,
  token: number,
): Promise<void> {
  try {
    const cells = await getFloatingRangeCells(frId, row, col, row, col);
    const st = editorState;
    if (!st || st.token !== token) return;
    if (st.touched || !textarea) return; // the user got there first
    const cell = cells.find((c) => c.row === row && c.col === col);
    const value = cell ? (cell.formula ?? cell.display ?? "") : "";
    st.loaded = true;
    if (textarea.value !== value) {
      textarea.value = value;
      st.cursor = value.length;
      if (st.view === "cell") textarea.setSelectionRange(value.length, value.length);
      // The bar mirrors the session: it must see the content arrive.
      notifyExternalEditChanged();
    }
  } catch {
    // The content never arrived: `loaded` stays false, so an untouched commit
    // writes NOTHING. A transient read failure must not blank the cell.
  }
}

function teardown(): void {
  closing = true;
  editorState = null;
  editorSession = null;
  clearSuppressBlurCommit();
  if (unregisterExtTarget) {
    // Notifies the external-edit store (and clears `parked` there).
    unregisterExtTarget();
    unregisterExtTarget = null;
  }
  if (removeAcceptedListener) {
    removeAcceptedListener();
    removeAcceptedListener = null;
  }
  if (textarea) {
    textarea.style.display = "none";
    textarea.value = "";
  }
  window.dispatchEvent(new CustomEvent(AutocompleteEvents.DISMISS));
  setFrEditingRange(null);
  closing = false;
}

/**
 * Commit the value, then optionally move the FR-local selection. Tears the
 * edit down SYNCHRONOUSLY before its first await. Resolves true when the value
 * was written or there was nothing to write, false when there was no edit or
 * the backend refused (the user has already been told why).
 */
export async function commitFrEditor(move: ExternalEditMove): Promise<boolean> {
  const st = editorState;
  if (!st || !textarea || closing) return false;
  const value = textarea.value;
  // Nothing typed and the cell's content never arrived: writing would blank
  // the cell with "" (double-click, then Enter before the read lands).
  const nothingToWrite = !st.touched && !st.loaded;
  teardown();

  // The MOVE happens now, with the teardown, before the write's first await --
  // the way the grid moves its cursor on Enter. Moved only after the write
  // resolved, the selection sat on the committed cell for the whole IPC and
  // recalc: the formula bar re-published THAT cell with its pre-edit cached
  // text, a key typed in the window opened a NEW edit on it seeded with the old
  // text, and when the move finally landed the edit-lifetime rule committed
  // that stale text over the value just written. The move never depended on
  // `written`; a new edit opened during the write now opens on the NEXT cell.
  const entry = getFloatingRangeById(st.frId);
  const sel = getLocalSelection();
  if (move && entry && sel && sel.frId === st.frId) {
    const delta =
      move === "down"
        ? [1, 0]
        : move === "up"
          ? [-1, 0]
          : move === "right"
            ? [0, 1]
            : [0, -1];
    // Navigation spans the CONTENT extent (M7), and the cell it lands on is
    // scrolled into view.
    const view = getFrView(entry);
    moveLocalSelection(delta[0], delta[1], false, view.rows, view.cols);
    const moved = getLocalSelection();
    if (moved) ensureFrCellVisible(entry, moved.endRow, moved.endCol);
    requestOverlayRedraw();
  }

  let written = true;
  if (!nothingToWrite) {
    try {
      await updateFloatingRangeCell(st.frId, st.row, st.col, value);
    } catch (err) {
      // The editor is already gone, so a refused write must not vanish into
      // the console: the user typed a value and is owed a reason it did not
      // stick. (Until the backend's write gate follows the content extent, a
      // cell the user scrolled to beyond the window is one such refusal.)
      written = false;
      console.error("[FloatingRange] Cell commit failed:", err);
      showToast(
        `The value could not be written: ${err instanceof Error ? err.message : String(err)}`,
        { type: "error" },
      );
    }
    invalidateFrCache(st.frId);
  }
  requestOverlayRedraw();

  // A NEW editor session may have opened while the write was in flight
  // (double-click on another cell); stealing its focus would blur-commit it.
  if (editorState === null) restoreFocusToGrid();
  return written;
}

/** Discard the edit (Esc). Local selection and object selection stay. */
export function cancelFrEditor(): void {
  if (!editorState) return;
  teardown();
  requestOverlayRedraw();
  restoreFocusToGrid();
}

// ============================================================================
// Reference insertion (grid->FR and float->float both land here)
// ============================================================================

/**
 * Insert `text` at the caret of whichever view owns it. The textarea view
 * replaces its selection and keeps the focus; the BAR view inserts at the
 * bar's caret and never focuses the textarea -- the bar keeps the keyboard, and
 * it emits its own autocomplete input.
 */
function insertTextAtCursor(text: string): void {
  const st = editorState;
  if (!textarea || !st) return;
  const v = textarea.value;
  const start = Math.min(caretOf(st), v.length);
  const end =
    st.view === "cell" ? Math.max(start, textarea.selectionEnd ?? start) : start;
  textarea.value = v.slice(0, start) + text + v.slice(end);
  st.touched = true;
  const pos = start + text.length;
  st.cursor = pos;
  if (st.view === "cell") {
    // The click that picked the reference is about to blur (or already
    // blurred) the textarea — that blur must not commit a half-typed formula.
    suppressNextBlurCommit();
    textarea.focus();
    textarea.setSelectionRange(pos, pos);
    emitAutocompleteInput();
  }
  notifyExternalEditChanged();
}

/** Insert reference text into THIS editor (used by the FR claimsBodyDrag
 *  float->float branch when this editor is the active formula target). */
export function insertReferenceIntoFrEditor(text: string): boolean {
  if (!editorState || !textarea) return false;
  insertTextAtCursor(text);
  return true;
}

// ============================================================================
// Event handlers
// ============================================================================

function emitAutocompleteInput(): void {
  if (!textarea) return;
  const rect = textarea.getBoundingClientRect();
  window.dispatchEvent(
    new CustomEvent(AutocompleteEvents.INPUT, {
      detail: {
        value: textarea.value,
        cursorPosition: textarea.selectionStart ?? textarea.value.length,
        anchorRect: {
          x: rect.left,
          y: rect.bottom,
          width: rect.width,
          height: rect.height,
        },
        source: "dialog",
      },
    }),
  );
}

function handleInput(): void {
  const st = editorState;
  if (!st) return;
  st.touched = true;
  if (textarea) st.cursor = textarea.selectionStart ?? textarea.value.length;
  emitAutocompleteInput();
  // The formula bar mirrors in-place typing live.
  notifyExternalEditChanged();
}

/** The textarea took the focus: it owns the caret again (from the bar). */
function handleFocus(): void {
  const st = editorState;
  if (!st || st.view === "cell") return;
  st.view = "cell";
  notifyExternalEditChanged();
}

function handleKeyDown(e: KeyboardEvent): void {
  if (!editorState) return;
  // Nothing typed in the editor may fall through to the grid or the FR's own
  // capture-phase keyboard handler.
  e.stopPropagation();

  // Swallow navigation keys while the autocomplete dropdown is visible and
  // forward them as autocomplete KEY events (InlineEditor pattern).
  if (isFormulaAutocompleteVisible()) {
    const autocompleteKeys = ["ArrowUp", "ArrowDown", "Tab", "Escape", "Enter"];
    if (autocompleteKeys.includes(e.key)) {
      e.preventDefault();
      window.dispatchEvent(
        new CustomEvent(AutocompleteEvents.KEY, { detail: { key: e.key } }),
      );
      return;
    }
  }

  // The textarea is only ever focused on the host sheet (it is hidden while
  // the edit is parked), so these never need to return anywhere first.
  if (e.key === "Enter" && !e.altKey) {
    e.preventDefault();
    void commitFrEditor(e.shiftKey ? "up" : "down");
  } else if (e.key === "Tab") {
    e.preventDefault();
    void commitFrEditor(e.shiftKey ? "left" : "right");
  } else if (e.key === "Escape") {
    e.preventDefault();
    cancelFrEditor();
  }
}

function handleBlur(): void {
  const st = editorState;
  if (!st || closing) return;
  // Deferred: a formula reference pick refocuses (or sets the suppress flag)
  // within the same interaction; only a GENUINE focus departure commits.
  window.setTimeout(() => {
    if (!editorState || editorState !== st) return;
    // Focus check FIRST: a reference pick refocuses the textarea, so this
    // alone already covers the case the suppress flag was added for — and
    // reaching it first means the flag is not consumed by a blur that was
    // never a departure in the first place.
    if (textarea && document.activeElement === textarea) return;
    // Parked: the edit is picking a reference on another sheet, and hiding
    // the textarea is what blurred it. The formula bar hosts the edit now.
    if (isExternalSessionParked()) return;
    // A hand-off, not a departure: the formula bar is the edit's OTHER view
    // (the InlineEditor rule). The bar now owns the caret.
    if (isFormulaBarElement(document.activeElement)) {
      if (st.view !== "bar") {
        st.view = "bar";
        notifyExternalEditChanged();
      }
      return;
    }
    // The BAR owns the edit (it adopted it -- fx does, before its dialog takes
    // the focus): the textarea losing a focus it no longer owns ends nothing.
    // The bar's own doors end the edit (Enter, Tab, X, the check mark, and a
    // click away through the edit-lifetime rule).
    if (st.view === "bar") return;
    // A formula still EXPECTING a reference is never blur-committed (Core's
    // InlineEditor rule): the focus left for something that feeds it -- the
    // Insert Function dialog's search box after fx, above all. Committed, the
    // half-typed "=SUM(" was written (or refused) and the function the user
    // then chose had no edit to land in.
    if (textarea && textarea.value.startsWith("=") && isFormulaExpectingReference(textarea.value, caretOf(st))) {
      return;
    }
    if (suppressBlurCommit) {
      clearSuppressBlurCommit();
      return;
    }
    void commitFrEditor(null);
  }, 150);
}

// ============================================================================
// Per-frame layout (called from the overlay renderer for the hosting FR)
// ============================================================================

/**
 * The part of a cell rect that is actually visible: the cell clipped to the
 * FR's cell VIEWPORT (M7 -- a scrolled cell can sit partly or wholly behind the
 * sticky headers or past the frame) and to the grid's own cell area. Returned
 * as insets from each side of the cell, or null when nothing of it shows.
 * Pure; exported for tests.
 */
export function frEditorVisibleInsets(
  cell: { x: number; y: number; width: number; height: number },
  viewport: { x: number; y: number; width: number; height: number },
  gridArea: { x: number; y: number; width: number; height: number },
): { top: number; right: number; bottom: number; left: number } | null {
  const left = Math.max(cell.x, viewport.x, gridArea.x);
  const top = Math.max(cell.y, viewport.y, gridArea.y);
  const right = Math.min(cell.x + cell.width, viewport.x + viewport.width, gridArea.x + gridArea.width);
  const bottom = Math.min(cell.y + cell.height, viewport.y + viewport.height, gridArea.y + gridArea.height);
  if (right <= left || bottom <= top) return null;
  return {
    top: top - cell.y,
    right: cell.x + cell.width - right,
    bottom: cell.y + cell.height - bottom,
    left: left - cell.x,
  };
}

/**
 * Reposition the textarea over its cell. Called by renderFloatingRange EVERY
 * overlay render frame for the FR that hosts the open editor — logical px from
 * the frame origin, multiplied by zoom for the DOM (InlineEditor precedent).
 *
 * The editor FOLLOWS ITS CELL through a scroll (`view`, the same live view the
 * frame was painted with), is HIDDEN once the cell has left the FR's cell
 * viewport (or the grid's cell area) entirely, and is CLIPPED to what still
 * shows while it is partly out, so a half-scrolled editor never paints over
 * the frame's sticky headers or outside the frame. Allocation-light: a handful
 * of style writes per frame.
 */
export function layoutFrEditorForFrame(
  entry: FloatingRangeEntry,
  frameCanvasX: number,
  frameCanvasY: number,
  overlayCtx: OverlayRenderContext,
  view?: FrView,
): void {
  const st = editorState;
  if (!st || st.frId !== entry.id || !textarea) return;
  // Parked: the grid shows another sheet. Belt and braces -- the regions are
  // suppressed then, so this frame should not have been painted at all.
  if (isExternalSessionParked()) {
    textarea.style.display = "none";
    return;
  }

  const origin = localCellOrigin(entry, st.row, st.col, view);
  const cellX = frameCanvasX + origin.x;
  const cellY = frameCanvasY + origin.y;
  const cellW = frColWidth(entry, st.col);
  const cellH = frRowHeight(entry, st.row);

  const rowHeaderWidth = overlayGetRowHeaderWidth(overlayCtx);
  const colHeaderHeight = overlayGetColHeaderHeight(overlayCtx);

  const insets = frEditorVisibleInsets(
    { x: cellX, y: cellY, width: cellW, height: cellH },
    {
      x: frameCanvasX + frRowHdrW(entry),
      y: frameCanvasY + frCellsTop(entry),
      width: contentWidth(entry),
      height: contentHeight(entry),
    },
    {
      x: rowHeaderWidth,
      y: colHeaderHeight,
      width: overlayCtx.canvasWidth - rowHeaderWidth,
      height: overlayCtx.canvasHeight - colHeaderHeight,
    },
  );

  if (!insets) {
    textarea.style.display = "none";
    return;
  }

  const zoom = getGridStateSnapshot()?.zoom ?? 1;
  textarea.style.display = "block";
  textarea.style.left = `${cellX * zoom}px`;
  textarea.style.top = `${cellY * zoom}px`;
  textarea.style.width = `${cellW * zoom}px`;
  textarea.style.height = `${cellH * zoom}px`;
  textarea.style.fontSize = `${11 * zoom}px`;
  const clipped = insets.top > 0 || insets.right > 0 || insets.bottom > 0 || insets.left > 0;
  textarea.style.clipPath = clipped
    ? `inset(${insets.top * zoom}px ${insets.right * zoom}px ${insets.bottom * zoom}px ${insets.left * zoom}px)`
    : "";
}
