//! FILENAME: app/extensions/ScriptableObjects/lib/__tests__/debugger.test.ts
// PURPOSE: The editor's breakpoint store and session controller (task H1):
//          breakpoints ROUND-TRIP through the workbook, edits do not leave them
//          pointing at the wrong statement, a live session is updated without a
//          restart, and stopping always goes through the host's stop path.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---- The workbook's extension-data store, faked as a single value ----------
let stored: unknown = null;
const getExtensionData = vi.fn(async () => stored);
const setExtensionData = vi.fn(async (_id: string, value: unknown) => {
  stored = value;
});
vi.mock("@api/extensionData", () => ({
  getExtensionData: (...a: unknown[]) => getExtensionData(...(a as [])),
  setExtensionData: (id: string, value: unknown) => setExtensionData(id, value),
}));

// ---- The script host (this window IS the main window in these tests) -------
const hostStartDebugSession = vi.fn(async () => undefined);
const hostStartModuleScriptDebugSession = vi.fn(async () => undefined);
const hostStopDebugSession = vi.fn(async () => undefined);
const hostDebugControl = vi.fn();
const hostDebugFireTrigger = vi.fn(async () => undefined);
const hostSetDebugBreakpoints = vi.fn();
let hostMounted = false;
let hostSession: unknown = null;
vi.mock("@api/scriptHost/host", () => ({
  hostStartDebugSession: (...a: unknown[]) => hostStartDebugSession(...(a as [])),
  hostStartModuleScriptDebugSession: (...a: unknown[]) =>
    hostStartModuleScriptDebugSession(...(a as [])),
  hostStopDebugSession: (...a: unknown[]) => hostStopDebugSession(...(a as [])),
  hostDebugControl: (...a: unknown[]) => hostDebugControl(...(a as [])),
  hostDebugFireTrigger: (...a: unknown[]) => hostDebugFireTrigger(...(a as [])),
  hostSetDebugBreakpoints: (...a: unknown[]) => hostSetDebugBreakpoints(...(a as [])),
  hostIsMounted: () => hostMounted,
  getDebugSession: () => hostSession,
}));

const emitTauriEvent = vi.fn(async () => undefined);
/** Cross-window listeners the module registered, so a test can deliver to them. */
const tauriListeners = new Map<string, (payload: unknown) => void>();
const listenTauriEvent = vi.fn(async (event: string, handler: (payload: unknown) => void) => {
  tauriListeners.set(event, handler);
  return () => {
    if (tauriListeners.get(event) === handler) tauriListeners.delete(event);
  };
});
vi.mock("@api/backend", () => ({
  emitTauriEvent: (...a: unknown[]) => emitTauriEvent(...(a as [])),
  listenTauriEvent: (...a: unknown[]) =>
    listenTauriEvent(...(a as [string, (payload: unknown) => void])),
}));

import * as dbg from "../debugger";

const SCRIPT = "script-1";

async function flushPersist(): Promise<void> {
  // The write-back is debounced by 400ms.
  await vi.advanceTimersByTimeAsync(500);
}

describe("breakpoint store", () => {
  beforeEach(() => {
    stored = null;
    // The session goes FIRST. `clearAllBreakpoints` now retargets a live
    // session (that is the fix, not an accident), so clearing while the
    // previous test's session is still installed schedules an async
    // `hostSetDebugBreakpoints` that lands AFTER the mockClear below and reads
    // as this test's call.
    hostSession = null;
    dbg.clearAllBreakpoints();
    getExtensionData.mockClear();
    setExtensionData.mockClear();
    hostSetDebugBreakpoints.mockClear();
  });

  it("toggles on and off", () => {
    expect(dbg.getBreakpointLines(SCRIPT)).toEqual([]);
    dbg.toggleBreakpoint(SCRIPT, 12);
    expect(dbg.getBreakpointLines(SCRIPT)).toEqual([12]);
    dbg.toggleBreakpoint(SCRIPT, 5);
    expect(dbg.getBreakpointLines(SCRIPT)).toEqual([5, 12]);
    dbg.toggleBreakpoint(SCRIPT, 12);
    expect(dbg.getBreakpointLines(SCRIPT)).toEqual([5]);
  });

  it("PERSISTS to the workbook so a session survives a reload", async () => {
    vi.useFakeTimers();
    try {
      dbg.toggleBreakpoint(SCRIPT, 3);
      dbg.toggleBreakpoint(SCRIPT, 9);
      await flushPersist();
    } finally {
      vi.useRealTimers();
    }
    expect(setExtensionData).toHaveBeenCalledWith(dbg.DEBUG_EXTENSION_DATA_ID, {
      breakpoints: { [SCRIPT]: [3, 9] },
    });
    expect(stored).toEqual({ breakpoints: { [SCRIPT]: [3, 9] } });
  });

  it("ROUND-TRIPS: a fresh module load restores what the workbook holds", async () => {
    stored = { breakpoints: { [SCRIPT]: [4, 8], other: [1] } };
    vi.resetModules();
    const fresh = await import("../debugger");
    await fresh.loadPersistedBreakpoints();
    expect(fresh.getBreakpointLines(SCRIPT)).toEqual([4, 8]);
    expect(fresh.getBreakpointLines("other")).toEqual([1]);
    expect(fresh.breakpointsLoaded()).toBe(true);
  });

  it("ignores junk in the persisted payload", async () => {
    stored = { breakpoints: { [SCRIPT]: [3, -1, 0, "x", 3, 2.5, 7] } };
    vi.resetModules();
    const fresh = await import("../debugger");
    await fresh.loadPersistedBreakpoints();
    expect(fresh.getBreakpointLines(SCRIPT)).toEqual([3, 7]);
  });

  it("survives a backend that refuses to answer", async () => {
    getExtensionData.mockRejectedValueOnce(new Error("no workbook"));
    vi.resetModules();
    const fresh = await import("../debugger");
    await expect(fresh.loadPersistedBreakpoints()).resolves.toBeUndefined();
    expect(fresh.getBreakpointLines(SCRIPT)).toEqual([]);
  });

  it("emits a change event the gutter can listen to", () => {
    const seen: number[][] = [];
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<{ scriptId: string; breakpoints: Array<{ line: number }> }>).detail;
      if (detail.scriptId === SCRIPT) seen.push(detail.breakpoints.map((b) => b.line));
    };
    window.addEventListener(dbg.DebugEvents.BREAKPOINTS_CHANGED, handler);
    dbg.toggleBreakpoint(SCRIPT, 6);
    dbg.clearBreakpoints(SCRIPT);
    window.removeEventListener(dbg.DebugEvents.BREAKPOINTS_CHANGED, handler);
    expect(seen).toEqual([[6], []]);
  });
});

describe("breakpoints stay anchored across edits", () => {
  beforeEach(() => {
    stored = null;
    dbg.clearAllBreakpoints();
    hostSession = null;
  });

  it("moves breakpoints down when lines are inserted above", () => {
    dbg.toggleBreakpoint(SCRIPT, 5);
    dbg.toggleBreakpoint(SCRIPT, 10);
    dbg.shiftBreakpoints(SCRIPT, 3, 2);
    expect(dbg.getBreakpointLines(SCRIPT)).toEqual([7, 12]);
  });

  it("leaves breakpoints above the edit alone", () => {
    dbg.toggleBreakpoint(SCRIPT, 2);
    dbg.toggleBreakpoint(SCRIPT, 20);
    dbg.shiftBreakpoints(SCRIPT, 10, 3);
    expect(dbg.getBreakpointLines(SCRIPT)).toEqual([2, 23]);
  });

  it("drops breakpoints on deleted lines", () => {
    dbg.toggleBreakpoint(SCRIPT, 6);
    dbg.toggleBreakpoint(SCRIPT, 12);
    // Three lines removed starting at line 5.
    dbg.shiftBreakpoints(SCRIPT, 5, -3);
    expect(dbg.getBreakpointLines(SCRIPT)).toEqual([9]);
  });

  it("does nothing for an edit that changes no line count", () => {
    dbg.toggleBreakpoint(SCRIPT, 4);
    dbg.shiftBreakpoints(SCRIPT, 2, 0);
    expect(dbg.getBreakpointLines(SCRIPT)).toEqual([4]);
  });
});

