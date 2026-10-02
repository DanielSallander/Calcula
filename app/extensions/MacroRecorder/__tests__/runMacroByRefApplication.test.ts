//! FILENAME: app/extensions/MacroRecorder/__tests__/runMacroByRefApplication.test.ts
// PURPOSE: Phase 3 of BUG-0257, the seam half. A button that came with an
//          application runs its held macro link through
//          `runMacroByRef(id, { requirePackage, trigger })`, and:
//            * `requirePackage` refuses -- BEFORE anything runs -- a record that
//              is the user's own or another application's, even with the same
//              id (the confused deputy the pull strip used to guard against by
//              removing every link); an EMPTY requirement refuses too;
//            * a matching record runs, and the button (`trigger`) is forwarded on
//              BOTH run routes to the Rust gate that verifies it: `run_script`'s
//              `request.trigger` (module runtime) and the one-off mount's
//              `check_distributed_mount_consent` (object-script route, via
//              `runObjectScriptOnce`'s `trigger`).
//          Nothing runs is asserted at the seam's two run doors, which are what
//          reach `run_script` / the mount.

import { describe, it, expect, beforeEach, vi } from "vitest";

interface StoredScript {
  id: string;
  name: string;
  description: string | null;
  source: string;
  sourcePackage: string | null;
}

const h = vi.hoisted(() => ({
  store: new Map<string, StoredScript>(),
  moduleRuns: [] as unknown[][],
  objectRuns: [] as unknown[],
}));

vi.mock("@api", async () => {
  // The REAL origin rule, as every gate reads it.
  const origin = await vi.importActual<typeof import("@api/scriptHost/scriptOrigin")>(
    "@api/scriptHost/scriptOrigin",
  );
  return {
    scriptOriginForStoredRecord: origin.scriptOriginForStoredRecord,
    originTagTitle: origin.originTagTitle,
    listWorkbookScripts: async () => [...h.store.values()].map((s) => ({ id: s.id, name: s.name })),
    getWorkbookScript: async (id: string) => {
      const found = h.store.get(id);
      if (!found) throw new Error(`Script '${id}' not found`);
      return found;
    },
    listWorkbookScriptRecords: async () => [],
    parseModuleScriptRuntime: (description: string | null | undefined) => {
      if (typeof description !== "string") return null;
      const match = /\bruntime=(objectScript|notebook)\b/.exec(description);
      return match ? match[1] : null;
    },
    saveWorkbookScript: async () => undefined,
    deleteWorkbookScript: async () => undefined,
    // The module-runtime door: what reaches `run_script`. Every argument kept.
    runWorkbookScript: async (...args: unknown[]) => {
      h.moduleRuns.push(args);
      return { type: "success", output: [], cellsModified: 1, durationMs: 1, screenUpdating: true };
    },
    // The object-script door: what reaches the mount gate.
    runObjectScriptOnce: async (options: unknown) => {
      h.objectRuns.push(options);
    },
  };
});

import { runMacroByRef } from "../lib/macroLibrary";
import { claimExplicitMacroRun, mintExplicitMacroRun } from "@api/explicitMacroRun";

const NOTEBOOK = "Recorded macro · runtime=notebook · 1 action";
const OBJECT_SCRIPT = "Recorded macro · runtime=objectScript · 1 action";

/** The application's own macro, stamped by the pull. */
const APP_MACRO: StoredScript = {
  id: "macro-report",
  name: "Report",
  description: NOTEBOOK,
  source: "Calcula.setCellValue(0,0,'the application');",
  sourcePackage: "Sales",
};

/** The subscriber's OWN macro with the SAME id -- what an application's button must never reach. */
const MY_MACRO: StoredScript = {
  ...APP_MACRO,
  name: "My report",
  source: "Calcula.setCellValue(0,0,'MINE');",
  sourcePackage: null,
};

const TRIGGER = { kind: "buttonControl" as const, sheetIndex: 2, row: 4, col: 1 };

beforeEach(() => {
  h.store.clear();
  h.moduleRuns.length = 0;
  h.objectRuns.length = 0;
});

