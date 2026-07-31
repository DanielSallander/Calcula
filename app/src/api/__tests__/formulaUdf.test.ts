// Unit tests for the UDF evaluation bridge (Wave 3 / C1). Covers the wire-value
// conversions (including the cell-error sentinel and spilling array returns),
// the broker-mediated resolveUdfCall (success, #NAME?, throw, arg-count,
// author-thrown cell errors) and the multi-edit collect/resolve orchestration
// that paste/fill depend on. The backend + core hook installer are mocked.

import { describe, it, expect, beforeEach, vi } from "vitest";

// formulaUdf -> capabilities -> ../backend (invokeBackend), and the collect
// round-trip. Each orchestration test programs this mock explicitly.
vi.mock("../backend", () => ({ invokeBackend: vi.fn().mockResolvedValue([]) }));
// Avoid pulling @tauri-apps/api at import time; the hook installer is a noop here.
vi.mock("../../core/lib/tauri-api", () => ({ setUdfResolveHook: vi.fn() }));

import { invokeBackend } from "../backend";
import {
  registerFunction,
  cellError,
  type CustomFunctionDef,
} from "../formulaFunctions";
import { __test, resolveUdfsForEdits, resolveUdfsForEdit, type UdfValue } from "../formulaUdf";

const { jsToUdfValue, udfValueToJs, resolveUdfCall, resolveCallsBounded } = __test;

function def(over: Partial<CustomFunctionDef> & { name: string; implementation: CustomFunctionDef["implementation"] }): CustomFunctionDef {
  return {
    description: "",
    syntax: "",
    category: "Custom",
    minArgs: 0,
    maxArgs: -1,
    ...over,
  };
}

describe("UdfValue conversions", () => {
  it("maps JS scalars/arrays to UdfValue", () => {
    expect(jsToUdfValue(42)).toEqual({ kind: "number", value: 42 });
    expect(jsToUdfValue("hi")).toEqual({ kind: "text", value: "hi" });
    expect(jsToUdfValue(true)).toEqual({ kind: "boolean", value: true });
    expect(jsToUdfValue(null)).toEqual({ kind: "empty" });
    expect(jsToUdfValue(undefined)).toEqual({ kind: "empty" });
    expect(jsToUdfValue(NaN)).toEqual({ kind: "error", value: "#VALUE!" });
    expect(jsToUdfValue(Infinity)).toEqual({ kind: "error", value: "#VALUE!" });
    expect(jsToUdfValue([1, "a", false])).toEqual({
      kind: "array",
      value: [
        { kind: "number", value: 1 },
        { kind: "text", value: "a" },
        { kind: "boolean", value: false },
      ],
    });
  });

  it("maps the cell-error sentinel to kind:error, but a plain string stays TEXT", () => {
    expect(jsToUdfValue(cellError("#N/A"))).toEqual({ kind: "error", value: "#N/A" });
    expect(jsToUdfValue({ __calculaError: "#REF!" })).toEqual({ kind: "error", value: "#REF!" });
    // Case-insensitive and normalized.
    expect(jsToUdfValue({ __calculaError: " #div/0! " })).toEqual({ kind: "error", value: "#DIV/0!" });
    // An unrepresentable code degrades to #VALUE! rather than vanishing.
    expect(jsToUdfValue({ __calculaError: "#NOPE" })).toEqual({ kind: "error", value: "#VALUE!" });
    // Excel parity: a String return is a string, only CVErr-equivalent is an error.
    expect(jsToUdfValue("#N/A")).toEqual({ kind: "text", value: "#N/A" });
  });

  it("maps a nested array so the backend can spill it as rows x cols", () => {
    expect(jsToUdfValue([[1, 2], [3, 4]])).toEqual({
      kind: "array",
      value: [
        { kind: "array", value: [{ kind: "number", value: 1 }, { kind: "number", value: 2 }] },
        { kind: "array", value: [{ kind: "number", value: 3 }, { kind: "number", value: 4 }] },
      ],
    });
  });

  it("maps UdfValue back to plain JS", () => {
    expect(udfValueToJs({ kind: "number", value: 5 })).toBe(5);
    expect(udfValueToJs({ kind: "text", value: "x" })).toBe("x");
    expect(udfValueToJs({ kind: "boolean", value: true })).toBe(true);
    expect(udfValueToJs({ kind: "empty" })).toBe(null);
    const arr: UdfValue = { kind: "array", value: [{ kind: "number", value: 1 }] };
    expect(udfValueToJs(arr)).toEqual([1]);
  });
});

