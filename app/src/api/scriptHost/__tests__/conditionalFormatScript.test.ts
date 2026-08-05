//! FILENAME: app/src/api/scriptHost/__tests__/conditionalFormatScript.test.ts
// PURPOSE: Wave 3 item 3 — conditional-formatting CRUD script reach.
// COVERS:  (1) the vCFSpec / vCFUpdate / vCFRuleId / vCFList / vCFClear
//              validator matrices, including EVERY rule kind of the serde
//              union (a drift check pins the test table to CF_RULE_KINDS);
//          (2) the ALLOWLIST rows' tier/class/validator wiring;
//          (3) the HOST executor (executeConditionalFormat) against a mocked
//              ../backend: every rule kind round-trips through the wrapper
//              byte-for-byte, the active-sheet slot REFUSES a foreign sheet
//              (the flagged integrator seam), clear-with-no-range spells the
//              whole sheet, and backend failures surface as rejections;
//          (4) the WORKER shim: ranges spelled in A1 resolve worker-side to
//              numeric boxes (Wave-1 style), and a "Sheet!" prefix is REFUSED
//              rather than silently dropped;
//          (5) the generated typings declare the authoring surface.

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { ALLOWLIST } from "../allowlist";
import {
  vCFSpec,
  vCFUpdate,
  vCFRuleId,
  vCFList,
  vCFClear,
  CF_RULE_KINDS,
  CF_FORMAT_KEYS,
  MAX_CF_RANGES,
  checkCFRule,
  checkCFFormat,
} from "../validators";
import { buildWorkerContext, type WorkerRuntime } from "../worker/contextShims";
import type { MountSpec, W2H } from "../protocol";
import { onAppEvent, AppEvents } from "../../events";

vi.mock("../../backend", () => ({
  addConditionalFormat: vi.fn(),
  updateConditionalFormat: vi.fn(),
  deleteConditionalFormat: vi.fn(),
  getAllConditionalFormats: vi.fn(),
  clearConditionalFormatsInRange: vi.fn(),
}));
vi.mock("../../lib", () => ({
  getActiveSheet: vi.fn(async () => 0),
  getSheets: vi.fn(async () => ({
    sheets: [
      { index: 0, name: "Alpha" },
      { index: 1, name: "Beta" },
    ],
    activeIndex: 0,
  })),
}));

import * as backend from "../../backend";
import { executeConditionalFormat } from "../host";

const mocked = backend as unknown as Record<string, ReturnType<typeof vi.fn>>;

// ============================================================================
// One canonical VALID rule per serde kind. The drift check below pins this
// table to CF_RULE_KINDS, so adding a backend variant without extending the
// validator (or this matrix) fails loudly.
// ============================================================================

const VALID_RULES: Record<string, Record<string, unknown>> = {
  colorScale: {
    type: "colorScale",
    minPoint: { valueType: "min", color: "#F8696B" },
    midPoint: { valueType: "percentile", value: 50, color: "#FFEB84" },
    maxPoint: { valueType: "max", color: "#63BE7B" },
  },
  dataBar: {
    type: "dataBar",
    minValueType: "autoMin",
    maxValueType: "autoMax",
    fillColor: "#638EC6",
    negativeFillColor: "#FF0000",
    axisColor: "#000000",
    axisPosition: "automatic",
    direction: "context",
    showValue: true,
    gradientFill: true,
  },
  iconSet: {
    type: "iconSet",
    iconSet: "threeTrafficLights1",
    thresholds: [
      { valueType: "percent", value: 33, operator: "greaterThanOrEqual" },
      { valueType: "percent", value: 67, operator: "greaterThanOrEqual" },
    ],
    reverseIcons: false,
    showIconOnly: false,
  },
  cellValue: { type: "cellValue", operator: "between", value1: "10", value2: "20" },
  containsText: { type: "containsText", ruleType: "beginsWith", text: "ERR" },
  topBottom: { type: "topBottom", ruleType: "topPercent", rank: 10 },
  aboveAverage: { type: "aboveAverage", ruleType: "twoStdDevAbove" },
  duplicateValues: { type: "duplicateValues" },
  uniqueValues: { type: "uniqueValues" },
  expression: { type: "expression", formula: "=MOD(ROW(),2)=0" },
  blankCells: { type: "blankCells" },
  noBlanks: { type: "noBlanks" },
  errorCells: { type: "errorCells" },
  noErrors: { type: "noErrors" },
  timePeriod: { type: "timePeriod", period: "lastWeek" },
};

