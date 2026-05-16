//! FILENAME: app/extensions/Pivot/dsl/dsl-workflows.test.ts
// PURPOSE: Complex real-world pivot DSL workflow simulations exercising the
//          full pipeline: lex -> parse -> validate -> compile -> serialize.

import { describe, it, expect } from "vitest";
import { lex } from "./lexer";
import { parse } from "./parser";
import { compile, type CompileContext } from "./compiler";
import { serialize } from "./serializer";
import { processDsl } from "./index";
import { PIVOT_TEMPLATES } from "../lib/namedConfigs";
import type { SourceField, ZoneField } from "../../_shared/components/types";
import type { LayoutConfig, BiPivotModelInfo } from "../components/types";

// ============================================================================
// Helpers
// ============================================================================

function sf(index: number, name: string, isNumeric = false): SourceField {
  return { index, name, isNumeric };
}

/** Finance-oriented source fields. */
const FINANCE_FIELDS: SourceField[] = [
  sf(0, "Department"),
  sf(1, "CostCenter"),
  sf(2, "Account"),
  sf(3, "Month"),
  sf(4, "Quarter"),
  sf(5, "Budget", true),
  sf(6, "Actual", true),
  sf(7, "Forecast", true),
  sf(8, "Headcount", true),
  sf(9, "Region"),
  sf(10, "Year"),
];

function ctx(
  fields: SourceField[] = FINANCE_FIELDS,
  biModel?: BiPivotModelInfo,
  filterUniqueValues?: Map<string, string[]>,
): CompileContext {
  return { sourceFields: fields, biModel, filterUniqueValues };
}

function run(dsl: string, context?: CompileContext) {
  return processDsl(dsl, context ?? ctx());
}

// ============================================================================
// Workflow 1: Finance report
// ============================================================================

