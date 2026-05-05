//! FILENAME: app/extensions/Pivot/dsl/compiler.ts
// PURPOSE: Compile a PivotLayoutAST into zone state (ZoneField[] arrays + LayoutConfig).
// CONTEXT: Bridges the DSL parser output to the existing pivot editor state types.
//
// IMPORTANT: For BI pivots, the visual editor uses a specific convention:
//   - Dimension fields: sourceIndex = -1, name = "Table.Column"
//   - Measure fields:   sourceIndex = -1, name = "[MeasureName]", customName = "[MeasureName]"
// The compiler MUST match this convention so that buildUpdateRequest and handleUpdate
// in PivotEditor.tsx produce correct backend requests.

import type {
  PivotLayoutAST, FieldNode, ValueFieldNode,
  FilterFieldNode, SortNode, LayoutDirective,
} from './ast';
import { type DslError, dslError, dslWarning } from './errors';
import type {
  SourceField, ZoneField, AggregationType,
} from '../../_shared/components/types';
import { getDefaultAggregation, getValueFieldDisplayName } from '../../_shared/components/types';
import type { LayoutConfig, ShowValuesAs, BiPivotModelInfo, CalculatedFieldDef, ValueColumnRefDef } from '../../Pivot/components/types';

/** The compiled output of a DSL definition. */
export interface CompileResult {
  rows: ZoneField[];
  columns: ZoneField[];
  values: ZoneField[];
  filters: ZoneField[];
  layout: LayoutConfig;
  /** Lookup column keys for BI pivots ("Table.Column"). */
  lookupColumns: string[];
  /** Calculated fields from CALC clauses. */
  calculatedFields: CalculatedFieldDef[];
  /** Unified column ordering (interleaved values + calculated fields). */
  valueColumnOrder: ValueColumnRefDef[];
  /** Save-as name if SAVE AS clause was present. */
  saveAs?: string;
  errors: DslError[];
}

/** Context needed to resolve field names. */
export interface CompileContext {
  sourceFields: SourceField[];
  biModel?: BiPivotModelInfo;
  /**
   * Map from filter field name to all unique values. Required to correctly
   * compile inclusion filters (= syntax) into hiddenItems (exclusion list).
   */
  filterUniqueValues?: Map<string, string[]>;
}

/**
 * Compile a parsed AST into zone state.
 * Resolves field names to sourceIndex, maps aggregations, and builds layout config.
 */
export function compile(ast: PivotLayoutAST, ctx: CompileContext): CompileResult {
  const compiler = new Compiler(ast, ctx);
  return compiler.compile();
}

// ---------------------------------------------------------------------------
// Compiler implementation
// ---------------------------------------------------------------------------

class Compiler {
  private ast: PivotLayoutAST;
  private ctx: CompileContext;
  private errors: DslError[] = [];
  private isBi: boolean;

  /** Map from lowercase field name to SourceField for fast lookup. */
  private fieldMap: Map<string, SourceField>;
  /** For BI: set of valid "table.column" keys (lowercase) for validation. */
  private biFieldKeys: Set<string>;
  /** For BI: map from column name (lowercase) to table.column for unqualified lookups. */
  private biColumnToKey: Map<string, string>;
  /** For BI: map from column name (lowercase) to isNumeric. */
  private biColumnNumeric: Map<string, boolean>;

  constructor(ast: PivotLayoutAST, ctx: CompileContext) {
    this.ast = ast;
    this.ctx = ctx;
    this.isBi = !!ctx.biModel;

    // Build lookup maps
    this.fieldMap = new Map();
    for (const f of ctx.sourceFields) {
      this.fieldMap.set(f.name.toLowerCase(), f);
    }

    this.biFieldKeys = new Set();
    this.biColumnToKey = new Map();
    this.biColumnNumeric = new Map();
    if (ctx.biModel) {
      for (const table of ctx.biModel.tables) {
        for (const col of table.columns) {
          const key = `${table.name}.${col.name}`.toLowerCase();
          this.biFieldKeys.add(key);
          // Only store unqualified lookup if column name is unique across tables
          const colLower = col.name.toLowerCase();
          if (!this.biColumnToKey.has(colLower)) {
            this.biColumnToKey.set(colLower, `${table.name}.${col.name}`);
            this.biColumnNumeric.set(colLower, col.isNumeric);
          } else {
            // Ambiguous — remove so unqualified use produces an error
            this.biColumnToKey.delete(colLower);
            this.biColumnNumeric.delete(colLower);
          }
        }
      }
    }
  }

