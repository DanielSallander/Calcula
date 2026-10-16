//! FILENAME: app/src/api/scriptHost/__tests__/scriptObjectHandleDoor.test.ts
// PURPOSE: The EXECUTOR half of the script object handle (D-BIND §3.19):
//          `context.self` / `api.object(kind, id)` reach a bindable object's
//          properties through @api/objectBindings, and the gates that need
//          STATE live here -- the object's real kind, the restricted-tier
//          clamp, and `bi.query` for a formula that reads the model.
// CONTEXT: THE EXECUTOR IS THE GATE. `BindingEditSource` is sent from the
//          renderer, so Rust's re-check of a call labelled "restricted script"
//          is defence in depth only (D §3.9). These tests drive the executors
//          against the REAL seam with the backend (`invokeBackend`) doubled
//          per `object_bindings` op, so what Rust is asked is asserted, and
//          what it is NOT asked (a refused bind sends no `set`) too.
//
//          The last block is the round trip: the real worker shim builds the
//          envelope, the real broker policy (`decidePolicy`, with vSetState's
//          rows) admits it, and the executor answers the shim's promise.
//
//          SABOTAGE (run 2026-10-15): drop the `analysis.measureRefs.length > 0`
//          test from executeBindingSetAspect -> the two bi.query cases go red
//          (the bind reaches Rust); drop `analysis.usesNames` from the clamp ->
//          "names refused" goes red.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type BindingRequest = { op: string; [k: string]: unknown };

/** Every `object_bindings` request the seam sent, in order. */
const sent: BindingRequest[] = [];
/** What the doubled backend answers per op (a function may throw a refusal). */
let answer: (req: BindingRequest) => unknown = () => ({ kind: "ack" });

const invokeBackend = vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
  if (cmd === "object_bindings") {
    const req = (args as { request: BindingRequest }).request;
    sent.push(req);
    if (req.op === "setPageFilters") return { kind: "ack" };
    return answer(req);
  }
  return null;
});
vi.mock("../../backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../backend")>()),
  invokeBackend: (cmd: string, args?: Record<string, unknown>) => invokeBackend(cmd, args),
}));

let activeSheet = 0;
vi.mock("../../lib", () => ({
  getActiveSheet: vi.fn(async () => activeSheet),
}));

const requestCapabilityGrant = vi.fn(async (..._a: unknown[]): Promise<string> => "deny");
vi.mock("../capabilities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capabilities")>()),
  requestCapabilityGrant: (...a: unknown[]) => requestCapabilityGrant(...a),
}));

import {
  executeBindingGetAspect,
  executeBindingSetAspect,
  requireExecutorCapability,
  RESTRICTED_BINDING_CLAMP_MESSAGE,
  RESTRICTED_SHEET_CLAMP_MESSAGE,
  type ResolvedBindingAspectTarget,
} from "../host";
import { BrokerError } from "../broker";
import { getGrantSet, revokeScriptGrants } from "../capabilities";
import type { CapabilityId } from "../capabilityIds";
import { decidePolicy } from "../brokerPolicy";
import { buildWorkerContext } from "../worker/contextShims";
import type { MountSpec, W2H } from "../protocol";
import { registerBindableProperties } from "../../objectBindings";
import type { BindingFormulaAnalysis, ObjectBindingInfo, ObjectBindingRef } from "../../types";

const CHART_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const INPUTS = 2;

function analysis(over: Partial<BindingFormulaAnalysis> = {}): BindingFormulaAnalysis {
  return {
    normalized: "=Inputs!B1",
    displayNormalized: "=Inputs!B1",
    sheets: [INPUTS],
    usesNames: false,
    usesTableRefs: false,
    usesIndirect: false,
    usesCube: false,
    measureRefs: [],
    model: null,
    error: null,
    warning: null,
    ...over,
  };
}

function bindingInfo(object: ObjectBindingRef, path: string, formula: string): ObjectBindingInfo {
  return { object, path, formula, displayFormula: formula, model: null, resolved: null };
}