const RANGES = [{ startRow: 1, startCol: 1, endRow: 99, endCol: 3 }];

function specFor(kind: string): Record<string, unknown> {
  return {
    rule: VALID_RULES[kind],
    format: { bold: true, backgroundColor: "#FFC7CE" },
    ranges: RANGES,
  };
}

// ============================================================================
// (1) validators
// ============================================================================

describe("vCFSpec: the rule-kind matrix", () => {
  it("the test table covers EXACTLY the serde union (drift check)", () => {
    expect(Object.keys(VALID_RULES).sort()).toEqual([...CF_RULE_KINDS].sort());
  });

  it("accepts a canonical spec for EVERY rule kind", () => {
    for (const kind of CF_RULE_KINDS) {
      expect(vCFSpec([specFor(kind)]), kind).toBe(true);
    }
  });

  it("rejects an unknown rule type WITH the accepted list", () => {
    const verdict = checkCFRule({ type: "rainbow" });
    expect(verdict).toContain("colorScale");
    expect(verdict).toContain("timePeriod");
  });

  it("rejects an unknown key on a rule WITH the accepted list (per kind)", () => {
    const rule = { ...VALID_RULES.cellValue, colour: "#FF0000" };
    const verdict = checkCFRule(rule);
    expect(verdict).toContain('unknown cellValue property "colour"');
    expect(verdict).toContain("operator");
  });

  it("rejects extra keys on a parameter-free kind", () => {
    expect(checkCFRule({ type: "duplicateValues", extra: 1 })).toContain(
      'unknown duplicateValues property "extra"',
    );
  });

  it("rejects a missing/invalid required field per kind", () => {
    expect(checkCFRule({ type: "colorScale", minPoint: VALID_RULES.colorScale.minPoint })).not.toBe(true);
    expect(checkCFRule({ ...VALID_RULES.dataBar, direction: "up" })).toContain("dataBar.direction");
    expect(checkCFRule({ ...VALID_RULES.iconSet, iconSet: "sixArrows" })).toContain("iconSet.iconSet");
    expect(checkCFRule({ ...VALID_RULES.cellValue, operator: ">" })).toContain("cellValue.operator");
    expect(checkCFRule({ ...VALID_RULES.containsText, text: "" })).toContain("containsText.text");
    expect(checkCFRule({ ...VALID_RULES.topBottom, rank: 0 })).toContain("topBottom.rank");
    expect(checkCFRule({ ...VALID_RULES.aboveAverage, ruleType: "median" })).toContain("aboveAverage.ruleType");
    expect(checkCFRule({ ...VALID_RULES.timePeriod, period: "someday" })).toContain("timePeriod.period");
    expect(checkCFRule({ type: "expression", formula: "" })).toContain("expression.formula");
  });

  it("rejects an unknown format key WITH the accepted list, and wrong value types", () => {
    expect(checkCFFormat({ bgColor: "#FFC7CE" })).toContain('unknown format property "bgColor"');
    expect(checkCFFormat({ bold: "yes" })).toContain("bold must be a boolean");
    // CF underline is a BOOLEAN (mirrors the backend), unlike setRangeFormat's.
    expect(checkCFFormat({ underline: true })).toBe(true);
    expect(checkCFFormat({ underline: "single" })).toContain("underline must be a boolean");
    expect(CF_FORMAT_KEYS.has("numberFormat")).toBe(true);
  });

  it("rejects bad ranges: empty, non-normalized, unknown keys, too many", () => {
    const base = specFor("cellValue");
    expect(vCFSpec([{ ...base, ranges: [] }])).toContain("non-empty array");
    expect(
      vCFSpec([{ ...base, ranges: [{ startRow: 5, startCol: 0, endRow: 1, endCol: 0 }] }]),
    ).toContain("normalized");
    expect(
      vCFSpec([{ ...base, ranges: [{ startRow: 0, startCol: 0, endRow: 1, endCol: 1, sheet: 2 }] }]),
    ).toContain('unknown ranges[0] property "sheet"');
    const many = Array.from({ length: MAX_CF_RANGES + 1 }, () => RANGES[0]);
    expect(vCFSpec([{ ...base, ranges: many }])).toContain(`max ${MAX_CF_RANGES}`);
  });

  it("rejects an unknown SPEC key and a non-boolean stopIfTrue", () => {
    expect(vCFSpec([{ ...specFor("cellValue"), priority: 1 }])).toContain('unknown spec property "priority"');
    expect(vCFSpec([{ ...specFor("cellValue"), stopIfTrue: "yes" }])).toContain("stopIfTrue must be a boolean");
    expect(vCFSpec([null])).toContain("spec object");
  });
});

