// FILENAME: tests/fixtures/model/gen-sales-star.mjs
// PURPOSE: Regenerate tests/fixtures/model/sales_star.json — the star-schema model
//          document AND its fact rows — byte-for-byte deterministically.
// CONTEXT: The model-path insights tests (plan §6.9) all run against this one fixture.
//          If the fixture is not reproducible, a test that "passes" proves nothing about
//          the engine and everything about whoever last hand-edited a number. So this
//          script is the SOURCE OF TRUTH for sales_star.json: the model definition, the
//          dimension rows and the fact rows are all emitted here, and the checked-in JSON
//          is exactly what `node gen-sales-star.mjs` writes.
//
//          Randomness is an explicit 32-bit LCG seeded by SEED below. `Math.random` must
//          never appear in this file, and neither may `Math.sin`/`Math.exp`/`Math.pow`
//          with a non-integer exponent: ECMA-262 leaves transcendental results
//          implementation-defined, so a seasonal curve computed with `Math.sin` would
//          make the fixture reproducible only on the engine that first wrote it. The
//          seasonal shape is therefore a hard-coded table.
//
// Usage:   node tests/fixtures/model/gen-sales-star.mjs
//          node tests/fixtures/model/gen-sales-star.mjs --check   (regenerate to memory
//          and diff against the checked-in file; exit 1 on drift)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(HERE, "sales_star.json");

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

/** The one seed. Change it and every number in the fixture changes. */
const SEED = 20260907;

/**
 * Numerical Recipes 32-bit linear congruential generator.
 * x' = (1664525 * x + 1013904223) mod 2^32
 *
 * Implemented with Math.imul + >>> 0 so the multiply wraps in exactly 32 bits
 * rather than losing low bits to double rounding — that is the difference
 * between "deterministic" and "deterministic on my machine".
 */
function makeLcg(seed) {
  let x = seed >>> 0;
  return function next() {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x;
  };
}

/** Integer in [0, n). */
function pick(next, n) {
  return next() % n;
}

/** Two-decimal round. Deterministic: IEEE-754 doubles, ties away from -Inf. */
function r2(x) {
  return Math.round(x * 100) / 100;
}

// ---------------------------------------------------------------------------
// Dimension shape
// ---------------------------------------------------------------------------

const CATEGORIES = ["Widgets", "Gadgets", "Gizmos", "Doodads", "Trinkets"];

/** The one category whose Amount is planted to collapse in the final month. */
const PLANTED_CATEGORY = "Gadgets";
/** Multiplier applied to that category's Quantity in the final month only. */
const PLANTED_FACTOR = 0.55;

/** Cost as a share of list price, per category. Fixed, not drawn. */
const COST_RATIO = {
  Widgets: 0.62,
  Gadgets: 0.58,
  Gizmos: 0.68,
  Doodads: 0.71,
  Trinkets: 0.55,
};

/**
 * Subcategories — the SNOWFLAKE. These live in their own dimension table that is
 * related to Product, NOT to Sales, so `Subcategory[SubcategoryName]` is reachable
 * only through a second hop. Nothing else in the fixture is two hops from the fact.
 */
const SUBCATEGORIES = [
  { key: 1, name: "Widgets - Standard", category: "Widgets" },
  { key: 2, name: "Widgets - Heavy Duty", category: "Widgets" },
  { key: 3, name: "Gadgets - Handheld", category: "Gadgets" },
  { key: 4, name: "Gadgets - Mounted", category: "Gadgets" },
  { key: 5, name: "Gizmos - Analogue", category: "Gizmos" },
  { key: 6, name: "Gizmos - Digital", category: "Gizmos" },
  { key: 7, name: "Doodads - Indoor", category: "Doodads" },
  { key: 8, name: "Doodads - Outdoor", category: "Doodads" },
  { key: 9, name: "Trinkets - Gift", category: "Trinkets" },
  { key: 10, name: "Trinkets - Bulk", category: "Trinkets" },
];

const SEGMENTS = [
  { name: "Enterprise", factor: 1.6 },
  { name: "Mid-Market", factor: 1.15 },
  { name: "SMB", factor: 0.7 },
  { name: "Public Sector", factor: 0.95 },
];

