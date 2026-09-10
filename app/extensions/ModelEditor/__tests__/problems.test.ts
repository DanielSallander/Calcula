// FILENAME: app/extensions/ModelEditor/__tests__/problems.test.ts
// PURPOSE: What the problems list reports — and, just as important, what it
//          deliberately does NOT.
// CONTEXT: A problems list that cries wolf gets ignored, and then the one real
//          row in it is missed too. Several tests here pin an ABSENCE: they
//          exist so that "why doesn't it warn about X?" is answered by a test
//          with a reason rather than re-added as a well-meaning improvement
//          that buries everything else.

import { describe, expect, it } from "vitest";
import type { ModelOverview } from "@api";
import {
  bestPracticeProblems,
  describeCoverage,
  groupProblems,
  locateStrategyFinding,
  modelBuildProblem,
  problemsBySection,
  sortProblems,
  strategyProblems,
  worstSeverity,
} from "../lib/problems";

function col(name: string, over: Record<string, unknown> = {}) {
  return {
    name, dataType: "String", displayName: null, description: null, isHidden: false,
    isCalculated: false, isDynamic: false, formula: null, lookupResolution: null,
    sortByColumn: null, formatString: null, ...over,
  };
}
function table(name: string, cols: ReturnType<typeof col>[], over: Record<string, unknown> = {}) {
  return {
    name, displayName: null, description: null, isHidden: false, storageMode: "DirectQuery",
    bound: true, sourceId: "s1", transformSteps: [], transformScript: null, sourceColumns: [],
    columns: cols, refreshStrategies: [], incrementalRefresh: null, ...over,
  };
}
function measure(name: string, over: Record<string, unknown> = {}) {
  return {
    name, table: "Fact", formula: "SUM(x)", hasSource: true, description: null,
    formatString: "0", formatStringExpression: null, detailRows: null, isHidden: false,
    group: null, ...over,
  };
}
function rel(name: string, fromTable: string, fromColumn: string, toTable: string, toColumn: string) {
  return {
    name, fromTable, toTable, cardinality: "manyToOne", active: true, isActive: true,
    filterPropagation: "auto", conditions: [{ fromColumn, toColumn, operator: "=" }],
  };
}

function overview(over: Partial<Record<string, unknown>> = {}): ModelOverview {
  return {
    editable: true, readOnlyReason: null,
    tables: [
      table("Fact", [col("Id"), col("DimId"), col("Amount")]),
      table("Dim", [col("Id"), col("Name")]),
    ],
    relationships: [rel("Fact_Dim", "Fact", "DimId", "Dim", "Id")],
    hierarchies: [], kpis: [], securityRoles: [], perspectives: [], cultures: [],
    calculationGroups: [], measures: [measure("Revenue")],
    contexts: [], contextColumns: [], tableVariables: [], globalVariables: [],
    scriptFunctions: [], dateTable: "Dim", defaultLookupResolution: null,
    modelName: "M", modelVersion: null, modelAuthor: null, modelDescription: null,
    sources: [], writebackColumns: [],
    ...over,
  } as unknown as ModelOverview;
}

const codes = (o: ModelOverview): string[] => bestPracticeProblems(o).map((p) => p.code);

describe("a clean model reports nothing", () => {
  it("finds no problems in a well-formed star", () => {
    expect(bestPracticeProblems(overview())).toEqual([]);
  });
});

describe("real breakage is an error", () => {
  it("catches a relationship pointing at a missing table", () => {
    const o = overview({ relationships: [rel("R", "Fact", "DimId", "Ghost", "Id")] });
    const p = bestPracticeProblems(o).find((x) => x.code === "relationship-missing-table")!;
    expect(p.severity).toBe("error");
    expect(p.message).toMatch(/Ghost/);
    expect(p.section).toBe("relationships");
    expect(p.selection).toBe("R");
  });

  it("catches a relationship pointing at a missing column", () => {
    const o = overview({ relationships: [rel("R", "Fact", "Nope", "Dim", "Id")] });
    const p = bestPracticeProblems(o).find((x) => x.code === "relationship-missing-column")!;
    expect(p.severity).toBe("error");
    expect(p.message).toMatch(/Fact\[Nope\]/);
  });

  it("catches a hierarchy level pointing at a missing column", () => {
    const o = overview({
      hierarchies: [{ name: "Geo", table: "Dim", levels: [{ column: "Ghost" }] }],
    });
    const p = bestPracticeProblems(o).find((x) => x.code === "hierarchy-missing-column")!;
    expect(p.severity).toBe("error");
    expect(p.selection).toBe("Geo");
  });

  it("catches a sort-by pointing at a missing column", () => {
    const o = overview({
      tables: [table("Dim", [col("Name", { sortByColumn: "SortOrder" })])],
      relationships: [],
    });
    expect(codes(o)).toContain("sortby-missing-column");
  });

  it("does not double-report a hierarchy whose whole TABLE is missing", () => {
    // The missing table has its own row; adding one per level would turn one
    // fact into five.
    const o = overview({
      hierarchies: [{ name: "Geo", table: "Ghost", levels: [{ column: "a" }, { column: "b" }] }],
    });
    expect(codes(o)).not.toContain("hierarchy-missing-column");
  });
});

