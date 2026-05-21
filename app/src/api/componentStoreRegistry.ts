//! FILENAME: app/src/api/componentStoreRegistry.ts
// PURPOSE: IoC registry for component object stores (Slicer, Chart, Pivot).
// CONTEXT: The API layer cannot import from extensions. Extensions register their
//          store functions here at activation time, and the scriptable object
//          contexts use these registered functions to access component data.

// ============================================================================
// Slicer Store Interface
// ============================================================================

export interface ISlicerStoreService {
  getSlicerById(id: number): { name: string; selectedItems: string[] | null; fieldName: string; sourceType: string; columns: number } | undefined;
  getSelectedItems(slicerId: number): string[];
  setSelectedItems(slicerId: number, items: string[] | null): Promise<void>;
  getCachedItems(slicerId: number): Array<{ text: string; hasData: boolean }> | undefined;
}

// ============================================================================
// Chart Store Interface
// ============================================================================

export interface IChartStoreService {
  getChartById(id: number): { specJson: string } | null;
  updateChartSpec(chartId: number, specUpdates: Record<string, unknown>): void;
}

// ============================================================================
// Pivot Store Interface
// ============================================================================

export interface IPivotStoreService {
  getPivotFields(pivotId: number): { rows: string[]; columns: string[]; values: string[]; filters: string[] };
  refreshPivot(pivotId: number): Promise<void>;
}

// ============================================================================
// Registry
// ============================================================================

let slicerStore: ISlicerStoreService | null = null;
let chartStore: IChartStoreService | null = null;
let pivotStore: IPivotStoreService | null = null;

export function registerSlicerStoreService(service: ISlicerStoreService): void {
  slicerStore = service;
}

export function registerChartStoreService(service: IChartStoreService): void {
  chartStore = service;
}

export function registerPivotStoreService(service: IPivotStoreService): void {
  pivotStore = service;
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
