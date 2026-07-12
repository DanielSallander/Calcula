//! FILENAME: app/src/api/pivotTypes.ts
// PURPOSE: The Pivot Table contract types. Owned by the API facade so the
//          facade never imports a specific extension (No First-Class Citizens).
//          The Pivot extension's pivot-api re-exports these; the implementation
//          is registered into @api/pivot via registerPivotApi (IoC).
// NOTE: CalculatedFieldDef / ValueColumnRefDef are intentionally also defined
//       here (small, structurally-identical copies of the editor types in
//       extensions/Pivot/components/types.ts) so the contract is self-contained.

import type { BiHierarchyMeta } from "./backend";

/** Inline calculated field definition. */
export interface CalculatedFieldDef {
  name: string;
  formula: string;
  numberFormat?: string;
}

/** Reference to a value or calculated field in the unified column ordering. */
export type ValueColumnRefDef =
  | { type: 'value'; index: number }
  | { type: 'calculated'; index: number };

/** Interactive hit-test regions painted over a pivot (icons/filter buttons). */
export interface PivotInteractiveBounds {
  expandCollapseIcons: Map<string, {
    x: number;
    y: number;
    width: number;
    height: number;
    row: number;
    col: number;
    isExpanded: boolean;
    isRow: boolean;
  }>;
  filterButtons: Map<string, {
    x: number;
    y: number;
    width: number;
    height: number;
    fieldIndex: number;
    row: number;
    col: number;
  }>;
  headerFilterButtons: Map<string, {
    x: number;
    y: number;
    width: number;
    height: number;
    zone: 'row' | 'column';
    row: number;
    col: number;
  }>;
}

// ============================================================================
// Types
// ============================================================================

export type PivotId = string;

/** Sort order for pivot fields */
export type SortOrder = "asc" | "desc" | "manual" | "source";

/** Aggregation types for value fields */
export type AggregationType =
  | "sum"
  | "count"
  | "average"
  | "min"
  | "max"
  | "countnumbers"
  | "stddev"
  | "stddevp"
  | "var"
  | "varp"
  | "product";

/** How to display calculated values */
export type ShowValuesAs =
  | "normal"
  | "percent_of_total"
  | "percent_of_row"
  | "percent_of_column"
  | "percent_of_parent_row"
  | "percent_of_parent_column"
  | "difference"
  | "percent_difference"
  | "running_total"
  | "percent_of_running_total"
  | "rank_ascending"
  | "rank_descending"
  | "index";

/** Report layout styles */
export type ReportLayout = "compact" | "outline" | "tabular";

/** Where to place multiple value fields */
export type ValuesPosition = "columns" | "rows";

/** Request to create a new pivot table */
export interface CreatePivotRequest {
  /** Source range in A1 notation (e.g., "A1:D100") */
  sourceRange: string;
  /** Destination cell in A1 notation (e.g., "F1") */
  destinationCell: string;
  /** Optional: sheet index for source data (defaults to active sheet) */
  sourceSheet?: number;
  /** Optional: sheet index for destination (defaults to active sheet) */
  destinationSheet?: number;
  /** Whether first row contains headers (default: true) */
  hasHeaders?: boolean;
  /** Optional: friendly name for the pivot table */
  name?: string;
  /** Optional: source table name (for table-backed pivots) */
  sourceTableName?: string;
}

/** Field configuration for row/column areas */
export interface PivotFieldConfig {
  /** Source column index (0-based) */
  sourceIndex: number;
  /** Display name */
  name: string;
  /** Sort order */
  sortOrder?: SortOrder;
  /** Whether to show subtotals */
  showSubtotals?: boolean;
  /** Whether field is collapsed (field-level: collapses ALL items) */
  collapsed?: boolean;
  /** Items to hide (filter out) */
  hiddenItems?: string[];
  /** Per-item collapse tracking: specific item labels that are collapsed */
  collapsedItems?: string[];
  /** Whether to show all items (including items with no data) */
  showAllItems?: boolean;
  /** Grouping configuration for this field */
  grouping?: FieldGroupingConfig;
}

/** Value field configuration */
/** Show-as calculation types matching Excel's ShowAsCalculation */
export type ShowAsCalculation =
  | "none"
  | "percentOfGrandTotal"
  | "percentOfRowTotal"
  | "percentOfColumnTotal"
  | "percentOfParentRowTotal"
  | "percentOfParentColumnTotal"
  | "differenceFrom"
  | "percentDifferenceFrom"
  | "runningTotal"
  | "percentOfRunningTotal"
  | "rankAscending"
  | "rankDescending"
  | "index";

