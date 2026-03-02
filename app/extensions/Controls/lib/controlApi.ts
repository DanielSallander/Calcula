//! FILENAME: app/extensions/Controls/lib/controlApi.ts
// PURPOSE: TypeScript bindings for the Tauri control metadata commands.
// CONTEXT: Uses the API facade (src/api/backend.ts) for sandboxed backend access.

import { invokeBackend } from "../../../src/api/backend";
import type { ControlMetadata, ControlEntry } from "./types";

// ============================================================================
// Control Metadata CRUD
// ============================================================================

/** Get control metadata for a specific cell. Returns null if no control exists. */
export async function getControlMetadata(
  sheetIndex: number,
  row: number,
  col: number,
): Promise<ControlMetadata | null> {
  return invokeBackend<ControlMetadata | null>("get_control_metadata", {
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
  return invokeBackend<ControlMetadata>("set_control_property", {
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
  return invokeBackend<ControlMetadata>("set_control_metadata", {
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
  return invokeBackend<boolean>("remove_control_metadata", {
    sheetIndex,
    row,
    col,
  });
}

/** Get all controls for a specific sheet. */
export async function getAllControls(
  sheetIndex: number,
): Promise<ControlEntry[]> {
  return invokeBackend<ControlEntry[]>("get_all_controls", { sheetIndex });
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
  return invokeBackend<Record<string, string>>("resolve_control_properties", {
    sheetIndex,
    row,
    col,
  });
}
