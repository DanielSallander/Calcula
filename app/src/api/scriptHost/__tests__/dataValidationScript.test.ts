//! FILENAME: app/src/api/scriptHost/__tests__/dataValidationScript.test.ts
// PURPOSE: Wave 3 item 5 — data-validation rows. Pins (1) checkValidationRule's
//          per-type key enumeration (unknown keys fail WITH the accepted list,
//          mirroring the serde tags), (2) the flat<->nested mappers round-trip
//          for every rule type, (3) the executors' exact backend payloads over
//          a mocked lib, including sheet-NAME resolution, and (4) the
//          allowlist classification (unlocked tier, no capability).

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../grid", () => ({
  refreshGridData: vi.fn(),
  refreshGridDimensions: vi.fn(),
  convertFormulaStyle: vi.fn(async (f: string) => f),
}));
vi.mock("../../../core/lib/cellEvents", () => ({
  cellEvents: { emitBatch: vi.fn() },
  cellToChange: vi.fn((c: unknown) => c),
}));

import {
  scriptRuleToDataValidation,
  dataValidationToScriptRule,
  executeSetDataValidation,
  executeClearDataValidation,
  executeGetDataValidation,
  executeListDataValidations,
  type ScriptValidationRule,
} from "../host";
import { ALLOWLIST } from "../allowlist";
import {
  checkValidationRule,
  vDataValidationSet,
  vDataValidationClear,
  vSheetScopedList,
  vCellRef,
  SCRIPT_VALIDATION_TYPES,
  SCRIPT_VALIDATION_OPERATORS,
} from "../validators";

const SHEETS = [
  { index: 0, name: "Main" },
  { index: 1, name: "Inputs" },
];

