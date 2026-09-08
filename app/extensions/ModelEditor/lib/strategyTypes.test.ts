// FILENAME: app/extensions/ModelEditor/lib/strategyTypes.test.ts
// PURPOSE: The PURE half of the strategy layer — the badge ladder, the
//          aggregation helpers and the role ordering the Strategy tab renders
//          from. No backend, no React: these are the decisions, and they are
//          asserted where they are made rather than through a component.
// CONTEXT: Two of these suites exist because of a specific defect.
//
//          (1) `measureHasValues` ENUMERATES its fields, so a field added to
//          `MeasureStrategy` and forgotten there would make an entry that says
//          something report as empty. The field-coverage test closes that: the
//          sample is typed `Required<MeasureStrategy>`, so a new field is a
//          COMPILE error until it is added, then a test failure until it is
//          listed, then a test failure until the predicate considers it.
//
//          (2) `withAggregationDefault` exists because the editor used to
//          write `{ default: v }` over the whole spec, and `withMeasure`
//          merges shallowly — so choosing a default DELETED the per-dimension
//          exceptions, which the collapsed cell had never shown in the first
//          place. The Rust inferrer writes exactly that map for a semi-additive
//          balance, so this was reachable with real data.

import { describe, expect, it } from "vitest";
import type { ModelOverview, ModelRelationshipInfo, ModelTableInfo } from "@api";
import {
  MEASURE_VALUE_FIELDS,
  ROLE_DISPLAY_ORDER,
  TABLE_VALUE_FIELDS,
  aggregationDimensionOptions,
  compareColumnsByRole,
  compareRoles,
  entryState,
  formatAggregationSpec,
  measureEntry,
  measureHasValues,
  tableEntry,
  tableHasValues,
  withAggregationDefault,
  withAggregationException,
  withColumn,
  withMeasure,
  withTable,
} from "./strategyTypes";
import type {
  AggregationSpec,
  MeasureStrategy,
  Role,
  StrategyDoc,
  TableStrategy,
} from "./strategyTypes";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Every value field of a measure entry, populated.
 *
 * `Required<MeasureStrategy>` is the teeth: adding a field to the interface
 * stops this file compiling until the field is here, which is the moment to
 * decide whether it counts as a value.
 */
const FULL_MEASURE: Required<MeasureStrategy> = {
  direction: "higherIsBetter",
  aggregation: { default: "additive" },
  unit: "currency",
  target: { type: "literal", value: 100 },
  materiality: { type: "relative", value: 0.02 },
  cadence: "monthly",
  priority: 1,
  analysisDimensions: ["Dim[Dept]"],
  neverSliceBy: ["Sales[Id]"],
  context: "the board reads this one first",
  reviewed: false,
  source: "authored",
};

const FULL_TABLE: Required<TableStrategy> = {
  kind: "dimension",
  labelColumn: "Dept",
  columns: { Dept: { role: "analysis" } },
  hierarchies: [["Region", "Dept"]],
  reviewed: false,
  source: "authored",
};

function column(name: string, dataType = "Decimal(38, 10)"): ModelTableInfo["columns"][number] {
  return {
    name,
    dataType,
    displayName: null,
    description: null,
    isHidden: false,
    isCalculated: false,
    isDynamic: false,
    formula: null,
    lookupResolution: null,
    sortByColumn: null,
    formatString: null,
  };
}

function table(name: string, cols: string[]): ModelTableInfo {
  return {
    name,
    displayName: null,
    description: null,
    isHidden: false,
    storageMode: "InMemory",
    bound: false,
    sourceId: null,
    columns: cols.map((c) => column(c)),
    refreshStrategies: [],
    incrementalRefresh: null,
    transformSteps: [],
    transformScript: "",
    sourceColumns: [],
  };
}

function relationship(
  from: string,
  to: string,
  active = true,
  cardinality = "manyToOne",
): ModelRelationshipInfo {
  return {
    name: `${from}_${to}`,
    fromTable: from,
    toTable: to,
    conditions: [{ fromColumn: "Key", toColumn: "Key" }],
    cardinality,
    active,
    filterPropagation: "auto",
  } as ModelRelationshipInfo;
}

