import { describe, it, expect } from "vitest";
import { generateLibrarySource, validateParam, validateFunctionName } from "../customFunctions";

describe("generateLibrarySource", () => {
  it("exposes each function NON-public with its params, uppercased", () => {
    const src = generateLibrarySource([
      { name: "addTax", params: ["price", "rate"], body: "return price * (1 + rate);" },
    ]);
    expect(src).toContain('function setup(context)');
    expect(src).toContain('fns["ADDTAX"] = async (price, rate) =>');
    expect(src).toContain('context.expose("ADDTAX", fns["ADDTAX"], { public: false });');
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
    expect(src).toContain('fns["REVBYCOUNTRY"] = async (country) =>');
    expect(src).toContain("cube.value(");
  });

  it("handles zero-param functions and trims param whitespace", () => {
    const src = generateLibrarySource([{ name: "pi", params: [" "], body: "return 3.14159;" }]);
    expect(src).toContain('fns["PI"] = async () =>');
  });

  it("skips functions with a blank name", () => {
    const src = generateLibrarySource([
      { name: "", params: [], body: "return 1;" },
      { name: "ok", params: [], body: "return 2;" },
    ]);
    expect(src).not.toContain("return 1;");
    expect(src).toContain('fns["OK"] = async () =>');
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

  it("binds cellError so a body can return a SPECIFIC spreadsheet error", () => {
    // The sentinel object is the only error channel that survives structured
    // clone across the worker boundary (a thrown object does not).
    const src = generateLibrarySource([
      { name: "safeDiv", params: ["a", "b"], body: 'return b === 0 ? cellError("#DIV/0!") : a / b;' },
    ]);
    expect(src).toContain("const cellError = (code) => ({ __calculaError: String(code) });");
    expect(src).toContain('cellError("#DIV/0!")');
  });

  it("throws on a parameter that shadows the cellError binding", () => {
    expect(() =>
      generateLibrarySource([{ name: "h", params: ["cellError"], body: "return 1;" }]),
    ).toThrow();
  });

  it("throws on an invalid function name", () => {
    expect(() =>
      generateLibrarySource([{ name: "has space", params: [], body: "return 1;" }]),
    ).toThrow();
  });

  // -------------------------------------------------------------------------
  // Sibling calls + library imports (script package manager, first slice)
  // -------------------------------------------------------------------------

  it("binds every function into `fns` so a body can call a SIBLING by name", () => {
    // Before this, each expose closure was anonymous inside setup and nothing
    // bound a sibling to a name; the only reachable path was the undocumented
    // context.callMethod peer call. `fns` sanctions it explicitly.
    const src = generateLibrarySource([
      { name: "base", params: ["x"], body: "return x * 2;" },
      { name: "wrapper", params: ["x"], body: "return await fns.BASE(x) + 1;" },
    ]);
    expect(src).toContain("const fns = {};");
    expect(src).toContain('fns["BASE"] = async (x) =>');
    expect(src).toContain("return await fns.BASE(x) + 1;");
  });

  it("a sibling call actually resolves when the generated source is executed", async () => {
    const src = generateLibrarySource([
      { name: "base", params: ["x"], body: "return x * 2;" },
      { name: "wrapper", params: ["x"], body: "return (await fns.BASE(x)) + 1;" },
    ]);
    const exposed = new Map<string, (...a: unknown[]) => unknown>();
    const context = {
      caps: {},
      expose: (name: string, fn: (...a: unknown[]) => unknown) => exposed.set(name, fn),
    };
    // Same wrapper shape as the worker bootstrap.
    // eslint-disable-next-line no-new-func
    new Function("context", `${src}\n; return setup(context);`)(context);
    await expect(exposed.get("WRAPPER")!(5)).resolves.toBe(11);
  });

  it("rejects a parameter named `fns` or `imports` (they shadow the bindings)", () => {
    expect(validateParam("fns", "F")).not.toBeNull();
    expect(validateParam("imports", "F")).not.toBeNull();
  });

  it("emits `// @uses` pragmas so ONE parser reads UDF and object-script imports alike", () => {
    const src = generateLibrarySource(
      [{ name: "f", params: [], body: "return await imports.stats.mean([1,2]);" }],
      [
        { alias: "stats", package: "acme.stats", pin: "^1.2.0", isolated: false },
        { alias: "vault", package: "acme.vault", pin: "2.0.0", isolated: true },
      ],
    );
    expect(src.startsWith("// @uses stats acme.stats@^1.2.0\n")).toBe(true);
    expect(src).toContain("// @uses-isolated vault acme.vault@2.0.0");
    // The pragma block precedes setup(), so it is line-anchored exactly like a
    // hand-written script's.
    expect(src.indexOf("// @uses stats")).toBeLessThan(src.indexOf("function setup"));
  });

  it("emits no pragma block when nothing is imported", () => {
    const src = generateLibrarySource([{ name: "f", params: [], body: "return 1;" }]);
    expect(src.startsWith("function setup(context)")).toBe(true);
    expect(src).not.toContain("@uses");
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
