import { describe, it, expect } from "vitest";
import { generateLibrarySource, validateParam, validateFunctionName } from "../customFunctions";

describe("generateLibrarySource", () => {
  it("exposes each function NON-public with its params, uppercased", () => {
    const src = generateLibrarySource([
      { name: "addTax", params: ["price", "rate"], body: "return price * (1 + rate);" },
    ]);
    expect(src).toContain('function setup(context)');
    expect(src).toContain('context.expose("ADDTAX", async (price, rate) =>');
    // Exposed { public: false } so a peer sandboxed script cannot reach the
    // library's capabilities via context.callMethod (only trusted host code,
    // which bypasses the public policy, invokes it).
    expect(src).toContain("{ public: false }");
    expect(src).not.toContain("{ public: true }");
    expect(src).toContain("return price * (1 + rate);");
  });

  it("binds cube from the capability shim so bodies can call cube.value", () => {
    const src = generateLibrarySource([
      {
        name: "revByCountry",
        params: ["country"],
        body: 'return await cube.value("Sales", "[Revenue]", "Geo[Country]=" + country);',
      },
    ]);
    expect(src).toContain("const cube = caps.cube;");
    expect(src).toContain('context.expose("REVBYCOUNTRY", async (country) =>');
    expect(src).toContain("cube.value(");
  });

  it("handles zero-param functions and trims param whitespace", () => {
    const src = generateLibrarySource([{ name: "pi", params: [" "], body: "return 3.14159;" }]);
    expect(src).toContain('context.expose("PI", async () =>');
  });

  it("skips functions with a blank name", () => {
    const src = generateLibrarySource([
      { name: "", params: [], body: "return 1;" },
      { name: "ok", params: [], body: "return 2;" },
    ]);
    expect(src).not.toContain("return 1;");
    expect(src).toContain('context.expose("OK", async () =>');
  });

  it("produces compilable structure for multiple functions", () => {
    const src = generateLibrarySource([
      { name: "a", params: ["x"], body: "return x + 1;" },
      { name: "b", params: ["y"], body: "return y * 2;" },
    ]);
    // Two expose calls, balanced braces.
    expect((src.match(/context\.expose\(/g) || []).length).toBe(2);
    const opens = (src.match(/\{/g) || []).length;
    const closes = (src.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
  });

  it("does NOT advertise a fetch binding the UI never grants", () => {
    // The dialog only grants bi.query; a `fetch` binding would always fail, so
    // it must not appear in the generated source (finding 12).
    const src = generateLibrarySource([{ name: "f", params: [], body: "return 1;" }]);
    expect(src).not.toContain("fetch");
  });

  it("throws on a parameter that could break out of the generated source", () => {
    // A crafted param must be rejected, not injected verbatim (finding 14).
    expect(() =>
      generateLibrarySource([{ name: "evil", params: ["a) => 1; context.expose("], body: "return 1;" }]),
    ).toThrow();
  });

  it("throws on a parameter that shadows an injected capability binding", () => {
    // `cube`/`caps`/`context` would shadow the sandbox helpers (finding 11).
    expect(() =>
      generateLibrarySource([{ name: "g", params: ["cube"], body: "return 1;" }]),
    ).toThrow();
  });

  it("throws on an invalid function name", () => {
    expect(() =>
      generateLibrarySource([{ name: "has space", params: [], body: "return 1;" }]),
    ).toThrow();
  });
});

describe("validators", () => {
  it("validateFunctionName rejects dotted/spaced names, accepts identifiers", () => {
    expect(validateFunctionName("ADD_TAX")).toBeNull();
    expect(validateFunctionName("my.fn")).not.toBeNull();
    expect(validateFunctionName("has space")).not.toBeNull();
  });

  it("validateParam rejects reserved + non-identifier params", () => {
    expect(validateParam("price", "F")).toBeNull();
    expect(validateParam("cube", "F")).not.toBeNull();
    expect(validateParam("a=1", "F")).not.toBeNull();
  });
});
