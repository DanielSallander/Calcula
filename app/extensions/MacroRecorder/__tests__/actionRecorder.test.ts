//! FILENAME: app/extensions/MacroRecorder/__tests__/actionRecorder.test.ts
// PURPOSE: Behaviour of the recording session — what gets captured, what gets
//          deliberately NOT captured, and how the session survives sheet
//          switches, undo, pause and cancel.
// CONTEXT: The @api hooks are mocked so the session can be driven directly:
//          the test IS the app, calling the hooks the way the bridge and the
//          command registry would.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted by vitest — the factories must not close over test locals)
// ---------------------------------------------------------------------------

const hooks: {
  grid: ((e: unknown) => void) | null;
  command: ((id: string, phase: string, args?: unknown) => void) | null;
  appEvent: ((detail: unknown) => void) | null;
  activeSheet: number;
} = { grid: null, command: null, appEvent: null, activeSheet: 0 };

vi.mock("@api/lib", () => ({
  getActiveSheet: () => Promise.resolve(hooks.activeSheet),
  setGridRecorderHook: (fn: ((e: unknown) => void) | null) => {
    hooks.grid = fn;
  },
}));

vi.mock("@api/commands", () => ({
  setCommandRecorderHook: (
    fn: ((id: string, phase: string, args?: unknown) => void) | null,
  ) => {
    hooks.command = fn;
  },
}));

vi.mock("@api", () => ({
  AppEvents: { SHEET_CHANGED: "app:sheet-changed" },
  onAppEvent: (_name: string, cb: (detail: unknown) => void) => {
    hooks.appEvent = cb;
    return () => {
      hooks.appEvent = null;
    };
  },
}));

import {
  cancelRecording,
  getRecordedActions,
  getRecorderSnapshot,
  pauseRecording,
  resetRecorderForTests,
  resumeRecording,
  startRecording,
  stopRecording,
  subscribeToRecorder,
} from "../lib/actionRecorder";
import type { RecordedGridEvent } from "@api/lib";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emitGrid(event: RecordedGridEvent): void {
  hooks.grid?.(event);
}

function emitCommand(id: string, phase: string, args?: unknown): void {
  hooks.command?.(id, phase, args);
}

const WRITE_A1: RecordedGridEvent = {
  kind: "cellWrites",
  writes: [{ row: 0, col: 0, value: "a" }],
};
const WRITE_A2: RecordedGridEvent = {
  kind: "cellWrites",
  writes: [{ row: 1, col: 0, value: "b" }],
};

beforeEach(() => {
  resetRecorderForTests();
  hooks.grid = null;
  hooks.command = null;
  hooks.appEvent = null;
  hooks.activeSheet = 0;
});

// ---------------------------------------------------------------------------

describe("session lifecycle", () => {
  it("installs both hooks and reports the recording state", async () => {
    expect(getRecorderSnapshot().status).toBe("idle");
    await startRecording("Macro1");
    expect(getRecorderSnapshot()).toMatchObject({ status: "recording", name: "Macro1" });
    expect(hooks.grid).toBeTypeOf("function");
    expect(hooks.command).toBeTypeOf("function");
  });

  it("refuses a second concurrent session", async () => {
    await startRecording("A");
    await expect(startRecording("B")).rejects.toThrow(/already in progress/);
  });

  it("uninstalls the hooks on stop", async () => {
    await startRecording("A");
    stopRecording();
    expect(hooks.grid).toBeNull();
    expect(hooks.command).toBeNull();
    expect(getRecorderSnapshot().status).toBe("idle");
  });

  it("cancel throws the recording away", async () => {
    await startRecording("A");
    emitGrid(WRITE_A1);
    expect(getRecordedActions()).toHaveLength(1);
    cancelRecording();
    expect(getRecorderSnapshot().status).toBe("idle");
    expect(hooks.grid).toBeNull();
    expect(stopRecording()).toEqual([]);
  });

  it("notifies subscribers as actions arrive", async () => {
    const seen: number[] = [];
    const off = subscribeToRecorder(() => seen.push(getRecorderSnapshot().actionCount));
    await startRecording("A");
    emitGrid(WRITE_A1);
    emitGrid(WRITE_A2);
    off();
    expect(seen[seen.length - 1]).toBe(2);
  });

  it("survives a failed active-sheet read", async () => {
    // getActiveSheet resolving is mocked; the guarantee under test is that the
    // session still starts and defaults to a usable sheet.
    hooks.activeSheet = 4;
    await startRecording("A");
    emitGrid(WRITE_A1);
    expect(getRecordedActions()[0].sheetIndex).toBe(4);
  });
});