  compile(): CompileResult {
    const rows = this.compileFieldNodes(this.ast.rows);
    const columns = this.compileFieldNodes(this.ast.columns);
    const values = this.compileValueFields(this.ast.values);
    const filters = this.compileFilters(this.ast.filters);
    const layout = this.compileLayout(this.ast.layout);
    const lookupColumns = this.collectLookupColumns();

    // Map CALC clauses to CalculatedFieldDef
    const calculatedFields: CalculatedFieldDef[] = this.ast.calculatedFields.map(cf => ({
      name: cf.name,
      formula: cf.expression,
    }));

    // Build unified column ordering from the interleaved values list.
    // ValueFieldNodes with inlineCalcIndex represent CALC entries within VALUES.
    const valueColumnOrder: ValueColumnRefDef[] = [];
    let regularValueIdx = 0;
    for (const node of this.ast.values) {
      if (node.inlineCalcIndex !== undefined) {
        valueColumnOrder.push({ type: 'calculated', index: node.inlineCalcIndex });
      } else {
        valueColumnOrder.push({ type: 'value', index: regularValueIdx });
        regularValueIdx++;
      }
    }
    // Append any standalone CALC clauses (not inline in VALUES) that aren't
    // already referenced by inline entries
    const inlineCalcIndices = new Set(
      this.ast.values.filter(n => n.inlineCalcIndex !== undefined).map(n => n.inlineCalcIndex!)
    );
    for (let i = 0; i < calculatedFields.length; i++) {
      if (!inlineCalcIndices.has(i)) {
        valueColumnOrder.push({ type: 'calculated', index: i });
      }
    }

    return {
      rows,
      columns,
      values,
      filters,
      layout,
      lookupColumns,
      calculatedFields,
      valueColumnOrder,
      saveAs: this.ast.saveAs,
      errors: this.errors,
    };
  }

  // --- Field nodes (ROWS / COLUMNS) ---

  private compileFieldNodes(nodes: FieldNode[]): ZoneField[] {
    const result: ZoneField[] = [];
    for (const node of nodes) {
      const resolved = this.resolveFieldToZone(node.name, node.table, node.column, false, node.location);
      if (!resolved) continue;

      resolved.isLookup = node.isLookup || undefined;
      result.push(resolved);
    }
    return result;
  }

  // --- Value fields ---

  private compileValueFields(nodes: ValueFieldNode[]): ZoneField[] {
    const result: ZoneField[] = [];
    for (const node of nodes) {
      // Skip inline CALC placeholders — they're handled via calculatedFields
      if (node.inlineCalcIndex !== undefined) continue;

      if (node.isMeasure) {
        // Bracket measure: [TotalSales]
        const zf = this.compileBiMeasure(node);
        if (zf) result.push(zf);
      } else {
        // Aggregation call or bare field
        const resolved = this.resolveFieldToZone(node.fieldName, node.table, node.column, true, node.location);
        if (!resolved) continue;

        const aggregation = node.aggregation ?? getDefaultAggregation(resolved.isNumeric);
        resolved.aggregation = aggregation;
        resolved.customName = node.alias;
        resolved.showValuesAs = node.showValuesAs;
        result.push(resolved);
      }
    }
    return result;
  }

  /** Compile a bracket measure [MeasureName] into a ZoneField. */
  private compileBiMeasure(node: ValueFieldNode): ZoneField | null {
    if (!this.ctx.biModel) {
      this.errors.push(dslError(
        `Bracket measures like [${node.fieldName}] are only supported for BI pivots`,
        node.location,
      ));
      return null;
    }

    const measure = this.ctx.biModel.measures.find(
      m => m.name.toLowerCase() === node.fieldName.toLowerCase()
    );
    if (!measure) {
      this.errors.push(dslError(`Unknown measure: [${node.fieldName}]`, node.location));
      return null;
    }

    // Match the convention used by handleBiMeasureToggle in PivotEditor:
    // name = "[MeasureName]", sourceIndex = -1, customName = "[MeasureName]"
    const bracketName = `[${measure.name}]`;
    return {
      sourceIndex: -1,
      name: bracketName,
      isNumeric: true,
      aggregation: measure.aggregation,
      customName: node.alias ?? bracketName,
      showValuesAs: node.showValuesAs,
    };
  }

  // --- Filters ---

  private compileFilters(nodes: FilterFieldNode[]): ZoneField[] {
    const result: ZoneField[] = [];
    for (const node of nodes) {
      const resolved = this.resolveFieldToZone(node.fieldName, node.table, node.column, false, node.location);
      if (!resolved) continue;

      if (node.exclude) {
        // NOT IN: values are items to hide — maps directly to hiddenItems
        resolved.hiddenItems = node.values;
      } else if (node.values.length > 0) {
        // = ("a", "b"): values are items to SHOW (include).
        // hiddenItems stores items to HIDE, so we must invert:
        // hiddenItems = allUniqueValues - includedValues
        const allValues = this.ctx.filterUniqueValues?.get(resolved.name);
        if (allValues && allValues.length > 0) {
          const includeSet = new Set(node.values);
          resolved.hiddenItems = allValues.filter(v => !includeSet.has(v));
        } else {
          // No unique values available — can't invert. Store as empty
          // (no filter applied) to avoid incorrect semantics.
          resolved.hiddenItems = undefined;
        }
      }

      result.push(resolved);
    }
    return result;
  }

