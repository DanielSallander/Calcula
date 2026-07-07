//! FILENAME: app/extensions/_shared/dsl/pivotLayout/designQuery.ts
// PURPOSE: Compile pivot-layout DSL text against a BI model into a backend
//   `DesignQueryRequest` — the payload for the headless `run_design_query`
//   command. Lets any consumer (charts now, paginated reports later) run a
//   design query without creating a pivot. Mirrors the BI branch of the pivot
//   editor's applyPivotDsl (Pivot/lib/pivot-api.ts) but targets a connection
//   instead of a stored pivot.

import { processDsl } from './index';
import type { CompileContext } from './compiler';
import type { DslError } from './errors';
import type {
  BiPivotModelInfo,
  CalculatedFieldDef,
  LayoutConfig,
  ValueColumnRefDef,
  ZoneField,
} from '../../components/types';

/** A field reference (table.column). Mirrors the Rust `BiFieldRef`. */
export interface DesignQueryFieldRef {
  table: string;
  column: string;
  isLookup?: boolean;
  hiddenItems?: string[];
}

/** A measure reference. Mirrors the Rust `BiValueFieldRef`. */
export interface DesignQueryValueRef {
  measureName: string;
  customName?: string;
}

/** Compiled design query — the payload sent to `run_design_query`. */
export interface DesignQueryRequest {
  connectionId: string;
  rowFields: DesignQueryFieldRef[];
  columnFields: DesignQueryFieldRef[];
  valueFields: DesignQueryValueRef[];
  filterFields: DesignQueryFieldRef[];
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

/** Split a "Table.Column" name into a field ref (bare names get an empty table). */
function splitRef(name: string, isLookup?: boolean): DesignQueryFieldRef {
  const dot = name.indexOf('.');
  if (dot === -1) return { table: '', column: name, isLookup };
  return { table: name.substring(0, dot), column: name.substring(dot + 1), isLookup };
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

  const request: DesignQueryRequest = {
    connectionId,
    rowFields: result.rows.filter(isBiField).map((f) => splitRef(f.name, f.isLookup)),
    columnFields: result.columns.filter(isBiField).map((f) => splitRef(f.name, f.isLookup)),
    valueFields: result.values.map((f) => valueRef(f.name, f.customName)),
    filterFields: result.filters
      .filter(isBiField)
      .map((f) => ({ ...splitRef(f.name, f.isLookup), hiddenItems: f.hiddenItems ?? [] })),
    calculatedFields: result.calculatedFields.length > 0 ? result.calculatedFields : undefined,
    valueColumnOrder: result.valueColumnOrder.length > 0 ? result.valueColumnOrder : undefined,
    layout: result.layout,
  };
  return { request, errors: [], warnings };
}
