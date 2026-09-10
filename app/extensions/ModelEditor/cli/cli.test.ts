// FILENAME: app/extensions/ModelEditor/cli/cli.test.ts
// PURPOSE: Unit tests for the Model Editor command line: lexer/parser shapes,
//          glob resolution, and executor behavior over a mock gateway
//          (wildcard fan-out, batch begin/end, all-or-nothing rollback,
//          read-modify-write carry semantics, read-only guard).

import { describe, expect, it, vi } from "vitest";
import type {
  ModelMeasureInfo,
  ModelOverview,
  ModelRelationshipInfo,
  ModelTableInfo,
  TransformStepDto,
} from "@api";
import { lexLine, logicalLines } from "./lex";
import { parseCommand, parseScript, optStr } from "./parse";
import { globMatch, matchRelationships } from "./resolve";
import { createSession, executeRun, planRun } from "./execute";
import type { CliIo } from "./execute";
import type { CliGateway } from "./gateway";
import {
  TRANSFORM_STEP_OPTIONS,
  TRANSFORM_STEP_TYPES,
} from "./transformSteps";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface TableOpts {
  bound?: boolean;
  /** The PERSISTED source binding a pipeline lives on. `bound` is looser. */
  sourceId?: string | null;
  transformSteps?: TransformStepDto[];
  /** The pipeline as the ENGINE renders it. Supplied literally here because
   *  the renderer lives in Rust: these fixtures stand in for what the backend
   *  sends, and a hand-written re-implementation of it in this file would be
   *  the exact second source of truth the feature removed. */
  transformScript?: string;
}

