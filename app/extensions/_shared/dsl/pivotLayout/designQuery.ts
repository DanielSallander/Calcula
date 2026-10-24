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
   *  (`@api/reportFilters` `filterLevel`). Only engine-routed filters read it. */
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

/**
 * One tuple (OR-of-AND) filter of a design query (P4). Mirrors the Rust
 * `DesignQueryTupleFilter` (pivot/headless.rs): `tuples[i][j]` is the member
 * KEY of `fields[j]` ("" for the blank member). An empty `tuples` keeps
 * nothing. `level` as `DesignQueryFieldRef.level` (absent = 1).
 */
export interface DesignQueryTupleFilter {
  fields: Array<{ table: string; column: string }>;
  tuples: string[][];
  level?: number;
}

/** Compiled design query — the payload sent to `run_design_query`. */
export interface DesignQueryRequest {
  connectionId: string;
  rowFields: DesignQueryFieldRef[];
  columnFields: DesignQueryFieldRef[];
  valueFields: DesignQueryValueRef[];
  filterFields: DesignQueryFieldRef[];
  /** The canvas PAGE's model filters (`@api/reportFilters`), merged by the
   *  chart reader and kept apart from the query's own FILTERS: the backend
   *  runs them INSIDE the engine query, never as a GROUP BY column, so a
   *  non-additive measure under a slicer keeping several items is exact
   *  (Rust `DesignQueryRequest.page_filter_fields`). */
  pageFilterFields?: DesignQueryFieldRef[];
  /** OR-of-AND filters (a non-rectangular cross-filter selection, P4): keep a
   *  row whose columns equal one of the tuples. Run inside the engine query
   *  like `pageFilterFields` (Rust `DesignQueryRequest.tuple_filters`). */
  tupleFilters?: DesignQueryTupleFilter[];
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

/** The items of the FIRST list that every other list also names, in the first list's order. */
function intersectInOrder(lists: string[][]): string[] {
  const [first, ...rest] = lists;
  const sets = rest.map((l) => new Set(l));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of first) {
    if (seen.has(item) || !sets.every((s) => s.has(item))) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** Every item of either list once, first-appearance order. */
function unionInOrder(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [...a, ...b]) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

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
  //
  // ONE REF PER FIELD. The compiler emits one ZoneField per FILTERS term and
  // reports each unresolved inclusion by field NAME, so two `=` terms on one
  // field -- the author's `[Product.Category] = ("Bikes", "Clothing")` and a
  // drill-through's baked `("Bikes")` -- used to collapse to whichever came
  // last (a Map by name, last wins, handed to BOTH refs). They are merged
  // instead: the inclusion is the INTERSECTION of every `=` list on the field
  // and the hidden list the UNION of every `NOT IN`, so the author's filter
  // ANDs with the drilled one. Rust already keeps one IN-list per ref and
  // intersects same-column inclusions on its host-mask fallback; the collapse
  // was purely here. An empty intersection travels as `[]`, which keeps
  // nothing -- the honest answer to two lists with no member in common.
  const inclusionLists = new Map<string, string[][]>();
  for (const u of result.unresolvedInclusions) {
    const lists = inclusionLists.get(u.fieldName) ?? [];
    lists.push([...u.values]);
    inclusionLists.set(u.fieldName, lists);
  }
  const filterRefs = new Map<string, DesignQueryFieldRef>();
  for (const f of result.filters.filter(isBiField)) {
    const existing = filterRefs.get(f.name);
    if (existing) {
      if (f.hiddenItems && f.hiddenItems.length > 0) {
        existing.hiddenItems = unionInOrder(existing.hiddenItems ?? [], f.hiddenItems);
      }
      continue;
    }
    const ref: DesignQueryFieldRef = {
      ...splitRef(f.name, biTableNames, f.isLookup),
      hiddenItems: f.hiddenItems ? [...f.hiddenItems] : [],
    };
    const lists = inclusionLists.get(f.name);
    if (lists && lists.length > 0) ref.includedItems = intersectInOrder(lists);
    filterRefs.set(f.name, ref);
  }
  const request: DesignQueryRequest = {
    connectionId,
    rowFields: result.rows.filter(isBiField).map(axisRef),
    columnFields: result.columns.filter(isBiField).map(axisRef),
    valueFields: result.values.map((f) => valueRef(f.name, f.customName)),
    filterFields: [...filterRefs.values()],
    calculatedFields: result.calculatedFields.length > 0 ? result.calculatedFields : undefined,
    valueColumnOrder: result.valueColumnOrder.length > 0 ? result.valueColumnOrder : undefined,
    layout: result.layout,
  };
  return { request, errors: [], warnings };
}
