//! FILENAME: app/src/api/__tests__/runScriptTriggerWire.test.ts
// PURPOSE: The button a click claims reaches Rust's `run_script` as
//          `request.trigger` (phase 3 of BUG-0257), spelled the way
//          `RunScriptRequest.trigger` / `ScriptRunTrigger` deserialize it
//          (app/src-tauri/src/scripting/types.rs: camelCase, kind
//          "buttonControl" | "buttonCell", sheetIndex/row/col).
// CONTEXT: The REAL @api wrapper, with only the backend door doubled -- so a
//          wrapper that drops the field, or renames it, is red here rather than
//          discovered as an audit row that never names its button.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ calls: [] as { cmd: string; args: unknown }[] }));

vi.mock("../backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backend")>()),
  invokeBackend: async (cmd: string, args?: unknown) => {
    h.calls.push({ cmd, args });
    return { type: "success", output: [], cellsModified: 0, durationMs: 1 };
  },
}));

import { runWorkbookScript } from "../workbookScripts";

beforeEach(() => {
  h.calls.length = 0;
});

function request(): Record<string, unknown> {
  const call = h.calls.find((c) => c.cmd === "run_script");
  expect(call, "run_script was never invoked").toBeDefined();
  return (call!.args as { request: Record<string, unknown> }).request;
}

describe("run_script's request carries the button a click claims", () => {
  // SABOTAGE: drop `trigger: options.trigger` from runWorkbookScript's request
  // (src/api/workbookScripts.ts).
  it("sends the trigger verbatim, in the Rust spelling", async () => {
    await runWorkbookScript("Calcula.log(1);", "button_Report.js", {
      trigger: { kind: "buttonCell", sheetIndex: 2, row: 5, col: 1 },
      startedBy: { kind: "macro", macroId: "macro-report", explicitRun: undefined },
    });
    expect(request().trigger).toEqual({ kind: "buttonCell", sheetIndex: 2, row: 5, col: 1 });
    expect(request().source).toBe("Calcula.log(1);");
  });

  it("sends none for a run nobody clicked a button for", async () => {
    await runWorkbookScript("Calcula.log(1);", "script.js", {
      startedBy: { kind: "macro", macroId: "macro-report", explicitRun: undefined },
    });
    expect(request().trigger).toBeUndefined();
  });
});
