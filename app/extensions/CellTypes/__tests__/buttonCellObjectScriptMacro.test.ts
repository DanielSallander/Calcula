//! FILENAME: app/extensions/CellTypes/__tests__/buttonCellObjectScriptMacro.test.ts
// PURPOSE: Owner decision B (2026-09-30), follow-up F6: a `calcula.button` cell
//          whose action is a macro that runs only as an OBJECT SCRIPT (the
//          Macro Recorder's default target). The Rust door used to refuse it ("a
//          button cell cannot run it"); now it answers `macro`, and the page
//          runs it through the macro-run seam:
//            * naming THIS cell as the run's `buttonCell` trigger -- the same
//              cell it named to the door, so the door and the trigger the Rust
//              gate verifies agree;
//            * as the button's application's macro (`requirePackage` = the
//              button's stamp), or with no requirement for the user's own;
//            * carrying the one-time explicit-run pass the click's GESTURE
//              (`onClick`) minted for exactly that macro -- door "button";
//            * every outcome said, a seam refusal also recorded (it was
//              decided on this side of the wire).
// CONTEXT: The real cell type (CellTypes/types/button.ts) -> the real shared
//          click (_shared/lib/buttonClickDoor.ts) -> the real @api door
//          wrapper, with only the backend, the toast sink, the grid snapshot and
//          the macro-run provider doubled. The end-to-end run of a recorded
//          macro from this click, through the real provider, host and realm, is
//          in MacroRecorder/__tests__/explicitRunEndToEnd.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: unknown }[],
  door: null as unknown,
  toasts: [] as { message: string; variant?: string }[],
}));

vi.mock("../../../src/api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/api/backend")>()),
  invokeBackend: async (cmd: string, args?: unknown) => {
    h.calls.push({ cmd, args });
    return cmd === "run_control_action" ? h.door : undefined;
  },
}));
vi.mock("../../../src/api/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/api/notifications")>()),
  showToast: (message: string, options?: { variant?: string }) => {
    h.toasts.push({ message, variant: options?.variant });
  },
}));
vi.mock("../../../src/api/designMode", () => ({ getDesignMode: () => false }));
vi.mock("../../../src/api/gridDispatch", () => ({ dispatchGridAction: () => {} }));
vi.mock("../../../src/api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/api/grid")>()),
  setSelection: (s: unknown) => s,
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 4 } }),
}));

import { buttonCellType } from "../types/button";
import { isCellReleaseClaim, type CellReleaseClaim } from "@api/cellClickInterceptors";

/**
 * An in-cell button's press is CLAIMED for its release (BUG-0258 design phase
 * 4: buttons act on release, sliding off cancels): nothing ran at the press.
 * Release it on the same cell, as Core's press session does.
 */
async function releaseOnTheButton(answer: unknown, row: number, col: number): Promise<void> {
  expect(isCellReleaseClaim(answer), "the button's press was not claimed for its release").toBe(true);
  await (answer as CellReleaseClaim).runAtRelease({ clientX: 0, clientY: 0, row, col });
}

import { claimExplicitMacroRun } from "@api/explicitMacroRun";
import {
  registerMacroRunProvider,
  resetMacroRunProvider,
  type MacroRunOptions,
  type MacroRunOutcome,
} from "@api/macroRunService";

let runs: { macroId: string; options?: MacroRunOptions }[];
let answer: MacroRunOutcome;
let unregister: () => void;

beforeEach(() => {
  h.calls.length = 0;
  h.toasts.length = 0;
  h.door = { kind: "macro", macroId: "macro-report", application: "Sales" };
  runs = [];
  answer = { status: "ran", name: "Report" };
  unregister = registerMacroRunProvider({
    runMacroByRef: async (macroId: string, options?: MacroRunOptions) => {
      runs.push({ macroId, options });
      return answer;
    },
  });
});

afterEach(() => {
  unregister();
  resetMacroRunProvider();
});

async function clickButton(): Promise<void> {
  const answer = await buttonCellType.onClick?.({
    row: 6,
    col: 2,
    value: "Go",
    params: { action: { kind: "script", scriptId: "macro-report" } },
    event: { clientX: 0, clientY: 0 } as MouseEvent,
  } as never);
  await releaseOnTheButton(answer, 6, 2);
}

const doorRequest = () =>
  (h.calls.find((c) => c.cmd === "run_control_action")?.args as { request: Record<string, unknown> }).request;
const audited = () => h.calls.filter((c) => c.cmd === "audit_button_refusal").map((c) => c.args);