describe("vCFUpdate / vCFRuleId / vCFList / vCFClear", () => {
  it("vCFUpdate accepts partial patches and requires at least one key", () => {
    expect(vCFUpdate([3, { enabled: false }])).toBe(true);
    expect(vCFUpdate([3, { format: { italic: true } }])).toBe(true);
    expect(vCFUpdate([3, { rule: VALID_RULES.expression, ranges: RANGES, stopIfTrue: true }])).toBe(true);
    expect(vCFUpdate([3, {}])).toContain("at least one");
    expect(vCFUpdate([3, { priority: 2 }])).toContain('unknown patch property "priority"');
    expect(vCFUpdate([3, { rule: { type: "rainbow" } }])).toContain("rule.type");
    expect(vCFUpdate(["3", { enabled: true }])).toContain("ruleId");
  });

  it("vCFRuleId takes a non-negative integer only", () => {
    expect(vCFRuleId([0])).toBe(true);
    expect(vCFRuleId([42])).toBe(true);
    for (const bad of [-1, 1.5, "7", null, undefined]) {
      expect(vCFRuleId([bad]), String(bad)).toContain("ruleId");
    }
  });

  it("vCFList / vCFClear accept the optional sheet slot (index or name)", () => {
    expect(vCFList([])).toBe(true);
    expect(vCFList([1])).toBe(true);
    expect(vCFList(["Beta"])).toBe(true);
    expect(vCFList([true])).not.toBe(true);
    expect(vCFClear([])).toBe(true);
    expect(vCFClear([null, "Beta"])).toBe(true);
    expect(vCFClear([{ startRow: 0, startCol: 0, endRow: 9, endCol: 9 }])).toBe(true);
    expect(vCFClear([{ startRow: 9, startCol: 0, endRow: 0, endCol: 9 }])).toContain("normalized");
    expect(vCFClear([{ startRow: 0, startCol: 0, endRow: 9, endCol: 9 }, {}])).not.toBe(true);
  });
});

// ============================================================================
// (2) allowlist wiring
// ============================================================================

const CF_METHODS = [
  "api.listConditionalFormats",
  "api.addConditionalFormat",
  "api.updateConditionalFormat",
  "api.deleteConditionalFormat",
  "api.clearConditionalFormats",
] as const;

