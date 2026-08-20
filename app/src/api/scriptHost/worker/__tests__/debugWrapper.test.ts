//! FILENAME: app/src/api/scriptHost/worker/__tests__/debugWrapper.test.ts
// PURPOSE: A DEBUG MOUNT OF A MODULE MACRO MUST EXECUTE NOTHING.
//
// THE BUG: the compile wrapper ends `return typeof setup === "function" ?
//          setup(context) : undefined`, and a recorded macro's generated `setup`
//          falls through its click branch (the synthetic `workbook` definition
//          has no `context.onClick`) to `return macroNNNN(context.api)`. So
//          MOUNTING THE MACRO RAN IT: the debugger paused at line 6 with every
//          value the macro writes already in the grid, and running or stepping
//          applied them a second time.
//
//          The wrapper is built here, so the property is proven here: the module
//          body still runs (it has to — that is what declares the functions and
//          executes the run-target registrations appended after it), and the
//          entry point is NOT called.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildRunTargetRegistrations,
  withRunTargets,
  stripModuleSyntax,
  wrapModuleSource,
} from "../debugWrapper";
import { DEBUG_GLOBAL, instrumentForDebug } from "../debugInstrument";

/**
 * The shape the macro recorder emits, minus the recorded body: a worker function
 * and a `setup` that runs it when there is no `onClick` to register against.
 */
const MACRO_SOURCE = [
  "async function macro0001(api) {",
  "  await api.setCellValue(0, 0, 'written');",
  "}",
  "",
  "function setup(context) {",
  "  if (typeof context.onClick === 'function') {",
  "    context.onClick(() => macro0001(context.api));",
  "    return;",
  "  }",
  "  return macro0001(context.api);",
  "}",
].join("\n");

/**
 * Evaluate a wrapper the way the blob-ESM import does, minus the module plumbing:
 * strip the `export default` and build the function from its text.
 */
function evaluateWrapper(wrapped: string): (context: unknown) => unknown {
  const body = wrapped.replace(/^export default /, "");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`return (${body})`)() as (context: unknown) => unknown;
}

/** A `context` that records everything the script does with it. */
function recordingContext() {
  const writes: Array<[number, number, unknown]> = [];
  const clicks: Array<() => void> = [];
  const api = {
    setCellValue: (row: number, col: number, value: unknown) => {
      writes.push([row, col, value]);
      return Promise.resolve();
    },
  };
  return {
    writes,
    clicks,
    context: {
      api,
      // A real object script HAS this; the synthetic module-macro mount does not.
      onClick: undefined as undefined | ((cb: () => void) => void),
    },
  };
}

describe("wrapModuleSource — invokeSetup decides whether the mount RUNS the script", () => {
  it("an ordinary mount calls setup, and the macro writes (unchanged behaviour)", async () => {
    const { context, writes } = recordingContext();
    const run = evaluateWrapper(wrapModuleSource(MACRO_SOURCE));

    await run(context);

    expect(writes).toEqual([[0, 0, "written"]]);
  });

  it("an INERT mount does not call setup: the macro writes NOTHING", async () => {
    const { context, writes } = recordingContext();
    const run = evaluateWrapper(wrapModuleSource(MACRO_SOURCE, { invokeSetup: false }));

    const result = await run(context);

    expect(writes).toEqual([]);
    expect(result).toBeUndefined();
  });

  it("an inert mount still EVALUATES the module body — the declarations exist", async () => {
    const { context, writes } = recordingContext();
    // The registration statements the debug wrapper appends stand in for the
    // module body's own effects: if the body did not run, `macro0001` and
    // `setup` would not be in scope and this would throw a ReferenceError.
    const seen: Array<{ name: string; fn: unknown; entryPoint: boolean }> = [];
    const globalScope = globalThis as unknown as Record<string, unknown>;
    globalScope[DEBUG_GLOBAL] = {
      rt: (name: string, fn: unknown, _ctx: unknown, entryPoint?: boolean) =>
        seen.push({ name, fn, entryPoint: entryPoint === true }),
    };
    try {
      const code = withRunTargets(
        MACRO_SOURCE,
        buildRunTargetRegistrations(MACRO_SOURCE, true),
      );
      await evaluateWrapper(wrapModuleSource(code, { invokeSetup: false }))(context);
    } finally {
      delete globalScope[DEBUG_GLOBAL];
    }

    expect(seen.map((s) => s.name)).toEqual(["macro0001", "setup"]);
    expect(seen.every((s) => typeof s.fn === "function")).toBe(true);
    // ...and evaluating the body still ran none of the macro.
    expect(writes).toEqual([]);
  });

  it("keeps the user's line numbers (breakpoints address the editor's lines)", () => {
    const wrapped = wrapModuleSource(MACRO_SOURCE, { invokeSetup: false });
    const lines = wrapped.split("\n");
    // Line 1 of the wrapper is line 1 of the user source; the tail is appended
    // after exactly one added newline, at the end.
    expect(lines[0]).toContain("async function macro0001(api) {");
    expect(lines.length).toBe(MACRO_SOURCE.split("\n").length + 1);
  });

  it("the async wrapper form is available to both, for instrumented yield points", () => {
    expect(wrapModuleSource("", { asyncWrapper: true })).toContain("async function(context)");
    expect(wrapModuleSource("", { asyncWrapper: true, invokeSetup: false })).toContain(
      "async function(context)",
    );
  });
});

