// FILENAME: app/extensions/ModelEditor/components/diagram/__tests__/layoutEngine.test.ts
// PURPOSE: Verify the relationship-diagram auto-layout. The highest-value check
//          is fact-centering: in this codebase `fromTable` is the MANY side, so
//          the fact table (which holds the foreign keys) is the many-side hub of
//          a manyToOne join — centering the ONE side instead would orbit the
//          fact around a dimension. These tests pin the correct behavior plus
//          determinism, grid snapping, and the messy-input edge cases.

import { describe, expect, it } from "vitest";
import type { ModelColumnInfo, ModelRelationshipInfo, ModelTableInfo } from "@api";
import { computeLayout, GRID } from "../layoutEngine";
import { getNodeHeight, getNodeWidth } from "../nodeGeometry";

function col(name: string): ModelColumnInfo {
  return {
    name,
    dataType: "string",
    displayName: null,
    description: null,
    isHidden: false,
    isCalculated: false,
    formula: null,
    lookupResolution: null,
    sortByColumn: null,
    formatString: null,
  };
}

function table(name: string, cols: string[] = ["id", "val"]): ModelTableInfo {
  return {
    name,
    displayName: null,
    description: null,
    isHidden: false,
    storageMode: "InMemory",
    bound: true,
    columns: cols.map(col),
    refreshStrategies: [],
    incrementalRefresh: null,
  };
}

function rel(
  name: string,
  from: string,
  to: string,
  cardinality = "manyToOne",
): ModelRelationshipInfo {
  return {
    name,
    fromTable: from,
    toTable: to,
    conditions: [{ fromColumn: "id", toColumn: "id" }],
    cardinality,
    active: true,
    filterPropagation: "auto",
  };
}

/** Center point of a laid-out node. */
function centerOf(t: ModelTableInfo, pos: Record<string, { x: number; y: number }>) {
  const p = pos[t.name];
  return { x: p.x + getNodeWidth(t) / 2, y: p.y + getNodeHeight(t) / 2 };
}

function allFinite(pos: Record<string, { x: number; y: number }>): boolean {
  return Object.values(pos).every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

function cols(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `c${i}`);
}

/** Returns the first overlapping table pair (as "A & B"), or null if none. */
function firstOverlap(
  tables: ModelTableInfo[],
  pos: Record<string, { x: number; y: number }>,
): string | null {
  for (let i = 0; i < tables.length; i++) {
    for (let j = i + 1; j < tables.length; j++) {
      const a = tables[i];
      const b = tables[j];
      const pa = pos[a.name];
      const pb = pos[b.name];
      const ax2 = pa.x + getNodeWidth(a);
      const ay2 = pa.y + getNodeHeight(a);
      const bx2 = pb.x + getNodeWidth(b);
      const by2 = pb.y + getNodeHeight(b);
      const separated = pa.x >= bx2 || pb.x >= ax2 || pa.y >= by2 || pb.y >= ay2;
      if (!separated) return `${a.name} & ${b.name}`;
    }
  }
  return null;
}

describe("computeLayout — fact centering (star schema)", () => {
  // Classic star: Sales (fact) holds FKs to 4 dimensions → 4 manyToOne joins
  // with Sales on the FROM/many side.
  const tables = [
    table("Sales"),
    table("Product"),
    table("Customer"),
    table("Date"),
    table("Store"),
  ];
  const rels = [
    rel("s_prod", "Sales", "Product"),
    rel("s_cust", "Sales", "Customer"),
    rel("s_date", "Sales", "Date"),
    rel("s_store", "Sales", "Store"),
  ];

  it("places the fact table at the geometric center of its dimensions", () => {
    const pos = computeLayout(tables, rels, "auto");
    const centers = tables.map((t) => ({ name: t.name, ...centerOf(t, pos) }));
    const meanX = centers.reduce((s, c) => s + c.x, 0) / centers.length;
    const meanY = centers.reduce((s, c) => s + c.y, 0) / centers.length;
    const dist = (c: { x: number; y: number }) => Math.hypot(c.x - meanX, c.y - meanY);
    const closest = centers.reduce((best, c) => (dist(c) < dist(best) ? c : best));
    // The fact — NOT a dimension — must be the most central node.
    expect(closest.name).toBe("Sales");
  });

  it("orbits every dimension at roughly the same radius from the fact", () => {
    const pos = computeLayout(tables, rels, "auto");
    const factC = centerOf(tables[0], pos);
    const radii = tables
      .slice(1)
      .map((t) => Math.hypot(centerOf(t, pos).x - factC.x, centerOf(t, pos).y - factC.y));
    const min = Math.min(...radii);
    const max = Math.max(...radii);
    // All dims on one ring: radii differ only by node-size, not by ring.
    expect(max - min).toBeLessThan(getNodeWidth(tables[1]));
    expect(min).toBeGreaterThan(0);
  });
});