describe("conditional-formatting allowlist rows", () => {
  it("all five rows exist at the unlocked tier with NO capability", () => {
    for (const m of CF_METHODS) {
      expect(ALLOWLIST[m], m).toBeDefined();
      expect(ALLOWLIST[m].tier, m).toBe("unlocked");
      expect(ALLOWLIST[m].capability, m).toBeUndefined();
    }
  });

  it("list is a read; the other four are mutates", () => {
    expect(ALLOWLIST["api.listConditionalFormats"].class).toBe("read");
    for (const m of CF_METHODS.slice(1)) {
      expect(ALLOWLIST[m].class, m).toBe("mutate");
    }
  });

  it("each row is wired to its own validator (not vAny)", () => {
    expect(ALLOWLIST["api.listConditionalFormats"].validate).toBe(vCFList);
    expect(ALLOWLIST["api.addConditionalFormat"].validate).toBe(vCFSpec);
    expect(ALLOWLIST["api.updateConditionalFormat"].validate).toBe(vCFUpdate);
    expect(ALLOWLIST["api.deleteConditionalFormat"].validate).toBe(vCFRuleId);
    expect(ALLOWLIST["api.clearConditionalFormats"].validate).toBe(vCFClear);
  });
});

// ============================================================================
// (3) host executor over a mocked backend
// ============================================================================

