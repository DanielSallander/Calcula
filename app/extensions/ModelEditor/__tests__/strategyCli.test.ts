// FILENAME: app/extensions/ModelEditor/__tests__/strategyCli.test.ts
// PURPOSE: The Model Editor CLI's strategy verbs — `show/validate/test/infer
//          strategy`, `set measure … direction=…`, `set column … role=…`,
//          `add rule` and `delete rule` — driven through the REAL parser,
//          option schema and executor, with only the backend doubled.
// CONTEXT: Three of these tests exist because of a specific way this class of
//          code fails.
//
//          (1) `infer --apply` REPLACES the stored strategy. Its consent
//          double returns `Promise.resolve(false)`, which is the Tauri shape.
//          A synchronous `false` double is what let six shipped gates pass
//          review while `if (!confirm(m))` was testing `!Promise` — always
//          false — and running as though the user had agreed.
//
//          (2) A refused `set` RESOLVES with `written: false`. The refusal
//          test asserts the run FAILS and that the findings reach the output,
//          because the failure mode is a cheerful "Updated Profit." over a
//          document the backend threw away.
//
//          (3) An unknown option must name the valid keys. That is what makes
//          the strategy vocabulary discoverable at all — there is no other
//          index of it in the panel.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ModelMeasureInfo,
  ModelOverview,
  ModelRelationshipInfo,
  ModelTableInfo,
} from "@api";

vi.mock("../lib/strategyBackend", () => ({
  strategyGet: vi.fn(),
  strategyInfer: vi.fn(),
  strategySuggestions: vi.fn(),
  strategyValidate: vi.fn(),
  strategyRunTests: vi.fn(),
  strategySet: vi.fn(),
  strategyDelete: vi.fn(),
}));

vi.mock("@api/dialogs", () => ({
  confirmAsync: vi.fn(),
  alertAsync: vi.fn(),
  promptAsync: vi.fn(),
}));