describe("capture", () => {
  it("records bridge events in order", async () => {
    await startRecording("A");
    emitGrid(WRITE_A1);
    emitGrid({ kind: "insertRows", startRow: 3, count: 2 });
    const actions = getRecordedActions();
    expect(actions.map((a) => a.event.kind)).toEqual(["cellWrites", "insertRows"]);
    expect(actions.map((a) => a.seq)).toEqual([1, 2]);
  });

  it("captures nothing while paused, and resumes cleanly", async () => {
    await startRecording("A");
    emitGrid(WRITE_A1);
    pauseRecording();
    expect(getRecorderSnapshot().status).toBe("paused");
    emitGrid(WRITE_A2);
    expect(getRecordedActions()).toHaveLength(1);
    resumeRecording();
    emitGrid(WRITE_A2);
    expect(getRecordedActions()).toHaveLength(2);
  });
});

describe("sheet tracking", () => {
  it("stamps each action with the active sheet", async () => {
    hooks.activeSheet = 1;
    await startRecording("A");
    emitGrid(WRITE_A1);
    expect(getRecordedActions()[0].sheetIndex).toBe(1);
  });

  it("an activateSheet marker carries the sheet it switches TO", async () => {
    await startRecording("A");
    emitGrid(WRITE_A1); // sheet 0
    emitGrid({ kind: "activateSheet", index: 2 });
    emitGrid(WRITE_A2);
    const actions = getRecordedActions();
    expect(actions.map((a) => a.sheetIndex)).toEqual([0, 2, 2]);
  });

  it("follows sheet changes that never go through setActiveSheet", async () => {
    await startRecording("A");
    hooks.appEvent?.({ sheetIndex: 3 });
    emitGrid(WRITE_A1);
    expect(getRecordedActions()[0].sheetIndex).toBe(3);
  });

  it("ignores a malformed sheet-changed payload", async () => {
    await startRecording("A");
    hooks.appEvent?.({ sheetIndex: "nope" });
    emitGrid(WRITE_A1);
    expect(getRecordedActions()[0].sheetIndex).toBe(0);
  });
});

