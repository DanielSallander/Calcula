//! FILENAME: app/extensions/Controls/__tests__/controlActionDoor.test.ts
// PURPOSE: Phase 4 of BUG-0257, the click. Every button-control click -- the
//          in-cell interceptor and the floating button -- goes through the Rust
//          button door `run_control_action`, naming the BUTTON and never code,
//          and each of the door's answers is said exactly once:
//            * ran      -> the run's notices (once per module per session), a
//                          repaint, or its error;
//            * refused  -> the door's sentence, and NO page-side audit row
//                          (Rust already wrote it -- a second would be false);
//            * link     -> the phase-3 macro-link route, fed fresh metadata;
//            * command  -> impossible for a control: said, nothing run;
//            * nothing  -> the surface's own word (silence in a cell).
//          Plus the census: no button path calls `runWorkbookScript`, and the
//          page planners the door replaced are defined nowhere.
// CONTEXT: The real Controls click (Button/interceptors.ts -> lib/controlClick.ts
//          -> _shared/lib/buttonClickDoor.ts -> @api/workbookScripts) with only
//          the backend door, the toast sink, the grid snapshot and the macro-run
//          provider doubled.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const h = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: unknown }[],
  /** The door's next answer (an Error is thrown). */
  door: null as unknown,
  toasts: [] as { message: string; variant?: string }[],
  metadata: null as unknown,
}));

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  invokeBackend: async (cmd: string, args?: unknown) => {
    h.calls.push({ cmd, args });
    if (cmd === "run_control_action") {
      if (h.door instanceof Error) throw h.door;
      return h.door;
    }
    return undefined;
  },
}));
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/notifications")>()),
  showToast: (message: string, options?: { variant?: string; type?: string }) => {
    h.toasts.push({ message, variant: options?.variant ?? options?.type });
  },
}));
vi.mock("../../../src/api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/api/grid")>()),
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 2 } }),
}));
vi.mock("../../../src/api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/api/lib")>()),
  getAllStyles: async () => [{}, { button: true }],
  getCell: async () => ({ styleIndex: 1 }),
}));
vi.mock("../lib/designMode", () => ({ getDesignMode: () => false }));

import { registerMacroRunProvider, resetMacroRunProvider, type MacroRunOptions } from "@api/macroRunService";
import { controlsBackend } from "../lib/controlsBackend";
import { buttonClickInterceptor, refreshStyleCache } from "../Button/interceptors";
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

import { clickButtonControl } from "../lib/controlClick";
import { resetButtonModuleNoticesForTest } from "../../_shared/lib/buttonClickDoor";
import { claimExplicitMacroRun } from "@api/explicitMacroRun";

const ok = (cellsModified = 1, screenUpdating = true) => ({
  kind: "ran",
  result: { type: "success", output: [], cellsModified, durationMs: 1, screenUpdating },
  unavailable: [],
});

let refreshes = 0;
const onRefresh = () => {
  refreshes += 1;
};
let macroRuns: { macroId: string; options?: MacroRunOptions }[];
let unregister: () => void;

beforeEach(async () => {
  h.calls.length = 0;
  h.toasts.length = 0;
  h.door = ok();
  h.metadata = null;
  refreshes = 0;
  macroRuns = [];
  resetButtonModuleNoticesForTest();
  controlsBackend.set(async <T,>(cmd: string, args?: unknown): Promise<T> => {
    h.calls.push({ cmd, args });
    return (cmd === "get_control_metadata" ? h.metadata : undefined) as T;
  });
  unregister = registerMacroRunProvider({
    runMacroByRef: async (macroId: string, options?: MacroRunOptions) => {
      macroRuns.push({ macroId, options });
      return { status: "ran", name: "Report" };
    },
  });
  window.addEventListener("grid:refresh", onRefresh);
  await refreshStyleCache();
});

afterEach(() => {
  window.removeEventListener("grid:refresh", onRefresh);
  unregister();
  resetMacroRunProvider();
});

const cmds = () => h.calls.map((c) => c.cmd);
const doorRequests = () =>
  h.calls.filter((c) => c.cmd === "run_control_action").map((c) => (c.args as { request: unknown }).request);
const audited = () => h.calls.filter((c) => c.cmd === "audit_button_refusal");

async function inCellClick(row = 4, col = 1): Promise<void> {
  await releaseOnTheButton(await buttonClickInterceptor(row, col, { clientX: 0, clientY: 0 }), row, col);
}

