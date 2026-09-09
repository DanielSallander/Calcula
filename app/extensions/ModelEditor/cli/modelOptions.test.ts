// FILENAME: app/extensions/ModelEditor/cli/modelOptions.test.ts
// PURPOSE: Proves the MODEL domain's strict option schema (modelOptions.ts)
//          matches what writers.ts actually reads: for EVERY kind+verb entry
//          in the tables a representative command carrying its full option
//          set plans WITHOUT an unknown-option error; unknown keys throw a
//          CliError naming the valid keys; `format=` empty assignment still
//          clears; a repeatable option (filter=) is accepted twice. The
//          mock-gateway session pattern is replicated from cli.test.ts
//          (which stays untouched).

import { describe, expect, it } from "vitest";
import type {
  ModelMeasureInfo,
  ModelOverview,
  ModelRelationshipInfo,
  ModelTableInfo,
  TransformStepDto,
} from "@api";
import { parseScript, usedOptKeys } from "./parse";
import type { Kind } from "./parse";
import { createSession, executeRun, planRun } from "./execute";
import type { CliIo, CliSession } from "./execute";
import type { CliGateway } from "./gateway";
import { createModelDomain } from "./modelDomain";
import {
  MODEL_KINDLESS_OPTIONS,
  MODEL_OPTION_TABLES,
  modelOptionSpecsFor,
} from "./modelOptions";

// ---------------------------------------------------------------------------
// Fixtures (cli.test.ts's fixture, extended with one object of EVERY kind so
// set/rename/delete targets resolve at plan time)
// ---------------------------------------------------------------------------

function table(
  name: string,
  cols: string[],
  calc: string[] = [],
  opts: { bound?: boolean; sourceId?: string | null; transformSteps?: TransformStepDto[] } = {},
): ModelTableInfo {
  return {
    name,
    displayName: null,
    description: null,
    isHidden: false,
    storageMode: "InMemory",
    bound: opts.bound ?? false,
    sourceId: opts.sourceId ?? null,
    transformSteps: opts.transformSteps ?? [],
    sourceColumns: [],
    columns: [
      ...cols.map((c) => ({
        name: c,
        dataType: "Float64",
        displayName: null,
        description: null,
        isHidden: false,
        isCalculated: false,
        isDynamic: false,
        formula: null,
        lookupResolution: null,
        sortByColumn: null,
        formatString: null,
      })),
      ...calc.map((c) => ({
        name: c,
        dataType: "Float64",
        displayName: null,
        description: null,
        isHidden: false,
        isCalculated: true,
        isDynamic: false,
        formula: "1+1",
        lookupResolution: null,
        sortByColumn: null,
        formatString: null,
      })),
    ],
    refreshStrategies: [],
    incrementalRefresh: null,
  };
}

function rel(name: string, from: string, fromCol: string, to: string, toCol: string): ModelRelationshipInfo {
  return {
    name,
    fromTable: from,
    toTable: to,
    conditions: [{ fromColumn: fromCol, toColumn: toCol, operator: "=" }],
    cardinality: "manyToOne",
    active: true,
    filterPropagation: "auto",
  };
}

function measure(name: string, format: string | null = null): ModelMeasureInfo {
  return {
    name,
    table: "Sales",
    formula: "SUM(Sales[Amount])",
    hasSource: true,
    description: null,
    formatString: format,
    formatStringExpression: null,
    detailRows: null,
    isHidden: false,
    group: null,
  };
}