import { confirmAsync } from "@api/dialogs";
import {
  strategyGet,
  strategyInfer,
  strategyRunTests,
  strategySet,
  strategyValidate,
} from "../lib/strategyBackend";
import { createSession, executeRun, planRun } from "../cli/execute";
import type { CliIo, CliSession } from "../cli/execute";
import type { CliGateway } from "../cli/gateway";
import type { Finding, StrategyDoc } from "../lib/strategyTypes";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function column(name: string, dataType = "Float64"): ModelTableInfo["columns"][number] {
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

function table(name: string, cols: Array<[string, string]>): ModelTableInfo {
  return {
    name,
    displayName: null,
    description: null,
    isHidden: false,
    storageMode: "InMemory",
    bound: false,
    sourceId: null,
    columns: cols.map(([n, t]) => column(n, t)),
    refreshStrategies: [],
    incrementalRefresh: null,
    transformSteps: [],
    transformScript: "",
    sourceColumns: [],
  };
}

function measure(name: string, formatString: string | null = null): ModelMeasureInfo {
  return {
    name,
    table: "Sales",
    formula: "SUM(Sales[Amount])",
    hasSource: true,
    description: null,
    formatString,
    formatStringExpression: null,
    detailRows: null,
    isHidden: false,
    group: null,
  } as ModelMeasureInfo;
}

const RELATIONSHIP: ModelRelationshipInfo = {
  name: "Sales_Dim",
  fromTable: "Sales",
  toTable: "Dim",
  conditions: [{ fromColumn: "DeptKey", toColumn: "DeptKey" }],
  cardinality: "manyToOne",
  active: true,
  filterPropagation: "auto",
};

function fixtureOverview(): ModelOverview {
  return {
    editable: true,
    readOnlyReason: null,
    tables: [
      table("Sales", [
        ["Id", "Int64"],
        ["Amount", "Float64"],
        ["DeptKey", "Int64"],
      ]),
      table("Dim", [
        ["DeptKey", "Int64"],
        ["Dept", "String"],
      ]),
    ],
    relationships: [RELATIONSHIP],
    hierarchies: [],
    kpis: [],
    securityRoles: [],
    perspectives: [],
    cultures: [],
    calculationGroups: [],
    measures: [measure("Returns"), measure("Profit", "#,0")],
    contexts: [],
    contextColumns: [],
    tableVariables: [],
    globalVariables: [],
    scriptFunctions: [],
    dateTable: null,
    defaultLookupResolution: null,
    modelName: "Test model",
    modelVersion: null,
    modelAuthor: null,
    modelDescription: null,
    sources: [],
    writebackColumns: [],
  };
}

/** Every gateway method resolves with the fixture overview. */
function mockGateway(overview: ModelOverview): CliGateway {
  return new Proxy({} as Record<string, unknown>, {
    get(target, prop: string) {
      if (!(prop in target)) {
        target[prop] = () => Promise.resolve(overview);
      }
      return target[prop];
    },
  }) as unknown as CliGateway;
}

interface Harness {
  session: CliSession;
  io: CliIo;
  lines: string[];
}

function makeHarness(readOnly = false): Harness {
  const overview = fixtureOverview();
  const lines: string[] = [];
  return {
    session: createSession("conn-1", overview, readOnly, mockGateway(overview)),
    io: {
      print: (text: string) => lines.push(text),
      clear: () => lines.splice(0, lines.length),
    },
    lines,
  };
}

async function run(text: string, readOnly = false): Promise<{ ok: boolean; output: string }> {
  const h = makeHarness(readOnly);
  const plan = planRun(text, h.session);
  const outcome = await executeRun(plan, h.session, h.io);
  return { ok: outcome.ok, output: h.lines.join(String.fromCharCode(10)) };
}

const WRITTEN = { written: true, findings: [] as Finding[] };

/**
 * The draft the BACKEND returns from `op: "infer"`.
 *
 * Deliberately unlike anything a frontend heuristic could have produced: Sales
 * is a `bridge`, and `Amount` — a numeric column the deleted TypeScript ladder
 * could not classify at all, because it compared `dataType` against exact
 * strings while the backend sends `Decimal(38, 10)` — comes back as `analysis`.
 * If the CLI ever computes its own draft again, these assertions fail.
 */
function inferredDraft(): StrategyDoc {
  return {
    version: 1,
    measures: {
      Returns: { direction: "lowerIsBetter", unit: "count", reviewed: false, source: "inferred" },
    },
    tables: {
      Sales: {
        kind: "bridge",
        labelColumn: "Amount",
        columns: { Amount: { role: "analysis" } },
        reviewed: false,
        source: "inferred",
      },
    },
  };
}

/** The document handed to `strategySet` by the Nth write. */
function writtenDoc(nth = 0): StrategyDoc {
  return vi.mocked(strategySet).mock.calls[nth][1];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(strategyGet).mockResolvedValue(null);
  vi.mocked(strategyInfer).mockResolvedValue(inferredDraft());
  vi.mocked(strategySet).mockResolvedValue(WRITTEN);
  vi.mocked(strategyValidate).mockResolvedValue({ written: false, findings: [] });
  vi.mocked(strategyRunTests).mockResolvedValue({ written: false, findings: [] });
  vi.mocked(confirmAsync).mockReturnValue(Promise.resolve(true));
});

// ---------------------------------------------------------------------------
// set measure — the strategy half of an existing verb
// ---------------------------------------------------------------------------

