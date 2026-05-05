//! FILENAME: app/extensions/Pivot/dsl/validator.ts
// PURPOSE: Semantic validation of a parsed PivotLayoutAST.
// CONTEXT: Runs after parsing, before compilation. Reports warnings
//          and errors for field existence, type mismatches, and duplicates.

import type { PivotLayoutAST, FieldNode, ValueFieldNode, FilterFieldNode } from './ast';
import { type DslError, dslError, dslWarning, dslInfo } from './errors';
import { LAYOUT_DIRECTIVES } from './tokens';
import type { SourceField } from '../../_shared/components/types';
import type { BiPivotModelInfo } from '../../Pivot/components/types';

/** Context for validation. */
export interface ValidateContext {
  sourceFields: SourceField[];
  biModel?: BiPivotModelInfo;
}

/**
 * Validate a parsed AST for semantic correctness.
 * Returns an array of diagnostics (errors, warnings, info).
 */
export function validate(ast: PivotLayoutAST, ctx: ValidateContext): DslError[] {
  const errors: DslError[] = [];
  const isBi = !!ctx.biModel;

  // Build lookup sets
  const fieldNames = new Set(ctx.sourceFields.map(f => f.name.toLowerCase()));
  const biFieldNames = new Set<string>();
  const biMeasureNames = new Set<string>();

  if (ctx.biModel) {
    for (const table of ctx.biModel.tables) {
      for (const col of table.columns) {
        biFieldNames.add(`${table.name}.${col.name}`.toLowerCase());
        // Also add just the column name for unqualified lookups
        fieldNames.add(col.name.toLowerCase());
      }
    }
    for (const m of ctx.biModel.measures) {
      biMeasureNames.add(m.name.toLowerCase());
    }
  }

  // --- Validate ROWS / COLUMNS fields ---
  const allFieldRefs: { name: string; zone: string; node: FieldNode }[] = [];

  for (const node of ast.rows) {
    allFieldRefs.push({ name: node.name, zone: 'ROWS', node });
    validateFieldExists(node.name, node.table, node.column, fieldNames, biFieldNames, node.location, errors, isBi);
    validateLookupRequiresBI(node, errors, isBi);
  }

  for (const node of ast.columns) {
    allFieldRefs.push({ name: node.name, zone: 'COLUMNS', node });
    validateFieldExists(node.name, node.table, node.column, fieldNames, biFieldNames, node.location, errors, isBi);
    validateLookupRequiresBI(node, errors, isBi);
  }

  // Check for duplicate fields across ROWS and COLUMNS
  const seenFields = new Map<string, string>();
  for (const ref of allFieldRefs) {
    const key = ref.name.toLowerCase();
    const existingZone = seenFields.get(key);
    if (existingZone) {
      if (existingZone !== ref.zone) {
        errors.push(dslWarning(
          `Field "${ref.name}" appears in both ${existingZone} and ${ref.zone}`,
          ref.node.location,
        ));
      } else {
        errors.push(dslWarning(
          `Duplicate field "${ref.name}" in ${ref.zone}`,
          ref.node.location,
        ));
      }
    }
    seenFields.set(key, ref.zone);
  }

  // --- Validate VALUES fields ---
  for (const node of ast.values) {
    if (node.isMeasure) {
      if (!isBi) {
        errors.push(dslError(
          `Bracket measures like [${node.fieldName}] require a BI model pivot`,
          node.location,
        ));
      } else if (!biMeasureNames.has(node.fieldName.toLowerCase())) {
        errors.push(dslError(`Unknown measure: [${node.fieldName}]`, node.location));
      }
    } else {
      validateFieldExists(node.fieldName, node.table, node.column, fieldNames, biFieldNames, node.location, errors, isBi);

      // Warn if using numeric aggregation on a non-numeric field
      if (node.aggregation && node.aggregation !== 'count') {
        const sf = findSourceField(node.fieldName, node.table, ctx);
        if (sf && !sf.isNumeric) {
          errors.push(dslWarning(
            `Aggregation "${node.aggregation}" on non-numeric field "${node.fieldName}". Consider using Count instead.`,
            node.location,
          ));
        }
      }
    }
  }

  // --- Validate FILTERS ---
  for (const node of ast.filters) {
    validateFieldExists(node.fieldName, node.table, node.column, fieldNames, biFieldNames, node.location, errors, isBi);
    if (node.values.length === 0) {
      errors.push(dslWarning('Filter has no values specified', node.location));
    }
  }

  // --- Validate SORT ---
  for (const node of ast.sort) {
    if (!fieldNames.has(node.fieldName.toLowerCase()) && !biFieldNames.has(node.fieldName.toLowerCase())) {
      errors.push(dslError(`Unknown sort field: "${node.fieldName}"`, node.location));
    }
  }

  // --- Validate LAYOUT directives ---
  for (const d of ast.layout) {
    if (!LAYOUT_DIRECTIVES.has(d.key)) {
      errors.push(dslWarning(
        `Unknown layout directive: "${d.key}". Valid options: ${[...LAYOUT_DIRECTIVES].join(', ')}`,
        d.location,
      ));
    }
  }

  // --- Informational hints ---
  if (ast.rows.length === 0 && ast.columns.length === 0 && ast.values.length === 0) {
    // No fields at all — not an error, but hint
  } else if (ast.values.length === 0 && (ast.rows.length > 0 || ast.columns.length > 0)) {
    errors.push(dslInfo(
      'No VALUES defined. Add a VALUES clause to see aggregated data.',
      ast.rows[0]?.location ?? ast.columns[0]?.location ?? { line: 1, column: 0, endColumn: 0 },
    ));
  }

  return errors;
}

// --- Helper functions ---

function validateFieldExists(
  name: string,
  table: string | undefined,
  column: string | undefined,
  fieldNames: Set<string>,
  biFieldNames: Set<string>,
  location: { line: number; column: number; endColumn: number },
  errors: DslError[],
  isBi: boolean,
): void {
  const lowerName = name.toLowerCase();

  if (table && column) {
    const biKey = `${table}.${column}`.toLowerCase();
    if (!biFieldNames.has(biKey)) {
      errors.push(dslError(`Unknown field: "${name}"`, location));
    }
    return;
  }

  if (!fieldNames.has(lowerName)) {
    errors.push(dslError(`Unknown field: "${name}"`, location));
  }
}

function validateLookupRequiresBI(node: FieldNode, errors: DslError[], isBi: boolean): void {
  if (node.isLookup && !isBi) {
    errors.push(dslError(
      'LOOKUP fields are only supported for BI model pivots',
      node.location,
    ));
  }
}

function findSourceField(
  name: string,
  table: string | undefined,
  ctx: ValidateContext,
): SourceField | null {
  if (table) {
    return ctx.sourceFields.find(
      f => f.tableName === table && f.name.toLowerCase() === name.toLowerCase()
    ) ?? null;
  }
  return ctx.sourceFields.find(f => f.name.toLowerCase() === name.toLowerCase()) ?? null;
}
