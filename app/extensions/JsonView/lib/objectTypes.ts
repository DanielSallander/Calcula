//! FILENAME: app/extensions/JsonView/lib/objectTypes.ts
// PURPOSE: Object type metadata for the JSON View extension.
// CONTEXT: Defines display names, icons, and categories for each object type.

export interface ObjectTypeInfo {
  /** The object_type string used in Tauri commands. */
  type: string;
  /** Human-readable display name. */
  displayName: string;
  /** Category for grouping in tree view (Phase B). */
  category: string;
}

/**
 * Registry of all supported object types.
 */
export const OBJECT_TYPES: Record<string, ObjectTypeInfo> = {
  theme: { type: "theme", displayName: "Document Theme", category: "Workbook" },
  properties: { type: "properties", displayName: "Workbook Properties", category: "Workbook" },
  chart: { type: "chart", displayName: "Chart", category: "Charts" },
  table: { type: "table", displayName: "Table", category: "Tables" },
  slicer: { type: "slicer", displayName: "Slicer", category: "Slicers" },
  ribbon_filter: { type: "ribbon_filter", displayName: "Ribbon Filter", category: "Filters" },
  timeline_slicer: { type: "timeline_slicer", displayName: "Timeline Slicer", category: "Slicers" },
  sparkline: { type: "sparkline", displayName: "Sparkline", category: "Charts" },
  script: { type: "script", displayName: "Script", category: "Scripts" },
  notebook: { type: "notebook", displayName: "Notebook", category: "Scripts" },
  pivot_layout: { type: "pivot_layout", displayName: "Pivot Layout", category: "Pivots" },
};

/**
 * Get display name for an object type.
 */
export function getObjectTypeName(objectType: string): string {
  return OBJECT_TYPES[objectType]?.displayName ?? objectType;
}
