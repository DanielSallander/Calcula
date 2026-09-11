//! FILENAME: app/extensions/_shared/dsl/pivotLayout/nextEditFacts.test.ts
// PURPOSE: The query's facts are what the parser saw, and an accepted edit
//          changes exactly the text it names — in the person's own style.
// CONTEXT: The rules are proved in `@api`; this file proves the two halves
//          that touch real text: the reduction to facts, and the textual
//          application of an edit, including the serializer's padded,
//          one-field-per-line style the pivot Design view writes.

import { describe, it, expect } from "vitest";
import { applyEditOp, clauseBlocks, factsFromDsl, leadingRef, splitFieldList, trailingCommentAt } from "./nextEditFacts";

describe("factsFromDsl", () => {
  it("reduces a query to names the rules read", () => {
    const facts = factsFromDsl([
      "ROWS: Product.Category, [Sales.Order Date]",
      "COLUMNS: Customer.Segment",
      'VALUES: [Revenue], sum(Sales.Amount) AS "Amount", [Cost] [% of grand total]',
      'FILTERS: Customer.Segment = ("Consumer"), Geography.Region NOT IN ("Europe", "Asia")',
      "SORT: Product.Category DESC",
      "TOP 3 BY [Revenue]",
      "LAYOUT: tabular, no-grand-totals",
    ].join("\n"));
    expect(facts.rows).toEqual([
      { ref: "Product.Category", qualified: "Product[Category]" },
      { ref: "[Sales.Order Date]", qualified: "Sales[Order Date]" },
    ]);
    expect(facts.columns).toEqual([{ ref: "Customer.Segment", qualified: "Customer[Segment]" }]);
    expect(facts.values[0]).toEqual({ ref: "Revenue", qualified: null, isMeasure: true, aggregation: undefined, showAs: undefined });
    expect(facts.values[1]).toMatchObject({ ref: "Sales.Amount", qualified: "Sales[Amount]", isMeasure: false, aggregation: "sum" });
    // The parser's own code for the label, not the label: the rules compare codes.
    expect(facts.values[2]).toMatchObject({ ref: "Cost", isMeasure: true, showAs: "percent_of_total" });
    expect(facts.filters).toEqual([
      { ref: "Customer.Segment", qualified: "Customer[Segment]", exclude: false, valueCount: 1 },
      { ref: "Geography.Region", qualified: "Geography[Region]", exclude: true, valueCount: 2 },
    ]);
    expect(facts.sort).toEqual([{ ref: "Product.Category", direction: "desc" }]);
    expect(facts.topN).toEqual({ top: true, count: 3, by: "Revenue" });
    expect(facts.layout).toEqual(["tabular", "no-grand-totals"]);
    expect(facts.hasParseErrors).toBe(false);
  });

  it("reports parse errors and keeps what parsed", () => {
    const facts = factsFromDsl("ROWS: Product.Category\nVALUES: [Revenue\nFILTERS:");
    expect(facts.hasParseErrors).toBe(true);
    expect(facts.rows).toHaveLength(1);
  });

  it("is empty for empty text", () => {
    const facts = factsFromDsl("");
    expect(facts.rows).toEqual([]);
    expect(facts.values).toEqual([]);
  });

  it("resolves the qualified key against the MODEL's table names, not the first dot", () => {
    // A schema-qualified table ("BI.dim_product") is the documented reason
    // `splitBiFieldKey` exists. The parser's own table/column split is a
    // first-dot split it documents as non-semantic; using it keyed the column
    // as `BI[dim_product.Name]`, which matches nothing in a strategy keyed
    // `BI.dim_product[Name]` — so every strategy rule went silently dead on
    // such a model.
    const dotted = factsFromDsl("ROWS: BI.dim_product.Name\nVALUES: [Revenue]", ["BI.dim_product"]);
    expect(dotted.rows[0].qualified).toBe("BI.dim_product[Name]");
    expect(dotted.rows[0].ref).toBe("BI.dim_product.Name");
    // Without the table names it falls back to the first-dot split, which is
    // right for every model whose table names contain no dots.
    expect(factsFromDsl("ROWS: Product.Category\nVALUES: [Revenue]").rows[0].qualified).toBe("Product[Category]");
    expect(factsFromDsl("ROWS: BI.dim_product.Name\nVALUES: [Revenue]").rows[0].qualified).toBe("BI[dim_product.Name]");
  });
});

