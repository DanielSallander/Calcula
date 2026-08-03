//! FILENAME: app/extensions/MacroRecorder/__tests__/macroLibrary.test.ts
// PURPOSE: A recorded macro lands in the workbook's module store as a NORMAL
//          user script, is retrievable, and shows up in the listing the library
//          window renders.
// CONTEXT: The bug being tested against is "the recording is gone if I press
//          Close". The fix is only real if the macro can be read back afterwards
//          and is visible in a listing — code that exists with nothing reaching
//          it is the failure this whole change is about.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// A fake module store standing in for the Rust script map.
// ---------------------------------------------------------------------------

interface StoredScript {
  id: string;
  name: string;
  description: string | null;
  source: string;
  scope?: { type: string; name?: string };
}

const store = new Map<string, StoredScript>();
const RESERVED_PREFIX = "__calcula_";

vi.mock("@api", () => ({
  listWorkbookScripts: async () =>
    // Mirrors Rust list_scripts: reserved internal records are HIDDEN.
    [...store.values()]
      .filter((s) => !s.id.startsWith(RESERVED_PREFIX))
      .map((s) => ({ id: s.id, name: s.name, scope: s.scope })),
  getWorkbookScript: async (id: string) => {
    const found = store.get(id);
    if (!found) throw new Error(`Script '${id}' not found`);
    return found;
  },
  saveWorkbookScript: async (script: StoredScript) => {
    store.set(script.id, { ...script });
  },
  deleteWorkbookScript: async (id: string) => {
    // Mirrors Rust delete_script: reserved records are refused.
    if (id.startsWith(RESERVED_PREFIX)) {
      throw new Error(`Script '${id}' is an internal record and cannot be deleted`);
    }
    if (!store.delete(id)) throw new Error(`Script '${id}' not found`);
  },
  runWorkbookScript: async () => ({
    type: "success",
    output: [],
    cellsModified: 0,
    durationMs: 1,
    screenUpdating: true,
  }),
}));

import {
  autoSaveRecordedMacro,
  buildMacroDescription,
  deleteMacroModule,
  isModuleRuntimeRunnable,
  describeRunRoute,
  macroRunRoute,
  listMacroModules,
  loadMacroModule,
  macroScriptId,
  parseMacroRuntime,
  reserveMacroModule,
  saveMacroModule,
  uniqueMacroName,
  updateMacroModule,
} from "../lib/macroLibrary";

beforeEach(() => {
  store.clear();
});

// ---------------------------------------------------------------------------

describe("naming", () => {
  it("keeps the requested name when it is free", () => {
    expect(uniqueMacroName("Macro1245", [])).toBe("Macro1245");
  });

  it("deduplicates against existing module names, case-insensitively", () => {
    expect(uniqueMacroName("Macro1245", ["Macro1245"])).toBe("Macro1245 (2)");
    expect(uniqueMacroName("Macro1245", ["macro1245", "Macro1245 (2)"])).toBe(
      "Macro1245 (3)",
    );
  });

  it("falls back to a real name for an empty request", () => {
    expect(uniqueMacroName("   ", [])).toBe("Recorded macro");
  });

  it("derives a readable, NON-RESERVED id", () => {
    const id = macroScriptId("Macro 12:45", []);
    expect(id).toBe("macro-macro-12-45");
    // The reserved namespace is what Rust hides from listings and refuses to
    // delete — a macro must never land there.
    expect(id.startsWith("__calcula_")).toBe(false);
  });

  it("deduplicates ids", () => {
    expect(macroScriptId("Macro1", ["macro-macro1"])).toBe("macro-macro1-2");
  });

  it("never produces an empty id", () => {
    expect(macroScriptId("!!!", [])).toBe("macro-recorded");
  });
});

describe("the runtime marker", () => {
  it("round-trips through the description", () => {
    const description = buildMacroDescription({
      runtime: "objectScript",
      actionCount: 12,
      recordedAt: "2026-07-31T10:00:00.000Z",
    });
    expect(parseMacroRuntime(description)).toBe("objectScript");
    expect(description).toContain("12 actions");
  });

  it("singularises one action", () => {
    expect(
      buildMacroDescription({
        runtime: "notebook",
        actionCount: 1,
        recordedAt: "x",
      }),
    ).toContain("1 action ");
  });

  it("treats an unmarked module as QuickJS (what run_script runs)", () => {
    expect(parseMacroRuntime(null)).toBeNull();
    expect(parseMacroRuntime("hand-written helper")).toBeNull();
    expect(isModuleRuntimeRunnable(null)).toBe(true);
    expect(isModuleRuntimeRunnable("hand-written helper")).toBe(true);
    expect(macroRunRoute(null)).toBe("moduleRuntime");
  });

  it("marks an object-script macro as NOT module-runtime runnable, with a reason", () => {
    const description = buildMacroDescription({
      runtime: "objectScript",
      actionCount: 2,
      recordedAt: "x",
    });
    expect(isModuleRuntimeRunnable(description)).toBe(false);
    expect(macroRunRoute(description)).toBe("objectScript");
    // The reason is not optional decoration: a control the user cannot use as
    // they expect must say WHY on screen, and it must name the actual cause.
    const note = describeRunRoute(description);
    expect(note).toMatch(/object-script runtime/i);
    expect(note).toMatch(/`api\.\*`/);
    expect(note).toMatch(/temporary unlocked object script/i);
  });

  it("marks notebook macros runnable by the module runtime", () => {
    const description = buildMacroDescription({
      runtime: "notebook",
      actionCount: 2,
      recordedAt: "x",
    });
    expect(isModuleRuntimeRunnable(description)).toBe(true);
    expect(macroRunRoute(description)).toBe("moduleRuntime");
    expect(describeRunRoute(description)).toMatch(/workbook script runtime/i);
  });
});

