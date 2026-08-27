//! FILENAME: app/src/api/scriptHost/__tests__/scriptTemplate.test.ts
// PURPOSE: A drafted script must have something Run (F5) can start.
// CONTEXT: 2026-08-26, reported: "again I could not run it due to it lacking
//          some sort of entry point function."  The assisted template put the
//          whole body inside a hook handler, and `setup` is EXCLUDED from
//          run-at-cursor because the mount already ran it. So every draft
//          mounted correctly, `validateScriptSource` returned ok, and Run had
//          nothing to start.
//
//          MEASURED, AND IT IS WHY THE SHAPE ASSERTIONS CARRY THE TEETH: the
//          pre-fix assisted template's `topLevelFunctions` returns exactly
//          ["setup"] while `validateScriptSource` returns ok: true. A test that
//          only read the prompt prose would have proved nothing.
//
//          THE FOUR STEPS ARE THE PRODUCT'S OWN, in the product's order:
//          topLevelFunctions -> enclosingTopLevelFunction (debugger.ts:594-601)
//          -> buildRunTargetRegistrations (bootstrap.ts:202, on the STRIPPED
//          source) -> registerRunTargetHandler's `fn.length === 0` branch
//          (contextShims.ts:760). Re-deriving any of them here would be testing
//          the test.

import { describe, it, expect } from "vitest";
import {
  PREFERRED_HOOK_BY_TYPE,
  preferredHookFor,
  buildRunnableSkeleton,
  RUNNABLE_WORK_FN,
} from "../scriptTemplate";
import { OBJECT_TYPE_CONTEXTS } from "../generated/scriptSurfacePolicy";
import { objectHooksFor } from "../scriptPreview/objectHooks";
import {
  topLevelFunctions,
  enclosingTopLevelFunction,
  instrumentForDebug,
} from "../worker/debugInstrument";
import {
  stripModuleSyntax,
  wrapModuleSource,
  buildRunTargetRegistrations,
} from "../worker/debugWrapper";
import { validateScriptSource } from "../scriptValidation";

const TYPES = OBJECT_TYPE_CONTEXTS.map(([t]) => t);

function skeletonFor(objectType: string, body?: string): string {
  return buildRunnableSkeleton({
    objectType,
    primaryHook: preferredHookFor(objectType),
    body,
  });
}

// ---------------------------------------------------------------------------

describe("PREFERRED_HOOK_BY_TYPE is honest about the live surface", () => {
  it("has an entry for every object type the generator knows", () => {
    for (const t of TYPES) {
      expect(
        Object.prototype.hasOwnProperty.call(PREFERRED_HOOK_BY_TYPE, t),
        `${t} has no entry — it would silently fall through to the direct branch`,
      ).toBe(true);
    }
  });

  it("names no type the generator does not know", () => {
    const known = new Set(TYPES);
    for (const t of Object.keys(PREFERRED_HOOK_BY_TYPE)) {
      expect(known.has(t), `${t} is not in OBJECT_TYPE_CONTEXTS`).toBe(true);
    }
  });

  it("names only hooks the object actually has", () => {
    // THE TABLE IS A PREFERENCE, NEVER AN AUTHORITY. `objectHooksFor` is the
    // live generated list and wins; a renamed hook must be caught here rather
    // than reaching a model as an invented method.
    for (const t of TYPES) {
      const hook = preferredHookFor(t);
      if (hook === null) continue;
      expect(objectHooksFor(t), `${t}.${hook} is not a hook this type declares`).toContain(hook);
    }
  });

  it("gives null for an unknown type without reading the prototype chain", () => {
    expect(preferredHookFor("nope")).toBeNull();
    // `in` would find Object.prototype.constructor and hand back a function.
    expect(preferredHookFor("constructor")).toBeNull();
    expect(preferredHookFor("toString")).toBeNull();
  });

  it("only says null where the type genuinely has no default reaction", () => {
    // The positive control for the two rows above: `workbook` and `sheet` DO
    // declare hooks and are still null on purpose (a workbook script runs at
    // mount), while `textbox` and `chartMark` declare none at all.
    expect(objectHooksFor("textbox")).toEqual([]);
    expect(objectHooksFor("chartMark")).toEqual([]);
    expect(preferredHookFor("button")).toBe("onClick");
  });
});

// ---------------------------------------------------------------------------

