//! FILENAME: app/src/api/scriptHost/__tests__/debugReach.test.ts
// PURPOSE: The debug channel must not become a new REACH. A script may be
//          debugged; it may not debug — it cannot open a session, cannot pause
//          itself or anyone else, and gains nothing while paused.
//
// WHY SOURCE-DERIVED: script reach is not one list. It is the ALLOWLIST *plus*
//          the aspect-dispatched `object.setState` / `object.getState` cases
//          (which have no allowlist row by design) *plus* the extension broker
//          methods *plus* whatever the worker context shim hands the script.
//          Each is enumerated here from its own source of truth, so a future
//          "just add a debug helper to the context" cannot pass unnoticed.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { ALLOWLIST } from "../allowlist";
import { EXTENSION_BROKER_METHODS } from "../extensionProtocol";

const HOST_DIR = path.resolve(__dirname, "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(HOST_DIR, rel), "utf8");
}

/** All `case "..."` labels inside one named function of a source file. */
function caseLabelsOf(source: string, fnName: string): string[] {
  const start = source.indexOf(`function ${fnName}(`);
  expect(start, `${fnName} not found — this test must be updated`).toBeGreaterThan(-1);
  // The dispatchers are the last functions of their section; take a generous
  // window and stop at the next top-level `async function ` declaration.
  const rest = source.slice(start + 1);
  const nextFn = rest.search(/\n(?:export )?(?:async )?function /);
  const body = nextFn > 0 ? rest.slice(0, nextFn) : rest;
  return [...body.matchAll(/case\s+"([^"]+)"/g)].map((m) => m[1]);
}