function overviewOf(
  tables: ModelTableInfo[],
  relationships: ModelRelationshipInfo[],
): ModelOverview {
  return {
    editable: true,
    readOnlyReason: null,
    tables,
    relationships,
    hierarchies: [],
    kpis: [],
    securityRoles: [],
    perspectives: [],
    cultures: [],
    calculationGroups: [],
    measures: [],
    contexts: [],
    contextColumns: [],
    tableVariables: [],
    globalVariables: [],
    scriptFunctions: [],
    dateTable: "Date",
    defaultLookupResolution: null,
    modelName: "Test model",
    modelVersion: null,
    modelAuthor: null,
    modelDescription: null,
    sources: [],
    writebackColumns: [],
  };
}

/** Sales is the fact; Date and Dim hang off it, Archive is unrelated. */
function starOverview(): ModelOverview {
  return overviewOf(
    [
      table("Sales", ["Key", "Amount"]),
      table("Date", ["Key", "Month"]),
      table("Dim", ["Key", "Dept"]),
      table("Archive", ["Key"]),
    ],
    [relationship("Sales", "Date"), relationship("Sales", "Dim")],
  );
}

// ---------------------------------------------------------------------------
// The value predicates
// ---------------------------------------------------------------------------

describe("measureHasValues", () => {
  it("lists every value field of the type, and nothing that is only metadata", () => {
    // Both directions. A field missing from the list is a field the predicate
    // will never see; a field listed that no longer exists is a stale name that
    // makes the per-field tests below silently pass on `undefined`.
    expect([...MEASURE_VALUE_FIELDS].sort()).toEqual(
      Object.keys(FULL_MEASURE)
        .filter((k) => k !== "reviewed" && k !== "source")
        .sort(),
    );
  });

  for (const field of MEASURE_VALUE_FIELDS) {
    it(`counts ${field} on its own as something the entry says`, () => {
      // Cast: a computed key of union type widens to an index signature, and
      // the point of the loop is that the KEY is the variable.
      const entry = { reviewed: false, [field]: FULL_MEASURE[field] } as MeasureStrategy;
      expect(measureHasValues(entry)).toBe(true);
    });
  }

  it("reads an entry that states nothing as empty, however it is spelled", () => {
    expect(measureHasValues({ reviewed: false })).toBe(false);
    // The shapes a cleared editor field actually leaves behind.
    expect(measureHasValues({ reviewed: true, analysisDimensions: [], neverSliceBy: [] })).toBe(
      false,
    );
    expect(measureHasValues({ reviewed: false, context: "   " })).toBe(false);
  });

  it("does not count reviewed or source as things the entry says", () => {
    expect(measureHasValues({ reviewed: true, source: "authored" })).toBe(false);
  });
});