/** Rule for showing values as a calculation (Excel-compatible) */
export interface ShowAsRule {
  calculation: ShowAsCalculation;
  baseField?: string;
  baseItem?: string;
}

export interface ValueFieldConfig {
  /** Source column index (0-based) */
  sourceIndex: number;
  /** Display name */
  name: string;
  /** Aggregation type */
  aggregation: AggregationType;
  /** Number format string */
  numberFormat?: string;
  /** Show values as (simple string form) */
  showValuesAs?: ShowValuesAs;
  /** Show as rule with base field/item (Excel-compatible form) */
  showAs?: ShowAsRule;
  /** User-provided custom display name override. */
  customName?: string;
}

/** Layout configuration */
export interface LayoutConfig {
  showRowGrandTotals?: boolean;
  showColumnGrandTotals?: boolean;
  reportLayout?: ReportLayout;
  repeatRowLabels?: boolean;
  showEmptyRows?: boolean;
  showEmptyCols?: boolean;
  valuesPosition?: ValuesPosition;
  autoFitColumnWidths?: boolean;
}

/** Request to update pivot table fields */
export interface UpdatePivotFieldsRequest {
  /** Pivot table ID */
  pivotId: PivotId;
  /** Row fields (optional - if undefined, keep existing) */
  rowFields?: PivotFieldConfig[];
  /** Column fields (optional) */
  columnFields?: PivotFieldConfig[];
  /** Value fields (optional) */
  valueFields?: ValueFieldConfig[];
  /** Filter fields (optional) */
  filterFields?: PivotFieldConfig[];
  /** Layout options (optional) */
  layout?: LayoutConfig;
  /** Calculated fields (replaces all when provided) */
  calculatedFields?: CalculatedFieldDef[];
  /** Unified column ordering for interleaving values and calculated fields */
  valueColumnOrder?: ValueColumnRefDef[];
}

/** Request to toggle a group's expand/collapse state */
export interface ToggleGroupRequest {
  /** Pivot table ID */
  pivotId: PivotId;
  /** Whether this is a row (true) or column (false) group */
  isRow: boolean;
  /** The field index to toggle */
  fieldIndex: number;
  /** The specific value to toggle (optional - if undefined, toggle all) */
  value?: string;
  /** Full group path for path-specific toggle: [fieldIndex, valueId] pairs.
   *  When provided, only the exact item at this path is toggled. */
  groupPath?: Array<[number, number]>;
}

/** Cell value — untagged for compact IPC serialization.
 * null = empty, number = numeric, string = text (errors prefixed with "#"),
 * boolean = true/false. */
export type PivotCellValue = number | string | boolean | null;

/** Cell type identifiers */
export type PivotCellType =
  | "Data"
  | "RowHeader"
  | "ColumnHeader"
  | "Corner"
  | "RowSubtotal"
  | "ColumnSubtotal"
  | "GrandTotal"
  | "GrandTotalRow"
  | "GrandTotalColumn"
  | "Blank"
  | "FilterLabel"
  | "FilterDropdown"
  | "RowLabelHeader"
  | "ColumnLabelHeader";

/** Background style for cells */
export type BackgroundStyle = 
  | "Normal" 
  | "Alternate" 
  | "Subtotal" 
  | "Total" 
  | "GrandTotal"
  | "Header"
  | "FilterRow";

/** Row type identifiers */
export type PivotRowType = "ColumnHeader" | "Data" | "Subtotal" | "GrandTotal" | "FilterRow";

/** Column type identifiers */
export type PivotColumnType = "RowLabel" | "Data" | "Subtotal" | "GrandTotal";

/** Cell data from the backend.
 * Fields with defaults (indentLevel, isBold, isExpandable, isCollapsed)
 * are omitted from the JSON payload when at their default value to reduce IPC size. */
export interface PivotCellData {
  cellType: PivotCellType;
  value: PivotCellValue;
  formattedValue?: string;
  indentLevel?: number;
  isBold?: boolean;
  isExpandable?: boolean;
  isCollapsed?: boolean;
  backgroundStyle: BackgroundStyle;
  numberFormat?: string;
  filterFieldIndex?: number;
  colSpan?: number;
  /** Group path for drill-down: [fieldIndex, valueId] pairs identifying this cell's data */
  groupPath?: Array<[number, number]>;
}