describe("resolveUdfCall (broker-mediated)", () => {
  beforeEach(() => {
    // registry is a module singleton; tests register uniquely-named functions.
  });

  it("evaluates a registered UDF and returns its result as a UdfValue", async () => {
    registerFunction(def({ name: "MYDOUBLE", minArgs: 1, maxArgs: 1, implementation: (x) => (x as number) * 2 }));
    const r = await resolveUdfCall({ key: "k", name: "MYDOUBLE", args: [{ kind: "number", value: 21 }] });
    expect(r).toEqual({ kind: "number", value: 42 });
  });

  it("awaits an async implementation", async () => {
    registerFunction(def({ name: "MYASYNC", minArgs: 0, maxArgs: 0, implementation: async () => "done" }));
    const r = await resolveUdfCall({ key: "k", name: "MYASYNC", args: [] });
    expect(r).toEqual({ kind: "text", value: "done" });
  });

  it("returns #NAME? for an unregistered function", async () => {
    const r = await resolveUdfCall({ key: "k", name: "DEFINITELY_NOT_REGISTERED", args: [] });
    expect(r).toEqual({ kind: "error", value: "#NAME?" });
  });

  it("returns #VALUE! when the implementation throws", async () => {
    registerFunction(def({ name: "BOOM", minArgs: 0, maxArgs: 0, implementation: () => { throw new Error("kaboom"); } }));
    const r = await resolveUdfCall({ key: "k", name: "BOOM", args: [] });
    expect(r).toEqual({ kind: "error", value: "#VALUE!" });
  });

  it("returns #VALUE! on an arg-count violation", async () => {
    registerFunction(def({ name: "NEEDS2", minArgs: 2, maxArgs: 2, implementation: (a, b) => (a as number) + (b as number) }));
    const r = await resolveUdfCall({ key: "k", name: "NEEDS2", args: [{ kind: "number", value: 1 }] });
    expect(r).toEqual({ kind: "error", value: "#VALUE!" });
  });

  it("honours a RETURNED cell-error sentinel", async () => {
    registerFunction(def({ name: "RETNA", minArgs: 0, maxArgs: 0, implementation: () => cellError("#N/A") }));
    const r = await resolveUdfCall({ key: "k", name: "RETNA", args: [] });
    expect(r).toEqual({ kind: "error", value: "#N/A" });
  });

  it("honours a THROWN cell error (the sandbox worker's only channel)", async () => {
    // A worker body's throw arrives host-side as Error(message), so an exact
    // literal message is the sanctioned way to signal a specific error.
    registerFunction(def({
      name: "THROWNA",
      minArgs: 0,
      maxArgs: 0,
      implementation: () => { throw new Error("#N/A"); },
    }));
    const r = await resolveUdfCall({ key: "k", name: "THROWNA", args: [] });
    expect(r).toEqual({ kind: "error", value: "#N/A" });
  });

  it("still maps a genuine bug in the body to #VALUE!, not the message", async () => {
    registerFunction(def({
      name: "REALBUG",
      minArgs: 0,
      maxArgs: 0,
      implementation: () => { throw new Error("Cannot read properties of undefined"); },
    }));
    const r = await resolveUdfCall({ key: "k", name: "REALBUG", args: [] });
    expect(r).toEqual({ kind: "error", value: "#VALUE!" });
  });

  it("returns an array result unchanged so the backend can spill it", async () => {
    registerFunction(def({ name: "TRIPLET", minArgs: 0, maxArgs: 0, implementation: () => [1, 2, 3] }));
    const r = await resolveUdfCall({ key: "k", name: "TRIPLET", args: [] });
    expect(r).toEqual({
      kind: "array",
      value: [
        { kind: "number", value: 1 },
        { kind: "number", value: 2 },
        { kind: "number", value: 3 },
      ],
    });
  });
});

describe("resolveCallsBounded", () => {
  it("preserves input order and caps in-flight calls", async () => {
    registerFunction(def({
      name: "SLOWECHO",
      minArgs: 1,
      maxArgs: 1,
      implementation: async (x) => {
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 0));
        inFlight--;
        return x;
      },
    }));
    let inFlight = 0;
    let peakInFlight = 0;
    const calls = Array.from({ length: 40 }, (_, i) => ({
      key: `k${i}`,
      name: "SLOWECHO",
      args: [{ kind: "number", value: i } as UdfValue],
    }));
    const out = await resolveCallsBounded(calls);
    expect(out).toHaveLength(40);
    // Order matches the input, so `fresh[i] -> resolved[i]` keying is sound.
    expect(out[0]).toEqual({ kind: "number", value: 0 });
    expect(out[39]).toEqual({ kind: "number", value: 39 });
    expect(peakInFlight).toBeLessThanOrEqual(16);
  });
});