describe("session control (local transport)", () => {
  beforeEach(() => {
    stored = null;
    // See the store's beforeEach: the session is torn down before the clear.
    hostSession = null;
    dbg.clearAllBreakpoints();
    hostStartDebugSession.mockClear();
    hostStopDebugSession.mockClear();
    hostDebugControl.mockClear();
    hostSetDebugBreakpoints.mockClear();
    emitTauriEvent.mockClear();
  });

  it("starts a session with the script's current breakpoints", async () => {
    dbg.toggleBreakpoint(SCRIPT, 3);
    dbg.toggleBreakpoint(SCRIPT, 8);
    await dbg.startDebugSession(SCRIPT, { pauseOnEntry: true });
    expect(hostStartDebugSession).toHaveBeenCalledWith(SCRIPT, [3, 8], { pauseOnEntry: true });
  });

  it("stopping goes through the host's stop path (which always resumes)", async () => {
    await dbg.stopDebugSession(SCRIPT);
    expect(hostStopDebugSession).toHaveBeenCalledWith(SCRIPT);
  });

  it("forwards step actions", async () => {
    await dbg.debugControl(SCRIPT, "stepOver");
    expect(hostDebugControl).toHaveBeenCalledWith(SCRIPT, "stepOver");
  });

  it("pushes a breakpoint change into a LIVE session without restarting it", async () => {
    hostSession = { scriptId: SCRIPT, status: "running" };
    // Seed the local mirror the way a host broadcast would.
    window.dispatchEvent(
      new CustomEvent(dbg.DebugEvents.STATE_CHANGED, {
        detail: { scriptId: SCRIPT, session: hostSession },
      }),
    );
    dbg.toggleBreakpoint(SCRIPT, 11);
    await new Promise((r) => setTimeout(r, 0));
    expect(hostSetDebugBreakpoints).toHaveBeenCalledWith(SCRIPT, [11]);
    expect(hostStartDebugSession).not.toHaveBeenCalled();
  });

  it("CLEAR ALL reaches a live session, not just the gutter", async () => {
    // The defect this pins: `clearAllBreakpoints` used to go round `commit`,
    // so it cleared the map, announced and persisted — and never told the
    // RUNNING session. The gutter emptied and the runtime went on stopping at
    // every line. It is now one `mutate` per script, which cannot forget,
    // because forgetting is not one of the things `mutate` can do.
    hostSession = { scriptId: SCRIPT, status: "running" };
    window.dispatchEvent(
      new CustomEvent(dbg.DebugEvents.STATE_CHANGED, {
        detail: { scriptId: SCRIPT, session: hostSession },
      }),
    );
    dbg.toggleBreakpoint(SCRIPT, 7);
    await new Promise((r) => setTimeout(r, 0));
    hostSetDebugBreakpoints.mockClear();

    dbg.clearAllBreakpoints();
    await new Promise((r) => setTimeout(r, 0));

    expect(hostSetDebugBreakpoints).toHaveBeenCalledWith(SCRIPT, []);
    expect(dbg.getBreakpointLines(SCRIPT)).toEqual([]);
  });

  it("does not touch the host when there is no session", async () => {
    window.dispatchEvent(
      new CustomEvent(dbg.DebugEvents.STATE_CHANGED, {
        detail: { scriptId: SCRIPT, session: null },
      }),
    );
    expect(dbg.getDebugSession(SCRIPT)).toBeNull();
    dbg.toggleBreakpoint(SCRIPT, 11);
    await new Promise((r) => setTimeout(r, 0));
    expect(hostSetDebugBreakpoints).not.toHaveBeenCalled();
  });
});

describe("session control (remote transport — the standalone editor window)", () => {
  it("sends commands over the window bridge instead of calling the host", async () => {
    vi.resetModules();
    const fresh = await import("../debugger");
    fresh.setRemoteDebugTransport();
    fresh.toggleBreakpoint(SCRIPT, 2);
    emitTauriEvent.mockClear();
    hostStartDebugSession.mockClear();

    await fresh.startDebugSession(SCRIPT);
    await fresh.debugControl(SCRIPT, "continue");
    await fresh.stopDebugSession(SCRIPT);

    expect(hostStartDebugSession).not.toHaveBeenCalled();
    const commands = emitTauriEvent.mock.calls.map((c) => (c as unknown[])[1]);
    // EVERY command carries an id from one monotonic sequence — the bridge
    // echoes it on the answer, and that echo is what pairs an answer with the
    // command it answers rather than with the oldest one outstanding.
    expect(commands).toEqual([
      {
        id: 1,
        command: "start",
        scriptId: SCRIPT,
        lines: [2],
        pauseOnEntry: false,
        fromModuleStore: false,
      },
      { id: 2, command: "control", scriptId: SCRIPT, action: "continue" },
      { id: 3, command: "stop", scriptId: SCRIPT },
    ]);
  });

  it("the attempt token a start returns IS the id on its wire command", async () => {
    vi.resetModules();
    const fresh = await import("../debugger");
    fresh.setRemoteDebugTransport();
    emitTauriEvent.mockClear();

    const first = await fresh.startDebugSession(SCRIPT);
    const second = await fresh.startDebugSession(SCRIPT);

    const ids = emitTauriEvent.mock.calls.map((c) => ((c as unknown[])[1] as { id: number }).id);
    expect(ids).toEqual([first, second]);
    expect(second).toBeGreaterThan(first);
  });

  // THE SECURITY PROPERTY: the editor window can name a module, never define
  // one. A `start` that carried source would be a door for mounting arbitrary
  // code at the unlocked tier from another window.
  it("NEVER puts script source on the bridge, even for a module macro", async () => {
    vi.resetModules();
    const fresh = await import("../debugger");
    fresh.setRemoteDebugTransport();
    emitTauriEvent.mockClear();

    await fresh.startDebugSession(SCRIPT, { mountFromModuleStore: true });

    const [command] = emitTauriEvent.mock.calls.map((c) => (c as unknown[])[1]) as Array<
      Record<string, unknown>
    >;
    expect(command).toEqual({
      id: 1,
      command: "start",
      scriptId: SCRIPT,
      lines: [],
      pauseOnEntry: false,
      fromModuleStore: true,
    });
    expect(JSON.stringify(command)).not.toContain("setCellValue");
    expect(Object.keys(command)).not.toContain("mount");
    expect(Object.keys(command)).not.toContain("source");
  });
});

// ============================================================================
// Run-at-cursor (VBA F5)
// ============================================================================

const MACRO_SOURCE = [
  "async function writeA1(api) {",          // 1
  "  await api.setCellValue(0, 0, 'v1');",  // 2
  "}",                                        // 3
  "",                                         // 4
  "async function writeB1(api) {",          // 5
  "  await api.setCellValue(0, 1, 'x');",   // 6
  "}",                                         // 7
  "",                                         // 8
  "function setup(context) {",              // 9
  "  return writeA1(context.api);",         // 10
  "}",                                        // 11
].join("\n");

/** Seed / clear the debugger's own session mirror the way a host broadcast would. */
function seedLocalSession(scriptId: string, session: unknown): void {
  window.dispatchEvent(
    new CustomEvent(dbg.DebugEvents.STATE_CHANGED, { detail: { scriptId, session } }),
  );
}

