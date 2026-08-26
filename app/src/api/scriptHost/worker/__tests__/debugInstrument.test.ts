//! FILENAME: app/src/api/scriptHost/worker/__tests__/debugInstrument.test.ts
// PURPOSE: The instrumentation pass must be SEMANTICS-PRESERVING. These tests
//          run the instrumented source for real (not just eyeball the text) and
//          compare its observable behaviour with the original's, with special
//          attention to the shapes that silently change meaning when a
//          statement is inserted in the wrong place (unbraced if/else bodies,
//          labels, switch clauses, ASI).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DEBUG_GLOBAL,
  instrumentForDebug,
  topLevelFunctions,
  enclosingTopLevelFunction,
} from "../debugInstrument";

interface Hit {
  line: number;
  kind: "async" | "sync";
}

function installRuntime(): { hits: Hit[] } {
  const hits: Hit[] = [];
  (globalThis as unknown as Record<string, unknown>)[DEBUG_GLOBAL] = {
    h: (line: number) => {
      hits.push({ line, kind: "async" });
    },
    s: (line: number) => {
      hits.push({ line, kind: "sync" });
    },
    p: (pairs: Array<[string, () => unknown]>) =>
      pairs.map(([name, get]) => {
        try {
          return { name, type: typeof get(), value: String(get()) };
        } catch {
          return { name, type: "unavailable", value: "<unavailable>" };
        }
      }),
  };
  return { hits };
}

/** Run a source the way the worker's blob wrapper does. */
async function run(source: string, asyncWrapper: boolean): Promise<unknown> {
  const body =
    `return (${asyncWrapper ? "async " : ""}function(context) { ${source}\n` +
    `; return typeof setup === "function" ? setup(context) : undefined; })(arguments[0]);`;
  // eslint-disable-next-line no-new-func -- the point of the test is to execute it
  const fn = new Function(body) as (context: unknown) => unknown;
  return await fn({ calls: [] });
}

/** Run original + instrumented and assert they agree. */
async function agree(source: string, context?: Record<string, unknown>): Promise<{ hits: Hit[] }> {
  const { hits } = installRuntime();
  const result = instrumentForDebug(source);
  expect(result.ok, result.error).toBe(true);
  const before = await run(source, false);
  const ctx = context ?? {};
  const after = await runWithContext(result.code, ctx);
  expect(after).toEqual(before);
  return { hits };
}

async function runWithContext(source: string, context: Record<string, unknown>): Promise<unknown> {
  const body =
    `return (async function(context) { ${source}\n` +
    `; return typeof setup === "function" ? setup(context) : undefined; })(arguments[0]);`;
  // eslint-disable-next-line no-new-func -- the point of the test is to execute it
  const fn = new Function(body) as (context: unknown) => unknown;
  return await fn(context);
}

describe("debug instrumentation — line preservation", () => {
  beforeEach(() => installRuntime());
  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>)[DEBUG_GLOBAL];
  });

  it("never changes the line count", () => {
    const src = [
      "const a = 1;",
      "function helper(x) {",
      "  const y = x * 2;",
      "  return y;",
      "}",
      "const b = helper(a);",
    ].join("\n");
    const r = instrumentForDebug(src);
    expect(r.ok).toBe(true);
    expect(r.code.split("\n").length).toBe(src.split("\n").length);
  });

  it("reports pausable lines at top level and snapshot lines inside sync functions", () => {
    const src = [
      "const a = 1;", // 1 - top level -> pausable
      "function helper(x) {", // 2
      "  const y = x * 2;", // 3 - sync body -> snapshot
      "  return y;", // 4 - sync body -> snapshot
      "}", // 5
    ].join("\n");
    const r = instrumentForDebug(src);
    expect(r.pausableLines).toContain(1);
    expect(r.snapshotLines).toEqual(expect.arrayContaining([3, 4]));
    expect(r.pausableLines).not.toContain(3);
  });

  it("uses await inside an author-written async function", () => {
    const src = ["async function work() {", "  const v = 1;", "  return v;", "}"].join("\n");
    const r = instrumentForDebug(src);
    expect(r.pausableLines).toEqual(expect.arrayContaining([2, 3]));
    expect(r.snapshotLines).toEqual([]);
  });
});

