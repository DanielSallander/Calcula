//! FILENAME: app/extensions/MacroRecorder/__tests__/scriptStartedModuleRun.test.ts
// PURPOSE: Owner decision B, follow-ups F10 + F2, composed at the page.
//          "An APPROVED application macro that the user runs EXPLICITLY (button
//          click, Developer > Macros > Run, CLI) gets the same CELL access in
//          either runtime; standing object scripts and any run a script starts
//          stay restricted." The MODULE runtime has no tiers, so a run a script
//          starts of an application's module macro is REFUSED there -- and every
//          person's door still runs it.
//
// CONTEXT: Nothing between the door and the wire is doubled: the script door
//          (host.ts `executeRunMacro`), the Macro Recorder's real provider and
//          `runMacroModule`, the real `runWorkbookScript` (which claims the pass
//          and says who started the run), and the command line's real engine,
//          app domain and live gateway. Doubled: the module store, and the
//          backend door -- whose `run_script` answers the way Rust's
//          module-runtime gate decides (an application's macro needs
//          `startedBy.kind === "you"`; application_code_gate_tests.rs pins the
//          real rule), so what is proven here is what the PAGE sends on every
//          route and how it voices the refusal.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

interface StoredScript {
  id: string;
  name: string;
  description: string | null;
  source: string;
  sourcePackage: string | null;
}

const h = vi.hoisted(() => ({
  store: new Map<string, StoredScript>(),
  requests: [] as Array<Record<string, unknown>>,
}));

vi.mock("@api/backend", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  invokeBackend: vi.fn(async (cmd: string, args?: { request?: Record<string, unknown> }) => {
    if (cmd !== "run_script") return null;
    const request = args?.request ?? {};
    h.requests.push(request);
    // The module-runtime gate's decision, as Rust makes it: an APPLICATION's
    // stored module needs a person's act; the user's own and ad hoc do not.
    const owner = [...h.store.values()].find((s) => s.source === request.source);
    const startedBy = request.startedBy as { kind?: string } | undefined;
    if (owner && owner.sourcePackage !== null && startedBy?.kind !== "you") {
      throw new Error(
        `APPLICATION_MACRO_NOT_STARTED_BY_YOU: '${owner.id}' came with the application '${owner.sourcePackage}', ` +
          "and nothing shows that you started this run. ... Nothing ran.",
      );
    }
    return { type: "success", output: [], cellsModified: 1, durationMs: 1, screenUpdating: true };
  }),
}));
vi.mock("@api/workbookScripts", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listWorkbookScripts: async () =>
    [...h.store.values()].map((s) => ({ id: s.id, name: s.name, sourcePackage: s.sourcePackage ?? undefined })),
  getWorkbookScript: async (id: string) => {
    const found = h.store.get(id);
    if (!found) throw new Error(`Script '${id}' not found`);
    return { ...found };
  },
}));
vi.mock("@api", async () => {
  const origin = await vi.importActual<typeof import("@api/scriptHost/scriptOrigin")>(
    "@api/scriptHost/scriptOrigin",
  );
  // The REAL wrapper: it claims the pass and puts `startedBy` on the wire.
  const scripts = await vi.importActual<typeof import("@api/workbookScripts")>("@api/workbookScripts");
  return {
    scriptOriginForStoredRecord: origin.scriptOriginForStoredRecord,
    originTagTitle: origin.originTagTitle,
    parseModuleScriptRuntime: scripts.parseModuleScriptRuntime,
    listWorkbookScripts: async () => [...h.store.values()].map((s) => ({ id: s.id, name: s.name })),
    getWorkbookScript: async (id: string) => {
      const found = h.store.get(id);
      if (!found) throw new Error(`Script '${id}' not found`);
      return { ...found };
    },
    listWorkbookScriptRecords: async () => [],
    saveWorkbookScript: async () => undefined,
    deleteWorkbookScript: async () => undefined,
    runWorkbookScript: scripts.runWorkbookScript,
    runObjectScriptOnce: vi.fn(async () => {
      throw new Error("no object-script macro in this test");
    }),
  };
});

import { buildMacroDescription, runMacroByRef, runMacroModule } from "../lib/macroLibrary";
import { mintExplicitMacroRun } from "@api/explicitMacroRun";
import { registerMacroRunProvider, resetMacroRunProvider } from "@api/macroRunService";
import { executeRunMacro, resetMacroRunTracking } from "@api/scriptHost/host";
import { describeLinkedRunFailure } from "../../_shared/lib/buttonClickDoor";
// The command line's real engine, domain and LIVE gateway (a test may reach
// across extensions; production may not).
import { createCliEngine } from "../../_shared/cli/engine";
import { createAppDomain } from "../../CommandLine/cli/appDomain";
import { createAppCliSession } from "../../CommandLine/cli/appSession";
import { createLiveAppGateway } from "../../CommandLine/cli/appGateway";

const MODULE_RUNTIME = buildMacroDescription({ runtime: "notebook", actionCount: 1, recordedAt: "T" });