/** The backend answering every op as Rust would for an accepted call. */
function acceptAll(a: BindingFormulaAnalysis): (req: BindingRequest) => unknown {
  return (req) => {
    switch (req.op) {
      case "analyze":
        return { kind: "analysis", analysis: a };
      case "set":
        return { kind: "binding", binding: bindingInfo(req.object as ObjectBindingRef, req.path as string, req.formula as string) };
      case "clear":
        return { kind: "cleared", removed: true };
      case "setLiteral":
        return { kind: "literalSet", domains: ["objects"] };
      case "objectJson":
        return { kind: "objectJson", json: { spec: { title: "Literal title", xAxis: { min: 0 } } } };
      default:
        return { kind: "ack" };
    }
  };
}

let seq = 0;
/** A mounted worker's identity, as the executors read it. */
function worker(opts: {
  tier: "restricted" | "unlocked";
  origin?: "local" | "package";
  declared?: CapabilityId[];
  granted?: CapabilityId[];
  objectType?: string;
  instanceId?: string | null;
}) {
  const scriptId = `s9-door-${++seq}`;
  const grants = getGrantSet(scriptId);
  for (const cap of opts.granted ?? []) grants.add(cap);
  return {
    handle: {
      scriptId,
      scriptName: "Door test",
      tier: opts.tier,
      objectType: opts.objectType ?? "chart",
      instanceId: opts.instanceId ?? CHART_ID,
      origin: opts.origin === "package" ? { kind: "package" as const, name: "Acme Report" } : { kind: "local" as const },
      grants,
      declaredCapabilities: new Set<CapabilityId>(opts.declared ?? []),
    },
    definition: {
      id: scriptId,
      name: "Door test",
      objectType: opts.objectType ?? "chart",
      instanceId: opts.instanceId ?? CHART_ID,
      source: "export function setup(context) {}",
    },
  } as unknown as Parameters<typeof executeBindingSetAspect>[0];
}

const chartViaApi: ResolvedBindingAspectTarget = { objectType: "chart", instanceId: CHART_ID, door: "api" };
const chartOwn: ResolvedBindingAspectTarget = { objectType: "chart", instanceId: CHART_ID, door: "own" };

function opsSent(): string[] {
  return sent.filter((r) => r.op !== "setPageFilters").map((r) => r.op);
}

beforeEach(() => {
  sent.length = 0;
  activeSheet = 0;
  answer = acceptAll(analysis());
  requestCapabilityGrant.mockReset();
  requestCapabilityGrant.mockResolvedValue("deny");
});

afterEach(() => {
  for (let i = 1; i <= seq; i++) revokeScriptGrants(`s9-door-${i}`);
});

// ============================================================================
// binding.set: the object, the analysis, bi.query, the restricted clamp
// ============================================================================

