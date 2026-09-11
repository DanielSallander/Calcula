//! FILENAME: app/extensions/FormulaAssist/__tests__/ladder.test.ts
// PURPOSE: Lock down the decisions the ladder makes, in the order it makes
//          them — which is where this feature can go wrong without anything
//          crashing.
// CONTEXT: Every outside edge is injected, so these tests drive the REAL
//          `assistFormula` rather than a re-implementation of it. What they
//          assert is behaviour a user would feel: an answer arriving without
//          context, a badge that is not given away, a repair that stops instead
//          of burning fifteen more seconds, and a reply with no formula in it
//          coming back as a result instead of an exception.

import { describe, it, expect, vi, beforeEach } from "vitest";

// The facade is mocked because the real one pulls in the whole Tauri bridge.
// Only the two functions the ladder and its explain fallback actually call are
// provided — anything else appearing here would be a silent widening of what
// this module is allowed to touch.
vi.mock("@api", () => ({
  columnToLetter: (col: number) => String.fromCharCode(65 + col),
  getAiCompletionProvider: () => null,
  getAllFunctions: async () => ({ functions: [] }),
  getFormulaEvalPlan: async () => {
    throw new Error("not used in these tests");
  },
}));

import type { AiCompletionProvider } from "@api/aiCompletionService";
import type { RetrievablePattern } from "@api/formulaAssist";
import { assistFormula, MAX_REPAIR_ROUNDS } from "../lib/ladder";
import type { LadderDeps, LadderPhase } from "../lib/ladder";
import type { FormulaVerifyReport, RegionContext } from "../lib/backend";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REQUEST = { intent: "total the Amount column", sheetIndex: 0, row: 5, col: 2 };

function context(overrides: Partial<RegionContext> = {}): RegionContext {
  return {
    sheetName: "Sales",
    target: "C6",
    targetRow: 5,
    targetCol: 2,
    targetIsEmpty: true,
    range: "A1:C6",
    hasHeaderRow: true,
    dataRowCount: 5,
    columns: [
      { letter: "A", header: "Region", kind: "text", isTarget: false },
      { letter: "B", header: "Amount", kind: "number", isTarget: false },
      { letter: "C", header: "Total", kind: "empty", isTarget: true },
    ],
    sampleRows: [["2", "North", "100", ""]],
    text: "(backend rendering)",
    tokenEstimate: 120,
    ...overrides,
  };
}

function report(overrides: Partial<FormulaVerifyReport> = {}): FormulaVerifyReport {
  return {
    normalized: "=SUM(B2:B6)",
    localized: "=SUMMA(B2:B6)",
    rung: "f2",
    verdict: "verified",
    findings: [],
    values: [{ row: 5, col: 2, display: "500", kind: "number" }],
    spillRows: 1,
    spillCols: 1,
    functionsUsed: ["SUM"],
    ...overrides,
  };
}

const PATTERNS: RetrievablePattern[] = [
  { id: "SUMIFS#1", fn: "SUMIFS", intent: "sums values that satisfy conditions", formula: "=SUMIFS(B:B,A:A,\"North\")", result: "300" },
  { id: "PV#1", fn: "PV", intent: "present value of an investment", formula: "=PV(0.05,10,-100)", result: "772" },
];

interface RecordedCall {
  messages: ReadonlyArray<{ role: string; text: string }>;
  grammar?: string;
  responseSchema?: unknown;
}

/** A model that answers with the scripted replies, in order. */
function scriptedProvider(replies: string[], honorsGrammar: boolean | undefined = false): AiCompletionProvider & {
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let i = 0;
  return {
    calls,
    isConfigured: () => true,
    modelLabel: () => "qwen2.5-coder:1.5b",
    isLocal: () => true,
    honorsSchema: () => true,
    honorsGrammar: () => honorsGrammar,
    complete: async (req) => {
      calls.push({
        messages: req.messages.map((m) => ({ role: m.role, text: m.text })),
        grammar: req.grammar,
        responseSchema: req.responseSchema,
      });
      const text = replies[Math.min(i, replies.length - 1)];
      i++;
      return { text, truncated: false, model: "qwen2.5-coder:1.5b", durationMs: 10 };
    },
  };
}