/** Row data from the backend */
export interface PivotRowData {
  viewRow: number;
  rowType: PivotRowType;
  depth: number;
  visible: boolean;
  cells: PivotCellData[];
}

/** Column descriptor from the backend */
export interface PivotColumnData {
  viewCol: number;
  colType: PivotColumnType;
  depth: number;
  widthHint: number;
  /** Longest display string in this column (with indent padding).
   * When present, the frontend measures this single string instead of
   * scanning all rows for column auto-sizing. */
  maxContentSample?: string;
}

/** Filter row metadata */
export interface FilterRowData {
  fieldIndex: number;
  fieldName: string;
  selectedValues: string[];
  uniqueValues: string[];
  displayValue: string;
  viewRow: number;
}

/** Summary info about a row or column field for header filter dropdowns */
export interface HeaderFieldSummary {
  fieldIndex: number;
  fieldName: string;
  hasActiveFilter: boolean;
}

/** Lightweight row descriptor for windowed responses (no cell data). */
export interface PivotRowDescriptorData {
  viewRow: number;
  rowType: PivotRowType;
  depth: number;
  visible: boolean;
}

/** Complete pivot view response */
export interface PivotViewResponse {
  pivotId: PivotId;
  version: number;
  rowCount: number;
  colCount: number;
  rowLabelColCount: number;
  columnHeaderRowCount: number;
  filterRowCount: number;
  filterRows: FilterRowData[];
  rowFieldSummaries: HeaderFieldSummary[];
  columnFieldSummaries: HeaderFieldSummary[];
  rows: PivotRowData[];
  columns: PivotColumnData[];
  /** True when the response contains only a window of cells (large pivots). */
  isWindowed?: boolean;
  /** For windowed responses: total number of rows in the full view. */
  totalRowCount?: number;
  /** For windowed responses: starting row index of the cell window. */
  windowStartRow?: number;
  /** For windowed responses: lightweight descriptors for ALL rows (no cells). */
  rowDescriptors?: PivotRowDescriptorData[];
  /** Number of non-empty cells outside the previous pivot region that were overwritten. */
  overwrittenCellCount?: number;
}

/** Response for a cell window fetch (scroll-triggered). */
export interface PivotCellWindowResponse {
  pivotId: PivotId;
  version: number;
  startRow: number;
  rows: PivotRowData[];
}

/** Source data response for drill-down */
export interface SourceDataResponse {
  pivotId: PivotId;
  headers: string[];
  rows: string[][];
  totalCount: number;
  isTruncated: boolean;
}

/** Group path for drill-down operations */
export type GroupPath = Array<[number, number]>;

 // [fieldIndex, valueId]

/** Source field info from pivot region check */
export interface SourceFieldInfo {
  index: number;
  name: string;
  isNumeric: boolean;
  tableName?: string;
}

/** Zone field info - represents a field assigned to a zone */
export interface ZoneFieldInfo {
  sourceIndex: number;
  name: string;
  isNumeric: boolean;
  /** Only present for value fields */
  aggregation?: string;
  /** Whether this is a LOOKUP (attribute) field rather than GROUP. BI pivots only. */
  isLookup?: boolean;
  /** Items hidden by the filter. Only present for filter fields with active filters. */
  hiddenItems?: string[];
  /** User-provided custom display name override. */
  customName?: string;
}

/** Current field configuration for the pivot editor */
export interface PivotFieldConfiguration {
  rowFields: ZoneFieldInfo[];
  columnFields: ZoneFieldInfo[];
  valueFields: ZoneFieldInfo[];
  filterFields: ZoneFieldInfo[];
  layout: LayoutConfig;
  calculatedFields?: { name: string; formula: string; numberFormat?: string }[];
  /** Hierarchy configs — which row/column fields belong to hierarchies
   *  so the frontend can reconstitute them as single items. */
  hierarchyConfigs?: HierarchyConfigInfo[];
}

/** Hierarchy config info (mirrors HierarchyConfigInfo in pivot/types.rs). */
export interface HierarchyConfigInfo {
  name: string;
  fieldStart: number;
  fieldCount: number;
  isRow: boolean;
}

/** Info about a filter dropdown cell position */
export interface FilterZoneInfo {
  row: number;
  col: number;
  fieldIndex: number;
  fieldName: string;
}