describe("executeConditionalFormat", () => {
  beforeEach(() => {
    for (const fn of Object.values(mocked)) fn.mockReset?.();
    mocked.addConditionalFormat.mockImplementation(async (params: Record<string, unknown>) => ({
      success: true,
      rule: { id: 7, priority: 1, enabled: true, ...params },
    }));
    mocked.updateConditionalFormat.mockImplementation(async (params: { ruleId: number }) => ({
      success: true,
      rule: { id: params.ruleId },
    }));
    mocked.deleteConditionalFormat.mockResolvedValue({ success: true });
    mocked.getAllConditionalFormats.mockResolvedValue([{ id: 1 }]);
    mocked.clearConditionalFormatsInRange.mockResolvedValue(2);
  });

  it("EVERY rule kind round-trips through the wrapper byte-for-byte", async () => {
    for (const kind of CF_RULE_KINDS) {
      mocked.addConditionalFormat.mockClear();
      const spec = specFor(kind);
      const result = (await executeConditionalFormat("api.addConditionalFormat", [spec])) as {
        rule: unknown;
      };
      expect(mocked.addConditionalFormat, kind).toHaveBeenCalledWith({
        rule: spec.rule,
        format: spec.format,
        ranges: spec.ranges,
        stopIfTrue: false,
      });
      // The stored rule comes back with the SAME rule payload the script sent.
      expect(result.rule, kind).toEqual(spec.rule);
    }
  });

  it("add announces the CF-changed app event (the extension's repaint hook)", async () => {
    const seen: unknown[] = [];
    const off = onAppEvent(AppEvents.CONDITIONAL_FORMATS_CHANGED, (d) => seen.push(d));
    await executeConditionalFormat("api.addConditionalFormat", [specFor("cellValue")]);
    off();
    expect(seen.length).toBe(1);
  });

  it("add surfaces a backend refusal as a rejection", async () => {
    mocked.addConditionalFormat.mockResolvedValue({ success: false, error: "boom" });
    await expect(
      executeConditionalFormat("api.addConditionalFormat", [specFor("cellValue")]),
    ).rejects.toThrow("boom");
  });

  it("list: the sheet slot resolves by Wave-1 name/index and reaches the backend", async () => {
    await expect(executeConditionalFormat("api.listConditionalFormats", [])).resolves.toEqual([
      { id: 1 },
    ]);
    expect(mocked.getAllConditionalFormats).toHaveBeenLastCalledWith(undefined);
    await expect(
      executeConditionalFormat("api.listConditionalFormats", ["Alpha"]),
    ).resolves.toEqual([{ id: 1 }]);
    expect(mocked.getAllConditionalFormats).toHaveBeenLastCalledWith(0);
    // A NON-ACTIVE sheet is honored now (conditional_formatting.rs takes
    // sheetIndex) — resolved by name to its index, not refused.
    await expect(
      executeConditionalFormat("api.listConditionalFormats", ["Beta"]),
    ).resolves.toEqual([{ id: 1 }]);
    expect(mocked.getAllConditionalFormats).toHaveBeenLastCalledWith(1);
    // An unknown sheet still refuses with the sheet roster spelled out.
    await expect(
      executeConditionalFormat("api.listConditionalFormats", ["Gamma"]),
    ).rejects.toThrow('no sheet named "Gamma"');
  });

  it("update passes { ruleId, ...patch } through and returns the updated rule", async () => {
    const patch = { enabled: false, format: { italic: true } };
    const result = await executeConditionalFormat("api.updateConditionalFormat", [9, patch]);
    expect(mocked.updateConditionalFormat).toHaveBeenCalledWith({ ruleId: 9, ...patch });
    expect(result).toEqual({ id: 9 });
  });

  it("update/delete surface 'rule not found' as rejections", async () => {
    mocked.updateConditionalFormat.mockResolvedValue({ success: false, error: "Rule not found" });
    await expect(
      executeConditionalFormat("api.updateConditionalFormat", [99, { enabled: true }]),
    ).rejects.toThrow("Rule not found");
    mocked.deleteConditionalFormat.mockResolvedValue({ success: false, error: "Rule not found" });
    await expect(executeConditionalFormat("api.deleteConditionalFormat", [99])).rejects.toThrow(
      "Rule not found",
    );
  });

  it("clear with a range forwards it; with none it spells the WHOLE sheet", async () => {
    await expect(
      executeConditionalFormat("api.clearConditionalFormats", [
        { startRow: 0, startCol: 0, endRow: 9, endCol: 3 },
      ]),
    ).resolves.toEqual({ count: 2 });
    expect(mocked.clearConditionalFormatsInRange).toHaveBeenCalledWith(0, 0, 9, 3, undefined);

    mocked.clearConditionalFormatsInRange.mockClear();
    await executeConditionalFormat("api.clearConditionalFormats", [null]);
    expect(mocked.clearConditionalFormatsInRange).toHaveBeenCalledWith(
      0, 0, 10_000_000, 10_000_000, undefined,
    );
  });

  it("clear honors a non-active sheet through the resolved slot", async () => {
    await expect(
      executeConditionalFormat("api.clearConditionalFormats", [null, 1]),
    ).resolves.toEqual({ count: 2 });
    expect(mocked.clearConditionalFormatsInRange).toHaveBeenLastCalledWith(
      0, 0, 10_000_000, 10_000_000, 1,
    );
    await expect(
      executeConditionalFormat("api.clearConditionalFormats", [null, "Beta"]),
    ).resolves.toEqual({ count: 2 });
    expect(mocked.clearConditionalFormatsInRange).toHaveBeenLastCalledWith(
      0, 0, 10_000_000, 10_000_000, 1,
    );
    await expect(
      executeConditionalFormat("api.clearConditionalFormats", [null, 7]),
    ).rejects.toThrow("no sheet with index 7");
  });
});

// ============================================================================
// (4) worker shim: A1-or-numbers ranges resolve WORKER-side
// ============================================================================

interface PostedCall {
  callId: number;
  method: string;
  args: unknown[];
}

function makeContext(): {
  api: Record<string, unknown>;
  rt: WorkerRuntime;
  calls: PostedCall[];
  drain: () => void;
} {
  const calls: PostedCall[] = [];
  const spec = {
    protocolVersion: 1,
    scriptId: "wave3-cf-test",
    objectType: "sheet",
    instanceId: null,
    tier: "unlocked",
    capabilities: [],
    apiVersion: "1.0.0",
    scriptName: "Wave3CF",
    packageInfo: null,
    snapshot: {},
    source: "",
  } as unknown as MountSpec;
  const { context, rt } = buildWorkerContext(spec, (msg: W2H) => {
    if (msg.t === "call") calls.push({ callId: msg.callId, method: msg.method, args: msg.args });
  });
  const drain = (): void => {
    for (const entry of rt.pending.values()) clearTimeout(entry.timer);
    rt.pending.clear();
  };
  return { api: context.api as Record<string, unknown>, rt, calls, drain };
}