describe("run-at-cursor (local transport)", () => {
  beforeEach(() => {
    stored = null;
    dbg.clearAllBreakpoints();
    hostSession = null;
    hostMounted = false;
    // The module-level session mirror leaks between tests; clear it so each test
    // starts with no open session for SCRIPT.
    seedLocalSession(SCRIPT, null);
    hostStartDebugSession.mockClear();
    hostStartModuleScriptDebugSession.mockClear();
    hostDebugFireTrigger.mockClear();
    emitTauriEvent.mockClear();
  });

  it("runs the function the CURSOR is in — the second, not the first", async () => {
    const outcome = await dbg.runAtCursor(SCRIPT, MACRO_SOURCE, 6);
    expect(outcome).toEqual({ status: "ran", functionName: "writeB1" });
    // A session had to be opened first (the script was not in one)...
    expect(hostStartDebugSession).toHaveBeenCalledWith(SCRIPT, [], { pauseOnEntry: false });
    // ...and the SECOND function's run-target was fired, not the first.
    expect(hostDebugFireTrigger).toHaveBeenCalledWith(SCRIPT, "method:writeB1");
  });

  it("falls back to the sole non-setup function when the cursor is in setup", async () => {
    const twoLine = [
      "async function onlyOne(api) {",
      "  await api.setCellValue(0, 0, 1);",
      "}",
      "function setup(context) { return onlyOne(context.api); }",
    ].join("\n");
    const outcome = await dbg.runAtCursor(SCRIPT, twoLine, 4); // cursor in setup
    expect(outcome).toEqual({ status: "ran", functionName: "onlyOne" });
    expect(hostDebugFireTrigger).toHaveBeenCalledWith(SCRIPT, "method:onlyOne");
  });

  it("refuses a wrong-arity function with a message, and fires NOTHING", async () => {
    const src = ["function twoArgs(a, b) {", "  return a + b;", "}"].join("\n");
    const outcome = await dbg.runAtCursor(SCRIPT, src, 2);
    expect(outcome.status).toBe("badArity");
    if (outcome.status === "badArity") {
      expect(outcome.functionName).toBe("twoArgs");
      expect(outcome.message).toMatch(/2 arguments/);
    }
    expect(hostDebugFireTrigger).not.toHaveBeenCalled();
    expect(hostStartDebugSession).not.toHaveBeenCalled();
  });

  // TWO DIFFERENT STATES, AND THE OLD SENTENCE TOLD BOTH OF THEM TO MOVE THE
  // CURSOR. "Put the cursor inside a top-level function" is not a remedy in a
  // file that declares none — there is nowhere to put it — and a message whose
  // only instruction is impossible reads as a fact about the editor rather than
  // about the file.
  it("says so when the cursor resolves to no runnable function", async () => {
    const src = ["const x = 1;", "const y = 2;"].join("\n"); // no top-level functions
    const outcome = await dbg.runAtCursor(SCRIPT, src, 1);
    expect(outcome.status).toBe("noFunction");
    if (outcome.status === "noFunction") {
      expect(outcome.message).toMatch(/declares no top-level function/i);
      // The remedy has to be one this file can actually carry out, and it has
      // to suggest the SAME name everything else does. `doThing` was a third
      // spelling of the run target the scaffolds emit and the authoring prompt
      // asks for, so a reader who followed this sentence and a reader who
      // followed the template ended up with differently-named entry points.
      expect(outcome.message).toContain("async function run()");
      expect(outcome.message).not.toMatch(/put the cursor inside/i);
    }
    expect(hostDebugFireTrigger).not.toHaveBeenCalled();
  });

  it("names the candidates when several functions could be meant", async () => {
    const twoTargets = [
      "function alpha() {", //   1
      "  return 1;", //          2
      "}", //                    3
      "", //                     4
      "function beta() {", //    5
      "  return 2;", //          6
      "}", //                    7
    ].join("\n");
    // Cursor on the blank line between them, and no `setup` to fall back to.
    const outcome = await dbg.runAtCursor(SCRIPT, twoTargets, 4);
    expect(outcome.status).toBe("noFunction");
    if (outcome.status === "noFunction") {
      expect(outcome.message).toMatch(/put the cursor inside/i);
      expect(outcome.message).toContain("alpha or beta");
    }
    expect(hostDebugFireTrigger).not.toHaveBeenCalled();
  });

  it("reuses an OPEN session instead of starting a new one", async () => {
    seedLocalSession(SCRIPT, { scriptId: SCRIPT, status: "waiting" });
    const outcome = await dbg.runAtCursor(SCRIPT, MACRO_SOURCE, 2);
    expect(outcome).toEqual({ status: "ran", functionName: "writeA1" });
    expect(hostStartDebugSession).not.toHaveBeenCalled();
    expect(hostStartModuleScriptDebugSession).not.toHaveBeenCalled();
    expect(hostDebugFireTrigger).toHaveBeenCalledWith(SCRIPT, "method:writeA1");
  });

  it("mounts a macro that has no standing mount BY ID, then fires", async () => {
    const outcome = await dbg.runAtCursor(SCRIPT, MACRO_SOURCE, 2, {
      mountFromModuleStore: true,
    });
    expect(outcome).toEqual({ status: "ran", functionName: "writeA1" });
    // The module path hands the host an ID and nothing else — the host resolves
    // the source from the module store itself.
    expect(hostStartModuleScriptDebugSession).toHaveBeenCalledTimes(1);
    expect(hostStartModuleScriptDebugSession).toHaveBeenCalledWith(SCRIPT, [], {
      pauseOnEntry: false,
    });
    expect(hostStartDebugSession).not.toHaveBeenCalled();
    expect(hostDebugFireTrigger).toHaveBeenCalledWith(SCRIPT, "method:writeA1");
  });

  // THE DOUBLE-RUN. Run on a macro with no session opens one and fires a
  // run-target. The mount used to EXECUTE the macro on its way in, so the editor
  // Run button ran a recorded macro twice per press — once un-stepped at mount,
  // once through the fire. The mount is inert now; the fire is the only
  // execution, and there is exactly one of it.
  it("Run on a cold macro starts ONE session and fires ONE run-target", async () => {
    await dbg.runAtCursor(SCRIPT, MACRO_SOURCE, 2, { mountFromModuleStore: true });

    expect(hostStartModuleScriptDebugSession).toHaveBeenCalledTimes(1);
    expect(hostDebugFireTrigger).toHaveBeenCalledTimes(1);
  });

  // An inert mount registers `setup` as a run-target, so a macro whose whole
  // body lives in setup is runnable rather than a Run button that does nothing.
  it("resolves setup() when there is no other top-level function", async () => {
    const allInSetup = [
      "function setup(context) {",
      "  return context.api.setCellValue(0, 0, 1);",
      "}",
    ].join("\n");
    seedLocalSession(SCRIPT, {
      scriptId: SCRIPT,
      status: "waiting",
      autoInvokeSetup: false,
      triggers: [{ id: "method:setup", kind: "method", name: "setup", fireable: true }],
    });

    const outcome = await dbg.runAtCursor(SCRIPT, allInSetup, 2, {
      mountFromModuleStore: true,
    });

    expect(outcome).toEqual({ status: "ran", functionName: "setup" });
    expect(hostDebugFireTrigger).toHaveBeenCalledWith(SCRIPT, "method:setup");
  });

  // ...but on a mount that INVOKED setup (every object script) it is not a run
  // target, and "try again in a moment" would be false advice for a wait that
  // never ends.
  //
  // AND THE REMEDY MUST EXIST IN THE FILE BEING EDITED. This sentence used to
  // end "Put the cursor inside another top-level function to run that, or fire
  // one of the triggers in the debug panel" — unconditionally, both halves,
  // whatever the script held.
  it("explains, rather than firing, when setup() is not a run target", async () => {
    const allInSetup = ["function setup(context) {", "  return 1;", "}"].join("\n");
    seedLocalSession(SCRIPT, {
      scriptId: SCRIPT,
      status: "waiting",
      autoInvokeSetup: true,
      triggers: [{ id: "hook:onClick", kind: "hook", name: "onClick", fireable: true }],
    });

    const outcome = await dbg.runAtCursor(SCRIPT, allInSetup, 2);

    expect(outcome.status).toBe("notReady");
    if (outcome.status === "notReady") {
      expect(outcome.message).toMatch(/entry point this mount already ran/i);
      expect(outcome.message).not.toMatch(/try run again/i);
      // The half that is REAL, named rather than gestured at.
      expect(outcome.message).toContain("onClick");
      // The half that is not: this file declares no other top-level function.
      expect(outcome.message).not.toMatch(/another top-level function/i);
      expect(outcome.message).not.toMatch(/put the cursor/i);
      // ...and because that half was dropped, the trigger sentence must not
      // open on "Or". A dangling conjunction reads as the second half of advice
      // the reader never got, which is the same disease as offering a remedy
      // that does not exist.
      expect(outcome.message).not.toMatch(/\bOr fire\b/);
      expect(outcome.message).toMatch(/\bFire one of the triggers\b/);
    }
    expect(hostDebugFireTrigger).not.toHaveBeenCalled();
  });

  // THE MESSAGE THE USER ACTUALLY HIT (reported 2026-08-25). One `setup` in the
  // file, nothing registered, session finished — so BOTH offered remedies were
  // impossible: there is no "another top-level function", and there is no
  // trigger in the debug panel to fire.
  it("offers something REAL when the file holds only setup() and nothing registered", async () => {
    const allInSetup = ["function setup(context) {", "  context.log('hi');", "}"].join("\n");
    seedLocalSession(SCRIPT, {
      scriptId: SCRIPT,
      status: "finished",
      autoInvokeSetup: true,
      triggers: [],
    });

    const outcome = await dbg.runAtCursor(SCRIPT, allInSetup, 2);

    expect(outcome.status).toBe("notReady");
    if (outcome.status === "notReady") {
      expect(outcome.message).toMatch(/no entry point/i);
      // Same name as the sibling refusal above, and as the scaffold.
      expect(outcome.message).toContain("async function run()");
      expect(outcome.message).not.toMatch(/another top-level function/i);
      expect(outcome.message).not.toMatch(/fire/i);
    }
    expect(hostDebugFireTrigger).not.toHaveBeenCalled();
  });

  // THE OTHER HALF OF THE SAME RULE: when the file does declare other functions
  // the cursor remedy is real and must survive. The trigger offer beside it must
  // not repeat them — a run-target IS one of those functions, and the button
  // beside it in the debug panel says "Run", not "Fire".
  it("names the other functions, and does not re-offer them as triggers", async () => {
    const src = [
      "function alpha() { return 1; }", //  1
      "function beta() { return 2; }", //   2
      "function setup(context) {", //       3
      "  context.log('ready');", //         4
      "}", //                               5
    ].join("\n");
    seedLocalSession(SCRIPT, {
      scriptId: SCRIPT,
      status: "waiting",
      autoInvokeSetup: true,
      triggers: [
        { id: "method:alpha", kind: "method", name: "alpha", fireable: true, runTarget: true },
        { id: "method:beta", kind: "method", name: "beta", fireable: true, runTarget: true },
        { id: "hook:onClick", kind: "hook", name: "onClick", fireable: true },
      ],
    });

    const outcome = await dbg.runAtCursor(SCRIPT, src, 4); // cursor inside setup

    expect(outcome.status).toBe("notReady");
    if (outcome.status === "notReady") {
      expect(outcome.message).toMatch(/put the cursor inside/i);
      expect(outcome.message).toContain("alpha or beta");
      expect(outcome.message).toContain("onClick");
      // The positive control for the dangling-"Or" guard in the setup-only
      // case above: HERE a cursor remedy really did precede the trigger offer,
      // so the conjunction is correct and must survive.
      expect(outcome.message).toMatch(/\bOr fire one of the triggers\b/);
      // THE SABOTAGE THIS PINS: filtering the offer on `fireable` alone writes
      // "alpha(), beta() or onClick" here — telling the user to fire the very
      // functions the sentence before told them to put the cursor in.
      expect(outcome.message).not.toMatch(/alpha\(\)/);
    }
    expect(hostDebugFireTrigger).not.toHaveBeenCalled();
  });

  it("diagnoses a trigger that cannot be fired instead of offering it", async () => {
    const allInSetup = [
      "function setup(context) {",
      "  context.onCellChange(() => {});",
      "}",
    ].join("\n");
    seedLocalSession(SCRIPT, {
      scriptId: SCRIPT,
      status: "waiting",
      autoInvokeSetup: true,
      triggers: [
        {
          id: "hook:onCellChange",
          kind: "hook",
          name: "onCellChange",
          fireable: false,
          reason: "the debugger cannot synthesize a cell edit",
        },
      ],
    });

    const outcome = await dbg.runAtCursor(SCRIPT, allInSetup, 2);

    expect(outcome.status).toBe("notReady");
    if (outcome.status === "notReady") {
      expect(outcome.message).toContain("onCellChange");
      expect(outcome.message).toContain("the debugger cannot synthesize a cell edit");
      // Named as a diagnosis, never as an instruction to fire it...
      expect(outcome.message).not.toMatch(/fire one of the triggers/i);
      // ...and this mount DOES hold a trigger, so it must not claim otherwise.
      expect(outcome.message).not.toMatch(/no entry point/i);
    }
    expect(hostDebugFireTrigger).not.toHaveBeenCalled();
  });

  it("says the script is no longer mounted, and does not quietly remount it", async () => {
    seedLocalSession(SCRIPT, {
      scriptId: SCRIPT,
      status: "detached",
      autoInvokeSetup: true,
      triggers: [],
    });

    const outcome = await dbg.runAtCursor(SCRIPT, MACRO_SOURCE, 6);

    expect(outcome.status).toBe("notReady");
    if (outcome.status === "notReady") {
      expect(outcome.functionName).toBe("writeB1");
      expect(outcome.message).toMatch(/no longer mounted/i);
      expect(outcome.message).toMatch(/press debug/i);
      // Not "in a moment": the realm is gone, and waiting cannot bring it back.
      expect(outcome.message).not.toMatch(/in a moment/i);
    }
    // A detached mirror IS a session as far as runAtCursor is concerned, so it
    // must not open a second one behind the user's back.
    expect(hostStartDebugSession).not.toHaveBeenCalled();
    expect(hostDebugFireTrigger).not.toHaveBeenCalled();
  });

  it("distinguishes a mount that has SETTLED from one still coming up", async () => {
    seedLocalSession(SCRIPT, {
      scriptId: SCRIPT,
      status: "finished",
      autoInvokeSetup: true,
      triggers: [{ id: "hook:onClick", kind: "hook", name: "onClick", fireable: true }],
    });
    const settled = await dbg.runAtCursor(SCRIPT, MACRO_SOURCE, 6);

    expect(settled.status).toBe("notReady");
    if (settled.status === "notReady") {
      expect(settled.message).toMatch(/press stop, then run again/i);
      expect(settled.message).not.toMatch(/in a moment/i);
      // It must NOT claim the user edited the source: the editor restarts a
      // drifted session before it ever calls runAtCursor, so that would be a
      // guess about the person rather than a fact about the mount.
      expect(settled.message).not.toMatch(/edited/i);
    }

    seedLocalSession(SCRIPT, {
      scriptId: SCRIPT,
      status: "running",
      autoInvokeSetup: true,
      triggers: [],
    });
    const early = await dbg.runAtCursor(SCRIPT, MACRO_SOURCE, 6);

    expect(early.status).toBe("notReady");
    if (early.status === "notReady") {
      expect(early.message).toMatch(/in a moment/i);
      expect(early.message).not.toMatch(/press stop/i);
    }
    expect(hostDebugFireTrigger).not.toHaveBeenCalled();
  });

  it("passes on the host's reason when an inert mount had nothing runnable", async () => {
    seedLocalSession(SCRIPT, {
      scriptId: SCRIPT,
      status: "failed",
      autoInvokeSetup: false,
      error: "Nothing in this script can be started from the debugger: no top-level function …",
      triggers: [],
    });

    const outcome = await dbg.runAtCursor(SCRIPT, MACRO_SOURCE, 2, {
      mountFromModuleStore: true,
    });

    expect(outcome.status).toBe("notReady");
    if (outcome.status === "notReady") {
      expect(outcome.message).toMatch(/cannot be started/i);
      expect(outcome.message).toMatch(/no top-level function/i);
      // Not the "setup() failed" wording — nothing ran, so nothing failed.
      expect(outcome.message).not.toMatch(/setup\(\) failed/i);
    }
    expect(hostDebugFireTrigger).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Run-at-cursor over the WINDOW BRIDGE — the cold-start race
// ============================================================================
//
// PROVEN LIVE, then pinned here. In the standalone editor window a fire is
// ONE-WAY: `startDebugSession` returns as soon as the command is on the wire, so
// run-at-cursor has to wait for the main window to finish remounting before it
// fires. It waited for "any status that is not `starting`" — and an instrumented
// remount UNMOUNTS the plain realm first, broadcasting `detached`. Run-at-cursor
// saw `detached`, called the mount settled, and fired into the gap; the host
// answered `"method:x" is not a trigger this script has registered`, the next
// broadcast wiped that error off the panel, and the user got a Run that printed
// "Running x()…" and changed nothing. Running the macro once by any other route
// "fixed" it, because the second Run found an open session and skipped the wait.

describe("run-at-cursor (remote transport — the standalone editor window)", () => {
  /**
   * A state the HOST itself announced (`emitDebugState`), relayed to this window
   * verbatim. It carries NO command: it answers no single command, and a start
   * is legitimately settled by one.
   */
  function broadcast(scriptId: string, session: unknown): void {
    window.dispatchEvent(
      new CustomEvent("objectscript:debug-state", { detail: { scriptId, session } }),
    );
  }

  /**
   * What the MAIN-WINDOW BRIDGE'S CATCH puts on the wire when a relayed command
   * REJECTS — the shape `installObjectScriptDebugBridge` builds, command, id
   * and all.
   *
   * The command is the load-bearing field: `{ session: null, error }` is the
   * shape of a refused mount AND of a `fire` into a session that had already
   * ended, and without the name they are the same message. The id is the other
   * half: it names WHICH start this rejection answers, so two starts in flight
   * are two answers rather than a queue paired by arrival order.
   */
  function bridgeRejection(
    scriptId: string,
    command: string,
    session: unknown,
    error: string,
    commandId: number,
  ): void {
    window.dispatchEvent(
      new CustomEvent("objectscript:debug-state", {
        detail: { scriptId, session, error, command, commandId },
      }),
    );
  }

  /**
   * The bridge's SUCCESS answer to a `start`: sent when the host's start promise
   * resolves, after the host's own settled state, stamped and error-free.
   */
  function bridgeStartAnswered(scriptId: string, session: unknown, commandId: number): void {
    window.dispatchEvent(
      new CustomEvent("objectscript:debug-state", {
        detail: { scriptId, session, command: "start", commandId },
      }),
    );
  }

  /** The ids of the `start` commands this window put on the wire, in order. */
  function startIds(): number[] {
    return (emitTauriEvent.mock.calls.map((c) => (c as unknown[])[1]) as Array<
      Record<string, unknown>
    >)
      .filter((c) => c.command === "start")
      .map((c) => c.id as number);
  }

  /** Yield to the event loop so `startDebugSession` has installed its listener. */
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  const SETTLED = {
    scriptId: SCRIPT,
    status: "waiting",
    triggers: [{ id: "method:writeB1", kind: "method", name: "writeB1", fireable: true }],
  };

  it("does NOT fire while the remount is mid-flight, and fires once it settles", async () => {
    vi.resetModules();
    const fresh = await import("../debugger");
    fresh.setRemoteDebugTransport();
    emitTauriEvent.mockClear();

    const pending = fresh.runAtCursor(SCRIPT, MACRO_SOURCE, 6);
    // Let `startDebugSession` put its command on the wire and start waiting.
    await tick();
    await tick();

    // The exact sequence the live host emits while it remounts instrumented.
    broadcast(SCRIPT, { scriptId: SCRIPT, status: "starting", triggers: [] });
    broadcast(SCRIPT, { scriptId: SCRIPT, status: "detached", triggers: [] });
    broadcast(SCRIPT, { scriptId: SCRIPT, status: "running", triggers: [] });
    await tick();

    // NOTHING has been fired: only the `start` command is on the wire.
    let commands = emitTauriEvent.mock.calls.map((c) => (c as unknown[])[1]) as Array<
      Record<string, unknown>
    >;
    expect(commands.map((c) => c.command)).toEqual(["start"]);

    // The realm reports in: setup returned and the run-targets exist.
    broadcast(SCRIPT, SETTLED);
    const outcome = await pending;

    expect(outcome).toEqual({ status: "ran", functionName: "writeB1" });
    commands = emitTauriEvent.mock.calls.map((c) => (c as unknown[])[1]) as Array<
      Record<string, unknown>
    >;
    expect(commands.map((c) => c.command)).toEqual(["start", "fire"]);
    expect(commands[1]).toMatchObject({ scriptId: SCRIPT, triggerId: "method:writeB1" });
  });

  it("says so instead of firing when the run target was never registered", async () => {
    vi.resetModules();
    const fresh = await import("../debugger");
    fresh.setRemoteDebugTransport();
    emitTauriEvent.mockClear();

    const pending = fresh.runAtCursor(SCRIPT, MACRO_SOURCE, 6);
    await tick();
    await tick();
    // setup threw, so nothing was registered.
    broadcast(SCRIPT, {
      scriptId: SCRIPT,
      status: "failed",
      triggers: [],
      error: "boom",
    });
    const outcome = await pending;

    expect(outcome.status).toBe("notReady");
    if (outcome.status === "notReady") {
      expect(outcome.functionName).toBe("writeB1");
      expect(outcome.message).toMatch(/boom/);
    }
    const commands = emitTauriEvent.mock.calls.map((c) => (c as unknown[])[1]) as Array<
      Record<string, unknown>
    >;
    expect(commands.map((c) => c.command)).toEqual(["start"]);
  });

  /** What the distributed-application consent gate refuses a mount with. */
  const CONSENT_REFUSAL =
    "DISTRIBUTED_SCRIPT_NOT_CONSENTED: 'macro1' arrived in the application 'SalesApp' and " +
    "you have not approved that application's code, so it will not run. Approve the " +
    "application first — code that arrives in an application stays switched off until you do.";

  /** The commands this window put on the bridge, in order. */
  function bridgeCommands(): string[] {
    return (emitTauriEvent.mock.calls.map((c) => (c as unknown[])[1]) as Array<
      Record<string, unknown>
    >).map((c) => c.command as string);
  }

  // THE DEFECT (DEFECT B). This test used to assert `{ status: "ran" }` for
  // exactly this broadcast, which is the bug written down as an expectation: the
  // mount was REFUSED, the mirror therefore held no session, the trigger check
  // below refuses only on evidence — so control fell through, fired into a script
  // that had never mounted, and the editor printed "Running writeB1()…".
  //
  // The refusal was already arriving; it was simply thrown away. The bridge's
  // catch broadcasts `{ session: null, error }` with the gate's own sentence in
  // it, and `waitForDebugSettled` used it only to stop waiting.
  it("reports the host's REFUSAL rather than a run that never started", async () => {
    vi.resetModules();
    const fresh = await import("../debugger");
    fresh.setRemoteDebugTransport();
    emitTauriEvent.mockClear();

    const pending = fresh.runAtCursor(SCRIPT, MACRO_SOURCE, 6);
    await tick();
    await tick();
    // The consent gate threw at the mount boundary, so the host never built a
    // session: the bridge relays its reason beside a null.
    bridgeRejection(SCRIPT, "start", null, CONSENT_REFUSAL, startIds()[0]);
    const outcome = await pending;

    expect(outcome.status).toBe("startRefused");
    if (outcome.status === "startRefused") {
      expect(outcome.functionName).toBe("writeB1");
      // THE AUTHOR MUST READ THE REASON, not a generic "not ready": which
      // application, and what to do about it. Both come from the gate verbatim.
      expect(outcome.message).toContain("SalesApp");
      expect(outcome.message).toContain("you have not approved that application's code");
      expect(outcome.message).toContain("Approve the application first");
      expect(outcome.message).not.toMatch(/in a moment/i);
      expect(outcome.message).not.toMatch(/not one of the run targets/i);
    }
    // ...and nothing was fired into the script that does not exist.
    expect(bridgeCommands()).toEqual(["start"]);
  });

  // THE ORDERING THAT MAKES A LISTENER-ONLY FIX WRONG. The bridge can answer
  // while `startDebugSession` is still awaiting its round trip — before
  // `waitForDebugSettled` has installed any listener of its own. Reading the
  // refusal only from that listener would miss it, wait out the 20-second
  // backstop, and then fire into nothing anyway. The record is written by the
  // module-level mirror listener, which is always already listening.
  it("does not miss a refusal that lands while the start is still on the wire", async () => {
    vi.resetModules();
    const fresh = await import("../debugger");
    fresh.setRemoteDebugTransport();
    emitTauriEvent.mockClear();
    emitTauriEvent.mockImplementationOnce(async (...args: unknown[]) => {
      // The answer echoes the id of the very command being put on the wire.
      const cmd = args[1] as { id: number };
      bridgeRejection(SCRIPT, "start", null, CONSENT_REFUSAL, cmd.id);
      return undefined;
    });

    const pending = fresh.runAtCursor(SCRIPT, MACRO_SOURCE, 6);
    // AND IT MUST BE ANSWERED NOW, not in twenty seconds. An answer that has
    // already arrived cannot be waited for: a listener-only fix resolves this
    // case on the backstop timer, which is the same silence in slower form. The
    // microtask flush lets the whole chain settle without letting ANY timer run.
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(settled, "the refusal was answered without waiting out the backstop").toBe(true);

    const outcome = await pending;

    expect(outcome.status).toBe("startRefused");
    if (outcome.status === "startRefused") {
      expect(outcome.message).toContain("SalesApp");
    }
    expect(bridgeCommands()).toEqual(["start"]);
  });

  // THE OTHER HALF OF "ON EVIDENCE". An error broadcast that comes WITH a session
  // is not a refusal to open one — a fire rejects with whatever the script threw,
  // and a `setup` that threw keeps its session on purpose. The mirror still
  // decides those, so the message stays the one that can name the failure.
  it("an error beside a LIVE session is not a refusal", async () => {
    vi.resetModules();
    const fresh = await import("../debugger");
    fresh.setRemoteDebugTransport();
    emitTauriEvent.mockClear();

    const pending = fresh.runAtCursor(SCRIPT, MACRO_SOURCE, 6);
    await tick();
    await tick();
    bridgeRejection(
      SCRIPT,
      "start",
      { scriptId: SCRIPT, status: "failed", autoInvokeSetup: true, triggers: [], error: "boom" },
      "boom",
      startIds()[0],
    );
    const outcome = await pending;

    expect(outcome.status).toBe("notReady");
    if (outcome.status === "notReady") {
      expect(outcome.message).toMatch(/boom/);
    }
    expect(bridgeCommands()).toEqual(["start"]);
  });

  // A SLOW MIRROR IS STILL NOT A REFUSAL. Nothing was broadcast between the two
  // Runs, and the second one settles normally: the first Run's refusal answered
  // the first Run only, and must not be read as this one's.
  it("a refusal answers ONE start — the next Run is judged on its own broadcast", async () => {
    vi.resetModules();
    const fresh = await import("../debugger");
    fresh.setRemoteDebugTransport();
    emitTauriEvent.mockClear();

    const refused = fresh.runAtCursor(SCRIPT, MACRO_SOURCE, 6);
    await tick();
    await tick();
    bridgeRejection(SCRIPT, "start", null, CONSENT_REFUSAL, startIds()[0]);
    expect((await refused).status).toBe("startRefused");

    const allowed = fresh.runAtCursor(SCRIPT, MACRO_SOURCE, 6);
    await tick();
    await tick();
    broadcast(SCRIPT, SETTLED);
    expect(await allowed).toEqual({ status: "ran", functionName: "writeB1" });
    expect(bridgeCommands()).toEqual(["start", "start", "fire"]);
  });

  // A REFUSAL NOBODY CONSUMED MUST NOT BECOME THE NEXT RUN'S ANSWER. Pressing
  // Debug records a refusal that no `runAtCursor` was waiting for; the Run after
  // it is a different question, and here it is one the mirror never answers at
  // all. That is the "not caught up" case, and it has to keep falling through to
  // the host — which is authoritative and refuses for itself — instead of being
  // told no by a reason left over from a different attempt.
  it("does not answer a Run with a refusal left over from an earlier Debug press", async () => {
    vi.resetModules();
    const fresh = await import("../debugger");
    fresh.setRemoteDebugTransport();
    emitTauriEvent.mockClear();

    await fresh.startDebugSession(SCRIPT);
    bridgeRejection(SCRIPT, "start", null, CONSENT_REFUSAL, startIds()[0]);

    vi.useFakeTimers();
    try {
      const pending = fresh.runAtCursor(SCRIPT, MACRO_SOURCE, 6);
      // Nothing is broadcast for THIS start: the wait ends on its backstop.
      await vi.advanceTimersByTimeAsync(21000);
      expect(await pending).toEqual({ status: "ran", functionName: "writeB1" });
    } finally {
      vi.useRealTimers();
    }
    expect(bridgeCommands()).toEqual(["start", "start", "fire"]);
  });

  // ==========================================================================
  // THE RECORD NEEDS AN ATTEMPT IDENTITY (defect 1)
  // ==========================================================================
  //
  // A bare `Map<scriptId, reason>` answers exactly one outstanding start. Two
  // are ordinary: `runFromCursor` had no in-flight guard and F5 is a Monaco
  // keybinding, which AUTO-REPEATS. The two probes below are the two halves of
  // the misattribution that shape produces — one Run reading somebody else's
  // answer, and one Run reading NO answer and inventing "ran" in its place.

  // PROBE 1. Both starts are refused, so there are two answers and two askers.
  // The single slot could hold only one: the first Run consumed it, the second
  // read null, found no session in the mirror, fell through the evidence-only
  // trigger check (an empty mirror is not evidence) and fired into a script that
  // had never mounted — reporting `{ status: "ran" }`, the exact lie the refusal
  // record exists to prevent.
  it("two overlapping Runs each get their OWN answer — neither invents a run", async () => {
    vi.resetModules();
    const fresh = await import("../debugger");
    fresh.setRemoteDebugTransport();
    emitTauriEvent.mockClear();

    const first = fresh.runAtCursor(SCRIPT, MACRO_SOURCE, 6);
    await tick();
    await tick();
    const second = fresh.runAtCursor(SCRIPT, MACRO_SOURCE, 6);
    await tick();
    await tick();

    // The host refuses both mounts; the bridge relays one error per start, in
    // the order the starts reached it, each naming the start it answers.
    bridgeRejection(SCRIPT, "start", null, CONSENT_REFUSAL, startIds()[0]);
    bridgeRejection(SCRIPT, "start", null, CONSENT_REFUSAL, startIds()[1]);

    const outcomes = await Promise.all([first, second]);
    expect(outcomes.map((o) => o.status)).toEqual(["startRefused", "startRefused"]);
    for (const outcome of outcomes) {
      if (outcome.status === "startRefused") expect(outcome.message).toContain("SalesApp");
    }
    // ...and NOTHING was fired into a script that never mounted.
    expect(bridgeCommands()).toEqual(["start", "start"]);
  });

  // PROBE 2. The other direction: an answer belonging to an EARLIER gesture must
  // not be handed to a later one. The Debug press was refused, but the refusal
  // arrived after the author had already pressed Run — and the record used to be
  // cleared blind at the top of every start, so whichever answer landed next
  // became that start's, whoever it was actually addressed to. The Run's own
  // mount came up perfectly well and the author was told it had been refused.
  it("does not adopt a Debug press's refusal that lands after a Run has started", async () => {
    vi.resetModules();
    const fresh = await import("../debugger");
    fresh.setRemoteDebugTransport();
    emitTauriEvent.mockClear();

    // The Debug button: its start is on the wire, unanswered.
    await fresh.startDebugSession(SCRIPT);
    await tick();

    // The author presses Run before that answer comes back.
    const run = fresh.runAtCursor(SCRIPT, MACRO_SOURCE, 6);
    await tick();
    await tick();

    // NOW the Debug press is refused. It answers the DEBUG press, by id.
    bridgeRejection(SCRIPT, "start", null, CONSENT_REFUSAL, startIds()[0]);
    await tick();
    // ...and the Run's own mount settles.
    broadcast(SCRIPT, SETTLED);

    expect(await run).toEqual({ status: "ran", functionName: "writeB1" });
    expect(bridgeCommands()).toEqual(["start", "start", "fire"]);
  });

  it("records a start REJECTION even when it carries a non-settled session", async () => {
    // The bridge's catch stamps `session: host.getDebugSession(scriptId)` — and
    // that is whatever the host happens to hold at that instant, NOT evidence the
    // mount came up. A refused `start` can therefore arrive carrying a leftover
    // `detached`/`starting` session.
    //
    // Judging a STAMPED broadcast by the settled test dropped it twice over: the
    // refusal was discarded, and the attempt was never retired — so the queue
    // desynced permanently and every later refused Run answered the wrong
    // attempt and reported "ran" while firing into an unmounted script. A stamped
    // broadcast IS the rejection of that command; the settled test belongs only
    // to unstamped host progress states.
    vi.resetModules();
    const fresh = await import("../debugger");
    fresh.setRemoteDebugTransport();
    emitTauriEvent.mockClear();

    const run = fresh.runAtCursor(SCRIPT, MACRO_SOURCE, 6);
    await tick();
    await tick();

    bridgeRejection(
      SCRIPT,
      "start",
      { scriptId: SCRIPT, status: "detached", triggers: [] },
      CONSENT_REFUSAL,
      startIds()[0],
    );
    await tick();

    const outcome = await run;
    expect(outcome.status, "a refused mount carrying a stale session is still a refusal").toBe(
      "startRefused",
    );
    expect(outcome.message).toContain("SalesApp");
    // Nothing was fired into the script that never mounted.
    expect(bridgeCommands()).toEqual(["start"]);
  });

  it("keeps the attempt queue in step, so the NEXT Run is answered correctly", async () => {
    // The second half of the same defect: a dropped rejection leaves its attempt
    // outstanding, and the next gesture's refusal then answers the STALE attempt
    // instead of the live one.
    vi.resetModules();
    const fresh = await import("../debugger");
    fresh.setRemoteDebugTransport();
    emitTauriEvent.mockClear();

    const first = fresh.runAtCursor(SCRIPT, MACRO_SOURCE, 6);
    await tick();
    await tick();
    bridgeRejection(
      SCRIPT,
      "start",
      { scriptId: SCRIPT, status: "detached", triggers: [] },
      CONSENT_REFUSAL,
      startIds()[0],
    );
    await tick();
    expect((await first).status).toBe("startRefused");
    // The host deletes the session it announced and says so, as it does on every
    // failed mount. Without this the mirror keeps the stale `detached` session
    // and the NEXT Run stops at the trigger-list check with "not ready" — an
    // unreachable state on the live wire, but the reason this line is here.
    broadcast(SCRIPT, null);
    await tick();

    const second = fresh.runAtCursor(SCRIPT, MACRO_SOURCE, 6);
    await tick();
    await tick();
    bridgeRejection(SCRIPT, "start", null, CONSENT_REFUSAL, startIds()[1]);
    await tick();

    expect((await second).status, "the second Run must get its OWN answer").toBe("startRefused");
    expect(bridgeCommands()).toEqual(["start", "start"]);
  });

  // ==========================================================================
  // ONLY A SETTLED SESSION IS AN ANSWER (the critical defect)
  // ==========================================================================
  //
  // `startDebugSessionOn` (app/src/api/scriptHost/host.ts) publishes the session
  // with `status: "starting"` and calls `emitDebugState` BEFORE it awaits
  // `mountWorker`. So a mount the gate refuses puts THREE things on the wire, in
  // this order:
  //     { status: "starting", triggers: [] }   the host announcing the attempt
  //     null                                   the host deleting it again
  //     { session: null, error, command }      the bridge relaying the throw
  //
  // Retiring the outstanding attempt on the FIRST of those consumed it, so the
  // refusal that followed found nothing outstanding and was dropped — and Run,
  // which had never seen a settled status either, fell through to
  // `{ status: "ran" }`. The feature meant to stop a refused mount being reported
  // as a run reported one itself, on the ONLY sequence the real host emits.
  it("the host's pre-mount 'starting' state must not consume the attempt the refusal answers", async () => {
    vi.resetModules();
    const fresh = await import("../debugger");
    fresh.setRemoteDebugTransport();
    emitTauriEvent.mockClear();

    const pending = fresh.runAtCursor(SCRIPT, MACRO_SOURCE, 6);
    await tick();
    await tick();

    // Byte for byte the live sequence, in the live order.
    broadcast(SCRIPT, { scriptId: SCRIPT, status: "starting", triggers: [] });
    broadcast(SCRIPT, null);
    bridgeRejection(SCRIPT, "start", null, CONSENT_REFUSAL, startIds()[0]);

    const outcome = await pending;

    expect(outcome.status).toBe("startRefused");
    if (outcome.status === "startRefused") {
      expect(outcome.message).toContain("SalesApp");
      expect(outcome.message).toContain("Approve the application first");
    }
    // ...and nothing was fired into the script that was never mounted.
    expect(bridgeCommands()).toEqual(["start"]);
  });

  // THE PROBE ABOVE IS THE LIVE SEQUENCE, BUT IT DOES NOT ISOLATE THE RULE: with
  // the settled gate removed it still passes, because the refusal then arrives to
  // an empty queue and is delivered to the Run still waiting (the other half of
  // this fix). This one isolates it — a `starting` that retires an attempt does
  // not merely lose an answer, it MISDELIVERS one.
  //
  // A Debug press is outstanding and nobody is waiting on it; a Run follows. The
  // host announces the Debug mount (`starting`), then refuses it. If `starting`
  // retires an attempt, the queue is off by one and the DEBUG PRESS'S refusal is
  // stamped onto the RUN — whose own mount then comes up perfectly well and is
  // reported to the author as never mounted, in a sentence addressed to somebody
  // else's gesture.
  it("a 'starting' state does not shift a refusal onto the NEXT gesture's start", async () => {
    vi.resetModules();
    const fresh = await import("../debugger");
    fresh.setRemoteDebugTransport();
    emitTauriEvent.mockClear();

    // The Debug button: on the wire, unanswered, and nothing is waiting on it.
    await fresh.startDebugSession(SCRIPT);
    await tick();

    const run = fresh.runAtCursor(SCRIPT, MACRO_SOURCE, 6);
    await tick();
    await tick();

    // The host announces the Debug press's mount before awaiting it...
    broadcast(SCRIPT, { scriptId: SCRIPT, status: "starting", triggers: [] });
    // ...and then refuses it. This answers the DEBUG press.
    bridgeRejection(SCRIPT, "start", null, CONSENT_REFUSAL, startIds()[0]);
    await tick();
    // The Run's own mount settles, with its run-target registered.
    broadcast(SCRIPT, SETTLED);

    expect(await run).toEqual({ status: "ran", functionName: "writeB1" });
    expect(bridgeCommands()).toEqual(["start", "start", "fire"]);
  });

  // The same rule from the other side: a progress state must not CLEAR a refusal
  // either. The host announces `starting` for the NEXT gesture while this Run is
  // still holding the answer to its own.
  it("a progress state does not erase a refusal that has already been recorded", async () => {
    vi.resetModules();
    const fresh = await import("../debugger");
    fresh.setRemoteDebugTransport();
    emitTauriEvent.mockClear();

    const pending = fresh.runAtCursor(SCRIPT, MACRO_SOURCE, 6);
    await tick();
    await tick();
    bridgeRejection(SCRIPT, "start", null, CONSENT_REFUSAL, startIds()[0]);
    // Somebody presses Debug; the host announces that mount before awaiting it.
    broadcast(SCRIPT, { scriptId: SCRIPT, status: "starting", triggers: [] });

    const outcome = await pending;

    expect(outcome.status).toBe("startRefused");
    if (outcome.status === "startRefused") expect(outcome.message).toContain("SalesApp");
    expect(bridgeCommands()).toEqual(["start"]);
  });

  // ==========================================================================
  // A REJECTION IS ONLY AN ANSWER TO THE COMMAND THAT REJECTED
  // ==========================================================================
  //
  // The bridge's catch answers EVERY relayed command with `{ session, error }`,
  // and `host.getDebugSession()` is null whenever the session has already ended —
  // which is exactly when a `fire` or a `stop` rejects. That is byte for byte the
  // shape of a refused mount, and it was stamped onto whatever start happened to
  // be outstanding: a Run whose own mount then came up perfectly well was told
  // the script had never been mounted, in somebody else's words.
  for (const command of ["fire", "stop", "control", "breakpoints"]) {
    it(`a rejected "${command}" is not this start's refusal`, async () => {
      vi.resetModules();
      const fresh = await import("../debugger");
      fresh.setRemoteDebugTransport();
      emitTauriEvent.mockClear();

      const pending = fresh.runAtCursor(SCRIPT, MACRO_SOURCE, 6);
      await tick();
      await tick();

      // The debug panel's own button, on a session that had just auto-ended.
      // Its id is that button's command, never a start's.
      bridgeRejection(
        SCRIPT,
        command,
        null,
        '"method:writeA1" is not a trigger this script has registered',
        4242,
      );
      await tick();
      // ...and THIS Run's mount settles, with its run-target registered.
      broadcast(SCRIPT, SETTLED);

      expect(await pending).toEqual({ status: "ran", functionName: "writeB1" });
      expect(bridgeCommands()).toEqual(["start", "fire"]);
    });
  }

  // A REFUSAL WITH NOTHING OUTSTANDING IS STILL AN ANSWER while a Run is waiting.
  // A settled broadcast for a session this Run did not open (another surface's
  // Debug press on the same script) retires the oldest outstanding attempt, so
  // the refusal that really did answer this Run's start arrives to an empty
  // queue. Dropped there, Run reports a run that never happened — the same
  // silence, reached by a different route.
  it("a refusal that finds nothing outstanding still reaches the Run waiting on it", async () => {
    vi.resetModules();
    const fresh = await import("../debugger");
    fresh.setRemoteDebugTransport();
    emitTauriEvent.mockClear();

    const pending = fresh.runAtCursor(SCRIPT, MACRO_SOURCE, 6);
    await tick();
    await tick();

    // Both land before this Run's continuation can run, so the wait is still
    // registered when the refusal arrives.
    broadcast(SCRIPT, SETTLED);
    bridgeRejection(SCRIPT, "start", null, CONSENT_REFUSAL, startIds()[0]);

    const outcome = await pending;

    expect(outcome.status).toBe("startRefused");
    if (outcome.status === "startRefused") expect(outcome.message).toContain("SalesApp");
    expect(bridgeCommands()).toEqual(["start"]);
  });

  // THE SLOW MIRROR, UNCHANGED. No broadcast at all is not evidence of anything:
  // the wait ends on its backstop and the host — which is authoritative and
  // refuses for itself — gets the fire.
  it("a mirror that never answers still falls through to the host", async () => {
    vi.resetModules();
    const fresh = await import("../debugger");
    fresh.setRemoteDebugTransport();
    emitTauriEvent.mockClear();

    vi.useFakeTimers();
    try {
      const pending = fresh.runAtCursor(SCRIPT, MACRO_SOURCE, 6);
      await vi.advanceTimersByTimeAsync(21000);
      expect(await pending).toEqual({ status: "ran", functionName: "writeB1" });
    } finally {
      vi.useRealTimers();
    }
    expect(bridgeCommands()).toEqual(["start", "fire"]);
  });

  // ==========================================================================
  // AN ANSWER NAMES ITS START — the pairing is the id, not arrival order
  // ==========================================================================
  //
  // Every probe above delivers answers in the order the starts went out, which
  // is the order the host happens to answer them today. That was the whole
  // pairing rule: "the host answers starts in the order it received them, and
  // the bridge relays in order" — a property of two async pipelines that
  // nothing enforced. The bridge now echoes each command's id on its answer,
  // and these probes deliver answers OUT of that order. Each one is red under
  // arrival-order pairing.

  /** A refusal from the OTHER gate, so two answers can be told apart by words. */
  const SECURITY_REFUSAL =
    "SCRIPT_SECURITY: object scripts are disabled for this workbook (Script Security is " +
    "set to Disable All), so 'macro1' will not run.";

  // Two Runs are in flight and both are refused — by DIFFERENT gates, so each
  // answer has words of its own. The answers arrive in the opposite order to the
  // starts. Paired by arrival, the first Run is told the second's reason and
  // vice versa: the right verdict, addressed to the wrong gesture, in words that
  // name a remedy for a refusal that gesture did not get.
  it("out-of-order answers to two outstanding Runs each reach their OWN Run", async () => {
    vi.resetModules();
    const fresh = await import("../debugger");
    fresh.setRemoteDebugTransport();
    emitTauriEvent.mockClear();

    const first = fresh.runAtCursor(SCRIPT, MACRO_SOURCE, 6);
    await tick();
    await tick();
    const second = fresh.runAtCursor(SCRIPT, MACRO_SOURCE, 6);
    await tick();
    await tick();
    const [firstId, secondId] = startIds();
    expect(secondId).toBeGreaterThan(firstId);

    // The SECOND start's answer lands first.
    bridgeRejection(SCRIPT, "start", null, SECURITY_REFUSAL, secondId);
    bridgeRejection(SCRIPT, "start", null, CONSENT_REFUSAL, firstId);

    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe("startRefused");
    expect(b.status).toBe("startRefused");
    if (a.status === "startRefused") {
      expect(a.message, "the first Run reads the answer addressed to ITS start").toContain(
        "SalesApp",
      );
      expect(a.message).not.toContain("Disable All");
    }
    if (b.status === "startRefused") {
      expect(b.message, "the second Run reads the answer addressed to ITS start").toContain(
        "Disable All",
      );
      expect(b.message).not.toContain("SalesApp");
    }
    expect(bridgeCommands()).toEqual(["start", "start"]);
  });

  // THE CASE WHERE ARRIVAL ORDER DID NOT MERELY MISWORD, IT LIED. A Debug press
  // is outstanding with nobody waiting on it; a Run follows; the RUN's refusal
  // comes back first (its gate threw at once; the Debug press's mount is still
  // spawning). Paired by arrival, that refusal was stamped onto the Debug press,
  // the Run found no answer of its own, waited out its twenty-second backstop,
  // and fired into a script that had never mounted — "Running writeB1()…".
  it("a Run's refusal that arrives BEFORE an earlier Debug press's answer reaches the Run", async () => {
    vi.resetModules();
    const fresh = await import("../debugger");
    fresh.setRemoteDebugTransport();
    emitTauriEvent.mockClear();

    vi.useFakeTimers();
    try {
      // The Debug button: on the wire, unanswered, nobody waiting.
      await fresh.startDebugSession(SCRIPT);
      const run = fresh.runAtCursor(SCRIPT, MACRO_SOURCE, 6);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      const [debugId, runId] = startIds();
      expect(runId).toBeGreaterThan(debugId);

      // The Run's own start is refused, and its answer says which start.
      bridgeRejection(SCRIPT, "start", null, CONSENT_REFUSAL, runId);

      // Answered NOW, not on the backstop: a refusal addressed to this Run is
      // not something to keep waiting for.
      let settled = false;
      void run.then(() => {
        settled = true;
      });
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(settled, "the Run's own refusal ended its wait without the backstop").toBe(true);

      // Under arrival-order pairing the wait ends here instead, on the timer,
      // and Run fires into nothing.
      await vi.advanceTimersByTimeAsync(21000);
      const outcome = await run;
      expect(outcome.status, "the refusal reached the Run it was addressed to").toBe(
        "startRefused",
      );
      if (outcome.status === "startRefused") expect(outcome.message).toContain("SalesApp");
    } finally {
      vi.useRealTimers();
    }
    expect(bridgeCommands()).toEqual(["start", "start"]);
  });

  // THE HOST'S OWN STATES ARE ATTRIBUTED AT THE BRIDGE. `emitDebugState` names
  // no command, and cannot: the settled state comes from the worker's `mounted`
  // message, keyed by mount. But the bridge AWAITED this exact start, so when
  // the host's start promise resolves it sends a stamped, error-free answer —
  // after the host's own settled state, which goes out first. That answer
  // retires exactly its own attempt, so the outstanding queue no longer depends
  // on arrival order to drain.
  //
  // WHERE THAT IS VISIBLE: two starts in one tick (F5 auto-repeats), so the
  // first Run's refusal can land before its wait is registered — the window the
  // outstanding queue exists for. The SECOND start is answered first. Retiring
  // the oldest on that answer takes the FIRST start off the queue; its refusal
  // then finds it neither outstanding nor waited on, is dropped, and the first
  // Run waits out its backstop and fires into a script that never mounted.
  it("a stamped success answer retires its own start, leaving an earlier one to its refusal", async () => {
    vi.resetModules();
    const fresh = await import("../debugger");
    fresh.setRemoteDebugTransport();
    emitTauriEvent.mockClear();

    vi.useFakeTimers();
    try {
      // Two Runs in the same tick; the first will be refused, the second comes up.
      const first = fresh.runAtCursor(SCRIPT, MACRO_SOURCE, 6);
      const second = fresh.runAtCursor(SCRIPT, MACRO_SOURCE, 6);
      const [firstId, secondId] = startIds();
      expect(secondId).toBeGreaterThan(firstId);

      // Both answers land before either Run has registered its wait. The
      // second start's answer, stamped, with its session still coming up (so
      // the settled fallback has nothing to say about it)...
      bridgeStartAnswered(SCRIPT, { scriptId: SCRIPT, status: "running", triggers: [] }, secondId);
      // ...then the first start's refusal, beside no session at all.
      bridgeRejection(SCRIPT, "start", null, CONSENT_REFUSAL, firstId);

      let settled = false;
      void first.then(() => {
        settled = true;
      });
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(settled, "the first Run's refusal was still on record when it looked").toBe(true);

      await vi.advanceTimersByTimeAsync(21000);
      const a = await first;
      expect(a.status, "the first Run got the refusal addressed to it").toBe("startRefused");

      // The second Run's mount settles and it runs.
      broadcast(SCRIPT, SETTLED);
      expect(await second).toEqual({ status: "ran", functionName: "writeB1" });
    } finally {
      vi.useRealTimers();
    }
    expect(bridgeCommands()).toEqual(["start", "start", "fire"]);
  });

  // A STAMP WITHOUT AN ID ANSWERS NOTHING. The bridge sets both together and
  // refuses to relay a command that has no id, so this shape cannot come from
  // it. Pairing it by guess would be the arrival-order rule again; it updates
  // the mirror and touches no start, and the Run is judged on what follows.
  it("a stamped broadcast with no id is not paired with any start", async () => {
    vi.resetModules();
    const fresh = await import("../debugger");
    fresh.setRemoteDebugTransport();
    emitTauriEvent.mockClear();

    const pending = fresh.runAtCursor(SCRIPT, MACRO_SOURCE, 6);
    await tick();
    await tick();
    window.dispatchEvent(
      new CustomEvent("objectscript:debug-state", {
        detail: { scriptId: SCRIPT, session: null, error: CONSENT_REFUSAL, command: "start" },
      }),
    );
    await tick();
    broadcast(SCRIPT, SETTLED);

    expect(await pending).toEqual({ status: "ran", functionName: "writeB1" });
    expect(bridgeCommands()).toEqual(["start", "fire"]);
  });
});

// ============================================================================
// The main-window bridge — relaying an error is not reporting a dead session
// ============================================================================
//
// FOUND LIVE, NOT HERE. Debugging a recorded macro whose body threw: the host
// kept the session open on purpose (that is exactly when the debugger is worth
// having), but the STANDALONE EDITOR WINDOW went blank — no badge, no trigger
// list, no Run row to retry with, and no Stop button — while a live,
// instrumented, debugger-owned mount stayed behind it with nothing left in the
// UI able to release it.
//
// The cause was one hard-coded field. The bridge's catch answered every failed
// command with `session: null`, and `subscribeRemoteDebugState` deletes the
// mirror on a null. But most of these commands say nothing about whether the
// session exists: `fire` rejects with whatever the SCRIPT threw. Only the host
// knows, so only the host may answer.
describe("the main-window debug bridge", () => {
  const BRIDGE_COMMAND_EVENT = "objscript:debug-command";
  const BRIDGE_STATE_EVENT = "objscript:debug-state-broadcast";

  /** Broadcasts the bridge sent to the editor window, oldest first. */
  function stateBroadcasts(): Array<Record<string, unknown>> {
    return (emitTauriEvent.mock.calls as unknown as unknown[][])
      .filter((c) => c[0] === BRIDGE_STATE_EVENT)
      .map((c) => c[1] as Record<string, unknown>);
  }

  /** Deliver a command from the editor window and let the relay settle. */
  async function sendFromEditor(cmd: Record<string, unknown>): Promise<void> {
    const handler = tauriListeners.get(BRIDGE_COMMAND_EVENT);
    expect(handler, "the bridge registered a command listener").toBeTypeOf("function");
    handler!(cmd);
    // hostApi() is dynamically imported and the relay is async throughout.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }

  let uninstall: (() => void) | null = null;

  beforeEach(() => {
    tauriListeners.clear();
    emitTauriEvent.mockClear();
    hostDebugFireTrigger.mockClear();
    hostStartDebugSession.mockClear();
    hostSession = null;
    uninstall = dbg.installObjectScriptDebugBridge();
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("keeps the session when a FIRED trigger throws — the error is the script's, not the session's", async () => {
    const live = {
      scriptId: SCRIPT,
      status: "finished",
      autoInvokeSetup: false,
      triggers: [{ id: "method:boom", kind: "method", name: "boom", fireable: true }],
      lastActivity: { label: "boom()", error: "Error: E2EBOOM" },
    };
    hostSession = live;
    hostDebugFireTrigger.mockRejectedValueOnce(new Error("Error: E2EBOOM"));

    await sendFromEditor({ id: 11, command: "fire", scriptId: SCRIPT, triggerId: "method:boom" });

    const broadcasts = stateBroadcasts();
    expect(broadcasts.length, "the editor window was told something").toBeGreaterThan(0);
    const last = broadcasts[broadcasts.length - 1];
    expect(last.error).toContain("E2EBOOM");
    // THE REGRESSION: this used to be null, which deleted the editor's mirror.
    expect(last.session, "the live session survives a run that threw").toBe(live);
  });

  it("still reports null when the host really has no session (a start that failed)", async () => {
    hostSession = null;
    hostStartDebugSession.mockRejectedValueOnce(
      new Error("Cannot debug a script that is not mounted — apply it first."),
    );

    await sendFromEditor({ id: 12, command: "start", scriptId: SCRIPT, lines: [] });

    const last = stateBroadcasts().pop();
    expect(last?.error).toMatch(/not mounted/);
    // Not invented by the catch — the host deleted the session and says so.
    expect(last?.session).toBeNull();
    // ...and it says WHICH command that is the answer to. Without this the
    // editor window cannot tell a refused mount from a `fire` that rejected
    // after the session ended: both are `{ session: null, error }`.
    expect(last?.command).toBe("start");
    // ...and WHICH ONE: the command's own id, echoed. Two starts in flight are
    // two answers, and without this the editor paired them by arrival order.
    expect(last?.commandId).toBe(12);
  });

  it("answers a start that RESOLVED with a stamped, error-free broadcast carrying its id", async () => {
    // The host's own `emitDebugState` cannot name the start it follows (the
    // settled state comes from the worker's `mounted` message, keyed by mount).
    // The bridge awaited this exact start, so it is where the attribution is
    // made — and it is the ONLY command answered on success: a `fire` is not
    // paired with anything, and a success answer per press would be a
    // duplicate render each time.
    const settled = {
      scriptId: SCRIPT,
      status: "waiting",
      autoInvokeSetup: false,
      triggers: [{ id: "method:run", kind: "method", name: "run", fireable: true }],
    };
    hostSession = settled;

    await sendFromEditor({ id: 21, command: "start", scriptId: SCRIPT, lines: [] });

    expect(stateBroadcasts()).toEqual([
      { scriptId: SCRIPT, session: settled, command: "start", commandId: 21 },
    ]);

    await sendFromEditor({ id: 22, command: "fire", scriptId: SCRIPT, triggerId: "method:run" });
    expect(hostDebugFireTrigger).toHaveBeenCalledWith(SCRIPT, "method:run");
    expect(stateBroadcasts().length, "a fire that resolved is not answered").toBe(1);
  });

  it("drops a command that carries no id rather than relaying it unanswerable", async () => {
    // Its rejection could pair with nothing, and a refused mount would be Run's
    // "ran" again. Both ends of the bridge are one file; nothing legitimate
    // sends this.
    await sendFromEditor({ command: "fire", scriptId: SCRIPT, triggerId: "method:boom" });
    await sendFromEditor({ command: "start", scriptId: SCRIPT, lines: [] });

    expect(hostDebugFireTrigger).not.toHaveBeenCalled();
    expect(hostStartDebugSession).not.toHaveBeenCalled();
    expect(stateBroadcasts()).toEqual([]);
  });

  // THE FIELD THE CATCH USED TO DROP. It has the command in hand — it is
  // switching on it three lines up — and every rejection went out anonymous, so
  // the editor window stamped a fire's rejection onto the start it was waiting
  // for and reported a mount that succeeded as never-mounted.
  it("names the command that failed, for every command it relays", async () => {
    hostSession = null;
    hostDebugFireTrigger.mockRejectedValueOnce(new Error("no session to fire into"));
    hostStopDebugSession.mockRejectedValueOnce(new Error("nothing to stop"));

    await sendFromEditor({ id: 31, command: "fire", scriptId: SCRIPT, triggerId: "method:boom" });
    expect(stateBroadcasts().pop()).toMatchObject({ command: "fire", commandId: 31, session: null });

    await sendFromEditor({ id: 32, command: "stop", scriptId: SCRIPT });
    expect(stateBroadcasts().pop()).toMatchObject({ command: "stop", commandId: 32, session: null });
  });
});
