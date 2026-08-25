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
  describeTransformStep,
  normalizeStepType,
  TRANSFORM_STEP_OPTIONS,
  TRANSFORM_STEP_TYPES,
  transformStepOptionKeys,
} from "./transformSteps";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface TableOpts {
  bound?: boolean;
  transformSteps?: TransformStepDto[];
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
    sourceId: null,
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
      table("Web", ["Id", "Status", "Qty", "Notes", "amount"], [], {
        bound: true,
        transformSteps: [
          { type: "removeColumns", columns: ["Notes"] },
          { type: "renameColumns", renames: [{ from: "amount", to: "net" }] },
          { type: "filterRows", condition: '[Status] <> "Cancelled"' },
        ],
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

  it("normalizes step-type spellings, including the singular renameColumn", () => {
    expect(normalizeStepType("renameColumn")).toBe("renameColumns");
    expect(normalizeStepType("REMOVECOLUMNS")).toBe("removeColumns");
    expect(normalizeStepType("groupby")).toBe("groupBy");
    expect(normalizeStepType("nonsense")).toBeNull();
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

  it("rename refuses a step that carries no output name, saying why", () => {
    const { session } = transformSession();
    expect(() => planRun("transform table Web rename 3 Whatever", session)).toThrow(
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

  it("rejects an undeclared option, naming the valid keys", () => {
    const { session } = transformSession();
    expect(() => planRun("transform table Web add fillDown bogus=1 columns=Qty", session)).toThrow(
      /Unknown option 'bogus='/,
    );
    expect(() => planRun("transform table Web add fillDown bogus=1 columns=Qty", session)).toThrow(
      /columns=/,
    );
  });

  it("rejects a declared option that means nothing to THIS step type", () => {
    const { session } = transformSession();
    expect(() =>
      planRun('transform table Web add filterRows column=Status = [Status] <> "x"', session),
    ).toThrow(/does not apply to a filterRows step/);
  });

  it("rejects an expression tail on a step that takes none", () => {
    const { session } = transformSession();
    expect(() => planRun("transform table Web add fillDown columns=Qty = 1", session)).toThrow(
      /takes no '= <expression>'/,
    );
  });

  it("refuses an unknown subaction and an unknown step type", () => {
    const { session } = transformSession();
    expect(() => planRun("transform table Web frobnicate 1", session)).toThrow(
      /Unknown transform action 'frobnicate'/,
    );
    expect(() => planRun("transform table Web add frobnicate columns=Q", session)).toThrow(
      /Unknown step type 'frobnicate'/,
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

describe("transform — step construction", () => {
  const STEP_MATRIX: Array<[type: string, cmd: string, expected: TransformStepDto]> = [
    [
      "removeColumns",
      "transform table Web add removeColumns columns=Notes,Internal",
      { type: "removeColumns", columns: ["Notes", "Internal"] },
    ],
    [
      "selectColumns",
      "transform table Web add selectColumns columns=Id,Status",
      { type: "selectColumns", columns: ["Id", "Status"] },
    ],
    [
      "renameColumns",
      "transform table Web add renameColumn column=Status newname=OrderStatus",
      { type: "renameColumns", renames: [{ from: "Status", to: "OrderStatus" }] },
    ],
    [
      "changeType",
      "transform table Web add changeType column=Qty type=Int64",
      { type: "changeType", changes: [{ column: "Qty", newType: "Int64" }] },
    ],
    [
      "changeType (many + policy)",
      "transform table Web add changeType columns=Qty,Id type=int onerror=null",
      {
        type: "changeType",
        changes: [
          { column: "Qty", newType: "Int64" },
          { column: "Id", newType: "Int64" },
        ],
        onError: "null",
      },
    ],
    [
      "filterRows",
      'transform table Web add filterRows = [Status] <> "Cancelled"',
      { type: "filterRows", condition: '[Status] <> "Cancelled"' },
    ],
    [
      "addColumn",
      "transform table Web add addColumn name=Margin type=Float64 = [Qty] * 2",
      { type: "addColumn", name: "Margin", expression: "[Qty] * 2", dataType: "Float64" },
    ],
    [
      "splitColumn",
      'transform table Web add splitColumn column=Status delimiter="-" parts=2 keeporiginal=true',
      { type: "splitColumn", column: "Status", delimiter: "-", parts: 2, keepOriginal: true },
    ],
    [
      "replaceValues",
      'transform table Web add replaceValues column=Status find="n/a" replace="" matchentire=true',
      {
        type: "replaceValues",
        column: "Status",
        find: "n/a",
        replace: "",
        matchEntireValue: true,
      },
    ],
    [
      "textTransform",
      "transform table Web add textTransform columns=Status operation=trim",
      { type: "textTransform", columns: ["Status"], operation: "trim" },
    ],
    [
      "fillDown",
      "transform table Web add fillDown columns=Status",
      { type: "fillDown", columns: ["Status"] },
    ],
    [
      "removeDuplicates",
      "transform table Web add removeDuplicates",
      { type: "removeDuplicates", columns: [] },
    ],
    [
      "sort",
      "transform table Web add sort by=Qty,-Id,Status:desc",
      {
        type: "sort",
        by: [{ column: "Qty" }, { column: "Id", descending: true }, { column: "Status", descending: true }],
      },
    ],
    [
      "groupBy",
      "transform table Web add groupBy groupby=Status agg=sum:Qty:TotalQty agg=countrows::Rows",
      {
        type: "groupBy",
        groupBy: ["Status"],
        aggregates: [
          { column: "Qty", function: "Sum", alias: "TotalQty" },
          { function: "CountRows", alias: "Rows" },
        ],
      },
    ],
    [
      "keepRows",
      "transform table Web add keepRows range=first:100",
      { type: "keepRows", range: { kind: "firstN", count: 100 } },
    ],
    [
      "removeRows",
      "transform table Web add removeRows range=range:0:10",
      { type: "removeRows", range: { kind: "range", offset: 0, count: 10 } },
    ],
    [
      "unpivot",
      "transform table Web add unpivot columns=Jan,Feb namecolumn=Month valuecolumn=Amount",
      {
        type: "unpivot",
        columns: ["Jan", "Feb"],
        nameColumn: "Month",
        valueColumn: "Amount",
      },
    ],
    [
      "pivot",
      "transform table Web add pivot namecolumn=Month valuecolumn=Amount aggregate=sum values=Jan,Feb",
      {
        type: "pivot",
        nameColumn: "Month",
        valueColumn: "Amount",
        aggregate: "Sum",
        valueNames: ["Jan", "Feb"],
      },
    ],
  ];

  it.each(STEP_MATRIX)("builds a %s step", async (_label, text, expected) => {
    const { sets, ok } = await runTransform(text);
    expect(ok).toBe(true);
    expect(sets[0].steps[sets[0].steps.length - 1]).toEqual(expected);
  });

  it("covers every step type the engine defines", () => {
    const built = new Set(
      STEP_MATRIX.map(([, , expected]) => expected.type),
    );
    expect([...TRANSFORM_STEP_TYPES].filter((t) => !built.has(t))).toEqual([]);
  });

  it("every per-step option key is declared in the option schema", () => {
    const declared = new Set(TRANSFORM_STEP_OPTIONS.map((s) => s.key));
    const undeclared = TRANSFORM_STEP_TYPES.flatMap((t) =>
      transformStepOptionKeys(t).filter((k) => !declared.has(k)),
    );
    expect(undeclared).toEqual([]);
    // …and the schema declares nothing no step reads (bar the placement key).
    const read = new Set([
      "at",
      ...TRANSFORM_STEP_TYPES.flatMap((t) => transformStepOptionKeys(t)),
    ]);
    expect(TRANSFORM_STEP_OPTIONS.map((s) => s.key).filter((k) => !read.has(k))).toEqual([]);
  });
});

describe("transform — show table lists the pipeline", () => {
  it("prints the steps numbered from 1, the way transform addresses them", async () => {
    const { lines } = await runText("show table Web");
    const text = lines.map((l) => l.text).join("\n");
    expect(text).toContain("applied steps");
    expect(text).toContain("Applied steps (3 steps)");
    expect(text).toMatch(/^1 +removeColumns +Notes$/m);
    expect(text).toMatch(/^2 +renameColumns +amount -> net$/m);
    expect(text).toMatch(/^3 +filterRows +\[Status\] <> "Cancelled"$/m);
  });

  it("says nothing extra for a table with no pipeline", async () => {
    const { lines } = await runText("show table Sales");
    const text = lines.map((l) => l.text).join("\n");
    expect(text).not.toContain("Applied steps");
  });

  it("renders each step type as one readable line", () => {
    expect(describeTransformStep(webSteps()[1])).toBe("amount -> net");
    expect(
      describeTransformStep({ type: "removeDuplicates", columns: [] }),
    ).toBe("(every column)");
    expect(
      describeTransformStep({
        type: "changeType",
        changes: [{ column: "Qty", newType: "Int64" }],
        onError: "null",
      }),
    ).toBe("Qty -> Int64 (errors -> null)");
    expect(
      describeTransformStep({ type: "keepRows", range: { kind: "lastN", count: 5 } }),
    ).toBe("last 5");
  });
});