describe("debug instrumentation — semantics preservation", () => {
  beforeEach(() => installRuntime());
  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>)[DEBUG_GLOBAL];
  });

  it("does not capture an unbraced if body", async () => {
    const src = [
      "let out = [];",
      "function f(x) {",
      "  if (x)",
      "    return 'yes';",
      "  return 'no';",
      "}",
      "out.push(f(true), f(false));",
      "function setup() { return out; }",
    ].join("\n");
    const r = instrumentForDebug(src);
    expect(r.ok).toBe(true);
    // Line 4 is the unbraced body — no yield point may be inserted there.
    expect(r.pausableLines).not.toContain(4);
    expect(r.snapshotLines).not.toContain(4);
    await agree(src);
  });

  it("does not capture an unbraced else body", async () => {
    const src = [
      "function f(x) {",
      "  if (x) {",
      "    return 1;",
      "  } else",
      "    return 2;",
      "}",
      "function setup() { return [f(true), f(false)]; }",
    ].join("\n");
    const r = instrumentForDebug(src);
    expect(r.snapshotLines).not.toContain(5);
    await agree(src);
  });

  it("does not break a labelled loop", async () => {
    const src = [
      "function f() {",
      "  let n = 0;",
      "  outer:",
      "  for (let i = 0; i < 3; i++) {",
      "    for (let j = 0; j < 3; j++) {",
      "      if (j === 1) continue outer;",
      "      n++;",
      "    }",
      "  }",
      "  return n;",
      "}",
      "function setup() { return f(); }",
    ].join("\n");
    await agree(src);
  });

  it("does not break switch clauses", async () => {
    const src = [
      "function f(x) {",
      "  switch (x) {",
      "    case 1:",
      "      return 'one';",
      "    case 2: {",
      "      const s = 'two';",
      "      return s;",
      "    }",
      "    default:",
      "      return 'other';",
      "  }",
      "}",
      "function setup() { return [f(1), f(2), f(3)]; }",
    ].join("\n");
    await agree(src);
  });

  it("survives semicolon-less style", async () => {
    const src = [
      "const a = 1",
      "const b = 2",
      "function setup() {",
      "  const c = a + b",
      "  return c",
      "}",
    ].join("\n");
    await agree(src);
  });

  it("never inserts inside strings, templates, comments or regexes", async () => {
    const src = [
      "const re = /const x = 1/g;",
      "const tpl = `line",
      "const inTemplate = 2",
      "end`;",
      "// const commented = 3",
      "/* const blockCommented = 4",
      "   const stillComment = 5 */",
      "const s = 'const inString = 6';",
      "function setup() { return [re.source, tpl, s]; }",
    ].join("\n");
    const r = instrumentForDebug(src);
    expect(r.ok).toBe(true);
    expect(r.code).toContain("const x = 1/g");
    expect(r.code).toContain("const inTemplate = 2");
    expect(r.code).toContain("// const commented = 3");
    expect(r.code).toContain("'const inString = 6'");
    await agree(src);
  });

  it("leaves object literals and class bodies alone", async () => {
    const src = [
      "const cfg = {",
      "  alpha: 1,",
      "  beta: 2,",
      "};",
      "class Thing {",
      "  constructor() {",
      "    this.v = cfg.alpha + cfg.beta;",
      "  }",
      "  value() {",
      "    return this.v;",
      "  }",
      "}",
      "function setup() { return new Thing().value(); }",
    ].join("\n");
    const r = instrumentForDebug(src);
    expect(r.pausableLines).not.toContain(2);
    expect(r.snapshotLines).not.toContain(2);
    await agree(src);
  });

  it("preserves try/catch/finally control flow", async () => {
    const src = [
      "function f() {",
      "  const trail = [];",
      "  try {",
      "    trail.push('t');",
      "    throw new Error('boom');",
      "  } catch (e) {",
      "    trail.push('c:' + e.message);",
      "  } finally {",
      "    trail.push('f');",
      "  }",
      "  return trail;",
      "}",
      "function setup() { return f(); }",
    ].join("\n");
    await agree(src);
  });

  it("preserves generators (which cannot await)", async () => {
    const src = [
      "function* gen() {",
      "  const a = 1;",
      "  yield a;",
      "  yield a + 1;",
      "}",
      "function setup() { return [...gen()]; }",
    ].join("\n");
    const r = instrumentForDebug(src);
    expect(r.pausableLines).not.toContain(2);
    await agree(src);
  });
});