describe("the text helpers", () => {
  it("splits a field list on the commas outside brackets, parentheses and quotes", () => {
    expect(splitFieldList('[Revenue], sum(Sales.Amount) AS "a, b", [Sales.Order, Date], Product.Category (no-subtotals)')).toEqual([
      "[Revenue]",
      'sum(Sales.Amount) AS "a, b"',
      "[Sales.Order, Date]",
      "Product.Category (no-subtotals)",
    ]);
  });

  it("an apostrophe inside a bracketed name is content, not a quote", () => {
    // The lexer treats `'` inside `[...]` as ordinary content. Treating it as a
    // quote opener left the splitter in a state the closing `]` never ended, so
    // every later field was swallowed into one entry — and an edit then rewrote
    // the whole remainder of the clause.
    expect(splitFieldList("[Customer.Owner's Key], Product.Category, [Revenue]")).toEqual([
      "[Customer.Owner's Key]",
      "Product.Category",
      "[Revenue]",
    ]);
    expect(
      applyEditOp("ROWS: [Customer.Owner's Key], Product.Category\nVALUES: [Revenue]", {
        op: "replace-field", clause: "ROWS", ref: "[Customer.Owner's Key]", text: "Customer.Name",
      }),
      "Product.Category must survive the edit",
    ).toBe("ROWS: Customer.Name, Product.Category\nVALUES: [Revenue]");
  });

  it("finds a trailing comment, and is not fooled by a # inside a value", () => {
    expect(trailingCommentAt("ROWS: Product.Category  # the board's list")).toBe(24);
    expect(trailingCommentAt('FILTERS: Tag = ("#1", "#2")')).toBe(-1);
    expect(trailingCommentAt("ROWS: Product.Category")).toBe(-1);
    // The same depth-zero quote rule as splitFieldList: an apostrophe inside
    // brackets is content. Without it this line reads as having NO comment, and
    // an edit then rewrites the line and takes the comment with it.
    expect(trailingCommentAt("ROWS: [Customer.Owner's Key]  # note")).toBe(30);
    expect(
      applyEditOp("ROWS: [Customer.Owner's Key], Product.Category  # note\nVALUES: [Revenue]", {
        op: "remove-field", clause: "ROWS", ref: "Product.Category",
      }),
      "a commented line is refused, not rewritten",
    ).toBe("ROWS: [Customer.Owner's Key], Product.Category  # note\nVALUES: [Revenue]");
  });

  it("finds the name an entry starts with, in every spelling the DSL and the serializer write", () => {
    expect(leadingRef("Product.Category (no-subtotals)")).toBe("Product.Category");
    expect(leadingRef("[Sales.Order Date] DESC")).toBe("[Sales.Order Date]");
    expect(leadingRef('[Revenue] AS "x"')).toBe("[Revenue]");
    // A grouping call is a suffix the parser stops before, so the name does too.
    expect(leadingRef("Date.Month.group(months)")).toBe("Date.Month");
    expect(leadingRef("Amount.bin(1000)")).toBe("Amount");
    // ...but a table or column actually CALLED "group" is still a name.
    expect(leadingRef("Sales.group")).toBe("Sales.group");
    // The two spellings the pivot's own serializer writes and the rules never see.
    expect(leadingRef("LOOKUP Customer.CustomerKey")).toBe("Customer.CustomerKey");
    expect(leadingRef('lookup  Customer.Name NOT IN ("x")')).toBe("Customer.Name");
    expect(leadingRef('"Order Date" DESC')).toBe('"Order Date"');
  });

  it("matches a field written LOOKUP or quoted against the bare name the AST reports", () => {
    // The serializer writes `LOOKUP ` for every BI lookup dimension and quotes
    // any name with a space; the parser keeps neither in the name. Before this
    // was handled, every edit against such a field silently did nothing.
    expect(applyEditOp('ROWS: LOOKUP Customer.CustomerKey, Product.Category\nVALUES: [Revenue]', { op: "replace-field", clause: "ROWS", ref: "Customer.CustomerKey", text: "Customer.Name" }))
      .toBe("ROWS: Customer.Name, Product.Category\nVALUES: [Revenue]");
    expect(applyEditOp('ROWS: "Order Date", Product.Category\nVALUES: [Revenue]', { op: "remove-field", clause: "ROWS", ref: "Order Date" }))
      .toBe("ROWS: Product.Category\nVALUES: [Revenue]");
  });

  it("blocks a text by clause, continuation lines included", () => {
    const blocks = clauseBlocks(["ROWS:    Product.Category", "VALUES:  [Revenue],", "         [Cost]", "", "TOP 3 BY [Revenue]"]);
    expect(blocks).toEqual([
      { clause: "ROWS", start: 0, end: 1 },
      { clause: "VALUES", start: 1, end: 3 },
      { clause: "TOP", start: 4, end: 5 },
    ]);
  });

  it("a comment line ends a block rather than continuing it", () => {
    const blocks = clauseBlocks(["ROWS: Product.Name", "# the names the board asked for", "VALUES: [Revenue]"]);
    expect(blocks).toEqual([
      { clause: "ROWS", start: 0, end: 1 },
      { clause: "VALUES", start: 2, end: 3 },
    ]);
  });
});

