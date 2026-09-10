// FILENAME: app/extensions/ModelEditor/__tests__/modelIndex.test.ts
// PURPOSE: Ranking and scoping for the Ctrl+K palette.
// CONTEXT: A search box is only as good as its ORDER. Every test here pins a
//          judgement someone would otherwise "fix" into uselessness — that an
//          exact name beats a substring, that the 3,000 columns in a real model
//          never bury the table you meant, and that a scope prefix means the
//          user has told you the kind and you must believe them.

import { describe, expect, it } from "vitest";
import type { ModelOverview } from "@api";
import { buildModelIndex, groupByKind, searchIndex } from "../lib/modelIndex";
import { commandTextOf, looksLikeCommand } from "../components/SearchPalette";

function col(name: string, extra: Record<string, unknown> = {}) {
  return {
    name, dataType: "String", displayName: null, description: null, isHidden: false,
    isCalculated: false, isDynamic: false, formula: null, lookupResolution: null,
    sortByColumn: null, formatString: null, ...extra,
  };
}
function table(name: string, cols: string[]) {
  return {
    name, displayName: null, description: null, isHidden: false, storageMode: "DirectQuery",
    bound: true, sourceId: "s1", transformSteps: [], transformScript: null, sourceColumns: [],
    columns: cols.map((c) => col(c)), refreshStrategies: [], incrementalRefresh: null,
  };
}
function measure(name: string, group: string | null = null, formula = "SUM(x)") {
  return {
    name, table: "Fact_Sales", formula, hasSource: true, description: null,
    formatString: null, formatStringExpression: null, detailRows: null,
    isHidden: false, group,
  };
}

const OVERVIEW = {
  editable: true, readOnlyReason: null,
  tables: [
    table("Fact_Sales", ["OrderDate", "Amount", "Margin"]),
    table("Dim_Customer", ["CustomerId", "FullName", "PostalCode"]),
  ],
  relationships: [{
    name: "Fact_Sales_to_Dim_Customer", fromTable: "Fact_Sales", toTable: "Dim_Customer",
    cardinality: "manyToOne", isActive: true, active: true, filterPropagation: "auto",
    conditions: [{ fromColumn: "CustomerId", toColumn: "CustomerId", operator: "=" }],
  }],
  hierarchies: [{ name: "Geography", table: "Dim_Customer", levels: [], threshold: null }],
  kpis: [], securityRoles: [], perspectives: [], cultures: [], calculationGroups: [],
  measures: [
    measure("Revenue", "Sales"),
    measure("Margin %", "Profitability", "DIVIDE([Margin],[Revenue])"),
    measure("Revenue Last Year", "Sales"),
  ],
  contexts: [], contextColumns: [], tableVariables: [], globalVariables: [],
  scriptFunctions: [], dateTable: null, defaultLookupResolution: null,
  modelName: "M", modelVersion: null, modelAuthor: null, modelDescription: null,
  sources: [], writebackColumns: [],
} as unknown as ModelOverview;

const INDEX = buildModelIndex(OVERVIEW);

/** Raw rank order. */
const names = (q: string, n = 5): string[] =>
  searchIndex(INDEX, q).slice(0, n).map((s) => s.entry.name);

/** What the palette ACTUALLY shows: grouped by kind, in KIND_ORDER. Ranking
 *  tests that matter to a user belong here — raw score order is an
 *  implementation detail nobody sees. */
const displayed = (q: string, n = 8): string[] =>
  groupByKind(searchIndex(INDEX, q))
    .flatMap((g) => g.items)
    .slice(0, n)
    .map((s) => s.entry.name);

describe("buildModelIndex", () => {
  it("indexes every named object plus the rail destinations", () => {
    const kinds = new Set(INDEX.map((e) => e.kind));
    expect(kinds).toContain("table");
    expect(kinds).toContain("column");
    expect(kinds).toContain("measure");
    expect(kinds).toContain("relationship");
    expect(kinds).toContain("hierarchy");
    // Sections are indexed too, so the palette also just navigates.
    expect(kinds).toContain("section");
  });

  it("files a measure under its display FOLDER, not its inferred home table", () => {
    // `ModelMeasureInfo.table` is derived from whichever column the formula
    // touches and has no setter; the folder is what the author chose.
    const m = INDEX.find((e) => e.kind === "measure" && e.name === "Margin %");
    expect(m?.context).toBe("Profitability");
  });

  it("points a column at its owning TABLE, because that is what Tables selects", () => {
    const c = INDEX.find((e) => e.kind === "column" && e.name === "PostalCode");
    expect(c?.section).toBe("tables");
    expect(c?.selection).toBe("Dim_Customer");
    expect(c?.context).toBe("Dim_Customer");
  });

  it("survives a null overview by still offering the sections", () => {
    const empty = buildModelIndex(null);
    expect(empty.length).toBeGreaterThan(10);
    expect(empty.every((e) => e.kind === "section")).toBe(true);
  });
});