const REGIONS = [
  { name: "Nordics", factor: 1.2, countries: ["Sweden", "Denmark"] },
  { name: "DACH", factor: 1.35, countries: ["Germany", "Austria"] },
  { name: "Benelux", factor: 0.85, countries: ["Netherlands", "Belgium"] },
  { name: "UK and Ireland", factor: 1.05, countries: ["United Kingdom", "Ireland"] },
];

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Seasonal multipliers by calendar month (Jan..Dec). Hard-coded rather than
 * computed from a trig function — see the header note on transcendentals.
 *
 * November and December are DELIBERATELY equal. The planted shift is measured as
 * month 24 against month 23, and if the seasonal factor moved between those two
 * months then EVERY category would fall together — the planted member would still
 * lead, but "every other category is flat" would be a lie and the contribution
 * shares would be measuring the calendar. The first run of this generator did
 * exactly that (Nov 1.12 -> Dec 1.02) and the planted share came out at 0.65 with
 * a third of the drop belonging to seasonality.
 */
const SEASONAL = [0.94, 0.92, 1.03, 1.01, 1.06, 1.09, 0.88, 0.86, 1.07, 1.1, 1.05, 1.05];

/** 24 monthly periods: 2024-01 .. 2025-12. */
const MONTHS = 24;
const FIRST_YEAR = 2024;

/** Share of the (product x customer x geography) cube that carries any sales at all. */
const CELL_DENSITY_PERCENT = 55;

// ---------------------------------------------------------------------------
// Build the dimensions
// ---------------------------------------------------------------------------

const next = makeLcg(SEED);

/** 15 products: three per category, each in one subcategory. */
const products = [];
for (let c = 0; c < CATEGORIES.length; c += 1) {
  const category = CATEGORIES[c];
  const subs = SUBCATEGORIES.filter((s) => s.category === category);
  for (let i = 0; i < 3; i += 1) {
    const key = products.length + 1;
    const unitPrice = r2(20 + pick(next, 18000) / 100);
    const baseQty = 6 + pick(next, 25);
    const costJitter = 0.96 + pick(next, 81) / 1000;
    products.push({
      key,
      category,
      subcategoryKey: subs[i % subs.length].key,
      name: `${category.slice(0, -1)} ${String.fromCharCode(65 + i)}${key}`,
      unitPrice,
      unitCost: r2(unitPrice * COST_RATIO[category] * costJitter),
      baseQty,
    });
  }
}

/** 8 customers: two per segment. */
const customers = [];
for (const segment of SEGMENTS) {
  for (let i = 0; i < 2; i += 1) {
    const key = customers.length + 1;
    customers.push({
      key,
      segment: segment.name,
      factor: segment.factor,
      name: `${segment.name} Account ${i + 1}`,
    });
  }
}

/** 8 geographies: two countries per region. */
const geographies = [];
for (const region of REGIONS) {
  for (const country of region.countries) {
    geographies.push({
      key: geographies.length + 1,
      region: region.name,
      factor: region.factor,
      country,
    });
  }
}

/** 24 monthly periods, first-of-month date keys. */
const dates = [];
for (let m = 0; m < MONTHS; m += 1) {
  const year = FIRST_YEAR + Math.floor(m / 12);
  const monthNumber = (m % 12) + 1;
  const mm = String(monthNumber).padStart(2, "0");
  dates.push({
    date: `${year}-${mm}-01`,
    year,
    month: `${year}-${mm}`,
    monthName: MONTH_NAMES[monthNumber - 1],
    monthNumber,
  });
}

/**
 * The sparse cell mask over (product x customer x geography), drawn ONCE and
 * reused for every month. A mask redrawn per month would make the set of
 * (product, customer, geo) combinations differ between the final month and the
 * one before it, and the "planted shift" test would then be measuring the mask
 * rather than the plant.
 */