describe("bindProperty through the executor", () => {
  it("an unlocked script binds another object's property: invariant, labelled as the script", async () => {
    const mw = worker({ tier: "unlocked" });
    await executeBindingSetAspect(mw, chartViaApi, "binding.set", ["/spec/title", "=Inputs!B1"]);
    expect(opsSent()).toEqual(["analyze", "set"]);
    const analyze = sent.find((r) => r.op === "analyze")!;
    expect(analyze).toMatchObject({ object: { kind: "chart", id: CHART_ID }, formula: "=Inputs!B1", invariant: true, model: null });
    const set = sent.find((r) => r.op === "set")!;
    expect(set).toMatchObject({
      object: { kind: "chart", id: CHART_ID },
      path: "/spec/title",
      formula: "=Inputs!B1",
      invariant: true,
      source: { kind: "script", scriptId: mw.handle.scriptId, unlocked: true },
    });
    // The page-filter snapshot goes first (the seam's belt and braces).
    expect(sent.findIndex((r) => r.op === "setPageFilters")).toBeLessThan(sent.findIndex((r) => r.op === "set"));
  });

  it("the model the script names is analysed AND bound (a two-model page refuses an unnamed [Measure])", async () => {
    answer = acceptAll(analysis({ sheets: [], measureRefs: ["Revenue"], model: "second-model" }));
    const mw = worker({ tier: "unlocked", declared: ["bi.query"], granted: ["bi.query"] });
    await executeBindingSetAspect(mw, chartViaApi, "binding.set", ["/spec/title", "=[Revenue]", { model: "second-model" }]);
    expect(sent.find((r) => r.op === "analyze")).toMatchObject({ model: "second-model" });
    expect(sent.find((r) => r.op === "set")).toMatchObject({ model: "second-model" });
  });

  it("a formula Rust's analysis refuses is refused with Rust's sentence, and nothing is set", async () => {
    answer = acceptAll(analysis({ error: "There is no measure [Profit] in model 'aw-model'. Its measures: Revenue." }));
    const refused = executeBindingSetAspect(worker({ tier: "unlocked" }), chartViaApi, "binding.set", ["/spec/title", "=[Profit]"]);
    await expect(refused).rejects.toBeInstanceOf(BrokerError);
    await expect(refused).rejects.toMatchObject({ code: "ValidationError", message: expect.stringMatching(/no measure \[Profit\]/) });
    expect(opsSent()).toEqual(["analyze"]);
  });

  it("a path the REAL kind's catalog does not list is refused before Rust is asked", async () => {
    // vSetState admitted it (a chart lists /spec/title); a slicer does not.
    const slicer: ResolvedBindingAspectTarget = { objectType: "slicer", instanceId: "7", door: "api" };
    const refused = executeBindingSetAspect(worker({ tier: "unlocked" }), slicer, "binding.set", ["/spec/title", "=A1"]);
    await expect(refused).rejects.toMatchObject({
      code: "ValidationError",
      message: expect.stringMatching(/not a bindable property of a slicer/),
    });
    expect(opsSent()).toEqual([]);
  });

  it("Rust's own refusal (a protected sheet) reaches the script as its sentence", async () => {
    answer = (req) => {
      if (req.op === "set") throw "Bind is refused: the sheet is protected and editing objects is not allowed.";
      return acceptAll(analysis())(req);
    };
    const refused = executeBindingSetAspect(worker({ tier: "unlocked" }), chartViaApi, "binding.set", ["/spec/title", "=Inputs!B1"]);
    await expect(refused).rejects.toMatchObject({
      code: "ValidationError",
      message: "Bind is refused: the sheet is protected and editing objects is not allowed.",
    });
  });
});

