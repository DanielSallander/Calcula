//! FILENAME: app/extensions/FilterPane/lib/filterPaneTypes.ts
// PURPOSE: TypeScript types mirroring Rust ribbon_filter types.

export type RibbonFilterScope = "workbook" | "sheet";
export type RibbonFilterDisplayMode = "checklist" | "buttons" | "dropdown";
export type SlicerSourceType = "table" | "pivot" | "biConnection";

export interface SlicerConnection {
  sourceType: SlicerSourceType;
  sourceId: number;
}

export interface RibbonFilter {
  id: number;
  name: string;
  scope: RibbonFilterScope;
  sheetIndex: number | null;
  sourceType: SlicerSourceType;
  cacheSourceId: number;
  fieldName: string;
  connectedSources: SlicerConnection[];
  displayMode: RibbonFilterDisplayMode;
  selectedItems: string[] | null;
  crossFilterEnabled: boolean;
  collapsed: boolean;
  order: number;
  buttonColumns: number;
  buttonRows: number;
}

export interface SlicerItem {
  value: string;
  selected: boolean;
  hasData: boolean;
}

export interface CreateRibbonFilterParams {
  name: string;
  scope: RibbonFilterScope;
  sheetIndex?: number | null;
  sourceType: SlicerSourceType;
  cacheSourceId: number;
  fieldName: string;
  connectedSources?: SlicerConnection[];
  displayMode?: RibbonFilterDisplayMode;
  order?: number;
}

export interface UpdateRibbonFilterParams {
  name?: string;
  scope?: RibbonFilterScope;
  sheetIndex?: number | null;
  displayMode?: RibbonFilterDisplayMode;
  collapsed?: boolean;
  order?: number;
  buttonColumns?: number;
  buttonRows?: number;
  crossFilterEnabled?: boolean;
  connectedSources?: SlicerConnection[];
}