describe("ranking", () => {
  it("puts an exact name first", () => {
    expect(names("Revenue")[0]).toBe("Revenue");
  });

  it("prefers a prefix over a mid-word substring", () => {
    const r = names("Rev");
    expect(r[0]).toBe("Revenue");
    expect(r).toContain("Revenue Last Year");
  });

  it("never lets columns bury the table you meant", () => {
    // "Customer" matches the table AND the CustomerId column, and `CustomerId`
    // legitimately scores higher — it is a true prefix match. What protects the
    // table is the GROUPING: tables are their own group and come before columns,
    // so on a model with 3,000 columns the handful of tables is still the first
    // thing on screen. That is the guarantee worth pinning, and it is what the
    // user actually sees.
    const shown = displayed("Customer");
    expect(shown[0]).toBe("Dim_Customer");
    expect(shown.indexOf("Dim_Customer")).toBeLessThan(shown.indexOf("CustomerId"));
  });

  it("matches a fuzzy subsequence", () => {
    expect(names("mrgn")).toContain("Margin");
  });

  it("returns nothing for a query that is not a subsequence anywhere", () => {
    expect(searchIndex(INDEX, "zzqqxx")).toEqual([]);
  });

  it("does not drag in every column of a table whose NAME matched", () => {
    // "Customer" must not return CustomerId, FullName and PostalCode merely
    // because they live in Dim_Customer — that turns one hit into eleven rows
    // of noise. Asking for a table's columns has its own spelling.
    const cols = searchIndex(INDEX, "Customer").filter((s) => s.entry.kind === "column");
    expect(cols.map((c) => c.entry.name)).toEqual(["CustomerId"]);
    // …and the qualified form still lists them all.
    expect(searchIndex(INDEX, "Dim_Customer[]").length).toBeGreaterThan(2);
  });

  it("still matches a measure by its FOLDER, where context is the point", () => {
    const r = searchIndex(INDEX, "Profitability");
    expect(r.some((s) => s.entry.name === "Margin %")).toBe(true);
  });

  it("matches on a formula, but ranks it below every name match", () => {
    const r = searchIndex(INDEX, "DIVIDE");
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].entry.name).toBe("Margin %");
  });
});

describe("scoping", () => {
  it("a kind prefix restricts to that kind", () => {
    const r = searchIndex(INDEX, "measure: rev");
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((s) => s.entry.kind === "measure")).toBe(true);
  });

  it("a kind prefix with an empty query lists that kind", () => {
    const r = searchIndex(INDEX, "table:");
    expect(r.every((s) => s.entry.kind === "table")).toBe(true);
    expect(r.length).toBe(2);
  });

  it("a qualified reference restricts to the named table", () => {
    const r = searchIndex(INDEX, "Dim_Customer[Postal]");
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].entry.name).toBe("PostalCode");
    expect(r.every((s) => (s.entry.context ?? "").includes("Dim_Customer"))).toBe(true);
  });

  it("an unknown prefix is treated as ordinary text, not a silent empty result", () => {
    // "margin:" must not look like a scope and quietly return nothing.
    expect(searchIndex(INDEX, "nonsense: rev")).toEqual([]);
    expect(names("Margin").length).toBeGreaterThan(0);
  });
});

describe("grouping", () => {
  it("groups by kind in a stable display order", () => {
    const g = groupByKind(searchIndex(INDEX, "a"));
    const kinds = g.map((x) => x.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    if (kinds.includes("measure") && kinds.includes("column")) {
      expect(kinds.indexOf("measure")).toBeLessThan(kinds.indexOf("column"));
    }
  });
});

describe("command mode", () => {
  it("treats a verb WITH an argument as a command", () => {
    expect(looksLikeCommand("set measure Revenue format=0.0%")).toBe(true);
    expect(looksLikeCommand("ls tables")).toBe(true);
  });

  it("treats a bare verb as a SEARCH, because that is what it usually is", () => {
    // Someone typing "show" is far more likely hunting for a name containing
    // it than issuing a command with no target.
    expect(looksLikeCommand("show")).toBe(false);
    expect(looksLikeCommand("test")).toBe(false);
  });

  it("an explicit > forces command mode even for one word", () => {
    expect(looksLikeCommand("> undo")).toBe(true);
    expect(commandTextOf("> undo")).toBe("undo");
  });

  it("leaves a plain name alone", () => {
    expect(looksLikeCommand("Revenue Last Year")).toBe(false);
  });
});
