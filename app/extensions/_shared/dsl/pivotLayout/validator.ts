//! FILENAME: app/extensions/Pivot/dsl/validator.ts
// PURPOSE: Semantic validation of a parsed PivotLayoutAST.
// CONTEXT: Runs after parsing, before compilation. Reports warnings
//          and errors for field existence, type mismatches, and duplicates.

import type { PivotLayoutAST, FieldNode, ValueFieldNode, FilterFieldNode, CalcFieldNode } from './ast';
import { type DslError, dslError, dslWarning, dslInfo } from './errors';
import { LAYOUT_DIRECTIVES, TRANSFORM_FUNCTIONS, VISUAL_CALC_FUNCTIONS, CALC_FUNCTION_ALIASES } from './tokens';
import type { SourceField } from '../../components/types';
import type { BiPivotModelInfo } from '../../components/types';

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
    // Skip inline CALC placeholders — their formulas are checked in the
    // calculated-field validation below (the parser stores inline CALCs in
    // ast.calculatedFields alongside standalone CALC clauses)
    if (node.inlineCalcIndex !== undefined) continue;

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
  // Sorting by a calculated field is not supported: the backend sort
  // (sort_pivot_field) only reorders row/column fields by their labels via
  // source_index — calculated columns have no source field to sort by.
  const calcFieldNames = new Set(ast.calculatedFields.map(c => c.name.toLowerCase()));
  for (const node of ast.sort) {
    const lower = node.fieldName.toLowerCase();
    if (calcFieldNames.has(lower)) {
      errors.push(dslError(
        `Sorting by calculated field "${node.fieldName}" is not supported yet`,
        node.location,
      ));
    } else if (!fieldNames.has(lower) && !biFieldNames.has(lower)) {
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

  // --- Validate CALCGROUP ---
  if (ast.calcGroup) {
    if (!isBi) {
      errors.push(dslError('CALCGROUP is only supported for BI model pivots', ast.calcGroup.location));
    } else if (ctx.biModel) {
      const group = ctx.biModel.calculationGroups?.find(
        g => g.name.toLowerCase() === ast.calcGroup!.name.toLowerCase(),
      );
      if (!group) {
        errors.push(dslError(`Unknown calculation group: "${ast.calcGroup.name}"`, ast.calcGroup.location));
      } else {
        const itemNames = new Set(group.items.map(i => i.name.toLowerCase()));
        for (const item of ast.calcGroup.items) {
          if (!itemNames.has(item.toLowerCase())) {
            errors.push(dslError(
              `Unknown calculation item "${item}" in group "${group.name}"`, ast.calcGroup.location,
            ));
          }
        }
      }
    }
  }

  // --- Validate CALC formulas (standalone CALC clauses AND inline CALCs in
  //     VALUES — the parser stores both in ast.calculatedFields) ---
  for (const cf of ast.calculatedFields) {
    validateCalcFormula(cf, errors);
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

// --- CALC formula validation ---

/** Engine limit for CALC formula length (core/pivot-engine/src/calculated.rs MAX_FORMULA_LEN). */
const MAX_CALC_FORMULA_LENGTH = 4096;

/** All function names the engine's CALC evaluator accepts (lowercase). */
const KNOWN_CALC_FUNCTIONS: ReadonlySet<string> = new Set([
  ...TRANSFORM_FUNCTIONS.keys(),
  ...VISUAL_CALC_FUNCTIONS.keys(),
  ...CALC_FUNCTION_ALIASES.keys(),
]);

/**
 * Lightweight structural validation of a CALC formula. Deliberately NOT a full
 * expression parse (the Rust engine owns the grammar): checks non-empty text,
 * length limit, balanced parentheses/brackets/quotes, and that every
 * identifier used as a function call is an engine-known function name.
 */
function validateCalcFormula(cf: CalcFieldNode, errors: DslError[]): void {
  const formula = cf.expression;

  if (formula.trim() === '') {
    errors.push(dslError(`Calculated field "${cf.name}" has an empty formula`, cf.location));
    return;
  }

  if (formula.length > MAX_CALC_FORMULA_LENGTH) {
    errors.push(dslError(
      `Formula for "${cf.name}" is too long (${formula.length} characters, max ${MAX_CALC_FORMULA_LENGTH})`,
      cf.location,
    ));
    return;
  }

  let parenDepth = 0;
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i];

    // Double-quoted string literal ("" is an escaped quote)
    if (ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < formula.length) {
        if (formula[j] === '"') {
          if (formula[j + 1] === '"') { j += 2; continue; }
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) {
        errors.push(dslError(`Unterminated string literal in formula for "${cf.name}"`, cf.location));
        return;
      }
      i = j + 1;
      continue;
    }

    // Single-quoted name reference
    if (ch === "'") {
      const close = formula.indexOf("'", i + 1);
      if (close === -1) {
        errors.push(dslError(`Unterminated quoted name in formula for "${cf.name}"`, cf.location));
        return;
      }
      i = close + 1;
      continue;
    }

    // Bracketed name reference (no nesting)
    if (ch === '[') {
      const close = formula.indexOf(']', i + 1);
      if (close === -1) {
        errors.push(dslError(`Unbalanced brackets in formula for "${cf.name}"`, cf.location));
        return;
      }
      i = close + 1;
      continue;
    }
    if (ch === ']') {
      errors.push(dslError(`Unbalanced brackets in formula for "${cf.name}"`, cf.location));
      return;
    }

    if (ch === '(') { parenDepth++; i++; continue; }
    if (ch === ')') {
      parenDepth--;
      if (parenDepth < 0) {
        errors.push(dslError(`Unbalanced parentheses in formula for "${cf.name}"`, cf.location));
        return;
      }
      i++;
      continue;
    }

    // Identifier — if directly followed by "(", it must be a known function.
    // The engine now hard-errors on unknown function names.
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < formula.length && /[A-Za-z0-9_.]/.test(formula[j])) j++;
      const ident = formula.slice(i, j);
      let k = j;
      while (k < formula.length && (formula[k] === ' ' || formula[k] === '\t')) k++;
      if (formula[k] === '(' && !KNOWN_CALC_FUNCTIONS.has(ident.toLowerCase())) {
        errors.push(dslError(
          `Unknown function "${ident}" in formula for "${cf.name}"`,
          cf.location,
        ));
      }
      i = j;
      continue;
    }

    i++;
  }

  if (parenDepth > 0) {
    errors.push(dslError(`Unbalanced parentheses in formula for "${cf.name}"`, cf.location));
  }
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