describe("an in-cell button click asks the door, naming the button and no code", () => {
  // SABOTAGE: put executeButtonAction back on runWorkbookScript (compose
  // onSelect on the page) -> run_script appears and no door request is sent.
  it("sends run_control_action with the button's kind and cell, and never run_script", async () => {
    await inCellClick(4, 1);
    expect(doorRequests()).toHaveLength(1);
    const request = doorRequests()[0] as Record<string, unknown>;
    expect({ kind: request.kind, sheetIndex: request.sheetIndex, row: request.row, col: request.col }).toEqual({
      kind: "control",
      sheetIndex: 2,
      row: 4,
      col: 1,
    });
    expect(Object.keys(request).sort()).toEqual(["col", "kind", "row", "sheetIndex", "viewState"]);
    expect(cmds(), "a click composed code on the page").not.toContain("run_script");
    expect(cmds(), "a click read the module library on the page").not.toContain("list_scripts");
    expect(cmds(), "a click read the button's code on the page before asking the door").not.toContain(
      "get_control_metadata",
    );
  });

  it("ran: repaints, and says nothing more", async () => {
    await inCellClick();
    expect(refreshes).toBe(1);
    expect(h.toasts).toEqual([]);
  });

  it("ran into an error of its own: says so", async () => {
    h.door = { kind: "ran", result: { type: "error", message: "ReferenceError: Report is not defined", output: [] }, unavailable: [] };
    await inCellClick();
    expect(refreshes).toBe(0);
    expect(h.toasts).toEqual([
      { message: "Button script couldn't run: ReferenceError: Report is not defined", variant: "error" },
    ]);
  });

  // REVIEW OF M6b: a button script that ends with Application.screenUpdating
  // off used to leave the grid stale -- its own written cells included -- and a
  // button has no way to resume it. Excel turns screen updating back on when a
  // macro ends; so does this.
  // SABOTAGE: put back `if (result.screenUpdating !== false)` around the
  // repaint in voiceRan (_shared/lib/buttonClickDoor.ts) -> no repaint, red.
  it("ran with screenUpdating left off: repaints anyway, as Excel does when a macro ends", async () => {
    h.door = ok(3, false);
    await inCellClick();
    expect(refreshes).toBe(1);
    expect(h.toasts).toEqual([]);
  });

  it("a module the code named but cannot call is said ONCE per module, across clicks", async () => {
    const notice = {
      id: "pkg-report",
      name: "Report",
      reason: "distributed",
      message: 'The script module "Report" arrived in the application "Sales", so ...',
    };
    h.door = { ...ok(), unavailable: [notice] };
    await inCellClick();
    await inCellClick();
    expect(h.toasts).toEqual([{ message: notice.message, variant: "info" }]);
  });

  // SABOTAGE: record the refusal on the page as well (a recordButtonRefusal
  // call in the shared refused branch) -> two rows for one click.
  it("refused: the door's own sentence, and NO page-side audit row (Rust wrote it)", async () => {
    const message =
      "DISTRIBUTED_SCRIPT_NOT_CONSENTED: the button at Dash!B5 came with the application 'Sales', and you have " +
      "not approved its code, so it did not run. The approval screen, which shows the code, comes back the next " +
      "time this workbook is opened or the application is updated.";
    h.door = { kind: "refused", reason: "notConsented", message };
    await inCellClick();
    expect(h.toasts).toEqual([{ message, variant: "error" }]);
    expect(audited(), "the page recorded a refusal the door had already recorded").toEqual([]);
    expect(refreshes).toBe(0);
  });

  it("link: the phase-3 route runs the application's macro, from metadata read AFTER the door answered", async () => {
    h.door = { kind: "link" };
    h.metadata = {
      controlType: "button",
      properties: {
        heldMacroRef: { valueType: "static", value: "macro-report" },
        heldFrom: { valueType: "static", value: JSON.stringify({ workspace: "w", application: "Sales", version: "1.0.0" }) },
      },
    };
    await inCellClick(4, 1);
    expect(cmds().indexOf("run_control_action")).toBeLessThan(cmds().indexOf("get_control_metadata"));
    expect(macroRuns.map((r) => r.macroId)).toEqual(["macro-report"]);
    const { explicitRun, ...rest } = macroRuns[0].options ?? {};
    expect(rest).toEqual({
      requirePackage: "Sales",
      trigger: { kind: "buttonControl", sheetIndex: 2, row: 4, col: 1 },
    });
    // THE PERSON'S CLICK (owner decision B): the interceptor -- the gesture --
    // minted the pass, for exactly this macro; the trigger beside it names the
    // same cell the door was asked about.
    // SABOTAGE: drop the gesture argument from buttonClickInterceptor's
    // executeButtonAction call (Button/interceptors.ts) -> no pass, red.
    expect(claimExplicitMacroRun(explicitRun)).toEqual({ door: "button", macroId: "macro-report" });
    const asked = doorRequests()[0] as Record<string, unknown>;
    expect(rest.trigger).toEqual({ kind: "buttonControl", sheetIndex: asked.sheetIndex, row: asked.row, col: asked.col });
  });

  // REVIEW OF M6b: a link run the runner stopped already says so in its own
  // sentence, naming the macro; the toast says it as it is -- the name once,
  // never "failed" beside "nothing was changed".
  it("link: the runner's own sentence is said as it is (the macro named once, no 'failed')", async () => {
    const stopped =
      '"Report" stopped before it finished: boom. Every change it had made was undone, so nothing was changed.';
    unregister();
    unregister = registerMacroRunProvider({
      runMacroByRef: async () => ({ status: "failed", name: "Report", message: stopped }),
    });
    h.door = { kind: "link" };
    h.metadata = {
      controlType: "button",
      properties: {
        heldMacroRef: { valueType: "static", value: "macro-report" },
        heldFrom: { valueType: "static", value: JSON.stringify({ workspace: "w", application: "Sales", version: "1.0.0" }) },
      },
    };
    await inCellClick(4, 1);
    expect(h.toasts).toEqual([{ message: stopped, variant: "error" }]);
  });

  it("macro: impossible for a control -- said, and nothing runs (only a button CELL gets it)", async () => {
    h.door = { kind: "macro", macroId: "macro-report", application: "Sales" };
    await inCellClick();
    expect(macroRuns).toEqual([]);
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].variant).toBe("error");
    expect(h.toasts[0].message).toContain('"macro" for a button control');
  });

  it("link, but the link vanished before the page read it: said, nothing run", async () => {
    h.door = { kind: "link" };
    h.metadata = { controlType: "button", properties: {} };
    await inCellClick();
    expect(macroRuns).toEqual([]);
    expect(h.toasts[0].message).toMatch(/macro link changed while it was being clicked/);
  });

  it("command: impossible for a control -- said, and nothing runs", async () => {
    h.door = { kind: "command", commandId: "format.bold" };
    await inCellClick();
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].variant).toBe("error");
    expect(h.toasts[0].message).toContain('"command" for a button control');
  });

  it("nothing: an in-cell button with nothing on it stays quiet", async () => {
    h.door = { kind: "nothing", message: null };
    await inCellClick();
    expect(h.toasts).toEqual([]);
  });

  it("the door itself failed (scripts disabled): said, never thrown", async () => {
    h.door = new Error("SCRIPTS_DISABLED: Script execution is disabled.");
    await inCellClick();
    expect(h.toasts).toEqual([
      { message: "Button script couldn't run: SCRIPTS_DISABLED: Script execution is disabled.", variant: "error" },
    ]);
  });
});