describe("a RESTRICTED script may bind only to cells on the sheet in front of the user", () => {
  it("the sentence is Rust's RESTRICTED_BINDING_CLAMP_MESSAGE, word for word", async () => {
    expect(RESTRICTED_BINDING_CLAMP_MESSAGE.startsWith(RESTRICTED_SHEET_CLAMP_MESSAGE)).toBe(true);
    const nodeFs = await import("fs");
    const nodePath = await import("path");
    const rust = nodeFs.readFileSync(
      nodePath.resolve(__dirname, "../../../../src-tauri/src/object_bindings/mod.rs"),
      "utf8",
    );
    const m = /pub const RESTRICTED_BINDING_CLAMP_MESSAGE: &str = "((?:[^"\\]|\\[\s\S])*)";/.exec(rust);
    expect(m, "RESTRICTED_BINDING_CLAMP_MESSAGE not found in object_bindings/mod.rs").not.toBeNull();
    // A Rust string continuation (`\` + newline + leading spaces) joins with nothing.
    const rustText = m![1].replace(/\\\r?\n\s*/g, "");
    expect(RESTRICTED_BINDING_CLAMP_MESSAGE).toBe(rustText);
  });

  it("another sheet is refused (PermissionDenied) and nothing is set", async () => {
    activeSheet = 0;
    answer = acceptAll(analysis({ sheets: [INPUTS] }));
    const refused = executeBindingSetAspect(worker({ tier: "restricted" }), chartOwn, "binding.set", ["/spec/title", "=Inputs!B1"]);
    await expect(refused).rejects.toMatchObject({ code: "PermissionDenied", message: RESTRICTED_BINDING_CLAMP_MESSAGE });
    expect(opsSent()).toEqual(["analyze"]);
  });

  it("the sheet in front of the user is allowed, labelled unlocked: false", async () => {
    activeSheet = INPUTS;
    answer = acceptAll(analysis({ sheets: [INPUTS] }));
    const mw = worker({ tier: "restricted" });
    await executeBindingSetAspect(mw, chartOwn, "binding.set", ["/spec/title", "=Inputs!B1"]);
    expect(sent.find((r) => r.op === "set")).toMatchObject({
      source: { kind: "script", scriptId: mw.handle.scriptId, unlocked: false },
    });
  });

  const indirectReads: Array<[string, Partial<BindingFormulaAnalysis>]> = [
    ["a defined name", { sheets: [], usesNames: true }],
    ["a table reference", { sheets: [], usesTableRefs: true }],
    ["INDIRECT", { sheets: [], usesIndirect: true }],
  ];
  for (const [what, over] of indirectReads) {
    it(`${what} is refused even with no other sheet named`, async () => {
      activeSheet = 0;
      answer = acceptAll(analysis(over));
      const refused = executeBindingSetAspect(worker({ tier: "restricted" }), chartOwn, "binding.set", ["/spec/title", "=X"]);
      await expect(refused).rejects.toMatchObject({ code: "PermissionDenied", message: RESTRICTED_BINDING_CLAMP_MESSAGE });
      expect(opsSent()).toEqual(["analyze"]);
    });
  }

  it("an UNLOCKED script reads any sheet, name, table or INDIRECT", async () => {
    answer = acceptAll(analysis({ sheets: [5], usesNames: true, usesTableRefs: true, usesIndirect: true }));
    await executeBindingSetAspect(worker({ tier: "unlocked" }), chartViaApi, "binding.set", ["/spec/title", "=X"]);
    expect(opsSent()).toEqual(["analyze", "set"]);
  });
});