/** BI model info for the hierarchical field list */
export interface BiPivotModelInfo {
  /** The connection ID this pivot is associated with. */
  connectionId: string;
  tables: BiModelTable[];
  measures: BiMeasureFieldInfo[];
  /** All columns toggled to LOOKUP mode ("Table.Column" keys) */
  lookupColumns?: string[];
  /** Hierarchies defined in the BI model (drill-down paths). */
  hierarchies?: BiHierarchyMeta[];
  /** Calculation groups defined in the BI model. Items are measure templates
   *  applied on the Values axis, not groupable dimensions. */
  calculationGroups?: BiCalcGroup[];
  /** The calculation group currently applied to this pivot (None = none). */
  appliedCalculationGroup?: AppliedCalcGroup;
  /** ISO-8601 time this pivot's data was last fetched ("Data as of …"). */
  dataAsOf?: string;
  /** Perspectives defined in the BI model (field-list display subsets). */
  perspectives?: BiPerspectiveInfo[];
  /** The perspective selected for this pivot's field list (null = all). */
  selectedPerspective?: string | null;
}

/** A perspective: a named presentation subset of the model (display-only —
 *  not a security boundary; selecting one filters the field LIST, never the
 *  query). Mirrors Rust `BiPerspectiveMeta`. */
export interface BiPerspectiveInfo {
  name: string;
  /** Tables shown in full (all their columns). */
  tables: string[];
  /** Individually shown qualified `Table[column]` refs. */
  columns: string[];
  /** Measures shown. */
  measures: string[];
  description?: string | null;
}

export interface BiModelTable {
  name: string;
  columns: BiModelColumn[];
}

/** A calculation group surfaced in the field list (read-only in v1). */
export interface BiCalcGroup {
  name: string;
  items: BiCalcGroupItem[];
}

export interface BiCalcGroupItem {
  name: string;
  /** Source text of the item's template expression (display/diagnostic). */
  source?: string;
}

export interface BiModelColumn {
  name: string;
  dataType: string;
  isNumeric: boolean;
  /** True for a Studio-authored CONTEXT column (dynamic segmentation). Not a
   *  physical column, but groupable like an ordinary dimension. */
  isContextColumn?: boolean;
  /** Model-authored description (shown as a field-list tooltip). */
  description?: string;
}

export interface BiMeasureFieldInfo {
  name: string;
  table: string;
  sourceColumn: string;
  aggregation: AggregationType;
}

/** BI field reference (table + column) */
export interface BiFieldRef {
  table: string;
  column: string;
  /** When true, this field is a lookup column (resolved post-aggregation). */
  isLookup?: boolean;
}

/** BI value field reference (measure name) */
export interface BiValueFieldRef {
  measureName: string;
  customName?: string;
}

/** Request to create a BI model pivot */
export interface CreatePivotFromBiModelRequest {
  destinationCell: string;
  destinationSheet?: number;
  name?: string;
  /** The connection ID to use for this BI pivot. */
  connectionId: string;
}

/** Request to update BI pivot field assignments */
export interface UpdateBiPivotFieldsRequest {
  pivotId: PivotId;
  rowFields: BiFieldRef[];
  columnFields: BiFieldRef[];
  valueFields: BiValueFieldRef[];
  filterFields: BiFieldRef[];
  /** Fields needed only by slicers — included in the query but not shown as visible filter rows */
  slicerFields?: BiFieldRef[];
  layout?: LayoutConfig;
  /** All columns toggled to LOOKUP mode, including those not in zones */
  lookupColumns?: string[];
  /** Calculated fields (replaces all when provided) */
  calculatedFields?: CalculatedFieldDef[];
  /** Unified column ordering for interleaving values and calculated fields */
  valueColumnOrder?: ValueColumnRefDef[];
  /** Applied calculation group (multiplies value fields on the Values axis). */
  calculationGroup?: AppliedCalcGroup;
}

/** A calculation group applied to a pivot: group name + selected items
 *  (empty = all items, declaration order). */
export interface AppliedCalcGroup {
  group: string;
  items: string[];
}

/** Pivot region info returned when checking if a cell is in a pivot */
export interface PivotRegionInfo {
  pivotId: PivotId;
  isEmpty: boolean;
  sourceFields: SourceFieldInfo[];
  /** Current field configuration - which fields are in which zones */
  fieldConfiguration: PivotFieldConfiguration;
  /** Filter zones: position info for each filter dropdown cell */
  filterZones: FilterZoneInfo[];
  /** BI model info - present only for BI-backed pivots */
  biModel?: BiPivotModelInfo;
  /** Source table name - present only for Table-linked pivots */
  sourceTableName?: string;
}

