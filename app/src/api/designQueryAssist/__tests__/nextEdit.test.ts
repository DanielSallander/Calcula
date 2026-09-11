//! FILENAME: app/src/api/designQueryAssist/__tests__/nextEdit.test.ts
// PURPOSE: Every rule of the next-edit engine, one at a time, over a strategy
//          built by hand so each assertion names the field it read.
// CONTEXT: The corpus test on the extension side proves the rules never fight
//          a correct query; this file proves each rule fires when it should,
//          says why, and proposes the edit it says it proposes.

import { describe, it, expect } from "vitest";
import {
  MODEL_CLAUSE_PRIORITY,
  NEXT_EDIT_RULES,
  nextClauseSuggestion,
  normalizeRef,
  suggestNextEdits,
  type DesignQueryModel,
  type FactField,
  type FactFilter,
  type FactValue,
  type QueryFacts,
} from "../index";

const col = (name: string, dataType = "String") => ({ name, dataType, isNumeric: /Float|Int/.test(dataType) });

const model: DesignQueryModel = {
  tables: [
    { name: "Sales", columns: [col("Amount", "Float64"), col("ProductKey", "Int64"), col("CustomerKey", "Int64"), col("Date", "Date")] },
    { name: "Product", columns: [col("ProductKey", "Int64"), col("Category"), col("Name")] },
    { name: "Customer", columns: [col("CustomerKey", "Int64"), col("Segment"), col("Name")] },
    { name: "Geography", columns: [col("Region"), col("Country")] },
    { name: "Date", columns: [col("Date", "Date"), col("Year", "Int64"), col("Quarter"), col("MonthName")] },
  ],
  measures: [{ name: "Revenue" }, { name: "Cost" }, { name: "Margin" }],
  strategy: {
    measureOrder: ["Revenue", "Margin", "Cost"],
    measures: {
      Revenue: {
        direction: "higherIsBetter",
        analysisDimensions: ["Product[Category]", "Customer[Segment]", "Geography[Region]"],
        neverSliceBy: ["Product[Name]"],
      },
      Cost: { direction: "lowerIsBetter", analysisDimensions: ["Product[Category]"], neverSliceBy: [] },
      Margin: { direction: "higherIsBetter", analysisDimensions: ["Vanished[Column]"], neverSliceBy: [] },
    },
    columnRoles: {
      "Product[ProductKey]": "key",
      "Customer[CustomerKey]": "key",
      "Sales[ProductKey]": "key",
      "Sales[CustomerKey]": "key",
      "Sales[Amount]": "ignore",
      "Product[Category]": "analysis",
      "Product[Name]": "analysis",
      "Customer[Segment]": "analysis",
      "Customer[Name]": "label",
      "Geography[Region]": "analysis",
    },
    labelColumns: { Customer: "Name", Product: "Name" },
    timeAxis: "Date[Date]",
    calendarTable: "Date",
  },
};

/** `Product.Category` as the facts carry it. */
function f(ref: string): FactField {
  const m = /^([A-Za-z_][\w]*)\.([A-Za-z_][\w ]*)$/.exec(ref);
  return { ref, qualified: m ? `${m[1]}[${m[2]}]` : null };
}
function m(name: string): FactValue {
  return { ref: name, qualified: null, isMeasure: true };
}
function filter(ref: string, valueCount = 1, exclude = false): FactFilter {
  return { ...f(ref), exclude, valueCount };
}
function facts(over: Partial<QueryFacts>): QueryFacts {
  return { rows: [], columns: [], values: [], filters: [], sort: [], topN: null, layout: [], hasParseErrors: false, ...over };
}

const kinds = (s: ReturnType<typeof suggestNextEdits>) => s.map((x) => x.kind);

describe("the rule list", () => {
  it("names every kind once", () => {
    const names = NEXT_EDIT_RULES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("remove-never-slice");
  });

  it("normalises a reference across brackets and case", () => {
    expect(normalizeRef("[Sales.Order Date]")).toBe("sales.order date");
    expect(normalizeRef(" Product.Category ")).toBe("product.category");
  });
});

