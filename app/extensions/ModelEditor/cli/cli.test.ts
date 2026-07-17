// FILENAME: app/extensions/ModelEditor/cli/cli.test.ts
// PURPOSE: Unit tests for the Model Editor command line: lexer/parser shapes,
//          glob resolution, and executor behavior over a mock gateway
//          (wildcard fan-out, batch begin/end, all-or-nothing rollback,
//          read-modify-write carry semantics, read-only guard).

import { describe, expect, it, vi } from "vitest";
import type { ModelMeasureInfo, ModelOverview, ModelRelationshipInfo, ModelTableInfo } from "@api";
import { lexLine, logicalLines } from "./lex";
import { parseCommand, parseScript, optStr } from "./parse";
import { globMatch, matchRelationships } from "./resolve";
import { createSession, executeRun, planRun } from "./execute";
import type { CliIo } from "./execute";
import type { CliGateway } from "./gateway";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function table(name: string, cols: string[], calc: string[] = []): ModelTableInfo {
  return {
    name,
    displayName: null,
    description: null,
    isHidden: false,
    storageMode: "InMemory",
    bound: false,
    sourceId: null,
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