describe("Finance report workflow", () => {
  it("builds a full budget-vs-actual report DSL", () => {
    const dsl = `
ROWS:    Department, CostCenter
COLUMNS: Quarter
VALUES:  Sum(Budget), Sum(Actual)
FILTERS: Region NOT IN ("APAC")
LAYOUT:  tabular, repeat-labels, no-column-totals
    `.trim();

    const result = run(dsl);
    const errors = result.errors.filter((e) => e.severity === "error");
    expect(errors).toHaveLength(0);

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].name).toBe("Department");
    expect(result.rows[1].name).toBe("CostCenter");
    expect(result.columns).toHaveLength(1);
    expect(result.columns[0].name).toBe("Quarter");
    expect(result.values).toHaveLength(2);
    expect(result.values[0].aggregation).toBe("sum");
    expect(result.values[1].aggregation).toBe("sum");
    expect(result.filters[0].hiddenItems).toEqual(["APAC"]);
    expect(result.layout.reportLayout).toBe("tabular");
    expect(result.layout.repeatRowLabels).toBe(true);
    expect(result.layout.showColumnGrandTotals).toBe(false);
  });

  it("adds a calculated variance field", () => {
    const dsl = `
ROWS:    Department
VALUES:  Sum(Budget), Sum(Actual), CALC Variance = [Actual] - [Budget]
LAYOUT:  compact
    `.trim();

    const result = run(dsl);
    const errors = result.errors.filter((e) => e.severity === "error");
    expect(errors).toHaveLength(0);

    expect(result.values).toHaveLength(2);
    expect(result.calculatedFields).toHaveLength(1);
    expect(result.calculatedFields[0].name).toBe("Variance");
    expect(result.calculatedFields[0].formula).toContain("[Actual]");
    expect(result.calculatedFields[0].formula).toContain("[Budget]");

    // Column ordering should preserve interleaving
    expect(result.valueColumnOrder).toHaveLength(3);
    expect(result.valueColumnOrder[2]).toEqual({ type: "calculated", index: 0 });
  });

  it("serializes the compiled finance report back to DSL and re-parses", () => {
    const rows: ZoneField[] = [
      { sourceIndex: 0, name: "Department", isNumeric: false },
      { sourceIndex: 1, name: "CostCenter", isNumeric: false },
    ];
    const columns: ZoneField[] = [
      { sourceIndex: 4, name: "Quarter", isNumeric: false },
    ];
    const values: ZoneField[] = [
      { sourceIndex: 5, name: "Budget", isNumeric: true, aggregation: "sum" },
      { sourceIndex: 6, name: "Actual", isNumeric: true, aggregation: "sum" },
    ];
    const filters: ZoneField[] = [
      { sourceIndex: 9, name: "Region", isNumeric: false, hiddenItems: ["APAC"] },
    ];
    const layout: LayoutConfig = {
      reportLayout: "tabular",
      repeatRowLabels: true,
      showColumnGrandTotals: false,
    };

    const text = serialize(rows, columns, values, filters, layout);
    expect(text).toContain("ROWS:");
    expect(text).toContain("Department");
    expect(text).toContain("Sum(Budget)");
    expect(text).toContain("Region NOT IN");

    // Re-parse and verify round-trip
    const result = run(text);
    const errors = result.errors.filter((e) => e.severity === "error");
    expect(errors).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
    expect(result.columns).toHaveLength(1);
    expect(result.values).toHaveLength(2);
    expect(result.filters[0].hiddenItems).toEqual(["APAC"]);
  });

  it("compiles a report with multiple aggregation types", () => {
    const dsl = `
ROWS:    Department
VALUES:  Sum(Budget), Average(Actual), Max(Forecast), Min(Headcount), Count(CostCenter)
    `.trim();

    const result = run(dsl);
    const errors = result.errors.filter((e) => e.severity === "error");
    expect(errors).toHaveLength(0);

    expect(result.values).toHaveLength(5);
    expect(result.values[0].aggregation).toBe("sum");
    expect(result.values[1].aggregation).toBe("average");
    expect(result.values[2].aggregation).toBe("max");
    expect(result.values[3].aggregation).toBe("min");
    expect(result.values[4].aggregation).toBe("count");
  });

  it("compiles show-values-as percentage of total for budget analysis", () => {
    const dsl = `
ROWS:    Department
VALUES:  Sum(Budget) [% of Grand Total], Sum(Actual) [% of Column]
    `.trim();

    const result = run(dsl);
    const errors = result.errors.filter((e) => e.severity === "error");
    expect(errors).toHaveLength(0);

    expect(result.values[0].showValuesAs).toBe("percent_of_total");
    expect(result.values[1].showValuesAs).toBe("percent_of_column");
  });
});

// ============================================================================
// Workflow 2: Iterative refinement
// ============================================================================

