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
// V1 PARITY GAPS (accepted, documented): no F4 abs/rel toggle, no arrow-key
//          reference navigation inside FR formulas.

import type { OverlayRenderContext } from "@api/gridOverlays";
import {
  overlayGetRowHeaderWidth,
  overlayGetColHeaderHeight,
  requestOverlayRedraw,
} from "@api/gridOverlays";
import { isFormulaExpectingReference } from "@api";
import {
  AutocompleteEvents,
  isFormulaAutocompleteVisible,
  type AutocompleteAcceptedPayload,
} from "@api/formulaAutocomplete";
import { restoreFocusToGrid } from "@api/events";
import { getGridStateSnapshot } from "@api/grid";
import { registerExternalFormulaTarget } from "@api/editing";
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
} from "../lib/frDimensions";
import { getLocalSelection, moveLocalSelection } from "../lib/frSelection";
import { invalidateFrCache } from "../rendering/frRenderer";
import { buildQualifiedRef } from "../lib/frRefs";

// ============================================================================
// State
// ============================================================================

interface FrEditorState {
  frId: string;
  row: number;
  col: number;
  /** Guard for the async initial-load: stale loads must not clobber typing. */
  touched: boolean;
}

let editorState: FrEditorState | null = null;
let textarea: HTMLTextAreaElement | null = null;
let unregisterExtTarget: (() => void) | null = null;
let removeAcceptedListener: (() => void) | null = null;

/** Set by a reference insertion so the imminent blur does not commit. */
let suppressBlurCommit = false;
/** Set while a commit/cancel is tearing the editor down. */
let closing = false;

export function isFrEditorOpen(): boolean {
  return editorState !== null;
}

export function getFrEditorCell(): { frId: string; row: number; col: number } | null {
  return editorState ? { ...editorState } : null;
}

/** True when this element is the FR editor's textarea (keyboard-guard check). */
export function isFrEditorElement(el: EventTarget | null): boolean {
  return textarea !== null && el === textarea;
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
    textarea.remove();
    textarea = null;
  }
}

// ============================================================================
// Open / close
// ============================================================================

/**
 * Open the editor on an FR cell. `initialValue` seeds type-to-edit; null loads
 * the cell's existing formula (or display value) asynchronously WITHOUT
 * clobbering anything the user typed in the meantime.
 *
 * Opens synchronously (the no-editOpenBuffer-race rule): the textarea exists,
 * is focused and receives keystrokes before this function returns.
 */
export function openFrEditor(
  frId: string,
  row: number,
  col: number,
  initialValue: string | null,
): void {
  const entry = getFloatingRangeById(frId);
  const el = ensureTextarea();
  if (!entry || !el) return;

  if (editorState) {
    // Switching cells commits the previous edit first (Excel behavior).
    void commitFrEditor(null);
  }

  editorState = { frId, row, col, touched: initialValue !== null };
  suppressBlurCommit = false;
  closing = false;

  el.value = initialValue ?? "";
  el.style.display = "block";
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);

  // External formula edit session: while this editor expects a reference, a
  // grid click inserts "Sheet1!A1" here instead of moving the grid selection.
  unregisterExtTarget = registerExternalFormulaTarget({
    isExpectingReference: () => {
      if (!editorState || !textarea) return false;
      const v = textarea.value;
      if (!v.startsWith("=")) return false;
      return isFormulaExpectingReference(
        v,
        textarea.selectionStart ?? v.length,
      );
    },
    insertReference: (ref) => {
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
  });

  // Autocomplete acceptance (InlineEditor pattern).
  const onAccepted = (e: Event) => {
    if (!editorState || !textarea) return;
    const { newValue, newCursorPosition } = (e as CustomEvent<AutocompleteAcceptedPayload>).detail;
    textarea.value = newValue;
    editorState.touched = true;
    textarea.setSelectionRange(newCursorPosition, newCursorPosition);
    textarea.focus();
  };
  window.addEventListener(AutocompleteEvents.ACCEPTED, onAccepted);
  removeAcceptedListener = () =>
    window.removeEventListener(AutocompleteEvents.ACCEPTED, onAccepted);

  if (initialValue === null) {
    void loadInitialValue(frId, row, col);
  }

  requestOverlayRedraw();
}