describe("resolveUdfsForEdits (collect/resolve orchestration)", () => {
  const mockInvoke = vi.mocked(invokeBackend);

  interface CollectRound {
    calls: Array<{ key: string; name: string; args: UdfValue[] }>;
    volatileCells: Array<{ row: number; col: number }>;
  }

  /** Program the collect rounds. `invokeBackend` also carries the broker's
   *  audit/capability traffic, so dispatch on the command name rather than a
   *  once-queue — otherwise an unrelated call eats a programmed round. */
  function programCollect(...rounds: CollectRound[]): void {
    let i = 0;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd !== "collect_udf_calls") return undefined;
      const round = rounds[Math.min(i, rounds.length - 1)];
      i++;
      return round;
    });
  }

  /** Only the collect_udf_calls invocations, in order. */
  function collectArgs(): Array<Record<string, unknown>> {
    return mockInvoke.mock.calls
      .filter((c) => c[0] === "collect_udf_calls")
      .map((c) => c[1] as Record<string, unknown>);
  }

  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
  });

  it("sends ALL pending edits in one collect call (paste/fill, not just one cell)", async () => {
    registerFunction(def({ name: "BATCHFN", minArgs: 1, maxArgs: 1, implementation: (x) => (x as number) + 1 }));
    programCollect(
      { calls: [{ key: "BATCHFN|[1]", name: "BATCHFN", args: [{ kind: "number", value: 1 }] }], volatileCells: [] },
      { calls: [], volatileCells: [] },
    );

    const edits = [
      { row: 0, col: 0, value: "=BATCHFN(A1)" },
      { row: 1, col: 0, value: "=BATCHFN(A2)", invariant: true },
    ];
    const res = await resolveUdfsForEdits(edits);

    // The whole pending batch crosses, not just the first cell — this is the
    // paste/fill fix (the batch bridge used to send no UDF data at all).
    expect(collectArgs()[0]).toMatchObject({ edits, known: {} });
    expect(res?.results).toEqual({ "BATCHFN|[1]": { kind: "number", value: 2 } });
  });

  it("passes the volatile function names and returns the volatile cells", async () => {
    registerFunction(def({
      name: "TICKER",
      minArgs: 0,
      maxArgs: 0,
      volatile: true,
      implementation: () => 7,
    }));
    programCollect(
      { calls: [{ key: "TICKER|[]", name: "TICKER", args: [] }], volatileCells: [{ row: 4, col: 2 }] },
      { calls: [], volatileCells: [{ row: 4, col: 2 }] },
    );

    const res = await resolveUdfsForEdits([{ row: 0, col: 0, value: "1" }]);

    expect(collectArgs()[0].volatileUdfNames).toContain("TICKER");
    // Deduped across rounds — the backend reports the same cells every round.
    expect(res?.volatileCells).toEqual([{ row: 4, col: 2 }]);
    expect(res?.results).toEqual({ "TICKER|[]": { kind: "number", value: 7 } });
  });

  it("omits non-volatile functions from volatileUdfNames", async () => {
    registerFunction(def({ name: "PLAINFN", minArgs: 0, maxArgs: 0, implementation: () => 1 }));
    programCollect({ calls: [], volatileCells: [] });
    await resolveUdfsForEdits([{ row: 0, col: 0, value: "1" }]);
    expect(collectArgs()[0].volatileUdfNames).not.toContain("PLAINFN");
    expect(collectArgs()[0].udfNames).toContain("PLAINFN");
  });

  it("feeds resolved results back so nested UDFs converge, then stops", async () => {
    registerFunction(def({ name: "INNER", minArgs: 0, maxArgs: 0, implementation: () => 2 }));
    registerFunction(def({ name: "OUTER", minArgs: 1, maxArgs: 1, implementation: (x) => (x as number) * 10 }));
    programCollect(
      { calls: [{ key: "INNER|[]", name: "INNER", args: [] }], volatileCells: [] },
      { calls: [{ key: "OUTER|[2]", name: "OUTER", args: [{ kind: "number", value: 2 }] }], volatileCells: [] },
      { calls: [], volatileCells: [] },
    );

    const res = await resolveUdfsForEdits([{ row: 0, col: 0, value: "=OUTER(INNER())" }]);

    const rounds = collectArgs();
    expect(rounds).toHaveLength(3);
    // Round 2 must carry round 1's answers so the backend can evaluate deeper.
    expect(rounds[1]).toMatchObject({ known: { "INNER|[]": { kind: "number", value: 2 } } });
    expect(res?.results).toEqual({
      "INNER|[]": { kind: "number", value: 2 },
      "OUTER|[2]": { kind: "number", value: 20 },
    });
  });

  it("skips the backend entirely when there are no pending edits", async () => {
    registerFunction(def({ name: "ANY", minArgs: 0, maxArgs: 0, implementation: () => 1 }));
    programCollect({ calls: [], volatileCells: [] });
    expect(await resolveUdfsForEdits([])).toBeUndefined();
    expect(collectArgs()).toHaveLength(0);
  });

  it("degrades to undefined (not a throw) when collect fails", async () => {
    registerFunction(def({ name: "FAILY", minArgs: 0, maxArgs: 0, implementation: () => 1 }));
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "collect_udf_calls") throw new Error("backend down");
      return undefined;
    });
    expect(await resolveUdfsForEdits([{ row: 0, col: 0, value: "=FAILY()" }])).toBeUndefined();
  });

  it("resolveUdfsForEdit wraps the single-cell case over the same path", async () => {
    registerFunction(def({ name: "ONECELL", minArgs: 0, maxArgs: 0, implementation: () => 5 }));
    programCollect(
      { calls: [{ key: "ONECELL|[]", name: "ONECELL", args: [] }], volatileCells: [] },
      { calls: [], volatileCells: [] },
    );

    const table = await resolveUdfsForEdit(3, 4, "=ONECELL()");

    expect(collectArgs()[0]).toMatchObject({
      edits: [{ row: 3, col: 4, value: "=ONECELL()" }],
    });
    expect(table).toEqual({ "ONECELL|[]": { kind: "number", value: 5 } });
  });
});