describe("Iterative refinement workflow", () => {
  it("starts with just ROWS and progressively adds clauses", () => {
    // Step 1: Just rows
    let dsl = "ROWS: Department";
    let result = run(dsl);
    expect(result.errors.filter((e) => e.severity === "error")).toHaveLength(0);
    expect(result.rows).toHaveLength(1);
    expect(result.values).toHaveLength(0);

    // Step 2: Add values
    dsl = "ROWS: Department\nVALUES: Sum(Budget)";
    result = run(dsl);
    expect(result.errors.filter((e) => e.severity === "error")).toHaveLength(0);
    expect(result.values).toHaveLength(1);

    // Step 3: Add columns
    dsl = "ROWS: Department\nCOLUMNS: Quarter\nVALUES: Sum(Budget)";
    result = run(dsl);
    expect(result.errors.filter((e) => e.severity === "error")).toHaveLength(0);
    expect(result.columns).toHaveLength(1);

    // Step 4: Add filter
    dsl = "ROWS: Department\nCOLUMNS: Quarter\nVALUES: Sum(Budget)\nFILTERS: Region NOT IN (\"APAC\")";
    result = run(dsl);
    expect(result.errors.filter((e) => e.severity === "error")).toHaveLength(0);
    expect(result.filters).toHaveLength(1);

    // Step 5: Add layout
    dsl += "\nLAYOUT: tabular, repeat-labels";
    result = run(dsl);
    expect(result.errors.filter((e) => e.severity === "error")).toHaveLength(0);
    expect(result.layout.reportLayout).toBe("tabular");
    expect(result.layout.repeatRowLabels).toBe(true);
  });

  it("adds a second row field and verifies ordering", () => {
    const dsl1 = "ROWS: Department\nVALUES: Sum(Budget)";
    const result1 = run(dsl1);
    expect(result1.rows).toHaveLength(1);

    const dsl2 = "ROWS: Department, CostCenter\nVALUES: Sum(Budget)";
    const result2 = run(dsl2);
    expect(result2.rows).toHaveLength(2);
    expect(result2.rows[0].name).toBe("Department");
    expect(result2.rows[1].name).toBe("CostCenter");
  });

  it("adds calculated field after initial values", () => {
    const dsl1 = "VALUES: Sum(Budget), Sum(Actual)";
    const result1 = run(dsl1);
    expect(result1.values).toHaveLength(2);
    expect(result1.calculatedFields).toHaveLength(0);

    const dsl2 = "VALUES: Sum(Budget), Sum(Actual), CALC Variance = [Actual] - [Budget]";
    const result2 = run(dsl2);
    expect(result2.values).toHaveLength(2);
    expect(result2.calculatedFields).toHaveLength(1);
  });

  it("switches layout from compact to tabular", () => {
    const result1 = run("ROWS: Department\nLAYOUT: compact");
    expect(result1.layout.reportLayout).toBe("compact");

    const result2 = run("ROWS: Department\nLAYOUT: tabular");
    expect(result2.layout.reportLayout).toBe("tabular");
  });

  it("refines filter from NOT IN to inclusion", () => {
    const uniqueValues = new Map([
      ["Region", ["Americas", "EMEA", "APAC", "Other"]],
    ]);
    const context = ctx(FINANCE_FIELDS, undefined, uniqueValues);

    const dsl1 = 'FILTERS: Region NOT IN ("APAC", "Other")';
    const result1 = run(dsl1, context);
    expect(result1.filters[0].hiddenItems).toEqual(["APAC", "Other"]);

    // Equivalent: include only Americas and EMEA
    const dsl2 = 'FILTERS: Region = ("Americas", "EMEA")';
    const result2 = run(dsl2, context);
    expect(result2.filters[0].hiddenItems).toEqual(
      expect.arrayContaining(["APAC", "Other"]),
    );
    expect(result2.filters[0].hiddenItems).toHaveLength(2);
  });

  it("adds alias to value field", () => {
    const result = run('VALUES: Sum(Budget) AS "Annual Budget"');
    expect(result.values[0].customName).toBe("Annual Budget");
  });

  it("adds SAVE AS clause for named layout", () => {
    const result = run('ROWS: Department\nVALUES: Sum(Budget)\nSAVE AS "Budget Overview"');
    expect(result.saveAs).toBe("Budget Overview");
  });
});

// ============================================================================
// Workflow 3: Template application
// ============================================================================