/** Pivot region data for rendering placeholders */
export interface PivotRegionData {
  pivotId: PivotId;
  name: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  isEmpty: boolean;
}

/** Result of resolving a pivot cell into GETPIVOTDATA formula arguments. */
export interface GetPivotDataFormulaResult {
  dataField: string;
  fieldItemPairs: [string, string][];
}

/** Response containing unique values for a field */
export interface FieldUniqueValuesResponse {
  fieldIndex: number;
  fieldName: string;
  uniqueValues: string[];
}

// ============================================================================
// NEW EXCEL-COMPATIBLE TYPES
// ============================================================================

/** Pivot layout type (Excel: PivotLayoutType) */
export type PivotLayoutType = "compact" | "tabular" | "outline";

/** Subtotal location type (Excel: SubtotalLocationType) */
export type SubtotalLocationType = "atTop" | "atBottom" | "off";

/** Aggregation function (Excel: AggregationFunction) */
export type AggregationFunction =
  | "automatic"
  | "sum"
  | "count"
  | "average"
  | "max"
  | "min"
  | "product"
  | "countNumbers"
  | "standardDeviation"
  | "standardDeviationP"
  | "variance"
  | "varianceP";

/** Pivot filter type (Excel: PivotFilterType) */
export type PivotFilterType = "unknown" | "value" | "manual" | "label" | "date";

/** Sort direction (Excel: SortBy) */
export type SortBy = "ascending" | "descending";

/** Pivot axis (Excel: PivotAxis) */
export type PivotAxis = "unknown" | "row" | "column" | "data" | "filter";

/** Label filter condition */
export type LabelFilterCondition =
  | "beginsWith"
  | "endsWith"
  | "contains"
  | "doesNotContain"
  | "equals"
  | "doesNotEqual"
  | "greaterThan"
  | "greaterThanOrEqualTo"
  | "lessThan"
  | "lessThanOrEqualTo"
  | "between";

/** Value filter condition */
export type ValueFilterCondition =
  | "equals"
  | "doesNotEqual"
  | "greaterThan"
  | "greaterThanOrEqualTo"
  | "lessThan"
  | "lessThanOrEqualTo"
  | "between"
  | "topN"
  | "bottomN"
  | "topNPercent"
  | "bottomNPercent";

/** Label filter for text-based filtering */
export interface PivotLabelFilter {
  condition: LabelFilterCondition;
  substring?: string;
  lowerBound?: string;
  upperBound?: string;
  exclusive?: boolean;
}

/** Value filter for numeric filtering */
export interface PivotValueFilter {
  condition: ValueFilterCondition;
  comparator?: number;
  lowerBound?: number;
  upperBound?: number;
  value?: number;
  selectionType?: string;
  exclusive?: boolean;
}

/** Manual filter for explicit item selection */
export interface PivotManualFilter {
  selectedItems: string[];
}

/** Combined pivot filters for a field */
export interface PivotFilters {
  dateFilter?: unknown; // Date filter (not fully implemented yet)
  labelFilter?: PivotLabelFilter;
  manualFilter?: PivotManualFilter;
  valueFilter?: PivotValueFilter;
}

/** Subtotals configuration for a pivot field */
export interface Subtotals {
  automatic?: boolean;
  average?: boolean;
  count?: boolean;
  countNumbers?: boolean;
  max?: boolean;
  min?: boolean;
  product?: boolean;
  standardDeviation?: boolean;
  standardDeviationP?: boolean;
  sum?: boolean;
  variance?: boolean;
  varianceP?: boolean;
}

/** Extended layout configuration with Excel properties */
export interface ExtendedLayoutConfig extends LayoutConfig {
  autoFormat?: boolean;
  preserveFormatting?: boolean;
  showFieldHeaders?: boolean;
  enableFieldList?: boolean;
  emptyCellText?: string;
  fillEmptyCells?: boolean;
  subtotalLocation?: SubtotalLocationType;
  altTextTitle?: string;
  altTextDescription?: string;
}