  // --- Layout ---

  private compileLayout(directives: LayoutDirective[]): LayoutConfig {
    const layout: LayoutConfig = {};

    for (const d of directives) {
      switch (d.key) {
        case 'compact':
          layout.reportLayout = 'compact';
          break;
        case 'outline':
          layout.reportLayout = 'outline';
          break;
        case 'tabular':
          layout.reportLayout = 'tabular';
          break;
        case 'repeat-labels':
          layout.repeatRowLabels = true;
          break;
        case 'no-repeat-labels':
          layout.repeatRowLabels = false;
          break;
        case 'no-grand-totals':
          layout.showRowGrandTotals = false;
          layout.showColumnGrandTotals = false;
          break;
        case 'grand-totals':
          layout.showRowGrandTotals = true;
          layout.showColumnGrandTotals = true;
          break;
        case 'no-row-totals':
          layout.showRowGrandTotals = false;
          break;
        case 'row-totals':
          layout.showRowGrandTotals = true;
          break;
        case 'no-column-totals':
          layout.showColumnGrandTotals = false;
          break;
        case 'column-totals':
          layout.showColumnGrandTotals = true;
          break;
        case 'show-empty-rows':
          layout.showEmptyRows = true;
          break;
        case 'show-empty-cols':
          layout.showEmptyCols = true;
          break;
        case 'values-on-rows':
          layout.valuesPosition = 'rows';
          break;
        case 'values-on-columns':
          layout.valuesPosition = 'columns';
          break;
        case 'auto-fit':
          layout.autoFitColumnWidths = true;
          break;
        default:
          this.errors.push(dslWarning(`Unknown layout directive: "${d.key}"`, d.location));
      }
    }

    return layout;
  }

  // --- Lookup columns ---

  private collectLookupColumns(): string[] {
    const lookups: string[] = [];
    for (const node of this.ast.rows) {
      if (node.isLookup && node.table && node.column) {
        lookups.push(`${node.table}.${node.column}`);
      }
    }
    for (const node of this.ast.columns) {
      if (node.isLookup && node.table && node.column) {
        lookups.push(`${node.table}.${node.column}`);
      }
    }
    return lookups;
  }

  // --- Field resolution ---

  /**
   * Resolve a field name to a ZoneField.
   *
   * For BI pivots: uses sourceIndex = -1 and name = "Table.Column" to match
   * the convention used by the visual editor (handleBiColumnToggle).
   *
   * For regular pivots: resolves against sourceFields to get the real sourceIndex.
   */
  private resolveFieldToZone(
    name: string,
    table: string | undefined,
    column: string | undefined,
    isValueField: boolean,
    location: { line: number; column: number; endColumn: number },
  ): ZoneField | null {
    // --- BI pivot path ---
    if (this.isBi) {
      // Dotted name: "Table.Column"
      if (table && column) {
        const key = `${table}.${column}`.toLowerCase();
        if (this.biFieldKeys.has(key)) {
          const numericKey = column.toLowerCase();
          const isNumeric = this.biColumnNumeric.get(numericKey) ?? false;
          return {
            sourceIndex: -1,
            name: `${table}.${column}`,
            isNumeric,
          };
        }
        this.errors.push(dslError(`Unknown field: "${name}"`, location));
        return null;
      }

      // Unqualified name: try to find unique column
      const fullKey = this.biColumnToKey.get(name.toLowerCase());
      if (fullKey) {
        const numericKey = name.toLowerCase();
        const isNumeric = this.biColumnNumeric.get(numericKey) ?? false;
        return {
          sourceIndex: -1,
          name: fullKey,
          isNumeric,
        };
      }

      // Fallback: check sourceFields (might be a flat field list)
      const sf = this.fieldMap.get(name.toLowerCase());
      if (sf) {
        return {
          sourceIndex: sf.index === -1 ? -1 : sf.index,
          name: sf.name,
          isNumeric: sf.isNumeric,
        };
      }

      this.errors.push(dslError(`Unknown field: "${name}"`, location));
      return null;
    }

    // --- Regular pivot path ---
    const sf = this.fieldMap.get(name.toLowerCase());
    if (sf) {
      return {
        sourceIndex: sf.index,
        name: sf.name,
        isNumeric: sf.isNumeric,
      };
    }

    // Case-insensitive fallback
    for (const f of this.ctx.sourceFields) {
      if (f.name.toLowerCase() === name.toLowerCase()) {
        return {
          sourceIndex: f.index,
          name: f.name,
          isNumeric: f.isNumeric,
        };
      }
    }

    this.errors.push(dslError(`Unknown field: "${name}"`, location));
    return null;
  }
}