describe("requirePackage: a button from an application runs only that application's macro", () => {
  // POSITIVE CONTROL: without a requirement the same record DOES run, so every
  // "nothing ran" below is a result, not a harness that cannot see a run.
  it("with no requirement, the user's own macro runs (Developer > Macros, the CLI, their own button)", async () => {
    h.store.set(MY_MACRO.id, MY_MACRO);
    const outcome = await runMacroByRef(MY_MACRO.id);
    expect(outcome).toEqual({ status: "ran", name: "My report" });
    expect(h.moduleRuns).toHaveLength(1);
  });

  // SABOTAGE: delete the `if (options.requirePackage !== undefined)` block in
  // runMacroByRef (MacroRecorder/lib/macroLibrary.ts) -> the user's macro runs.
  it("refuses the user's OWN macro with the same id, and runs nothing", async () => {
    h.store.set(MY_MACRO.id, MY_MACRO);
    const outcome = await runMacroByRef(MY_MACRO.id, { requirePackage: "Sales", trigger: TRIGGER });
    expect(h.moduleRuns, "the application's button ran the user's own macro").toEqual([]);
    expect(h.objectRuns).toEqual([]);
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") {
      expect(outcome.owner).toBeNull();
      expect(outcome.macroId).toBe("macro-report");
      expect(outcome.message).toContain('came with the application "Sales"');
      expect(outcome.message).toContain("is one of your own");
      expect(outcome.message).toContain("runs only that application's own macros");
    }
  });

  it("refuses ANOTHER application's macro, naming it", async () => {
    h.store.set(APP_MACRO.id, { ...APP_MACRO, sourcePackage: "Someone Else" });
    const outcome = await runMacroByRef(APP_MACRO.id, { requirePackage: "Sales" });
    expect(h.moduleRuns).toEqual([]);
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") {
      expect(outcome.owner).toBe("Someone Else");
      expect(outcome.message).toContain('"Someone Else"');
    }
  });

  // SABOTAGE: change `required === "" ||` to `false ||` -> an empty stamp on a
  // blank-stamped record matches and the macro runs.
  it("an EMPTY requirement refuses (fail closed), even for a record with a blank stamp", async () => {
    h.store.set(APP_MACRO.id, { ...APP_MACRO, sourcePackage: "" });
    const outcome = await runMacroByRef(APP_MACRO.id, { requirePackage: "" });
    expect(h.moduleRuns).toEqual([]);
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") {
      expect(outcome.message).toMatch(/could not say which application/);
    }
  });

  it("a missing macro is still notFound, not refused", async () => {
    const outcome = await runMacroByRef("macro-gone", { requirePackage: "Sales" });
    expect(outcome).toEqual({ status: "notFound", macroId: "macro-gone" });
  });
});

describe("a matching application runs, and the BUTTON travels to the Rust gate", () => {
  // SABOTAGE: drop `{ trigger: entry.trigger }` from the module-runtime branch
  // of runMacroModule -> the payload carries no trigger.
  it("module runtime: run_script's request gets the trigger", async () => {
    h.store.set(APP_MACRO.id, APP_MACRO);
    const outcome = await runMacroByRef(APP_MACRO.id, { requirePackage: "Sales", trigger: TRIGGER });
    expect(outcome).toEqual({ status: "ran", name: "Report" });
    expect(h.moduleRuns).toHaveLength(1);
    const [source, filename, options] = h.moduleRuns[0] as [string, string, { trigger?: unknown }];
    // The STORED source, verbatim -- what the Rust gate's hash-keyed approval covers.
    expect(source).toBe(APP_MACRO.source);
    expect(filename).toBe("macro-report.js");
    expect(options?.trigger).toEqual(TRIGGER);
  });

  // SABOTAGE: drop `trigger: entry.trigger` from the runObjectScriptOnce call in
  // runMacroModule -> the mount gate is never told which button asked.
  it("object-script route: the one-off mount is handed the trigger", async () => {
    h.store.set(APP_MACRO.id, { ...APP_MACRO, description: OBJECT_SCRIPT });
    const outcome = await runMacroByRef(APP_MACRO.id, { requirePackage: "Sales", trigger: TRIGGER });
    expect(outcome).toEqual({ status: "ran", name: "Report" });
    expect(h.objectRuns).toHaveLength(1);
    expect(h.objectRuns[0]).toMatchObject({
      scriptId: "macro-report",
      accessLevel: "restricted",
      trigger: TRIGGER,
    });
  });

  it("a run nobody clicked a button for carries no trigger", async () => {
    h.store.set(APP_MACRO.id, APP_MACRO);
    await runMacroByRef(APP_MACRO.id);
    const options = (h.moduleRuns[0] as unknown[])[2] as { trigger?: unknown } | undefined;
    expect(options?.trigger).toBeUndefined();
  });
});