describe("a formula that reads the MODEL needs bi.query (declared, then granted)", () => {
  const measure = analysis({ sheets: [], measureRefs: ["Revenue"], model: "aw-model" });

  it("undeclared -> PermissionDenied, and nobody is asked", async () => {
    answer = acceptAll(measure);
    const refused = executeBindingSetAspect(worker({ tier: "unlocked" }), chartViaApi, "binding.set", ["/spec/title", "=[Revenue]"]);
    await expect(refused).rejects.toMatchObject({
      code: "PermissionDenied",
      message: "bindProperty requires the 'bi.query' capability, which this script did not declare",
    });
    expect(requestCapabilityGrant).not.toHaveBeenCalled();
    expect(opsSent()).toEqual(["analyze"]);
  });

  it("declared but not granted (an application's script) -> CapabilityRequired, never prompted", async () => {
    answer = acceptAll(measure);
    const mw = worker({ tier: "unlocked", origin: "package", declared: ["bi.query"] });
    const refused = executeBindingSetAspect(mw, chartViaApi, "binding.set", ["/spec/title", "=[Revenue]"]);
    await expect(refused).rejects.toMatchObject({ code: "CapabilityRequired", capability: "bi.query" });
    expect(requestCapabilityGrant).not.toHaveBeenCalled();
    expect(opsSent()).toEqual(["analyze"]);
  });

  it("a CUBE function needs it too", async () => {
    answer = acceptAll(analysis({ sheets: [], usesCube: true }));
    const mw = worker({ tier: "unlocked", origin: "package", declared: ["bi.query"] });
    await expect(
      executeBindingSetAspect(mw, chartViaApi, "binding.set", ["/spec/title", '=CUBEVALUE("AW","[Measures].[Revenue]")']),
    ).rejects.toMatchObject({ code: "CapabilityRequired" });
  });

  it("a LOCAL script is asked; a refusal is CapabilityRequired, an allow binds", async () => {
    answer = acceptAll(measure);
    const denied = worker({ tier: "unlocked", declared: ["bi.query"] });
    await expect(
      executeBindingSetAspect(denied, chartViaApi, "binding.set", ["/spec/title", "=[Revenue]"]),
    ).rejects.toMatchObject({ code: "CapabilityRequired" });
    expect(requestCapabilityGrant).toHaveBeenCalledTimes(1);
    expect(requestCapabilityGrant.mock.calls[0][0]).toMatchObject({ capability: "bi.query", scriptId: denied.handle.scriptId });

    requestCapabilityGrant.mockResolvedValue("once");
    sent.length = 0;
    const allowed = worker({ tier: "unlocked", declared: ["bi.query"] });
    await executeBindingSetAspect(allowed, chartViaApi, "binding.set", ["/spec/title", "=[Revenue]"]);
    expect(allowed.handle.grants.has("bi.query")).toBe(true);
    expect(opsSent()).toEqual(["analyze", "set"]);
  });

  it("granted -> binds without a prompt; a cell-only formula needs nothing", async () => {
    answer = acceptAll(measure);
    await executeBindingSetAspect(
      worker({ tier: "unlocked", declared: ["bi.query"], granted: ["bi.query"] }),
      chartViaApi,
      "binding.set",
      ["/spec/title", "=[Revenue]"],
    );
    answer = acceptAll(analysis());
    await executeBindingSetAspect(worker({ tier: "unlocked" }), chartViaApi, "binding.set", ["/spec/title", "=Inputs!B1"]);
    expect(requestCapabilityGrant).not.toHaveBeenCalled();
    expect(opsSent()).toEqual(["analyze", "set", "analyze", "set"]);
  });

  it("requireExecutorCapability checks the ceiling BEFORE the grant (the broker's order)", async () => {
    // Granted but undeclared is still refused: the ceiling wins.
    const mw = worker({ tier: "unlocked", granted: ["bi.query"] });
    await expect(requireExecutorCapability(mw, "bi.query", "bindProperty")).rejects.toMatchObject({ code: "PermissionDenied" });
  });
});

// ============================================================================
// The object: which ref a script call addresses
// ============================================================================

describe("which object a call addresses", () => {
  it("own door: the family that owns the script's object type maps the instance to its ref", async () => {
    const off = registerBindableProperties({
      kind: "control",
      regionTypes: ["s9-test-control"],
      instanceTypes: ["shape"],
      refOf: () => null,
      refForInstance: (instanceId) => ({ kind: "control", id: `uid-of-${instanceId}` }),
      properties: () => [],
    });
    try {
      const mw = worker({ tier: "restricted", objectType: "shape", instanceId: "control-0-5-2" });
      await executeBindingSetAspect(mw, { objectType: "shape", instanceId: "control-0-5-2", door: "own" }, "property.set", [
        "/properties/text",
        "Hello",
      ]);
      expect(sent.find((r) => r.op === "setLiteral")).toMatchObject({
        object: { kind: "control", id: "uid-of-control-0-5-2" },
        path: "/properties/text",
        value: "Hello",
        source: { kind: "script", unlocked: false },
      });
    } finally {
      off();
    }
  });

  it("an object type with no bindable properties is a ValidationError naming the kinds", async () => {
    await expect(
      executeBindingGetAspect({ objectType: "sheet", instanceId: "", door: "own" }, "property.get", ["/spec/title"]),
    ).rejects.toMatchObject({ code: "ValidationError", message: expect.stringMatching(/no bindable properties.*chart, control/) });
    await expect(
      executeBindingSetAspect(worker({ tier: "unlocked" }), { objectType: "table", instanceId: "t1", door: "api" }, "binding.clear", ["/spec/title"]),
    ).rejects.toMatchObject({ code: "ValidationError", message: expect.stringMatching(/'table' 't1' is not an object with bindable properties/) });
    expect(opsSent()).toEqual([]);
  });
});