describe("a button cell's object-script macro runs through the macro seam", () => {
  // SABOTAGE: drop the `macro:` handler from runButtonCell (CellTypes/types/
  // button.ts) -> the shared click says the answer is impossible, nothing runs.
  it("as the button's application's macro, naming this cell -- the cell the door was asked about", async () => {
    await clickButton();
    expect(runs.map((r) => r.macroId)).toEqual(["macro-report"]);
    const { explicitRun, ...rest } = runs[0].options ?? {};
    expect(rest).toEqual({
      requirePackage: "Sales",
      trigger: { kind: "buttonCell", sheetIndex: 4, row: 6, col: 2 },
    });
    // The door and the trigger agree: one cell, the kind each side reads it as.
    const asked = doorRequest();
    expect(asked.kind).toBe("cell");
    expect(rest.trigger).toEqual({ kind: "buttonCell", sheetIndex: asked.sheetIndex, row: asked.row, col: asked.col });
    expect(explicitRun, "a person's click carried no pass").toBeDefined();
  });

  // SABOTAGE: drop the mint from buttonCellType.onClick (pass no gesture) ->
  // no pass, red. (The census in src/api/__tests__/explicitMacroRun.test.ts
  // pins WHERE it is minted.)
  it("carrying the pass the click's gesture minted for exactly that macro -- once", async () => {
    await clickButton();
    const pass = runs[0].options?.explicitRun;
    expect(claimExplicitMacroRun(pass)).toEqual({ door: "button", macroId: "macro-report" });
    expect(claimExplicitMacroRun(pass)).toBeNull();
    // A second click is a second person's act: a new pass.
    await clickButton();
    expect(runs[1].options?.explicitRun).not.toBe(pass);
    expect(claimExplicitMacroRun(runs[1].options?.explicitRun)?.door).toBe("button");
  });

  it("a button of the user's own (no stamp) asks for no application", async () => {
    h.door = { kind: "macro", macroId: "macro-mine", application: null };
    await clickButton();
    const { explicitRun: _pass, ...rest } = runs[0].options ?? {};
    expect(rest).toEqual({ trigger: { kind: "buttonCell", sheetIndex: 4, row: 6, col: 2 } });
  });

  // SABOTAGE: turn an absent `application` back into null in buttonClickDoor.ts
  // (`outcome.application ?? null`) -> the macro runs with no application
  // required, as the user's own, red.
  it("a `macro` answer that does not say whose button it is runs nothing", async () => {
    h.door = { kind: "macro", macroId: "macro-report" };
    await clickButton();
    expect(runs, "an answer with no application ran the macro as the user's own").toEqual([]);
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].message).toContain("did not say whose button it is");
  });

  it("ran: repaints, and says nothing more", async () => {
    let repainted = 0;
    const onRefresh = () => {
      repainted += 1;
    };
    window.addEventListener("grid:refresh", onRefresh);
    try {
      await clickButton();
    } finally {
      window.removeEventListener("grid:refresh", onRefresh);
    }
    expect(repainted).toBe(1);
    expect(h.toasts).toEqual([]);
  });

  it("a Rust-gate refusal is said as 'did not run', and recorded by Rust alone", async () => {
    answer = {
      status: "failed",
      name: "Report",
      message: "DISTRIBUTED_SCRIPT_NOT_CONSENTED: you have not approved the application's code",
    };
    await clickButton();
    expect(h.toasts).toEqual([
      {
        message: '"Report" did not run: DISTRIBUTED_SCRIPT_NOT_CONSENTED: you have not approved the application\'s code',
        variant: "error",
      },
    ]);
    expect(audited()).toEqual([]);
  });

  // REVIEW OF M6b: the runner's own sentences already name the macro and say
  // what happened. Wrapped, the toast read `"Report" failed: "Report" stopped
  // ... nothing was changed` -- the name twice, "failed" beside "nothing was
  // changed".
  // SABOTAGE: drop the `startsWith(\`"${name}" \`)` pass-through from
  // describeLinkedRunFailure (_shared/lib/buttonClickDoor.ts) -> red.
  it("the runner's own sentence is said as it is: the name once, never 'failed' beside 'nothing was changed'", async () => {
    for (const message of [
      // F9: a granted run that stopped part-way and was taken back.
      '"Report" stopped before it finished: boom. Every change it had made was undone, so nothing was changed.',
      // The pre-flight's refusal: it was never run.
      '"Report" was not run: it came in the application "Sales". When you run such a macro yourself it may ' +
        "read and change cells on any sheet, but it also calls api.setRangeFormat, which is outside that " +
        "access. Nothing was changed.",
      // A granted run that could not be given its one undo step.
      '"Report" did not start: a macro you run with cell access is undone as a whole if it stops part-way, ' +
        "and that could not be arranged here (x). Nothing was changed.",
    ]) {
      h.toasts.length = 0;
      answer = { status: "failed", name: "Report", message };
      await clickButton();
      expect(h.toasts, message).toEqual([{ message, variant: "error" }]);
      expect(h.toasts[0].message.split('"Report"').length - 1, "the name is said twice").toBe(1);
      expect(h.toasts[0].message).not.toMatch(/failed/);
    }
    // CONTROL: an error that does not name the macro is still said as a failure.
    h.toasts.length = 0;
    answer = { status: "failed", name: "Report", message: "TypeError: boom" };
    await clickButton();
    expect(h.toasts).toEqual([{ message: '"Report" failed: TypeError: boom', variant: "error" }]);
  });

  it("a macro that is gone is said, never a silent no-op", async () => {
    answer = { status: "notFound", macroId: "macro-report" };
    await clickButton();
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].message).toContain('"macro-report", which no longer exists');
  });

  // SABOTAGE: delete the recordButtonRefusal("cell", ...) call -> no row.
  it("the seam's own refusal (not the button's application's macro) is said AND recorded", async () => {
    answer = {
      status: "refused",
      macroId: "macro-report",
      name: "My report",
      owner: null,
      message: 'This button came with the application "Sales", and the macro "My report" it names is one of your own.',
    };
    await clickButton();
    expect(h.toasts[0].variant).toBe("error");
    expect(h.toasts[0].message).toContain("is one of your own");
    expect(audited()).toEqual([
      { kind: "cell", sheetIndex: 4, row: 6, col: 2, refused: 'the macro "My report"', reason: "macroNotFromApplication" },
    ]);
  });

  it("with no Macro Recorder loaded, names the remedy and runs nothing", async () => {
    unregister();
    resetMacroRunProvider();
    await clickButton();
    expect(runs).toEqual([]);
    expect(h.toasts[0].message).toMatch(/Macro Recorder extension is not loaded/);
  });

  it("a button CONTROL's answer on a cell (`link`) is impossible: said, nothing runs", async () => {
    h.door = { kind: "link" };
    await clickButton();
    expect(runs).toEqual([]);
    expect(h.toasts[0].message).toContain('"link" for a button cell');
  });
});