// ============================================================================
// OWNER DECISION B (2026-09-30): the provider FORWARDS a person's pass and
// never makes one. This is the real provider `api.runMacro` reaches (host.ts
// executeRunMacro -> requireMacroRunProvider().runMacroByRef(resolved.id)).
// ============================================================================

describe("the explicit-run pass: forwarded, never minted", () => {
  const OBJECT_MACRO: StoredScript = { ...APP_MACRO, description: OBJECT_SCRIPT };

  it("a pass handed in reaches the object-script run as the SAME object", async () => {
    h.store.set(OBJECT_MACRO.id, OBJECT_MACRO);
    const pass = mintExplicitMacroRun("macrosDialog", OBJECT_MACRO.id);
    const outcome = await runMacroByRef(OBJECT_MACRO.id, { explicitRun: pass });
    expect(outcome.status).toBe("ran");
    expect((h.objectRuns[0] as { explicitRun?: unknown }).explicitRun).toBe(pass);
  });

  // SABOTAGE: in runMacroByRef write
  // `explicitRun: options.explicitRun ?? mintExplicitMacroRun("button", macroId)`
  // -> a script-started run (no options) carries a pass and this goes red.
  it("no pass handed in -> none forwarded: api.runMacro's call, and a button's", async () => {
    h.store.set(OBJECT_MACRO.id, OBJECT_MACRO);
    await runMacroByRef(OBJECT_MACRO.id);
    await runMacroByRef(OBJECT_MACRO.id, { requirePackage: "Sales", trigger: TRIGGER });
    expect(h.objectRuns).toHaveLength(2);
    for (const run of h.objectRuns) {
      expect((run as { explicitRun?: unknown }).explicitRun).toBeUndefined();
    }
  });

  // Owner decision B, follow-up F10: the module runtime has no tiers, so a
  // pass there is not spent unused any more -- it travels to the run
  // (`runWorkbookScript`, which claims it and tells Rust a person started the
  // run). Without it, Rust refuses an application's macro a script started.
  // SABOTAGE: send `explicitRun: undefined` in runMacroModule's module branch.
  it("a pass on the MODULE route travels to the run, with the macro it is for", async () => {
    h.store.set(APP_MACRO.id, APP_MACRO);
    const pass = mintExplicitMacroRun("macrosDialog", APP_MACRO.id);
    await runMacroByRef(APP_MACRO.id, { explicitRun: pass });
    expect(h.moduleRuns).toHaveLength(1);
    const options = h.moduleRuns[0][2] as { startedBy?: { kind: string; macroId: string; explicitRun: unknown } };
    expect(options.startedBy?.kind).toBe("macro");
    expect(options.startedBy?.macroId).toBe(APP_MACRO.id);
    expect(options.startedBy?.explicitRun, "the pass was not handed to the run").toBe(pass);
  });

  it("a script's run on the MODULE route hands the run no pass", async () => {
    h.store.set(APP_MACRO.id, APP_MACRO);
    await runMacroByRef(APP_MACRO.id);
    expect(h.moduleRuns).toHaveLength(1);
    expect(h.moduleRuns[0][2]).toMatchObject({
      startedBy: { kind: "macro", macroId: APP_MACRO.id, explicitRun: undefined },
    });
  });

  it("a pass is spent when nothing runs: not found, refused", async () => {
    const lost = mintExplicitMacroRun("macrosDialog", "macro-gone");
    await runMacroByRef("macro-gone", { explicitRun: lost });
    expect(claimExplicitMacroRun(lost)).toBeNull();

    h.store.set(MY_MACRO.id, MY_MACRO);
    const refused = mintExplicitMacroRun("button", MY_MACRO.id);
    const outcome = await runMacroByRef(MY_MACRO.id, { requirePackage: "Sales", explicitRun: refused });
    expect(outcome.status).toBe("refused");
    expect(claimExplicitMacroRun(refused)).toBeNull();
  });
});