describe("comments survive every edit", () => {
  it("removing a clause's last field does not delete the comment beneath it", () => {
    const text = "ROWS: Product.Name\n# the names the board asked for\nVALUES: [Revenue]";
    expect(applyEditOp(text, { op: "remove-field", clause: "ROWS", ref: "Product.Name" }))
      .toBe("# the names the board asked for\nVALUES: [Revenue]");
  });

  it("replacing the ranking clause does not delete the comment beneath it", () => {
    const text = "ROWS: Product.Category\nVALUES: [Cost]\nTOP 3 BY [Cost]\n# only the three biggest\nLAYOUT: tabular";
    expect(applyEditOp(text, { op: "replace-clause", clause: "BOTTOM", line: "BOTTOM 3 BY [Cost]" }))
      .toBe("ROWS: Product.Category\nVALUES: [Cost]\nBOTTOM 3 BY [Cost]\n# only the three biggest\nLAYOUT: tabular");
  });

  it("refuses to edit a clause line that carries a trailing comment, rather than rewriting it away", () => {
    // A chip that quietly does not appear is a non-event; a deleted comment is
    // not. `applied === text` is how the row drops such a suggestion.
    const text = "ROWS: Product.Name, Product.Category  # board's list\nVALUES: [Revenue]";
    expect(applyEditOp(text, { op: "remove-field", clause: "ROWS", ref: "Product.Name" })).toBe(text);
    expect(applyEditOp(text, { op: "add-field", clause: "ROWS", text: "Customer.Segment" })).toBe(text);
    expect(applyEditOp(text, { op: "replace-field", clause: "ROWS", ref: "Product.Name", text: "X.Y" })).toBe(text);
    // A clause with no comment of its own is still editable beside one.
    expect(applyEditOp(text, { op: "add-field", clause: "VALUES", text: "[Cost]" }))
      .toBe("ROWS: Product.Name, Product.Category  # board's list\nVALUES: [Revenue], [Cost]");
  });
});