/** Pivot table info response */
export interface PivotTableInfo {
  id: PivotId;
  /** Alias for id, used by some callers */
  pivotId?: PivotId;
  name: string;
  sourceRange: string;
  destination: string;
  allowMultipleFiltersPerField: boolean;
  enableDataValueEditing: boolean;
  refreshOnOpen: boolean;
  useCustomSortLists: boolean;
  hasHeaders: boolean;
  sourceTableName?: string;
  /** Source field info (available when queried with detail) */
  sourceFields?: SourceFieldInfo[];
  /** Row hierarchy info (available when queried with detail) */
  rowHierarchies?: Array<{ name: string }>;
}

/** Range information */
export interface RangeInfo {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  address: string;
}

/** Pivot layout ranges response */
export interface PivotLayoutRanges {
  range?: RangeInfo;
  dataBodyRange?: RangeInfo;
  columnLabelRange?: RangeInfo;
  rowLabelRange?: RangeInfo;
  filterAxisRange?: RangeInfo;
}

/** Pivot field info including items and filters */
export interface PivotFieldInfoResponse {
  id: number;
  name: string;
  showAllItems: boolean;
  filters: PivotFilters;
  isFiltered: boolean;
  subtotals: Subtotals;
  items: PivotItemInfo[];
}

/** Pivot item info */
export interface PivotItemInfo {
  id: number;
  name: string;
  isExpanded: boolean;
  visible: boolean;
}

/** Data hierarchy info */
export interface DataHierarchyInfo {
  id: number;
  name: string;
  fieldIndex: number;
  summarizeBy: AggregationFunction;
  numberFormat?: string;
  position: number;
  showAs?: ShowAsRule;
}

/** Row/Column hierarchy info */
export interface RowColumnHierarchyInfo {
  id: number;
  name: string;
  fieldIndex: number;
  position: number;
}

/** All hierarchies info response */
export interface PivotHierarchiesInfo {
  hierarchies: SourceFieldInfo[];
  rowHierarchies: RowColumnHierarchyInfo[];
  columnHierarchies: RowColumnHierarchyInfo[];
  dataHierarchies: DataHierarchyInfo[];
  filterHierarchies: RowColumnHierarchyInfo[];
}

// ============================================================================
// NEW REQUEST TYPES
// ============================================================================

/** Request to update pivot properties */
export interface UpdatePivotPropertiesRequest {
  pivotId: PivotId;
  name?: string;
  allowMultipleFiltersPerField?: boolean;
  enableDataValueEditing?: boolean;
  refreshOnOpen?: boolean;
  useCustomSortLists?: boolean;
}

/** Request to change pivot data source range */
export interface ChangePivotDataSourceRequest {
  pivotId: PivotId;
  sourceRange: string;
  sourceSheet?: number;
}

/** Request to update pivot layout */
export interface UpdatePivotLayoutRequest {
  pivotId: PivotId;
  layout: ExtendedLayoutConfig;
}

/** Request to add a field to a hierarchy */
export interface AddHierarchyRequest {
  pivotId: PivotId;
  fieldIndex: number;
  axis: PivotAxis;
  position?: number;
  name?: string;
  aggregation?: AggregationFunction;
}

/** Request to remove a field from a hierarchy */
export interface RemoveHierarchyRequest {
  pivotId: PivotId;
  axis: PivotAxis;
  position: number;
}

/** Request to move a field to a different hierarchy */
export interface MoveFieldRequest {
  pivotId: PivotId;
  fieldIndex: number;
  targetAxis: PivotAxis;
  position?: number;
}

/** Request to set aggregation function */
export interface SetAggregationRequest {
  pivotId: PivotId;
  valueFieldIndex: number;
  summarizeBy: AggregationFunction;
}

/** Request to set number format */
export interface SetNumberFormatRequest {
  pivotId: PivotId;
  valueFieldIndex: number;
  numberFormat: string;
}

/** Request to apply filters to a pivot field */
export interface ApplyPivotFilterRequest {
  pivotId: PivotId;
  fieldIndex: number;
  filters: PivotFilters;
}

/** Request to clear pivot field filters */
export interface ClearPivotFilterRequest {
  pivotId: PivotId;
  fieldIndex: number;
  filterType?: PivotFilterType;
}

/** Request to sort a pivot field */
export interface SortPivotFieldRequest {
  pivotId: PivotId;
  fieldIndex: number;
  sortBy: SortBy;
  valuesHierarchy?: string;
  pivotItemScope?: string[];
}

/** Request to set pivot item visibility */
export interface SetItemVisibilityRequest {
  pivotId: PivotId;
  fieldIndex: number;
  itemName: string;
  visible: boolean;
}

// ============================================================================
// EXPAND/COLLAPSE AND GROUPING TYPES
// ============================================================================

