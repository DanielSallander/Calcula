// FILENAME: app/extensions/ModelEditor/lib/strategyTypes.test.ts
// PURPOSE: The PURE half of the strategy layer — the badge ladder, the
//          aggregation helpers and the role ordering the Strategy tab renders
//          from. No backend and nothing mounted: these are the decisions, and
//          they are asserted where they are made rather than through a
//          component. The one function imported out of a component file is
//          `parseFiscalYearStart`, which is pure, and it is imported so that
//          ONE reading of the Rust calendar can diff both restatements of it —
//          see the import for why splitting that would be worse.
// CONTEXT: Two of these suites exist because of a specific defect.
//
//          (1) `measureHasValues` ENUMERATES its fields, so a field added to
//          `MeasureStrategy` and forgotten there would make an entry that says
//          something report as empty. The field-coverage test closes that: the
//          sample is typed `Required<MeasureStrategy>`, so a new field is a
//          COMPILE error until it is added, then a test failure until it is
//          listed, then a test failure until the predicate considers it.
//
//          (0) AN EDIT REVOKES THE CONFIRMATION IT EDITS. `withMeasure` used
//          to re-stamp `source: "authored"` and leave `reviewed: true`
//          standing, so a confirmed row went on asserting a value no human had
//          ever seen — and `reviewed` is read by the decomposition engine. The
//          suite pins both directions: an edit drops it, and a patch that
//          touches nothing but `reviewed`/`source` (Confirm, un-confirm) still
//          re-authors nothing, so the round trip lands exactly where it began.
//
//          (2) `withAggregationDefault` exists because the editor used to
//          write `{ default: v }` over the whole spec, and `withMeasure`
//          merges shallowly — so choosing a default DELETED the per-dimension
//          exceptions, which the collapsed cell had never shown in the first
//          place. The Rust inferrer writes exactly that map for a semi-additive
//          balance, so this was reachable with real data.

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { ModelOverview, ModelRelationshipInfo, ModelTableInfo } from "@api";
import {
  ADDITIVITIES,
  CADENCES,
  DIRECTIONS,
  EXPECTED_STATUSES,
  MEASURE_VALUE_FIELDS,
  MODEL_VALUE_FIELDS,
  ROLES,
  ROLE_DISPLAY_ORDER,
  STRATEGY_SOURCES,
  TABLE_KINDS,
  TABLE_VALUE_FIELDS,
  UNITS,
  SUPPRESSIBLE_FACT_KINDS,
  aggregationDimensionOptions,
  bandDirectionIsIncomplete,
  compareColumnsByRole,
  compareRoles,
  effectiveTableKind,
  entryState,
  formatAggregationSpec,
  formatTargetSpec,
  inferenceTakePatch,
  measureDivergences,
  measureEntry,
  measureHasValues,
  modelDivergences,
  modelEntry,
  modelHasValues,
  formatScopeSpec,
  isValidIsoDate,
  nearestSuppressibleFactKind,
  parseCurrencyCode,
  parseIsoDate,
  parseScopeSpec,
  parseSuppressSpec,
  parseTargetSpec,
  stateIsHumanDecision,
  tableDivergences,
  tableEntry,
  tableHasValues,
  tableKindClaimsALookup,
  tableKindOrigin,
  tableKindTopologyRefusal,
  withAggregationDefault,
  withAggregationException,
  withColumn,
  withMeasure,
  withModel,
  withTable,
} from "./strategyTypes";
// THE ONE IMPORT OUT OF A COMPONENT FILE, and it is deliberate. The drift guard
// at the bottom of this file reads the calendar out of `insights/strategy/types.rs`
// once and diffs BOTH restatements of it against what it read: `isValidIsoDate`
// here and `parseFiscalYearStart` there. Splitting the two rows across two test
// files would mean two copies of the Rust-reading parser, which is the same
// second-source-of-truth this suite exists to refuse. `parseFiscalYearStart` is
// a pure function; nothing here mounts anything.
import { parseFiscalYearStart } from "../components/sections/StrategySection";
import type {
  AggregationSpec,
  MeasureStrategy,
  ModelStrategy,
  Role,
  Scope,
  StrategyDoc,
  TableStrategy,
  Target,
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

/** The model block with every value field populated. Same teeth as
 *  `FULL_MEASURE`: a field added to `ModelStrategy` stops this compiling. */
const FULL_MODEL: Required<ModelStrategy> = {
  defaultTimeAxis: "Date[Day]",
  fiscalYearStart: "04-01",
  reportingCurrency: "SEK",
  priority: ["Revenue"],
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

describe("modelHasValues", () => {
  it("lists every value field of the type, and nothing that is only metadata", () => {
    expect([...MODEL_VALUE_FIELDS].sort()).toEqual(
      Object.keys(FULL_MODEL)
        .filter((k) => k !== "reviewed" && k !== "source")
        .sort(),
    );
  });

  for (const field of MODEL_VALUE_FIELDS) {
    it(`counts ${field} on its own as something the model block says`, () => {
      const entry = { reviewed: false, [field]: FULL_MODEL[field] } as ModelStrategy;
      expect(modelHasValues(entry)).toBe(true);
    });
  }

  it("reads a block that states nothing as empty, however it is spelled", () => {
    expect(modelHasValues({ reviewed: false })).toBe(false);
    expect(
      modelHasValues({ reviewed: true, defaultTimeAxis: "", reportingCurrency: "", priority: [] }),
    ).toBe(false);
  });

  it("hands back an unconfirmed blank for a document with no model block", () => {
    const entry = modelEntry({ version: 1 });
    expect(entry).toEqual({ reviewed: false });
    expect(entryState(entry, modelHasValues(entry))).toBe("empty");
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

  it("stamps the model block the same way, and leaves it alone for a bare confirm", () => {
    const doc: StrategyDoc = { version: 1, model: { defaultTimeAxis: "Date[Day]", reviewed: false } };
    expect(withModel(doc, { reportingCurrency: "SEK" }).model?.source).toBe("authored");
    expect(withModel(doc, { reviewed: true }).model?.source).toBeUndefined();
    expect(withModel(doc, { reviewed: true }).model?.reviewed).toBe(true);
    // A block the document never had is created rather than merged into
    // nothing — `modelEntry` is what makes the missing case a blank.
    expect(withModel({ version: 1 }, { reportingCurrency: "SEK" }).model).toEqual({
      reviewed: false,
      source: "authored",
      reportingCurrency: "SEK",
    });
  });
});

describe("an edit revokes the confirmation it edits", () => {
  const confirmedDoc: StrategyDoc = {
    version: 1,
    measures: { Revenue: { direction: "higherIsBetter", reviewed: true, source: "inferred" } },
    tables: { Dim: { kind: "dimension", reviewed: true } },
    model: { defaultTimeAxis: "Date[Day]", reviewed: true },
  };

  it("drops reviewed when a value changes, because reviewed is about VALUES", () => {
    // THE DEFECT. The edit re-stamped `source: "authored"` and left
    // `reviewed: true` standing, so a confirmed row went on asserting a value
    // no human had ever seen — the same class as a `{reviewed: true}` entry
    // with no reader, one step further along, because this flag IS read.
    const next = withMeasure(confirmedDoc, "Revenue", { unit: "currency" });
    expect(next.measures?.Revenue?.reviewed).toBe(false);
    expect(next.measures?.Revenue?.source).toBe("authored");
  });

  it("drops it on a table, on a column edit, and on the model block", () => {
    expect(withTable(confirmedDoc, "Dim", { labelColumn: "Dept" }).tables?.Dim?.reviewed).toBe(
      false,
    );
    // The column map is part of what the table entry says.
    expect(
      withColumn(confirmedDoc, "Dim", "Dept", { role: "analysis" }).tables?.Dim?.reviewed,
    ).toBe(false);
    expect(withModel(confirmedDoc, { reportingCurrency: "SEK" }).model?.reviewed).toBe(false);
  });

  it("leaves it alone when the patch touches nothing but reviewed or source", () => {
    // Un-confirm is the other direction of the same act, and neither direction
    // may re-author: the round trip must land exactly where it started.
    const off = withMeasure(confirmedDoc, "Revenue", { reviewed: false });
    expect(off.measures?.Revenue?.source).toBe("inferred");
    const on = withMeasure(off, "Revenue", { reviewed: true });
    expect(on.measures?.Revenue).toEqual(confirmedDoc.measures?.Revenue);
  });

  it("lets one act say both things, which is how the CLI confirms what it wrote", () => {
    // `set measure [X] unit=currency reviewed=true` is a person writing a value
    // AND vouching for it in one command; the explicit flag wins over the
    // stamp, or the CLI could never confirm anything it had just set.
    const next = withMeasure(confirmedDoc, "Revenue", { unit: "currency", reviewed: true });
    expect(next.measures?.Revenue?.reviewed).toBe(true);
    expect(next.measures?.Revenue?.source).toBe("authored");
  });
});

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

describe("a band target", () => {
  it("round-trips the ordinary both-inclusive band unchanged", () => {
    const parsed = parseTargetSpec("band:0.8,1.2");
    // NO inclusivity keys: absent means inclusive, so an existing document
    // neither changes shape nor re-reads differently for having been opened.
    expect(parsed.ok === true && parsed.target).toEqual({ type: "band", low: 0.8, high: 1.2 });
    expect(formatTargetSpec({ type: "band", low: 0.8, high: 1.2 })).toBe("band:0.8,1.2");
  });

  it("reads and writes an exclusive bound as an interval bracket", () => {
    const parsed = parseTargetSpec("band:[0.8,1.2)");
    expect(parsed.ok === true && parsed.target).toEqual({
      type: "band",
      low: 0.8,
      high: 1.2,
      highInclusive: false,
    });
    expect(formatTargetSpec(parsed.ok === true ? parsed.target : undefined)).toBe("band:[0.8,1.2)");
    expect(
      formatTargetSpec({ type: "band", low: 0, high: 1, lowInclusive: false, highInclusive: false }),
    ).toBe("band:(0,1)");
  });

  it("refuses an interval it cannot read rather than guessing at the bounds", () => {
    const open = parseTargetSpec("band:[0.8,1.2");
    expect(open.ok).toBe(false);
    expect(open.ok === false && open.error).toContain("never closes it");
    expect(parseTargetSpec("band:[a,b]").ok).toBe(false);
  });

  it("knows a band DIRECTION that has no band to judge against", () => {
    // `targetBand` is the one direction that needs a second value to mean
    // anything: with no band every favourability comes back None and the
    // Variance fact is never emitted, silently.
    expect(bandDirectionIsIncomplete({ direction: "targetBand" })).toBe(true);
    expect(
      bandDirectionIsIncomplete({ direction: "targetBand", target: { type: "literal", value: 1 } }),
    ).toBe(true);
    expect(
      bandDirectionIsIncomplete({ direction: "targetBand", target: { type: "kpi" } }),
    ).toBe(true);
    const band: Target = { type: "band", low: 0.8, high: 1.2 };
    expect(bandDirectionIsIncomplete({ direction: "targetBand", target: band })).toBe(false);
    // Any other direction is complete on its own — a band is not required, and
    // a band left over from a previous direction is not an error either.
    expect(bandDirectionIsIncomplete({ direction: "higherIsBetter" })).toBe(false);
    expect(bandDirectionIsIncomplete({ direction: "higherIsBetter", target: band })).toBe(false);
    expect(bandDirectionIsIncomplete({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Divergence
// ---------------------------------------------------------------------------

describe("divergence between a stored decision and today's inference", () => {
  const confirmed: MeasureStrategy = {
    direction: "lowerIsBetter",
    unit: "count",
    reviewed: true,
  };

  it("reports the field, what the entry says, and what inference proposes", () => {
    const diverged = measureDivergences(confirmed, {
      direction: "higherIsBetter",
      unit: "count",
      reviewed: false,
    });
    // `unit` agrees, so it is not mentioned: a notice that lists everything is
    // one nobody reads.
    expect(diverged).toEqual([
      { field: "direction", yours: "lowerIsBetter", inference: "higherIsBetter" },
    ]);
  });

  it("counts a field the entry is SILENT about, which is what a new column looks like", () => {
    const diverged = measureDivergences(confirmed, {
      target: { type: "literal", value: 100 },
      reviewed: false,
    });
    expect(diverged).toEqual([{ field: "target", yours: "", inference: "100" }]);
  });

  it("does NOT count a field inference is silent about — no opinion is not a disagreement", () => {
    expect(measureDivergences(confirmed, { reviewed: false })).toEqual([]);
    // Nor the absent draft: a tab that could not infer shows no divergences at
    // all rather than claiming everything has changed.
    expect(measureDivergences(confirmed, undefined)).toEqual([]);
  });

  it("compares structured values by content, not by key order", () => {
    const entry: MeasureStrategy = {
      reviewed: true,
      aggregation: { default: "additive", byDimension: { Date: "lastValue" } },
    };
    expect(
      measureDivergences(entry, {
        reviewed: false,
        aggregation: { byDimension: { Date: "lastValue" }, default: "additive" },
      }),
    ).toEqual([]);
    const changed = measureDivergences(entry, {
      reviewed: false,
      aggregation: { default: "additive", byDimension: { Date: "firstValue" } },
    });
    expect(changed).toHaveLength(1);
    // The exception is IN the text, because "aggregation changed" with two
    // identical-looking defaults beside it says nothing at all.
    expect(changed[0].yours).toContain("Date: last value");
    expect(changed[0].inference).toContain("Date: first value");
  });

  it("reads a table entry and the model block the same way", () => {
    expect(
      tableDivergences({ kind: "fact", reviewed: true }, { kind: "dimension", reviewed: false }),
    ).toEqual([{ field: "kind", yours: "fact", inference: "dimension" }]);
    expect(
      modelDivergences(
        { defaultTimeAxis: "Sales[Date]", reviewed: true },
        { defaultTimeAxis: "Calendar[Day]", reviewed: false },
      ),
    ).toEqual([
      { field: "defaultTimeAxis", yours: "Sales[Date]", inference: "Calendar[Day]" },
    ]);
  });

  it("marks only the rows a human has a stake in", () => {
    // An inferred row that disagrees with today's inference is a stale draft;
    // an empty one has nothing to disagree with. Neither is a decision anybody
    // needs interrupting over.
    expect(stateIsHumanDecision("confirmed")).toBe(true);
    expect(stateIsHumanDecision("authored")).toBe(true);
    expect(stateIsHumanDecision("inferred")).toBe(false);
    expect(stateIsHumanDecision("empty")).toBe(false);
  });

  it("takes ONLY the diverging fields, and hands the row back as a proposal", () => {
    const proposed: MeasureStrategy = {
      direction: "higherIsBetter",
      unit: "count",
      cadence: "monthly",
      reviewed: false,
      source: "inferred",
    };
    const diverged = measureDivergences(confirmed, proposed);
    const patch = inferenceTakePatch(proposed, diverged);
    // `unit` AGREED, so it is not in the patch at all — taking inference's
    // answer to the disagreements is not the same as overwriting the row with
    // the whole draft. `cadence` is in it because the entry says nothing there
    // and inference does, which is what a newly added column looks like.
    expect(patch).toEqual({
      direction: "higherIsBetter",
      cadence: "monthly",
      source: "inferred",
      reviewed: false,
    });
    const applied = withMeasure(
      { version: 1, measures: { Revenue: confirmed } },
      "Revenue",
      patch,
    );
    // The values are the machine's, so the badge must say so — and nobody has
    // vouched for the new values yet.
    expect(entryState(applied.measures?.Revenue ?? { reviewed: false }, true)).toBe("inferred");
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

// ---------------------------------------------------------------------------
// suppress — a closed set whose near miss now costs the whole document
// ---------------------------------------------------------------------------

describe("parseSuppressSpec", () => {
  it("accepts every kind the backend can name, in the spelling it names it by", () => {
    // Both directions, deliberately: a list that has drifted from the Rust
    // enum either refuses a legal value or waves an illegal one through, and
    // only an equality against the whole set catches the first.
    const parsed = parseSuppressSpec(SUPPRESSIBLE_FACT_KINDS.join(","));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.kinds).toEqual([...SUPPRESSIBLE_FACT_KINDS]);
    expect([...SUPPRESSIBLE_FACT_KINDS]).toEqual([
      "change",
      "changePoint",
      "contribution",
      "definitionalDriver",
      "memberMove",
      "seasonality",
      "trend",
      "variance",
    ]);
  });

  it("refuses a near miss, names it, and says what the whole document would cost", () => {
    // `contribtion` is the shape of this mistake: the vocabulary is right and
    // the keyboard is wrong. Listing eight kinds back at somebody makes them
    // find their own answer; naming the one they meant does not.
    const parsed = parseSuppressSpec("trend,contribtion");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("Did you mean 'contribution'?");
      // The stake is the point. An unknown variant does not lose ONE
      // suppression — `strategy_doc` answers the serde failure by discarding
      // the whole document, so the refusal has to say so.
      expect(parsed.error).toContain("whole");
      expect(parsed.error).toContain("change, changePoint, contribution");
    }
  });

  it("refuses 'outlier' — the example this vocabulary used to offer", () => {
    // It is not a kind anything emits under any spelling (the core engine's
    // own key for that fact is the plural `outliers`, and a model run never
    // wraps one). It stood in the Rust doc comment AND in the tab's hint,
    // which is exactly how a prose list drifts from a parser.
    expect(parseSuppressSpec("outlier").ok).toBe(false);
  });

  it("reads an empty list as no suppression rather than as an error", () => {
    // Clearing the field is how a rule stops suppressing anything; refusing
    // the empty string would make that gesture unreachable.
    const parsed = parseSuppressSpec("");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.kinds).toEqual([]);
  });

  it("de-duplicates, because naming a kind twice suppresses it once", () => {
    const parsed = parseSuppressSpec("trend, trend ,variance");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.kinds).toEqual(["trend", "variance"]);
  });
});

describe("nearestSuppressibleFactKind", () => {
  it("reaches a long kind from a long typo without letting a short one wander", () => {
    expect(nearestSuppressibleFactKind("definitionalDrivr")).toBe("definitionalDriver");
    // `xy` is nothing's near miss. A fixed budget would have suggested
    // whichever kind happened to sort first, which is worse than silence.
    expect(nearestSuppressibleFactKind("xy")).toBeUndefined();
  });

  it("matches an exact kind whatever case it was typed in", () => {
    expect(nearestSuppressibleFactKind("CHANGEPOINT")).toBe("changePoint");
  });
});

// ---------------------------------------------------------------------------
// Table kind — whose answer is in force, and what the topology disproves
// ---------------------------------------------------------------------------

describe("tableKindOrigin", () => {
  it("calls an authored kind chosen and an inference-stamped one detected", () => {
    // THE DIFFERENCE CHANGES BEHAVIOUR. `authored_table_kinds` filters on
    // `source != inferred`, so the first of these overrides the backend's own
    // classification and the second is thrown away and re-derived.
    expect(tableKindOrigin({ kind: "calendar", reviewed: false, source: "authored" }, "fact")).toBe(
      "chosen",
    );
    expect(tableKindOrigin({ kind: "calendar", reviewed: false, source: "inferred" }, "fact")).toBe(
      "detected",
    );
  });

  it("counts an ABSENT source as chosen, the way the Rust filter does", () => {
    // A hand-written document has no `source` field and somebody typed it.
    expect(tableKindOrigin({ kind: "bridge", reviewed: false }, undefined)).toBe("chosen");
  });

  it("shows inference's reading when the entry is silent, and nothing when neither speaks", () => {
    expect(tableKindOrigin({ reviewed: false }, "dimension")).toBe("detected");
    expect(tableKindOrigin({ reviewed: false }, undefined)).toBe("none");
  });

  it("is a different axis from the row badge, which is why both exist", () => {
    // A table whose labelColumn a person typed reads `authored` as a ROW while
    // its kind is still a machine's reading. One badge cannot say both.
    const entry: TableStrategy = {
      kind: "fact",
      labelColumn: "Dept",
      reviewed: false,
      source: "inferred",
    };
    expect(entryState(entry, tableHasValues(entry))).toBe("inferred");
    expect(tableKindOrigin(entry, "fact")).toBe("detected");
    expect(effectiveTableKind(entry, "dimension")).toBe("fact");
    expect(effectiveTableKind({ reviewed: false }, "dimension")).toBe("dimension");
  });
});

describe("tableKindTopologyRefusal", () => {
  it("refuses a lookup claim on the table filters flow OUT of, and names the join", () => {
    // The case the whole seam turns on: `calendar` on a wide fact table
    // carrying an order date is the commonest way to get this wrong, and the
    // backend answers it with a Save-blocking error rather than a warning.
    const refusal = tableKindTopologyRefusal(starOverview(), "Sales", "calendar");
    expect(refusal).not.toBeNull();
    expect(refusal).toContain("'Sales'");
    // 'Date' is the SMALLEST of the two tables Sales filters, so the sentence
    // does not depend on relationship declaration order.
    expect(refusal).toContain("'Date'");
  });

  it("refuses a lookup claim on a table nothing points at either way", () => {
    const refusal = tableKindTopologyRefusal(starOverview(), "Archive", "dimension");
    expect(refusal).toContain("no active many-to-one or one-to-one relationship");
  });

  it("accepts the same kind on a table the model really can look up", () => {
    expect(tableKindTopologyRefusal(starOverview(), "Dim", "dimension")).toBeNull();
    expect(tableKindTopologyRefusal(starOverview(), "Date", "calendar")).toBeNull();
  });

  it("says nothing about the kinds that claim no lookup at all", () => {
    // `fact`, `bridge` and `other` assert nothing a relationship graph can
    // disprove, so refusing one here would be STRICTER than the validator —
    // which is worse than not checking, because the tab would then block a
    // document the backend accepts.
    for (const kind of ["fact", "bridge", "other"] as const) {
      expect(tableKindClaimsALookup(kind)).toBe(false);
      expect(tableKindTopologyRefusal(starOverview(), "Sales", kind)).toBeNull();
    }
  });

  it("ignores an INACTIVE relationship, because the planner never issues one", () => {
    const withInactive = overviewOf(
      [table("Sales", ["Key"]), table("Dim", ["Key"])],
      [relationship("Sales", "Dim", false)],
    );
    expect(tableKindTopologyRefusal(withInactive, "Dim", "dimension")).not.toBeNull();
  });

  it("ignores a many-to-many endpoint, which has no dimension side to be", () => {
    // Reading the to-side off every relationship whatever its cardinality is
    // how a bridge table ends up offered as an analysis axis.
    const bridged = overviewOf(
      [table("Sales", ["Key"]), table("Bridge", ["Key"])],
      [relationship("Sales", "Bridge", true, "manyToMany")],
    );
    expect(tableKindTopologyRefusal(bridged, "Bridge", "dimension")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scope text — format and parse are ONE grammar
//
// `list rules` prints `formatScopeSpec` and `add rule` reads `parseScopeSpec`,
// so copying a printed rule back in is how a rule gets edited. They had
// drifted: format printed an open-ended range as `Col=2025-01-01..` and parse
// demanded a second date, so the value fell through to the MEMBER branch and
// came back as the one-member list `["2025-01-01.."]` — a date range silently
// turned into a member filter that matches nothing. The checked-in corpus
// (`tests/fixtures/model/sales_star_strategy.json`) carries exactly such a
// range, so this was reachable with the fixture in the repo.
// ---------------------------------------------------------------------------

describe("scope spec round trip", () => {
  /** Every shape a `Scope` can hold, in both directions. */
  const SCOPES: Array<[what: string, scope: Scope]> = [
    ["a single member", { "Dim[Dept]": ["Refunds"] }],
    ["several members", { "Dim[Dept]": ["Refunds", "Retail"] }],
    ["a bounded date range", { "Date[Month]": { from: "2025-01-01", to: "2025-06-30" } }],
    ["an open-ended date range", { "Date[Month]": { from: "2025-01-01" } }],
    ["a leap day bound", { "Date[Month]": { from: "2024-02-29", to: "2024-12-31" } }],
    [
      "members and a range together",
      { "Dim[Dept]": ["Refunds"], "Date[Month]": { from: "2025-01-01" } },
    ],
    ["an empty scope", {}],
  ];

  it.each(SCOPES)("prints and re-reads %s unchanged", (_what, scope) => {
    const text = formatScopeSpec(scope);
    const parsed = parseScopeSpec(starOverview(), text);
    expect(parsed.ok, `'${text}' did not parse back`).toBe(true);
    if (parsed.ok) expect(parsed.scope).toEqual(scope);
  });

  /** The other direction: text a person types, printed back as they wrote it. */
  const TEXTS: string[] = [
    "Dim[Dept]=Refunds",
    "Dim[Dept]=Refunds,Retail",
    "Date[Month]=2025-01-01..2025-06-30",
    "Date[Month]=2025-01-01..",
    "Dim[Dept]=Refunds; Date[Month]=2025-01-01..",
  ];

  it.each(TEXTS)("re-prints '%s' as itself", (text) => {
    const parsed = parseScopeSpec(starOverview(), text);
    expect(parsed.ok, `'${text}' did not parse`).toBe(true);
    if (parsed.ok) expect(formatScopeSpec(parsed.scope)).toBe(text);
  });

  it("reads an open-ended range as a RANGE, not as a member whose name ends in dots", () => {
    // The exact regression, named. Before the end bound became optional this
    // produced `{"Date[Month]": ["2025-01-01.."]}` — well-formed, accepted by
    // the backend, and constraining the rule to a member no column has.
    const parsed = parseScopeSpec(starOverview(), "Date[Month]=2025-01-01..");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(Array.isArray(parsed.scope["Date[Month]"])).toBe(false);
      expect(parsed.scope["Date[Month]"]).toEqual({ from: "2025-01-01" });
    }
  });

  it("refuses a date range whose bounds have the right shape and are not dates", () => {
    // `2025-13-45` passed the old digit-counting regex and is refused by
    // `IsoDate` at DESERIALIZE, so the command planned, executed, and left a
    // document nothing could open.
    const parsed = parseScopeSpec(starOverview(), "Date[Month]=2025-13-01..2025-99-99");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("2025-13-01");
  });

  it("refuses a range with no start rather than reading it as a member", () => {
    const parsed = parseScopeSpec(starOverview(), "Date[Month]=..2025-06-30");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("is not a date range");
  });

  it("still reads an ordinary member list, which carries no dots", () => {
    const parsed = parseScopeSpec(starOverview(), "Dim[Dept]=Refunds, Retail");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.scope["Dim[Dept]"]).toEqual(["Refunds", "Retail"]);
  });
});

// ---------------------------------------------------------------------------
// The newtype mirrors — `IsoDate` and `CurrencyCode`
// ---------------------------------------------------------------------------

describe("isValidIsoDate", () => {
  it("accepts real dates and refuses days their month does not have", () => {
    for (const good of ["2025-01-01", "2025-12-31", "2024-02-29", "2000-02-29", "2025-06-30"]) {
      expect(isValidIsoDate(good), `'${good}' is a date`).toBe(true);
    }
    // 1900 is the century that is NOT a leap year, which is the case a
    // `year % 4` check gets wrong; 2026-02-31 is the case a `1..=31` day range
    // gets wrong.
    for (const bad of [
      "2026-02-31",
      "2025-02-29",
      "1900-02-29",
      "2025-13-01",
      "2025-00-01",
      "2025-01-00",
      "2025-04-31",
      "2025-1-01",
      "20250101",
      "2025-01-01T00:00:00",
      "",
    ]) {
      expect(isValidIsoDate(bad), `'${bad}' is not a date`).toBe(false);
    }
  });

  it("names the value and the format when it refuses one", () => {
    const parsed = parseIsoDate("2025-13-45");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("2025-13-45");
      expect(parsed.error).toContain("YYYY-MM-DD");
      // The STAKE, the same way the suppress refusal states it: a bad bound is
      // not one bad field, it is a document that stops parsing.
      expect(parsed.error).toContain("whole strategy document");
    }
  });
});

describe("parseCurrencyCode", () => {
  it("takes a three-letter uppercase code and clears on empty", () => {
    expect(parseCurrencyCode("SEK")).toEqual({ ok: true, value: "SEK" });
    expect(parseCurrencyCode("  EUR  ")).toEqual({ ok: true, value: "EUR" });
    // Clearing the field is how a document stops naming a currency; refusing
    // an empty box would make that gesture unreachable.
    expect(parseCurrencyCode("")).toEqual({ ok: true, value: undefined });
  });

  it("refuses every shape `CurrencyCode::from_str` refuses", () => {
    for (const bad of ["sek", "Sek", "kr", "USDX", "US1", "SE K"]) {
      const parsed = parseCurrencyCode(bad);
      expect(parsed.ok, `'${bad}' must be refused`).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain(bad);
    }
  });
});

// ---------------------------------------------------------------------------
// Rust -> TypeScript drift on the CLOSED SETS
//
// Every closed set below exists twice: once as a Rust enum whose variants the
// document is parsed against, and once as a TypeScript array this tab and the
// CLI author from. Adding a ninth `SuppressibleFactKind`, or a fifth
// `ExpectedStatus`, used to red NOTHING on this side — the mirrors were
// hand-typed and nothing compared them.
//
// Same shape and same reason as
// `app/src/api/__tests__/interpreterReachDrift.test.ts`: READ the other
// language's source of truth at test time rather than restating it. THE
// DIRECTION IS FIXED, Rust -> TypeScript, because Rust is where the document is
// PARSED: a TS array missing a variant merely fails to offer it, but a TS array
// carrying one Rust does not have writes a document `serde` refuses — and
// `strategy_doc` answers a serde failure by discarding the whole file. So Rust
// states the vocabulary and TypeScript must match it, never the reverse.
// ---------------------------------------------------------------------------

describe("the closed sets mirror insights/strategy/types.rs", () => {
  const TYPES_RS = path.resolve(__dirname, "../../../src-tauri/src/insights/strategy/types.rs");
  const rustSrc = fs.readFileSync(TYPES_RS, "utf8");

  const FIX =
    "FIX: app/src-tauri/src/insights/strategy/types.rs is the source of truth — it is " +
    "where the document is parsed. Update the mirror in " +
    "app/extensions/ModelEditor/lib/strategyTypes.ts to match it, never the other way " +
    "round. A TS array carrying a variant Rust does not have writes a document serde " +
    "refuses, and strategy_doc answers that by discarding the whole file.";

  /** `PascalCase` -> the `rename_all = "camelCase"` wire spelling serde emits. */
  function camel(variant: string): string {
    return variant.charAt(0).toLowerCase() + variant.slice(1);
  }

  /**
   * The variants of one `#[serde(rename_all = "camelCase")]` unit enum, in
   * declaration order.
   *
   * Order is checked, not just membership: several of these arrays are rendered
   * as dropdowns in declaration order, and `ExpectedStatus` derives `Ord` from
   * it. Doc comments and attributes between variants are skipped; a variant
   * with a payload is not a unit enum and would not belong in a closed-set
   * mirror, so the body match deliberately accepts only bare identifiers.
   */
  function rustEnumVariants(name: string): string[] {
    const at = rustSrc.indexOf(`pub enum ${name} {`);
    expect(at, `'pub enum ${name}' not found in types.rs`).toBeGreaterThan(-1);
    // The `rename_all` attribute must be there, or the wire spellings this
    // function computes are a fiction.
    const header = rustSrc.slice(Math.max(0, at - 400), at);
    expect(
      header.includes('rename_all = "camelCase"'),
      `${name} has no rename_all = "camelCase", so the camelCase wire spellings ` +
        `this guard derives are wrong. ${FIX}`,
    ).toBe(true);
    const open = rustSrc.indexOf("{", at);
    const close = rustSrc.indexOf("\n}", open);
    expect(close, `unterminated 'pub enum ${name}'`).toBeGreaterThan(-1);
    const body = rustSrc.slice(open + 1, close);
    const variants: string[] = [];
    for (const line of body.split("\n")) {
      const text = line.trim();
      // Skip doc comments, ordinary comments and attributes; take the bare
      // `Variant,` lines that a unit enum is made of.
      if (text === "" || text.startsWith("//") || text.startsWith("#[")) continue;
      const m = /^([A-Z][A-Za-z0-9]*),$/.exec(text);
      expect(m, `'${text}' in enum ${name} is not a bare unit variant`).not.toBeNull();
      if (m) variants.push(m[1]);
    }
    expect(variants.length, `enum ${name} parsed to no variants`).toBeGreaterThan(0);
    return variants;
  }

  /** Every mirror, and the Rust enum it claims to be a mirror OF. */
  const MIRRORS: Array<[rustEnum: string, tsConst: readonly string[]]> = [
    ["Direction", DIRECTIONS],
    ["Additivity", ADDITIVITIES],
    ["Unit", UNITS],
    ["Cadence", CADENCES],
    ["Role", ROLES],
    ["TableKind", TABLE_KINDS],
    ["EntrySource", STRATEGY_SOURCES],
    ["ExpectedStatus", EXPECTED_STATUSES],
    ["SuppressibleFactKind", SUPPRESSIBLE_FACT_KINDS],
  ];

  it.each(MIRRORS)("%s has exactly the variants Rust declares, in order", (rustEnum, tsConst) => {
    const expected = rustEnumVariants(rustEnum).map(camel);
    expect([...tsConst], `${rustEnum} mirror has drifted. ${FIX}`).toEqual(expected);
  });

  it("checks the guard's own reading of the file, not merely its own arrays", () => {
    // A parser that silently found nothing would make every row above pass by
    // comparing two empty lists. Pinning one known variant of one known enum
    // proves the file was read and the body was understood.
    expect(rustEnumVariants("SuppressibleFactKind")).toContain("DefinitionalDriver");
    expect(rustEnumVariants("Direction")).toContain("TargetBand");
  });

  it("names every closed-set enum types.rs declares, so a new one cannot skip the diff", () => {
    // The MIRRORS list is hand-written and would otherwise rot the way the
    // mirrors themselves did. This finds every `rename_all = "camelCase"` unit
    // enum in the file and insists it is either diffed above or listed here as
    // deliberately not mirrored — so a NEW Rust enum reds until somebody
    // decides which it is.
    const declared = [...rustSrc.matchAll(/pub enum (\w+) \{([^}]*)\}/g)]
      .filter(([, , body]) =>
        body
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l !== "" && !l.startsWith("//") && !l.startsWith("#["))
          .every((l) => /^[A-Z][A-Za-z0-9]*,$/.test(l)),
      )
      .map(([, name]) => name);
    const mirrored = new Set(MIRRORS.map(([name]) => name));
    // Rust-INTERNAL enums the wire never carries, so there is nothing on this
    // side to mirror. `BandSide` names which END of a band a finding is about,
    // inside a message the backend formats. `Attribute` is the axis overlap.rs
    // groups conflicts by and resolve.rs layers along; it lives inside
    // `Conflict`, which no Tauri command returns — what reaches this side is
    // the FINDING TEXT built from it. Either becoming wire vocabulary is a
    // reason to mirror it, not a reason to extend this list.
    const notMirrored = new Set(["BandSide", "Attribute"]);
    for (const name of declared) {
      expect(
        mirrored.has(name) || notMirrored.has(name),
        `enum ${name} is a closed set in types.rs and is diffed nowhere. ` +
          `Mirror it in strategyTypes.ts and add it to MIRRORS, or add it to ` +
          `notMirrored with the reason it carries no wire vocabulary. ${FIX}`,
      ).toBe(true);
    }
    expect(declared.length, "no unit enums found — the scan is broken").toBeGreaterThan(4);
  });

  it("keeps ROLE_DISPLAY_ORDER a permutation of ROLES rather than a second vocabulary", () => {
    // A PRESENTATION order over the mirror, not a mirror of its own — so it is
    // checked against ROLES, which the row above checks against Rust.
    expect([...ROLE_DISPLAY_ORDER].sort()).toEqual([...ROLES].sort());
  });

  it("pins the CurrencyCode rule the tab's own validator mirrors", () => {
    // `parseCurrencyCode` restates a Rust PREDICATE rather than an enum, so the
    // diff above cannot see it. Reading the predicate keeps the restatement
    // honest: if `from_str` stops demanding three uppercase ASCII letters, this
    // reds and the mirror gets re-read.
    const at = rustSrc.indexOf("impl FromStr for CurrencyCode");
    expect(at, "impl FromStr for CurrencyCode not found in types.rs").toBeGreaterThan(-1);
    const body = rustSrc.slice(at, at + 600);
    expect(body, `the CurrencyCode rule has changed. ${FIX}`).toContain("s.len() == 3");
    expect(body, `the CurrencyCode rule has changed. ${FIX}`).toContain("is_ascii_uppercase");
  });

  // -------------------------------------------------------------------------
  // The two CALENDAR predicates
  //
  // `isValidIsoDate` (here) and `parseFiscalYearStart` (`StrategySection.tsx`)
  // are restatements of Rust FUNCTIONS, not of enums, so the variant diff above
  // is blind to them. The `CurrencyCode` row directly above pins its rule by
  // quoting two substrings back at the file; a calendar cannot be pinned that
  // way, because "is the day inside its own month" is a table and a leap-year
  // rule rather than a phrase. So these rows READ the Rust functions and RUN
  // them: the leap-year body is a boolean expression that happens to be valid
  // JavaScript, and both month tables are a `match month` whose arms parse.
  // What is compared is behaviour on a probe grid, not text.
  //
  // THERE ARE TWO RUST TABLES AND THEY ARE NOT THE SAME TABLE. `days_in_month`
  // answers for a `YYYY-MM-DD` and consults the leap rule; `max_day_of_month`
  // answers for an `MM-DD`, which names no year, and therefore allows February
  // 29 unconditionally. Each restatement is diffed against ITS OWN table, so a
  // change to one does not red the other and neither is checked against a
  // table it does not implement.
  //
  // Before this, `DAYS_IN_MONTH` and `isLeapYear` in strategyTypes.ts matched
  // Rust by luck: they were typed from it once and nothing ever looked again.
  // `MONTH_DAY_MAX` in StrategySection.tsx is newer than that — it was written
  // in the same pass as this guard, replacing a flat 1..=31 day bound that had
  // stopped agreeing with `MonthDay` — and it arrives already diffed.
  // -------------------------------------------------------------------------

  /**
   * Rust's `is_leap_year`, EVALUATED rather than restated a third time.
   *
   * Its body — `(year % 4 == 0 && year % 100 != 0) || year % 400 == 0` — is
   * also a valid JavaScript expression, so the guard runs the Rust source
   * itself. Writing a JS copy of it here would just be one more restatement of
   * exactly the kind this suite exists to catch.
   */
  function rustIsLeapYear(): (year: number) => boolean {
    const at = rustSrc.indexOf("fn is_leap_year(year: u32) -> bool {");
    expect(at, "fn is_leap_year not found in types.rs").toBeGreaterThan(-1);
    const open = rustSrc.indexOf("{", at);
    const close = rustSrc.indexOf("\n}", open);
    expect(close, "unterminated fn is_leap_year").toBeGreaterThan(-1);
    const body = rustSrc.slice(open + 1, close).trim();
    // A body this guard cannot read must RED, never be evaluated hopefully. A
    // statement, a `let`, a call — any of them means the rule moved somewhere
    // this guard is not looking, and a guard that misreads its own source
    // passes for the wrong reason.
    expect(
      body,
      `is_leap_year is no longer a single boolean expression this guard can ` +
        `evaluate, so it is no longer diffed at all. ${FIX}`,
    ).toMatch(/^[\d\s%=!&|()a-z_]+$/);
    return new Function("year", `return (${body});`) as (year: number) => boolean;
  }

  /**
   * The `match month { ... }` inside one Rust function, as a lookup.
   *
   * Every arm inside the match must parse — the `_` catch-all included; an arm
   * shape this cannot read is a FAILURE rather than a skip, because a skipped
   * arm builds a shorter table that still answers every probe and answers some
   * of them wrongly. `if is_leap_year(year)` is the only guard form supported,
   * which is the only one either function uses; a new guard reds here rather
   * than being quietly ignored.
   */
  function rustMonthTable(signature: string): (year: number, month: number) => number {
    const at = rustSrc.indexOf(signature);
    expect(at, `'${signature}' not found in types.rs`).toBeGreaterThan(-1);
    const matchAt = rustSrc.indexOf("match month {", at);
    expect(matchAt, `'${signature}' no longer matches on month. ${FIX}`).toBeGreaterThan(-1);
    const arms: Array<{ months: number[] | null; leapOnly: boolean; days: number }> = [];
    const lines = rustSrc.slice(matchAt).split("\n").slice(1);
    let closed = false;
    for (const line of lines) {
      const text = line.trim();
      if (text === "}") {
        closed = true;
        break;
      }
      if (text === "" || text.startsWith("//")) continue;
      const m = /^([\d|\s]+|_)(?:if\s+(is_leap_year\(year\)))?\s*=>\s*(\d+),$/.exec(text);
      expect(
        m,
        `'${text}' is an arm of '${signature}' this guard cannot read, so the ` +
          `table it builds would be wrong rather than merely absent. ${FIX}`,
      ).not.toBeNull();
      if (!m) continue;
      arms.push({
        months: m[1].trim() === "_" ? null : m[1].split("|").map((p) => Number(p.trim())),
        leapOnly: m[2] !== undefined,
        days: Number(m[3]),
      });
    }
    expect(closed, `the match block in '${signature}' never closed`).toBe(true);
    const leap = rustIsLeapYear();
    return (year: number, month: number): number => {
      for (const arm of arms) {
        if (arm.months !== null && !arm.months.includes(month)) continue;
        if (arm.leapOnly && !leap(year)) continue;
        return arm.days;
      }
      throw new Error(`'${signature}' parsed to no catch-all arm`);
    };
  }

  /** The `YYYY-MM-DD` calendar `IsoDate::is_valid` uses. Consults the leap rule. */
  const rustDaysInMonth = (): ((year: number, month: number) => number) =>
    rustMonthTable("fn days_in_month(year: u32, month: u32) -> u32 {");

  /**
   * The `MM-DD` ceiling `MonthDay::new` uses. It takes no year, so the wrapper
   * drops the one this parser's shared arm evaluator expects.
   */
  const rustMaxDayOfMonth = (): ((month: number) => number) => {
    const table = rustMonthTable("const fn max_day_of_month(month: u32) -> u32 {");
    return (month: number) => table(0, month);
  };

  const pad = (n: number, width: number): string => String(n).padStart(width, "0");

  it("reads two real calendars out of types.rs rather than two empty tables", () => {
    // The rows below would pass by comparing predicates that all answer "no" if
    // a parse silently produced nothing. These are the answers that separate a
    // real calendar from a degenerate one, plus the century rule the
    // divisible-by-four shorthand gets wrong in both directions — and the one
    // value where the two tables deliberately DISAGREE, February.
    const daysInMonth = rustDaysInMonth();
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 13)).toBe(0);
    const isLeap = rustIsLeapYear();
    expect(isLeap(2000)).toBe(true);
    expect(isLeap(1900)).toBe(false);
    const maxDay = rustMaxDayOfMonth();
    expect(maxDay(2)).toBe(29);
    expect(maxDay(4)).toBe(30);
    expect(maxDay(1)).toBe(31);
  });

  it("answers every YYYY-MM-DD probe the way types.rs answers it", () => {
    const daysInMonth = rustDaysInMonth();
    // The years are chosen for the leap rule: 1900 and 2100 are the century
    // exception, 2000 the exception to the exception, 2024 an ordinary leap
    // year. Months and days run one step PAST their legal range so that the
    // boundaries are probed from outside as well as inside.
    for (const year of [1900, 1999, 2000, 2023, 2024, 2100]) {
      for (let month = 0; month <= 13; month += 1) {
        for (let day = 0; day <= 32; day += 1) {
          const text = `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
          const rust = day >= 1 && day <= daysInMonth(year, month);
          expect(isValidIsoDate(text), `${text}: types.rs says ${rust}. ${FIX}`).toBe(rust);
        }
      }
    }
  });

  it("refuses the shapes that are not ten digits-and-dashes at all", () => {
    // The probe grid above only ever builds well-shaped text, so on its own it
    // says nothing about the FORM check — and the form is the load-bearing half
    // here: overlap.rs compares these bounds as text.
    for (const bad of ["2026-1-01", "2026/01/01", "20260101", "2026-01-01 ", "26-01-01", ""]) {
      expect(isValidIsoDate(bad), `'${bad}' must not be a date`).toBe(false);
    }
  });

  it("gives a fiscal year start the day ceilings max_day_of_month declares", () => {
    // `MonthDay` is deliberately looser than `IsoDate` in exactly one way: an
    // MM-DD names no year, so whether `02-29` exists is unanswerable and it has
    // to be accepted. That is why the ceiling comes from `max_day_of_month`
    // rather than from `days_in_month` with some year supplied — the second
    // would be this guard inventing a rule for the backend instead of reading
    // the one it has.
    //
    // Only months 1..=12 are probed here, because `max_day_of_month`'s `_` arm
    // answers 31 for every other month and `MonthDay::new` never reaches it:
    // the month range is checked first, and the row below is what pins it.
    const maxDay = rustMaxDayOfMonth();
    for (let month = 1; month <= 12; month += 1) {
      for (let day = 0; day <= 32; day += 1) {
        const text = `${pad(month, 2)}-${pad(day, 2)}`;
        const rust = day >= 1 && day <= maxDay(month);
        expect(parseFiscalYearStart(text).ok, `'${text}': types.rs says ${rust}. ${FIX}`).toBe(
          rust,
        );
      }
    }
    // The six days no year has that a flat 1..=31 day bound used to accept,
    // named one by one so a failure says which case moved, and the one loose
    // case beside them so a tightening cannot quietly take it too.
    //
    // SIX, and this line said five over the same six-item list. `02-30` is the
    // one that goes missing whenever February is thought about as the leap-year
    // case rather than as a month with a ceiling like any other, which is the
    // same slip the Rust header records having made and fixed.
    for (const impossible of ["02-31", "02-30", "04-31", "06-31", "09-31", "11-31"]) {
      expect(parseFiscalYearStart(impossible).ok, `'${impossible}' is a day no year has`).toBe(
        false,
      );
    }
    expect(parseFiscalYearStart("02-29").ok, "an MM-DD names no year").toBe(true);
  });

  it("refuses a fiscal-year month outside the 1..=12 MonthDay::new still spells", () => {
    // The table above cannot decide this: `max_day_of_month` answers 31 for a
    // month outside 1..=12, and it is `MonthDay::new` that refuses those before
    // it asks. So the month bound is pinned as TEXT, and the tab is checked
    // against it from both sides of each end.
    const at = rustSrc.indexOf("impl MonthDay {");
    expect(at, "impl MonthDay not found in types.rs").toBeGreaterThan(-1);
    const body = rustSrc.slice(at, rustSrc.indexOf("\n}", at));
    expect(
      body,
      `MonthDay::new no longer bounds the month by 1..=12, so parseFiscalYearStart ` +
        `(StrategySection.tsx) is enforcing a range the backend has stopped ` +
        `enforcing. ${FIX}`,
    ).toContain("(1..=12).contains(&month)");
    for (const bad of ["00-01", "13-01", "99-01"]) {
      expect(parseFiscalYearStart(bad).ok, `'${bad}' is not a month`).toBe(false);
    }
    expect(parseFiscalYearStart("01-01").ok).toBe(true);
    expect(parseFiscalYearStart("12-31").ok).toBe(true);
  });

  it("reds if MonthDay::new goes back to bounding the day by a flat 1..=31", () => {
    // A behavioural probe cannot see this one. The rows above read
    // `max_day_of_month`, and that function would go on answering 29 for
    // February while `MonthDay::new` stopped calling it and widened back to
    // `1..=31` inline — at which point the tab refuses `02-31` and Save accepts
    // it, which is the second, stricter rule nobody wrote down. This is the
    // exact spelling the type carried before it was tightened, so it is the
    // exact spelling a revert would restore.
    const at = rustSrc.indexOf("impl MonthDay {");
    expect(at, "impl MonthDay not found in types.rs").toBeGreaterThan(-1);
    const body = rustSrc.slice(at, rustSrc.indexOf("\n}", at));
    expect(
      body.includes("1..=31"),
      `MonthDay::new bounds the day by a flat 1..=31 again, so the backend now ` +
        `accepts 02-30, 02-31, 04-31, 06-31, 09-31 and 11-31 while parseFiscalYearStart ` +
        `(StrategySection.tsx) refuses them. ${FIX}`,
    ).toBe(false);
  });
});
