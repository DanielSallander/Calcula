//! FILENAME: app/src/api/scriptHost/worker/__tests__/debugInstrument.test.ts
// PURPOSE: The instrumentation pass must be SEMANTICS-PRESERVING. These tests
//          run the instrumented source for real (not just eyeball the text) and
//          compare its observable behaviour with the original's, with special
//          attention to the shapes that silently change meaning when a
//          statement is inserted in the wrong place (unbraced if/else bodies,
//          labels, switch clauses, ASI).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DEBUG_GLOBAL, instrumentForDebug } from "../debugInstrument";

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