describe("before-you-ship warnings", () => {
  it("flags a table that joins nothing", () => {
    const o = overview({
      tables: [
        table("Fact", [col("Id"), col("DimId")]),
        table("Dim", [col("Id")]),
        table("Orphan", [col("Id")]),
      ],
    });
    const p = bestPracticeProblems(o).find((x) => x.code === "orphan-table")!;
    expect(p.severity).toBe("warning");
    expect(p.subject).toBe("Orphan");
  });

  it("stays quiet about orphans when the model has NO relationships at all", () => {
    // Then it is one fact about the model, not one fact per table — a fresh
    // import would otherwise open with a warning per table.
    const o = overview({ relationships: [] });
    expect(codes(o)).not.toContain("orphan-table");
  });

  it("flags an unbound table", () => {
    const o = overview({
      tables: [table("Fact", [col("Id"), col("DimId")]), table("Dim", [col("Id")], { bound: false })],
    });
    expect(codes(o)).toContain("unbound-table");
  });

  it("flags an empty perspective and an empty culture", () => {
    const o = overview({
      perspectives: [{ name: "Sales", tables: [], columns: [], measures: [], description: null }],
      cultures: [{ locale: "sv-SE", tables: [], columns: [], measures: [] }],
    });
    expect(codes(o)).toContain("empty-perspective");
    expect(codes(o)).toContain("empty-culture");
  });

  it("flags a VISIBLE measure with no format", () => {
    const o = overview({ measures: [measure("Revenue", { formatString: null })] });
    expect(codes(o)).toContain("no-format-string");
  });

  it("stays quiet about a HIDDEN measure with no format", () => {
    // A hidden measure is an intermediate nobody formats on purpose. Flagging
    // those is exactly the noise that gets a problems list ignored.
    const o = overview({
      measures: [measure("_base", { formatString: null, isHidden: true })],
    });
    expect(codes(o)).not.toContain("no-format-string");
  });

  it("accepts a dynamic format expression as a format", () => {
    const o = overview({
      measures: [measure("R", { formatString: null, formatStringExpression: 'IF(1,"0")' })],
    });
    expect(codes(o)).not.toContain("no-format-string");
  });

  it("reports a missing date table ONCE, not per measure", () => {
    const o = overview({ dateTable: null, measures: [measure("a"), measure("b"), measure("c")] });
    expect(codes(o).filter((c) => c === "no-date-table")).toHaveLength(1);
  });
});

describe("deliberate silences", () => {
  it("does NOT flag an inactive relationship", () => {
    // Inactive is a DELIBERATE modelling choice (USERELATIONSHIP), not a
    // defect. Reporting it would train people to ignore the list.
    const o = overview({
      relationships: [{ ...rel("R", "Fact", "DimId", "Dim", "Id"), active: false, isActive: false }],
    });
    expect(bestPracticeProblems(o)).toEqual([]);
  });

  it("does NOT flag missing descriptions", () => {
    // True of most objects in most models; it would bury everything else.
    const o = overview();
    expect(codes(o)).not.toContain("no-description");
  });
});

