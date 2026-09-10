//! FILENAME: app/extensions/_shared/dsl/pivotLayout/canonical.test.ts
// PURPOSE: The canonical form says two queries are the same exactly when the
//          pivot would draw the same table from them.
// CONTEXT: The grading rule for the design-query eval. Measured 2026-09-10:
//          several of a 3B model's "wrong" answers differed from the
//          reference only by an explicit `LAYOUT: compact`, which is the
//          default spelled out. So layout is compared as compiled, defaults
//          dropped; names case-insensitively; and SORT and TOP N — which the
//          compiled request does not carry — from the parsed form.

import { describe, it, expect } from "vitest";
import { canonicalDesignQuery, sameDesignQuery } from "./canonical";

const base = "ROWS: Product.Category\nVALUES: [Revenue]";

describe("canonicalDesignQuery", () => {
  it("is null for text that does not parse, and never equal to anything", () => {
    expect(canonicalDesignQuery("ROWS: \nVALUES: [")).toBeNull();
    expect(sameDesignQuery("ROWS: \nVALUES: [", "ROWS: \nVALUES: [")).toBe(false);
  });

  it("ignores case in names", () => {
    expect(sameDesignQuery(base, "ROWS: product.category\nVALUES: [revenue]")).toBe(true);
  });

  it("treats an explicit default layout as no layout", () => {
    expect(sameDesignQuery(base, `${base}\nLAYOUT: compact`)).toBe(true);
    expect(sameDesignQuery(base, `${base}\nLAYOUT: grand-totals`)).toBe(true);
  });

  it("treats the serializer's two spellings of no-grand-totals as one", () => {
    expect(sameDesignQuery(`${base}\nLAYOUT: no-grand-totals`, `${base}\nLAYOUT: no-row-totals, no-column-totals`)).toBe(true);
  });

  it("keeps a non-default layout as a difference", () => {
    expect(sameDesignQuery(base, `${base}\nLAYOUT: tabular`)).toBe(false);
    expect(sameDesignQuery(base, `${base}\nLAYOUT: no-grand-totals`)).toBe(false);
    expect(sameDesignQuery(base, `${base}\nLAYOUT: subtotals-off`)).toBe(false);
  });

  it("keeps SORT and TOP N, which the compiled request would lose", () => {
    expect(sameDesignQuery(base, `${base}\nSORT: Product.Category DESC`)).toBe(false);
    expect(sameDesignQuery(base, `${base}\nTOP 5 BY [Revenue]`)).toBe(false);
    expect(sameDesignQuery(`${base}\nTOP 5 BY [Revenue]`, `${base}\nBOTTOM 5 BY [Revenue]`)).toBe(false);
  });

  it("keeps an inclusion filter, which the compiler drops without a member list", () => {
    expect(sameDesignQuery(base, `${base}\nFILTERS: Customer.Segment = ("Consumer")`)).toBe(false);
    expect(sameDesignQuery(
      `${base}\nFILTERS: Customer.Segment = ("A", "B")`,
      `${base}\nFILTERS: Customer.Segment = ("B", "A")`,
    )).toBe(true);
  });

  it("keeps an alias and a show-values-as label", () => {
    expect(sameDesignQuery(base, 'ROWS: Product.Category\nVALUES: [Revenue] AS "Sales"')).toBe(false);
    expect(sameDesignQuery(base, "ROWS: Product.Category\nVALUES: [Revenue] [% of grand total]")).toBe(false);
  });
});