function fixtureOverview(): ModelOverview {
  return {
    editable: true,
    readOnlyReason: null,
    tables: [
      table("Sales", ["Id", "Amount", "CustomerId", "Region"], ["Margin"]),
      table("Customer", ["Id", "Name"]),
      table("Orders", ["Id", "CustomerId"]),
      // Source-bound WITH a pipeline: the only shape `transform` accepts. The
      // binding that matters is `sourceId` — a pipeline lives on it.
      table("Web", ["Id", "Status", "Qty"], [], {
        bound: true,
        sourceId: "11111111-2222-3333-4444-555555555555",
        transformSteps: [
          // Step 1 is renameable (it introduces an output name); step 2 is not
          // — both shapes the `transform … rename` row exercises.
          { type: "renameColumns", renames: [{ from: "amount", to: "net" }] },
          { type: "filterRows", condition: "1 = 1" },
        ],
      }),
    ],
    relationships: [rel("Sales_Customer", "Sales", "CustomerId", "Customer", "Id")],
    hierarchies: [{ name: "Geo", table: "Customer", levels: [{ column: "Name" }] }],
    kpis: [
      {
        name: "Goal",
        baseMeasure: "[Total Sales]",
        targetMeasure: null,
        targetConstant: 100,
        statusBands: [],
        description: null,
      },
    ],
    securityRoles: [{ name: "Regional", filters: [], deniedTables: [], deniedColumns: [] }],
    perspectives: [{ name: "P1", tables: [], columns: [], measures: [], description: null }],
    cultures: [{ locale: "sv-SE", tables: [], columns: [], measures: [] }],
    calculationGroups: [{ name: "TimeCalc", items: [{ name: "YTD", formula: "1" }] }],
    measures: [measure("Total Sales"), measure("Profit", "#,0")],
    contexts: [{ name: "ctx1", expression: "KEEP(Sales)", operations: [] }],
    contextColumns: [
      { name: "Share", table: "Sales", expression: "x", dataType: "Float64", description: null },
    ],
    tableVariables: [{ name: "WestSales", source: "Sales", filters: [] }],
    globalVariables: [
      { name: "Top10", table: "Sales", expression: "QUERY(Sales)", isQuery: true, dynamic: true },
    ],
    scriptFunctions: [{ name: "Clamp", params: [], returnType: "Float", body: "x" }],
    dateTable: null,
    defaultLookupResolution: null,
    modelName: "Test model",
    modelVersion: null,
    modelAuthor: null,
    modelDescription: null,
    sources: [
      {
        id: "src-1",
        kind: "postgres",
        displayName: "Warehouse",
        host: "db.local",
        port: 5432,
        database: "dw",
        defaultSchema: null,
        preferredAuth: "integrated",
        sslMode: null,
        tableCount: 0,
      },
    ],
    writebackColumns: [
      {
        id: "wb-1",
        name: "Forecast",
        table: "Sales",
        dataType: "Float64",
        keyColumns: ["Id"],
        kind: "history",
        projectionMode: "blank",
        projectionExpression: null,
        required: false,
        min: null,
        max: null,
        enumValues: [],
        maxLength: null,
        pattern: null,
        allowedEditors: [],
        exposeHistory: false,
        historyTable: "Forecast_History",
      },
    ],
  };
}

interface MockCalls {
  gateway: CliGateway;
  calls: Record<string, unknown[][]>;
}

/** A gateway whose mutations succeed and return the (unchanged) fixture. */
function mockGateway(overview: ModelOverview): MockCalls {
  const calls: Record<string, unknown[][]> = {};
  const record =
    (name: string, result: unknown) =>
    (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
      return Promise.resolve(result);
    };
  const gateway = new Proxy({} as Record<string, unknown>, {
    get(target, prop: string) {
      if (!(prop in target)) {
        const result =
          prop === "upsertMeasure" || prop === "deleteMeasure"
            ? overview.measures
            : prop === "batchBegin" || prop === "batchEnd" || prop === "refreshTable"
              ? undefined
              : overview;
        target[prop] = record(prop, result);
      }
      return target[prop];
    },
  }) as unknown as CliGateway;
  return { gateway, calls };
}

function collectIo(): { io: CliIo; lines: Array<{ cls: string; text: string }> } {
  const lines: Array<{ cls: string; text: string }> = [];
  return {
    io: {
      print: (text, cls) => lines.push({ cls: cls ?? "out", text }),
      clear: () => lines.splice(0, lines.length),
    },
    lines,
  };
}

function makeSession(): { session: CliSession; calls: Record<string, unknown[][]> } {
  const overview = fixtureOverview();
  const { gateway, calls } = mockGateway(overview);
  return { session: createSession("conn-1", overview, false, gateway), calls };
}

async function runText(
  text: string,
): Promise<{ calls: Record<string, unknown[][]>; lines: Array<{ cls: string; text: string }>; ok: boolean }> {
  const { session, calls } = makeSession();
  const { io, lines } = collectIo();
  const plan = planRun(text, session);
  const outcome = await executeRun(plan, session, io);
  return { calls, lines, ok: outcome.ok };
}

// ---------------------------------------------------------------------------
// The representative-command matrix: one row per kind+verb entry in the
// option tables, each carrying EVERY option key its spec row declares
// (asserted mechanically below, so the matrix can never rot).
// ---------------------------------------------------------------------------