function jsonReply(formula: string, fillDown = false): string {
  return JSON.stringify({
    formula,
    explanation: "Adds up the Amount column.",
    assumptions: [],
    fillDown,
  });
}

interface Harness {
  deps: LadderDeps;
  verifyCalls: Array<{ formula: string; fillDownRows: number }>;
  phases: LadderPhase[];
}

function harness(opts: {
  replies?: string[];
  provider?: AiCompletionProvider | null;
  reports?: FormulaVerifyReport[];
  contextFails?: boolean;
  patternsFail?: boolean;
}): Harness {
  const verifyCalls: Array<{ formula: string; fillDownRows: number }> = [];
  const phases: LadderPhase[] = [];
  const reports = opts.reports ?? [report()];
  let verifyIndex = 0;

  const deps: LadderDeps = {
    fetchContext: async () => {
      if (opts.contextFails) throw new Error("formula_context is unavailable");
      return context();
    },
    verify: async (req) => {
      verifyCalls.push({ formula: req.formula, fillDownRows: req.fillDownRows });
      const r = reports[Math.min(verifyIndex, reports.length - 1)];
      verifyIndex++;
      return r;
    },
    getProvider: () =>
      opts.provider === undefined
        ? scriptedProvider(opts.replies ?? [jsonReply("=SUM(B2:B6)")])
        : opts.provider,
    loadPatterns: async () => {
      if (opts.patternsFail) throw new Error("pattern library missing");
      return PATTERNS;
    },
    onPhase: (p) => phases.push(p),
  };

  // `buildIndex` / `rankPatterns` run for real against PATTERNS, so what the
  // examples assertion checks is the actual retrieval, not a stub of it.
  return { deps, verifyCalls, phases };
}

// ---------------------------------------------------------------------------

describe("the ladder builds context before it asks", () => {
  it("carries on and still answers when formula_context fails", async () => {
    const h = harness({ contextFails: true });
    const proposal = await assistFormula(REQUEST, h.deps);

    expect(proposal.status).toBe("verified");
    expect(h.verifyCalls).toHaveLength(1);
  });

  it("reports a phase for every rung, so the UI is never silent", async () => {
    const h = harness({});
    await assistFormula(REQUEST, h.deps);

    expect(h.phases.map((p) => p.kind)).toEqual([
      "context",
      "retrieval",
      "asking",
      "verifying",
    ]);
  });
});

describe("the ladder puts worked examples in front of the model", () => {
  it("sends retrieved examples in the user prompt", async () => {
    const provider = scriptedProvider([jsonReply("=SUM(B2:B6)")]);
    const h = harness({ provider });
    await assistFormula(
      { ...REQUEST, intent: "sum the Amount where the Region is North" },
      h.deps,
    );

    const firstUserMessage = provider.calls[0].messages[0].text;
    expect(firstUserMessage).toContain("Similar verified formulas:");
    expect(firstUserMessage).toContain("SUMIFS");
  });

  it("still answers when the pattern library cannot be loaded", async () => {
    const provider = scriptedProvider([jsonReply("=SUM(B2:B6)")]);
    const h = harness({ provider, patternsFail: true });
    const proposal = await assistFormula(REQUEST, h.deps);

    expect(proposal.status).toBe("verified");
    expect(provider.calls[0].messages[0].text).not.toContain("Similar verified formulas:");
  });
});

describe("the ladder constrains where it can and requests where it must", () => {
  it("sends the formula grammar, and no schema, to a runtime measured to honour one", async () => {
    const provider = scriptedProvider([jsonReply("=SUM(B2:B6)")], true);
    const h = harness({ provider });
    const proposal = await assistFormula(REQUEST, h.deps);

    expect(proposal.status).toBe("verified");
    const call = provider.calls[0];
    expect(call.grammar, "a grammar-honouring runtime gets the grammar").toContain('root ::=');
    expect(call.grammar).toContain("expr");
    expect(call.responseSchema, "and not the schema beside it").toBeUndefined();
  });

  it("sends the schema, and no grammar, everywhere else — including the unmeasured case", async () => {
    for (const verdict of [false, undefined] as const) {
      const provider = scriptedProvider([jsonReply("=SUM(B2:B6)")], verdict);
      const h = harness({ provider });
      await assistFormula(REQUEST, h.deps);
      const call = provider.calls[0];
      expect(call.grammar, `verdict ${String(verdict)}`).toBeUndefined();
      expect(call.responseSchema, `verdict ${String(verdict)}`).toBeTruthy();
    }
  });
});

