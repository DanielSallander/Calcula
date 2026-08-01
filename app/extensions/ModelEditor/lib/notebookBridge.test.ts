// FILENAME: app/extensions/ModelEditor/lib/notebookBridge.test.ts
// PURPOSE: "Test in notebook" — the measure/context evaluate bridge.
// CONTEXT: The property under test is that this is a READ-ONLY path: it calls
//          the read-only diagnostics (bi_model_validate_measure /
//          bi_model_validate_context), it emits a text scaffold, and it never
//          reaches an upsert/delete/batch command. It also has to be HONEST —
//          the engine cannot execute an unapplied draft, so the scaffold must
//          say what it really evaluates instead of implying it ran the draft.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MeasureValidation, ModelMeasureInfo } from "@api";

const validateMeasure = vi.fn();
const validateContext = vi.fn();
const upsertMeasure = vi.fn();
const upsertContext = vi.fn();
const emitted: Array<{ event: string; payload: unknown }> = [];

vi.mock("@api", () => ({
  biModelValidateMeasure: (...args: unknown[]) => validateMeasure(...args),
  biModelValidateContext: (...args: unknown[]) => validateContext(...args),
  biModelUpsertMeasure: (...args: unknown[]) => upsertMeasure(...args),
  biModelUpsertContext: (...args: unknown[]) => upsertContext(...args),
}));

vi.mock("@api/backend", () => ({
  emitTauriEvent: async (event: string, payload: unknown) => {
    emitted.push({ event, payload });
  },
}));

import {
  buildContextScaffold,
  buildMeasureScaffold,
  measuresUsingContext,
  referencedMeasures,
  testContextInNotebook,
  testMeasureInNotebook,
} from "./notebookBridge";

function measure(name: string, formula: string): ModelMeasureInfo {
  return {
    name,
    table: "Sales",
    formula,
    hasSource: true,
    description: null,
    formatString: null,
    formatStringExpression: null,
    detailRows: null,
    isHidden: false,
    group: null,
  };
}

const OK: MeasureValidation = { ok: true, message: null, position: null };
const BAD: MeasureValidation = { ok: false, message: "unknown measure [Nope]", position: 12 };

const MODEL = [
  measure("Revenue", "SUM(Sales[amount])"),
  measure("Cost", "SUM(Sales[cost])"),
  measure("Margin EMEA", "using([Revenue] - [Cost], emea_only)"),
];

beforeEach(() => {
  emitted.length = 0;
  validateMeasure.mockReset();
  validateContext.mockReset();
  upsertMeasure.mockReset();
  upsertContext.mockReset();
});

// ---------------------------------------------------------------------------
// Reference extraction
// ---------------------------------------------------------------------------

describe("referencedMeasures", () => {
  it("finds measure references that the live model actually defines", () => {
    expect(referencedMeasures("[Revenue] - [Cost]", MODEL)).toEqual(["Cost", "Revenue"]);
  });

  it("drops bracketed names the model does not define (columns, typos)", () => {
    expect(referencedMeasures("SUM(Sales[amount]) + [Nope]", MODEL)).toEqual([]);
  });
});

