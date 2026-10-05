//! FILENAME: app/extensions/ConditionalFormatting/types.ts
// PURPOSE: Extension-internal types for conditional formatting state management,
//          and the preset DATA the galleries and dialogs offer.
// CONTEXT: Every preset below is Excel's, read from live Excel 16 (M365) on
//          2026-10-04 -- a fresh unsaved workbook driven over COM + UI
//          Automation (scratchpad styles-probe/cfprobe.ps1): the gallery names
//          in gallery order, and for the colour scales the rule each item
//          WRITES (FormatConditions(1).ColorScaleCriteria, item by item). The
//          colours are DATA -- the colours ARE the presets -- so their literals
//          stay; the chrome that shows them paints with @api/layout tokens.

import type {
  ConditionalFormatDefinition,
  CellConditionalFormat,
  IconSetType,
  TimePeriod,
} from "@api";

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

// ============================================================================
// Color Scales
// ============================================================================

/**
 * One Color Scales preset. Excel names a scale from the HIGHEST value down
 * ("Green - Yellow - Red": high values green, low values red; the gallery
 * picture has green on top), so `maxColor` is the FIRST colour of the label.
 * The previous presets had every scale upside down -- min green, max red under
 * the label "Green - Yellow - Red" -- so the first pick a user made painted
 * their best numbers red.
 */
export interface PresetColorScale {
  /** "Green - Yellow - Red" -- Excel's name without " Color Scale". */
  label: string;
  /** The lowest value's colour. */
  minColor: string;
  /** The 50th percentile's colour (3-colour scales only). */
  midColor?: string;
  /** The highest value's colour. */
  maxColor: string;
}

/** Excel's gallery tooltip for a preset: "Green - Yellow - Red Color Scale". */
export function colorScaleName(preset: PresetColorScale): string {
  return `${preset.label} Color Scale`;
}

/** Excel's twelve, in gallery order (four per row) [LIVE 2026-10-04]. */
export const PRESET_COLOR_SCALES: PresetColorScale[] = [
  { label: "Green - Yellow - Red", minColor: "#F8696B", midColor: "#FFEB84", maxColor: "#63BE7B" },
  { label: "Red - Yellow - Green", minColor: "#63BE7B", midColor: "#FFEB84", maxColor: "#F8696B" },
  { label: "Green - White - Red", minColor: "#F8696B", midColor: "#FCFCFF", maxColor: "#63BE7B" },
  { label: "Red - White - Green", minColor: "#63BE7B", midColor: "#FCFCFF", maxColor: "#F8696B" },
  { label: "Blue - White - Red", minColor: "#F8696B", midColor: "#FCFCFF", maxColor: "#5A8AC6" },
  { label: "Red - White - Blue", minColor: "#5A8AC6", midColor: "#FCFCFF", maxColor: "#F8696B" },
  { label: "White - Red", minColor: "#F8696B", maxColor: "#FCFCFF" },
  { label: "Red - White", minColor: "#FCFCFF", maxColor: "#F8696B" },
  { label: "Green - White", minColor: "#FCFCFF", maxColor: "#63BE7B" },
  { label: "White - Green", minColor: "#63BE7B", maxColor: "#FCFCFF" },
  { label: "Green - Yellow", minColor: "#FFEF9C", maxColor: "#63BE7B" },
  { label: "Yellow - Green", minColor: "#63BE7B", maxColor: "#FFEF9C" },
];

// ============================================================================
// Data Bars
// ============================================================================

/** One Data Bars colour, by Excel's gallery name. */
export interface PresetDataBar {
  name: string;
  color: string;
}

/** Excel's six, in gallery order; each is offered as a Gradient Fill and as a
 *  Solid Fill bar [LIVE 2026-10-04 for the names and order]. */
export const PRESET_DATA_BARS: PresetDataBar[] = [
  { name: "Blue Data Bar", color: "#638EC6" },
  { name: "Green Data Bar", color: "#63C384" },
  { name: "Red Data Bar", color: "#FF555A" },
  { name: "Orange Data Bar", color: "#FFB628" },
  { name: "Light Blue Data Bar", color: "#008AEF" },
  { name: "Purple Data Bar", color: "#D6007B" },
];

/** The bar colours alone, in the same order (New Rule's colour list). */
export const PRESET_DATA_BAR_COLORS: string[] = PRESET_DATA_BARS.map((bar) => bar.color);

// ============================================================================
// Icon Sets
// ============================================================================

export interface IconSetEntry {
  id: IconSetType;
  /** Excel's gallery name. */
  label: string;
  /** Number of icons in the set. */
  count: number;
}

