//! FILENAME: app/src/api/__tests__/runScriptStartedByWire.test.ts
// PURPOSE: Owner decision B, follow-up F10 -- who started a module-runtime run
//          reaches Rust's `run_script` as `request.startedBy`, and it can name a
//          PERSON only when a person's act did: a live one-time pass minted for
//          the very macro being run, or the user activating a view bookmark of
//          their own. Rust refuses an application's macro that no person started
//          (`application_code_gate::distributed_run_gate`), so every way the page
//          could over-claim is pinned here.
// CONTEXT: The REAL @api wrapper (`runWorkbookScript`), with only the backend door
//          (and the Script Security confirm) doubled. The Rust half is pinned in
//          application_code_gate_tests.rs; the spelling is drift-tested against
//          app/src-tauri/src/scripting/types.rs below.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: unknown }[],
  promptOnce: false,
}));

vi.mock("../backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backend")>()),
  invokeBackend: async (cmd: string, args?: unknown) => {
    h.calls.push({ cmd, args });
    if (cmd === "run_script" && h.promptOnce) {
      h.promptOnce = false;
      throw new Error("SCRIPT_PROMPT_REQUIRED: approve once for this session");
    }
    return { type: "success", output: [], cellsModified: 0, durationMs: 1 };
  },
}));
vi.mock("../dialogs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dialogs")>()),
  confirmAsync: vi.fn(async () => true),
}));

import {
  APPLICATION_MACRO_NOT_STARTED_BY_YOU,
  runWorkbookScript,
  type WorkbookScriptStarter,
} from "../workbookScripts";
import { claimExplicitMacroRun, mintExplicitMacroRun, type ExplicitMacroRun } from "../explicitMacroRun";

beforeEach(() => {
  h.calls.length = 0;
  h.promptOnce = false;
});

/** Every `run_script` request sent, in order. */
function requests(): Array<Record<string, unknown>> {
  return h.calls
    .filter((c) => c.cmd === "run_script")
    .map((c) => (c.args as { request: Record<string, unknown> }).request);
}

async function startedBy(starter: WorkbookScriptStarter): Promise<unknown> {
  await runWorkbookScript("Calcula.log(1);", "macro-b.js", { startedBy: starter });
  const sent = requests();
  expect(sent, "run_script was never invoked").toHaveLength(1);
  return sent[0].startedBy;
}

describe("a macro run names a person only through a live pass for that very macro", () => {
  // SABOTAGE: make startedByOnTheWire return `{ kind: "you", door: "macrosDialog" }`
  // for every macro starter -> the pass-less and wrong-macro cases go red.
  it("each person's door, from its own pass, is named -- and the pass is spent", async () => {
    for (const door of ["macrosDialog", "button", "commandLine"] as const) {
      h.calls.length = 0;
      const pass = mintExplicitMacroRun(door, "macro-b");
      expect(await startedBy({ kind: "macro", macroId: "macro-b", explicitRun: pass })).toEqual({ kind: "you", door });
      expect(claimExplicitMacroRun(pass), `${door}: the run did not spend the pass`).toBeNull();
    }
  });

  it("no pass -- a script's api.runMacro -- is a script", async () => {
    expect(await startedBy({ kind: "macro", macroId: "macro-b", explicitRun: undefined })).toEqual({ kind: "script" });
  });

  // SABOTAGE: drop `|| claimed.macroId !== starter.macroId` -> a pass minted
  // for one macro names a person for another.
  it("a pass minted for ANOTHER macro names nobody (and is spent all the same)", async () => {
    const other = mintExplicitMacroRun("macrosDialog", "macro-other");
    expect(await startedBy({ kind: "macro", macroId: "macro-b", explicitRun: other })).toEqual({ kind: "script" });
    expect(claimExplicitMacroRun(other)).toBeNull();
  });

  it("a SPENT pass, and a COPY of a pass, name nobody", async () => {
    const spent = mintExplicitMacroRun("macrosDialog", "macro-b");
    expect(claimExplicitMacroRun(spent)).not.toBeNull();
    expect(await startedBy({ kind: "macro", macroId: "macro-b", explicitRun: spent })).toEqual({ kind: "script" });

    h.calls.length = 0;
    const live = mintExplicitMacroRun("macrosDialog", "macro-b");
    const copy = structuredClone(live) as unknown as ExplicitMacroRun;
    expect(await startedBy({ kind: "macro", macroId: "macro-b", explicitRun: copy })).toEqual({ kind: "script" });
    // ...and the copy did not spend the real one.
    expect(claimExplicitMacroRun(live)).not.toBeNull();
  });

  // SABOTAGE: move `startedByOnTheWire(...)` inside the closure handed to
  // withScriptSecurityPrompt -> the retry claims a spent pass and says "script".
  it("the Script Security retry re-sends the SAME answer: the pass is claimed once, before it", async () => {
    h.promptOnce = true;
    const pass = mintExplicitMacroRun("commandLine", "macro-b");
    await runWorkbookScript("Calcula.log(1);", "macro-b.js", {
      startedBy: { kind: "macro", macroId: "macro-b", explicitRun: pass },
    });
    const sent = requests();
    expect(sent, "precondition: the prompt made the wrapper send twice").toHaveLength(2);
    expect(sent.map((r) => r.startedBy)).toEqual([
      { kind: "you", door: "commandLine" },
      { kind: "you", door: "commandLine" },
    ]);
  });
});