describe("measuresUsingContext", () => {
  it("finds the measures that apply a context today", () => {
    expect(measuresUsingContext("emea_only", MODEL)).toEqual(["Margin EMEA"]);
  });

  it("returns nothing for an unused or unnamed context", () => {
    expect(measuresUsingContext("brand_new", MODEL)).toEqual([]);
    expect(measuresUsingContext("  ", MODEL)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Scaffold content
// ---------------------------------------------------------------------------

describe("buildMeasureScaffold", () => {
  it("says the draft is NOT applied to the model", () => {
    const s = buildMeasureScaffold(
      {
        connectionId: "c1",
        name: "Margin",
        formula: "[Revenue] - [Cost]",
        existing: null,
        knownMeasures: MODEL,
      },
      OK,
    );
    const prose = s.cells[0].source;
    expect(s.cells[0].kind).toBe("markdown");
    expect(prose).toMatch(/has not been applied to the model/i);
    expect(prose).toMatch(/cannot \*execute\* an unapplied one/);
  });

  it("carries the read-only verdict through, pass or fail", () => {
    const req = {
      connectionId: "c1",
      name: "Margin",
      formula: "[Revenue] - [Nope]",
      existing: null,
      knownMeasures: MODEL,
    };
    expect(buildMeasureScaffold(req, OK).cells[0].source).toMatch(/compiles against the live model/);
    const bad = buildMeasureScaffold(req, BAD).cells[0].source;
    expect(bad).toMatch(/FAILS \(at position 12\)/);
    expect(bad).toContain("unknown measure [Nope]");
  });

  it("evaluates the referenced measures of a NEW draft", () => {
    const s = buildMeasureScaffold(
      {
        connectionId: "c1",
        name: "Margin",
        formula: "[Revenue] - [Cost]",
        existing: null,
        knownMeasures: MODEL,
      },
      OK,
    );
    const code = s.cells[1].source;
    expect(s.cells[1].kind).toBe("code");
    expect(code).toContain('measures: ["Cost", "Revenue"]');
    expect(code).toContain('const conn = "c1";');
  });

  it("puts the SAVED measure first when editing an existing one", () => {
    const s = buildMeasureScaffold(
      {
        connectionId: "c1",
        name: "Revenue",
        formula: "SUM(Sales[amount]) * 1.1",
        existing: MODEL[0],
        knownMeasures: MODEL,
      },
      OK,
    );
    expect(s.cells[1].source).toContain('measures: ["Revenue"]');
    expect(s.cells[0].source).toMatch(/the \*\*saved\*\* definition/);
  });

  it("says plainly when there is nothing to evaluate yet", () => {
    const s = buildMeasureScaffold(
      {
        connectionId: "c1",
        name: "Brand new",
        formula: "SUM(Sales[amount])",
        existing: null,
        knownMeasures: MODEL,
      },
      OK,
    );
    expect(s.cells[0].source).toMatch(/no saved definition to query/);
    expect(s.cells[1].source).toContain("measures: []");
  });

  it("fences a formula that itself contains a code fence", () => {
    const s = buildMeasureScaffold(
      {
        connectionId: "c1",
        name: "Odd",
        formula: "SUM(x) // ```",
        existing: null,
        knownMeasures: MODEL,
      },
      OK,
    );
    // The formula survives byte-for-byte, inside a longer fence.
    expect(s.cells[0].source).toContain("SUM(x) // ```");
    expect(s.cells[0].source).toContain("````");
  });
});

describe("buildContextScaffold", () => {
  it("evaluates the measures that apply the context", () => {
    const s = buildContextScaffold(
      {
        connectionId: "c1",
        name: "emea_only",
        expression: "KEEP(dim_region, dim_region[region] = \"EMEA\")",
        originalName: "emea_only",
        knownMeasures: MODEL,
      },
      OK,
    );
    expect(s.cells[1].source).toContain('measures: ["Margin EMEA"]');
    expect(s.cells[0].source).toMatch(/has not been applied to the model/i);
  });

  it("is honest when nothing uses the context yet", () => {
    const s = buildContextScaffold(
      {
        connectionId: "c1",
        name: "brand_new",
        expression: "RESET()",
        originalName: null,
        knownMeasures: MODEL,
      },
      OK,
    );
    expect(s.cells[0].source).toMatch(/No saved measure applies this context yet/);
    expect(s.cells[1].source).toContain("measures: []");
  });
});

// ---------------------------------------------------------------------------
// The path itself is read-only
// ---------------------------------------------------------------------------

describe("testMeasureInNotebook / testContextInNotebook", () => {
  it("validates through the READ-ONLY diagnostic and never upserts", async () => {
    validateMeasure.mockResolvedValue(OK);
    await testMeasureInNotebook({
      connectionId: "c1",
      name: "Margin",
      formula: "[Revenue] - [Cost]",
      existing: null,
      knownMeasures: MODEL,
    });
    expect(validateMeasure).toHaveBeenCalledWith("c1", "Margin", "[Revenue] - [Cost]", null);
    expect(upsertMeasure).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe("calcula:notebook-scaffold");
  });

  it("passes the original name so an EDIT validates as an edit, not a clash", async () => {
    validateMeasure.mockResolvedValue(OK);
    await testMeasureInNotebook({
      connectionId: "c1",
      name: "Revenue v2",
      formula: "SUM(Sales[amount])",
      existing: MODEL[0],
      knownMeasures: MODEL,
    });
    expect(validateMeasure).toHaveBeenCalledWith("c1", "Revenue v2", "SUM(Sales[amount])", "Revenue");
  });

  it("does the same for contexts", async () => {
    validateContext.mockResolvedValue(OK);
    await testContextInNotebook({
      connectionId: "c1",
      name: "emea_only",
      expression: "RESET()",
      originalName: "emea_only",
      knownMeasures: MODEL,
    });
    expect(validateContext).toHaveBeenCalledWith("c1", "emea_only", "RESET()", "emea_only");
    expect(upsertContext).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(1);
  });

  it("emits nothing when validation itself fails to run", async () => {
    validateMeasure.mockRejectedValue(new Error("connection lost"));
    await expect(
      testMeasureInNotebook({
        connectionId: "c1",
        name: "Margin",
        formula: "x",
        existing: null,
        knownMeasures: MODEL,
      }),
    ).rejects.toThrow("connection lost");
    expect(emitted).toHaveLength(0);
  });
});