const MATRIX: Array<[kind: string, verb: string, cmd: string]> = [
  ["measure", "add", 'add measure [M2] format="0.0%" formatexpr="fx" folder="KPIs" hidden=true description="d" detailrows=Sales[Id] = 1'],
  // `set measure` addresses the measure AND its strategy entry — writers.ts
  // routes per KEY, so this row carries both halves.
  ["measure", "set", 'set measure [Profit] format="0.0%" formatexpr="fx" folder="KPIs" hidden=true description="d" detailrows=Sales[Id] direction=lowerIsBetter unit=currency target=1000 materiality=2% cadence=monthly priority=1 analysisdims=Sales[Region] neverslice=Sales[Id] reviewed=true'],
  ["measure", "rename", "rename measure [Profit] [P2]"],
  ["measure", "delete", "delete measure [Profit]"],
  // `set table` addresses the table AND its strategy entry — writers.ts routes
  // per KEY (`TABLE_STRATEGY_KEYS`), so this row carries both halves, the same
  // way the `set measure` row above does.
  ["table", "set", 'set table Sales displayname="S" description="d" hidden=false storage=InMemory refresh=interval:300 incremental="inc" source=Warehouse schema=public sourcetable=orders kind=fact labelcolumn=Region reviewed=true'],
  ["table", "rename", "rename table Sales S2"],
  ["table", "delete", "delete table Orders"],
  ["table", "refresh", "refresh table Sales"],
  ["table", "import", "import tables public.orders schema=public"],
  ["column", "add", 'add column Sales[NewCol] type=Int64 description="d" = 1'],
  ["column", "set", 'set column Sales[Amount] type=Float64 description="d" hidden=true format="#,0" displayname="A" sortby=Id lookup="lk" role=analysis priority=2'],
  ["column", "rename", "rename column Sales[Margin] [M2]"],
  ["column", "delete", "delete column Sales[Margin]"],
  ["relationship", "add", 'add relationship Sales[CustomerId] -> Customer[Id] cardinality=m:1 active=true propagation=auto name="R1" ops=eq'],
  ["relationship", "set", "set relationship Sales_Customer cardinality=1:1 active=false propagation=both"],
  ["relationship", "rename", "rename relationship Sales_Customer R2"],
  ["relationship", "delete", "delete relationship Sales_Customer"],
  ["hierarchy", "add", "add hierarchy Geo2 table=Customer levels=Name,Id"],
  ["hierarchy", "set", "set hierarchy Geo table=Customer levels=Name"],
  ["hierarchy", "rename", "rename hierarchy Geo Geo2"],
  ["hierarchy", "delete", "delete hierarchy Geo"],
  ["kpi", "add", 'add kpi G2 base=[Profit] target=[Total Sales] targetvalue=10 bands=0:offTrack description="d"'],
  ["kpi", "set", 'set kpi Goal base=[Profit] target=[Total Sales] targetvalue=5 bands=0:onTrack description="d"'],
  ["kpi", "rename", "rename kpi Goal G2"],
  ["kpi", "delete", "delete kpi Goal"],
  ["role", "add", "add role R2 filter=\"Sales[Region] = 'West'\" deny=Secret"],
  ["role", "set", "set role Regional filter=\"Sales[Region] = 'East'\" deny=HR[SSN]"],
  ["role", "rename", "rename role Regional R2"],
  ["role", "delete", "delete role Regional"],
  ["perspective", "add", 'add perspective P2 tables=Sales columns=Sales[Amount] measures=[Profit] description="d"'],
  ["perspective", "set", 'set perspective P1 tables=Sales columns=Sales[Amount] measures=[Profit] description="d"'],
  ["perspective", "rename", "rename perspective P1 P2"],
  ["perspective", "delete", "delete perspective P1"],
  ["culture", "add", "add culture en-US"],
  ["culture", "rename", "rename culture sv-SE sv"],
  ["culture", "delete", "delete culture sv-SE"],
  ["translation", "set", 'set translation sv-SE table Sales caption="Fsg" description="d"'],
  ["translation", "delete", "delete translation sv-SE table Sales"],
  ["calcgroup", "add", "add calcgroup CG2"],
  ["calcgroup", "rename", "rename calcgroup TimeCalc TC"],
  ["calcgroup", "delete", "delete calcgroup TimeCalc"],
  ["calcitem", "add", "add calcitem TimeCalc[MTD] = 1"],
  ["calcitem", "set", "set calcitem TimeCalc[YTD] = 2"],
  ["calcitem", "rename", "rename calcitem TimeCalc[YTD] [Y2]"],
  ["calcitem", "delete", "delete calcitem TimeCalc[YTD]"],
  ["calctable", "add", "add calctable CT2 dynamic=false table=Sales cascade=true = QUERY(Sales)"],
  ["calctable", "set", "set calctable Top10 dynamic=true table=Sales cascade=true"],
  ["calctable", "rename", "rename calctable Top10 T2 cascade=true"],
  ["calctable", "delete", "delete calctable Top10 cascade=true"],
  ["calctable", "materialize", "materialize calctable Top10"],
  ["tablevar", "add", "add tablevar TV source=Sales filter=\"Sales[Region] = 'West'\""],
  ["tablevar", "set", "set tablevar WestSales source=Sales filter=\"Sales[Region] = 'East'\""],
  ["tablevar", "rename", "rename tablevar WestSales WS"],
  ["tablevar", "delete", "delete tablevar WestSales"],
  ["scriptfunction", "add", "add func F2 params=x:Float,y:Int returns=Float = x"],
  ["scriptfunction", "set", "set func Clamp params=x:Int returns=Int"],
  ["scriptfunction", "rename", "rename func Clamp C2"],
  ["scriptfunction", "delete", "delete func Clamp"],
  ["context", "add", "add context C2 = KEEP(Sales)"],
  ["context", "set", "set context ctx1 = KEEP(Sales)"],
  ["context", "rename", "rename context ctx1 C2"],
  ["context", "delete", "delete context ctx1"],
  ["contextcolumn", "delete", "delete contextcolumn Share"],
  ["writeback", "add", 'add writeback Sales[WB] type=Float64 keys=Id kind=history projection=blank projexpr="p" required=true min=0 max=10 enum=a,b maxlength=5 pattern="abc" editors=u1 history=true'],
  ["writeback", "set", 'set writeback Forecast name=F2 type=Float64 keys=Id kind=masterData projection=latest projexpr="p" required=false min=1 max=2 enum=a maxlength=3 pattern="abc" editors=u1 history=false'],
  ["writeback", "rename", "rename writeback Forecast F2"],
  ["writeback", "delete", "delete writeback Forecast"],
  ["source", "add", "add source S2 kind=postgres host=h port=5432 database=db schema=public auth=integrated ssl=require trustcert=true"],
  ["source", "set", 'set source Warehouse kind=postgres host=h port=1 database=db schema=s auth=integrated ssl=require trustcert=false name="W2"'],
  ["source", "rename", "rename source Warehouse W2"],
  ["source", "delete", "delete source Warehouse"],
  ["source", "connect", 'connect source Warehouse connstr="host=h user=u"'],
  ["model", "set", 'set model name="M" version="1" author="a" description="d" datetable=Sales lookup="lk"'],
  ["extdata", "set", 'set extdata acme.meta = {"a": 1}'],
  ["extdata", "delete", "delete extdata acme.meta"],
  ["sql", "import", "import sql BigCustomers = SELECT 1"],
  // The insights strategy layer. `test`/`infer` take no options; `add rule`
  // carries the whole AttributeSet a rule may set.
  ["strategy", "test", "test strategy"],
  ["strategy", "infer", "infer strategy --apply"],
  // `suppress=` carries a REAL kind. It said `outlier` — the spelling the old
  // free-text field's own doc offered as an example and that nothing has ever
  // emitted — which `MODEL_CLOSED_VALUE_LISTS` now correctly refuses at plan
  // time. The matrix row has to be a command that plans, so it names a kind the
  // engine can actually withhold.
  ["rule", "add", 'add rule r1 measure=[Profit] scope="Sales[Region]=West" direction=lowerIsBetter target=kpi materiality=2% cadence=monthly suppress=seasonality rankweight=2 note="n"'],
  ["rule", "delete", "delete rule r1"],
];

