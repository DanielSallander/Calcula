//! FILENAME: app/extensions/_shared/dsl/pivotLayout/designQuery.ts
// PURPOSE: Compile pivot-layout DSL text against a BI model into a backend
//   `DesignQueryRequest` — the payload for the headless `run_design_query`
//   command. Lets any consumer (charts now, paginated reports later) run a
//   design query without creating a pivot. Mirrors the BI mapping in
//   Pivot/components/biFieldsRequest.ts (the pivot editor's one request
//   builder) but targets a connection instead of a stored pivot.

import { processDsl } from './index';
import { splitBiFieldKey } from '../../lib/biFieldKey';
import type { CompileContext } from './compiler';
import type { DslError } from './errors';
import type {
  BiPivotModelInfo,
  CalculatedFieldDef,
  LayoutConfig,
  ValueColumnRefDef,
  ZoneField,
} from '../../components/types';

/** A field reference (table.column). Mirrors the Rust `DesignQueryFieldRef`
 *  (pivot/headless.rs): a `BiFieldRef` plus `includedItems`. */
export interface DesignQueryFieldRef {
  table: string;
  column: string;
  isLookup?: boolean;
  /** Items to hide (`NOT IN (...)`). */
  hiddenItems?: string[];
  /** Items to KEEP (`= (...)`): every other item of the field is hidden. The
   *  backend inverts it against the query's own result -- a design query has
   *  no pivot whose item list could invert it here (BUG-0197). */
  includedItems?: string[];
  /** The FILTER LEVEL an engine-routed filter applies at (Rust
   *  `DesignQueryFieldRef.level`): absent = 1, an ordinary slicer that a bare
   *  CLEAR/RESET removes; 2..9 = a slicer PINNED above that range
   *  (`@api/pageFilters` `filterLevel`). Only engine-routed filters read it. */
  level?: number;
}

/** A measure reference. Mirrors the Rust `BiValueFieldRef`. */
export interface DesignQueryValueRef {
  measureName: string;
  customName?: string;
  /** The Excel format code the consumer chose for this measure (a chart's
   *  `spec.fieldFormats[measure]`). Rust formats `formattedValue` with it
   *  (`BiValueFieldRef.number_format`); absent = the backend's own default.
   *  The compiler never sets it -- the DSL has no spelling for a format. */
  numberFormat?: string;
}

/** Compiled design query — the payload sent to `run_design_query`. */
export interface DesignQueryRequest {
  connectionId: string;
  rowFields: DesignQueryFieldRef[];
  columnFields: DesignQueryFieldRef[];
  valueFields: DesignQueryValueRef[];
  filterFields: DesignQueryFieldRef[];
  /** The canvas PAGE's model filters (`@api/pageFilters`), merged by the
   *  chart reader and kept apart from the query's own FILTERS: the backend
   *  runs them INSIDE the engine query, never as a GROUP BY column, so a
   *  non-additive measure under a slicer keeping several items is exact
   *  (Rust `DesignQueryRequest.page_filter_fields`). */
  pageFilterFields?: DesignQueryFieldRef[];
  calculatedFields?: CalculatedFieldDef[];
  valueColumnOrder?: ValueColumnRefDef[];
  layout?: LayoutConfig;
}

/** Result of compiling a design query. `request` is null when there are hard errors. */
export interface CompiledDesignQuery {
  request: DesignQueryRequest | null;
  errors: DslError[];
  warnings: DslError[];
}

/** Split a "Table.Column" name into a field ref (bare names get an empty table).
 *  Table names can contain dots, so resolve against the model's table names. */
function splitRef(name: string, tableNames: string[], isLookup?: boolean): DesignQueryFieldRef {
  const { table, column } = splitBiFieldKey(name, tableNames);
  return { table, column, isLookup };
}

/** Strip the [brackets] from a measure name. */
function valueRef(name: string, customName?: string): DesignQueryValueRef {
  const measureName =
    name.startsWith('[') && name.endsWith(']') ? name.substring(1, name.length - 1) : name;
  return { measureName, customName };
}

/** Only fully-qualified "Table.Column" fields go to the backend (bare grid names don't apply). */
const isBiField = (f: ZoneField) => f.name.includes('.');

/**
 * Compile design-query DSL text against a BI model into a backend request.
 * Only the BI (model-backed) path is supported — a design query always runs
 * against a connection's model.
 */
export function compileDesignQuery(
  dslText: string,
  connectionId: string,
  biModel: BiPivotModelInfo,
): CompiledDesignQuery {
  const ctx: CompileContext = { sourceFields: [], biModel };
  const result = processDsl(dslText, ctx);
  const errors = result.errors.filter((e) => e.severity === 'error');
  const warnings = result.errors.filter((e) => e.severity !== 'error');
  if (errors.length > 0) {
    return { request: null, errors, warnings };
  }

  const biTableNames = biModel.tables.map((t) => t.name);
  // A ROWS / COLUMNS field's `NOT IN (...)` list. The mapping used to copy
  // none, so the query ran with every item of the field.
  const axisRef = (f: ZoneField): DesignQueryFieldRef => {
    const ref = splitRef(f.name, biTableNames, f.isLookup);
    return f.hiddenItems && f.hiddenItems.length > 0 ? { ...ref, hiddenItems: [...f.hiddenItems] } : ref;
  };
  // A FILTERS inclusion `= (...)` cannot be inverted here (there is no item
  // list to invert it against; the compiler says so in
  // `unresolvedInclusions`), so it travels as the items to KEEP and the
  // backend inverts it. It used to travel as nothing, and the query ran
  // UNFILTERED with no warning (BUG-0197).
  const inclusions = new Map(result.unresolvedInclusions.map((u) => [u.fieldName, u.values]));
  const filterRef = (f: ZoneField): DesignQueryFieldRef => {
    const ref = { ...splitRef(f.name, biTableNames, f.isLookup), hiddenItems: f.hiddenItems ?? [] };
    const included = inclusions.get(f.name);
    return included ? { ...ref, includedItems: [...included] } : ref;
  };
  const request: DesignQueryRequest = {
    connectionId,
    rowFields: result.rows.filter(isBiField).map(axisRef),
    columnFields: result.columns.filter(isBiField).map(axisRef),
    valueFields: result.values.map((f) => valueRef(f.name, f.customName)),
    filterFields: result.filters.filter(isBiField).map(filterRef),
    calculatedFields: result.calculatedFields.length > 0 ? result.calculatedFields : undefined,
    valueColumnOrder: result.valueColumnOrder.length > 0 ? result.valueColumnOrder : undefined,
    layout: result.layout,
  };
  return { request, errors: [], warnings };
}