/** Date group level for date grouping */
export type DateGroupLevel = "year" | "quarter" | "month" | "week" | "day";

/** Request to set a pivot item's expand/collapse state */
export interface SetItemExpandedRequest {
  pivotId: PivotId;
  fieldIndex: number;
  itemName: string;
  isExpanded: boolean;
}

/** Request to expand or collapse all items at a specific field level */
export interface ExpandCollapseLevelRequest {
  pivotId: PivotId;
  isRow: boolean;
  fieldIndex: number;
  expand: boolean;
}

/** Request to expand or collapse all fields in the pivot table */
export interface ExpandCollapseAllRequest {
  pivotId: PivotId;
  expand: boolean;
}

// ============================================================================
// GROUPING TYPES
// ============================================================================

/** Manual group configuration */
export interface ManualGroupConfig {
  name: string;
  members: string[];
}

/** Grouping configuration for a pivot field (tagged union via "type" key) */
export type FieldGroupingConfig =
  | { type: "none" }
  | { type: "dateGrouping"; levels: DateGroupLevel[] }
  | { type: "numberBinning"; start: number; end: number; interval: number }
  | { type: "manualGrouping"; groups: ManualGroupConfig[]; ungroupedName?: string };

/** Request to apply grouping to a field */
export interface GroupFieldRequest {
  pivotId: PivotId;
  fieldIndex: number;
  grouping: FieldGroupingConfig;
}

/** Request to create a manual group on a field */
export interface CreateManualGroupRequest {
  pivotId: PivotId;
  fieldIndex: number;
  groupName: string;
  memberItems: string[];
}

/** Request to remove grouping from a field */
export interface UngroupFieldRequest {
  pivotId: PivotId;
  fieldIndex: number;
}

// ============================================================================
// Drill-Through (creates new sheet with matching source data)
// ============================================================================

/** Request for drill-through to a new sheet. */
export interface DrillThroughRequest {
  pivotId: PivotId;
  groupPath: Array<[number, number]>;
  maxRecords?: number;
}

/** Response from drill-through operation. */
export interface DrillThroughResponse {
  sheetName: string;
  sheetIndex: number;
  rowCount: number;
  colCount: number;
}

// ---------------------------------------------------------------------------
// Drill-through behavior (Layer 1: declarative query override). Mirrors the
// Rust DrillThroughBehavior; persists in the pivot's BI metadata and travels
// in .calp. See docs/design/pivot-drillthrough-customization.md.
// ---------------------------------------------------------------------------

/** How a pivot's double-click drill-through behaves. */
export type DrillThroughKind = "builtin" | "query" | "script";

/** A model column reference for a drill-through override. */
export interface DrillColumnRef {
  table: string;
  column: string;
}

/** ORDER BY clause over a detail-table column. */
export interface DrillOrderBy {
  table: string;
  column: string;
  descending?: boolean;
}

/** Extra filter ANDed onto the cell-derived drill filters. */
export interface DrillFilter {
  column: string;
  operator: string;
  value: string;
}

/** Declarative override of the drill-through detail query (no code). */
export interface DrillQueryOverride {
  columns?: string[];
  dimensionColumns?: DrillColumnRef[];
  orderBy?: DrillOrderBy[];
  limit?: number;
  filters?: DrillFilter[];
}

/** Per-pivot drill-through behavior config. */
export interface DrillThroughBehavior {
  kind: DrillThroughKind;
  query?: DrillQueryOverride;
}

// ============================================================================
// Calculated Fields / Items
// ============================================================================

export interface CalculatedFieldRequest {
  pivotId: string;
  name: string;
  formula: string;
  numberFormat?: string;
}

export interface UpdateCalculatedFieldRequest {
  pivotId: string;
  fieldIndex: number;
  name: string;
  formula: string;
  numberFormat?: string;
}

export interface RemoveCalculatedFieldRequest {
  pivotId: string;
  fieldIndex: number;
}

export interface CalculatedItemRequest {
  pivotId: string;
  fieldIndex: number;
  name: string;
  formula: string;
}

export interface RemoveCalculatedItemRequest {
  pivotId: string;
  itemIndex: number;
}

// =============================================================================
// PivotApi — the shape of the @api/pivot facade object (Pivot extension registers
// an implementation via registerPivotApi; consumers use the `pivot` proxy).
// DSL methods are intentionally NOT part of the cross-extension facade.
// =============================================================================