// ============================================================================
// setProperty / unbindProperty / the three reads
// ============================================================================

describe("setProperty, unbindProperty and the reads", () => {
  it("setProperty writes the literal through the family core (setLiteral), labelled", async () => {
    const mw = worker({ tier: "unlocked" });
    await executeBindingSetAspect(mw, chartViaApi, "property.set", ["/spec/xAxis/min", 10]);
    expect(sent.find((r) => r.op === "setLiteral")).toMatchObject({
      object: { kind: "chart", id: CHART_ID },
      path: "/spec/xAxis/min",
      value: 10,
      source: { kind: "script", scriptId: mw.handle.scriptId, unlocked: true },
    });
  });

  it("unbindProperty clears through the seam, labelled", async () => {
    const mw = worker({ tier: "restricted" });
    await executeBindingSetAspect(mw, chartOwn, "binding.clear", ["/spec/title"]);
    expect(sent.find((r) => r.op === "clear")).toMatchObject({
      path: "/spec/title",
      source: { kind: "script", scriptId: mw.handle.scriptId, unlocked: false },
    });
  });

  it("getLiteral reads the object's JSON by pointer; \"\" is the whole object; absent is null", async () => {
    expect(await executeBindingGetAspect(chartViaApi, "literal.get", ["/spec/title"])).toBe("Literal title");
    expect(await executeBindingGetAspect(chartViaApi, "literal.get", ["/spec/xAxis/min"])).toBe(0);
    expect(await executeBindingGetAspect(chartViaApi, "literal.get", ["/spec/nothing/here"])).toBeNull();
    expect(await executeBindingGetAspect(chartViaApi, "literal.get", [""])).toEqual({
      spec: { title: "Literal title", xAxis: { min: 0 } },
    });
    await expect(executeBindingGetAspect(chartViaApi, "literal.get", ["no-slash"])).rejects.toMatchObject({
      code: "ValidationError",
      message: expect.stringMatching(/JSON Pointer/),
    });
  });

  it("getProperty shows the resolved value; getBinding returns the invariant formula", async () => {
    const ref = { kind: "chart" as const, id: CHART_ID };
    answer = (req) => {
      if (req.op === "set") {
        return {
          kind: "binding",
          binding: {
            ...bindingInfo(ref, "/spec/title", "=Inputs!B1"),
            displayFormula: "=Inputs!B1",
            resolved: { object: ref, path: "/spec/title", value: "Q4 Revenue", display: "Q4 Revenue", error: null, pending: false },
          },
        };
      }
      return acceptAll(analysis())(req);
    };
    await executeBindingSetAspect(worker({ tier: "unlocked" }), chartViaApi, "binding.set", ["/spec/title", "=Inputs!B1"]);
    expect(await executeBindingGetAspect(chartViaApi, "property.get", ["/spec/title"])).toBe("Q4 Revenue");
    expect(await executeBindingGetAspect(chartViaApi, "literal.get", ["/spec/title"])).toBe("Literal title");
    expect(await executeBindingGetAspect(chartViaApi, "binding.get", ["/spec/title"])).toEqual({
      formula: "=Inputs!B1",
      model: null,
    });
    expect(await executeBindingGetAspect(chartViaApi, "binding.get", ["/spec/xAxis/min"])).toBeNull();
    // Clean the seam's cache for the next test.
    await executeBindingSetAspect(worker({ tier: "unlocked" }), chartViaApi, "binding.clear", ["/spec/title"]);
  });
});

// ============================================================================
// The round trip: shim -> broker policy -> executor -> shim
// ============================================================================