describe("a view bookmark's script says who activated the bookmark", () => {
  // SABOTAGE: read `activatedBy` as "person" always in startedByOnTheWire ->
  // a script's activation is sent as the user's.
  it("the user's activation is the view-bookmark door; a script's is a script", async () => {
    expect(await startedBy({ kind: "viewBookmark", activatedBy: "person" })).toEqual({
      kind: "you",
      door: "viewBookmark",
    });
    h.calls.length = 0;
    expect(await startedBy({ kind: "viewBookmark", activatedBy: "script" })).toEqual({ kind: "script" });
  });
});

describe("the wire is Rust's", () => {
  const TYPES = readFileSync(join(__dirname, "..", "..", "..", "src-tauri", "src", "scripting", "types.rs"), "utf8");
  const GATE = readFileSync(
    join(__dirname, "..", "..", "..", "src-tauri", "src", "scripting", "application_code_gate.rs"),
    "utf8",
  );
  const WORKBOOK_SCRIPTS = readFileSync(join(__dirname, "..", "workbookScripts.ts"), "utf8");

  /** The variants of a Rust enum, camelCased as serde writes them. */
  function rustVariants(name: string): string[] {
    const start = TYPES.indexOf(`pub enum ${name} {`);
    expect(start, `Rust enum ${name} moved`).toBeGreaterThan(-1);
    const body = TYPES.slice(start, TYPES.indexOf("\n}\n", start));
    return [...body.matchAll(/^\s{4}([A-Z]\w*)/gm)].map((m) => m[1][0].toLowerCase() + m[1].slice(1));
  }

  it("RunDoor's spellings are Rust's, every one", () => {
    const union = WORKBOOK_SCRIPTS.match(/export type RunDoor = ([^;]+);/)?.[1] ?? "";
    const ts = [...union.matchAll(/"(\w+)"/g)].map((m) => m[1]).sort();
    expect(ts).toEqual(rustVariants("RunDoor").sort());
    expect(ts).toEqual(["button", "commandLine", "macrosDialog", "viewBookmark"]);
  });

  it("RunStartedBy is tagged by `kind`, `you` or `script`, and the request field is `startedBy`", () => {
    expect(rustVariants("RunStartedBy").sort()).toEqual(["script", "you"]);
    const at = TYPES.indexOf("pub enum RunStartedBy {");
    expect(TYPES.slice(at - 200, at)).toContain('#[serde(rename_all = "camelCase", tag = "kind")]');
    const request = TYPES.slice(TYPES.indexOf("pub struct RunScriptRequest {"));
    expect(request.slice(0, request.indexOf("\n}\n"))).toContain("pub started_by: RunStartedBy,");
  });

  it("the refusal sentinel is the gate's", () => {
    expect(GATE).toContain(
      `pub const APPLICATION_MACRO_NOT_STARTED_BY_YOU: &str = "${APPLICATION_MACRO_NOT_STARTED_BY_YOU}";`,
    );
  });
});