describe("no model configured is a result, not a failure", () => {
  it("returns no-model without asking the verifier anything", async () => {
    const h = harness({ provider: null });
    const proposal = await assistFormula(REQUEST, h.deps);

    expect(proposal.status).toBe("no-model");
    expect(proposal.summary).toContain("AI Chat");
    expect(h.verifyCalls).toHaveLength(0);
  });

  it("returns no-model when a provider exists but nothing is selected", async () => {
    const unconfigured = { ...scriptedProvider([]), isConfigured: () => false };
    const h = harness({ provider: unconfigured });
    const proposal = await assistFormula(REQUEST, h.deps);

    expect(proposal.status).toBe("no-model");
  });
});

describe("the badge is earned", () => {
  it("calls a verdict-verified f2 answer verified and carries its value", async () => {
    const h = harness({});
    const proposal = await assistFormula(REQUEST, h.deps);

    expect(proposal.status).toBe("verified");
    expect(proposal.formulaLocalized).toBe("=SUMMA(B2:B6)");
    expect(proposal.formulaInvariant).toBe("=SUM(B2:B6)");
    expect(proposal.verification?.verified).toBe(true);
    expect(proposal.verification?.display).toBe("500");
    expect(proposal.rounds).toBe(1);
  });

  it("refuses the badge when the verdict is verified but the rung is not f2", async () => {
    const h = harness({
      reports: [report({ rung: "f1" }), report({ rung: "f1" }), report({ rung: "f1" })],
      replies: [jsonReply("=SUM(B2:B6)"), jsonReply("=SUM(B2:B7)"), jsonReply("=SUM(B2:B8)")],
    });
    const proposal = await assistFormula(REQUEST, h.deps);

    expect(proposal.status).toBe("unverified");
    expect(proposal.verification?.verified).toBe(false);
  });

  it("shows the decline reason and never claims a check happened", async () => {
    const h = harness({
      reports: [
        report({
          verdict: "declined",
          rung: "f0",
          declineReason: "The target cell is inside a subscribed writeback region.",
          values: [],
        }),
      ],
    });
    const proposal = await assistFormula(REQUEST, h.deps);

    expect(proposal.status).toBe("declined");
    expect(proposal.verification?.verified).toBe(false);
    expect(proposal.summary).toContain("writeback region");
  });
});

describe("a fill-down proposal is previewed over three rows", () => {
  it("asks the verifier for three rows and reports the first three values", async () => {
    const h = harness({
      replies: [jsonReply("=B2*0.25", true)],
      reports: [
        report({
          values: [
            { row: 5, col: 2, display: "25", kind: "number" },
            { row: 6, col: 2, display: "50", kind: "number" },
            { row: 7, col: 2, display: "75", kind: "number" },
            { row: 8, col: 2, display: "100", kind: "number" },
          ],
        }),
      ],
    });
    const proposal = await assistFormula(REQUEST, h.deps);

    expect(h.verifyCalls[0].fillDownRows).toBe(3);
    expect(proposal.fillDown).toBe(true);
    expect(proposal.verification?.display).toBe("25");
    expect(proposal.verification?.fillDownDisplays).toEqual(["50", "75", "100"]);
  });

  it("asks for no fill-down rows when the model did not ask for a fill-down", async () => {
    const h = harness({});
    await assistFormula(REQUEST, h.deps);

    expect(h.verifyCalls[0].fillDownRows).toBe(0);
  });
});