// `transform table` is the ONE verb whose options are not a single flat set a
// single command can carry: the accepted keys depend on the step type being
// added, and transformSteps.ts refuses a key that means nothing to that step.
// So its audit runs over a GROUP of commands whose union must equal the spec
// row exactly — the same teeth (nothing declared that no command uses, nothing
// used that is not declared), one row per legal shape instead of one row.
/** Canonical spellings — the option keys the engine's renderer emits, which
 *  are the ones completion offers and help documents. */
const TRANSFORM_MATRIX: string[] = [
  "transform table Web add removeColumns columns=Notes at=1",
  "transform table Web add selectColumns columns=Id,Status",
  "transform table Web add renameColumns rename=Status:OrderStatus",
  "transform table Web add changeType cast=Qty:Int64 onError=null",
  "transform table Web add addColumn name=Margin dataType=Float64 = [Qty] * 2",
  'transform table Web add splitColumn column=Status delimiter="-" parts=2 keepOriginal=true',
  'transform table Web add replaceValues column=Status find="a" replace="b" matchEntireValue=true',
  "transform table Web add textTransform columns=Status operation=trim",
  "transform table Web add fillDown columns=Status",
  "transform table Web add removeDuplicates",
  "transform table Web add sort by=Qty,-Id",
  "transform table Web add groupBy groupBy=Status agg=Sum:Qty:Total",
  'transform table Web add groupBy groupBy=Status aggFormula=Sum:"IF([Qty] > 1, [Qty], BLANK())":Big',
  "transform table Web add keepRows range=first:10",
  "transform table Web add removeRows range=range:0:5",
  "transform table Web add unpivot columns=Jan,Feb nameColumn=Month valueColumn=Amount",
  "transform table Web add pivot nameColumn=Month valueColumn=Amount aggregate=Sum valueNames=Jan,Feb",
  "transform table Web add lookupColumn table=Customers on=Id:CustomerId take=Name take=Tier:CustomerTier",
  "transform table Web remove 2",
  "transform table Web move 2 1",
  "transform table Web rename 1 Kept",
  "transform table Web clear",
];

