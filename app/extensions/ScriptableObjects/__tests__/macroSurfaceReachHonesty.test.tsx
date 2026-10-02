//! FILENAME: app/extensions/ScriptableObjects/__tests__/macroSurfaceReachHonesty.test.tsx
// PURPOSE: The consent prompt's REACH paragraph must describe the surface the
//          grant actually covers — the object-script realm when there are object
//          scripts, the macro surface when there are macros — and never one
//          surface's containment stapled to the other's grant.
// CONTEXT: Rendered with `scriptCount: 0` and macros present, ScriptConsentDialog
//          still ended with "Scripts run in restricted mode — they can read and
//          write the cells of the sheet currently shown". That sentence is the
//          OBJECT-SCRIPT realm's reach: the worker realm, clamped by the host to
//          the active sheet, bounded by a consented capability set. A macro is a
//          MODULE script — the run routes hand its source to `run_script`, the
//          `one-off-script` surface of the Rust QuickJS interpreter — and it is
//          clamped to no sheet at all and consults no capability. So the last
//          screen before a stranger's code runs described a containment that
//          application does not use, and UNDERSTATED the one it does. A consent
//          screen that understates reach is worse than none: the user's Allow
//          answers a different question from the one the code will act on (the
//          finding consentTextHonesty.test.ts records for the grid sentences,
//          and macroConsentTriggerHonesty.test.ts for the trigger list).
//
//          THE NEW SENTENCE IS PINNED AGAINST THE INTERPRETER, NOT AGAINST
//          MEMORY. `core/script-engine/src/manifest.rs` is the source of truth
//          for what the QuickJS realm registers — its own test boots a real
//          runtime and diffs the manifest against the live surface — and
//          `SURFACE_PROFILES` records how the host builds the realm for each
//          surface. This file reads that Rust file, derives `one-off-script`'s
//          reach classes and capability ceiling the way `surface_reach()` /
//          `surface_capability_ids()` do, and fails if the prompt's paragraph
//          stops naming a class the surface can touch — or keeps claiming a
//          capability bound the surface does not have. Direction is fixed
//          Rust -> TypeScript, for the reason CLAUDE.md gives: the renderer can
//          be compromised and the interpreter is where the sandbox is.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@api/scriptEditorService", () => ({
  requireScriptEditorProvider: () => ({
    openMacroInEditor: async () => undefined,
    openDraftInEditor: async () => undefined,
  }),
}));

vi.mock("@api/events", () => ({
  emitAppEvent: () => undefined,
}));

import ScriptConsentDialog, { describeObjectScriptMacroReach } from "../components/ScriptConsentDialog";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const MANIFEST = fs.readFileSync(
  path.join(REPO_ROOT, "core/script-engine/src/manifest.rs"),
  "utf8",
);

// ===========================================================================
// The interpreter's own answer, read out of manifest.rs
// ===========================================================================

/**
 * The `SURFACE_PROFILES` entry for one surface id, as a field map.
 *
 * Parsed from the struct literal rather than from the file's prose: the
 * `mcp-tool` row carries a long correction comment that MENTIONS its fields, and
 * manifest.rs warns in that comment that a field-scanning parser will read the
 * commentary as the value. Comments are stripped first, for exactly that reason.
 */
function surfaceProfile(id: string): {
  modelProvider: boolean;
  granted: string[];
  hostGlobalsDeleted: boolean;
} {
  const code = MANIFEST.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const start = code.indexOf(`id: "${id}",`);
  expect(start, `SURFACE_PROFILES has no row for "${id}"`).toBeGreaterThan(-1);
  const end = code.indexOf("SurfaceProfile {", start);
  const row = code.slice(start, end === -1 ? code.length : end);

  const modelProvider = /model_provider:\s*(true|false)/.exec(row);
  const hostGlobals = /host_globals_deleted:\s*(true|false)/.exec(row);
  const granted = /granted:\s*&\[([^\]]*)\]/.exec(row);
  expect(modelProvider, "model_provider not found").toBeTruthy();
  expect(hostGlobals, "host_globals_deleted not found").toBeTruthy();
  expect(granted, "granted not found").toBeTruthy();

  return {
    modelProvider: modelProvider![1] === "true",
    hostGlobalsDeleted: hostGlobals![1] === "true",
    granted: [...granted![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]),
  };
}

