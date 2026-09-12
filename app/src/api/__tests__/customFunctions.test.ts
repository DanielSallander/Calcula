import { describe, it, expect } from "vitest";
import {
  generateLibrarySource,
  validateParam,
  validateFunctionName,
  validateFunctionBody,
} from "../customFunctions";

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

describe("validateFunctionBody — a body must stay inside its wrapper", () => {
  // The generator splices the body between the braces of
  // `fns[NAME] = async (...) => { … }`. These bodies close that arrow and keep
  // going, so the trailing statements become siblings inside `setup(context)`
  // and run once per MOUNT — every workbook open — instead of per cell call.
  // The UDF still registers and still answers, so nothing looks wrong.
  const ESCAPES: Array<[string, string]> = [
    ["plain statement after the brace", "return 1; };  globalThis.PWNED = 1;  const _ = async () => {"],
    [
      "re-exposes itself as public",
      'return 1; }; context.expose("X", fns["X"], { public: true }); const _ = async () => {',
    ],
    ["hidden behind a comment", "return 1; }; /* quiet */ sideEffect(); const _ = async () => {"],
    ["closes and stops", "return 1; }"],
  ];

  it.each(ESCAPES)("refuses: %s", (_label, body) => {
    expect(validateFunctionBody(body, ["a"], "F")).not.toBeNull();
  });

  it("says WHEN the escaped code would run, because that is the whole defect", () => {
    const msg = validateFunctionBody(ESCAPES[0][1], ["a"], "TAX");
    expect(msg).toContain("runs when the workbook opens");
    expect(msg).toContain("TAX");
  });

  it("generateLibrarySource refuses to emit an escaping body at all", () => {
    expect(() =>
      generateLibrarySource([{ name: "PWN", params: [], body: ESCAPES[0][1] }]),
    ).toThrow(/workbook opens/);
  });

  // THE FALSE-REJECTION HALF, and the reason this is a parse rather than a
  // brace count. Every one of these carries a `}` that closes nothing, and a
  // counter would reject all of them — rejecting a legitimate body is the worse
  // failure, because the author has no way to satisfy it.
  const LEGITIMATE: Array<[string, string]> = [
    ["brace in a string", 'const s = "}"; return s + a;'],
    ["brace in a template literal", "const s = `${a}}`; return s;"],
    ["brace in a regex literal", "const r = /}/; return r.test(String(a));"],
    ["brace in a line comment", "// closes } here\nreturn a;"],
    ["brace in a block comment", "/* } */ return a;"],
    ["nested blocks and an object literal", "if (a) { const o = { x: 1 }; return o.x; }\nreturn 0;"],
    ["an inner arrow function", "const f = (n) => { return n * 2; };\nreturn f(a);"],
    ["await and a try/catch", "try { return await cube.value(a); } catch (e) { return cellError('#N/A'); }"],
  ];

  it.each(LEGITIMATE)("accepts: %s", (_label, body) => {
    expect(validateFunctionBody(body, ["a"], "F")).toBeNull();
  });

  it("a body with braces in strings still MOUNTS and runs per call", async () => {
    const src = generateLibrarySource([
      { name: "BRACY", params: ["a"], body: 'const s = "}"; return String(a) + s;' },
    ]);
    const exposed = new Map<string, (...a: unknown[]) => unknown>();
    const context = {
      caps: {},
      expose: (name: string, fn: (...a: unknown[]) => unknown) => exposed.set(name, fn),
    };
    // eslint-disable-next-line no-new-func
    new Function("context", `${src}\n; return setup(context);`)(context);
    await expect(exposed.get("BRACY")!(7)).resolves.toBe("7}");
  });

  it("the parameter list is part of the probe, so a bad body is caught with real params", () => {
    expect(validateFunctionBody("return price * 1.25;", ["price"], "TAX")).toBeNull();
    expect(validateFunctionBody("return price; }; evil();  const _ = async () => {", ["price"], "TAX")).not.toBeNull();
  });
});