describe("saving a recording", () => {
  it("stores the macro and hands back where it went", async () => {
    const saved = await saveMacroModule({
      id: "macro-macro1245",
      name: "Macro1245",
      source: "// body\n",
      runtime: "objectScript",
      actionCount: 3,
      recordedAt: "2026-07-31T10:00:00.000Z",
    });

    expect(saved).toEqual({
      id: "macro-macro1245",
      name: "Macro1245",
      runtime: "objectScript",
    });

    // RETRIEVABLE — the whole point.
    const readBack = await loadMacroModule("macro-macro1245");
    expect(readBack.source).toBe("// body\n");
    expect(readBack.name).toBe("Macro1245");
  });

  it("refuses to write into the reserved namespace", async () => {
    await expect(
      saveMacroModule({
        id: "__calcula_macro",
        name: "X",
        source: "",
        runtime: "notebook",
        actionCount: 0,
        recordedAt: "x",
      }),
    ).rejects.toThrow(/reserved internal script id/i);
    expect(store.size).toBe(0);
  });

  it("auto-save generates the source with the FINAL (deduplicated) name", async () => {
    store.set("macro-macro1245", {
      id: "macro-macro1245",
      name: "Macro1245",
      description: null,
      source: "existing",
    });

    const saved = await autoSaveRecordedMacro({
      desiredName: "Macro1245",
      runtime: "objectScript",
      actionCount: 1,
      recordedAt: "2026-07-31T10:00:00.000Z",
      generateSource: (finalName) => `// macro: ${finalName}\n`,
    });

    expect(saved.name).toBe("Macro1245 (2)");
    expect(saved.id).not.toBe("macro-macro1245");
    const readBack = await loadMacroModule(saved.id);
    // The stored SOURCE names the module it is stored as — no quiet mismatch.
    expect(readBack.source).toBe("// macro: Macro1245 (2)\n");
    // The pre-existing module is untouched.
    expect((await loadMacroModule("macro-macro1245")).source).toBe("existing");
  });

  it("reserve claims a free name and id together", async () => {
    store.set("macro-a", { id: "macro-a", name: "A", description: null, source: "" });
    const reserved = await reserveMacroModule("A");
    expect(reserved.name).toBe("A (2)");
    expect(reserved.id).toBe("macro-a-2");
  });
});

describe("the listing the library window renders", () => {
  it("shows a saved macro with its runtime resolved", async () => {
    await autoSaveRecordedMacro({
      desiredName: "Macro1245",
      runtime: "objectScript",
      actionCount: 4,
      recordedAt: "2026-07-31T10:00:00.000Z",
      generateSource: () => "// body\n",
    });

    const entries = await listMacroModules();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("Macro1245");
    expect(entries[0].runtime).toBe("objectScript");
    expect(entries[0].loadError).toBeNull();
    // Asserted through the functions the DIALOG calls, on the description the
    // dialog passes them — not through precomputed copies no screen reads.
    expect(isModuleRuntimeRunnable(entries[0].description)).toBe(false);
    expect(macroRunRoute(entries[0].description)).toBe("objectScript");
    expect(describeRunRoute(entries[0].description)).not.toBe("");
  });

  it("lists hand-authored modules too, as runnable", async () => {
    store.set("helper", {
      id: "helper",
      name: "Helper",
      description: null,
      source: "Calcula.setCellValue(0,0,'x')",
    });
    const entries = await listMacroModules();
    expect(entries.map((e) => e.name)).toEqual(["Helper"]);
    expect(entries[0].runtime).toBeNull();
    expect(isModuleRuntimeRunnable(entries[0].description)).toBe(true);
    expect(macroRunRoute(entries[0].description)).toBe("moduleRuntime");
  });

  it("never lists reserved internal records", async () => {
    store.set("__calcula_custom_functions__", {
      id: "__calcula_custom_functions__",
      name: "custom functions",
      description: null,
      source: "{}",
    });
    await saveMacroModule({
      id: "macro-m",
      name: "M",
      source: "",
      runtime: "notebook",
      actionCount: 0,
      recordedAt: "x",
    });
    const entries = await listMacroModules();
    expect(entries.map((e) => e.id)).toEqual(["macro-m"]);
  });
});

describe("editing and deleting a saved macro", () => {
  beforeEach(async () => {
    await saveMacroModule({
      id: "macro-m",
      name: "M",
      source: "one",
      runtime: "notebook",
      actionCount: 1,
      recordedAt: "x",
    });
  });

  it("rename and edit are the same keyed write", async () => {
    await updateMacroModule({
      id: "macro-m",
      name: "Renamed",
      source: "two",
      description: store.get("macro-m")!.description,
    });
    const readBack = await loadMacroModule("macro-m");
    expect(readBack.name).toBe("Renamed");
    expect(readBack.source).toBe("two");
    // The runtime marker survives the edit, so the library still knows what it is.
    expect(parseMacroRuntime(readBack.description)).toBe("notebook");
    expect(store.size).toBe(1);
  });

  it("deletes the user's own macro", async () => {
    await deleteMacroModule("macro-m");
    expect(store.size).toBe(0);
    expect(await listMacroModules()).toEqual([]);
  });

  it("cannot delete a reserved internal record", async () => {
    store.set("__calcula_custom_functions__", {
      id: "__calcula_custom_functions__",
      name: "cf",
      description: null,
      source: "{}",
    });
    await expect(deleteMacroModule("__calcula_custom_functions__")).rejects.toThrow(
      /internal record/i,
    );
    expect(store.has("__calcula_custom_functions__")).toBe(true);
  });
});