/** Every `OP_MANIFEST` row, as `{ reach, capability }`. */
function opManifest(): Array<{ reach: string; capability: string | null }> {
  const code = MANIFEST.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const start = code.indexOf("pub const OP_MANIFEST");
  expect(start, "OP_MANIFEST not found").toBeGreaterThan(-1);
  const body = code.slice(start, code.indexOf("\n];", start));
  const rows: Array<{ reach: string; capability: string | null }> = [];
  for (const m of body.matchAll(/\bop\("[^"]*",\s*ReachClass::(\w+)\)/g)) {
    rows.push({ reach: m[1], capability: null });
  }
  for (const m of body.matchAll(
    /\bgated\("[^"]*",\s*ReachClass::(\w+),\s*"([^"]+)"\)/g,
  )) {
    rows.push({ reach: m[1], capability: m[2] });
  }
  expect(rows.length, "OP_MANIFEST parsed as empty").toBeGreaterThan(20);
  return rows;
}

/** `surface_ops()`, reimplemented over the parsed manifest. */
function surfaceOps(id: string): Array<{ reach: string; capability: string | null }> {
  const profile = surfaceProfile(id);
  if (profile.hostGlobalsDeleted) return [];
  return opManifest().filter((e) =>
    e.capability === null
      ? true
      : profile.modelProvider && profile.granted.includes(e.capability),
  );
}

/** `surface_reach()` — the reach classes this surface can touch. */
function surfaceReach(id: string): string[] {
  return [...new Set(surfaceOps(id).map((e) => e.reach))].sort();
}

/** `surface_capability_ids()` — empty means "nothing beyond the workbook". */
function surfaceCapabilityIds(id: string): string[] {
  return [
    ...new Set(surfaceOps(id).flatMap((e) => (e.capability === null ? [] : [e.capability]))),
  ].sort();
}

/**
 * THE SURFACE A MACRO RUNS ON.
 *
 * Both macro run routes reach the same interpreter: the library's Run goes
 * through `runMacroModule` -> `runWorkbookScript` -> `run_script`
 * (extensions/MacroRecorder/lib/macroLibrary.ts), and a publisher's button cell
 * through the Rust button door `run_control_action`
 * (app/src-tauri/src/scripting/control_action.rs), which hands its source to
 * the same `run_in_interpreter` core `run_script` uses. That core is
 * `ScriptEngine::run_with_options`, which is exactly what the `one-off-script`
 * profile names as its entry point.
 */
const MACRO_SURFACE = "one-off-script";

/**
 * The clause the prompt must contain for each reach class the surface has.
 *
 * Adding a class to the manifest without a clause here fails the test rather
 * than silently widening what a macro may touch behind an unchanged sentence.
 *
 * A Map rather than an object literal: the keys are `ReachClass` VARIANT names
 * copied from Rust, so they are PascalCase by definition and an object literal
 * would have to disable the identifier-format rule to hold them.
 */
const CLAUSE_FOR_REACH = new Map<string, string>([
  ["Grid", "the cells of any sheet in this workbook"],
  ["Workbook", "its sheets, document properties and calculation settings"],
  ["View", "how it is displayed"],
  ["Bookmarks", "its bookmarks"],
  ["AppMetadata", "version and locale settings"],
  ["Output", "the results it prints back to you"],
]);

// ===========================================================================
// Rendering
// ===========================================================================

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;

function render(data: Record<string, unknown>): string {
  act(() => {
    root.render(
      React.createElement(ScriptConsentDialog, {
        onClose: () => undefined,
        data,
      } as never),
    );
  });
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

const BASE = {
  promptId: "consent-1",
  packageName: "Quarterly Reports",
  requestedCapabilities: [],
  changedScripts: [],
  unapprovableMacroNames: [],
};

const MACRO_ONLY = {
  ...BASE,
  scriptCount: 0,
  scriptNames: [],
  scriptIds: [],
  moduleScriptNames: ["Month end"],
  moduleScriptIds: ["macro-month-end"],
};

const OBJECT_ONLY = {
  ...BASE,
  scriptCount: 1,
  scriptNames: ["Refresh"],
  scriptIds: ["obj-refresh"],
  moduleScriptNames: [],
  moduleScriptIds: [],
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

// ===========================================================================

describe("the premise, read from the interpreter", () => {
  it("a macro's surface holds no capability and reaches nothing outside the workbook", () => {
    const profile = surfaceProfile(MACRO_SURFACE);
    expect(profile.modelProvider, "no ModelDataProvider is injected here").toBe(false);
    expect(profile.granted, "and no capability id can be held for it").toEqual([]);
    expect(surfaceCapabilityIds(MACRO_SURFACE)).toEqual([]);
    expect(
      surfaceReach(MACRO_SURFACE),
      "the model class is the only one that leaves the cloned workbook",
    ).not.toContain("Model");
  });

  it("...and it is NOT clamped to one sheet, unlike a restricted object script", () => {
    // The reach classes the surface really has. `Workbook` alone already proves
    // the object-script sentence cannot describe it: that class is sheets,
    // visibility and document settings, which "the sheet currently shown" is not.
    expect(surfaceReach(MACRO_SURFACE)).toContain("Grid");
    expect(surfaceReach(MACRO_SURFACE)).toContain("Workbook");
  });

  it("every reach class the surface has is one this test knows a clause for", () => {
    for (const reach of surfaceReach(MACRO_SURFACE)) {
      expect(
        CLAUSE_FOR_REACH.get(reach),
        `manifest.rs gives ${MACRO_SURFACE} the '${reach}' reach class and no ` +
          "sentence in the consent prompt has been written for it — the screen " +
          "would understate what a macro may touch",
      ).toBeDefined();
    }
  });
});

describe("a MACRO-ONLY prompt describes the macro surface, not the object-script realm", () => {
  it("does not end with the object-script restricted-mode sentence", () => {
    const text = render(MACRO_ONLY);
    expect(
      text,
      "with scriptCount: 0 the prompt still claimed the object-script realm's " +
        "containment — a clamp this application's code is not subject to",
    ).not.toContain("restricted mode");
    expect(text).not.toContain("the cells of the sheet currently shown");
  });

  it("states the macro surface's own reach, class by class", () => {
    const text = render(MACRO_ONLY);
    for (const reach of surfaceReach(MACRO_SURFACE)) {
      expect(text, `the '${reach}' reach class is not stated on the prompt`).toContain(
        CLAUSE_FOR_REACH.get(reach)!,
      );
    }
  });

  it("says there is no capability to grant, because the surface holds none", () => {
    expect(surfaceCapabilityIds(MACRO_SURFACE)).toEqual([]);
    const text = render(MACRO_ONLY);
    expect(text).toContain("no permission to grant and none to withhold");
    expect(text).toContain("no network, no files, no BI data");
  });

  it("still tells the user the approval is remembered and re-asked on a change", () => {
    const text = render(MACRO_ONLY);
    expect(text).toContain("You can inspect the source before allowing.");
    expect(text).toContain("Allowing is remembered with this workbook");
  });
});

describe("an OBJECT-SCRIPT prompt keeps the object-script sentence", () => {
  it("says restricted mode, and does not borrow the macro paragraph", () => {
    // The positive control. Deleting the restricted-mode sentence outright would
    // pass every assertion above and would be just as dishonest.
    const text = render(OBJECT_ONLY);
    expect(text).toContain("restricted mode");
    expect(text).toContain("read and write the cells of the sheet currently shown");
    expect(text).not.toContain("A macro is not an object script");
  });

  it("an application with BOTH kinds gets BOTH paragraphs", () => {
    const text = render({
      ...OBJECT_ONLY,
      moduleScriptNames: ["Month end"],
      moduleScriptIds: ["macro-month-end"],
    });
    expect(text).toContain("restricted mode");
    expect(text).toContain("A macro is not an object script");
  });
});

describe("the prompt says what Allow cannot cover", () => {
  it("names an id-colliding macro instead of looping in silence", () => {
    const text = render({
      ...OBJECT_ONLY,
      unapprovableMacroNames: ["Month end"],
    });
    expect(text).toContain("cannot be approved and will not run");
    expect(text).toContain("Month end");
  });

  it("says nothing of the sort when everything is approvable", () => {
    expect(render(OBJECT_ONLY)).not.toContain("cannot be approved");
  });
});

// ===========================================================================
// OWNER DECISION B, follow-up F4: a macro WRITTEN AS AN OBJECT SCRIPT (the
// Macro Recorder's default) does not run in the interpreter the paragraph
// above describes. It runs in a restricted worker realm, and a run YOU start
// may also change the cells of any sheet -- and nothing more. The screen says
// exactly that, names exactly the doors that carry a person's pass, and never
// tells such a macro it "is not an object script".
// ===========================================================================

describe("a macro written as an OBJECT SCRIPT gets its own paragraph (owner decision B)", () => {
  const OBJECT_SCRIPT_MACRO_ONLY = { ...MACRO_ONLY, objectScriptMacroIds: ["macro-month-end"] };

  // SABOTAGE: drop the `{objectScriptMacroCount > 0 && (...)}` paragraph from
  // ScriptConsentDialog.tsx -> the screen says nothing of cell access.
  it("says what a run YOU start may do -- the cells of any sheet, and nothing more -- and that a part-way run is undone", () => {
    const text = render(OBJECT_SCRIPT_MACRO_ONLY);
    expect(text).toContain("This macro is written as an object script");
    expect(text).toContain("it may also read and change the cells of any sheet in this workbook");
    expect(text).toContain("no other formatting, no sheet structure, no files, no other macros");
    expect(text).toContain("If it stops part-way, every change it made is undone.");
    expect(text).toContain("Started by another script, it has only what every restricted script has: the sheet on screen.");
  });

  // SABOTAGE: render the interpreter paragraph whenever there are macros
  // (`moduleScriptNames.length > 0`) -> an object-script macro is told it runs
  // "in Calcula's isolated interpreter, on a copy of this workbook".
  it("does not describe it as running in the interpreter, on a copy of the workbook", () => {
    const text = render(OBJECT_SCRIPT_MACRO_ONLY);
    expect(text).not.toContain("on a copy of this workbook");
    expect(text).not.toContain("A macro is not an object script");
  });

  it("an application with BOTH runtimes gets both paragraphs, each naming its own", () => {
    const text = render({
      ...MACRO_ONLY,
      moduleScriptNames: ["Month end", "Report"],
      moduleScriptIds: ["macro-month-end", "macro-report"],
      objectScriptMacroIds: ["macro-month-end"],
    });
    expect(text).toContain("A macro written for the workbook script runtime is not an object script");
    expect(text).toContain("on a copy of this workbook");
    expect(text).toContain("One of these macros is written as an object script");
  });

  it("CONTROL: an application whose macros are all for the workbook script runtime reads exactly as before", () => {
    const text = render(MACRO_ONLY);
    expect(text).toContain("A macro is not an object script");
    expect(container.querySelector("[data-consent-object-script-macros]")).toBeNull();
    expect(text).not.toContain("may also read and change the cells of any sheet");
  });

  it("an id the prompt does not list as a macro cannot add the paragraph", () => {
    const text = render({ ...MACRO_ONLY, objectScriptMacroIds: ["macro-someone-else"] });
    expect(container.querySelector("[data-consent-object-script-macros]")).toBeNull();
    expect(text).not.toContain("may also read and change the cells of any sheet");
  });

  // THE DOORS IT NAMES ARE EXACTLY THE DOORS THAT MINT A PASS -- read from the
  // production source, the way macroProvenance.test.ts reads them for the
  // Macros dialog's sentence. Unwiring a door (or wiring a new one) turns this
  // red until the screen follows.
  // SABOTAGE: drop ", or from the command line" from describeObjectScriptMacroReach.
  it("names exactly the doors that mint a person's pass, and the Macros dialog says the same", async () => {
    const appRoot = path.resolve(__dirname, "..", "..", "..");
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const minted = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "__tests__") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
          for (const m of strip(fs.readFileSync(full, "utf8")).matchAll(/mintExplicitMacroRun\("(\w+)"/g)) {
            minted.add(m[1]);
          }
        }
      }
    };
    walk(path.join(appRoot, "src"));
    walk(path.join(appRoot, "extensions"));
    const PHRASE: Record<string, string> = {
      macrosDialog: "Developer ▸ Macros ▸ Run",
      button: "clicking a button that runs it",
      commandLine: "the command line",
    };
    const passModule = fs.readFileSync(path.join(appRoot, "src/api/explicitMacroRun.ts"), "utf8");
    const union = passModule.match(/export type ExplicitMacroRunDoor = ([^;]+);/)?.[1] ?? "";
    const doors = [...union.matchAll(/"(\w+)"/g)].map((m) => m[1]).sort();
    expect(doors, "a door the screen has no words for").toEqual(Object.keys(PHRASE).sort());
    // Positive control: today every door mints.
    expect([...minted].sort()).toEqual(["button", "commandLine", "macrosDialog"]);

    const sentence = describeObjectScriptMacroReach(1, 1);
    const yours = sentence.slice(sentence.indexOf("When you run"), sentence.indexOf("it may also read"));
    expect(yours.length, "the 'when you run it yourself' clause moved").toBeGreaterThan(0);
    for (const door of doors) {
      if (minted.has(door)) expect(yours, `"${door}" mints a pass, so the screen must name it`).toContain(PHRASE[door]);
      else expect(sentence, `"${door}" mints no pass, yet the screen promises it cell access`).not.toContain(PHRASE[door]);
    }
    // ONE PROMISE IN TWO PLACES: the Macros dialog's note on such a macro says
    // the same doors and the same limits (macroLibrary.ts describeMacroProvenance).
    // Read from its source (its module needs more of @api than this file
    // doubles), with the concatenated string literals joined back into prose.
    const libSrc = fs.readFileSync(path.join(appRoot, "extensions/MacroRecorder/lib/macroLibrary.ts"), "utf8");
    const at = libSrc.indexOf("export function describeMacroProvenance(");
    expect(at, "describeMacroProvenance moved").toBeGreaterThan(-1);
    const note = libSrc.slice(at, libSrc.indexOf("export function macroRunAccessLevel(", at)).replace(/"\s*\+\s*"/g, "");
    const noteYours = note.slice(note.indexOf("When you run it yourself"), note.indexOf("it may also read"));
    for (const door of doors) {
      if (minted.has(door)) expect(noteYours, door).toContain(PHRASE[door]);
    }
    expect(note).toContain("no other formatting, no sheet structure, no files, no other macros");
    expect(sentence).toContain("no other formatting, no sheet structure, no files, no other macros");
  });

  // THE "UNDONE" CLAUSE IS A STATEMENT ABOUT THE HOST: a granted run that does
  // not complete is taken back to the savepoint marked before it ran
  // (host.ts closeGrantedRunStep -> roll_back_to_undo_savepoint; proven end to
  // end by MacroRecorder/__tests__/explicitRunEndToEnd.test.ts "throws after TWO
  // writes"). If that door goes, the sentence must go with it.
  it("the 'undone' clause is backed by the host's rollback door", () => {
    const appRoot = path.resolve(__dirname, "..", "..", "..");
    const host = fs.readFileSync(path.join(appRoot, "src/api/scriptHost/host.ts"), "utf8");
    // The rollback answers the restore AND the cells it took back (review of M6b).
    expect(host).toContain('invokeBackend<UndoRollbackWire>("roll_back_to_undo_savepoint"');
    expect(host).toContain('"begin_undo_savepoint"');
  });
});
