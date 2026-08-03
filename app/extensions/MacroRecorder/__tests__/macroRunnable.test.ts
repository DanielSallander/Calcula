//! FILENAME: app/extensions/MacroRecorder/__tests__/macroRunnable.test.ts
// PURPOSE: End to end at unit level — record, auto-save, press Run, and the
//          recorded cell changes actually happen.
// CONTEXT: The bug this closes: the module the recorder saved DEFINED a macro
//          function and never called it, so executing that module defined a
//          function and stopped. Worse, it was stored in the workbook module
//          store, whose runtime is the Rust QuickJS interpreter (`Calcula.*`),
//          where `api` does not exist at all — so even appending a call would
//          have thrown. Run could not work by construction, and the previous
//          round "fixed" it by disabling the button.
//
//          Two properties are pinned here, one per flavour:
//            objectScript -> the stored source ENDS IN AN INVOCATION, and Run
//                            routes it to a one-shot object-script mount (the
//                            runtime it is written for).
//            notebook     -> the stored source is `Calcula.*` statements the
//                            module runtime executes directly, and Run routes
//                            it to run_script.
//          In both cases the source is EXECUTED here against a fake runtime and
//          the resulting writes are compared with what was recorded.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RecordedAction } from "../lib/types";

// --- A fake module store + the two run seams ---------------------------------

interface StoredScript {
  id: string;
  name: string;
  description: string | null;
  source: string;
}
const store = new Map<string, StoredScript>();
const runObjectScriptOnce = vi.fn(async (_o: unknown) => undefined);
const runWorkbookScript = vi.fn(async (_source: string, _file: string) => ({
  type: "success" as const,
  output: [],
  cellsModified: 3,
  durationMs: 1,
  screenUpdating: true,
}));

vi.mock("@api", () => ({
  listWorkbookScripts: async () =>
    [...store.values()].map((s) => ({ id: s.id, name: s.name })),
  getWorkbookScript: async (id: string) => {
    const found = store.get(id);
    if (!found) throw new Error(`Script '${id}' not found`);
    return found;
  },
  saveWorkbookScript: async (s: StoredScript) => {
    store.set(s.id, { ...s });
  },
  deleteWorkbookScript: async (id: string) => {
    store.delete(id);
  },
  runWorkbookScript: (source: string, file: string) => runWorkbookScript(source, file),
  runObjectScriptOnce: (o: unknown) => runObjectScriptOnce(o),
}));

vi.mock("@api/ui", () => ({ showDialog: () => undefined }));
vi.mock("@api/lib", () => ({ getActiveSheet: async () => 0 }));
vi.mock("@api/locale", () => ({
  getCachedLocale: () => ({ decimalSeparator: "." }),
}));
vi.mock("../lib/actionRecorder", () => ({
  getRecorderSnapshot: () => ({ status: "idle", actionCount: 0, name: "", startedAt: 0 }),
  stopRecording: () => [],
  cancelRecording: () => undefined,
}));

import { generateStoredSource, moduleRuntimeSupport } from "../lib/flow";
import {
  autoSaveRecordedMacro,
  describeRunRoute,
  isModuleRuntimeRunnable,
  listMacroModules,
  loadMacroModule,
  macroRunRoute,
  runMacroModule,
} from "../lib/macroLibrary";

// --- The recording: three cell edits, exactly the user's case -----------------

const RECORDED_WRITES: Array<[number, number, string]> = [
  [0, 0, "10"],
  [1, 0, "20"],
  [2, 0, "=SUM(A1:A2)"],
];

const ACTIONS: RecordedAction[] = [
  {
    seq: 1,
    sheetIndex: 0,
    event: {
      kind: "cellWrites",
      writes: RECORDED_WRITES.map(([row, col, value]) => ({ row, col, value })),
    },
  },
];

/** Record + auto-save, exactly as `finishRecording` does. */
async function recordAndSave(target: "objectScript" | "notebook") {
  return autoSaveRecordedMacro({
    desiredName: "Macro1426",
    runtime: target,
    actionCount: ACTIONS.length,
    recordedAt: "2026-08-03T10:00:00.000Z",
    generateSource: (finalName) =>
      generateStoredSource({
        actions: ACTIONS,
        target,
        name: finalName,
        recordedAt: "2026-08-03T10:00:00.000Z",
      }),
  });
}

beforeEach(() => {
  store.clear();
  runObjectScriptOnce.mockClear();
  runWorkbookScript.mockClear();
});

// -----------------------------------------------------------------------------

