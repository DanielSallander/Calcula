//! FILENAME: app/src/api/jsonView.ts
// PURPOSE: API facade for JSON View extension — generic object inspection/editing.
// CONTEXT: Wraps Tauri commands for get/set/list of any workbook object as JSON.

import { invokeBackend } from "./backend";

// ============================================================================
// Types
// ============================================================================

export interface ObjectEntry {
  objectType: string;
  objectId: string;
  label: string;
}

export interface TreeNode {
  label: string;
  objectType: string | null;
  objectId: string | null;
  children: TreeNode[];
}

// ============================================================================
// Commands
// ============================================================================

/**
 * Get the JSON representation of a workbook object.
 * @param objectType - e.g. "chart", "table", "slicer", "theme", "properties"
 * @param objectId - The object's ID (as string)
 * @returns Pretty-printed JSON string
 */
export function getObjectJson(objectType: string, objectId: string): Promise<string> {
  return invokeBackend<string>("get_object_json", {
    objectType,
    objectId,
  });
}

/**
 * Replace a workbook object with the given JSON.
 * The JSON must deserialize to the correct Rust type.
 * @param objectType - e.g. "chart", "table", "slicer", "theme", "properties"
 * @param objectId - The object's ID (as string)
 * @param json - The new JSON string
 */
export function setObjectJson(objectType: string, objectId: string, json: string): Promise<void> {
  return invokeBackend<void>("set_object_json", {
    objectType,
    objectId,
    json,
  });
}

/**
 * List all configurable objects in the workbook.
 * Returns an array of { objectType, objectId, label } entries.
 */
export function listObjects(): Promise<ObjectEntry[]> {
  return invokeBackend<ObjectEntry[]>("list_objects");
}

/**
 * Get a tree representation of all workbook objects.
 * Returns a hierarchical tree mirroring the .cala structure.
 */
export function getWorkbookTree(): Promise<TreeNode> {
  return invokeBackend<TreeNode>("get_workbook_tree");
}