describe("rule 1: a query with no VALUES", () => {
  it("offers the strategy's first measure and says so", () => {
    const s = suggestNextEdits(facts({ rows: [f("Product.Category")] }), model);
    const values = s.find((x) => x.kind === "add-values")!;
    expect(values.text).toBe("Add VALUES: [Revenue]");
    expect(values.source).toBe("strategy");
    expect(values.reason).toContain("priority order");
    expect(values.op).toEqual({ op: "add-field", clause: "VALUES", text: "[Revenue]" });
    expect(s[0].kind, "the first thing a query needs comes first").toBe("add-values");
  });

  it("falls back to the model's first measure without a strategy", () => {
    const s = suggestNextEdits(facts({ rows: [f("Product.Category")] }), { ...model, strategy: null });
    const values = s.find((x) => x.kind === "add-values")!;
    expect(values.text).toBe("Add VALUES: [Revenue]");
    expect(values.source).toBe("structure");
  });

  it("says nothing when VALUES is there", () => {
    expect(kinds(suggestNextEdits(facts({ rows: [f("Product.Category")], values: [m("Revenue")] }), model))).not.toContain("add-values");
  });
});

describe("rule 2: a measure with no breakdown", () => {
  it("offers the lead measure's first analysis dimension as ROWS", () => {
    const s = suggestNextEdits(facts({ values: [m("Cost"), m("Revenue")] }), model);
    const rows = s.find((x) => x.kind === "add-rows")!;
    // Revenue leads by the strategy's order even though Cost was written first.
    expect(rows.text).toBe("Add ROWS: Product.Category");
    expect(rows.reason).toBe("The strategy analyses Revenue by Product.Category.");
    expect(rows.source).toBe("strategy");
  });

  it("skips an analysis dimension the model no longer has, then falls back to the model's dimensions", () => {
    const s = suggestNextEdits(facts({ values: [m("Margin")] }), model);
    const rows = s.find((x) => x.kind === "add-rows")!;
    expect(rows.source).toBe("structure");
    expect(rows.text.startsWith("Add ROWS: ")).toBe(true);
    expect(rows.text).not.toContain("Vanished");
  });

  it("never volunteers a further breakdown once one exists", () => {
    // The corpus gate refused an "also analyse by" rule on its first run:
    // "revenue by category" is finished, and a chip saying "also by segment"
    // fires on every complete, correct query.
    const s = suggestNextEdits(facts({ rows: [f("Product.Category")], values: [m("Revenue")] }), model);
    expect(kinds(s)).toEqual([]);
  });
});

describe("rule 3: never-slice-by", () => {
  it("asks to remove the forbidden column and names the measure", () => {
    const s = suggestNextEdits(facts({ rows: [f("Product.Name"), f("Product.Category")], values: [m("Revenue")] }), model);
    const never = s.find((x) => x.kind === "remove-never-slice")!;
    expect(never.text).toBe("Remove Product.Name from ROWS");
    expect(never.reason).toBe("The strategy says Revenue is never sliced by Product.Name.");
    expect(never.op).toEqual({ op: "remove-field", clause: "ROWS", ref: "Product.Name" });
    expect(s[0].kind, "outranks the softer suggestions").toBe("remove-never-slice");
  });

  it("is silent when the forbidden column slices a different measure", () => {
    const s = suggestNextEdits(facts({ rows: [f("Product.Name")], values: [m("Cost")] }), model);
    expect(kinds(s)).not.toContain("remove-never-slice");
  });
});

describe("rule 4: direction versus ranking", () => {
  it("offers BOTTOM for TOP over a lower-is-better measure", () => {
    const s = suggestNextEdits(
      facts({ rows: [f("Product.Category")], values: [m("Cost")], topN: { top: true, count: 3, by: "Cost" } }),
      model,
    );
    const rank = s.find((x) => x.kind === "rank-direction")!;
    expect(rank.text).toBe("Use BOTTOM 3 BY [Cost]");
    expect(rank.op).toEqual({ op: "replace-clause", clause: "BOTTOM", line: "BOTTOM 3 BY [Cost]" });
    expect(rank.reason).toContain("better when lower");
  });

  it("leaves TOP over a higher-is-better measure and BOTTOM over anything alone", () => {
    expect(kinds(suggestNextEdits(facts({ rows: [f("Product.Category")], values: [m("Revenue")], topN: { top: true, count: 3, by: "Revenue" } }), model))).not.toContain("rank-direction");
    expect(kinds(suggestNextEdits(facts({ rows: [f("Product.Category")], values: [m("Cost")], topN: { top: false, count: 3, by: "Cost" } }), model))).not.toContain("rank-direction");
  });
});