describe("tableHasValues", () => {
  it("lists every value field of the type, and nothing that is only metadata", () => {
    expect([...TABLE_VALUE_FIELDS].sort()).toEqual(
      Object.keys(FULL_TABLE)
        .filter((k) => k !== "reviewed" && k !== "source")
        .sort(),
    );
  });

  for (const field of TABLE_VALUE_FIELDS) {
    it(`counts ${field} on its own as something the entry says`, () => {
      const entry = { reviewed: false, [field]: FULL_TABLE[field] } as TableStrategy;
      expect(tableHasValues(entry)).toBe(true);
    });
  }

  it("reads an entry that states nothing as empty, however it is spelled", () => {
    expect(tableHasValues({ reviewed: false })).toBe(false);
    expect(tableHasValues({ reviewed: true, columns: {}, hierarchies: [], labelColumn: "" })).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// The badge ladder
// ---------------------------------------------------------------------------

describe("entryState", () => {
  it("separates a measure the document never mentions from one a machine guessed at", () => {
    const doc: StrategyDoc = {
      version: 1,
      measures: { Guessed: { direction: "higherIsBetter", reviewed: false } },
    };
    const guessed = measureEntry(doc, "Guessed");
    const missing = measureEntry(doc, "NeverMentioned");
    // Both entries carry `reviewed: false` and are otherwise indistinguishable
    // by that flag alone — which is exactly why the badge needs a third state.
    expect(entryState(guessed, measureHasValues(guessed))).toBe("inferred");
    expect(entryState(missing, measureHasValues(missing))).toBe("empty");
  });

  it("reads an absent source as inferred, because that is the only way old values arrived", () => {
    expect(entryState({ reviewed: false }, true)).toBe("inferred");
    expect(entryState({ reviewed: false, source: "inferred" }, true)).toBe("inferred");
  });

  it("reads values a person typed as authored until they confirm them", () => {
    expect(entryState({ reviewed: false, source: "authored" }, true)).toBe("authored");
    expect(entryState({ reviewed: true, source: "authored" }, true)).toBe("confirmed");
  });

  it("keeps an empty row empty even after a bulk confirm has ticked it", () => {
    // `confirmAll` marks every measure NAME reviewed, including ones the
    // document gave no values to. If `reviewed` won here, a bulk confirm would
    // paint "confirmed" across rows that state nothing — a claim that someone
    // agreed to a strategy nobody wrote.
    expect(entryState({ reviewed: true }, false)).toBe("empty");
    expect(entryState({ reviewed: true, source: "authored" }, false)).toBe("empty");
  });
});

// ---------------------------------------------------------------------------
// Authoring re-stamps the source
// ---------------------------------------------------------------------------

describe("withMeasure / withTable / withColumn stamp who wrote the values", () => {
  const inferredDoc: StrategyDoc = {
    version: 1,
    measures: { Revenue: { direction: "higherIsBetter", reviewed: false, source: "inferred" } },
    tables: { Dim: { kind: "dimension", reviewed: false, source: "inferred" } },
  };

  it("marks a measure authored the moment a person changes one of its values", () => {
    const next = withMeasure(inferredDoc, "Revenue", { unit: "currency" });
    expect(next.measures?.Revenue?.source).toBe("authored");
  });

  it("marks a measure authored when a person CLEARS a guessed value", () => {
    // Deleting a machine's guess is a decision too. Leaving it `inferred`
    // would say a machine chose to say nothing here.
    const next = withMeasure(inferredDoc, "Revenue", { direction: undefined });
    expect(next.measures?.Revenue?.source).toBe("authored");
  });

  it("leaves the source alone when the only change is confirming the entry", () => {
    const next = withMeasure(inferredDoc, "Revenue", { reviewed: true });
    expect(next.measures?.Revenue?.source).toBe("inferred");
    expect(next.measures?.Revenue?.reviewed).toBe(true);
  });

  it("marks a table authored, and does so through a column edit too", () => {
    expect(withTable(inferredDoc, "Dim", { labelColumn: "Dept" }).tables?.Dim?.source).toBe(
      "authored",
    );
    expect(withTable(inferredDoc, "Dim", { reviewed: true }).tables?.Dim?.source).toBe("inferred");
    // The column map is part of what the table entry says.
    const edited = withColumn(inferredDoc, "Dim", "Dept", { role: "analysis" });
    expect(edited.tables?.Dim?.source).toBe("authored");
  });

  it("lets an explicit source in the patch win, so a restored draft stays a draft", () => {
    const next = withMeasure(inferredDoc, "Revenue", { unit: "count", source: "inferred" });
    expect(next.measures?.Revenue?.source).toBe("inferred");
  });
});

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

describe("withAggregationDefault", () => {
  const semiAdditive: AggregationSpec = {
    default: "additive",
    byDimension: { Date: "lastValue" },
  };

  it("keeps the per-dimension exceptions when the default changes", () => {
    // THE REGRESSION. The editor wrote `{ default: v }` over the whole spec and
    // `withMeasure` merges shallowly, so choosing a default silently destroyed
    // a semi-additive balance's last-value rule over the date table.
    const next = withAggregationDefault(semiAdditive, "average");
    expect(next).toEqual({ default: "average", byDimension: { Date: "lastValue" } });
  });

  it("survives the round trip through withMeasure, which is where the loss happened", () => {
    const doc: StrategyDoc = {
      version: 1,
      measures: { Balance: { aggregation: semiAdditive, reviewed: false } },
    };
    const current = measureEntry(doc, "Balance");
    const next = withMeasure(doc, "Balance", {
      aggregation: withAggregationDefault(current.aggregation, "nonAdditive"),
    });
    expect(next.measures?.Balance?.aggregation?.byDimension).toEqual({ Date: "lastValue" });
  });

  it("creates a spec when there was none", () => {
    expect(withAggregationDefault(undefined, "additive")).toEqual({ default: "additive" });
  });

  it("drops the whole spec when the default is cleared, because a default is required", () => {
    // Not an oversight: `AggregationSpec.default` is required on the Rust side,
    // so an exception list with nothing to be an exception TO cannot be stored.
    // The difference from the bug is that this erase is the user's own act.
    expect(withAggregationDefault(semiAdditive, undefined)).toBeUndefined();
  });
});

describe("withAggregationException", () => {
  const spec: AggregationSpec = { default: "additive", byDimension: { Date: "lastValue" } };

  it("adds an exception beside the existing ones", () => {
    expect(withAggregationException(spec, "Store", "average")).toEqual({
      default: "additive",
      byDimension: { Date: "lastValue", Store: "average" },
    });
  });

  it("replaces an exception on a dimension that already has one", () => {
    expect(withAggregationException(spec, "Date", "firstValue")?.byDimension).toEqual({
      Date: "firstValue",
    });
  });

  it("leaves byDimension ABSENT rather than empty when the last exception goes", () => {
    const next = withAggregationException(spec, "Date", undefined);
    expect(next).toEqual({ default: "additive" });
    // An empty map and a missing one read the same but diff differently, and a
    // document that grows `"byDimension": {}` on every visit is unreviewable.
    expect(next !== undefined && "byDimension" in next).toBe(false);
  });

  it("refuses to invent a default just to hang an exception on", () => {
    expect(withAggregationException(undefined, "Date", "lastValue")).toBeUndefined();
  });

  it("ignores a blank dimension rather than storing an exception nothing can match", () => {
    expect(withAggregationException(spec, "   ", "average")).toEqual(spec);
  });
});

describe("formatAggregationSpec", () => {
  it("says nothing when nothing is set", () => {
    expect(formatAggregationSpec(undefined)).toBe("");
  });

  it("shows the default alone when there are no exceptions", () => {
    expect(formatAggregationSpec({ default: "additive" })).toBe("additive");
  });

  it("shows the exception in the COLLAPSED cell, which is what hid the data loss", () => {
    expect(
      formatAggregationSpec({ default: "additive", byDimension: { Date: "lastValue" } }),
    ).toBe("additive (Date: last value)");
  });

  it("spells out two exceptions and counts the rest, in dimension order", () => {
    expect(
      formatAggregationSpec({
        default: "additive",
        byDimension: { Store: "average", Date: "lastValue", Product: "min" },
      }),
      // Sorted by dimension, never by insertion order: a cell whose text
      // depends on which key was typed first cannot be asserted on.
    ).toBe("additive (Date: last value, Product: min, +1 more)");
  });
});

describe("aggregationDimensionOptions", () => {
  it("offers the measure's own table first, then its related tables by name", () => {
    expect(aggregationDimensionOptions(starOverview(), "Sales")).toEqual(["Sales", "Date", "Dim"]);
  });

  it("reaches a relationship from either end, so a detail table can except over its header", () => {
    expect(aggregationDimensionOptions(starOverview(), "Date")).toEqual(["Date", "Sales"]);
  });

  it("leaves out a table nothing connects to the measure", () => {
    expect(aggregationDimensionOptions(starOverview(), "Sales")).not.toContain("Archive");
  });

  it("ignores an inactive relationship, which propagates no filter to except over", () => {
    const overview = overviewOf(
      [table("Sales", ["Key"]), table("Date", ["Key"])],
      [relationship("Sales", "Date", false)],
    );
    expect(aggregationDimensionOptions(overview, "Sales")).toEqual(["Sales"]);
  });

  it("returns a CLOSED list, so a typo is unreachable from the UI", () => {
    // The engine tries `Table[Column]`, then a bare column, then a bare table.
    // A key matching none of those is not an error anywhere — it is an
    // exception that never applies — so every option must name a real table.
    const overview = starOverview();
    const names = new Set(overview.tables.map((t) => t.name));
    for (const option of aggregationDimensionOptions(overview, "Sales")) {
      expect(names.has(option)).toBe(true);
    }
  });

  it("says nothing about a measure whose table is not in the model", () => {
    expect(aggregationDimensionOptions(starOverview(), "Ghost")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Role ordering
// ---------------------------------------------------------------------------

describe("compareColumnsByRole", () => {
  it("names every role exactly once, so no role can fall off the end of a table", () => {
    const seen = new Set(ROLE_DISPLAY_ORDER);
    expect(seen.size).toBe(ROLE_DISPLAY_ORDER.length);
    const all: Role[] = ["key", "analysis", "label", "filter", "hierarchy", "ignore"];
    expect([...seen].sort()).toEqual([...all].sort());
  });

  it("puts the columns a report can be broken down by above the model's plumbing", () => {
    const columns = [
      { name: "CustomerKey", role: "key" as Role },
      { name: "Amount", role: "ignore" as Role },
      { name: "Region", role: "analysis" as Role },
      { name: "Name", role: "label" as Role },
      { name: "Month", role: "hierarchy" as Role },
      { name: "Channel", role: "filter" as Role },
    ];
    expect([...columns].sort(compareColumnsByRole).map((c) => c.name)).toEqual([
      "Region",
      "Month",
      "Channel",
      "Name",
      "CustomerKey",
      "Amount",
    ]);
  });

  it("orders bare roles the same way, for a caller that breaks its own name ties", () => {
    // The Strategy tab projects its columns down to roles and tiebreaks by
    // name itself. Both spellings must agree, or a table's columns would sit in
    // one order in the grid and another anywhere else this order is printed.
    const roles: Role[] = ["ignore", "key", "analysis", "label"];
    expect([...roles].sort(compareColumnsByRole)).toEqual([
      "analysis",
      "label",
      "key",
      "ignore",
    ]);
    expect(compareColumnsByRole("analysis", "analysis")).toBe(0);
    expect(compareRoles("hierarchy", "filter")).toBeLessThan(0);
  });

  it("breaks a tie within a role by name", () => {
    const columns = [
      { name: "Region", role: "analysis" as Role },
      { name: "Country", role: "analysis" as Role },
    ];
    expect([...columns].sort(compareColumnsByRole).map((c) => c.name)).toEqual([
      "Country",
      "Region",
    ]);
  });

  it("sinks a column nobody has classified below even the ignored ones", () => {
    // "Nobody has said what this is for" is a weaker claim than "not worth
    // breaking down by", and the unclassified tail is what a person opens a
    // table to triage.
    const columns = [{ name: "Mystery" }, { name: "Amount", role: "ignore" as Role }];
    expect([...columns].sort(compareColumnsByRole).map((c) => c.name)).toEqual([
      "Amount",
      "Mystery",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The blanks the doc hands back for a name it does not mention
// ---------------------------------------------------------------------------

describe("tableEntry", () => {
  it("hands back an empty unconfirmed entry for a table the document never mentions", () => {
    const entry = tableEntry({ version: 1 }, "Absent");
    expect(entry).toEqual({ reviewed: false });
    expect(entryState(entry, tableHasValues(entry))).toBe("empty");
  });
});
