//! FILENAME: app/extensions/pivot/types.ts
// PURPOSE: Type definitions for the pivot extension.
// CONTEXT: Re-exports types from API and defines extension-specific types.

import type { LayoutConfig, AggregationType } from "../../src/api";

// Re-export types from API that the extension uses
export type { LayoutConfig, AggregationType };

/**
 * Source field from the pivot table's data source.
 */
export interface SourceField {
  index: number;
  name: string;
  isNumeric: boolean;
}

/**
 * Field assigned to a zone (rows, columns, values, filters).
 */
export interface ZoneField {
  sourceIndex: number;
  name: string;
  isNumeric: boolean;
  aggregation?: AggregationType;
}

/**
 * Data passed to the PivotEditorView component.
 */
export interface PivotEditorViewData {
  pivotId: number;
  sourceFields: SourceField[];
  initialRows: ZoneField[];
  initialColumns: ZoneField[];
  initialValues: ZoneField[];
  initialFilters: ZoneField[];
  initialLayout: Partial<LayoutConfig>;
}

/**
 * Pivot region data for rendering.
 */
export interface PivotRegionData {
  pivotId: number;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  isEmpty: boolean;
}