describe("rule 5: a fine time grain without the year", () => {
  it("offers the year before the month on ROWS", () => {
    const s = suggestNextEdits(facts({ rows: [f("Date.MonthName")], values: [m("Revenue")] }), model);
    const time = s.find((x) => x.kind === "add-coarser-time")!;
    expect(time.text).toBe("Add Date.Year before Date.MonthName");
    expect(time.op).toEqual({ op: "add-field", clause: "ROWS", text: "Date.Year", before: "Date.MonthName" });
    expect(time.reason).toContain("calendar: Date");
  });

  it("is silent when the year is filtered to one value, already present, or the month sits on COLUMNS", () => {
    expect(kinds(suggestNextEdits(facts({ rows: [f("Date.MonthName")], values: [m("Revenue")], filters: [filter("Date.Year")] }), model))).not.toContain("add-coarser-time");
    expect(kinds(suggestNextEdits(facts({ rows: [f("Date.Year"), f("Date.MonthName")], values: [m("Revenue")] }), model))).not.toContain("add-coarser-time");
    expect(kinds(suggestNextEdits(facts({ rows: [f("Product.Category")], columns: [f("Date.MonthName")], values: [m("Revenue")] }), model))).not.toContain("add-coarser-time");
  });

  it("is silent when the year is on COLUMNS — the ordinary month-down, year-across cross-tab", () => {
    // The first version looked for the year on ROWS only, so it called the most
    // common shape in the language wrong and its edit put Date.Year on BOTH
    // axes. The years are already separated across the columns.
    const s = suggestNextEdits(facts({ rows: [f("Date.MonthName")], columns: [f("Date.Year")], values: [m("Revenue")] }), model);
    expect(kinds(s)).not.toContain("add-coarser-time");
    expect(kinds(s)).toEqual([]);
  });

  it("is silent when the calendar's coarsest grouping is not a YEAR", () => {
    // An AdventureWorks-style date table: `MonthNumberOfYear` and
    // `WeekNumberOfYear` are groupings, but nothing in the list is a year — so
    // the sentence "adds the same period across every year" would be a claim
    // the edit cannot support, and the rule must say nothing at all.
    const fiscal: DesignQueryModel = {
      tables: [
        { name: "Sales", columns: [col("Amount", "Float64")] },
        { name: "DimDate", columns: [col("MonthNumberOfYear"), col("WeekNumberOfYear")] },
      ],
      measures: [{ name: "Revenue" }],
      strategy: {
        measureOrder: ["Revenue"],
        measures: { Revenue: { analysisDimensions: [], neverSliceBy: [] } },
        columnRoles: {},
        labelColumns: {},
        timeAxis: null,
        calendarTable: "DimDate",
      },
    };
    const s = suggestNextEdits(facts({ rows: [f("DimDate.WeekNumberOfYear")], values: [m("Revenue")] }), fiscal);
    expect(kinds(s)).not.toContain("add-coarser-time");
  });
});

describe("rule 6: a column filtered to one value and used as an axis", () => {
  it("asks to remove it from the axis", () => {
    const s = suggestNextEdits(
      facts({ rows: [f("Product.Category"), f("Customer.Segment")], values: [m("Revenue")], filters: [filter("Customer.Segment")] }),
      model,
    );
    const axis = s.find((x) => x.kind === "remove-filtered-axis")!;
    expect(axis.text).toBe("Remove Customer.Segment from ROWS");
    expect(axis.reason).toContain("pins Customer.Segment to one value");
  });

  it("is silent for a multi-value or an excluding filter", () => {
    expect(kinds(suggestNextEdits(facts({ rows: [f("Customer.Segment")], values: [m("Revenue")], filters: [filter("Customer.Segment", 2)] }), model))).not.toContain("remove-filtered-axis");
    expect(kinds(suggestNextEdits(facts({ rows: [f("Customer.Segment")], values: [m("Revenue")], filters: [filter("Customer.Segment", 1, true)] }), model))).not.toContain("remove-filtered-axis");
  });
});