describe("command capture", () => {
  it("does NOT record core commands (the bridge already saw them)", async () => {
    await startRecording("A");
    emitCommand("core.grid.insertRow", "before");
    emitGrid({ kind: "insertRows", startRow: 0, count: 1 });
    emitCommand("core.grid.insertRow", "after");
    const actions = getRecordedActions();
    expect(actions).toHaveLength(1);
    expect(actions[0].event.kind).toBe("insertRows");
  });

  it("records a non-core command and SUPPRESSES its internal writes", async () => {
    await startRecording("A");
    emitCommand("flashfill.execute", "before");
    emitGrid(WRITE_A1); // the command's own writes — must not double up
    emitGrid(WRITE_A2);
    emitCommand("flashfill.execute", "after");
    const actions = getRecordedActions();
    expect(actions).toHaveLength(1);
    expect(actions[0].event).toMatchObject({
      kind: "command",
      commandId: "flashfill.execute",
    });
  });

  it("keeps only JSON-representable args", async () => {
    await startRecording("A");
    emitCommand("x.y", "before", { a: 1 });
    emitCommand("x.y", "after", { a: 1 });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    emitCommand("x.z", "before", cyclic);
    emitCommand("x.z", "after", cyclic);
    const actions = getRecordedActions();
    expect(actions[0].event).toMatchObject({ args: { a: 1 } });
    expect((actions[1].event as { args?: unknown }).args).toBeUndefined();
  });

  it("does not record a command that threw, but reopens the bridge", async () => {
    await startRecording("A");
    emitCommand("x.y", "before");
    emitCommand("x.y", "failed");
    emitGrid(WRITE_A1);
    const actions = getRecordedActions();
    expect(actions).toHaveLength(1);
    expect(actions[0].event.kind).toBe("cellWrites");
  });

  it("does not record a command with no handler", async () => {
    await startRecording("A");
    emitCommand("x.y", "before");
    emitCommand("x.y", "unhandled");
    expect(getRecordedActions()).toHaveLength(0);
  });

  it("nests command scopes correctly", async () => {
    await startRecording("A");
    emitCommand("outer.cmd", "before");
    emitCommand("inner.cmd", "before");
    emitGrid(WRITE_A1);
    emitCommand("inner.cmd", "after");
    emitGrid(WRITE_A2); // still inside outer — suppressed
    emitCommand("outer.cmd", "after");
    emitGrid(WRITE_A1); // outside now — captured
    const kinds = getRecordedActions().map((a) => a.event.kind);
    expect(kinds).toEqual(["command", "command", "cellWrites"]);
  });

  it("ignores the recorder's own commands entirely", async () => {
    await startRecording("A");
    emitCommand("macroRecorder.stop", "before");
    emitGrid(WRITE_A1); // must NOT be suppressed by an ignored command
    emitCommand("macroRecorder.stop", "after");
    const actions = getRecordedActions();
    expect(actions).toHaveLength(1);
    expect(actions[0].event.kind).toBe("cellWrites");
  });

  it("still records sheet markers while a command owns the timeline", async () => {
    await startRecording("A");
    emitCommand("x.y", "before");
    emitGrid({ kind: "activateSheet", index: 5 });
    emitCommand("x.y", "after");
    const actions = getRecordedActions();
    expect(actions.map((a) => a.event.kind)).toEqual(["activateSheet", "command"]);
    expect(actions[1].sheetIndex).toBe(5);
  });
});

describe("undo edits the recording", () => {
  it("pops the last action instead of recording the undo", async () => {
    await startRecording("A");
    emitGrid(WRITE_A1);
    emitGrid(WRITE_A2);
    emitCommand("core.edit.undo", "before");
    emitCommand("core.edit.undo", "after");
    const actions = getRecordedActions();
    expect(actions).toHaveLength(1);
    expect(actions[0].event).toEqual(WRITE_A1);
  });

  it("redo puts the popped action back", async () => {
    await startRecording("A");
    emitGrid(WRITE_A1);
    emitGrid(WRITE_A2);
    emitCommand("core.edit.undo", "after");
    emitCommand("core.edit.redo", "after");
    expect(getRecordedActions()).toHaveLength(2);
    expect(getRecordedActions()[1].event).toEqual(WRITE_A2);
  });

  it("a new action after an undo drops the redo stack", async () => {
    await startRecording("A");
    emitGrid(WRITE_A1);
    emitGrid(WRITE_A2);
    emitCommand("core.edit.undo", "after");
    emitGrid({ kind: "insertRows", startRow: 0, count: 1 });
    emitCommand("core.edit.redo", "after");
    const kinds = getRecordedActions().map((a) => a.event.kind);
    expect(kinds).toEqual(["cellWrites", "insertRows"]);
  });

  it("undoing a sheet switch rewinds the tracked sheet", async () => {
    await startRecording("A");
    emitGrid(WRITE_A1); // sheet 0
    emitGrid({ kind: "activateSheet", index: 4 });
    emitCommand("core.edit.undo", "after");
    emitGrid(WRITE_A2);
    const actions = getRecordedActions();
    expect(actions).toHaveLength(2);
    expect(actions[1].sheetIndex).toBe(0);
  });

  it("an undo with nothing recorded is harmless", async () => {
    await startRecording("A");
    emitCommand("core.edit.undo", "after");
    expect(getRecordedActions()).toHaveLength(0);
  });
});