describe("debug instrumentation — async promotion", () => {
  beforeEach(() => installRuntime());
  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>)[DEBUG_GLOBAL];
  });

  it("promotes a top-level setup() so its body can pause", () => {
    const src = ["function setup(context) {", "  const a = 1;", "  return a;", "}"].join("\n");
    const r = instrumentForDebug(src);
    expect(r.promotedFunctions).toContain("setup");
    expect(r.code).toContain("async function setup");
    expect(r.pausableLines).toEqual(expect.arrayContaining([2, 3]));
  });

  it("promotes an inline context.onXxx callback", () => {
    const src = [
      "function setup(context) {",
      "  context.onEdit(function (e) {",
      "    const v = e.value;",
      "    return v;",
      "  });",
      "}",
    ].join("\n");
    const r = instrumentForDebug(src);
    expect(r.code).toContain("context.onEdit(async function");
    expect(r.pausableLines).toEqual(expect.arrayContaining([3, 4]));
  });

  it("promotes an inline arrow callback passed to context.expose", () => {
    const src = [
      "function setup(context) {",
      "  context.expose('run', (a) => {",
      "    const doubled = a * 2;",
      "    return doubled;",
      "  });",
      "}",
    ].join("\n");
    const r = instrumentForDebug(src);
    expect(r.code).toContain("context.expose('run', async (a) =>");
    expect(r.pausableLines).toEqual(expect.arrayContaining([3, 4]));
  });

  it("NEVER promotes onRender — the render path must not wait on a debugger", () => {
    const src = [
      "function setup(context) {",
      "  context.onRender(function (cell) {",
      "    const bold = cell.value === 'x';",
      "    return { bold };",
      "  });",
      "}",
    ].join("\n");
    const r = instrumentForDebug(src);
    expect(r.code).not.toContain("onRender(async");
    expect(r.snapshotLines).toEqual(expect.arrayContaining([3, 4]));
    expect(r.pausableLines).not.toContain(3);
  });

  it("follows the CONTEXT PARAMETER'S NAME, not the literal word 'context'", () => {
    // The macro recorder emits exactly this shape. Keying promotion on the word
    // "context" left every recorded macro's handler un-promotable, so every
    // breakpoint inside it degraded to a hollow snapshot-only dot — in the one
    // script shape the recorder produces, which is the one shape most users
    // will ever debug.
    const src = [
      "function setup(button) {",
      "  button.onClick(function () {",
      "    const total = 1;",
      "    return total;",
      "  });",
      "}",
    ].join("\n");
    const r = instrumentForDebug(src);
    expect(r.code).toContain("button.onClick(async function");
    expect(r.pausableLines).toEqual(expect.arrayContaining([3, 4]));
    expect(r.snapshotLines).not.toContain(3);
  });

  it("promotes a callback on a NESTED context path (context.sheet.onDataChange)", () => {
    const src = [
      "function setup(context) {",
      "  context.sheet.onDataChange(function (e) {",
      "    const n = e.changes.length;",
      "    return n;",
      "  });",
      "}",
    ].join("\n");
    const r = instrumentForDebug(src);
    expect(r.code).toContain("context.sheet.onDataChange(async function");
    expect(r.pausableLines).toEqual(expect.arrayContaining([3, 4]));
  });

  it("leaves a lookalike on someone ELSE'S object alone", () => {
    // `emitter` is not the context binding, so its on* callback is a user
    // contract we know nothing about — promoting it could change what the
    // script's own code observes.
    const src = [
      "function setup(context) {",
      "  const emitter = context.getThing();",
      "  emitter.onTick(function () {",
      "    const n = 1;",
      "    return n;",
      "  });",
      "}",
    ].join("\n");
    const r = instrumentForDebug(src);
    expect(r.code).not.toContain("emitter.onTick(async");
    expect(r.snapshotLines).toEqual(expect.arrayContaining([4, 5]));
  });

  it("still never promotes onRender, whatever the context is called", () => {
    const src = [
      "function setup(cell) {",
      "  cell.onRender(function (c) {",
      "    const bold = c.value === 'x';",
      "    return { bold };",
      "  });",
      "}",
    ].join("\n");
    const r = instrumentForDebug(src);
    expect(r.code).not.toContain("onRender(async");
    expect(r.snapshotLines).toEqual(expect.arrayContaining([3, 4]));
  });

  it("does not promote an ordinary user helper (its callers are synchronous)", () => {
    const src = [
      "function helper(x) {",
      "  return x + 1;",
      "}",
      "function setup(context) {",
      "  const v = helper(1);",
      "  return v;",
      "}",
    ].join("\n");
    const r = instrumentForDebug(src);
    expect(r.code).not.toContain("async function helper");
    expect(r.promotedFunctions).toEqual(["setup"]);
  });
});

