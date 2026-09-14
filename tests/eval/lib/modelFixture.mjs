//! FILENAME: tests/eval/lib/modelFixture.mjs
// PURPOSE: Turn the checked-in model fixture into the shapes the design-query
//          assistant works over, so the eval runner and the Layer A tests read
//          ONE fixture rather than each hand-typing a model.
// CONTEXT: `tests/fixtures/model/sales_star.json` is the engine's own
//          `DataModel` JSON; the assistant sees a `BiPivotModelInfo` (tables,
//          columns, measures) plus a `DesignStrategySummary`. In the product
//          Rust builds both (`pivot/headless.rs`, `insights/describe.rs`); here
//          they are derived in JavaScript from the same two files. The Rust
//          tests in `describe.rs` and `designQueryCorpus.test.ts` pin the same
//          facts about the same fixture, which is what keeps this derivation
//          honest.

const NUMERIC = new Set([
  "int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64",
  "float32", "float64", "decimal",
]);

/**
 * The fixture bundle's model as a `BiPivotModelInfo`.
 * @param {{ model: any }} bundle the parsed `sales_star.json`
 */
export function modelInfoFromFixture(bundle) {
  const model = bundle.model;
  const tables = model.tables.map((t) => ({
    name: t.name,
    columns: t.columns.map((c) => ({
      name: c.name,
      dataType: c.data_type,
      isNumeric: NUMERIC.has(String(c.data_type).toLowerCase()),
    })),
  }));
  const measures = (model.measures ?? []).map((m) => ({
    name: m.name,
    table: m.table ?? model.tables[0]?.name ?? "",
    sourceColumn: "",
    aggregation: "sum",
  }));
  return {
    connectionId: "fixture",
    tables,
    measures,
    lookupColumns: [],
    // CARRIED THROUGH, not blanked. This was hardcoded `[]` while
    // `sales_star.json` declares a real "Region to Country" hierarchy, so every
    // rule and every eval that reads a drill-down path was silently untestable
    // — the code looked exercised and was not. Both the corpus gate and
    // `run-next-edit-eval.mjs` derive their model from here.
    hierarchies: (model.hierarchies ?? []).map((h) => ({
      name: h.name,
      table: h.table,
      levels: (h.levels ?? []).map((l) => ({ column: l.column })),
    })),
    calculationGroups: [],
    perspectives: [],
    cultures: [],
  };
}

/**
 * The fixture's strategy document as a `DesignStrategySummary`: the run's
 * measure order (declared priority, then KPI measures, then the rest by name),
 * the per-measure hints, the column roles, the label columns, the time axis
 * and the calendar table.
 * @param {any} doc the parsed `sales_star_strategy.json`
 * @param {{ model: any }} bundle the parsed `sales_star.json`
 */
export function strategySummaryFromFixture(doc, bundle) {
  const model = bundle.model;
  const measureNames = (model.measures ?? []).map((m) => m.name);
  const kpiMeasures = new Set((model.kpis ?? []).map((k) => k.base_measure));
  const order = [];
  const seen = new Set();
  const push = (name) => {
    if (measureNames.includes(name) && !seen.has(name)) {
      seen.add(name);
      order.push(name);
    }
  };
  for (const name of doc.model?.priority ?? []) push(name);
  for (const name of [...measureNames].sort()) if (kpiMeasures.has(name)) push(name);
  for (const name of [...measureNames].sort()) push(name);

  const measures = {};
  for (const [name, entry] of Object.entries(doc.measures ?? {})) {
    const hints = {
      direction: entry.direction ?? null,
      analysisDimensions: entry.analysisDimensions ?? [],
      neverSliceBy: entry.neverSliceBy ?? [],
    };
    if (hints.direction || hints.analysisDimensions.length || hints.neverSliceBy.length) {
      measures[name] = hints;
    }
  }

  const columnRoles = {};
  const labelColumns = {};
  let calendarTable = model.date_table ?? null;
  for (const [table, entry] of Object.entries(doc.tables ?? {})) {
    for (const [column, c] of Object.entries(entry.columns ?? {})) {
      if (c.role) columnRoles[`${table}[${column}]`] = c.role;
    }
    if (entry.labelColumn) labelColumns[table] = entry.labelColumn;
    if (!calendarTable && entry.kind === "calendar") calendarTable = table;
  }

  return {
    measureOrder: order,
    measures,
    columnRoles,
    labelColumns,
    timeAxis: doc.model?.defaultTimeAxis ?? null,
    calendarTable,
  };
}
