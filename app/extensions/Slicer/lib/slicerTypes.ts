//! FILENAME: app/extensions/Slicer/lib/slicerTypes.ts
// PURPOSE: TypeScript interfaces mirroring Rust slicer types.

export type SlicerSourceType = "table" | "pivot";

export interface Slicer {
  id: number;
  name: string;
  sheetIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  sourceType: SlicerSourceType;
  sourceId: number;
  fieldName: string;
  selectedItems: string[] | null;
  showHeader: boolean;
  columns: number;
  stylePreset: string;
}

export interface SlicerItem {
  value: string;
  selected: boolean;
  hasData: boolean;
}

export interface CreateSlicerParams {
  name: string;
  sheetIndex: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
  sourceType: SlicerSourceType;
  sourceId: number;
  fieldName: string;
  columns?: number;
  stylePreset?: string;
}

export interface UpdateSlicerParams {
  name?: string;
  showHeader?: boolean;
  columns?: number;
  stylePreset?: string;
}