/** The spellings the command line shipped with, before the grammar moved into
 *  the engine. Validation must not be STRICTER than the parser that runs the
 *  command — the engine resolves option keys case-insensitively and still
 *  understands the single-rename and single-cast shapes, so a script written
 *  against the old surface has to keep planning. */
const TRANSFORM_LEGACY_MATRIX: string[] = [
  "transform table Web add renameColumn column=Status newname=OrderStatus",
  "transform table Web add changeType column=Qty type=Int64 onerror=null",
  'transform table Web add splitColumn column=Status delimiter="-" parts=2 keeporiginal=true',
  'transform table Web add replaceValues column=Status find="a" replace="b" matchentire=true',
  "transform table Web add groupBy groupby=Status agg=sum:Qty:Total",
  "transform table Web add unpivot columns=Jan,Feb namecolumn=Month valuecolumn=Amount",
  "transform table Web add pivot namecolumn=Month valuecolumn=Amount aggregate=sum values=Jan,Feb",
];

describe("model option schema — table/matrix integrity", () => {
  it("the matrix covers every kind+verb entry in the option tables", () => {
    const covered = new Set(MATRIX.map(([kind, verb]) => `${kind}:${verb}`));
    for (const text of TRANSFORM_MATRIX) {
      const cmd = parseScript(text)[0];
      covered.add(`${cmd.kind}:${cmd.verb}`);
    }
    for (const [kind, verbTable] of Object.entries(MODEL_OPTION_TABLES)) {
      for (const verb of Object.keys(verbTable)) {
        expect(covered.has(`${kind}:${verb}`), `no matrix row for '${verb} ${kind}'`).toBe(true);
      }
    }
    expect(Object.keys(MODEL_KINDLESS_OPTIONS)).toEqual([]);
  });

  it.each(MATRIX)("'%s %s' carries exactly its spec row's option keys", (kind, verb, text) => {
    const cmd = parseScript(text)[0];
    expect(cmd.verb).toBe(verb);
    expect(cmd.kind).toBe(kind);
    const specs = MODEL_OPTION_TABLES[kind as Kind]?.[verb] ?? [];
    // Lowercased on both sides: the lexer lowercases what the user typed, and
    // validation matches case-insensitively, so a spec key spelled in the
    // engine's canonical camelCase is the same option.
    expect([...usedOptKeys(cmd)].map((k) => k.toLowerCase()).sort()).toEqual(
      specs.map((s) => s.key.toLowerCase()).sort(),
    );
  });

  it.each(TRANSFORM_LEGACY_MATRIX)("still plans the shipped spelling '%s'", (text) => {
    const { session } = makeSession();
    expect(() => planRun(text, session)).not.toThrow();
  });

  it("every legacy spelling is an alias of a canonical option, never a stray", () => {
    // Guards the aliases themselves: an alias that matches no canonical key
    // would let validation accept a key the engine then refuses.
    // Everything is compared lowercased, because validation is
    // case-insensitive: a key that differs only in case is the SAME option,
    // not a legacy spelling.
    const specs = MODEL_OPTION_TABLES.table?.transform ?? [];
    const canonical = new Set(specs.map((s) => s.key.toLowerCase()));
    for (const spec of specs) {
      for (const alias of spec.aliases ?? []) {
        expect(
          canonical.has(alias.toLowerCase()),
          `'${alias}' only differs in case from a canonical key, so it is not an alias`,
        ).toBe(false);
      }
    }
    const aliases = new Set(specs.flatMap((s) => s.aliases ?? []).map((a) => a.toLowerCase()));
    const usedLegacy = new Set<string>();
    for (const text of TRANSFORM_LEGACY_MATRIX) {
      for (const key of usedOptKeys(parseScript(text)[0])) {
        if (!canonical.has(key.toLowerCase())) usedLegacy.add(key.toLowerCase());
      }
    }
    expect(usedLegacy.size).toBeGreaterThan(0);
    for (const key of usedLegacy) {
      expect(aliases.has(key), `'${key}=' is planned but declared nowhere`).toBe(true);
    }
  });

  it("the transform group's option keys are exactly the 'transform table' spec row", () => {
    const used = new Set<string>();
    for (const text of TRANSFORM_MATRIX) {
      const cmd = parseScript(text)[0];
      expect(cmd.verb).toBe("transform");
      expect(cmd.kind).toBe("table");
      for (const key of usedOptKeys(cmd)) used.add(key);
    }
    const specs = MODEL_OPTION_TABLES.table?.transform ?? [];
    expect([...used].map((k) => k.toLowerCase()).sort()).toEqual(
      specs.map((s) => s.key.toLowerCase()).sort(),
    );
  });
});