describe("clickButtonControl hands `nothing` to the surface", () => {
  it("with the door's reason", async () => {
    h.door = { kind: "nothing", message: "no action" };
    const heard: (string | null)[] = [];
    await clickButtonControl(0, 1, 1, (m) => {
      heard.push(m);
    });
    expect(heard).toEqual(["no action"]);
  });

  it("and only for `nothing`", async () => {
    const heard: unknown[] = [];
    for (const answer of [ok(), { kind: "refused", reason: "r", message: "m" }]) {
      h.door = answer;
      await clickButtonControl(0, 1, 1, (m) => {
        heard.push(m);
      });
    }
    expect(heard).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE CENSUS: every button path through the door, no page composition left
// ---------------------------------------------------------------------------

const EXT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(EXT, rel), "utf8");
/** Comments stripped: a comment naming a deleted route is not the route. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function body(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start);
  return rest.slice(0, rest.indexOf("\n}\n"));
}

describe("the census", () => {
  it("no button path calls runWorkbookScript", () => {
    for (const rel of ["Controls/index.ts", "Controls/Button/interceptors.ts", "CellTypes/types/button.ts"]) {
      expect(code(read(rel)), rel).not.toContain("runWorkbookScript(");
    }
  });

  it("both control paths click through the door; the floating one diagnoses only `nothing`", () => {
    const floating = body(read("Controls/index.ts"), "runFloatingButtonClick");
    expect(floating).toContain("await clickButtonControl(sheetIndex, row, col,");
    expect(floating, "the floating click still reads the button's code itself").not.toContain("getControlMetadata(");
    const inCell = body(read("Controls/Button/interceptors.ts"), "executeButtonAction");
    expect(inCell).toContain("await clickButtonControl(sheetIndex, row, col,");
    expect(inCell).not.toContain("getControlMetadata(");
    expect(read("CellTypes/types/button.ts")).toContain('{ kind: "cell", sheetIndex: at.sheetIndex, row: at.row, col: at.col }');
  });

  it("the page planners the door replaced are defined nowhere", () => {
    const roots = [EXT, path.resolve(EXT, "../src")];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          const text = fs.readFileSync(full, "utf8");
          if (/function (planInlineButtonRun|planStoredModuleRun|buildLocalPreamble|loadButtonScriptModules)\b/.test(text)) {
            offenders.push(path.relative(EXT, full));
          }
        }
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });

  it("the shared click records no refusal itself", () => {
    const door = code(read("_shared/lib/buttonClickDoor.ts"));
    expect(door).not.toContain("recordButtonRefusal");
    expect(door).not.toContain("audit_button_refusal");
  });
});
