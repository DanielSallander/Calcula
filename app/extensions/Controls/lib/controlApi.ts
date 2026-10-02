//! FILENAME: app/extensions/Controls/lib/controlApi.ts
// PURPOSE: TypeScript bindings for the Tauri control metadata commands.
// CONTEXT: Uses the API facade (src/api/backend.ts) for sandboxed backend access.

import { controlsBackend } from "./controlsBackend";
import { trackControlGeometryWrite } from "./geometryWriteOrder";
import type { ControlMetadata, ControlEntry, ControlGeometryChange } from "./types";

// ============================================================================
// Control Metadata CRUD
// ============================================================================

/** Get control metadata for a specific cell. Returns null if no control exists. */
export async function getControlMetadata(
  sheetIndex: number,
  row: number,
  col: number,
): Promise<ControlMetadata | null> {
  return controlsBackend.invoke<ControlMetadata | null>("get_control_metadata", {
    sheetIndex,
    row,
    col,
  });
}

/** Set a single property on a control. Creates the control if it doesn't exist. */
export async function setControlProperty(
  sheetIndex: number,
  row: number,
  col: number,
  controlType: string,
  propertyName: string,
  valueType: string,
  value: string,
): Promise<ControlMetadata> {
  return controlsBackend.invoke<ControlMetadata>("set_control_property", {
    sheetIndex,
    row,
    col,
    controlType,
    propertyName,
    valueType,
    value,
  });
}

/**
 * "Remove the application's code" (BUG-0257): discard a working copy button's
 * HELD code -- both held slots and the stamp -- as ONE undoable "Change button
 * code" step, leaving the button with no code. Call it only after the held code
 * has been SHOWN and the author confirmed (`requestHeldRemoval`): the backend
 * treats an empty code write as the tab-through no-op unless this flag says the
 * removal was asked for. Without it a developer could not remove an application
 * button's action at all -- the next push restored it.
 */
export async function removeApplicationButtonCode(
  sheetIndex: number,
  row: number,
  col: number,
  controlType: string,
): Promise<ControlMetadata> {
  return controlsBackend.invoke<ControlMetadata>("set_control_property", {
    sheetIndex,
    row,
    col,
    controlType,
    propertyName: "onSelect",
    valueType: "static",
    value: "",
    replaceHeld: true,
  });
}

/**
 * "Make this my own" (phase 4 of BUG-0257): MOVE a button's held application
 * code into its live slots, so it becomes the author's own code -- the one way
 * an application's button code becomes code of the user's own. Rust
 * (`controls::adopt_held_button_code`) does it as ONE undoable step ("Make
 * button code my own"), always audited (`button_code_adopted`).
 *
 * `shownOnSelect` / `shownMacroRef` are EXACTLY the texts the confirm showed
 * (null for a slot it did not show), never a fresh read: Rust compares them with
 * what the button holds under the same lock as the move, and refuses with
 * nothing written when the code changed after it was shown. Refused too when
 * nothing is held, the control is not a button, or the button already runs code
 * of the author's own. Main window only; `codeExecution` for everyone else.
 */
export async function adoptHeldButtonCode(
  sheetIndex: number,
  row: number,
  col: number,
  shownOnSelect: string | null,
  shownMacroRef: string | null,
): Promise<ControlMetadata> {
  return controlsBackend.invoke<ControlMetadata>("adopt_held_button_code", {
    sheetIndex,
    row,
    col,
    shownOnSelect,
    shownMacroRef,
  });
}

/** Set the full control metadata for a cell (replaces existing). */
export async function setControlMetadata(
  sheetIndex: number,
  row: number,
  col: number,
  metadata: ControlMetadata,
): Promise<ControlMetadata> {
  return controlsBackend.invoke<ControlMetadata>("set_control_metadata", {
    sheetIndex,
    row,
    col,
    metadata,
  });
}

/**
 * MOVE a control to another anchor cell on the same sheet, with every property
 * it has, as ONE undoable step ("Move control"), writing `overrides` over it in
 * the same step.
 *
 * Not `setControlMetadata` + `removeControlMetadata`: the metadata door strips
 * a button's HELD code (it is the paste door, and a copy is the author's own),
 * so re-creating a working copy's button at a new cell lost its application's
 * code, and the next push published the button empty (BUG-0257). `overrides`
 * may not name a code key. Refused, with nothing written, when another control
 * already sits at the target.
 */
export async function moveControl(
  sheetIndex: number,
  fromRow: number,
  fromCol: number,
  toRow: number,
  toCol: number,
  overrides: Record<string, ControlMetadata["properties"][string]> = {},
): Promise<ControlMetadata> {
  return controlsBackend.invoke<ControlMetadata>("move_control", {
    sheetIndex,
    fromRow,
    fromCol,
    toRow,
    toCol,
    properties: overrides,
  });
}

/** Remove control metadata for a specific cell. */
export async function removeControlMetadata(
  sheetIndex: number,
  row: number,
  col: number,
): Promise<boolean> {
  return controlsBackend.invoke<boolean>("remove_control_metadata", {
    sheetIndex,
    row,
    col,
  });
}

/**
 * Move and/or resize several floating controls as ONE undoable step ("Move
 * control"), joining an undo transaction that is already open -- so a
 * cross-family arrange wrapped in begin/commit stays one Ctrl+Z. Replaces the
 * 4-6 non-undoable `set_control_property` calls per control that a move used
 * to cost. The whole batch is refused, with nothing written, if any change is
 * malformed, names a control that does not exist, or targets a protected sheet
 * that does not allow editing objects. Resolves to how many controls actually
 * changed (0 = nothing to do: no dirty flag, no undo step).
 *
 * The write is TRACKED from the moment it is issued (lib/geometryWriteOrder.ts):
 * a renderer's property read of these controls waits for it, and a read that
 * was already on its way is not written back over the new geometry (BUG-0268).
 * Every geometry persist of this extension comes through here, so none can
 * skip that ordering.
 */
export async function setControlGeometry(
  changes: ControlGeometryChange[],
): Promise<number> {
  return trackControlGeometryWrite(
    changes,
    controlsBackend.invoke<number>("set_control_geometry", { changes }),
  );
}

/** Get all controls for a specific sheet. */
export async function getAllControls(
  sheetIndex: number,
): Promise<ControlEntry[]> {
  return controlsBackend.invoke<ControlEntry[]>("get_all_controls", { sheetIndex });
}

/**
 * Resolve all formula-type properties for a control.
 * Returns a map of property name -> resolved display value.
 * Static properties are returned as-is; formula properties are evaluated.
 */
export async function resolveControlProperties(
  sheetIndex: number,
  row: number,
  col: number,
): Promise<Record<string, string>> {
  return controlsBackend.invoke<Record<string, string>>("resolve_control_properties", {
    sheetIndex,
    row,
    col,
  });
}