describe("Template application workflow", () => {
  it("PIVOT_TEMPLATES array has expected templates", () => {
    expect(PIVOT_TEMPLATES.length).toBeGreaterThanOrEqual(4);
    const names = PIVOT_TEMPLATES.map((t) => t.name);
    expect(names).toContain("Basic Summary");
    expect(names).toContain("Cross-Tab");
    expect(names).toContain("Year-over-Year");
    expect(names).toContain("Detailed Report");
  });

  it("Basic Summary template lexes and parses without errors", () => {
    const template = PIVOT_TEMPLATES.find((t) => t.name === "Basic Summary")!;
    const { tokens, errors: lexErrors } = lex(template.dslText);
    expect(lexErrors).toHaveLength(0);
    const { errors: parseErrors } = parse(tokens);
    expect(parseErrors).toHaveLength(0);
  });

  it("Cross-Tab template lexes and parses without errors", () => {
    const template = PIVOT_TEMPLATES.find((t) => t.name === "Cross-Tab")!;
    const { tokens, errors: lexErrors } = lex(template.dslText);
    expect(lexErrors).toHaveLength(0);
    const { errors: parseErrors } = parse(tokens);
    expect(parseErrors).toHaveLength(0);
  });

  it("customizes Basic Summary template with finance fields", () => {
    // Replace placeholder comments with actual fields
    const customized = `ROWS:    Department, CostCenter
VALUES:  Sum(Budget), Sum(Actual)
LAYOUT:  compact`;

    const result = run(customized);
    const errors = result.errors.filter((e) => e.severity === "error");
    expect(errors).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
    expect(result.values).toHaveLength(2);
    expect(result.layout.reportLayout).toBe("compact");
  });

  it("customizes Cross-Tab template for budget vs actual by quarter", () => {
    const customized = `ROWS:    Department
COLUMNS: Quarter
VALUES:  Sum(Budget), Sum(Actual)
LAYOUT:  tabular`;

    const result = run(customized);
    const errors = result.errors.filter((e) => e.severity === "error");
    expect(errors).toHaveLength(0);
    expect(result.rows).toHaveLength(1);
    expect(result.columns).toHaveLength(1);
    expect(result.columns[0].name).toBe("Quarter");
    expect(result.layout.reportLayout).toBe("tabular");
  });

  it("customizes Detailed Report template with no grand totals", () => {
    const customized = `ROWS:    Department, Account
VALUES:  Sum(Actual), Average(Budget)
LAYOUT:  tabular, repeat-labels, no-grand-totals`;

    const result = run(customized);
    const errors = result.errors.filter((e) => e.severity === "error");
    expect(errors).toHaveLength(0);
    expect(result.layout.repeatRowLabels).toBe(true);
    expect(result.layout.showRowGrandTotals).toBe(false);
    expect(result.layout.showColumnGrandTotals).toBe(false);
  });

  it("customized template round-trips through serialize and re-parse", () => {
    const dsl = `ROWS:    Department, Region
COLUMNS: Year
VALUES:  Sum(Budget) AS "Total Budget", Sum(Actual) AS "Total Actual"
FILTERS: Quarter NOT IN ("Q4")
LAYOUT:  outline, auto-fit`;

    const result1 = run(dsl);
    expect(result1.errors.filter((e) => e.severity === "error")).toHaveLength(0);

    // Serialize back to DSL text
    const rows: ZoneField[] = result1.rows;
    const columns: ZoneField[] = result1.columns;
    const values: ZoneField[] = result1.values;
    const filters: ZoneField[] = result1.filters;
    const serialized = serialize(rows, columns, values, filters, result1.layout);

    // Re-parse
    const result2 = run(serialized);
    expect(result2.errors.filter((e) => e.severity === "error")).toHaveLength(0);
    expect(result2.rows).toHaveLength(2);
    expect(result2.columns).toHaveLength(1);
    expect(result2.values).toHaveLength(2);
    expect(result2.layout.reportLayout).toBe("outline");
    expect(result2.layout.autoFitColumnWidths).toBe(true);
  });

  it("all templates produce valid token streams", () => {
    for (const template of PIVOT_TEMPLATES) {
      const { errors } = lex(template.dslText);
      expect(errors).toHaveLength(0);
    }
  });

  it("template with values-on-rows layout compiles correctly", () => {
    const dsl = `ROWS:    Department
VALUES:  Sum(Budget), Sum(Actual), Sum(Forecast)
LAYOUT:  tabular, values-on-rows`;

    const result = run(dsl);
    const errors = result.errors.filter((e) => e.severity === "error");
    expect(errors).toHaveLength(0);
    expect(result.layout.valuesPosition).toBe("rows");
    expect(result.values).toHaveLength(3);
  });
});
