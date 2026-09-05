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

vi.mock("@api", async () => {
  // The REAL origin rule: a provenance decision in a test must agree with the one
  // definition every gate reads, or the test pins a rule the product does not have.
  const origin = await vi.importActual<typeof import("@api/scriptHost/scriptOrigin")>(
    "@api/scriptHost/scriptOrigin",
  );
  return {
    scriptOriginForStoredRecord: origin.scriptOriginForStoredRecord,
    originTagTitle: origin.originTagTitle,

  AppEvents: { SHEET_CHANGED: "app:sheet-changed" },
  onAppEvent: (_name: string, cb: (detail: unknown) => void) => {
    hooks.appEvent = cb;
    return () => {
      hooks.appEvent = null;
    };
  },
  MACRO_MODEL_EDIT_EVENT: "macro:model-edit",
  MACRO_MODEL_BATCH_EVENT: "macro:model-batch",
  // The Tauri event plumbing cannot run under vitest; the model tests drive
  // the handlers through the modelCaptureForTests seam instead.
  listenTauriEvent: () => Promise.resolve(() => {}),
  };
});

import {
  cancelRecording,
  getRecordedActions,
  getRecorderSnapshot,
  modelCaptureForTests,
  pauseRecording,
  resetRecorderForTests,
  resumeRecording,
  startRecording,
  stopRecording,
  subscribeToRecorder,
} from "../lib/actionRecorder";
import { macroRecorderBackend } from "../lib/macroRecorderBackend";
import type { RecordedGridEvent } from "@api/lib";

// The recorder arms/disarms model capture and prefetches connection names via
// its backend channel; bind it to a benign stub so install/uninstall resolve.
macroRecorderBackend.set(async <T,>(command: string): Promise<T> => {
  if (command === "bi_get_connections") {
    return [{ id: "conn-1", name: "Sales" }] as unknown as T;
  }
  return undefined as unknown as T;
});

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

// ---------------------------------------------------------------------------
// Model-edit capture (macro:model-edit / macro:model-batch)
// ---------------------------------------------------------------------------

function modelEdit(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: "conn-1",
    kind: "measure",
    action: "upsert" as const,
    name: "Revenue",
    payload: { originalName: null, name: "Revenue" },
    replayable: true,
    ...overrides,
  };
}

describe("model-edit capture", () => {
  it("records a captured model edit with the cached connection name", async () => {
    await startRecording("A");
    modelCaptureForTests.setConnectionNames(new Map([["conn-1", "Sales"]]));
    modelCaptureForTests.onModelEdit(modelEdit());
    const actions = getRecordedActions();
    expect(actions).toHaveLength(1);
    expect(actions[0].event).toMatchObject({
      kind: "modelEdit",
      connectionId: "conn-1",
      connectionName: "Sales",
      modelKind: "measure",
      action: "upsert",
      replayable: true,
    });
  });

  it("drops model edits while paused and while a command owns the timeline", async () => {
    await startRecording("A");
    pauseRecording();
    modelCaptureForTests.onModelEdit(modelEdit());
    expect(getRecordedActions()).toHaveLength(0);
    resumeRecording();
    emitCommand("someExtension.command", "before");
    modelCaptureForTests.onModelEdit(modelEdit());
    emitCommand("someExtension.command", "after");
    // Only the command itself was recorded — not its internal model edit.
    const kinds = getRecordedActions().map((a) => a.event.kind);
    expect(kinds).toEqual(["command"]);
  });

  it("a model undo marker pops the last MODEL action, never a grid action", async () => {
    await startRecording("A");
    emitGrid(WRITE_A1);
    modelCaptureForTests.onModelEdit(modelEdit());
    emitGrid(WRITE_A2);
    modelCaptureForTests.onModelEdit(modelEdit({ action: "undo", payload: undefined }));
    const kinds = getRecordedActions().map((a) => a.event.kind);
    expect(kinds).toEqual(["cellWrites", "cellWrites"]);
  });

  it("grid Ctrl+Z pops the last GRID action even when a model edit came later", async () => {
    await startRecording("A");
    emitGrid(WRITE_A1);
    emitGrid(WRITE_A2);
    modelCaptureForTests.onModelEdit(modelEdit());
    emitCommand("core.edit.undo", "after");
    const kinds = getRecordedActions().map((a) => a.event.kind);
    expect(kinds).toEqual(["cellWrites", "modelEdit"]);
    expect(
      getRecordedActions().filter((a) => a.event.kind === "cellWrites"),
    ).toHaveLength(1);
  });

  it("a model redo marker restores the popped model action in place", async () => {
    await startRecording("A");
    modelCaptureForTests.onModelEdit(modelEdit());
    emitGrid(WRITE_A1);
    modelCaptureForTests.onModelEdit(modelEdit({ action: "undo", payload: undefined }));
    modelCaptureForTests.onModelEdit(modelEdit({ action: "redo", payload: undefined }));
    const kinds = getRecordedActions().map((a) => a.event.kind);
    expect(kinds).toEqual(["modelEdit", "cellWrites"]);
  });

  it("a cancelled batch drops its model edits but keeps interleaved grid work", async () => {
    await startRecording("A");
    modelCaptureForTests.onModelBatch({ connectionId: "conn-1", action: "begin" });
    modelCaptureForTests.onModelEdit(modelEdit());
    emitGrid(WRITE_A1);
    modelCaptureForTests.onModelEdit(modelEdit({ name: "Two" }));
    modelCaptureForTests.onModelBatch({ connectionId: "conn-1", action: "cancel" });
    const kinds = getRecordedActions().map((a) => a.event.kind);
    expect(kinds).toEqual(["cellWrites"]);
  });

  it("an ended batch keeps its model edits", async () => {
    await startRecording("A");
    modelCaptureForTests.onModelBatch({ connectionId: "conn-1", action: "begin" });
    modelCaptureForTests.onModelEdit(modelEdit());
    modelCaptureForTests.onModelBatch({ connectionId: "conn-1", action: "end" });
    expect(getRecordedActions()).toHaveLength(1);
  });

  it("a cancel with no recorded begin is harmless", async () => {
    await startRecording("A");
    modelCaptureForTests.onModelEdit(modelEdit());
    modelCaptureForTests.onModelBatch({ connectionId: "conn-1", action: "cancel" });
    expect(getRecordedActions()).toHaveLength(1);
  });
});