describe("the engine's own answer", () => {
  it("renders as exactly ONE row, never a list", () => {
    // `bi_model_validate` can only ever return one anchorless error; showing it
    // as a list would imply a completeness it does not have.
    const rows = modelBuildProblem([
      { level: "error", message: "circular reference" },
      { level: "error", message: "second thing" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toMatch(/circular reference/);
    expect(rows[0].severity).toBe("error");
  });

  it("says nothing when the model builds", () => {
    expect(modelBuildProblem([])).toEqual([]);
  });
});

describe("strategy findings", () => {
  // THE TOKEN IS THE WHOLE PATH. It used to be the bare object name, which
  // threw away everything the consumer needs: which of Strategy's four views
  // the row lives in, and — for a column or an attribute — which part of the
  // row. It could not even say whether "Sales" was a table or a measure. The
  // tab consequently did nothing with it at all.
  it("carries a measure finding's whole path, attribute included", () => {
    expect(locateStrategyFinding("measures['Margin %'].unit")).toEqual({
      section: "strategy",
      selection: "measures['Margin %'].unit",
    });
  });

  it("carries a column finding's path rather than collapsing it to the table", () => {
    expect(locateStrategyFinding("tables['Dim_Date'].columns['Year']")).toEqual({
      section: "strategy",
      selection: "tables['Dim_Date'].columns['Year']",
    });
  });

  it("anchors a RULE finding, which it used to drop", () => {
    // rules[N] is a real row in a real view. Returning no selection for it sent
    // the user to the Measures view with nothing selected.
    expect(locateStrategyFinding("rules[2].scope")).toEqual({
      section: "strategy",
      selection: "rules[2].scope",
    });
  });

  it("anchors a MODEL finding to the defaults view", () => {
    expect(locateStrategyFinding("model.defaultTimeAxis")).toEqual({
      section: "strategy",
      selection: "model.defaultTimeAxis",
    });
  });

  it("carries no selection rather than a guess for a path it does not know", () => {
    expect(locateStrategyFinding("somethingElse['x']")).toEqual({ section: "strategy" });
    expect(locateStrategyFinding("")).toEqual({ section: "strategy" });
  });

  it("carries the finding's own severity through", () => {
    const p = strategyProblems([
      { severity: "warning", code: "unreviewed", path: "measures['a']", message: "m" },
    ]);
    expect(p[0].severity).toBe("warning");
  });
});

describe("presentation", () => {
  it("sorts errors above warnings above info", () => {
    const sorted = sortProblems([
      { severity: "info", code: "c", subject: "s", message: "", section: "overview" },
      { severity: "error", code: "a", subject: "s", message: "", section: "overview" },
      { severity: "warning", code: "b", subject: "s", message: "", section: "overview" },
    ]);
    expect(sorted.map((p) => p.severity)).toEqual(["error", "warning", "info"]);
  });

  it("groups by code so twelve of one thing do not bury one of another", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      severity: "warning" as const, code: "no-format-string", subject: `m${i}`,
      message: "", section: "measures" as const,
    }));
    const one = {
      severity: "error" as const, code: "relationship-missing-table", subject: "R",
      message: "", section: "relationships" as const,
    };
    const groups = groupProblems([...many, one]);
    expect(groups).toHaveLength(2);
    // The single ERROR group leads, despite being outnumbered 12 to 1.
    expect(groups[0].code).toBe("relationship-missing-table");
    expect(groups[1].items).toHaveLength(12);
  });

  it("reports the worst severity present", () => {
    expect(worstSeverity([])).toBeNull();
    expect(
      worstSeverity([
        { severity: "warning", code: "a", subject: "", message: "", section: "overview" },
        { severity: "error", code: "b", subject: "", message: "", section: "overview" },
      ]),
    ).toBe("error");
  });

  it("maps the worst severity onto each rail section", () => {
    const map = problemsBySection([
      { severity: "warning", code: "a", subject: "", message: "", section: "tables" },
      { severity: "error", code: "b", subject: "", message: "", section: "tables" },
      { severity: "info", code: "c", subject: "", message: "", section: "measures" },
    ]);
    expect(map.get("tables")).toBe("error");
    expect(map.get("measures")).toBe("info");
    expect(map.has("roles")).toBe(false);
  });
});

describe("coverage is stated, never implied", () => {
  it("says what has NOT been checked", () => {
    // "Problems 0" must never read as "checked and clean" when it means
    // "nothing was checked".
    const text = describeCoverage({ bestPractice: 0, modelBuild: null, strategy: null });
    expect(text).toMatch(/not checked yet/);
    expect(text).toMatch(/strategy not checked/);
  });

  it("distinguishes a passing build from an unknown one", () => {
    expect(describeCoverage({ bestPractice: 0, modelBuild: "ok", strategy: 0 })).toMatch(
      /Model build: OK/,
    );
    expect(describeCoverage({ bestPractice: 0, modelBuild: "failed", strategy: 0 })).toMatch(
      /FAILED/,
    );
  });

  it("pluralises honestly", () => {
    expect(describeCoverage({ bestPractice: 1, modelBuild: "ok", strategy: 1 })).toMatch(
      /1 best-practice finding · 1 strategy finding/,
    );
  });
});
