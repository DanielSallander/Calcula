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
import {
  buildRunTargetRegistrations,
  withRunTargets,
  wrapModuleSource,
} from "../debugWrapper";
import { DEBUG_GLOBAL } from "../debugInstrument";

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
