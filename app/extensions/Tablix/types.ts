//! FILENAME: app/extensions/Tablix/types.ts
// PURPOSE: Type definitions for the Tablix extension.
// CONTEXT: Re-exports types from API and defines extension-specific types.

import type { AggregationType } from '../../src/api';

// Re-export shared types
export type { AggregationType };

export type TablixId = number;

/** Data field mode: aggregated (summarized) or detail (raw rows) */
export type DataFieldMode = 'aggregated' | 'detail';

/** Group layout: how row groups are arranged */
export type GroupLayout = 'stepped' | 'block';

/**
 * Source field from the tablix's data source.
 */
export interface SourceField {
  index: number;
  name: string;
  isNumeric: boolean;
}

/**
 * Zone field info for the tablix editor.
 */
export interface ZoneField {
  sourceIndex: number;
  name: string;
  isNumeric: boolean;
  /** Data field mode (for data fields) */
  mode?: DataFieldMode;
  /** Aggregation type (for aggregated data fields) */
  aggregation?: string;
}

/**
 * Tablix layout configuration.
 */
export interface TablixLayoutConfig {
  showRowGrandTotals?: boolean;
  showColumnGrandTotals?: boolean;
  groupLayout?: GroupLayout;
  repeatGroupLabels?: boolean;
  showEmptyGroups?: boolean;
}

/**
 * Data passed to the TablixEditorView component.
 */
export interface TablixEditorViewData {
  tablixId: TablixId;
  sourceFields: SourceField[];
  initialRowGroups: ZoneField[];
  initialColumnGroups: ZoneField[];
  initialDataFields: ZoneField[];
  initialFilters: ZoneField[];
  initialLayout: Partial<TablixLayoutConfig>;
}

/**
 * Tablix region data for rendering.
 */
export interface TablixRegionData {
  tablixId: TablixId;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  isEmpty: boolean;
}
