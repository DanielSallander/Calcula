//! FILENAME: app/src/api/editing.ts
// PURPOSE: Editing API for shell and extensions.
// CONTEXT: Exposes editing hooks and state management through the API facade.
// Shell components should import from here instead of core/hooks/useEditing.

// The flag's own dependency-free store (useEditing's getGlobalIsEditing reads
// the same one), so this door and the keybinding dispatcher read one boolean.
import { isCoreCellEditOpen as coreCellEditOpen } from "../core/lib/cellEditFlag";
import { isExternalEditLive as externalEditLive } from "../core/lib/formulaEditTarget";
import { isEditingKeystroke } from "./keybindings";

export {
  useEditing,
  setGlobalIsEditing,
  getGlobalIsEditing,
  getGlobalEditingValue,
  isGlobalFormulaMode,
  setGlobalCursorPosition,
  getGlobalCursorPosition,
  setChartSeriesRefMode,
  insertTextIntoActiveFormula,
} from "../core/hooks/useEditing";

// External formula edit session seam: an extension-owned editor registers
// itself to receive grid reference picks while it is expecting a reference.
export {
  registerExternalFormulaTarget,
  getExternalFormulaTarget,
} from "../core/lib/formulaEditTarget";
export type {
  ExternalFormulaTarget,
  ExternalFormulaReference,
} from "../core/lib/formulaEditTarget";

// The rest of the external-edit seam (the two-view session, the selected
// external cell, the Name Box resolver, the point-mode switch). A PURE
// re-export of the `externalEdit` subpath: one binding per name, so this door
// and that one cannot drift (pinned by api-surface-stability.test.ts). The
// shell imports the subpath, because its tests mock this module with fixed
// export lists.
export * from "./externalEdit";

// ============================================================================
// "Is this keystroke an edit's?" -- the question an extension's OWN key
// listener asks before it acts on Core's selection
// ============================================================================

/**
 * Whether a CELL EDIT is in progress: Core's own (its in-cell editor, the
 * formula bar hosting that edit, or parked on another sheet while it picks a
 * reference, the keyboard on the grid container) or a live external session (a floating grid's
 * cell edit, in its own editor, in the formula bar, or parked on another sheet
 * while it picks a reference). The same pair Core's own gates read
 * (gridPointerEntry's `editBlocksGridFocus`, useGridKeyboard's edit check).
 */
export function isCellEditInProgress(): boolean {
  return coreCellEditOpen() || externalEditLive();
}

function isTextEntryElement(el: EventTarget | null): boolean {
  if (!el || typeof (el as HTMLElement).tagName !== "string") return false;
  const node = el as HTMLElement;
  const tag = node.tagName.toUpperCase();
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    node.isContentEditable === true ||
    node.contentEditable === "true"
  );
}

/**
 * Whether this keystroke belongs to an EDIT rather than to Core's selection --
 * so an extension's own window key listener that ACTS on the selection
 * (AutoFilter's Ctrl+Shift+L, Grouping's Alt+Shift+Arrow, Format Painter's
 * Ctrl+Shift+C, Ctrl+K, Ctrl+E, Ctrl+Alt+M, Alt+Down, Alt+;, the bookmark
 * keys) must stand down. True when
 *   - the keybinding dispatcher's own editing context holds
 *     (`isEditingKeystroke`: a text field or a pointer claim owns the key, or
 *     a cell edit is live -- Core's own, even with the keyboard off its editor
 *     while it is parked on another sheet, or an external session) -- the
 *     same test that makes a "not-editing" registry binding stand down, so a
 *     listener and the binding for the same key cannot disagree. Excel ignores
 *     these shortcuts in edit mode;
 *   - the event's TARGET is a text field (a synthesised or re-dispatched event
 *     can carry one that is not `document.activeElement`).
 * The failure it prevents: with a floating grid's cell edit live (its editor
 * or the formula bar focused, or parked with the keyboard on the grid
 * container), these listeners acted on Core's HIDDEN selection -- a table, a
 * filter, a group or a format painted over cells the user could not see.
 */
export function isEditKeystroke(event: KeyboardEvent): boolean {
  return isEditingKeystroke(event) || isTextEntryElement(event.target);
}