describe("buildRunTargetRegistrations — what a session can start", () => {
  it("excludes setup on a mount that INVOKES it (offering it twice would be noise)", () => {
    const regs = buildRunTargetRegistrations(MACRO_SOURCE, false);
    expect(regs).toContain('"macro0001"');
    expect(regs).not.toContain('"setup"');
  });

  it("INCLUDES setup on an inert mount, marked as the entry point", () => {
    const regs = buildRunTargetRegistrations(MACRO_SOURCE, true);
    expect(regs).toContain('"macro0001"');
    expect(regs).toContain('"setup"');
    // The 4th argument is what makes the thunk hand `setup` the whole context
    // rather than `context.api` — see registerRunTargetHandler.
    expect(regs).toMatch(/rt\("setup",[^;]*,context,true\);/);
    expect(regs).toMatch(/rt\("macro0001",[^;]*,context\);/);
  });

  it("a macro whose whole body lives in setup is still runnable when inert", () => {
    const allInSetup = [
      "function setup(context) {",
      "  return context.api.setCellValue(0, 0, 1);",
      "}",
    ].join("\n");
    // Without setup this would be EMPTY — an inert session with no way at all to
    // start the script, which is the silent dead end the host reports on.
    expect(buildRunTargetRegistrations(allInSetup, false)).toBe("");
    expect(buildRunTargetRegistrations(allInSetup, true)).toContain('"setup"');
  });

  it("guards every name with a typeof check — never a ReferenceError", () => {
    const regs = buildRunTargetRegistrations(MACRO_SOURCE, true);
    expect(regs).toContain('typeof macro0001==="function"?macro0001:null');
    expect(regs).toContain('typeof setup==="function"?setup:null');
  });

  it("withRunTargets is a no-op when there is nothing to register", () => {
    expect(withRunTargets("body", "")).toBe("body");
    expect(withRunTargets("body", "regs;")).toBe("body\nregs;");
  });
});

describe("wrapModuleSource — an `export`ed declaration still compiles", () => {
  /**
   * The user body is spliced INSIDE a function, where `export` is a
   * SyntaxError. `export function setup(context)` is the form the docs, the
   * generated IntelliSense typings and the AI authoring prompt all teach, so a
   * script could pass every static check and then fail to mount. Found while
   * dry-running AI drafts, where every generated script carried it.
   */
  it("mounts and runs `export function setup`", async () => {
    const { context, writes } = recordingContext();
    const source = [
      "export function setup(context) {",
      "  return context.api.setCellValue(0, 0, 'exported');",
      "}",
    ].join("\n");

    await evaluateWrapper(wrapModuleSource(source))(context);

    expect(writes).toEqual([[0, 0, "exported"]]);
  });

  it("mounts `export const` and `export async function` too", async () => {
    const { context, writes } = recordingContext();
    const source = [
      "export const target = 7;",
      "export async function setup(context) {",
      "  await context.api.setCellValue(0, target, 'both');",
      "}",
    ].join("\n");

    await evaluateWrapper(wrapModuleSource(source))(context);

    expect(writes).toEqual([[0, 7, "both"]]);
  });

  /**
   * Breakpoints, error stacks and the debugger's call-stack view all address
   * the user's own coordinates, so the keyword is blanked rather than deleted.
   */
  it("preserves the line AND column of what followed the keyword", () => {
    const source = ["const a = 1;", "export function setup(context) {}"].join("\n");

    const wrapped = wrapModuleSource(source);
    const line = wrapped.split("\n").find((l) => l.includes("function setup"));

    expect(line).toBeDefined();
    // The keyword is GONE (otherwise this assertion holds trivially — the
    // untouched text has `function setup` at that column too)...
    expect(line).not.toContain("export");
    // ...and what followed it did not move.
    expect(line!.indexOf("function setup")).toBe("export function setup".indexOf("function setup"));
    expect(wrapped.split("\n").length).toBe(source.split("\n").length + 1);
  });

  it("leaves the word alone where it is not a declaration", async () => {
    const { context, writes } = recordingContext();
    const source = [
      "function setup(context) {",
      "  const note = 'export function setup';",
      "  return context.api.setCellValue(0, 0, note);",
      "}",
    ].join("\n");

    await evaluateWrapper(wrapModuleSource(source))(context);

    expect(writes).toEqual([[0, 0, "export function setup"]]);
  });
});