describe.each(TYPES)("the %s skeleton", (type) => {
  const src = skeletonFor(type);

  it("declares exactly one non-setup top-level function, `run`, taking no arguments", () => {
    const fns = topLevelFunctions(src);
    const targets = fns.filter((f) => f.name !== "setup");
    expect(targets.map((f) => f.name)).toEqual([RUNNABLE_WORK_FN]);
    // `fn.length === 0` is the branch registerRunTargetHandler takes to call it
    // with NO arguments; arity 1 would hand it `context.api`, which is null on
    // an ordinary mount.
    expect(targets[0].arity).toBe(0);
    expect(fns.some((f) => f.name === "setup")).toBe(true);
  });

  it("resolves to `run` from the cursor, wherever in the file the cursor is", () => {
    // The exact two-step run-at-cursor performs (debugger.ts:594-601).
    const fns = topLevelFunctions(src);
    const run = fns.find((f) => f.name === RUNNABLE_WORK_FN)!;
    const setup = fns.find((f) => f.name === "setup")!;

    const inside = enclosingTopLevelFunction(fns, run.startLine + 1);
    expect(inside?.name).toBe(RUNNABLE_WORK_FN);

    // Cursor inside setup: `setup` is refused as a target, and the sole-non-setup
    // fallback is what yields `run`.
    const enclosing = enclosingTopLevelFunction(fns, setup.startLine + 1);
    expect(enclosing?.name).toBe("setup");
    const nonSetup = fns.filter((f) => f.name !== "setup");
    expect(nonSetup).toHaveLength(1);
    expect(nonSetup[0].name).toBe(RUNNABLE_WORK_FN);
  });

  it("is registered as a run target at an ORDINARY mount", () => {
    // The STRIPPED source, because bootstrap.ts:202 scans before instrumenting.
    // `includeSetup: false` is the ordinary (non-inert) mount.
    const regs = buildRunTargetRegistrations(stripModuleSyntax(src), false);
    expect(regs).toContain(JSON.stringify(RUNNABLE_WORK_FN));
    expect(regs, "setup must not be offered on an ordinary mount").not.toContain('"setup"');
  });

  it("still validates, and is still debuggable", () => {
    const report = validateScriptSource(src, type);
    expect(report.ok, JSON.stringify(report.findings)).toBe(true);
    expect(report.findings.map((f) => f.code)).not.toContain("no-entry-point");
    // Phase C adds `no-run-target`; the whole point of the skeleton is that it
    // never earns one.
    expect(report.findings.map((f) => f.code)).not.toContain("no-run-target");
    expect(instrumentForDebug(stripModuleSyntax(src)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------

/**
 * Compile the production wrapper the way `scriptEval/harness.ts:178-204` does.
 * Node has no Worker realm to import a blob module into, so the wrapper text is
 * evaluated as the function expression it wraps.
 */
function mount(src: string, context: Record<string, unknown>): unknown {
  const wrapped = wrapModuleSource(stripModuleSyntax(src));
  const PREFIX = "export default ";
  expect(wrapped.startsWith(PREFIX), "wrapModuleSource no longer emits the expected wrapper").toBe(true);
  const factory = new Function(`"use strict"; return (${wrapped.slice(PREFIX.length)});`) as () => (
    ctx: unknown,
  ) => unknown;
  return factory()(context);
}

describe("the skeleton actually runs", () => {
  const WIRED = TYPES.filter((t) => preferredHookFor(t) !== null);
  const DIRECT = TYPES.filter((t) => preferredHookFor(t) === null);

  it("covers both branches, so neither list can silently empty out", () => {
    expect(WIRED.length).toBeGreaterThan(0);
    expect(DIRECT.length).toBeGreaterThan(0);
    expect(WIRED.length + DIRECT.length).toBe(TYPES.length);
  });

  it.each(WIRED)("%s: does nothing at mount, and runs when the hook fires", async (type) => {
    const hook = preferredHookFor(type)!;
    const calls: string[] = [];
    let handler: (() => unknown) | null = null;
    const context: Record<string, unknown> = {
      __ran: () => calls.push("ran"),
      [hook]: (h: () => unknown) => { handler = h; },
    };

    await mount(skeletonFor(type, "context.__ran();"), context);
    expect(calls, "the body ran at mount — a hook-wired script must not").toEqual([]);
    expect(handler, `nothing was registered on context.${hook}`).not.toBeNull();

    // No ReferenceError: `run` is in scope for the handler the wrapper closed over.
    await (handler as unknown as () => Promise<unknown>)();
    expect(calls).toEqual(["ran"]);
  });

  it.each(DIRECT)("%s: runs during the mount, and the mount waits for it", async (type) => {
    const calls: string[] = [];
    let resolveWork: (() => void) | null = null;
    const context: Record<string, unknown> = {
      __ran: () =>
        new Promise<void>((resolve) => {
          calls.push("ran");
          resolveWork = resolve;
        }),
    };

    const mounted = mount(skeletonFor(type, "await context.__ran();"), context);
    expect(calls, "the direct branch must call run() during the mount").toEqual(["ran"]);

    // `return run()` and not a bare call: the mount resolves only after the work
    // settles, which is what makes "the script finished" knowable.
    let settled = false;
    const promise = Promise.resolve(mounted).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled, "the mount resolved before the work did").toBe(false);
    (resolveWork as unknown as () => void)();
    await promise;
    expect(settled).toBe(true);
  });
});