describe("debug instrumentation — locals capture", () => {
  beforeEach(() => installRuntime());
  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>)[DEBUG_GLOBAL];
  });

  it("captures declarations and parameters in scope", async () => {
    const src = [
      "function setup(context) {",
      "  const alpha = 1;",
      "  let beta = alpha + 1;",
      "  return beta;",
      "}",
    ].join("\n");
    const r = instrumentForDebug(src);
    expect(r.ok).toBe(true);
    expect(r.code).toContain('["alpha",()=>alpha]');
    expect(r.code).toContain('["context",()=>context]');

    const captured: Array<Array<{ name: string; value: string }>> = [];
    (globalThis as unknown as Record<string, unknown>)[DEBUG_GLOBAL] = {
      h: (_line: number, locals: () => Array<{ name: string; value: string }>) => {
        captured.push(locals() ?? []);
      },
      s: () => undefined,
      p: (pairs: Array<[string, () => unknown]>) =>
        pairs.map(([name, get]) => {
          try {
            return { name, value: String(get()) };
          } catch {
            return { name, value: "<unavailable>" };
          }
        }),
    };
    const out = await runWithContext(r.code, { tag: "ctx" });
    expect(out).toBe(2);
    // The frame at `return beta` sees both bindings with their real values.
    const last = captured[captured.length - 1];
    expect(last.find((v) => v.name === "alpha")?.value).toBe("1");
    expect(last.find((v) => v.name === "beta")?.value).toBe("2");
  });

  it("lists only bindings declared ABOVE the yield point, so no frame sits in a TDZ", async () => {
    const src = [
      "function setup(context) {",
      "  const first = 1;",
      "  const second = first + 1;",
      "  return second;",
      "}",
    ].join("\n");
    const r = instrumentForDebug(src);
    const frames: Array<{ line: number; names: string[] }> = [];
    (globalThis as unknown as Record<string, unknown>)[DEBUG_GLOBAL] = {
      h: (line: number, locals: () => Array<{ name: string }>) => {
        frames.push({ line, names: (locals() ?? []).map((v) => v.name) });
      },
      s: () => undefined,
      p: (pairs: Array<[string, () => unknown]>) =>
        pairs.map(([name, get]) => {
          try {
            return { name, value: String(get()) };
          } catch {
            return { name, value: "<unavailable>" };
          }
        }),
    };
    await expect(runWithContext(r.code, {})).resolves.toBe(2);
    const atThird = frames.find((f) => f.line === 3);
    expect(atThird?.names).toContain("first");
    expect(atThird?.names).not.toContain("second");
    const atFourth = frames.find((f) => f.line === 4);
    expect(atFourth?.names).toEqual(expect.arrayContaining(["first", "second"]));
  });
});

// ============================================================================
// Top-level function inventory (run-at-cursor / VBA F5)
// ============================================================================

const RECORDED_MACRO = [
  "// Macro: Demo",                          // 1
  "async function demo(api) {",             // 2
  "  await api.setCellValue(0, 0, 'v');",   // 3
  "}",                                        // 4
  "",                                         // 5
  "function setup(context) {",              // 6
  "  if (typeof context.onClick === 'function') {", // 7
  "    context.onClick(async () => {",      // 8
  "      await demo(context.api);",          // 9
  "    });",                                  // 10
  "    return;",                              // 11
  "  }",                                      // 12
  "  return demo(context.api);",            // 13
  "}",                                        // 14
].join("\n");

describe("topLevelFunctions", () => {
  it("finds both top-level declarations in a recorded macro, with lines and arity", () => {
    const fns = topLevelFunctions(RECORDED_MACRO);
    expect(fns.map((f) => f.name)).toEqual(["demo", "setup"]);
    const demo = fns.find((f) => f.name === "demo")!;
    expect(demo).toMatchObject({ name: "demo", arity: 1, isAsync: true, startLine: 2, endLine: 4 });
    const setup = fns.find((f) => f.name === "setup")!;
    expect(setup).toMatchObject({ name: "setup", arity: 1, startLine: 6, endLine: 14 });
  });

  it("does NOT report function EXPRESSIONS or nested functions", () => {
    const src = [
      "const f = function inner() { return 1; };", // expression, not a declaration
      "function real() {",
      "  function nested() { return 2; }",         // nested — depth > 0
      "  return nested();",
      "}",
    ].join("\n");
    expect(topLevelFunctions(src).map((f) => f.name)).toEqual(["real"]);
  });

  it("counts arity: 0, 1 and many", () => {
    const src = [
      "function none() {}",
      "function one(api) {}",
      "function many(a, b, c) {}",
    ].join("\n");
    const byName = Object.fromEntries(topLevelFunctions(src).map((f) => [f.name, f.arity]));
    expect(byName).toEqual({ none: 0, one: 1, many: 3 });
  });

  it("returns [] for unparseable source rather than throwing", () => {
    expect(topLevelFunctions("function broken( {")).toEqual([]);
  });
});