const cells = [];
for (const product of products) {
  for (const customer of customers) {
    for (const geo of geographies) {
      if (pick(next, 100) < CELL_DENSITY_PERCENT) {
        cells.push({ product, customer, geo });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Build the fact rows
// ---------------------------------------------------------------------------

const salesRows = [];
for (let m = 0; m < MONTHS; m += 1) {
  const period = dates[m];
  const trend = 1 + 0.004 * m;
  const seasonal = SEASONAL[period.monthNumber - 1];
  const isFinalMonth = m === MONTHS - 1;
  for (const cell of cells) {
    const noise = 0.94 + pick(next, 121) / 1000;
    let quantity = Math.round(
      cell.product.baseQty * cell.customer.factor * cell.geo.factor * trend * seasonal * noise,
    );
    if (quantity < 1) quantity = 1;
    // THE ONE PLANTED THING: in the final month the planted category's volume
    // collapses. Amount, Cost and Quantity all move together, because this is a
    // volume drop, not a margin event — that keeps `Margin` exactly decomposable
    // into `Revenue - Cost` and leaves `MarginPct` moved only by mix.
    if (isFinalMonth && cell.product.category === PLANTED_CATEGORY) {
      quantity = Math.max(1, Math.round(quantity * PLANTED_FACTOR));
    }
    salesRows.push([
      period.date,
      cell.product.key,
      cell.customer.key,
      cell.geo.key,
      r2(cell.product.unitPrice * quantity),
      r2(cell.product.unitCost * quantity),
      quantity,
    ]);
  }
}

// ---------------------------------------------------------------------------
// Measure the plant (never assert a planted fact you did not measure)
// ---------------------------------------------------------------------------

const categoryByProductKey = new Map(products.map((p) => [p.key, p.category]));
const finalDate = dates[MONTHS - 1].date;
const previousDate = dates[MONTHS - 2].date;

const revenueByCategory = { current: {}, previous: {} };
for (const category of CATEGORIES) {
  revenueByCategory.current[category] = 0;
  revenueByCategory.previous[category] = 0;
}
for (const row of salesRows) {
  const bucket =
    row[0] === finalDate ? "current" : row[0] === previousDate ? "previous" : null;
  if (bucket) revenueByCategory[bucket][categoryByProductKey.get(row[1])] += row[4];
}

let totalDelta = 0;
const deltaByCategory = {};
for (const category of CATEGORIES) {
  const delta = r2(revenueByCategory.current[category] - revenueByCategory.previous[category]);
  deltaByCategory[category] = delta;
  totalDelta += delta;
}
totalDelta = r2(totalDelta);
const plantedShare = deltaByCategory[PLANTED_CATEGORY] / totalDelta;

// ---------------------------------------------------------------------------
// The model document
// ---------------------------------------------------------------------------

const col = (name, dataType, extra = {}) => ({
  name,
  data_type: dataType,
  nullable: false,
  ...extra,
});

const agg = (operation, table, column) => ({
  Aggregate: {
    operation,
    operand: { QualifiedColumnRef: { table_or_var: table, column } },
  },
});

const model = {
  format_version: 28,
  model_name: "Sales Star",
  model_description:
    "Deterministic star-schema fixture for the model-path insights tests. " +
    "One planted shift: Gadgets volume collapses in the final month.",
  tables: [
    {
      name: "Sales",
      columns: [
        col("Date", "Date"),
        col("ProductKey", "Int64"),
        col("CustomerKey", "Int64"),
        col("GeoKey", "Int64"),
        col("Amount", "Float64", { format_string: "#,##0.00" }),
        col("Cost", "Float64", { format_string: "#,##0.00" }),
        col("Quantity", "Int64", { format_string: "#,##0" }),
      ],
      storage_mode: "in_memory",
    },
    {
      name: "Product",
      columns: [
        col("ProductKey", "Int64", { is_hidden: true }),
        col("Category", "String"),
        col("SubcategoryKey", "Int64", { is_hidden: true }),
        col("Name", "String"),
      ],
      storage_mode: "in_memory",
    },
    {
      name: "Subcategory",
      columns: [
        col("SubcategoryKey", "Int64", { is_hidden: true }),
        col("SubcategoryName", "String"),
      ],
      storage_mode: "in_memory",
    },
    {
      name: "Customer",
      columns: [
        col("CustomerKey", "Int64", { is_hidden: true }),
        col("Segment", "String"),
        col("Name", "String"),
      ],
      storage_mode: "in_memory",
    },
    {
      name: "Geography",
      columns: [
        col("GeoKey", "Int64", { is_hidden: true }),
        col("Region", "String"),
        col("Country", "String"),
      ],
      storage_mode: "in_memory",
    },
    {
      name: "Date",
      columns: [
        col("Date", "Date", { date_role: "DateKey", format_string: "yyyy-mm-dd" }),
        col("Year", "Int32", { date_role: "Year" }),
        col("Month", "String"),
        col("MonthName", "String", { sort_by_column: "MonthNumber" }),
        col("MonthNumber", "Int32", { date_role: "Month" }),
      ],
      storage_mode: "in_memory",
    },
  ],
  relationships: [
    {
      name: "Sales_Product",
      from_table: "Sales",
      to_table: "Product",
      conditions: [{ from_column: "ProductKey", to_column: "ProductKey", operator: "Equal" }],
      cardinality: "ManyToOne",
      propagation: "Auto",
      active: true,
    },
    {
      name: "Sales_Customer",
      from_table: "Sales",
      to_table: "Customer",
      conditions: [{ from_column: "CustomerKey", to_column: "CustomerKey", operator: "Equal" }],
      cardinality: "ManyToOne",
      propagation: "Auto",
      active: true,
    },
    {
      name: "Sales_Geography",
      from_table: "Sales",
      to_table: "Geography",
      conditions: [{ from_column: "GeoKey", to_column: "GeoKey", operator: "Equal" }],
      cardinality: "ManyToOne",
      propagation: "Auto",
      active: true,
    },
    {
      name: "Sales_Date",
      from_table: "Sales",
      to_table: "Date",
      conditions: [{ from_column: "Date", to_column: "Date", operator: "Equal" }],
      cardinality: "ManyToOne",
      propagation: "Auto",
      active: true,
    },
    {
      // THE SNOWFLAKE HOP. Product -> Subcategory, so Subcategory is two hops
      // from Sales and every attribute on it is `unreachable-in-v1` (plan C1).
      name: "Product_Subcategory",
      from_table: "Product",
      to_table: "Subcategory",
      conditions: [
        { from_column: "SubcategoryKey", to_column: "SubcategoryKey", operator: "Equal" },
      ],
      cardinality: "ManyToOne",
      propagation: "Auto",
      active: true,
    },
  ],
  measures: [
    {
      name: "Revenue",
      expression: agg("Sum", "Sales", "Amount"),
      source: "SUM(Sales[Amount])",
      format_string: "#,##0",
      description: "Gross sales amount.",
    },
    {
      name: "Cost",
      expression: agg("Sum", "Sales", "Cost"),
      source: "SUM(Sales[Cost])",
      format_string: "#,##0",
      description: "Cost of goods sold.",
    },
    {
      name: "Margin",
      expression: {
        BinaryOp: {
          left: { MeasureRef: "Revenue" },
          op: "Subtract",
          right: { MeasureRef: "Cost" },
        },
      },
      source: "[Revenue] - [Cost]",
      format_string: "#,##0",
      description: "Revenue less cost. Additive; decomposes exactly into its two terms.",
    },
    {
      name: "MarginPct",
      expression: {
        SafeDivide: {
          numerator: { MeasureRef: "Margin" },
          denominator: { MeasureRef: "Revenue" },
          alternate: null,
        },
      },
      source: "DIVIDE([Margin], [Revenue])",
      format_string: "0.0%",
      description: "Margin as a share of revenue. A ratio: never additive.",
    },
    {
      name: "Quantity",
      expression: agg("Sum", "Sales", "Quantity"),
      source: "SUM(Sales[Quantity])",
      format_string: "#,##0",
      description: "Units shipped.",
    },
    {
      name: "Customers",
      expression: agg("DistinctCount", "Sales", "CustomerKey"),
      source: "DISTINCTCOUNT(Sales[CustomerKey])",
      format_string: "#,##0",
      description: "Distinct customers with sales in the period. Non-additive over time.",
    },
  ],
  calculated_columns: [],
  measure_groups: [],
  hierarchies: [
    {
      // NOT named "Geography": a hierarchy may not share a name with a table.
      name: "Region to Country",
      table: "Geography",
      levels: [{ column: "Region" }, { column: "Country" }],
    },
  ],
  date_table: "Date",
  kpis: [
    {
      name: "Margin % KPI",
      base_measure: "MarginPct",
      target: { Constant: 0.35 },
      status_bands: [
        { threshold: 0.0, status: "OffTrack" },
        { threshold: 0.9, status: "AtRisk" },
        { threshold: 1.0, status: "OnTrack" },
      ],
      description:
        "Margin percent against a 35% goal. Bands are ASCENDING on the base/target ratio, " +
        "which is the higher-is-better shape KPIs can express — see plan C6.",
    },
  ],
};

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

/** A `{columns, rows}` block: compact, one row per line, diffable. */
function tableBlock(indent, columns, rows) {
  const pad = " ".repeat(indent);
  const inner = " ".repeat(indent + 2);
  const lines = rows.map((r) => `${inner}  ${JSON.stringify(r)}`);
  return [
    "{",
    `${inner}"columns": ${JSON.stringify(columns)},`,
    `${inner}"rows": [`,
    lines.join(",\n"),
    `${inner}]`,
    `${pad}}`,
  ].join("\n");
}

function render() {
  const parts = [];
  parts.push("{");
  parts.push(`  "formatVersion": 1,`);
  parts.push(
    `  "generator": ${JSON.stringify(
      {
        script: "tests/fixtures/model/gen-sales-star.mjs",
        seed: SEED,
        algorithm: "lcg32-numerical-recipes",
        note: "This file is generated. Edit the generator, never the JSON.",
      },
      null,
      2,
    )
      .split("\n")
      .join("\n  ")},`,
  );
  parts.push(
    `  "model": ${JSON.stringify(model, null, 2).split("\n").join("\n  ")},`,
  );
  parts.push(`  "data": {`);
  const dataEntries = [
    [
      "Sales",
      ["Date", "ProductKey", "CustomerKey", "GeoKey", "Amount", "Cost", "Quantity"],
      salesRows,
    ],
    [
      "Product",
      ["ProductKey", "Category", "SubcategoryKey", "Name"],
      products.map((p) => [p.key, p.category, p.subcategoryKey, p.name]),
    ],
    [
      "Subcategory",
      ["SubcategoryKey", "SubcategoryName"],
      SUBCATEGORIES.map((s) => [s.key, s.name]),
    ],
    [
      "Customer",
      ["CustomerKey", "Segment", "Name"],
      customers.map((c) => [c.key, c.segment, c.name]),
    ],
    [
      "Geography",
      ["GeoKey", "Region", "Country"],
      geographies.map((g) => [g.key, g.region, g.country]),
    ],
    [
      "Date",
      ["Date", "Year", "Month", "MonthName", "MonthNumber"],
      dates.map((d) => [d.date, d.year, d.month, d.monthName, d.monthNumber]),
    ],
  ];
  parts.push(
    dataEntries
      .map(([name, columns, rows]) => `    ${JSON.stringify(name)}: ${tableBlock(4, columns, rows)}`)
      .join(",\n"),
  );
  parts.push(`  },`);
  parts.push(
    `  "planted": ${JSON.stringify(
      {
        what:
          "In the final month the Gadgets category's volume collapses; every other " +
          "category keeps its ordinary trend and seasonal shape.",
        measure: "Revenue",
        dimension: "Product[Category]",
        member: PLANTED_CATEGORY,
        quantityFactor: PLANTED_FACTOR,
        currentPeriod: finalDate,
        previousPeriod: previousDate,
        revenueDeltaByCategory: deltaByCategory,
        totalRevenueDelta: totalDelta,
        shareOfTotalDelta: plantedShare,
      },
      null,
      2,
    )
      .split("\n")
      .join("\n  ")},`,
  );
  parts.push(
    `  "counts": ${JSON.stringify(
      {
        salesRows: salesRows.length,
        months: MONTHS,
        products: products.length,
        subcategories: SUBCATEGORIES.length,
        customers: customers.length,
        geographies: geographies.length,
        cubeCells: cells.length,
      },
      null,
      2,
    )
      .split("\n")
      .join("\n  ")}`,
  );
  parts.push("}");
  return `${parts.join("\n")}\n`;
}

const text = render();

// A plant nobody can point at is not a plant. Refuse to write a fixture whose
// top contributor does not actually dominate the delta the tests will measure.
if (!(plantedShare > 0.5)) {
  console.error(
    `[FAIL] planted share of the total Revenue delta is ${plantedShare} (needs > 0.5). ` +
      `Adjust PLANTED_FACTOR or the noise band and re-run.`,
  );
  process.exit(1);
}

if (process.argv.includes("--check")) {
  const onDisk = readFileSync(OUT_PATH, "utf8");
  if (onDisk !== text) {
    console.error("[FAIL] sales_star.json differs from what the generator produces.");
    process.exit(1);
  }
  console.log("[OK] sales_star.json matches the generator byte for byte.");
} else {
  writeFileSync(OUT_PATH, text, "utf8");
  console.log(`[OK] wrote ${OUT_PATH}`);
  console.log(`     sales rows: ${salesRows.length}`);
  console.log(`     total revenue delta: ${totalDelta}`);
  console.log(`     ${PLANTED_CATEGORY} delta: ${deltaByCategory[PLANTED_CATEGORY]}`);
  console.log(`     planted share of total delta: ${plantedShare}`);
}