export interface IconSetCategory {
  label: string;
  sets: IconSetEntry[];
}

/**
 * Excel's Icon Sets gallery, group by group [LIVE 2026-10-04]. Two corrections
 * against what was here: 5 Quarters is a RATING (it sat under Shapes), and
 * Excel lists each Gray arrow set before its Colored one from 4 arrows up.
 */
export const ICON_SET_CATEGORIES: IconSetCategory[] = [
  {
    label: "Directional",
    sets: [
      { id: "threeArrows", label: "3 Arrows (Colored)", count: 3 },
      { id: "threeArrowsGray", label: "3 Arrows (Gray)", count: 3 },
      { id: "threeTriangles", label: "3 Triangles", count: 3 },
      { id: "fourArrowsGray", label: "4 Arrows (Gray)", count: 4 },
      { id: "fourArrows", label: "4 Arrows (Colored)", count: 4 },
      { id: "fiveArrowsGray", label: "5 Arrows (Gray)", count: 5 },
      { id: "fiveArrows", label: "5 Arrows (Colored)", count: 5 },
    ],
  },
  {
    label: "Shapes",
    sets: [
      { id: "threeTrafficLights1", label: "3 Traffic Lights (Unrimmed)", count: 3 },
      { id: "threeTrafficLights2", label: "3 Traffic Lights (Rimmed)", count: 3 },
      { id: "threeSigns", label: "3 Signs", count: 3 },
      { id: "fourTrafficLights", label: "4 Traffic Lights", count: 4 },
      { id: "fourRedToBlack", label: "Red To Black", count: 4 },
    ],
  },
  {
    label: "Indicators",
    sets: [
      { id: "threeSymbols", label: "3 Symbols (Circled)", count: 3 },
      { id: "threeSymbols2", label: "3 Symbols (Uncircled)", count: 3 },
      { id: "threeFlags", label: "3 Flags", count: 3 },
    ],
  },
  {
    label: "Ratings",
    sets: [
      { id: "threeStars", label: "3 Stars", count: 3 },
      { id: "fourRating", label: "4 Ratings", count: 4 },
      { id: "fiveQuarters", label: "5 Quarters", count: 5 },
      { id: "fiveRating", label: "5 Ratings", count: 5 },
      { id: "fiveBoxes", label: "5 Boxes", count: 5 },
    ],
  },
];

// ============================================================================
// A Date Occurring
// ============================================================================

/**
 * The periods Excel's "A Date Occurring" dialog (and New Rule's "Dates
 * Occurring") offers, in its order, Yesterday first and preselected -- read
 * from the live dialog's combo box on 2026-10-04, spelling included: Excel
 * itself writes "This Month" with a capital M among nine sentence-case
 * entries, and Calcula copies its words rather than correcting them. The
 * backend's TimePeriod also knows quarters and years; Excel's dialogs do not
 * offer them, so neither do these.
 */
export const DATE_OCCURRING_PERIODS: { value: TimePeriod; label: string }[] = [
  { value: "yesterday", label: "Yesterday" },
  { value: "today", label: "Today" },
  { value: "tomorrow", label: "Tomorrow" },
  { value: "last7Days", label: "In the last 7 days" },
  { value: "lastWeek", label: "Last week" },
  { value: "thisWeek", label: "This week" },
  { value: "nextWeek", label: "Next week" },
  { value: "lastMonth", label: "Last month" },
  { value: "thisMonth", label: "This Month" },
  { value: "nextMonth", label: "Next month" },
];

// ============================================================================
// New Rule's starting page
// ============================================================================

/** The rule types New Rule lists, in Excel's order. */
export type NewRuleCategory =
  | "formatByValues"
  | "formatContaining"
  | "topBottom"
  | "aboveBelow"
  | "uniqueDuplicate"
  | "formula";

/** "Format all cells based on their values" has three format styles. */
export type NewRuleFormatStyle = "colorScale" | "dataBar" | "iconSet";

/**
 * What a door may hand New Rule (`showDialog(NEW_RULE_DIALOG_ID, data)`):
 * the range the rule covers, and where the dialog opens. Excel opens it on
 * "Format only cells that contain" from the item and from Highlight Cells
 * Rules > More Rules..., on the ranked-values page from Top/Bottom Rules >
 * More Rules..., and on "based on their values" -- with the gallery's own
 * format style -- from each gallery's More Rules....
 */
export interface NewRuleDialogData {
  selection: { startRow: number; startCol: number; endRow: number; endCol: number } | null;
  initialCategory?: NewRuleCategory;
  initialFormatStyle?: NewRuleFormatStyle;
}