describe("enclosingTopLevelFunction", () => {
  // The inventory is scanned ONCE and handed in — the caller needs the whole
  // list anyway, to fall back to and to name in its message.
  const MACRO_FNS = topLevelFunctions(RECORDED_MACRO);

  it("maps a cursor line to the function whose body contains it", () => {
    expect(enclosingTopLevelFunction(MACRO_FNS, 3)?.name).toBe("demo");
    expect(enclosingTopLevelFunction(MACRO_FNS, 9)?.name).toBe("setup");
    expect(enclosingTopLevelFunction(MACRO_FNS, 2)?.name).toBe("demo"); // on the decl line
    expect(enclosingTopLevelFunction(MACRO_FNS, 14)?.name).toBe("setup"); // on the close brace
  });

  it("returns null between declarations (blank line / header comment)", () => {
    expect(enclosingTopLevelFunction(MACRO_FNS, 1)).toBeNull(); // header comment
    expect(enclosingTopLevelFunction(MACRO_FNS, 5)).toBeNull(); // blank line
  });

  it("returns null for an empty inventory", () => {
    expect(enclosingTopLevelFunction([], 1)).toBeNull();
  });
});

describe("an EXPORTED declaration is a run-target", () => {
  // Reported 2026-08-25, minutes after the AI authored its first working
  // script: pressing Run/F5 said "This script has no single function to fall
  // back to" about a script whose only top-level function was under the cursor.
  // `topLevelFunctions` returned [] because the token before `function` was the
  // WORD `export`, and only punctuation was accepted as a declaration anchor.
  //
  // That sentence is quoted as it read THEN. The editor's message has since been
  // rewritten to name the functions the file declares (debugger.ts,
  // `noRunTargetMessage`), so it is a historical quotation, not a string any
  // test may assert on.
  //
  // `export function setup(context)` is what the docs teach, what the generated
  // typings show, what every corpus reference uses, and what the AI pipeline
  // emits — so this was broken for the shape the product is built around.

  it("finds a plain declaration", () => {
    expect(topLevelFunctions("function setup(context) {\n  context.log('x');\n}\n").map((f) => f.name))
      .toEqual(["setup"]);
  });

  it("finds an EXPORTED declaration", () => {
    expect(topLevelFunctions("export function setup(context) {\n  context.log('x');\n}\n").map((f) => f.name))
      .toEqual(["setup"]);
  });

  it("finds an exported ASYNC declaration", () => {
    // The async branch reads two tokens back, so `export` has to be accepted
    // there as well.
    expect(topLevelFunctions("export async function run(api) {\n  await api.x();\n}\n").map((f) => f.name))
      .toEqual(["run"]);
  });

  it("finds an export-default declaration", () => {
    expect(topLevelFunctions("export default function main() {\n  return 1;\n}\n").map((f) => f.name))
      .toEqual(["main"]);
  });

  it("keeps the arity, so Run can still refuse a wrong-arity target", () => {
    const [fn] = topLevelFunctions("export function setup(context) {\n}\n");
    expect(fn.arity).toBe(1);
    expect(fn.isAsync).toBe(false);
    const [afn] = topLevelFunctions("export async function go() {\n}\n");
    expect(afn.isAsync).toBe(true);
    expect(afn.arity).toBe(0);
  });

  it("reports the real line span of an exported function", () => {
    // The editor maps a cursor line to its enclosing function with this.
    const src = "// a comment\nexport function setup(context) {\n  context.log('x');\n}\n";
    const [fn] = topLevelFunctions(src);
    expect(fn.startLine).toBe(2);
    expect(fn.endLine).toBe(4);
  });

  it("still excludes function EXPRESSIONS", () => {
    // The whole point of the anchor check: an expression is not something a
    // user can run on its own, and admitting one would offer a bogus target.
    expect(topLevelFunctions("const f = function () {};\n")).toEqual([]);
    expect(topLevelFunctions("const g = async function () {};\n")).toEqual([]);
    expect(topLevelFunctions("register(function inner() {});\n")).toEqual([]);
  });

  it("finds both halves of the shape the AI actually writes", () => {
    const src = [
      "export function setup(context) {",
      "  context.onClick(async () => {",
      "    await context.api.setRangeFormat(0, 0, 0, 0, { backgroundColor: '#FFFF00' });",
      "  });",
      "}",
      "",
      "export function helper(v) { return v; }",
    ].join("\n");
    // The arrow inside onClick is NOT top-level and must not be offered.
    expect(topLevelFunctions(src).map((f) => f.name)).toEqual(["setup", "helper"]);
  });
});