describe("stripModuleSyntax — the specifier forms, and line alignment", () => {
  /**
   * Closing the DECLARATION forms and leaving these open just narrowed the
   * hole: acorn parses with `sourceType: "module"` and accepts them, and
   * `hasSetupEntryPoint` finds the declaration and calls the script healthy —
   * so the blob import is the first thing that objects, at mount.
   */
  it("neutralises `export { setup };`", async () => {
    const { context, writes } = recordingContext();
    const source = [
      "function setup(context) {",
      "  return context.api.setCellValue(0, 0, 'specifier');",
      "}",
      "export { setup };",
    ].join("\n");

    await evaluateWrapper(wrapModuleSource(source))(context);

    expect(writes).toEqual([[0, 0, "specifier"]]);
  });

  it("neutralises `export * from` and a multi-line specifier list", () => {
    const source = [
      "export * from './helpers';",
      "export {",
      "  setup,",
      "};",
    ].join("\n");

    const out = stripModuleSyntax(source);

    expect(out).not.toContain("export");
    // Blanked, not deleted: the line count is untouched.
    expect(out.split("\n").length).toBe(source.split("\n").length);
  });

  /**
   * `\s` includes `\n`, and `^` matches at the start of a blank line under
   * `/m`, so a `\s*` prefix consumed the PRECEDING blank line's newline and
   * shifted every following line up by one. `debugRuntime.ts` documents that
   * the blob is line-aligned with the author's source and reports stack frames
   * on that basis, so every reported line was too low.
   */
  it("does not eat the blank line before an import", () => {
    const source = [
      "// @capability net.fetch",
      "",
      "import { helper } from './util';",
      "",
      "function setup(context) {}",
    ].join("\n");

    const out = stripModuleSyntax(source);

    expect(out.split("\n").length).toBe(source.split("\n").length);
    expect(out.split("\n").findIndex((l) => l.includes("function setup"))).toBe(4);
  });

  it("keeps every line of the wrapped blob aligned with the author's source", () => {
    const source = [
      "",
      "import { helper } from './util';",
      "",
      "export default function setup(context) {",
      "  return context.api.setCellValue(0, 0, 'aligned');",
      "}",
    ].join("\n");

    const wrapped = wrapModuleSource(source);
    const lines = wrapped.split("\n");

    // The wrapper adds no newline before the body, so author line N is blob
    // line N (1-indexed), and only the tail is appended.
    expect(lines[3]).toContain("function setup");
    expect(lines.length).toBe(source.split("\n").length + 1);
  });

  it("is idempotent", () => {
    const source = "export const x = 1;\nexport function setup(context) {}\nexport { setup };";
    const once = stripModuleSyntax(source);
    expect(stripModuleSyntax(once)).toBe(once);
  });
});

describe("the DEBUG mount composes instrumentation with the wrapper", () => {
  /**
   * Neither pass is wrong alone; the ORDER is the whole defect.
   *
   * `instrumentForDebug` inserts a yield point at offset 0, so line 1 becomes
   * `await __calculaDbg.h(1,…);export function setup(context) {` — `export` is
   * no longer at a line start, and `wrapModuleSource`'s anchored strip cannot
   * reach it. The blob threw the SyntaxError the strip exists to prevent,
   * bootstrap swallowed it and recompiled un-instrumented, and the session ran
   * with NO breakpoint able to fire. Nothing composed the two passes, so nothing
   * caught it: debugInstrument's own tests hand-roll a wrapper with no strips.
   */
  const OBJECT_SCRIPT = [
    "export function setup(context) {",
    "  return context.api.setCellValue(0, 0, 'debugged');",
    "}",
  ].join("\n");

  const compiles = (wrapped: string): boolean => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new Function(`return (${wrapped.replace(/^export default /, "")})`);
      return true;
    } catch {
      return false;
    }
  };

  it("strips BEFORE instrumenting, and the result compiles", () => {
    const result = instrumentForDebug(stripModuleSyntax(OBJECT_SCRIPT));

    expect(result.ok).toBe(true);
    expect(compiles(wrapModuleSource(result.code, { asyncWrapper: true }))).toBe(true);
  });

  /** The negative control: the other order is what shipped, and it does not compile. */
  it("instrumenting FIRST leaves an `export` the wrapper's strip cannot reach", () => {
    const result = instrumentForDebug(OBJECT_SCRIPT);

    expect(result.ok).toBe(true);
    expect(result.code).toContain("export function setup");
    expect(compiles(wrapModuleSource(result.code, { asyncWrapper: true }))).toBe(false);
  });
});

describe("the debug mount actually applies the strip first", () => {
  /**
   * `bootstrap.ts` cannot be imported by a test — it is a worker entry point
   * that hardens the ambient globals and installs `self.onmessage` at module
   * load — so the wiring is pinned by reading it, the way this repo pins other
   * un-importable sources. The composition property itself is proven above; this
   * asserts the debug mount is the thing that uses it.
   */
  it("instruments the STRIPPED source, never the raw one", () => {
    const bootstrap = readFileSync(
      resolve(__dirname, "../bootstrap.ts"),
      "utf8",
    );

    expect(bootstrap).toContain("stripModuleSyntax(spec.source)");
    expect(bootstrap).not.toContain("instrumentForDebug(spec.source)");
    // The fallback path must compile the stripped source too, or losing
    // instrumentation would also lose the fix.
    expect(bootstrap).not.toContain("withRunTargets(spec.source");
  });
});