describe("computeLayout — snowflake depth", () => {
  it("pushes dims-of-dims onto an outer ring", () => {
    const tables = [table("Sales"), table("Product"), table("Category"), table("Customer")];
    const rels = [
      rel("s_prod", "Sales", "Product"),
      rel("s_cust", "Sales", "Customer"),
      rel("p_cat", "Product", "Category"), // Category is a dim of a dim
    ];
    const pos = computeLayout(tables, rels, "auto");
    const factC = centerOf(tables[0], pos);
    const rad = (name: string, t: ModelTableInfo) =>
      Math.hypot(centerOf(t, pos).x - factC.x, centerOf(t, pos).y - factC.y);
    const productR = rad("Product", tables[1]);
    const categoryR = rad("Category", tables[2]);
    expect(categoryR).toBeGreaterThan(productR);
  });
});

describe("computeLayout — layered fallback (multi-fact, conformed dimension)", () => {
  // Two facts share one dimension → no single many-side hub → layered.
  const tables = [table("Sales"), table("Inventory"), table("Date")];
  const rels = [rel("s_date", "Sales", "Date"), rel("i_date", "Inventory", "Date")];

  it("places the shared (one-side) dimension downstream of both facts", () => {
    const pos = computeLayout(tables, rels, "auto");
    expect(allFinite(pos)).toBe(true);
    // Facts share a layer (same column); the conformed dim is one layer right.
    expect(pos["Sales"].x).toBe(pos["Inventory"].x);
    expect(pos["Date"].x).toBeGreaterThan(pos["Sales"].x);
  });

  it("respects an explicit layered mode without error", () => {
    const pos = computeLayout(tables, rels, "layered");
    expect(allFinite(pos)).toBe(true);
    expect(Object.keys(pos)).toHaveLength(3);
  });
});

describe("computeLayout — messy inputs", () => {
  it("handles disconnected components + isolated tables without overlap or NaN", () => {
    const tables = [
      table("Sales"),
      table("Product"),
      table("HR"),
      table("Employee"),
      table("Orphan"), // no relationships at all
    ];
    const rels = [rel("s_prod", "Sales", "Product"), rel("hr_emp", "HR", "Employee")];
    const pos = computeLayout(tables, rels, "auto");
    expect(allFinite(pos)).toBe(true);
    expect(Object.keys(pos).sort()).toEqual([
      "Employee",
      "HR",
      "Orphan",
      "Product",
      "Sales",
    ]);
  });

  it("does not crash on a self-relationship (parent/child on one table)", () => {
    const tables = [table("Employee", ["id", "managerId"])];
    const rels = [rel("mgr", "Employee", "Employee")];
    const pos = computeLayout(tables, rels, "auto");
    expect(allFinite(pos)).toBe(true);
    expect(pos["Employee"]).toBeDefined();
  });

  it("handles all-manyToMany (no orientable hub) via the layered fallback", () => {
    const tables = [table("A"), table("B"), table("C")];
    const rels = [rel("ab", "A", "B", "manyToMany"), rel("bc", "B", "C", "manyToMany")];
    const pos = computeLayout(tables, rels, "auto");
    expect(allFinite(pos)).toBe(true);
    expect(Object.keys(pos)).toHaveLength(3);
  });

  it("returns an empty map for an empty model", () => {
    expect(computeLayout([], [], "auto")).toEqual({});
  });
});