const APP_MODULE: StoredScript = {
  id: "macro-app-total",
  name: "App total",
  description: MODULE_RUNTIME,
  source: "Calcula.setCellValue(0, 0, 'APP');",
  sourcePackage: "Sales",
};
const MY_MODULE: StoredScript = {
  id: "macro-my-total",
  name: "My total",
  description: MODULE_RUNTIME,
  source: "Calcula.setCellValue(1, 0, 'MINE');",
  sourcePackage: null,
};

const TRIGGER = { kind: "buttonControl" as const, sheetIndex: 0, row: 3, col: 1 };

let unregister: () => void = () => undefined;

beforeEach(() => {
  h.store.clear();
  h.store.set(APP_MODULE.id, APP_MODULE);
  h.store.set(MY_MODULE.id, MY_MODULE);
  h.requests.length = 0;
  resetMacroRunTracking();
  unregister = registerMacroRunProvider({ runMacroByRef });
});
afterEach(() => {
  unregister();
  resetMacroRunProvider();
});

function onlyRequest(): Record<string, unknown> {
  expect(h.requests, "run_script was asked a different number of times").toHaveLength(1);
  return h.requests[0];
}

describe("a run a SCRIPT starts never gets an application module macro's reach", () => {
  // SABOTAGE: delete the APPLICATION_MACRO_NOT_STARTED_BY_YOU branch in
  // executeRunMacro (host.ts) -> the script is told the macro "failed"
  // (HostError) instead of that it did not run.
  it("api.runMacro of an application's MODULE macro: refused, as a refusal -- it did not run", async () => {
    const run = executeRunMacro(APP_MODULE.id);
    await expect(run).rejects.toMatchObject({ name: "BrokerError", code: "PermissionDenied" });
    await expect(run).rejects.toThrow(/macro "App total" did not run: APPLICATION_MACRO_NOT_STARTED_BY_YOU/);
    expect(onlyRequest().startedBy).toEqual({ kind: "script" });
  });

  it("the user's OWN module macro, started by the same script, runs -- it is not asked", async () => {
    await expect(executeRunMacro(MY_MODULE.id)).resolves.toEqual({ name: "My total" });
    expect(onlyRequest().startedBy).toEqual({ kind: "script" });
  });

  it("a button route reached WITHOUT a person's gesture is refused, and says it did not run", async () => {
    const outcome = await runMacroByRef(APP_MODULE.id, { requirePackage: "Sales", trigger: TRIGGER });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.message).toContain("APPLICATION_MACRO_NOT_STARTED_BY_YOU");
    // The button's toast says "did not run" -- the gate already recorded it.
    expect(describeLinkedRunFailure(outcome.name, outcome.message)).toMatch(/^"App total" did not run: /);
    expect(onlyRequest()).toMatchObject({ startedBy: { kind: "script" }, trigger: TRIGGER });
  });
});

describe("every person's door runs it", () => {
  // SABOTAGE: in runMacroModule's module branch, send
  // `startedBy: { kind: "macro", macroId: entry.id, explicitRun: undefined }`
  // (drop the pass, as the old `voidExplicitMacroRun` did) -> every door here
  // is refused.
  it("Developer > Macros > Run", async () => {
    const result = await runMacroModule({
      id: APP_MODULE.id,
      name: APP_MODULE.name,
      source: APP_MODULE.source,
      description: APP_MODULE.description,
      sourcePackage: APP_MODULE.sourcePackage,
      storedSource: APP_MODULE.source,
      explicitRun: mintExplicitMacroRun("macrosDialog", APP_MODULE.id),
    });
    expect(result.type, JSON.stringify(result)).toBe("success");
    expect(onlyRequest().startedBy).toEqual({ kind: "you", door: "macrosDialog" });
  });

  it("a person's click on its button (the gesture's pass, with the button)", async () => {
    const outcome = await runMacroByRef(APP_MODULE.id, {
      requirePackage: "Sales",
      trigger: TRIGGER,
      explicitRun: mintExplicitMacroRun("button", APP_MODULE.id),
    });
    expect(outcome.status).toBe("ran");
    expect(onlyRequest()).toMatchObject({ startedBy: { kind: "you", door: "button" }, trigger: TRIGGER });
  });

  // SABOTAGE: drop `, explicitRun` from the gateway call in appWriters.ts
  // runMacro -> the typed line runs as a script's and is refused.
  it("`run App total` typed at the command line (the real engine, domain and live gateway)", async () => {
    const session = createAppCliSession(createLiveAppGateway());
    const engine = createCliEngine([{ domain: createAppDomain(), session }], "app");
    const lines: Array<{ cls: string; text: string }> = [];
    const io = { print: (text: string, cls?: string) => lines.push({ cls: cls ?? "out", text }), clear: () => undefined };
    const outcome = await engine.executeRun(engine.planRun("run App total"), io as never);
    expect(outcome.ok, JSON.stringify(lines)).toBe(true);
    expect(lines.map((l) => l.text).join("\n")).toContain(`Macro 'App total' ran (from application "Sales").`);
    expect(onlyRequest().startedBy).toEqual({ kind: "you", door: "commandLine" });
  });
});