describe("rule 7: a key column as an axis", () => {
  it("offers the table's label column instead", () => {
    const s = suggestNextEdits(facts({ rows: [f("Customer.CustomerKey")], values: [m("Revenue")] }), model);
    const key = s.find((x) => x.kind === "key-to-label")!;
    expect(key.text).toBe("Replace Customer.CustomerKey with Customer.Name");
    expect(key.op).toEqual({ op: "replace-field", clause: "ROWS", ref: "Customer.CustomerKey", text: "Customer.Name" });
    expect(key.reason).toContain("recognised by Name");
  });

  it("is silent when the label column is already on an axis", () => {
    const s = suggestNextEdits(facts({ rows: [f("Customer.CustomerKey"), f("Customer.Name")], values: [m("Revenue")] }), model);
    expect(kinds(s)).not.toContain("key-to-label");
  });

  it("never proposes a label the never-slice-by rule would then demand you remove", () => {
    // The fixture's own positive control: Product is labelled by Name, and
    // Revenue may never be sliced by Product[Name]. Offering it produced two
    // confident chips undoing each other, one click apart.
    const withRevenue = suggestNextEdits(facts({ rows: [f("Product.ProductKey")], values: [m("Revenue")] }), model);
    expect(kinds(withRevenue)).not.toContain("key-to-label");
    // ...and it is still offered for a measure that permits the column.
    const withCost = suggestNextEdits(facts({ rows: [f("Product.ProductKey")], values: [m("Cost")] }), model);
    expect(withCost.find((x) => x.kind === "key-to-label")?.text).toBe("Replace Product.ProductKey with Product.Name");
  });

  it("finds the label column when the query spells the table in another case", () => {
    // Every other strategy lookup here is case-insensitive and the compiler
    // resolves table names case-insensitively; an exact-case index made this
    // rule die on a spelling everything else accepts.
    const s = suggestNextEdits(facts({ rows: [f("customer.CustomerKey")], values: [m("Revenue")] }), model);
    expect(s.find((x) => x.kind === "key-to-label")?.text).toBe("Replace customer.CustomerKey with customer.Name");
  });
});

describe("the list as a whole", () => {
  it("is empty for a complete, well-formed query", () => {
    const s = suggestNextEdits(
      facts({ rows: [f("Product.Category")], columns: [f("Customer.Segment")], values: [m("Revenue")], filters: [filter("Geography.Region", 2)] }),
      model,
    );
    expect(kinds(s)).toEqual([]);
  });

  it("orders by priority and never repeats an edit", () => {
    const s = suggestNextEdits(facts({ rows: [f("Product.Name")], values: [m("Revenue"), m("Cost")] }), model);
    const priorities = s.map((x) => x.priority);
    expect([...priorities].sort((a, b) => b - a)).toEqual(priorities);
    expect(new Set(s.map((x) => x.id)).size).toBe(s.length);
  });

  it("shows ONE chip when two rules reach the same edit, and keeps the stronger reason", () => {
    // Product.Name is both never-slice-by for Revenue (priority 90) and pinned
    // to one value by FILTERS (priority 85). Both rules propose the identical
    // removal; the first version rendered it twice, spending two of the three
    // slots on one edit and leaving the second click a no-op.
    const s = suggestNextEdits(
      facts({ rows: [f("Product.Name")], values: [m("Revenue")], filters: [filter("Product.Name")] }),
      model,
    );
    const removals = s.filter((x) => x.text === "Remove Product.Name from ROWS");
    expect(removals).toHaveLength(1);
    expect(removals[0].kind, "the higher-priority rule's reason survives").toBe("remove-never-slice");
  });

  it("does not offer a breakdown by a column FILTERS already pins to one value", () => {
    // Otherwise: remove-filtered-axis says take it off ROWS, this rule says put
    // it back, and the person walks in a circle with a confident sentence each way.
    const s = suggestNextEdits(facts({ values: [m("Revenue")], filters: [filter("Product.Category")] }), model);
    expect(s.find((x) => x.kind === "add-rows")?.text).toBe("Add ROWS: Customer.Segment");
  });

  it("closes the circle end to end: removing a pinned axis does not immediately offer it back", () => {
    const start = facts({ rows: [f("Product.Category")], values: [m("Revenue")], filters: [filter("Product.Category")] });
    const first = suggestNextEdits(start, model);
    expect(first[0].kind).toBe("remove-filtered-axis");
    // The query the removal produces.
    const after = facts({ values: [m("Revenue")], filters: [filter("Product.Category")] });
    const second = suggestNextEdits(after, model);
    expect(second.map((x) => x.text)).not.toContain("Add ROWS: Product.Category");
  });

  it("works with no strategy at all, structurally", () => {
    const s = suggestNextEdits(facts({ rows: [f("Product.Category"), f("Customer.Segment")], filters: [filter("Customer.Segment")] }), { ...model, strategy: null });
    expect(kinds(s)).toEqual(["add-values", "remove-filtered-axis"]);
  });
});

