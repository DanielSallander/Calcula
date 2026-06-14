// Unit tests for the UDF evaluation bridge (Wave 3 / C1). Covers the wire-value
// conversions and the broker-mediated resolveUdfCall (success, #NAME?, throw,
// arg-count). The collect/orchestration loop is exercised by the e2e suite (it
// needs the Rust backend); here we mock the backend + core hook installer.

import { describe, it, expect, beforeEach, vi } from "vitest";

// formulaUdf -> capabilities -> ../backend (invokeBackend). Not called by the
// paths under test, but mock so module import resolves cleanly in jsdom.
vi.mock("../backend", () => ({ invokeBackend: vi.fn().mockResolvedValue([]) }));
// Avoid pulling @tauri-apps/api at import time; the hook installer is a noop here.
vi.mock("../../core/lib/tauri-api", () => ({ setUdfResolveHook: vi.fn() }));

import { registerFunction, type CustomFunctionDef } from "../formulaFunctions";
import { __test, type UdfValue } from "../formulaUdf";

const { jsToUdfValue, udfValueToJs, resolveUdfCall } = __test;

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
});
