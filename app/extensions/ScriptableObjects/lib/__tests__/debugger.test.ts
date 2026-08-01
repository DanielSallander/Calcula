//! FILENAME: app/extensions/ScriptableObjects/lib/__tests__/debugger.test.ts
// PURPOSE: The editor's breakpoint store and session controller (task H1):
//          breakpoints ROUND-TRIP through the workbook, edits do not leave them
//          pointing at the wrong statement, a live session is updated without a
//          restart, and stopping always goes through the host's stop path.

import { describe, it, expect, beforeEach, vi } from "vitest";

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
const hostStopDebugSession = vi.fn(async () => undefined);
const hostDebugControl = vi.fn();
const hostSetDebugBreakpoints = vi.fn();
let hostSession: unknown = null;
vi.mock("@api/scriptHost/host", () => ({
  hostStartDebugSession: (...a: unknown[]) => hostStartDebugSession(...(a as [])),
  hostStopDebugSession: (...a: unknown[]) => hostStopDebugSession(...(a as [])),
  hostDebugControl: (...a: unknown[]) => hostDebugControl(...(a as [])),
  hostSetDebugBreakpoints: (...a: unknown[]) => hostSetDebugBreakpoints(...(a as [])),
  getDebugSession: () => hostSession,
}));

const emitTauriEvent = vi.fn(async () => undefined);
vi.mock("@api/backend", () => ({
  emitTauriEvent: (...a: unknown[]) => emitTauriEvent(...(a as [])),
  listenTauriEvent: vi.fn(async () => () => undefined),
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
    dbg.clearAllBreakpoints();
    getExtensionData.mockClear();
    setExtensionData.mockClear();
    hostSession = null;
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
    dbg.clearAllBreakpoints();
    hostSession = null;
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
    expect(commands).toEqual([
      { command: "start", scriptId: SCRIPT, lines: [2], pauseOnEntry: false },
      { command: "control", scriptId: SCRIPT, action: "continue" },
      { command: "stop", scriptId: SCRIPT },
    ]);
  });
});
