//! FILENAME: app/src/api/__tests__/biModelFields.test.ts
// PURPOSE: The field-name index classifies a model's names the way the router
//          needs them, and the seam around it warms, refreshes and fails soft.
// CONTEXT: The router's `bi-query` rule is only as good as this index. Two
//          classifications carry the whole rule: a CALENDAR column must not
//          count as a business dimension (or "is this month better than last
//          month" becomes a report), and a camel-case name must be reachable by
//          its parts minus the generic ones (or "first and last name" names
//          `SubcategoryName`).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildModelFieldIndex,
  configureModelFields,
  warmModelFields,
  modelFieldIndex,
  resetModelFields,
  __setModelFieldsForTest,
  EMPTY_MODEL_FIELDS,
} from "../biModelFields";
import { emitAppEvent } from "../events";

/** A star shaped like the eval fixture, without reading it: the test states its own facts. */
const STAR = {
  tables: [
    { name: "Sales", columns: [{ name: "Date" }, { name: "ProductKey" }, { name: "Amount" }, { name: "Quantity" }] },
    { name: "Product", columns: [{ name: "ProductKey" }, { name: "Category" }, { name: "Name" }] },
    { name: "Subcategory", columns: [{ name: "SubcategoryKey" }, { name: "SubcategoryName" }] },
    { name: "Customer", columns: [{ name: "CustomerKey" }, { name: "Segment" }, { name: "Name" }] },
    { name: "Geography", columns: [{ name: "GeoKey" }, { name: "Region" }, { name: "Country" }] },
    { name: "Date", columns: [{ name: "Date" }, { name: "Year" }, { name: "Month" }, { name: "MonthName" }, { name: "MonthNumber" }] },
  ],
  measures: [{ name: "Revenue" }, { name: "MarginPct" }, { name: "Customers" }],
};

describe("buildModelFieldIndex", () => {
  const idx = buildModelFieldIndex([STAR]);

  it("indexes measures lower-cased, and by their non-generic parts", () => {
    expect(idx.measures.has("revenue")).toBe(true);
    expect(idx.measures.has("marginpct")).toBe(true);
    // "MarginPct" is asked for as "margin".
    expect(idx.measures.has("margin")).toBe(true);
    expect(idx.measures.has("pct")).toBe(true);
  });

  it("treats a table name as a dimension people ask by — 'customers', 'products'", () => {
    expect(idx.dimensions.has("customer")).toBe(true);
    expect(idx.dimensions.has("product")).toBe(true);
    expect(idx.tables.has("geography")).toBe(true);
  });

  it("splits a camel-case column into parts and DROPS the generic ones", () => {
    // `SubcategoryName` -> "subcategoryname" and "subcategory", never "name".
    expect(idx.dimensions.has("subcategoryname")).toBe(true);
    expect(idx.dimensions.has("subcategory")).toBe(true);
    expect(idx.dimensions.has("name")).toBe(false);
    expect(idx.measures.has("name")).toBe(false);
  });

  it("skips key columns entirely — nobody asks for a ProductKey", () => {
    expect(idx.dimensions.has("productkey")).toBe(false);
    expect(idx.dimensions.has("geokey")).toBe(false);
    // ...and their entity still reaches the index through the TABLE name.
    expect(idx.dimensions.has("product")).toBe(true);
  });

  it("puts calendar columns in the calendar set, never among the dimensions", () => {
    for (const w of ["year", "month", "monthname", "monthnumber", "date"]) {
      expect(idx.calendar.has(w), w).toBe(true);
      expect(idx.dimensions.has(w), w).toBe(false);
    }
    // The Date TABLE is calendar too, so it must not become a business dimension.
    expect(idx.dimensions.has("date")).toBe(false);
  });

  it("keeps a business column of the fact table a dimension of the fact, not calendar", () => {
    expect(idx.dimensions.has("amount")).toBe(true);
    expect(idx.dimensions.has("quantity")).toBe(true);
  });

  it("counts connections, so an empty index is distinguishable from a model with no fields", () => {
    expect(buildModelFieldIndex([]).connections).toBe(0);
    expect(idx.connections).toBe(1);
    expect(buildModelFieldIndex([STAR, STAR]).connections).toBe(2);
  });
});

describe("the seam", () => {
  beforeEach(() => resetModelFields());
  afterEach(() => resetModelFields());

  it("is empty until configured and warmed", () => {
    expect(modelFieldIndex()).toBe(EMPTY_MODEL_FIELDS);
  });

  it("warms through the injected invoker and reads back synchronously", async () => {
    const calls: string[] = [];
    const off = configureModelFields({
      invoke: async <T,>(cmd: string, args?: Record<string, unknown>) => {
        calls.push(`${cmd}:${String(args?.connectionId)}`);
        return STAR as unknown as T;
      },
    });
    await warmModelFields(["c1"]);
    expect(calls).toEqual(["get_connection_bi_model:c1"]);
    expect(modelFieldIndex().measures.has("revenue")).toBe(true);
    expect(modelFieldIndex().connections).toBe(1);
    off();
  });

  it("fails SOFT per connection: a connection that cannot be described contributes nothing", async () => {
    const off = configureModelFields({
      invoke: async <T,>(_cmd: string, args?: Record<string, unknown>) => {
        if (args?.connectionId === "bad") throw new Error("no such connection");
        return STAR as unknown as T;
      },
    });
    await warmModelFields(["good", "bad"]);
    expect(modelFieldIndex().connections).toBe(1);
    expect(modelFieldIndex().measures.has("revenue")).toBe(true);
    off();
  });

  it("re-warms the changed connection on bi:model-changed", async () => {
    let served = STAR;
    const off = configureModelFields({ invoke: async <T,>() => served as unknown as T });
    await warmModelFields(["c1"]);
    expect(modelFieldIndex().measures.has("revenue")).toBe(true);

    // The Model Editor renames the measure; the event arrives; the cache follows.
    served = { ...STAR, measures: [{ name: "Turnover" }] };
    emitAppEvent("bi:model-changed", { connectionId: "c1" });
    // The handler warms asynchronously; yield once.
    await new Promise((r) => setTimeout(r, 0));
    expect(modelFieldIndex().measures.has("turnover")).toBe(true);
    expect(modelFieldIndex().measures.has("revenue")).toBe(false);
    off();
  });

  it("stops refreshing once unsubscribed", async () => {
    let served = STAR;
    const off = configureModelFields({ invoke: async <T,>() => served as unknown as T });
    await warmModelFields(["c1"]);
    off();
    served = { ...STAR, measures: [{ name: "Turnover" }] };
    emitAppEvent("bi:model-changed", { connectionId: "c1" });
    await new Promise((r) => setTimeout(r, 0));
    expect(modelFieldIndex().measures.has("revenue")).toBe(true);
  });

  it("lets a test pin an index without any backend, and restores on null", () => {
    __setModelFieldsForTest(buildModelFieldIndex([STAR]));
    expect(modelFieldIndex().measures.has("revenue")).toBe(true);
    __setModelFieldsForTest(null);
    expect(modelFieldIndex()).toBe(EMPTY_MODEL_FIELDS);
  });
});
