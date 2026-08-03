//! FILENAME: app/extensions/MacroRecorder/__tests__/flowAutoSave.test.ts
// PURPOSE: Stopping a recording SAVES it before the review dialog opens, and
//          says so honestly when the save fails.
// CONTEXT: The reported bug: "if I choose Close the recorded macro is gone."
//          Ordering is the fix — the module write has to have happened by the
//          time the user can reach a Close button, so the dialog is never the
//          thing standing between the user and their work.

import { describe, it, expect, beforeEach, vi } from "vitest";

const events: string[] = [];
const saved: Array<{ id: string; name: string; source: string; description: string | null }> = [];
const state = { failSave: false, existingNames: [] as string[] };

vi.mock("@api/ui", () => ({
  showDialog: (id: string) => {
    events.push(`showDialog:${id}`);
  },
}));

vi.mock("@api/locale", () => ({
  getCachedLocale: () => ({ decimalSeparator: "." }),
}));

vi.mock("@api", () => ({
  listWorkbookScripts: async () =>
    state.existingNames.map((name, i) => ({ id: `existing-${i}`, name })),
  getWorkbookScript: async (id: string) => {
    const found = saved.find((s) => s.id === id);
    if (!found) throw new Error("not found");
    return found;
  },
  saveWorkbookScript: async (script: {
    id: string;
    name: string;
    source: string;
    description: string | null;
  }) => {
    if (state.failSave) throw new Error("backend is unavailable");
    events.push(`save:${script.name}`);
    saved.push(script);
  },
  deleteWorkbookScript: async () => undefined,
  runWorkbookScript: async () => ({
    type: "success",
    output: [],
    cellsModified: 0,
    durationMs: 0,
    screenUpdating: true,
  }),
}));

// The recorder session itself is stubbed: this test is about the ORDER of the
// stop -> save -> show sequence, not about capture.
const session = { status: "recording" as string, name: "Macro1245" };
vi.mock("../lib/actionRecorder", () => ({
  getRecorderSnapshot: () => ({
    status: session.status,
    actionCount: 1,
    name: session.name,
    startedAt: 0,
  }),
  stopRecording: () => {
    events.push("stopRecording");
    session.status = "idle";
    return [
      {
        seq: 1,
        sheetIndex: 0,
        event: { kind: "updateCell", row: 0, col: 0, value: "42" },
      },
    ];
  },
  cancelRecording: () => {
    session.status = "idle";
  },
}));

import {
  finishRecording,
  getFinishedRecording,
  resetFlow,
  setPendingTarget,
} from "../lib/flow";

beforeEach(() => {
  events.length = 0;
  saved.length = 0;
  state.failSave = false;
  state.existingNames = [];
  session.status = "recording";
  session.name = "Macro1245";
  resetFlow();
});

describe("finishRecording", () => {
  it("stops, then SAVES, then opens the dialog — in that order", async () => {
    setPendingTarget("objectScript");
    await finishRecording();

    expect(events).toEqual([
      "stopRecording",
      "save:Macro1245",
      "showDialog:macro-recorder:result",
    ]);
  });

  it("tells the dialog where the recording was saved", async () => {
    setPendingTarget("objectScript");
    await finishRecording();

    const finished = getFinishedRecording();
    expect(finished?.saved).toEqual({
      id: "macro-macro1245",
      name: "Macro1245",
      runtime: "objectScript",
    });
    expect(finished?.saveError).toBeNull();
  });

  it("stores source in the flavour the user chose", async () => {
    setPendingTarget("notebook");
    await finishRecording();
    // Notebook cells are synchronous Calcula.* statements, never an async
    // object-script function.
    expect(saved[0].source).toContain("Calcula.");
    expect(saved[0].source).not.toContain("async function");

    resetFlow();
    saved.length = 0;
    events.length = 0;
    session.status = "recording";
    setPendingTarget("objectScript");
    await finishRecording();
    expect(saved[0].source).toContain("async function macro1245(api)");
  });

  it("the stored source names the module it was stored as", async () => {
    state.existingNames = ["Macro1245"];
    setPendingTarget("objectScript");
    await finishRecording();

    expect(saved[0].name).toBe("Macro1245 (2)");
    expect(saved[0].source).toContain("Macro1245 (2)");
    expect(getFinishedRecording()?.name).toBe("Macro1245 (2)");
  });

  it("marks the module with the runtime so the library can classify it", async () => {
    setPendingTarget("notebook");
    await finishRecording();
    expect(saved[0].description).toContain("runtime=notebook");
  });

  it("SURFACES a failed auto-save instead of losing the recording silently", async () => {
    state.failSave = true;
    setPendingTarget("objectScript");
    await finishRecording();

    const finished = getFinishedRecording();
    expect(finished).not.toBeNull();
    expect(finished?.saved).toBeNull();
    expect(finished?.saveError).toContain("backend is unavailable");
    // The recording is still handed to the dialog, so the user can copy it out.
    expect(finished?.actions).toHaveLength(1);
    expect(events).toContain("showDialog:macro-recorder:result");
  });

  it("does nothing when no session is running", async () => {
    session.status = "idle";
    await finishRecording();
    expect(events).toEqual([]);
    expect(getFinishedRecording()).toBeNull();
  });

  it("pins the timestamp so the dialog regenerates the stored source exactly", async () => {
    setPendingTarget("objectScript");
    await finishRecording();
    const finished = getFinishedRecording()!;
    expect(saved[0].source).toContain(finished.recordedAt);
  });
});