describe("an object-script recording is a runnable module", () => {
  it("the stored source ends in an INVOCATION, never a comment", async () => {
    const saved = await recordAndSave("objectScript");
    const source = (await loadMacroModule(saved.id)).source;

    expect(source).toContain("async function macro1426(api)");
    expect(source).toContain("function setup(context) {");
    expect(source).toContain("return macro1426(context.api);");
    // The exact shape that shipped and could not run:
    expect(source).not.toContain("// Run it from any unlocked object script:");
    expect(source.trimEnd().endsWith("}")).toBe(true);
  });

  it("executing the stored source performs the recorded cell changes", async () => {
    const saved = await recordAndSave("objectScript");
    const source = (await loadMacroModule(saved.id)).source;

    const writes: Array<[number, number, string]> = [];
    const batches: string[] = [];
    const api = {
      beginBatch: async (label: string) => {
        batches.push(`begin:${label}`);
      },
      commitBatch: async () => {
        batches.push("commit");
      },
      cancelBatch: async () => {
        batches.push("cancel");
      },
      setActiveSheet: async () => undefined,
      setCellValue: async (row: number, col: number, value: string) => {
        writes.push([row, col, value]);
      },
      updateCellsBatch: async (
        updates: Array<{ row: number; col: number; value: string }>,
      ) => {
        for (const u of updates) writes.push([u.row, u.col, u.value]);
      },
    };

    // eslint-disable-next-line no-new-func
    const setup = new Function(`${source}\nreturn setup;`)() as (
      ctx: unknown,
    ) => Promise<void>;
    await setup({ api, notify: () => undefined });

    expect(writes).toEqual(RECORDED_WRITES);
    // One undo step, committed — not left open.
    expect(batches).toEqual(["begin:Macro1426", "commit"]);
  });

  it("the library marks it not-runnable by the MODULE runtime, with a reason", async () => {
    await recordAndSave("objectScript");
    const [entry] = await listMacroModules();

    expect(entry.runtime).toBe("objectScript");
    expect(isModuleRuntimeRunnable(entry.description)).toBe(false);
    expect(macroRunRoute(entry.description)).toBe("objectScript");
    // The reason is a real sentence naming the actual cause, not a shrug.
    const note = describeRunRoute(entry.description);
    expect(note).toMatch(/`api\.\*`/);
    expect(note).toMatch(/`Calcula\.\*`/);
    expect(note).toMatch(/temporary unlocked object script/i);
  });

  it("Run mounts it as an unlocked object script instead of refusing", async () => {
    const saved = await recordAndSave("objectScript");
    const script = await loadMacroModule(saved.id);

    const result = await runMacroModule({
      id: script.id,
      name: script.name,
      source: script.source,
      description: script.description ?? null,
    });

    expect(runWorkbookScript).not.toHaveBeenCalled();
    expect(runObjectScriptOnce).toHaveBeenCalledTimes(1);
    expect(runObjectScriptOnce.mock.calls[0][0]).toMatchObject({
      source: script.source,
      objectType: "workbook",
      accessLevel: "unlocked",
      name: "Macro1426",
    });
    expect(result.type).toBe("success");
  });

  it("a failed run is reported as an error, not as a success with 0 cells", async () => {
    runObjectScriptOnce.mockRejectedValueOnce(new Error("setup() threw"));
    const saved = await recordAndSave("objectScript");
    const script = await loadMacroModule(saved.id);

    const result = await runMacroModule({
      id: script.id,
      name: script.name,
      source: script.source,
      description: script.description ?? null,
    });

    expect(result.type).toBe("error");
    if (result.type === "error") expect(result.message).toContain("setup() threw");
  });
});

describe("which recordings the module runtime can express", () => {
  it("says YES for a recording of nothing but cell writes", () => {
    const support = moduleRuntimeSupport(ACTIONS);
    expect(support.supported).toBe(true);
    expect(support.reasons).toEqual([]);
  });

  it("says NO — and NAMES the actions — when the recording exceeds it", () => {
    const support = moduleRuntimeSupport([
      ...ACTIONS,
      {
        seq: 2,
        sheetIndex: 0,
        event: { kind: "formatting", rows: [0], cols: [0], formatting: { bold: true } },
      },
      { seq: 3, sheetIndex: 0, event: { kind: "insertRows", startRow: 1, count: 1 } },
    ]);

    expect(support.supported).toBe(false);
    expect(support.reasons).toHaveLength(2);
    // Not "unsupported": the specific action, and why.
    expect(support.reasons[0]).toMatch(/format A1/);
    expect(support.reasons[0]).toMatch(/no formatting API/);
    expect(support.reasons[1]).toMatch(/insert 1 row/);
  });

  it("is computed from the ACTIONS, so it cannot drift from the stored source", async () => {
    // Same action list, both flavours, one answer about the module runtime.
    const support = moduleRuntimeSupport(ACTIONS);
    const notebook = await recordAndSave("notebook");
    const notebookSource = (await loadMacroModule(notebook.id)).source;
    // Everything expressible => nothing was dropped into a NOT REPLAYABLE note.
    expect(support.supported).toBe(true);
    expect(notebookSource).not.toContain("NOT REPLAYABLE");
  });
});

describe("a notebook recording is runnable by the module runtime itself", () => {
  it("stores `Calcula.*` statements the module runtime executes directly", async () => {
    const saved = await recordAndSave("notebook");
    const source = (await loadMacroModule(saved.id)).source;

    expect(source).toContain("Calcula.setCellValue");
    expect(source).not.toContain("async function");
    expect(source).not.toContain("api.");
  });

  it("executing the stored source performs the recorded cell changes", async () => {
    const saved = await recordAndSave("notebook");
    const source = (await loadMacroModule(saved.id)).source;

    const writes: Array<[number, number, string]> = [];
    const Calcula = {
      setActiveSheet: () => undefined,
      setCellValue: (row: number, col: number, value: string) => {
        writes.push([row, col, value]);
      },
    };
    // eslint-disable-next-line no-new-func
    new Function("Calcula", source)(Calcula);

    expect(writes).toEqual(RECORDED_WRITES);
  });

  it("Run goes straight to the workbook script runtime", async () => {
    const saved = await recordAndSave("notebook");
    const script = await loadMacroModule(saved.id);
    const [entry] = await listMacroModules();

    expect(isModuleRuntimeRunnable(entry.description)).toBe(true);
    expect(macroRunRoute(entry.description)).toBe("moduleRuntime");

    const result = await runMacroModule({
      id: script.id,
      name: script.name,
      source: script.source,
      description: script.description ?? null,
    });

    expect(runObjectScriptOnce).not.toHaveBeenCalled();
    expect(runWorkbookScript).toHaveBeenCalledWith(script.source, `${script.id}.js`);
    expect(result.type).toBe("success");
  });
});