describe("api.object(kind, id) and context.self round-trip through the broker", () => {
  function mount(tier: "restricted" | "unlocked") {
    const mw = worker({ tier });
    const posted: W2H[] = [];
    const built = buildWorkerContext(
      {
        protocolVersion: 1,
        scriptId: mw.handle.scriptId,
        objectType: "chart",
        instanceId: CHART_ID,
        tier,
        capabilities: [],
        apiVersion: "1.0.0",
        scriptName: "Door test",
        snapshot: {},
        source: "",
      } as unknown as MountSpec,
      (msg) => posted.push(msg),
    );
    /** The host's dispatch for these aspects: policy, then the executor, then settle. */
    async function pump(): Promise<void> {
      while (posted.length > 0) {
        const msg = posted.shift()!;
        if (msg.t !== "call") continue;
        const decision = decidePolicy(mw.handle, msg.method, msg.args);
        if (!decision.admitted) {
          built.rt.settleCall(msg.callId, false, undefined, { code: decision.code, message: decision.message });
          continue;
        }
        try {
          let value: unknown;
          if (msg.method === "api.objectSetState" || msg.method === "api.objectGetState") {
            const [objectType, id, aspect, aspectArgs] = msg.args as [string, string, string, unknown[]];
            const target = { objectType, instanceId: id, door: "api" as const };
            value = msg.method === "api.objectSetState"
              ? await executeBindingSetAspect(mw, target, aspect, aspectArgs)
              : await executeBindingGetAspect(target, aspect, aspectArgs);
          } else {
            const [aspect, aspectArgs] = msg.args as [string, unknown[]];
            const target = { objectType: "chart", instanceId: CHART_ID, door: "own" as const };
            value = msg.method === "object.setState"
              ? await executeBindingSetAspect(mw, target, aspect, aspectArgs)
              : await executeBindingGetAspect(target, aspect, aspectArgs);
          }
          built.rt.settleCall(msg.callId, true, value);
        } catch (e) {
          const err = e as BrokerError;
          built.rt.settleCall(msg.callId, false, undefined, { code: err.code ?? "HostError", message: err.message });
        }
      }
    }
    return { mw, context: built.context as Record<string, any>, pump };
  }

  it("api.object(\"chart\", id).bindProperty reaches Rust as that chart, through api.objectSetState", async () => {
    const { mw, context, pump } = mount("unlocked");
    const handle = context.api.object("chart", CHART_ID);
    expect(handle.kind).toBe("chart");
    expect(handle.id).toBe(CHART_ID);
    const done = handle.bindProperty("/spec/title", "=Inputs!B1");
    await pump();
    await expect(done).resolves.toBeUndefined();
    expect(sent.find((r) => r.op === "set")).toMatchObject({
      object: { kind: "chart", id: CHART_ID },
      source: { kind: "script", scriptId: mw.handle.scriptId, unlocked: true },
    });

    const literal = handle.getLiteral("/spec/title");
    await pump();
    await expect(literal).resolves.toBe("Literal title");
  });

  it("the broker's row refuses onSelect before the executor runs (the shim's promise rejects)", async () => {
    const { context, pump } = mount("unlocked");
    const done = context.api.object("control", "uid-1").bindProperty("/properties/onSelect", "=A1");
    await pump();
    await expect(done).rejects.toMatchObject({ code: "ValidationError", message: expect.stringMatching(/code is never bound/) });
    expect(opsSent()).toEqual([]);
  });

  it("a restricted script has context.self but no api; its clamp holds through the round trip", async () => {
    const { context, pump } = mount("restricted");
    expect(context.api).toBeNull();
    expect(context.self.kind).toBe("chart");
    activeSheet = 0;
    answer = acceptAll(analysis({ sheets: [INPUTS] }));
    const done = context.self.bindProperty("/spec/title", "=Inputs!B1");
    await pump();
    await expect(done).rejects.toMatchObject({ code: "PermissionDenied", message: RESTRICTED_BINDING_CLAMP_MESSAGE });
    expect(opsSent()).toEqual(["analyze"]);
  });
});