describe("set measure … <strategy options>", () => {
  it("round-trips direction=lowerIsBetter into the stored document", async () => {
    const { ok } = await run("set measure [Returns] direction=lowerIsBetter");
    expect(ok).toBe(true);
    expect(strategySet).toHaveBeenCalledTimes(1);
    expect(writtenDoc().measures?.Returns?.direction).toBe("lowerIsBetter");
    // A brand-new entry is NOT silently confirmed: a value a person typed at
    // the command line is still an unreviewed entry until they say otherwise.
    expect(writtenDoc().measures?.Returns?.reviewed).toBe(false);
  });

  it("writes only the strategy when no measure-metadata option is given", async () => {
    const h = makeHarness();
    const upsert = vi.fn().mockResolvedValue(h.session.overview.measures);
    (h.session.gateway as unknown as Record<string, unknown>).upsertMeasure = upsert;
    await executeRun(planRun("set measure [Returns] unit=currency", h.session), h.session, h.io);
    expect(strategySet).toHaveBeenCalledTimes(1);
    // A no-op measure upsert here would spend an undo step saying nothing.
    expect(upsert).not.toHaveBeenCalled();
  });

  it("carries the whole vocabulary the Strategy tab writes", async () => {
    await run(
      "set measure [Returns] direction=targetBand unit=percent target=band:0.8,1.2 " +
        "materiality=2% cadence=quarterly priority=3 analysisdims=Dim[Dept] reviewed=true",
    );
    const entry = writtenDoc().measures?.Returns;
    expect(entry).toEqual({
      direction: "targetBand",
      unit: "percent",
      target: { type: "band", low: 0.8, high: 1.2 },
      // A percentage is a FRACTION on the wire; storing 2 here would call every
      // two-percent movement immaterial by a factor of a hundred.
      materiality: { type: "relative", value: 0.02 },
      cadence: "quarterly",
      priority: 3,
      analysisDimensions: ["Dim[Dept]"],
      reviewed: true,
      // A person typed every one of these at the command line, so the entry
      // must stop claiming a machine guessed it. `source` is what the tab's
      // badge reads to tell an authored row from an inferred one.
      source: "authored",
    });
  });

  it("does not re-author an entry that is only being confirmed", async () => {
    // `reviewed=true` says a human AGREED with the values; it does not say a
    // human WROTE them. Stamping `authored` here would erase the very
    // distinction the Strategy tab exists to show — and un-confirming the row
    // afterwards would then show "authored" about a machine's guess.
    vi.mocked(strategyGet).mockResolvedValue({
      version: 1,
      measures: { Returns: { direction: "higherIsBetter", reviewed: false, source: "inferred" } },
    });
    await run("set measure [Returns] reviewed=true");
    expect(writtenDoc().measures?.Returns).toEqual({
      direction: "higherIsBetter",
      reviewed: true,
      source: "inferred",
    });
  });

  it("round-trips neverslice into neverSliceBy, which inference never fills in", async () => {
    // The inferrer deliberately leaves `neverSliceBy` empty — "never break this
    // down by employee" is a policy, not something a model can be read off. So
    // the only two ways it can ever be set are this verb and the Strategy tab,
    // and a break here silently removes half of them.
    await run("set measure [Returns] neverslice=Sales[Id],Dim[Dept]");
    expect(writtenDoc().measures?.Returns?.neverSliceBy).toEqual(["Sales[Id]", "Dim[Dept]"]);
  });

  it("resolves a bare analysis-dimension name and refuses one the model lacks", async () => {
    await run("set measure [Returns] analysisdims=Dept");
    expect(writtenDoc().measures?.Returns?.analysisDimensions).toEqual(["Dim[Dept]"]);

    const { ok, output } = await run("set measure [Returns] analysisdims=Ghost");
    expect(ok).toBe(false);
    expect(output).toContain("'Ghost' is not a column in this model");
  });

  it("refuses a direction the layer has no meaning for, naming the alternatives", async () => {
    const { ok, output } = await run("set measure [Returns] direction=higherIsBeter");
    expect(ok).toBe(false);
    expect(output).toContain("higherIsBetter");
    expect(strategySet).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// set column
// ---------------------------------------------------------------------------

describe("set column … role= / priority=", () => {
  it("stores a role against the column inside its table", async () => {
    await run("set column Dim[Dept] role=analysis priority=1");
    expect(writtenDoc().tables?.Dim?.columns?.Dept).toEqual({ role: "analysis", priority: 1 });
    // The column map is part of what the TABLE entry says, so classifying a
    // column authors the table entry too — it can no longer claim the whole
    // classification was a machine's.
    expect(writtenDoc().tables?.Dim?.source).toBe("authored");
  });

  it("refuses a priority-only edit on a column that has no entry yet", async () => {
    // `ColumnStrategy.role` has no serde default, so an entry without one
    // would not deserialize on the way back in.
    const { ok, output } = await run("set column Dim[Dept] priority=1");
    expect(ok).toBe(false);
    expect(output).toContain("give role= as well");
    expect(strategySet).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// add rule / delete rule
// ---------------------------------------------------------------------------

describe("add rule / delete rule", () => {
  it("builds a scoped rule from the Column=Member spelling", async () => {
    const { ok } = await run(
      'add rule refunds-dept measure=[Returns] scope="Dept=Refunds,Retail" direction=higherIsBetter note="ERP cutover"',
    );
    expect(ok).toBe(true);
    expect(writtenDoc().rules).toEqual([
      {
        id: "refunds-dept",
        measure: "Returns",
        scope: { "Dim[Dept]": ["Refunds", "Retail"] },
        set: { direction: "higherIsBetter" },
        note: "ERP cutover",
      },
    ]);
  });

  it("refuses a scope column the model does not have", async () => {
    const { ok, output } = await run('add rule r1 measure=[Returns] scope="Deptt=Refunds"');
    expect(ok).toBe(false);
    // A typo here is not a broken rule — it is a rule that silently never
    // fires, which is why it cannot be stored.
    expect(output).toContain("'Deptt' is not a column in this model");
    expect(strategySet).not.toHaveBeenCalled();
  });

  it("refuses a rule on a measure the model does not have", async () => {
    const { ok, output } = await run("add rule r1 measure=[Ghost] direction=neutral");
    expect(ok).toBe(false);
    expect(output).toContain("'Ghost' is not a measure in this model");
  });

  it("deletes by id, and says so when the id is not there", async () => {
    vi.mocked(strategyGet).mockResolvedValue({
      version: 1,
      rules: [{ id: "r1", measure: "Returns", set: { direction: "neutral" } }],
    });
    const kept = await run("delete rule r1");
    expect(kept.ok).toBe(true);
    expect(writtenDoc().rules).toEqual([]);

    const missing = await run("delete rule nope");
    expect(missing.ok).toBe(false);
    expect(missing.output).toContain("has no rule 'nope'");
  });

  it("reports the findings when the backend REFUSES the write", async () => {
    const finding: Finding = {
      severity: "error",
      code: "scope-column-role",
      path: "rules[0].scope",
      message: "'Sales[Id]' has role 'key', so it cannot scope a rule",
    };
    vi.mocked(strategySet).mockResolvedValue({ written: false, findings: [finding] });
    const { ok, output } = await run('add rule r1 measure=[Returns] scope="Dept=Refunds"');
    // A refusal RESOLVES; treating it as success is the defect this pins.
    expect(ok).toBe(false);
    expect(output).toContain("NOTHING was written");
    expect(output).toContain("scope-column-role");
    expect(output).toContain("cannot scope a rule");
    expect(output).not.toContain("Added rule");
  });
});

// ---------------------------------------------------------------------------
// Strict options
// ---------------------------------------------------------------------------

describe("strict option validation", () => {
  it("errors on an unknown option and lists the valid ones", () => {
    const h = makeHarness();
    expect(() => planRun("set measure [Returns] direktion=lowerIsBetter", h.session)).toThrow(
      /Unknown option 'direktion='/,
    );
    expect(() => planRun("set measure [Returns] direktion=lowerIsBetter", h.session)).toThrow(
      /direction=/,
    );
  });

  it("errors on an unknown rule option and lists the rule's own keys", () => {
    const h = makeHarness();
    expect(() => planRun("add rule r1 measur=[Returns]", h.session)).toThrow(
      /Unknown option 'measur='.*measure=.*scope=/s,
    );
  });

  it("says a verb takes no options when it takes none", () => {
    const h = makeHarness();
    expect(() => planRun("test strategy bogus=1", h.session)).toThrow(/takes no options here/);
  });
});

// ---------------------------------------------------------------------------
// show / validate / test — reads
// ---------------------------------------------------------------------------

describe("reading the strategy", () => {
  const doc: StrategyDoc = {
    version: 1,
    measures: { Returns: { direction: "lowerIsBetter", reviewed: true } },
    tables: { Dim: { kind: "dimension", reviewed: false } },
    rules: [
      {
        id: "refunds-dept",
        measure: "Returns",
        scope: { "Dim[Dept]": ["Refunds"] },
        set: { direction: "higherIsBetter" },
      },
    ],
  };

  it("show strategy prints the entries and the rules", async () => {
    vi.mocked(strategyGet).mockResolvedValue(doc);
    const { output } = await run("show strategy");
    expect(output).toContain("Returns");
    expect(output).toContain("lowerIsBetter");
    expect(output).toContain("refunds-dept");
    expect(output).toContain("Dim[Dept]=Refunds");
  });

  it("counts the model block as an entry that can still be a machine's guess", async () => {
    // The Strategy tab gives the model block the same badge every row has.
    // `show strategy` printed its four fields and said nothing about who put
    // them there, and its unreviewed tally counted only measures and tables —
    // so a `defaultTimeAxis` inferred from an UNMARKED calendar read exactly
    // like one a person had chosen.
    vi.mocked(strategyGet).mockResolvedValue({
      ...doc,
      model: { defaultTimeAxis: "Calendar[Date]", reviewed: false },
    });
    const { output } = await run("show strategy");
    expect(output).toContain("model block reviewed: no");
    // Returns is reviewed, Dim is not, and the model block is not: two.
    expect(output).toMatch(/unreviewed entries:\s*2/);
  });

  it("says nothing about a model block that states nothing", async () => {
    // "reviewed: no" against four empty fields reads as an outstanding task
    // where there is none.
    vi.mocked(strategyGet).mockResolvedValue(doc);
    const { output } = await run("show strategy");
    expect(output).not.toContain("model block reviewed");
    expect(output).toMatch(/unreviewed entries:\s*1/);
  });

  it("validate strategy judges the DOCUMENT, not the engine's model checks", async () => {
    vi.mocked(strategyGet).mockResolvedValue(doc);
    vi.mocked(strategyValidate).mockResolvedValue({
      written: false,
      findings: [
        {
          severity: "error",
          code: "unknown-measure",
          path: "rules[0]",
          message: "rule 'refunds-dept' annotates measure 'Gone'",
        },
      ],
    });
    const h = makeHarness();
    const engineValidate = vi.fn().mockResolvedValue([]);
    (h.session.gateway as unknown as Record<string, unknown>).validate = engineValidate;
    await executeRun(planRun("validate strategy", h.session), h.session, h.io);
    expect(strategyValidate).toHaveBeenCalledTimes(1);
    // The verb is kindless, so a `cmd.kind` check here would have fallen
    // through to the engine's own model validation and reported it as clean.
    expect(engineValidate).not.toHaveBeenCalled();
    expect(h.lines.join(" ")).toContain("unknown-measure");
  });

  it("test strategy runs the inline assertions and writes nothing", async () => {
    vi.mocked(strategyGet).mockResolvedValue(doc);
    const { ok, output } = await run("test strategy");
    expect(ok).toBe(true);
    expect(strategyRunTests).toHaveBeenCalledTimes(1);
    expect(strategySet).not.toHaveBeenCalled();
    expect(output).toContain("pass");
  });

  it("test strategy still answers on a read-only model", async () => {
    vi.mocked(strategyGet).mockResolvedValue(doc);
    // A subscriber of a distributed report cannot change the strategy, but
    // must still be able to ask why it calls a rise bad.
    const { ok } = await run("test strategy", true);
    expect(ok).toBe(true);
    expect(strategyRunTests).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// infer strategy
// ---------------------------------------------------------------------------

describe("infer strategy", () => {
  it("previews without --apply and never asks, because it writes nothing", async () => {
    const { ok, output } = await run("infer strategy");
    expect(ok).toBe(true);
    expect(confirmAsync).not.toHaveBeenCalled();
    expect(strategySet).not.toHaveBeenCalled();
    expect(output).toContain("Nothing was written");
    expect(output).toContain("UNREVIEWED");
  });

  it("prints the draft the BACKEND inferred rather than a second opinion of its own", async () => {
    const { ok, output } = await run("infer strategy");
    expect(ok).toBe(true);
    expect(strategyInfer).toHaveBeenCalledWith("conn-1");
    // Sales is the from-side of the only relationship, so any frontend
    // heuristic worth the name would call it a fact. The backend called it a
    // bridge, and the backend is the one inference.
    expect(output).toContain("bridge");
    expect(output).toContain("lowerIsBetter");
  });

  it("--apply ASKS first and does nothing when the answer is no", async () => {
    // The Tauri shape: confirmAsync resolves to false. A synchronous `false`
    // double would pass even if the code never awaited the answer.
    vi.mocked(confirmAsync).mockReturnValue(Promise.resolve(false));
    const { ok, output } = await run("infer strategy --apply");
    expect(confirmAsync).toHaveBeenCalledTimes(1);
    expect(strategySet).not.toHaveBeenCalled();
    expect(ok).toBe(true);
    expect(output).toContain("Cancelled");
  });

  it("--apply writes the backend's draft through unchanged when the answer is yes", async () => {
    vi.mocked(confirmAsync).mockReturnValue(Promise.resolve(true));
    const { ok } = await run("infer strategy --apply");
    expect(ok).toBe(true);
    expect(strategySet).toHaveBeenCalledTimes(1);
    // Byte for byte what `op: "infer"` returned. The CLI is a courier here: it
    // does not re-classify, re-order or "improve" the draft on the way past,
    // because a second opinion applied silently is how the two generators
    // disagreed in the first place.
    expect(writtenDoc()).toEqual(inferredDraft());
    // Inference is a draft, not an answer — and it stays one on the way in.
    expect(writtenDoc().measures?.Returns?.reviewed).toBe(false);
    expect(Object.values(writtenDoc().tables ?? {}).every((t) => !t.reviewed)).toBe(true);
  });

  it("refuses an argument that is not --apply rather than reading it as a preview", async () => {
    const h = makeHarness();
    expect(() => planRun("infer strategy -aply", h.session)).toThrow(/Unknown argument '-aply'/);
  });
});