describe("nextClauseSuggestion — a model's reply turned into a suggestion", () => {
  // Pure, and shared: the row calls it after a completion and the offline
  // runner calls it to score one, so a change here moves both. Its edge cases
  // are what a grammar-constrained 1.5B actually produces.
  it("reads the first line and names the clause", () => {
    const s = nextClauseSuggestion("TOP 3 BY [Revenue]", "qwen2.5-coder-1.5b");
    expect(s?.op).toEqual({ op: "add-clause", clause: "TOP", line: "TOP 3 BY [Revenue]" });
    expect(s?.source).toBe("model");
    expect(s?.priority, "a rule always outranks the model").toBe(MODEL_CLAUSE_PRIORITY);
    expect(s?.reason).toContain("qwen2.5-coder-1.5b");
  });

  it("treats an empty reply as an ANSWER, not a failure", () => {
    // The grammar's root is `nextclause?` precisely so the model can decline,
    // and the prompt ends by telling it to on a finished query. Null here is
    // how "nothing to add" reaches the row, which then shows no chip.
    expect(nextClauseSuggestion("", "m")).toBeNull();
    expect(nextClauseSuggestion("   \n  \n", "m"), "whitespace is nothing").toBeNull();
  });

  it("keeps only the first line, however much the model wrote", () => {
    const s = nextClauseSuggestion("FILTERS: Geography.Region = (\"Europe\")\nLAYOUT: tabular\n", "m");
    expect(s?.op).toEqual({
      op: "add-clause",
      clause: "FILTERS",
      line: 'FILTERS: Geography.Region = ("Europe")',
    });
  });

  it("refuses a reply that does not start with a clause word", () => {
    // Without a leading keyword there is nothing to tell `applyEditOp` where
    // the line belongs, and guessing would put a line in the wrong place.
    expect(nextClauseSuggestion("[Revenue]", "m")).toBeNull();
    expect(nextClauseSuggestion("  ,ROWS: X", "m")).toBeNull();
  });

  it("carries BOTTOM through as its own keyword", () => {
    // TOP and BOTTOM share one clause slot; `applyEditOp` resolves that, and it
    // can only do so if the keyword survives verbatim.
    expect(nextClauseSuggestion("BOTTOM 5 BY [Cost]", "m")?.op).toEqual({
      op: "add-clause",
      clause: "BOTTOM",
      line: "BOTTOM 5 BY [Cost]",
    });
  });

  it("gives two different clauses two different ids, so a dismissal is specific", () => {
    const a = nextClauseSuggestion("SORT: Product.Category ASC", "m")!;
    const b = nextClauseSuggestion("SORT: Product.Category DESC", "m")!;
    expect(a.id).not.toBe(b.id);
  });
});
