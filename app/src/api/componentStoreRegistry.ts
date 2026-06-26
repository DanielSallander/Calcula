//! FILENAME: app/src/api/componentStoreRegistry.ts
// PURPOSE: IoC registry for component object stores (Slicer, Chart, Pivot, BI).
// CONTEXT: The API layer cannot import from extensions, and extensions must not
//          import each other. Extensions register their store/service functions
//          here at activation time; consumers (scriptable object contexts, other
//          extensions) access them through these registered functions.

import type { BiPivotModelInfo } from "./pivot";
import type { ConnectionInfo, UpdateConnectionRequest } from "./backend";

// ============================================================================
// Slicer Store Interface
// ============================================================================

export interface ISlicerStoreService {
  getSlicerById(id: string): { name: string; selectedItems: string[] | null; fieldName: string; sourceType: string; columns: number } | undefined;
  getSelectedItems(slicerId: string): string[];
  setSelectedItems(slicerId: string, items: string[] | null): Promise<void>;
  getCachedItems(slicerId: string): Array<{ text: string; hasData: boolean }> | undefined;
  /** Register a custom item renderer for a slicer. Returns cleanup function. */
  setItemRenderer(slicerId: string, renderer: ((
    item: { text: string; selected: boolean; hasData: boolean; index: number },
    ctx: CanvasRenderingContext2D,
    bounds: { x: number; y: number; width: number; height: number },
  ) => void) | null): () => void;
  /** Set a canvas-style property override on a slicer. */
  setStyleProperty(slicerId: string, name: string, value: string): void;
}

// ============================================================================
// Timeline Store Interface
// ============================================================================

/** Access to timeline (date-range) slicers, registered by the TimelineSlicer
 *  extension. Lets scriptable timeline contexts read/write the selected date
 *  range without importing the extension directly. Dates are ISO "YYYY-MM-DD"
 *  or null (no bound = open-ended / all dates). */
export interface ITimelineStoreService {
  getTimelineById(id: string): {
    name: string;
    selectionStart: string | null;
    selectionEnd: string | null;
    fieldName: string;
    level: string;
    sourceType: string;
  } | undefined;
  getSelection(timelineId: string): { start: string | null; end: string | null };
  setSelection(timelineId: string, start: string | null, end: string | null): Promise<void>;
}

// ============================================================================
// Chart Store Interface
// ============================================================================

export interface IChartStoreService {
  getChartById(id: string): { specJson: string } | null;
  /** Deep-merge a partial patch into the chart's spec. Validates the merged
   *  result against the ChartSpec schema; throws on a schema violation. */
  updateChartSpec(chartId: string, specUpdates: Record<string, unknown>): void;
  /** Replace the chart's entire spec (full re-author). Validates the spec against
   *  the ChartSpec schema; throws on a schema violation. */
  replaceChartSpec(chartId: string, fullSpec: Record<string, unknown>): void;
  /** Set a canvas-style property override on a chart. */
  setStyleProperty(chartId: string, name: string, value: string): void;
}

// ============================================================================
// Pivot Store Interface
// ============================================================================

export interface IPivotStoreService {
  getPivotFields(pivotId: string): { rows: string[]; columns: string[]; values: string[]; filters: string[] };
  refreshPivot(pivotId: string): Promise<void>;
  /** Open the Pivot editor pane for a freshly created BI-backed pivot.
   *  Used by the BusinessIntelligence extension after create_pivot_from_bi_model. */
  openBiPivotEditor(pivotId: string, biModel: BiPivotModelInfo): void;
}

// ============================================================================
// BI Connection Service Interface
// ============================================================================

/** Access to BI connections, registered by the BusinessIntelligence extension.
 *  Lets other extensions (e.g. Pivot's connection banner/badge) read and manage
 *  connections without importing the BI extension directly. */
export interface IBiConnectionService {
  /** Get all connections (cached by the BI extension). */
  getConnections(): Promise<ConnectionInfo[]>;
  /** Connect a connection to its database. */
  connect(connectionId: string): Promise<ConnectionInfo>;
  /** Update connection properties (e.g. provide credentials). */
  updateConnection(request: UpdateConnectionRequest): Promise<ConnectionInfo>;
}

// ============================================================================
// Registry
// ============================================================================

let slicerStore: ISlicerStoreService | null = null;
let timelineStore: ITimelineStoreService | null = null;
let chartStore: IChartStoreService | null = null;
let pivotStore: IPivotStoreService | null = null;
let biConnectionService: IBiConnectionService | null = null;

export function registerSlicerStoreService(service: ISlicerStoreService): void {
  slicerStore = service;
}

export function registerTimelineStoreService(service: ITimelineStoreService): void {
  timelineStore = service;
}

export function getTimelineStoreService(): ITimelineStoreService | null {
  return timelineStore;
}

export function registerChartStoreService(service: IChartStoreService): void {
  chartStore = service;
}

export function registerPivotStoreService(service: IPivotStoreService): void {
  pivotStore = service;
}

export function registerBiConnectionService(service: IBiConnectionService): void {
  biConnectionService = service;
}

export function getSlicerStoreService(): ISlicerStoreService | null {
  return slicerStore;
}

export function getChartStoreService(): IChartStoreService | null {
  return chartStore;
}

export function getPivotStoreService(): IPivotStoreService | null {
  return pivotStore;
}

export function getBiConnectionService(): IBiConnectionService | null {
  return biConnectionService;
}