describe("model option schema — strict planning", () => {
  it.each(MATRIX)("plans '%s %s' without an unknown-option error", (_kind, _verb, text) => {
    const { session } = makeSession();
    expect(() => planRun(text, session)).not.toThrow();
  });

  it.each(TRANSFORM_MATRIX)("plans '%s' without an option error", (text) => {
    const { session } = makeSession();
    expect(() => planRun(text, session)).not.toThrow();
  });

  it("rejects an unknown option, naming the valid keys", () => {
    const { session } = makeSession();
    expect(() => planRun("set measure [Profit] bogus=1", session)).toThrow(/Unknown option 'bogus='/);
    expect(() => planRun("set measure [Profit] bogus=1", session)).toThrow(/format=/);
  });

  it("a supported verb that takes no options says so", () => {
    const { session } = makeSession();
    expect(() => planRun("delete measure [Profit] hidden=true", session)).toThrow(
      /takes no options here/,
    );
  });

  it("kind-null commands validate against the empty kindless table", () => {
    const { session } = makeSession();
    expect(() => planRun("refresh bogus=1", session)).toThrow(/takes no options here/);
  });

  it("runWrite validates too, not only preview", async () => {
    const { session } = makeSession();
    const domain = createModelDomain();
    const { io } = collectIo();
    const cmd = parseScript("set measure [Profit] bogus=1")[0];
    await expect(domain.runWrite(cmd, session, io)).rejects.toThrow(/Unknown option 'bogus='/);
  });
});

describe("model option schema — accepted value shapes still work", () => {
  it("format= empty assignment still clears the format", async () => {
    const { calls, ok } = await runText("set measure [Profit] format=");
    expect(ok).toBe(true);
    const arg = calls.upsertMeasure[0][0] as Record<string, unknown>;
    expect(arg.formatString).toBeNull(); // fixture had "#,0" — cleared
  });

  it("a repeatable option (filter=) is accepted twice", async () => {
    const { calls, ok } = await runText(
      "add role R2 filter=\"Sales[Region] = 'West'\" filter=\"Sales[Owner] = @username\"",
    );
    expect(ok).toBe(true);
    const arg = calls.upsertRole[0][0] as { filters: unknown[] };
    expect(arg.filters).toHaveLength(2);
  });
});

describe("completion derivation (replaces the OPTION_KEYS mirror)", () => {
  it("resolves verb aliases and per-verb rows", () => {
    expect(modelOptionSpecsFor("create", "measure").map((s) => s.key)).toContain("format");
    expect(modelOptionSpecsFor("set", "writeback").map((s) => s.key)).toContain("name");
    expect(modelOptionSpecsFor("connect", "source").map((s) => s.key)).toEqual(["connstr"]);
    expect(modelOptionSpecsFor("rename", "measure")).toEqual([]);
    expect(modelOptionSpecsFor("ls", "measure")).toEqual([]);
    expect(modelOptionSpecsFor("nonsense", "measure")).toEqual([]);
  });
});
