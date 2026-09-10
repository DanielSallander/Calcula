//! FILENAME: app/extensions/_shared/dsl/pivotLayout/canonical.ts
// PURPOSE: One canonical form for "these two queries mean the same thing".
// CONTEXT: The eval corpus grades a model's query against a reference, and
//          the compiled `DesignQueryRequest` is the wrong thing to compare:
//          it carries no SORT and no TOP N, and an inclusion filter compiles to
//          "no filter" when no member list is at hand. The PARSED form carries
//          all of it. This renders the AST with names lower-cased, locations
//          dropped and layout directives sorted, so `ROWS: product.category`
//          and `ROWS: Product.Category` are one query and a missing SORT is a
//          different one.
//
//          Null when the text does not parse: an unparseable query is never
//          "equal" to anything, including another unparseable one.
//
//          Measured 2026-09-10 on the first corpus run: several of a 3B
//          model's "wrong" answers differed from the reference only by an
//          explicit `LAYOUT: compact` — the default, spelled out. So the
//          layout is compared as the pivot would DRAW it, defaults removed,
//          not as the directive list was typed.

import { lex } from './lexer';
import { parse } from './parser';
import { compile } from './compiler';
import type { FieldNode, FilterFieldNode, PivotLayoutAST, SortNode, ValueFieldNode } from './ast';
import type { LayoutConfig } from '../../components/types';

/**
 * The layout as the pivot will actually draw it, with every DEFAULT removed.
 *
 * `LAYOUT: compact` draws the same table as no LAYOUT at all, and
 * `no-row-totals, no-column-totals` is the serializer's own spelling of
 * `no-grand-totals` — so the directive LIST is the wrong thing to compare.
 * The compiled config is compared instead, through the real compiler, with
 * the keys that equal the pivot's defaults dropped.
 */
function canonicalLayout(ast: PivotLayoutAST): Record<string, unknown> {
  const layout: LayoutConfig = compile({ ...ast, rows: [], columns: [], values: [], filters: [], calculatedFields: [] }, { sourceFields: [] }).layout;
  const out: Record<string, unknown> = {};
  if (layout.reportLayout && layout.reportLayout !== 'compact') out.reportLayout = layout.reportLayout;
  if (layout.showRowGrandTotals === false) out.showRowGrandTotals = false;
  if (layout.showColumnGrandTotals === false) out.showColumnGrandTotals = false;
  if (layout.repeatRowLabels !== undefined) out.repeatRowLabels = layout.repeatRowLabels;
  if (layout.showEmptyRows) out.showEmptyRows = true;
  if (layout.showEmptyCols) out.showEmptyCols = true;
  if (layout.valuesPosition === 'rows') out.valuesPosition = 'rows';
  if (layout.autoFitColumnWidths) out.autoFitColumnWidths = true;
  // Directives `LayoutConfig` cannot hold. The compiler DROPS these today
  // (`compiler.ts` has no case for them, though the validator accepts them and
  // the editor offers them — filed in open-items.md 2.AI.10), so they are
  // carried from the directive list: a person who asked for subtotals off
  // asked for something different from one who did not, whether or not the
  // pivot honours it yet.
  const unrepresented = ast.layout
    .map((d) => d.key.toLowerCase())
    .filter((k) => k.startsWith('subtotals-'))
    .sort();
  if (unrepresented.length > 0) out.subtotals = unrepresented;
  return out;
}

function field(f: FieldNode): unknown {
  return {
    name: f.name.toLowerCase(),
    lookup: f.isLookup || undefined,
    subtotals: f.subtotals,
    grouping: f.grouping ? { type: f.grouping.type, levels: f.grouping.levels, params: f.grouping.params } : undefined,
    via: f.via?.path.toLowerCase(),
    hidden: f.hiddenItems && f.hiddenItems.length ? [...f.hiddenItems].sort() : undefined,
  };
}

function value(v: ValueFieldNode, ast: PivotLayoutAST): unknown {
  if (v.inlineCalcIndex !== undefined) {
    const calc = ast.calculatedFields[v.inlineCalcIndex];
    return { calc: calc?.name.toLowerCase(), expression: calc?.expression };
  }
  return {
    field: v.fieldName.toLowerCase(),
    measure: v.isMeasure || undefined,
    aggregation: v.aggregation,
    alias: v.alias,
    showAs: v.showValuesAs,
  };
}

function filter(f: FilterFieldNode): unknown {
  return {
    name: f.fieldName.toLowerCase(),
    values: [...f.values].sort(),
    exclude: f.exclude || undefined,
  };
}

function sort(s: SortNode): unknown {
  return { name: s.fieldName.toLowerCase(), direction: s.direction };
}

/** The canonical JSON of a query, or null when it does not parse. */
export function canonicalDesignQuery(dsl: string): string | null {
  const { tokens, errors: lexErrors } = lex(dsl);
  if (lexErrors.some((e) => e.severity === 'error')) return null;
  const { ast, errors } = parse(tokens);
  if (errors.some((e) => e.severity === 'error')) return null;
  const shape = {
    rows: ast.rows.map(field),
    columns: ast.columns.map(field),
    values: ast.values.map((v) => value(v, ast)),
    filters: ast.filters.map(filter),
    sort: ast.sort.map(sort),
    layout: canonicalLayout(ast),
    calc: ast.calculatedFields
      .filter((_, i) => !ast.values.some((v) => v.inlineCalcIndex === i))
      .map((c) => ({ name: c.name.toLowerCase(), expression: c.expression })),
    top: ast.topN
      ? { count: ast.topN.count, top: ast.topN.top, by: ast.topN.byField.toLowerCase(), aggregation: ast.topN.byAggregation }
      : undefined,
    saveAs: ast.saveAs,
  };
  return JSON.stringify(shape);
}

/** True when both parse and mean the same thing. */
export function sameDesignQuery(a: string, b: string): boolean {
  const ca = canonicalDesignQuery(a);
  const cb = canonicalDesignQuery(b);
  return ca !== null && cb !== null && ca === cb;
}