describe("worker shim: conditional formatting", () => {
  it("addConditionalFormat resolves A1 range spellings to numeric boxes", () => {
    const { api, calls, drain } = makeContext();
    void (api.addConditionalFormat as (s: unknown) => Promise<unknown>)({
      rule: VALID_RULES.cellValue,
      format: { bold: true },
      ranges: ["B2:D10", { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }],
    });
    expect(calls[0].method).toBe("api.addConditionalFormat");
    expect((calls[0].args[0] as { ranges: unknown }).ranges).toEqual([
      { startRow: 1, startCol: 1, endRow: 9, endCol: 3 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
    ]);
    drain();
  });

  it("a 'Sheet!' prefix on a CF range is REFUSED, not silently dropped", () => {
    const { api, drain } = makeContext();
    expect(() =>
      (api.addConditionalFormat as (s: unknown) => Promise<unknown>)({
        rule: VALID_RULES.cellValue,
        format: { bold: true },
        ranges: ["Data!A1:A5"],
      }),
    ).toThrow("active-sheet scoped");
    drain();
  });

  it("clearConditionalFormats resolves an A1 argument and forwards the sheet slot", () => {
    const { api, calls, drain } = makeContext();
    void (api.clearConditionalFormats as (...a: unknown[]) => Promise<unknown>)("A1:C3", "Alpha");
    void (api.clearConditionalFormats as (...a: unknown[]) => Promise<unknown>)();
    expect(calls.map((c) => [c.method, ...c.args])).toEqual([
      ["api.clearConditionalFormats", { startRow: 0, startCol: 0, endRow: 2, endCol: 2 }, "Alpha"],
      ["api.clearConditionalFormats", null, undefined],
    ]);
    drain();
  });

  it("list / update / delete dispatch verbatim", () => {
    const { api, calls, drain } = makeContext();
    void (api.listConditionalFormats as (...a: unknown[]) => Promise<unknown>)("Alpha");
    void (api.updateConditionalFormat as (...a: unknown[]) => Promise<unknown>)(4, {
      enabled: false,
      ranges: ["A1"],
    });
    void (api.deleteConditionalFormat as (...a: unknown[]) => Promise<unknown>)(4);
    expect(calls.map((c) => [c.method, ...c.args])).toEqual([
      ["api.listConditionalFormats", "Alpha"],
      [
        "api.updateConditionalFormat",
        4,
        { enabled: false, ranges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }] },
      ],
      ["api.deleteConditionalFormat", 4],
    ]);
    drain();
  });
});

// ============================================================================
// (5) generated typings declare the authoring surface
// ============================================================================

describe("generated typings", () => {
  const typingsSrc = fs.readFileSync(
    path.resolve(__dirname, "../../../../extensions/ScriptableObjects/objectContexts.d.ts"),
    "utf8",
  );

  it("declare the five CF methods and the rule union", () => {
    expect(typingsSrc).toContain("listConditionalFormats(sheet?: SheetRef)");
    expect(typingsSrc).toContain("addConditionalFormat(spec: {");
    expect(typingsSrc).toContain("updateConditionalFormat(ruleId: number, patch: {");
    expect(typingsSrc).toContain("deleteConditionalFormat(ruleId: number)");
    expect(typingsSrc).toContain("clearConditionalFormats(range?: ScriptCFRangeInput | null");
    expect(typingsSrc).toContain("declare type ScriptCFRule =");
    // Spot-check the union's kinds against the validator's set.
    for (const kind of ["colorScale", "dataBar", "iconSet", "cellValue", "topBottom"]) {
      expect(CF_RULE_KINDS.has(kind), kind).toBe(true);
      expect(typingsSrc).toContain(`"${kind}"`);
    }
  });
});
