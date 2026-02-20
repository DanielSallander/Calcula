//! FILENAME: app/extensions/ConditionalFormatting/types.ts
// PURPOSE: Extension-internal types for conditional formatting state management.

import type {
  ConditionalFormatDefinition,
  CellConditionalFormat,
} from "../../src/api";

/** Internal state for the conditional formatting extension */
export interface CFState {
  /** All CF rules for the current sheet (cached from backend) */
  rules: ConditionalFormatDefinition[];
  /** Cached evaluation results: Map<"row,col", CellConditionalFormat[]> */
  evaluationCache: Map<string, CellConditionalFormat[]>;
  /** Current viewport range being tracked for evaluation */
  viewportRange: {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
  } | null;
  /** Whether evaluation is dirty and needs refresh */
  dirty: boolean;
}

/** Preset format style for quick-apply actions */
export interface PresetFormat {
  label: string;
  backgroundColor: string;
  textColor: string;
}

/** Well-known preset styles matching Excel's quick formats */
export const PRESET_STYLES: PresetFormat[] = [
  { label: "Light Red Fill with Dark Red Text", backgroundColor: "#FFC7CE", textColor: "#9C0006" },
  { label: "Yellow Fill with Dark Yellow Text", backgroundColor: "#FFEB9C", textColor: "#9C5700" },
  { label: "Green Fill with Dark Green Text", backgroundColor: "#C6EFCE", textColor: "#006100" },
  { label: "Light Red Fill", backgroundColor: "#FFC7CE", textColor: "" },
  { label: "Red Text", backgroundColor: "", textColor: "#9C0006" },
  { label: "Red Border", backgroundColor: "", textColor: "" },
];

/** Preset color scale configurations */
export interface PresetColorScale {
  label: string;
  minColor: string;
  midColor?: string;
  maxColor: string;
}

export const PRESET_COLOR_SCALES: PresetColorScale[] = [
  { label: "Green - Yellow - Red", minColor: "#63BE7B", midColor: "#FFEB84", maxColor: "#F8696B" },
  { label: "Red - Yellow - Green", minColor: "#F8696B", midColor: "#FFEB84", maxColor: "#63BE7B" },
  { label: "Green - White - Red", minColor: "#63BE7B", midColor: "#FFFFFF", maxColor: "#F8696B" },
  { label: "Red - White - Green", minColor: "#F8696B", midColor: "#FFFFFF", maxColor: "#63BE7B" },
  { label: "White - Red", minColor: "#FFFFFF", maxColor: "#F8696B" },
  { label: "Red - White", minColor: "#F8696B", maxColor: "#FFFFFF" },
  { label: "Green - White", minColor: "#63BE7B", maxColor: "#FFFFFF" },
  { label: "White - Green", minColor: "#FFFFFF", maxColor: "#63BE7B" },
];

/** Preset data bar colors */
export const PRESET_DATA_BAR_COLORS: string[] = [
  "#638EC6", // Blue (default)
  "#63C384", // Green
  "#FF555A", // Red
  "#FFB628", // Orange
  "#008AEF", // Light Blue
  "#D6007B", // Purple
];