describe("applyEditOp", () => {
  it("adds a field to the end of its clause", () => {
    expect(applyEditOp("ROWS: Product.Category\nVALUES: [Revenue]", { op: "add-field", clause: "ROWS", text: "Customer.Segment" }))
      .toBe("ROWS: Product.Category, Customer.Segment\nVALUES: [Revenue]");
  });

  it("creates a missing clause in the canonical position", () => {
    expect(applyEditOp("ROWS: Product.Category\nFILTERS: Geography.Region = (\"Europe\")", { op: "add-field", clause: "VALUES", text: "[Revenue]" }))
      .toBe("ROWS: Product.Category\nVALUES: [Revenue]\nFILTERS: Geography.Region = (\"Europe\")");
    expect(applyEditOp("VALUES: [Revenue]", { op: "add-field", clause: "ROWS", text: "Product.Category" }))
      .toBe("ROWS: Product.Category\nVALUES: [Revenue]");
    expect(applyEditOp("ROWS: Product.Category\nVALUES: [Revenue]", { op: "add-field", clause: "COLUMNS", text: "Customer.Segment" }))
      .toBe("ROWS: Product.Category\nCOLUMNS: Customer.Segment\nVALUES: [Revenue]");
  });

  it("keeps the serializer's padded headers and one-field-per-line style", () => {
    const padded = "ROWS:    Product.Category\nVALUES:  [Revenue],\n         [Cost]";
    expect(applyEditOp(padded, { op: "add-field", clause: "VALUES", text: "[Margin]" }))
      .toBe("ROWS:    Product.Category\nVALUES:  [Revenue],\n         [Cost],\n         [Margin]");
    expect(applyEditOp(padded, { op: "add-field", clause: "COLUMNS", text: "Customer.Segment" }))
      .toBe("ROWS:    Product.Category\nCOLUMNS: Customer.Segment\nVALUES:  [Revenue],\n         [Cost]");
  });

  it("inserts before a named field", () => {
    expect(applyEditOp("ROWS: Product.Category, Date.MonthName\nVALUES: [Revenue]", { op: "add-field", clause: "ROWS", text: "Date.Year", before: "Date.MonthName" }))
      .toBe("ROWS: Product.Category, Date.Year, Date.MonthName\nVALUES: [Revenue]");
  });

  it("refuses a positional add whose anchor it cannot find, rather than appending", () => {
    // Appending is the OPPOSITE of what such a chip promises: the coarse grain
    // would end up INSIDE the fine one, which is the very defect the rule that
    // emits this op exists to prevent. Unchanged text drops the chip instead.
    const text = "ROWS: Product.Category\nVALUES: [Revenue]";
    expect(applyEditOp(text, { op: "add-field", clause: "ROWS", text: "Date.Year", before: "Date.MonthName" })).toBe(text);
    // ...including when the clause does not exist at all.
    expect(applyEditOp("VALUES: [Revenue]", { op: "add-field", clause: "ROWS", text: "Date.Year", before: "Date.MonthName" }))
      .toBe("VALUES: [Revenue]");
  });

  it("does not add a field that is already there", () => {
    const text = "ROWS: Product.Category\nVALUES: [Revenue]";
    expect(applyEditOp(text, { op: "add-field", clause: "ROWS", text: "product.category" })).toBe(text);
  });

  it("removes a field, and the clause with its last field", () => {
    expect(applyEditOp("ROWS: Product.Name, Product.Category\nVALUES: [Revenue]", { op: "remove-field", clause: "ROWS", ref: "Product.Name" }))
      .toBe("ROWS: Product.Category\nVALUES: [Revenue]");
    expect(applyEditOp("ROWS: Product.Name (no-subtotals)\nVALUES: [Revenue]", { op: "remove-field", clause: "ROWS", ref: "[Product.Name]" }))
      .toBe("VALUES: [Revenue]");
    const untouched = "ROWS: Product.Category\nVALUES: [Revenue]";
    expect(applyEditOp(untouched, { op: "remove-field", clause: "ROWS", ref: "Nope.Nothing" })).toBe(untouched);
    expect(applyEditOp(untouched, { op: "remove-field", clause: "COLUMNS", ref: "Product.Category" })).toBe(untouched);
  });

  it("replaces a field in place", () => {
    expect(applyEditOp("ROWS: Customer.CustomerKey, Product.Category\nVALUES: [Revenue]", { op: "replace-field", clause: "ROWS", ref: "Customer.CustomerKey", text: "Customer.Name" }))
      .toBe("ROWS: Customer.Name, Product.Category\nVALUES: [Revenue]");
  });

  it("replaces the ranking clause, or inserts it where it belongs", () => {
    expect(applyEditOp("ROWS: Product.Category\nVALUES: [Cost]\nTOP 3 BY [Cost]\nLAYOUT: tabular", { op: "replace-clause", clause: "BOTTOM", line: "BOTTOM 3 BY [Cost]" }))
      .toBe("ROWS: Product.Category\nVALUES: [Cost]\nBOTTOM 3 BY [Cost]\nLAYOUT: tabular");
    expect(applyEditOp("ROWS: Product.Category\nVALUES: [Cost]\nLAYOUT: tabular", { op: "replace-clause", clause: "BOTTOM", line: "BOTTOM 3 BY [Cost]" }))
      .toBe("ROWS: Product.Category\nVALUES: [Cost]\nBOTTOM 3 BY [Cost]\nLAYOUT: tabular");
  });

  it("normalises Windows line endings", () => {
    expect(applyEditOp("ROWS: Product.Category\r\nVALUES: [Revenue]", { op: "add-field", clause: "ROWS", text: "Customer.Segment" }))
      .toBe("ROWS: Product.Category, Customer.Segment\nVALUES: [Revenue]");
  });
});