export interface PivotApi {
  create(request: CreatePivotRequest): Promise<PivotViewResponse>;
  updateFields(request: UpdatePivotFieldsRequest): Promise<PivotViewResponse>;
  toggleGroup(request: ToggleGroupRequest): Promise<PivotViewResponse>;
  getView(pivotId?: PivotId): Promise<PivotViewResponse>;
  delete(pivotId: PivotId): Promise<void>;
  refreshCache(pivotId: PivotId): Promise<PivotViewResponse>;
  getSourceData(pivotId: PivotId, groupPath: GroupPath, maxRecords?: number): Promise<SourceDataResponse>;
  getAtCell(row: number, col: number): Promise<PivotRegionInfo | null>;
  getDataFormula(row: number, col: number): Promise<GetPivotDataFormulaResult | null>;
  getRegionsForSheet(): Promise<PivotRegionData[]>;
  getFieldUniqueValues(pivotId: PivotId, fieldIndex: number): Promise<FieldUniqueValuesResponse>;
  getCellNumericValue(value: PivotCellValue): number;
  getCellDisplayValue(value: PivotCellValue): string;
  isHeaderCell(cellType: PivotCellType): boolean;
  isTotalCell(cellType: PivotCellType): boolean;
  isFilterCell(cellType: PivotCellType): boolean;
  isDataRow(rowType: PivotRowType): boolean;
  isFilterRow(rowType: PivotRowType): boolean;
  createFieldConfig(sourceIndex: number, name: string, options?: Partial<Omit<PivotFieldConfig, "sourceIndex" | "name">>): PivotFieldConfig;
  createValueFieldConfig(sourceIndex: number, name: string, aggregation?: AggregationType, options?: Partial<Omit<ValueFieldConfig, "sourceIndex" | "name" | "aggregation">>): ValueFieldConfig;
  createLayoutConfig(options?: Partial<LayoutConfig>): LayoutConfig;
  getInfo(pivotId: PivotId): Promise<PivotTableInfo>;
  updateProperties(request: UpdatePivotPropertiesRequest): Promise<PivotTableInfo>;
  getLayoutRanges(pivotId: PivotId): Promise<PivotLayoutRanges>;
  updateLayout(request: UpdatePivotLayoutRequest): Promise<PivotViewResponse>;
  getHierarchies(pivotId: PivotId): Promise<PivotHierarchiesInfo>;
  addHierarchy(request: AddHierarchyRequest): Promise<PivotViewResponse>;
  removeHierarchy(request: RemoveHierarchyRequest): Promise<PivotViewResponse>;
  moveField(request: MoveFieldRequest): Promise<PivotViewResponse>;
  setAggregation(request: SetAggregationRequest): Promise<PivotViewResponse>;
  setNumberFormat(request: SetNumberFormatRequest): Promise<PivotViewResponse>;
  applyFilter(request: ApplyPivotFilterRequest): Promise<PivotViewResponse>;
  clearFilter(request: ClearPivotFilterRequest): Promise<PivotViewResponse>;
  sortField(request: SortPivotFieldRequest): Promise<PivotViewResponse>;
  getFieldInfo(pivotId: PivotId, fieldIndex: number): Promise<PivotFieldInfoResponse>;
  setItemVisibility(request: SetItemVisibilityRequest): Promise<PivotViewResponse>;
  getAll(): Promise<PivotTableInfo[]>;
  refreshAll(): Promise<PivotViewResponse[]>;
  setItemExpanded(request: SetItemExpandedRequest): Promise<PivotViewResponse>;
  expandCollapseLevel(request: ExpandCollapseLevelRequest): Promise<PivotViewResponse>;
  expandCollapseAll(request: ExpandCollapseAllRequest): Promise<PivotViewResponse>;
  groupPivotField(request: GroupFieldRequest): Promise<PivotViewResponse>;
  createManualGroup(request: CreateManualGroupRequest): Promise<PivotViewResponse>;
  ungroupPivotField(request: UngroupFieldRequest): Promise<PivotViewResponse>;
  drillThroughToSheet(request: DrillThroughRequest): Promise<DrillThroughResponse>;
  createFromBiModel(request: CreatePivotFromBiModelRequest): Promise<PivotViewResponse>;
  updateBiFields(request: UpdateBiPivotFieldsRequest): Promise<PivotViewResponse>;
  setBiLookupColumns(pivotId: PivotId, lookupColumns: string[]): Promise<void>;
}