async function loadInitialValue(
  frId: string,
  row: number,
  col: number,
): Promise<void> {
  try {
    const cells = await getFloatingRangeCells(frId, row, col, row, col);
    const st = editorState;
    if (!st || st.frId !== frId || st.row !== row || st.col !== col) return;
    if (st.touched || !textarea) return; // the user got there first
    const cell = cells.find((c) => c.row === row && c.col === col);
    const value = cell ? (cell.formula ?? cell.display ?? "") : "";
    textarea.value = value;
    textarea.setSelectionRange(value.length, value.length);
  } catch {
    // Editing an unreadable cell starts blank — the commit still goes through.
  }
}

function teardown(): void {
  closing = true;
  editorState = null;
  if (unregisterExtTarget) {
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
  closing = false;
}

/** Commit the value, then optionally move the FR-local selection. */
export async function commitFrEditor(
  move: "down" | "up" | "right" | "left" | null,
): Promise<void> {
  const st = editorState;
  if (!st || !textarea || closing) return;
  const value = textarea.value;
  teardown();

  try {
    await updateFloatingRangeCell(st.frId, st.row, st.col, value);
  } catch (err) {
    console.error("[FloatingRange] Cell commit failed:", err);
  }
  invalidateFrCache(st.frId);
  requestOverlayRedraw();

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
    moveLocalSelection(delta[0], delta[1], false, entry.rows, entry.cols);
    requestOverlayRedraw();
  }
  // A NEW editor session may have opened while the write was in flight
  // (double-click on another cell); stealing its focus would blur-commit it.
  if (editorState === null) restoreFocusToGrid();
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

function insertTextAtCursor(text: string): void {
  if (!textarea || !editorState) return;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  textarea.value =
    textarea.value.slice(0, start) + text + textarea.value.slice(end);
  editorState.touched = true;
  const pos = start + text.length;
  // The click that picked the reference is about to blur (or already blurred)
  // the textarea — that blur must not commit a half-typed formula.
  suppressBlurCommit = true;
  textarea.focus();
  textarea.setSelectionRange(pos, pos);
  emitAutocompleteInput();
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
  if (!editorState) return;
  editorState.touched = true;
  emitAutocompleteInput();
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
    if (suppressBlurCommit) {
      suppressBlurCommit = false;
      return;
    }
    if (textarea && document.activeElement === textarea) return;
    void commitFrEditor(null);
  }, 150);
}

// ============================================================================
// Per-frame layout (called from the overlay renderer for the hosting FR)
// ============================================================================

/**
 * Reposition the textarea over its cell. Called by renderFloatingRange EVERY
 * overlay render frame for the FR that hosts the open editor — logical px from
 * the frame origin, multiplied by zoom for the DOM (InlineEditor precedent),
 * hidden when clipped behind the grid headers or off-canvas. Allocation-light:
 * a handful of style writes per frame.
 */
export function layoutFrEditorForFrame(
  entry: FloatingRangeEntry,
  frameCanvasX: number,
  frameCanvasY: number,
  overlayCtx: OverlayRenderContext,
): void {
  const st = editorState;
  if (!st || st.frId !== entry.id || !textarea) return;

  const origin = localCellOrigin(entry, st.row, st.col);
  const cellX = frameCanvasX + origin.x;
  const cellY = frameCanvasY + origin.y;
  const cellW = frColWidth(entry, st.col);
  const cellH = frRowHeight(entry, st.row);

  const rowHeaderWidth = overlayGetRowHeaderWidth(overlayCtx);
  const colHeaderHeight = overlayGetColHeaderHeight(overlayCtx);

  const visible =
    cellX + cellW > rowHeaderWidth &&
    cellY + cellH > colHeaderHeight &&
    cellX < overlayCtx.canvasWidth &&
    cellY < overlayCtx.canvasHeight;

  if (!visible) {
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
}