describe("repair", () => {
  it("sends the engine's findings back and accepts the corrected formula", async () => {
    const provider = scriptedProvider([
      jsonReply("=SUM(B2:B99)"),
      jsonReply("=SUM(B2:B6)"),
    ]);
    const h = harness({
      provider,
      reports: [
        report({
          verdict: "repair",
          rung: "f1",
          findings: [{ code: "range", message: "B2:B99 reaches past the data.", hint: "Use B2:B6." }],
        }),
        report(),
      ],
    });
    const proposal = await assistFormula(REQUEST, h.deps);

    expect(proposal.status).toBe("verified");
    expect(proposal.rounds).toBe(2);
    // The repair is APPENDED — the first user message survives, so the context
    // and the provider's prefix cache both do.
    const secondCall = provider.calls[1].messages;
    expect(secondCall).toHaveLength(3);
    expect(secondCall[0].role).toBe("user");
    expect(secondCall[1].role).toBe("assistant");
    expect(secondCall[2].text).toContain("B2:B99 reaches past the data. Use B2:B6.");
  });

  it("STOPS the moment a repair returns the same formula, without asking again", async () => {
    // The measured case: 30 of 38 repair rounds came back byte-identical.
    const provider = scriptedProvider([
      jsonReply("=SUM(B2:B99)"),
      jsonReply("=SUM(B2:B99)"),
      jsonReply("=SUM(B2:B6)"),
    ]);
    const h = harness({
      provider,
      reports: [report({ verdict: "repair", rung: "f1", findings: [{ code: "r", message: "no." }] })],
    });
    const proposal = await assistFormula(REQUEST, h.deps);

    expect(provider.calls).toHaveLength(2);
    expect(h.verifyCalls).toHaveLength(1);
    expect(proposal.status).toBe("unverified");
    expect(proposal.summary).toContain("same formula again");
  });

  it("never spends more than the budgeted number of repairs", async () => {
    const provider = scriptedProvider([
      jsonReply("=SUM(B2:B1)"),
      jsonReply("=SUM(B2:B2)"),
      jsonReply("=SUM(B2:B3)"),
      jsonReply("=SUM(B2:B4)"),
    ]);
    const h = harness({
      provider,
      reports: [report({ verdict: "repair", rung: "f1", findings: [{ code: "r", message: "no." }] })],
    });
    const proposal = await assistFormula(REQUEST, h.deps);

    expect(provider.calls).toHaveLength(MAX_REPAIR_ROUNDS + 1);
    expect(proposal.rounds).toBe(MAX_REPAIR_ROUNDS + 1);
    expect(proposal.status).toBe("unverified");
  });
});

describe("a reply with no formula is a result", () => {
  it("declines rather than throwing", async () => {
    const h = harness({ replies: ["I am not able to help with that."] });
    const proposal = await assistFormula(REQUEST, h.deps);

    expect(proposal.status).toBe("declined");
    expect(proposal.verification?.declineReason).toContain("no formula");
    expect(h.verifyCalls).toHaveLength(0);
  });

  it("says so differently when the reply was cut off by the token limit", async () => {
    const truncating: AiCompletionProvider = {
      isConfigured: () => true,
      modelLabel: () => "tiny",
      isLocal: () => true,
      honorsSchema: () => undefined,
      honorsGrammar: () => undefined,
      complete: async () => ({
        text: "Here is what I would do: first consider",
        truncated: true,
        model: "tiny",
        durationMs: 5,
      }),
    };
    const h = harness({ provider: truncating });
    const proposal = await assistFormula(REQUEST, h.deps);

    expect(proposal.status).toBe("declined");
    expect(proposal.summary).toContain("length limit");
  });
});

describe("what the engine had to change is told to the user", () => {
  it("adds an assumption when the model wrote a localized formula", async () => {
    const h = harness({
      replies: [jsonReply("=SUMMA(B2;B6)")],
      reports: [report({ delocalizedFromLocale: "sv-SE" })],
    });
    const proposal = await assistFormula(REQUEST, h.deps);

    expect(proposal.assumptions.join(" ")).toContain("sv-SE");
  });
});

describe("the target is the cell that was asked about", () => {
  beforeEach(() => vi.clearAllMocks());

  it("binds the proposal to the request's cell, spelled in A1", async () => {
    const h = harness({});
    const proposal = await assistFormula(REQUEST, h.deps);

    expect(proposal.target).toEqual({ sheetIndex: 0, row: 5, col: 2, a1: "C6" });
  });
});