function table(
  name: string,
  cols: string[],
  calc: string[] = [],
  opts: TableOpts = {},
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
    transformScript: opts.transformScript ?? "",
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

function measure(name: string, group: string | null = null): ModelMeasureInfo {
  return {
    name,
    table: "Sales",
    formula: "SUM(Sales[Amount])",
    hasSource: true,
    description: null,
    formatString: null,
    formatStringExpression: null,
    detailRows: null,
    isHidden: false,
    group,
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
      // A source-bound table WITH a pipeline: the `transform` verb's subject.
      // It carries a real `sourceId` because that — not the looser `bound` —
      // is what a pipeline hangs off.
      table("Web", ["Id", "Status", "Qty", "Notes", "amount"], [], {
        bound: true,
        sourceId: "11111111-2222-3333-4444-555555555555",
        transformSteps: [
          { type: "removeColumns", columns: ["Notes"] },
          { type: "renameColumns", renames: [{ from: "amount", to: "net" }] },
          { type: "filterRows", condition: '[Status] <> "Cancelled"' },
        ],
        transformScript: [
          "removeColumns columns=Notes",
          "",
          "renameColumns rename=amount:net",
          "",
          'filterRows = [Status] <> "Cancelled"',
        ].join("\n"),
      }),
    ],
    relationships: [
      rel("Sales_Customer", "Sales", "CustomerId", "Customer", "Id"),
      rel("Orders_Customer", "Orders", "CustomerId", "Customer", "Id"),
    ],
    hierarchies: [],
    kpis: [],
    securityRoles: [],
    perspectives: [],
    cultures: [],
    calculationGroups: [{ name: "TimeCalc", items: [{ name: "YTD", formula: "1" }] }],
    measures: [measure("Total Sales"), measure("Profit"), measure("tmp calc", "Scratch")],
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

interface MockCalls {
  gateway: CliGateway;
  calls: Record<string, unknown[][]>;
}

/** A gateway whose mutations succeed and return the (unchanged) fixture. */
function mockGateway(overview: ModelOverview, overrides: Partial<CliGateway> = {}): MockCalls {
  const calls: Record<string, unknown[][]> = {};
  const record =
    (name: string, result: unknown) =>
    (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
      return Promise.resolve(result);
    };
  const gateway = new Proxy({} as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop in overrides) return (overrides as Record<string, unknown>)[prop];
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

async function runText(
  text: string,
  overview = fixtureOverview(),
  overrides: Partial<CliGateway> = {},
  readOnly = false,
): Promise<{ calls: Record<string, unknown[][]>; lines: Array<{ cls: string; text: string }>; ok: boolean }> {
  const { gateway, calls } = mockGateway(overview, overrides);
  const session = createSession("conn-1", overview, readOnly, gateway);
  const { io, lines } = collectIo();
  const plan = planRun(text, session);
  const outcome = await executeRun(plan, session, io);
  return { calls, lines, ok: outcome.ok };
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

describe("logicalLines", () => {
  it("drops comments and blanks, joins indented continuations", () => {
    const src = [
      "# a comment",
      "add measure [M] =",
      "    VAR x = 1",
      "    RETURN x",
      "",
      "// another comment",
      "ls tables",
    ].join("\n");
    const lines = logicalLines(src);
    expect(lines).toHaveLength(2);
    expect(lines[0].line).toBe(2);
    expect(lines[0].text).toContain("RETURN x");
    expect(lines[1].text).toBe("ls tables");
    expect(lines[1].line).toBe(7);
  });
});

describe("lexLine", () => {
  it("captures the raw tail after a free-standing =", () => {
    const { tokens, expr } = lexLine('add measure [Margin %] = DIVIDE([P], [R]) # not a comment');
    expect(tokens.map((t) => t.kind)).toEqual(["word", "word", "bracket"]);
    expect(expr).toBe("DIVIDE([P], [R]) # not a comment");
  });

  it("distinguishes attached option = from the formula =", () => {
    const { tokens, expr } = lexLine('set measure [A] folder="Sales\\Core" hidden=true');
    expect(expr).toBeNull();
    const kinds = tokens.map((t) => t.kind);
    expect(kinds).toContain("eqAttached");
    expect(kinds.filter((k) => k === "eqAttached")).toHaveLength(2);
  });

  it("lexes Table[Column] and quoted-table refs as colrefs", () => {
    const { tokens } = lexLine('ls columns "Dim Customer"[Full Name] Sales[Id]');
    const colrefs = tokens.filter((t) => t.kind === "colref");
    expect(colrefs).toHaveLength(2);
    expect(colrefs[0]).toMatchObject({ table: "Dim Customer", column: "Full Name" });
    expect(colrefs[1]).toMatchObject({ table: "Sales", column: "Id" });
  });

  it("lexes -> as an arrow, also when glued", () => {
    const { tokens } = lexLine("delete relationship Sales[CustomerId]->Customer[Id]");
    expect(tokens.some((t) => t.kind === "arrow")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

describe("parseCommand", () => {
  it("normalizes verb and kind aliases", () => {
    const cmd = parseCommand({ text: "rm rels Sales_Customer", line: 1 });
    expect(cmd.verb).toBe("delete");
    expect(cmd.kind).toBe("relationship");
    expect(cmd.pos[0].text).toBe("Sales_Customer");
  });

  it("collects repeated options and comma lists", () => {
    const cmd = parseCommand({
      text: 'add role R filter="Sales[Region] = \'West\'" filter="T[U] = @username" deny=Secret',
      line: 1,
    });
    expect(cmd.opts.get("filter")).toHaveLength(2);
    expect(optStr(cmd, "deny")).toBe("Secret");
  });

  it("supports 'rename … to …'", () => {
    const cmd = parseCommand({ text: "rename measure [Old] to [New]", line: 1 });
    expect(cmd.pos.map((t) => t.text)).toEqual(["Old", "New"]);
  });

  it("splits endpoints across ->", () => {
    const cmd = parseCommand({ text: "delete relationship * -> Customer", line: 1 });
    expect(cmd.pos[0].text).toBe("*");
    expect(cmd.arrowPos[0].text).toBe("Customer");
  });

  it("parses multi-line formulas from a script", () => {
    const cmds = parseScript("add measure [M] =\n    VAR x = 1\n    RETURN x\nls measures");
    expect(cmds).toHaveLength(2);
    expect(cmds[0].expr).toBe("VAR x = 1\n    RETURN x");
  });
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe("glob resolution", () => {
  it("matches case-insensitively with * and ?", () => {
    expect(globMatch("total*", "Total Sales")).toBe(true);
    expect(globMatch("t?p*", "tmp calc")).toBe(true);
    expect(globMatch("total", "Total Sales")).toBe(false);
  });

  it("matches relationships by endpoint pattern", () => {
    const o = fixtureOverview();
    const toCustomer = matchRelationships(o, null, { kind: "word", text: "*", pos: 0 }, { kind: "word", text: "Customer", pos: 0 });
    expect(toCustomer.map((r) => r.name).sort()).toEqual(["Orders_Customer", "Sales_Customer"]);
    const byCol = matchRelationships(
      o,
      null,
      { kind: "colref", text: "Sales[CustomerId]", table: "Sales", column: "CustomerId", pos: 0 },
      null,
    );
    expect(byCol.map((r) => r.name)).toEqual(["Sales_Customer"]);
  });
});

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

describe("executor", () => {
  it("adds a measure with options", async () => {
    const { calls, ok } = await runText('add measure [Margin] format="0.0%" folder="KPIs" = DIVIDE([Profit], [Total Sales])');
    expect(ok).toBe(true);
    expect(calls.upsertMeasure).toHaveLength(1);
    expect(calls.upsertMeasure[0][0]).toMatchObject({
      connectionId: "conn-1",
      name: "Margin",
      formula: "DIVIDE([Profit], [Total Sales])",
      formatString: "0.0%",
      group: "KPIs",
    });
    expect(calls.batchBegin).toBeUndefined(); // single write: no batch
  });

  it("expands wildcard deletes and wraps them in one batch", async () => {
    const { calls, ok } = await runText("delete relationship * -> Customer");
    expect(ok).toBe(true);
    expect(calls.batchBegin).toHaveLength(1);
    expect(calls.deleteRelationship).toHaveLength(2);
    expect(calls.deleteRelationship.map((a) => a[1]).sort()).toEqual(["Orders_Customer", "Sales_Customer"]);
    expect(calls.batchEnd).toHaveLength(1);
    expect(calls.batchEnd[0][1]).toBe(true); // hadEdits
  });

  it("rolls the whole batch back when a step fails", async () => {
    const restored = fixtureOverview();
    let n = 0;
    const { calls, lines, ok } = await runText("delete relationship * -> Customer", fixtureOverview(), {
      deleteRelationship: vi.fn(() => {
        n += 1;
        return n === 1 ? Promise.resolve(restored) : Promise.reject(new Error("engine says no"));
      }),
      batchCancel: vi.fn(() => Promise.resolve(restored)),
    });
    expect(ok).toBe(false);
    expect(calls.batchEnd).toBeUndefined();
    expect(lines.some((l) => l.cls === "err" && l.text.includes("engine says no"))).toBe(true);
    expect(lines.some((l) => l.text.includes("rolled back"))).toBe(true);
  });

  it("set with wildcard carries unspecified measure fields", async () => {
    const { calls } = await runText('set measure [t*] folder="Archive"');
    expect(calls.upsertMeasure.length).toBeGreaterThanOrEqual(1);
    const arg = calls.upsertMeasure[0][0] as Record<string, unknown>;
    expect(arg.originalName).toBe(arg.name);
    expect(arg.formula).toBe("SUM(Sales[Amount])"); // carried
    expect(arg.group).toBe("Archive");
  });

  it("refuses a formula set across multiple matches", async () => {
    const overview = fixtureOverview();
    const { gateway } = mockGateway(overview);
    const session = createSession("conn-1", overview, false, gateway);
    expect(() => planRun("set measure [*] = 1", session)).toThrow(/ONE object/);
  });

  it("rename table sets the display name", async () => {
    const { calls } = await runText("rename table Orders Beställningar");
    expect(calls.updateTable[0][0]).toMatchObject({ table: "Orders", displayName: "Beställningar" });
  });

  it("deletes a calculated column but refuses a physical one", async () => {
    const { calls } = await runText("delete column Sales[Margin]");
    expect(calls.deleteCalcColumn[0][1]).toBe("Margin");
    const overview = fixtureOverview();
    const { gateway } = mockGateway(overview);
    const session = createSession("conn-1", overview, false, gateway);
    const { io } = collectIo();
    const plan = planRun("delete column Sales[Amount]", session);
    const outcome = await executeRun(plan, session, io);
    expect(outcome.ok).toBe(false);
  });

  it("edits calc-group items via read-modify-write", async () => {
    const { calls } = await runText("add calcitem TimeCalc[MTD] = TOTALMTD(SELECTEDMEASURE(), 'D'[Date])");
    const arg = calls.upsertCalcGroup[0][0] as { items: Array<{ name: string }> };
    expect(arg.items.map((i) => i.name)).toEqual(["YTD", "MTD"]);
  });

  it("rejects writes on a read-only model", async () => {
    const { lines, ok } = await runText("delete measure [Profit]", fixtureOverview(), {}, true);
    expect(ok).toBe(false);
    expect(lines.some((l) => l.cls === "err" && l.text.includes("read-only"))).toBe(true);
  });

  it("rejects undo mixed into a script", () => {
    const overview = fixtureOverview();
    const { gateway } = mockGateway(overview);
    const session = createSession("conn-1", overview, false, gateway);
    expect(() => planRun("undo\ndelete measure [Profit]", session)).toThrow(/undo\/redo/);
  });

  it("plans confirmation only for wildcard or multi-write runs", () => {
    const overview = fixtureOverview();
    const { gateway } = mockGateway(overview);
    const session = createSession("conn-1", overview, false, gateway);
    expect(planRun('add measure [X] = 1', session).needsConfirm).toBe(false);
    expect(planRun("delete relationship * -> Customer", session).needsConfirm).toBe(true);
    expect(planRun('add measure [X] = 1\nadd measure [Y] = 2', session).needsConfirm).toBe(true);
  });

  it("ls measures prints an aligned table", async () => {
    const { lines } = await runText("ls measures");
    expect(lines[0].text).toContain("Total Sales");
    expect(lines[0].text.split("\n").length).toBeGreaterThanOrEqual(5); // header + sep + 3 rows
  });

  it("help prints and never writes", async () => {
    const { calls, lines } = await runText("help measure");
    expect(lines[0].text).toContain("add measure");
    expect(Object.keys(calls)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// transform — a table's applied-steps pipeline
// ---------------------------------------------------------------------------

/**
 * What the ENGINE returns for each statement these tests write.
 *
 * The grammar lives in Rust now, so a TypeScript test cannot parse a statement
 * and must not try: re-implementing the parser here to test the code that
 * replaced it would recreate the very mirror this change deleted. The map
 * states, per statement, what the engine answers — and
 * `model-engine-lib/.../transform/script/tests.rs` is what proves the engine
 * really answers that. These tests cover the CLI's own job: index arithmetic,
 * read-modify-write, one `transformSet` per command.
 */
const PARSED_STATEMENTS: Record<string, { step: TransformStepDto; at: number | null }> = {
  "removeColumns columns=Qty": { step: { type: "removeColumns", columns: ["Qty"] }, at: null },
  "fillDown columns=Status at=2": { step: { type: "fillDown", columns: ["Status"] }, at: 2 },
  "fillDown columns=Status at=4": { step: { type: "fillDown", columns: ["Status"] }, at: 4 },
  "fillDown columns=Status at=5": { step: { type: "fillDown", columns: ["Status"] }, at: 5 },
  "renameColumns rename=amount:net": {
    step: { type: "renameColumns", renames: [{ from: "amount", to: "net" }] },
    at: null,
  },
  'filterRows = [Status] <> "Cancelled"': {
    step: { type: "filterRows", condition: '[Status] <> "Cancelled"' },
    at: null,
  },
};

/** The engine's refusals, keyed the same way. */
const REFUSED_STATEMENTS: Record<string, string> = {
  "frobnicate columns=Q":
    "'frobnicate' is not a transformation step. The steps are: removeColumns, ...",
  'filterRows column=Status = [Status] <> "x"':
    "'column=' does not apply to a filterRows step - it takes only an '= <expression>'",
  "fillDown columns=Qty = 1":
    "a fillDown step takes no '= <expression>' - only filterRows and addColumn do",
};

/** Stand-in for the engine's single-statement parser. */
function fakeParseStatement(_connectionId: string, text: string) {
  if (text in REFUSED_STATEMENTS) return Promise.reject(new Error(REFUSED_STATEMENTS[text]));
  const parsed = PARSED_STATEMENTS[text];
  if (!parsed) {
    return Promise.reject(
      new Error(`the test fixture has no parse for the statement ${JSON.stringify(text)}`),
    );
  }
  return Promise.resolve(parsed);
}

/** A session whose `transformSet` actually INSTALLS the new steps, so a second
 *  command in the same run reads what the first one wrote (the read-modify-
 *  write is against the session overview, not a re-fetch). */
function transformSession(overview: ModelOverview = fixtureOverview()): {
  session: ReturnType<typeof createSession>;
  calls: Record<string, unknown[][]>;
  sets: Array<{ table: string; steps: TransformStepDto[] }>;
  current: () => ModelOverview;
} {
  const sets: Array<{ table: string; steps: TransformStepDto[] }> = [];
  let current = overview;
  const { gateway, calls } = mockGateway(overview, {
    transformParseStatement: fakeParseStatement,
    transformSet: (connectionId: string, table: string, steps: TransformStepDto[]) => {
      sets.push({ table, steps });
      current = {
        ...current,
        tables: current.tables.map((t) =>
          t.name === table ? { ...t, transformSteps: steps } : t,
        ),
      };
      return Promise.resolve(current);
    },
    getOverview: () => Promise.resolve(current),
  });
  return {
    session: createSession("conn-1", overview, false, gateway),
    calls,
    sets,
    current: () => current,
  };
}

async function runTransform(
  text: string,
  overview: ModelOverview = fixtureOverview(),
): Promise<{
  sets: Array<{ table: string; steps: TransformStepDto[] }>;
  calls: Record<string, unknown[][]>;
  lines: Array<{ cls: string; text: string }>;
  ok: boolean;
}> {
  const { session, calls, sets } = transformSession(overview);
  const { io, lines } = collectIo();
  const plan = planRun(text, session);
  const outcome = await executeRun(plan, session, io);
  return { sets, calls, lines, ok: outcome.ok };
}

/** The fixture's Web pipeline: removeColumns, renameColumns, filterRows. */
function webSteps(): TransformStepDto[] {
  return fixtureOverview().tables.find((t) => t.name === "Web")!.transformSteps;
}

/**
 * Run a transform command and return the error text it printed.
 *
 * Several refusals moved from PLAN time to RUN time when the grammar moved
 * into the engine: the parser is an async call, and planning is synchronous.
 * The confirm card therefore shows the statement as typed and a bad statement
 * fails when the command runs. That is the deliberate trade recorded in
 writers.ts's previewWrite comment, and these tests pin it rather than
 * pretending the old timing survived.
 */
async function transformError(text: string): Promise<string> {
  const { session } = transformSession();
  const { io, lines } = collectIo();
  const outcome = await executeRun(planRun(text, session), session, io);
  expect(outcome.ok).toBe(false);
  return lines
    .filter((l) => l.cls === "err")
    .map((l) => l.text)
    .join(" | ");
}

describe("transform — parsing", () => {
  it("parses the subaction and indices as positionals", () => {
    const cmd = parseCommand({ text: "transform table Sales move 3 1", line: 1 });
    expect(cmd.verb).toBe("transform");
    expect(cmd.kind).toBe("table");
    expect(cmd.pos.map((t) => t.text)).toEqual(["Sales", "move", "3", "1"]);
  });

  it("keeps the raw expression tail for an expression step", () => {
    const cmd = parseCommand({
      text: 'transform table Sales add filterRows = [Status] <> "Cancelled"',
      line: 1,
    });
    expect(cmd.pos.map((t) => t.text)).toEqual(["Sales", "add", "filterRows"]);
    expect(cmd.expr).toBe('[Status] <> "Cancelled"');
  });

  it("hands the whole statement to the engine, verbatim from the step name on", async () => {
    // The contract that replaced the TypeScript builder: everything from the
    // step name to the end of the logical line goes to the engine's parser,
    // untouched. Anything less would mean re-deciding here what a step is.
    const seen: string[] = [];
    const overview = fixtureOverview();
    const { gateway } = mockGateway(overview, {
      transformParseStatement: (connectionId: string, text: string) => {
        seen.push(text);
        return Promise.resolve({
          step: { type: "removeColumns", columns: ["Qty"] } as TransformStepDto,
          at: null,
        });
      },
      getOverview: () => Promise.resolve(overview),
    });
    const session = createSession("conn-1", overview, false, gateway);
    const { io } = collectIo();
    await executeRun(planRun("transform table Web add removeColumns columns=Qty", session), session, io);
    expect(seen).toEqual(["removeColumns columns=Qty"]);
  });

  it("re-indents a continuation line so the engine reads the author's text exactly", async () => {
    // The script grammar strips ONE leading whitespace character as the marker
    // that makes a line a continuation. The command line's own raw form has no
    // such marker, so it adds one — without this the condition comes back a
    // space short of what was typed.
    const seen: string[] = [];
    const overview = fixtureOverview();
    const { gateway } = mockGateway(overview, {
      transformParseStatement: (connectionId: string, text: string) => {
        seen.push(text);
        return Promise.resolve({
          step: { type: "filterRows", condition: "x" } as TransformStepDto,
          at: null,
        });
      },
      getOverview: () => Promise.resolve(overview),
    });
    const session = createSession("conn-1", overview, false, gateway);
    const { io } = collectIo();
    const typed = 'transform table Web add filterRows = [Status] <> "x"\n  AND [Qty] > 0';
    await executeRun(planRun(typed, session), session, io);
    expect(seen).toEqual(['filterRows = [Status] <> "x"\n   AND [Qty] > 0']);
  });
});

describe("transform — subactions", () => {
  it("add appends a step and sends the WHOLE pipeline in one call", async () => {
    const { sets, calls, lines, ok } = await runTransform(
      "transform table Web add removeColumns columns=Qty",
    );
    expect(ok).toBe(true);
    expect(sets).toHaveLength(1);
    expect(sets[0].table).toBe("Web");
    expect(sets[0].steps.map((s) => s.type)).toEqual([
      "removeColumns",
      "renameColumns",
      "filterRows",
      "removeColumns",
    ]);
    expect(sets[0].steps[3]).toEqual({ type: "removeColumns", columns: ["Qty"] });
    // One edit = one undo step: a single write never opens a batch.
    expect(calls.batchBegin).toBeUndefined();
    expect(lines.some((l) => l.text.includes("Added step 4"))).toBe(true);
  });

  it("add at=N is 1-based: at=2 becomes array index 1", async () => {
    const { sets } = await runTransform(
      "transform table Web add fillDown columns=Status at=2",
    );
    expect(sets[0].steps.map((s) => s.type)).toEqual([
      "removeColumns",
      "fillDown",
      "renameColumns",
      "filterRows",
    ]);
  });

  it("add at= one past the end appends; past that it refuses", () => {
    const { session } = transformSession();
    expect(() => planRun("transform table Web add fillDown columns=Status at=4", session)).not.toThrow();
    expect(() => planRun("transform table Web add fillDown columns=Status at=5", session)).toThrow(
      /at= must be a whole number between 1 and 4/,
    );
  });

  it("remove 3 drops the THIRD step (array index 2)", async () => {
    const { sets, lines } = await runTransform("transform table Web remove 3");
    expect(sets[0].steps.map((s) => s.type)).toEqual(["removeColumns", "renameColumns"]);
    expect(lines.some((l) => l.text.includes("Removed step 3 (filterRows)"))).toBe(true);
  });

  it("move 3 1 puts the third step first", async () => {
    const { sets } = await runTransform("transform table Web move 3 1");
    expect(sets[0].steps.map((s) => s.type)).toEqual([
      "filterRows",
      "removeColumns",
      "renameColumns",
    ]);
  });

  it("clear empties the pipeline, and refuses when there is nothing to clear", async () => {
    const { sets, lines } = await runTransform("transform table Web clear");
    expect(sets[0].steps).toEqual([]);
    expect(lines.some((l) => l.text.includes("Cleared 3 steps"))).toBe(true);

    const empty = fixtureOverview();
    empty.tables = empty.tables.map((t) =>
      t.name === "Web" ? { ...t, transformSteps: [] } : t,
    );
    const { session } = transformSession(empty);
    expect(() => planRun("transform table Web clear", session)).toThrow(
      /no transformation steps to clear/,
    );
  });

  it("rename retargets the output name a step introduces", async () => {
    const { sets } = await runTransform("transform table Web rename 2 OrderNet");
    expect(sets[0].steps[1]).toEqual({
      type: "renameColumns",
      renames: [{ from: "amount", to: "OrderNet" }],
    });
  });

  it("rename refuses a step that carries no output name, saying why", async () => {
    expect(await transformError("transform table Web rename 3 Whatever")).toMatch(
      /filterRows step, which introduces no single output name/,
    );
  });

  it("an out-of-range step number names the valid range", () => {
    const { session } = transformSession();
    expect(() => planRun("transform table Web remove 9", session)).toThrow(
      /between 1 and 3/,
    );
    expect(() => planRun("transform table Web remove 0", session)).toThrow(/between 1 and 3/);
  });
});

describe("transform — guards", () => {
  it("refuses a wildcard target (a step number is per-table)", () => {
    const { session } = transformSession();
    expect(() => planRun("transform table W* clear", session)).toThrow(/wildcards are not allowed/);
  });

  it("previews as a single non-wildcard write, so it never asks for confirmation", () => {
    const { session } = transformSession();
    const plan = planRun("transform table Web remove 1", session);
    expect(plan.hasWildcard).toBe(false);
    expect(plan.needsConfirm).toBe(false);
    expect(plan.writeLabels).toEqual(["transform table Web: remove step 1 (removeColumns)"]);
  });

  it("refuses a table that is not bound to a data source", () => {
    const { session } = transformSession();
    expect(() => planRun("transform table Sales clear", session)).toThrow(
      /not bound to a data source/,
    );
  });

  it("gates on the SOURCE BINDING, not the looser `bound` flag", () => {
    // `bound` is also true for a live app-side bind that carries no persisted
    // binding — and a pipeline lives on the binding, so such a table cannot
    // hold steps. Gating on `bound` let the CLI plan a `transformSet` the
    // backend then refused. `sourceId` is the test the modal itself applies.
    const overview = fixtureOverview();
    overview.tables = overview.tables.map((t) =>
      t.name === "Web" ? { ...t, bound: true, sourceId: null } : t,
    );
    const { session } = transformSession(overview);
    expect(() => planRun("transform table Web clear", session)).toThrow(
      /not bound to a data source/,
    );
  });

  it("accepts a table whose source binding is recorded", () => {
    const { session } = transformSession();
    expect(() => planRun("transform table Web clear", session)).not.toThrow();
  });

  it("rejects an undeclared option, naming the valid keys", () => {
    const { session } = transformSession();
    expect(() => planRun("transform table Web add fillDown bogus=1 columns=Qty", session)).toThrow(
      /Unknown option 'bogus='/,
    );
    expect(() => planRun("transform table Web add fillDown bogus=1 columns=Qty", session)).toThrow(
      /columns=/,
    );
  });

  it("surfaces the engine's refusal of an option that means nothing to THIS step", async () => {
    // Refused by the engine's parser now, not by a mirror of it here — and so
    // at RUN time rather than at plan time. What matters is that the refusal
    // still reaches the user, with the engine's own wording.
    expect(
      await transformError('transform table Web add filterRows column=Status = [Status] <> "x"'),
    ).toMatch(/does not apply to a filterRows step/);
  });

  it("surfaces the engine's refusal of an expression tail on a step that takes none", async () => {
    expect(await transformError("transform table Web add fillDown columns=Qty = 1")).toMatch(
      /takes no '= <expression>'/,
    );
  });

  it("refuses an unknown subaction at plan time, and an unknown step at run time", async () => {
    // The subaction is the command line's OWN vocabulary, so it still fails
    // before the confirm card. The step name belongs to the engine's catalog,
    // so its refusal arrives with the engine's message — which names the
    // catalog, where the old one only named the seventeen tags.
    const { session } = transformSession();
    expect(() => planRun("transform table Web frobnicate 1", session)).toThrow(
      /Unknown transform action 'frobnicate'/,
    );
    expect(await transformError("transform table Web add frobnicate columns=Q")).toMatch(
      /not a transformation step/,
    );
  });

  it("rejects writes on a read-only model", async () => {
    const overview = fixtureOverview();
    const { gateway } = mockGateway(overview);
    const session = createSession("conn-1", overview, true, gateway);
    const { io, lines } = collectIo();
    const plan = planRun("transform table Web clear", session);
    const outcome = await executeRun(plan, session, io);
    expect(outcome.ok).toBe(false);
    expect(lines.some((l) => l.cls === "err" && l.text.includes("read-only"))).toBe(true);
  });
});

describe("transform — scripts", () => {
  it("a second command in the run reads what the first one wrote", async () => {
    const { sets, calls, ok } = await runTransform(
      ["transform table Web remove 1", "transform table Web remove 1"].join("\n"),
    );
    expect(ok).toBe(true);
    expect(sets).toHaveLength(2);
    expect(sets[0].steps.map((s) => s.type)).toEqual(["renameColumns", "filterRows"]);
    expect(sets[1].steps.map((s) => s.type)).toEqual(["filterRows"]);
    // Two writes: the run becomes ONE batch (one undo step, all-or-nothing).
    expect(calls.batchBegin).toHaveLength(1);
    expect(calls.batchEnd).toHaveLength(1);
  });
});

describe('transform — step construction moved to the engine', () => {
  it('no longer builds steps in TypeScript', async () => {
    // This block used to hold a seventeen-row matrix asserting the shape the
    // TypeScript builder produced for each step. That builder is gone: the
    // grammar lives in the crate that owns the step enum, and the matrix that
    // replaced this one is
    // model-engine-lib/crates/engine-core/src/transform/script/tests.rs,
    // where it can assert Rust value equality against the enum itself rather
    // than against a DTO mirror of it.
    //
    // What is asserted HERE is the property that makes that safe: the command
    // line constructs nothing, and whatever the engine answers is exactly what
    // gets written. A test that re-parsed the statement in TypeScript to check
    // the answer would be the mirror this change removed.
    const engineAnswer: TransformStepDto = {
      type: 'changeType',
      changes: [
        { column: 'a', newType: { Decimal: [18, 2] } },
        { column: 'b', newType: 'Timestamp' },
      ],
      onError: 'null',
    };
    const overview = fixtureOverview();
    const sets: Array<{ table: string; steps: TransformStepDto[] }> = [];
    const { gateway } = mockGateway(overview, {
      transformParseStatement: () => Promise.resolve({ step: engineAnswer, at: null }),
      transformSet: (_c: string, table: string, steps: TransformStepDto[]) => {
        sets.push({ table, steps });
        return Promise.resolve(overview);
      },
      getOverview: () => Promise.resolve(overview),
    });
    const session = createSession('conn-1', overview, false, gateway);
    const { io } = collectIo();
    await executeRun(planRun('transform table Web add changeType cast=a:Decimal(18,2)', session), session, io);
    // Written through untouched — including the heterogeneous cast list and
    // the Decimal type, neither of which the old TypeScript builder could
    // even express.
    expect(sets[0].steps[sets[0].steps.length - 1]).toEqual(engineAnswer);
  });

  it('declares every option the engine publishes, and none it does not', () => {
    // The one remaining mirror — a word list for completion — pinned to the
    // engine's own vocabulary by __tests__/transformScriptDrift.test.ts, which
    // reads the Rust source. This test only guards the local shape.
    const keys = TRANSFORM_STEP_OPTIONS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('at');
    for (const spec of TRANSFORM_STEP_OPTIONS) {
      expect(spec.help && spec.help.length).toBeGreaterThan(5);
    }
  });
});

describe("transform — show table lists the pipeline", () => {
  it("prints the steps numbered from 1, the way transform addresses them", async () => {
    const { lines } = await runText("show table Web");
    const text = lines.map((l) => l.text).join("\n");
    expect(text).toContain("applied steps");
    expect(text).toContain("Applied steps (3 steps)");
    // Printed as the engine's own script, numbered the way `transform`
    // addresses the steps. The old prose column went through `textTable`,
    // which clips a cell at 64 characters and flattens newlines, so a real
    // condition was shown truncated and could not be copied anywhere.
    expect(text).toMatch(/^ +1 +removeColumns columns=Notes$/m);
    expect(text).toMatch(/^ +2 +renameColumns rename=amount:net$/m);
    expect(text).toMatch(/^ +3 +filterRows = \[Status\] <> "Cancelled"$/m);
  });

  it("says nothing extra for a table with no pipeline", async () => {
    const { lines } = await runText("show table Sales");
    const text = lines.map((l) => l.text).join("\n");
    expect(text).not.toContain("Applied steps");
  });

  it("prints a long condition in full, and a multi-line step across lines", async () => {
    // The defect the prose column had: `textTable` clips a cell at 64
    // characters and flattens newlines, so the one part of a pipeline most
    // likely to be long was the part you could not read.
    const long = '[Status] <> "Cancelled" AND [Qty] > 0 AND [Region] IN {"North", "South", "East"}';
    expect(long.length).toBeGreaterThan(64);
    const overview = fixtureOverview();
    overview.tables = overview.tables.map((t) =>
      t.name === "Web"
        ? {
            ...t,
            transformSteps: [{ type: "filterRows", condition: long }],
            transformScript: `filterRows = ${long}`,
          }
        : t,
    );
    const { gateway } = mockGateway(overview);
    const session = createSession("conn-1", overview, false, gateway);
    const { io, lines } = collectIo();
    await executeRun(planRun("show table Web", session), session, io);
    const text = lines.map((l) => l.text).join("\n");
    expect(text).toContain(long);
    expect(text).not.toContain("...");
  });

  it("keeps a wrapped step's continuation lines under its number", async () => {
    const overview = fixtureOverview();
    overview.tables = overview.tables.map((t) =>
      t.name === "Web"
        ? {
            ...t,
            transformSteps: [
              { type: "removeColumns", columns: ["Notes"] },
              {
                type: "renameColumns",
                renames: [
                  { from: "a", to: "b" },
                  { from: "c", to: "d" },
                ],
              },
            ],
            transformScript: [
              "removeColumns columns=Notes",
              "",
              "renameColumns",
              "  rename=a:b",
              "  rename=c:d",
            ].join("\n"),
          }
        : t,
    );
    const { gateway } = mockGateway(overview);
    const session = createSession("conn-1", overview, false, gateway);
    const { io, lines } = collectIo();
    await executeRun(planRun("show table Web", session), session, io);
    const text = lines.map((l) => l.text).join("\n");
    expect(text).toMatch(/^ +1 +removeColumns columns=Notes$/m);
    expect(text).toMatch(/^ +2 +renameColumns$/m);
    expect(text).toMatch(/^ +rename=a:b$/m);
    expect(text).toMatch(/^ +rename=c:d$/m);
  });
});

// ---------------------------------------------------------------------------
// `where` clause — end to end through planRun/executeRun
// ---------------------------------------------------------------------------
// The unit tests in __tests__/whereClause.test.ts cover parsing and predicate
// evaluation. These cover the thing that actually protects the user: that the
// CONFIRMATION CARD and the EXECUTION see the same narrowed set. A clause that
// narrowed only one of them would either ask consent for work it does not do,
// or — far worse — do work it did not ask consent for.

describe("where clause", () => {
  it("narrows the confirmation card, not just the execution", async () => {
    // THE point of the feature. `writeLabels` is what the confirm card lists,
    // and it comes from the same `expandNamed` the execution walks — so a card
    // showing N names is a promise that N objects change.
    const overview = fixtureOverview();
    const sales = overview.tables.find((t) => t.name === "Sales")!;
    sales.columns[0] = { ...sales.columns[0], isHidden: true };
    const { gateway } = mockGateway(overview);
    const session = createSession("conn-1", overview, false, gateway);

    const all = planRun("set column Sales[*] format=\"0\"", session);
    const narrowed = planRun('set column Sales[*] format="0" where hidden=true', session);

    expect(all.writeLabels.length).toBe(sales.columns.length);
    expect(narrowed.writeLabels).toEqual([`set column Sales[${sales.columns[0].name}]`]);
  });

  it("refuses when the clause matches nothing, rather than running unfiltered", async () => {
    const overview = fixtureOverview();
    const { gateway } = mockGateway(overview);
    const session = createSession("conn-1", overview, false, gateway);
    // No Sales column is hidden, so this qualifies nothing. The dangerous
    // alternative is running `set column Sales[*] hidden=true` over everything.
    expect(() =>
      planRun('set column Sales[*] hidden=true where hidden=true', session),
    ).toThrow(/where hidden=true/);
  });

  it("actually filters the writes it performs", async () => {
    // Only ONE Sales column carries a format string in the fixture, so
    // `where format=` must skip it and hit the rest.
    const overview = fixtureOverview();
    const target = overview.tables.find((t) => t.name === "Sales")!;
    target.columns[0] = { ...target.columns[0], formatString: "0.0%" };
    const { calls } = await runText('set column Sales[*] hidden=true where format=', overview);
    const touched = calls.updateColumn.map((c) => (c[0] as { column: string }).column);
    expect(touched).not.toContain(target.columns[0].name);
    expect(touched.length).toBe(target.columns.length - 1);
  });

  it("filters measures by folder, and hides NOTHING when none qualify", async () => {
    // THE defect this whole clause could have introduced: with the predicate
    // ignored, `set measure * hidden=true where folder="Archive"` hides every
    // measure in the model and reports success. It must refuse instead.
    await expect(
      runText('set measure * hidden=true where folder="Archive"'),
    ).rejects.toThrow(/No measure matches '\*' where folder=Archive/);

    // And it must actually FIND them when they do qualify.
    const overview = fixtureOverview();
    overview.measures[0] = { ...overview.measures[0], group: "Archive" };
    const { calls } = await runText(
      'set measure * hidden=true where folder="Archive"',
      overview,
    );
    expect(calls.upsertMeasure.length).toBe(1);
    expect((calls.upsertMeasure[0][0] as { name: string }).name).toBe(overview.measures[0].name);
  });

  it("rejects an unknown property before touching anything", async () => {
    const overview = fixtureOverview();
    const { gateway } = mockGateway(overview);
    const session = createSession("conn-1", overview, false, gateway);
    expect(() => planRun('set column Sales[*] hidden=true where hiden=false', session)).toThrow(
      /not a property of a column/,
    );
  });

  it("rejects a clause on a kind that cannot evaluate one", async () => {
    const overview = fixtureOverview();
    const { gateway } = mockGateway(overview);
    const session = createSession("conn-1", overview, false, gateway);
    expect(() => planRun('delete role * where x=1', session)).toThrow(/cannot filter role/);
  });
});