describe("computeLayout — no node overlaps", () => {
  it("keeps a tall fact clear of its ring (the reported fact_sales bug)", () => {
    // fact_sales has 8 columns → ~196px tall; the innermost ring must clear it.
    const tables = [
      table("fact_sales", cols(8)),
      table("dim_product", cols(6)),
      table("dim_customer", cols(9)),
      table("dim_date", cols(4)),
      table("dim_store", cols(5)),
    ];
    const rels = [
      rel("f_prod", "fact_sales", "dim_product"),
      rel("f_cust", "fact_sales", "dim_customer"),
      rel("f_date", "fact_sales", "dim_date"),
      rel("f_store", "fact_sales", "dim_store"),
    ];
    const pos = computeLayout(tables, rels, "radial");
    expect(firstOverlap(tables, pos)).toBeNull();
  });

  it("keeps a dense star (12 dimensions) overlap-free via arc spacing", () => {
    const dims = Array.from({ length: 12 }, (_, i) => table(`dim_${i}`, cols(5)));
    const tables = [table("fact", cols(6)), ...dims];
    const rels = dims.map((d, i) => rel(`f_${i}`, "fact", d.name));
    const pos = computeLayout(tables, rels, "radial");
    expect(firstOverlap(tables, pos)).toBeNull();
  });

  it("keeps a snowflake (multi-depth) overlap-free", () => {
    const tables = [
      table("fact", cols(7)),
      table("dim_product", cols(6)),
      table("dim_category", cols(4)),
      table("dim_subcategory", cols(3)),
      table("dim_customer", cols(8)),
      table("dim_geography", cols(5)),
    ];
    const rels = [
      rel("f_prod", "fact", "dim_product"),
      rel("f_cust", "fact", "dim_customer"),
      rel("p_cat", "dim_product", "dim_category"),
      rel("cat_sub", "dim_category", "dim_subcategory"),
      rel("c_geo", "dim_customer", "dim_geography"),
    ];
    const pos = computeLayout(tables, rels, "auto");
    expect(firstOverlap(tables, pos)).toBeNull();
  });

  it("keeps a layered multi-fact schema overlap-free", () => {
    const tables = [
      table("fact_sales", cols(6)),
      table("fact_inventory", cols(5)),
      table("dim_date", cols(4)),
      table("dim_product", cols(7)),
    ];
    const rels = [
      rel("s_date", "fact_sales", "dim_date"),
      rel("s_prod", "fact_sales", "dim_product"),
      rel("i_date", "fact_inventory", "dim_date"),
      rel("i_prod", "fact_inventory", "dim_product"),
    ];
    const pos = computeLayout(tables, rels, "auto");
    expect(firstOverlap(tables, pos)).toBeNull();
  });
});

describe("computeLayout — invariants", () => {
  const tables = [table("Sales"), table("Product"), table("Customer"), table("Date")];
  const rels = [
    rel("s_prod", "Sales", "Product"),
    rel("s_cust", "Sales", "Customer"),
    rel("s_date", "Sales", "Date"),
  ];

  it("is deterministic (same input → identical output)", () => {
    const a = computeLayout(tables, rels, "auto");
    const b = computeLayout(tables, rels, "auto");
    expect(a).toEqual(b);
  });

  it("snaps every position to the grid", () => {
    const pos = computeLayout(tables, rels, "auto");
    for (const p of Object.values(pos)) {
      expect(p.x % GRID).toBe(0);
      expect(p.y % GRID).toBe(0);
    }
  });

  it("assigns a position to every table in all three modes", () => {
    for (const mode of ["auto", "radial", "layered"] as const) {
      const pos = computeLayout(tables, rels, mode);
      expect(Object.keys(pos).sort()).toEqual(["Customer", "Date", "Product", "Sales"]);
    }
  });
});