function makeLib() {
  return {
    getActiveSheet: vi.fn(async () => 0),
    getSheets: vi.fn(async () => ({ sheets: SHEETS, activeIndex: 0 })),
    setDataValidation: vi.fn(async () => ({ success: true, validation: null, error: null })),
    clearDataValidation: vi.fn(async () => ({ success: true, validation: null, error: null })),
    getDataValidation: vi.fn(async () => null),
    getAllDataValidations: vi.fn(async () => []),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asLib = (l: unknown) => l as any;

beforeEach(() => vi.clearAllMocks());

// ============================================================================
// (1) checkValidationRule: the per-type acceptance matrix
// ============================================================================

describe("checkValidationRule", () => {
  it("the type set mirrors the serde union tags (minus 'none')", () => {
    expect([...SCRIPT_VALIDATION_TYPES].sort()).toEqual(
      ["custom", "date", "decimal", "list", "textLength", "time", "wholeNumber"],
    );
    expect(SCRIPT_VALIDATION_OPERATORS.size).toBe(8);
  });

  it("accepts one well-formed rule of every type", () => {
    const good: ScriptValidationRule[] = [
      { type: "wholeNumber", operator: "between", formula1: 1, formula2: 100 },
      { type: "decimal", operator: "greaterThan", formula1: 0.5 },
      { type: "date", operator: "notBetween", formula1: 45000, formula2: 45365 },
      { type: "time", operator: "lessThanOrEqual", formula1: 0.5 },
      { type: "textLength", operator: "equal", formula1: 4 },
      { type: "custom", formula: "=A1>0" },
      { type: "list", values: ["Red", "Green"], inCellDropdown: true },
      {
        type: "list",
        sourceRange: { startRow: 0, startCol: 0, endRow: 9, endCol: 0, sheetIndex: 1 },
      },
      {
        type: "wholeNumber", operator: "equal", formula1: 7,
        ignoreBlanks: false, inputTitle: "T", inputMessage: "M", showInput: true,
        errorTitle: "E", errorMessage: "Bad", errorStyle: "warning", showError: true,
      },
    ];
    for (const rule of good) {
      expect(checkValidationRule(rule), JSON.stringify(rule)).toBe(true);
    }
  });

  it("an unknown key fails WITH the accepted list for that type", () => {
    const verdict = checkValidationRule({ type: "custom", formula: "=1", operator: "equal" });
    expect(verdict).toContain('unknown rule key "operator" for type "custom"');
    expect(verdict).toContain("formula");
    // A list key on a numeric rule is just as out of place.
    expect(
      checkValidationRule({ type: "decimal", operator: "equal", formula1: 1, values: ["x"] }),
    ).toContain('unknown rule key "values"');
  });

  it("compare kinds: operator + formula1 required, formula2 only for two-bound", () => {
    expect(checkValidationRule({ type: "wholeNumber", formula1: 1 })).toContain("operator");
    expect(checkValidationRule({ type: "wholeNumber", operator: "between", formula1: 1 }))
      .toContain("formula2");
    expect(
      checkValidationRule({ type: "wholeNumber", operator: "equal", formula1: 1, formula2: 2 }),
    ).toContain('only used with "between"');
  });

  it("list: exactly one source, values checked element-wise", () => {
    expect(checkValidationRule({ type: "list" })).toContain("exactly one source");
    expect(
      checkValidationRule({
        type: "list", values: ["a"],
        sourceRange: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
      }),
    ).toContain("exactly one source");
    expect(checkValidationRule({ type: "list", values: [] })).toContain("non-empty");
    expect(checkValidationRule({ type: "list", values: [42] })).toContain("must be a string");
  });

  it("rejects a type outside the set, naming it", () => {
    expect(checkValidationRule({ type: "cellIs" })).toContain("rule.type must be one of");
    expect(checkValidationRule(null)).toContain("must be an object");
  });
});

describe("vDataValidationSet / vDataValidationClear / list validators", () => {
  it("range + rule + optional sheet ref", () => {
    const rule = { type: "custom", formula: "=1" };
    expect(vDataValidationSet([0, 0, 9, 9, rule, "Inputs"])).toBe(true);
    expect(vDataValidationSet([0, 0, 9, 9, rule, undefined])).toBe(true);
    // Whole-column validation must NOT hit a cell-count ceiling.
    expect(vDataValidationSet([0, 0, 1048575, 0, rule])).toBe(true);
    expect(vDataValidationSet([9, 0, 0, 0, rule])).toContain("endRow");
    expect(vDataValidationSet([0, 0, 9, 9, rule, -1])).not.toBe(true);
  });

  it("clear takes a rectangle OBJECT plus the sheet slot", () => {
    expect(vDataValidationClear([{ startRow: 0, startCol: 0, endRow: 3, endCol: 3 }, 1])).toBe(true);
    expect(vDataValidationClear([{ startRow: 0, startCol: 0, endRow: 3 }, 1])).toContain("endCol");
    expect(vDataValidationClear([[0, 0, 3, 3]])).toContain("must be an object");
  });

  it("the list row takes only the sheet slot", () => {
    expect(vSheetScopedList([])).toBe(true);
    expect(vSheetScopedList(["Inputs"])).toBe(true);
    expect(vSheetScopedList([{}])).not.toBe(true);
  });
});

// ============================================================================
// (2) flat <-> nested mapping, round-tripped per type
// ============================================================================

describe("rule mapping round-trips", () => {
  const cases: ScriptValidationRule[] = [
    { type: "wholeNumber", operator: "between", formula1: 1, formula2: 100 },
    { type: "decimal", operator: "greaterThanOrEqual", formula1: -2.5 },
    { type: "date", operator: "notBetween", formula1: 45000, formula2: 45365 },
    { type: "time", operator: "lessThan", formula1: 0.75 },
    { type: "textLength", operator: "notEqual", formula1: 8 },
    { type: "custom", formula: "=LEN(A1)>2" },
    { type: "list", values: ["Yes", "No"], inCellDropdown: false },
    {
      type: "list",
      sourceRange: { startRow: 1, startCol: 2, endRow: 20, endCol: 2, sheetIndex: 1 },
      inCellDropdown: true,
    },
  ];

  it.each(cases.map((c) => [c.type + (c.values ? "+values" : c.sourceRange ? "+range" : ""), c] as const))(
    "%s survives write -> read-back -> write unchanged where it matters",
    (_label, rule) => {
      const full: ScriptValidationRule = {
        ...rule,
        ignoreBlanks: false,
        inputTitle: "Pick",
        inputMessage: "Please",
        showInput: true,
        errorTitle: "No",
        errorMessage: "Bad value",
        errorStyle: "information",
        showError: false,
      };
      const nested = scriptRuleToDataValidation(full);
      const back = dataValidationToScriptRule(nested);
      expect(back).not.toBeNull();
      // The read-back is a legal write again (the shape contract).
      expect(checkValidationRule(back as ScriptValidationRule)).toBe(true);
      expect(back).toMatchObject({
        type: full.type,
        ignoreBlanks: false,
        inputTitle: "Pick",
        inputMessage: "Please",
        showInput: true,
        errorTitle: "No",
        errorMessage: "Bad value",
        errorStyle: "information",
        showError: false,
      });
      if (full.operator) expect((back as ScriptValidationRule).operator).toBe(full.operator);
      if (full.formula1 !== undefined) expect((back as ScriptValidationRule).formula1).toBe(full.formula1);
      if (full.formula2 !== undefined) expect((back as ScriptValidationRule).formula2).toBe(full.formula2);
      if (full.formula) expect((back as ScriptValidationRule).formula).toBe(full.formula);
      if (full.values) expect((back as ScriptValidationRule).values).toEqual(full.values);
      if (full.sourceRange) expect((back as ScriptValidationRule).sourceRange).toEqual(full.sourceRange);
      if (full.inCellDropdown !== undefined) {
        expect((back as ScriptValidationRule).inCellDropdown).toBe(full.inCellDropdown);
      }
    },
  );

  it("defaults land exactly like the dialog's: stop / show / ignore blanks", () => {
    const nested = scriptRuleToDataValidation({ type: "custom", formula: "=1" });
    expect(nested.errorAlert).toEqual({ title: "", message: "", style: "stop", showAlert: true });
    expect(nested.prompt).toEqual({ title: "", message: "", showPrompt: false });
    expect(nested.ignoreBlanks).toBe(true);
    // Giving a prompt message flips showPrompt on without an explicit flag.
    expect(
      scriptRuleToDataValidation({ type: "custom", formula: "=1", inputMessage: "hi" }).prompt
        .showPrompt,
    ).toBe(true);
  });

  it("a stored 'none' rule reads back as null (no rule to report)", () => {
    expect(
      dataValidationToScriptRule({
        rule: { none: true },
        errorAlert: { title: "", message: "", style: "stop", showAlert: true },
        prompt: { title: "", message: "", showPrompt: false },
        ignoreBlanks: true,
      }),
    ).toBeNull();
  });
});

// ============================================================================
// (3) executors: exact payloads over the mocked lib
// ============================================================================

describe("data validation executors", () => {
  it("set: sheet NAME resolves; the nested payload crosses; errors throw", async () => {
    const lib = makeLib();
    const rule: ScriptValidationRule = { type: "list", values: ["A", "B"] };
    await executeSetDataValidation(asLib(lib), 1, 2, 10, 2, rule, "Inputs");
    expect(lib.setDataValidation).toHaveBeenCalledWith(
      1, 2, 10, 2, scriptRuleToDataValidation(rule), 1,
    );
    lib.setDataValidation.mockResolvedValueOnce({
      success: false, validation: null, error: "Sheet index 9 out of range",
    });
    await expect(
      executeSetDataValidation(asLib(lib), 0, 0, 0, 0, rule, undefined),
    ).rejects.toThrow(/out of range/);
  });

  it("clear: the rectangle unpacks positionally; active = undefined sheet", async () => {
    const lib = makeLib();
    await executeClearDataValidation(asLib(lib), { startRow: 0, startCol: 1, endRow: 5, endCol: 3 });
    expect(lib.clearDataValidation).toHaveBeenCalledWith(0, 1, 5, 3, undefined);
  });

  it("get: null passes through; a rule maps to the flat shape", async () => {
    const lib = makeLib();
    expect(await executeGetDataValidation(asLib(lib), 2, 2)).toBeNull();
    lib.getDataValidation.mockResolvedValueOnce({
      rule: { custom: { formula: "=A1" } },
      errorAlert: { title: "t", message: "m", style: "stop", showAlert: true },
      prompt: { title: "", message: "", showPrompt: false },
      ignoreBlanks: true,
    });
    const flat = await executeGetDataValidation(asLib(lib), 2, 2, "Inputs");
    expect(lib.getDataValidation).toHaveBeenLastCalledWith(2, 2, 1);
    expect(flat).toMatchObject({ type: "custom", formula: "=A1", errorTitle: "t" });
  });

  it("list: every stored range maps, rectangle + flat rule", async () => {
    const lib = makeLib();
    lib.getAllDataValidations.mockResolvedValueOnce([
      {
        startRow: 0, startCol: 0, endRow: 9, endCol: 0,
        validation: {
          rule: { wholeNumber: { formula1: 1, formula2: 5, operator: "between" } },
          errorAlert: { title: "", message: "", style: "stop", showAlert: true },
          prompt: { title: "", message: "", showPrompt: false },
          ignoreBlanks: true,
        },
      },
    ]);
    const out = await executeListDataValidations(asLib(lib), 1);
    expect(lib.getAllDataValidations).toHaveBeenCalledWith(1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      startRow: 0, endRow: 9,
      rule: { type: "wholeNumber", operator: "between", formula1: 1, formula2: 5 },
    });
  });
});

// ============================================================================
// (4) allowlist classification
// ============================================================================

describe("allowlist rows", () => {
  it("unlocked tier, no capability, honestly classed, right validators", () => {
    expect(ALLOWLIST["api.setDataValidation"]).toMatchObject({ tier: "unlocked", class: "mutate" });
    expect(ALLOWLIST["api.setDataValidation"].validate).toBe(vDataValidationSet);
    expect(ALLOWLIST["api.clearDataValidation"]).toMatchObject({ tier: "unlocked", class: "mutate" });
    expect(ALLOWLIST["api.clearDataValidation"].validate).toBe(vDataValidationClear);
    expect(ALLOWLIST["api.getDataValidation"]).toMatchObject({ tier: "unlocked", class: "read" });
    expect(ALLOWLIST["api.getDataValidation"].validate).toBe(vCellRef);
    expect(ALLOWLIST["api.listDataValidations"]).toMatchObject({ tier: "unlocked", class: "read" });
    expect(ALLOWLIST["api.listDataValidations"].validate).toBe(vSheetScopedList);
    for (const m of [
      "api.setDataValidation", "api.clearDataValidation",
      "api.getDataValidation", "api.listDataValidations",
    ]) {
      expect(ALLOWLIST[m].capability, m).toBeUndefined();
    }
  });
});