describe("the debug channel is not a script-reachable surface", () => {
  it("no ALLOWLIST method is a debug method", () => {
    const offenders = Object.keys(ALLOWLIST).filter((m) => /debug/i.test(m));
    expect(offenders).toEqual([]);
  });

  it("no aspect-dispatched setState/getState case is a debug aspect", () => {
    const host = read("host.ts");
    const setAspects = caseLabelsOf(host, "executeSetState");
    const getAspects = caseLabelsOf(host, "executeGetState");
    expect(setAspects.length).toBeGreaterThan(0);
    expect(getAspects.length).toBeGreaterThan(0);
    expect(setAspects.filter((a) => /debug|pause|breakpoint|step/i.test(a))).toEqual([]);
    expect(getAspects.filter((a) => /debug|pause|breakpoint|step/i.test(a))).toEqual([]);
  });

  it("no extension-broker method is a debug method", () => {
    const offenders = [...EXTENSION_BROKER_METHODS].filter((m) => /debug/i.test(m));
    expect(offenders).toEqual([]);
  });

  it("the worker context shim exposes nothing debug-related to the script", () => {
    const shims = read("worker/contextShims.ts");
    // The instrumentation calls a GLOBAL the bootstrap installs; the frozen
    // `context` object a script receives must carry no debug surface at all.
    const hits = shims
      .split("\n")
      .filter((l) => /debug/i.test(l))
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    expect(hits).toEqual([]);
  });

  it("the debug session is only ever built from the host's own mount definition", () => {
    const host = read("host.ts");
    const fn = host.slice(host.indexOf("export async function hostStartDebugSession"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    // It resolves the script from the host's mount table...
    expect(body).toContain("mounted.get(scriptId)");
    expect(body).toContain("mw.definition");
    // ...and refuses anything it does not already own.
    expect(body).toMatch(/throw new Error\("Cannot debug a script that is not mounted/);
  });

  it("only a session mount carries the debug spec", () => {
    const host = read("host.ts");
    // Exactly one place sets MountSpec.debug, and it is conditional on a
    // session existing for that script id.
    const assignments = [...host.matchAll(/^\s*debug:\s/gm)];
    expect(assignments.length).toBe(1);
    expect(host).toContain("debug: debugSession");
  });

  it("the definition-taking session starter is module-private", () => {
    const host = read("host.ts");
    // `startDebugSessionOn` takes a HostMountDefinition, so exporting it would
    // reopen the source-injection door `hostStartModuleScriptDebugSession`'s
    // id-only contract closed: a caller could mount arbitrary code at the
    // unlocked tier by handing the debugger a definition.
    expect(host).toContain("async function startDebugSessionOn(");
    expect(host).not.toMatch(/export\s+async\s+function\s+startDebugSessionOn\b/);
  });

  it("the MODULE session path still gates on Script Security", () => {
    const host = read("host.ts");
    const fn = host.slice(host.indexOf("export async function hostStartModuleScriptDebugSession"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    // It builds the mount itself now (one inert mount instead of a plain mount
    // followed by an instrumented remount), so the gate `hostMountScript` used
    // to apply has to be applied here, explicitly.
    expect(body).toContain("assertMountAllowed(definition.name)");
    expect(body).toContain("startDebugSessionOn(definition");
  });
});

// ============================================================================
// A DEBUG MOUNT OF A MODULE MACRO EXECUTES NOTHING — pinned at the source, so a
// future edit cannot quietly restore "mounting the macro runs it".
// ============================================================================

describe("inertness is decided by the host, for the module path only", () => {
  it("exactly one call site asks for an inert session, and it is the module one", () => {
    const host = read("host.ts");
    const inertCalls = [...host.matchAll(/startDebugSessionOn\([^)]*?,\s*false\)/gs)];
    expect(inertCalls.length).toBe(1);
    const moduleFn = host.slice(
      host.indexOf("export async function hostStartModuleScriptDebugSession"),
    );
    expect(moduleFn.slice(0, moduleFn.indexOf("\n}\n"))).toMatch(
      /startDebugSessionOn\(definition,[\s\S]*?false\)/,
    );
  });

  it("the worker only skips the entry point when the spec says so", () => {
    const bootstrap = read("worker/bootstrap.ts");
    const mount = bootstrap.slice(bootstrap.indexOf("async function handleMount("));
    const body = mount.slice(0, mount.indexOf("\n}\n"));
    // The decision is read from the MOUNT SPEC — never from the source, never
    // from a heuristic about what the script looks like.
    expect(body).toContain("!spec.debug.autoInvokeSetup");
    // ...and a non-debug mount is untouched: production always invokes setup.
    expect(body).toContain("spec.debug ? !spec.debug.autoInvokeSetup : false");
  });

  it("the inert module body cannot pause — pauseOnEntry belongs to the user's run", () => {
    const bootstrap = read("worker/bootstrap.ts");
    const fn = bootstrap.slice(bootstrap.indexOf("async function runInertModuleBody("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    // The instrumenter yields before every top-level statement, declarations
    // included, so the body evaluation is bracketed by the inert region or a
    // pauseOnEntry session would stop on line 1 of a mount that ran nothing.
    expect(body).toContain("dbg?.beginInert()");
    expect(body).toContain("dbg?.endInert()");
    // In a finally: a throwing module body must not leave the realm deaf to
    // every subsequent breakpoint.
    expect(body).toMatch(/finally\s*\{\s*dbg\?\.endInert\(\);/);
  });
});

describe("the pause itself cannot be weaponized", () => {
  it("the worker never suspends inside a render callback", () => {
    const bootstrap = read("worker/bootstrap.ts");
    // Both render entry points bracket the renderer with a no-pause region.
    const cells = bootstrap.slice(bootstrap.indexOf("function handleRenderCells("));
    expect(cells.slice(0, cells.indexOf("\n}\n"))).toContain("beginNoPause()");
    const draw = bootstrap.slice(bootstrap.indexOf("function handleRenderDraw("));
    expect(draw.slice(0, draw.indexOf("\n}\n"))).toContain("beginNoPause()");
  });

  it("a paused script is skipped by both verdict paths (default-allow)", () => {
    const host = read("host.ts");
    const commit = host.slice(host.indexOf("export async function callRangeBeforeCommit"));
    expect(commit.slice(0, 900)).toContain("isScriptDebugPaused(scriptId)");
    const lifecycle = host.slice(host.indexOf("export async function callWorkbookBeforeLifecycle"));
    expect(lifecycle.slice(0, 900)).toContain("isScriptDebugPaused(scriptId)");
  });

  it("stopping a session resumes before it tears anything down", () => {
    const host = read("host.ts");
    const stop = host.slice(host.indexOf("export async function hostStopDebugSession"));
    const body = stop.slice(0, stop.indexOf("\n}\n"));
    const resumeAt = body.indexOf('action: "stop"');
    const remountAt = body.indexOf("mountWorker(");
    expect(resumeAt).toBeGreaterThan(-1);
    expect(remountAt).toBeGreaterThan(resumeAt);
  });
});
