//! FILENAME: app/extensions/Controls/lib/controlApi.ts
// PURPOSE: TypeScript bindings for the Tauri control metadata commands.
// CONTEXT: Uses the API facade (src/api/backend.ts) for sandboxed backend access.

import { controlsBackend } from "./controlsBackend";
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
 */
export async function setControlGeometry(
  changes: ControlGeometryChange[],
): Promise<number> {
  return controlsBackend.invoke<number>("set_control_geometry", { changes });
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
