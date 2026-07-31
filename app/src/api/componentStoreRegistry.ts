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
  /** Every slicer in the workbook, as identity-only rows (B3 enumeration).
   *  Never the cached ITEMS — that is data, and reading it is a separate call. */
  listSlicers(): Array<{ id: string; name: string; sheetIndex: number; fieldName: string; sourceType: string }>;
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

/** Where a newly created chart is placed on its sheet (pixels, sheet-relative).
 *  Every field is optional — the Charts extension supplies its insert defaults
 *  for whatever the caller omits. */
export interface ChartPlacement {
  name?: string;
  sheetIndex?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface IChartStoreService {
  getChartById(id: string): { specJson: string } | null;
  /** Every chart in the workbook, with its STORED definition JSON (B3
   *  enumeration). The spec stays opaque here — the ChartSpec schema lives in
   *  the Charts extension, so the caller only parses what it needs. */
  listCharts(): Array<{ chartId: string; name: string; sheetIndex: number; specJson: string }>;
  /** Create a chart from a full ChartSpec and place it. Validates the spec
   *  against the ChartSpec schema (throws on a violation), registers the grid
   *  region and announces the new chart exactly as the Insert Chart dialog
   *  does. Returns the new chart's stable id. */
  createChart(fullSpec: Record<string, unknown>, placement?: ChartPlacement): string;
  /** Delete a chart (undoable through the extension's own delete trash).
   *  Returns false when no chart has that id. */
  deleteChart(chartId: string): boolean;
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
  /** Connect a connection to its database. Pass remember=false to skip
   *  caching the credentials for later auto-connect (default: remember). */
  connect(connectionId: string, remember?: boolean): Promise<ConnectionInfo>;
  /** Update connection properties (e.g. provide credentials). */
  updateConnection(request: UpdateConnectionRequest): Promise<ConnectionInfo>;
}

// ============================================================================
// Pane Control Store Interface
// ============================================================================

/**
 * Access to CELL-ANCHORED form controls (buttons, checkboxes, shapes),
 * registered by the Controls extension. These are the objects an object script
 * mounts as objectType "shape"/"button" (instanceId "control-{sheet}-{row}-{col}"),
 * so this is what api.listObjects("shape") enumerates. Read-only: creating a
 * control is a canvas-placement gesture, not a data operation.
 */
export interface IControlStoreService {
  /** Every control on ONE sheet, as identity + anchor rows. Never the property
   *  VALUES (those can be formulas over the user's data — a separate read). */
  listControls(sheetIndex: number): Promise<Array<{
    sheetIndex: number;
    row: number;
    col: number;
    controlType: string;
    name?: string;
  }>>;
}

/** Access to pane controls (Controls pane), registered by the ControlsPane
 *  extension. Lets the script host seed a pane-hosted custom control's shape
 *  script with its declared properties (instanceId "pane-{controlId}") without
 *  importing the extension directly. */
export interface IPaneControlStoreService {
  /** Declared property values for a pane control (Custom config), or undefined
   *  if the control doesn't exist. Keyed by property name. */
  getProperties(controlId: string): Record<string, string> | undefined;
}

// ============================================================================
// Registry
// ============================================================================

let slicerStore: ISlicerStoreService | null = null;
let timelineStore: ITimelineStoreService | null = null;
let chartStore: IChartStoreService | null = null;
let pivotStore: IPivotStoreService | null = null;
let biConnectionService: IBiConnectionService | null = null;
let controlStore: IControlStoreService | null = null;
let paneControlStore: IPaneControlStoreService | null = null;

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

export function registerControlStoreService(service: IControlStoreService | null): void {
  controlStore = service;
}

export function getControlStoreService(): IControlStoreService | null {
  return controlStore;
}

export function registerPaneControlStoreService(service: IPaneControlStoreService | null): void {
  paneControlStore = service;
}

export function getPaneControlStoreService(): IPaneControlStoreService | null {
  return paneControlStore;
}
