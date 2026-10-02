//! FILENAME: app/extensions/CellTypes/__tests__/buttonCellFromApplication.test.ts
// PURPOSE: BUG-0260, the CLICK half, since phase 4 of BUG-0257. A
//          `calcula.button` cell that came with an application never runs the
//          subscriber's (or, in a working copy, the developer's) own macro,
//          never a command that is not on Calcula's list and approved (plan_M8;
//          the page's half of that rule is buttonCommandAllowlist.test.ts), and
//          never a held action -- and the page is no longer what decides that.
// CONTEXT: The click used to decide from the params the page had cached (the
//          deleted `planStoredModuleRun`, with its `fromApplication` check) and
//          record its own refusals. Now the Rust button door
//          `run_control_action` reads the cell from its own store and answers:
//          the stamped-button rules (another party's macro refused and named,
//          a command not on Calcula's list -- or not approved -- refused, a
//          held action refused, the application's own macro run verbatim) are
//          pinned in
//          app/src-tauri/src/scripting/control_action_tests.rs and
//          control_action_door_tests.rs, and EVERY such refusal is written to
//          the audit trail BY RUST. This file proves the page's half:
//
//          * it asks the door and says ITS answer, whatever the params say;
//          * it records NO refusal itself (a second row would be a second,
//            false refusal of one click);
//          * a stamped command never reaches the extension registry unless
//            the door answers `command` -- for the user's own button, or with
//            the application once Rust's command gate said yes (and then the
//            page's own half decides, buttonCommandAllowlist.test.ts);
//          * the user's own command still runs, with the shared context.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: unknown }[],
  door: null as unknown,
  toasts: [] as { message: string; variant?: string }[],
  commands: new Map<string, { id: string; execute: (ctx: unknown) => unknown }>(),
}));

vi.mock("../../../src/api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/api/backend")>()),
  invokeBackend: async (cmd: string, args?: unknown) => {
    h.calls.push({ cmd, args });
    return cmd === "run_control_action" ? h.door : undefined;
  },
}));
// The active sheet a clicked button cell sits on (the true state-vector index).
vi.mock("../../../src/api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/api/grid")>()),
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 3 } }),
}));
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/notifications")>()),
  showToast: (message: string, options?: { variant?: string }) => {
    h.toasts.push({ message, variant: options?.variant });
  },
}));
vi.mock("@api/commandDispatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/commandDispatch")>()),
  buildCommandContext: () => ({}),
}));
vi.mock("@api/designMode", () => ({ getDesignMode: () => false }));
vi.mock("@api/gridDispatch", () => ({ dispatchGridAction: vi.fn() }));

import { registerExtensionRegistryService, type ExtensionRegistryService } from "@api/extensions";
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


// The extension registry, behind the real @api facade: one registration per id.
registerExtensionRegistryService({
  getCommand: (id: string) => h.commands.get(id),
  isCommandShadowed: () => false,
  getAllCommands: () => [...h.commands.values()],
} as unknown as ExtensionRegistryService);

const STAMP = { workspace: "ws-scope-id", application: "Quarterly Reports", version: "1.2.0" };

async function click(params: Record<string, unknown>): Promise<void> {
  const answer = await buttonCellType.onClick?.({
    row: 2,
    col: 2,
    typeId: "calcula.button",
    params,
    event: { clientX: 0, clientY: 0 } as never,
  } as never);
  await releaseOnTheButton(answer, 2, 2);
}

beforeEach(() => {
  h.calls.length = 0;
  h.toasts.length = 0;
  h.commands.clear();
  h.door = { kind: "nothing", message: null };
});

const sent = () => h.calls.map((c) => c.cmd);
const doorRequests = () =>
  h.calls.filter((c) => c.cmd === "run_control_action").map((c) => (c.args as { request: Record<string, unknown> }).request);

/** The door's sentences, as Rust writes them (scripting/control_action.rs). */
const NOT_THE_APPLICATIONS =
  'This button came with the application "Quarterly Reports", and the macro "Report" it names is one of your own. ' +
  "A button from an application runs only that application's own macros, so it did not run. To run this macro from " +
  "a button, give the button an action of your own (Insert > Cell Type > Button).";
// Rust's command gate (application_code_gate::button_command_gate, step 1):
// the command is not on Calcula's list, so the door refuses it -- recorded by
// Rust -- before the page ever sees a command answer.
const COMMAND_REFUSED =
  "APPLICATION_COMMAND_NOT_ALLOWED: the button cell at Sheet4!C3 came with the application 'Quarterly Reports' " +
  "and asks to run the command \"format.bold\", which is not on Calcula's list of commands a button from an " +
  "application may run, so it did not run. To run it yourself, give the button an action of your own " +
  "(Insert > Cell Type > Button).";
const HELD =
  "This button's action came with the application 'Quarterly Reports' (v1.2.0) and does not run in a working copy: " +
  "it runs a macro the application did not bring in, or a command that is not on Calcula's list of commands such " +
  "buttons may run. A push publishes it unchanged, after checking it against the signed version. To give the " +
  "button an action of your own, use Insert > Cell Type > Button on this cell.";

describe("a button cell that came with an application: the door answers, the page says it", () => {
  it("names the cell to the door, on the button's own sheet", async () => {
    await click({ fromApplication: STAMP, action: { kind: "script", scriptId: "macro-report" } });
    expect(doorRequests().map((r) => [r.kind, r.sheetIndex, r.row, r.col])).toEqual([["cell", 3, 2, 2]]);
  });

  // SABOTAGE: record the door's refusal on the page as well (a
  // recordButtonRefusal call in the refused branch of
  // _shared/lib/buttonClickDoor.ts) -> a second audit row, red.
  it("a refusal (the user's own macro) is said in the door's words, and recorded by nobody on this side", async () => {
    h.door = { kind: "refused", reason: "macroNotFromApplication", message: NOT_THE_APPLICATIONS };
    await click({
      fromApplication: STAMP,
      action: { kind: "script", scriptId: "macro-report", functionName: "Exfiltrate" },
    });
    expect(h.toasts).toEqual([{ message: NOT_THE_APPLICATIONS, variant: "error" }]);
    expect(sent(), "the page recorded a refusal the door had already recorded").not.toContain("audit_button_refusal");
    expect(sent()).not.toContain("run_script");
  });

  // SABOTAGE: run a params-named command before asking the door (the old
  // `action.kind === "command"` branch in runButtonCell) -> execute runs, red.
  it("a stamped COMMAND the door refused never reaches the extension registry", async () => {
    const execute = vi.fn();
    h.commands.set("format.bold", { id: "format.bold", execute });
    h.door = { kind: "refused", reason: "notAllowlisted", message: COMMAND_REFUSED };
    await click({ fromApplication: STAMP, action: { kind: "command", commandId: "format.bold" } });
    expect(execute, "a button from an application ran a command").not.toHaveBeenCalled();
    expect(h.toasts).toEqual([{ message: COMMAND_REFUSED, variant: "error" }]);
    expect(sent()).not.toContain("audit_button_refusal");
  });

  it("a checkout's HELD action: the door's notice, as information, never run", async () => {
    h.door = { kind: "refused", reason: "heldInWorkingCopy", message: HELD };
    await click({
      fromApplication: STAMP,
      heldAction: { kind: "script", scriptId: "macro-report", functionName: "Exfiltrate" },
    });
    expect(h.toasts).toEqual([{ message: HELD, variant: "info" }]);
    expect(sent()).not.toContain("run_script");
  });

  it("after a subscribe removed its action: the door's reason, as information", async () => {
    const message =
      "This button came with the application 'Quarterly Reports' and has no action it can run in this workbook. " +
      "To give it one of your own, use Insert > Cell Type > Button.";
    h.door = { kind: "nothing", message };
    await click({ label: "Report", fromApplication: STAMP });
    expect(h.toasts).toEqual([{ message, variant: "info" }]);
  });

  it("its application's own macro: the door ran it, and the page adds nothing", async () => {
    h.door = {
      kind: "ran",
      result: { type: "success", output: [], cellsModified: 1, durationMs: 1, screenUpdating: true },
      unavailable: [],
    };
    await click({ fromApplication: STAMP, action: { kind: "script", scriptId: "macro-app" } });
    expect(h.toasts).toEqual([]);
    expect(sent()).not.toContain("audit_button_refusal");
  });
});

describe("the user's own button", () => {
  it("runs its own command when the door answers `command`", async () => {
    const execute = vi.fn();
    h.commands.set("format.bold", { id: "format.bold", execute });
    // Rust ALWAYS sends the field: null for the user's own button.
    h.door = { kind: "command", commandId: "format.bold", application: null };
    await click({ action: { kind: "command", commandId: "format.bold" } });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  // SABOTAGE: turn an absent `application` back into null in buttonClickDoor.ts
  // (`outcome.application ?? null`) -> the command runs as the user's own, red.
  it("a `command` answer that does not say whose button it is runs NOTHING (never the user's own by default)", async () => {
    const execute = vi.fn();
    h.commands.set("format.bold", { id: "format.bold", execute });
    h.door = { kind: "command", commandId: "format.bold" };
    await click({ action: { kind: "command", commandId: "format.bold" } });
    expect(execute, "an answer with no application ran as the user's own command").not.toHaveBeenCalled();
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].variant).toBe("error");
    expect(h.toasts[0].message).toContain("did not say whose button it is");
    expect(sent(), "nothing was authorized either").not.toContain("authorize_button_command");
  });

  it("the command the DOOR named runs -- never the one the cached params name", async () => {
    const theirs = vi.fn();
    const doors = vi.fn();
    h.commands.set("params.command", { id: "params.command", execute: theirs });
    h.commands.set("store.command", { id: "store.command", execute: doors });
    h.door = { kind: "command", commandId: "store.command", application: null };
    await click({ action: { kind: "command", commandId: "params.command" } });
    expect(theirs).not.toHaveBeenCalled();
    expect(doors).toHaveBeenCalledTimes(1);
  });

  it("with nothing configured: the door's reason", async () => {
    h.door = { kind: "nothing", message: "This button has no action configured (right-click > Cell Type)" };
    await click({});
    expect(h.toasts).toEqual([
      { message: "This button has no action configured (right-click > Cell Type)", variant: "info" },
    ]);
  });

  it("a `link` answer cannot happen for a cell: said, nothing run", async () => {
    h.door = { kind: "link" };
    await click({ action: { kind: "script", scriptId: "s" } });
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].variant).toBe("error");
    expect(h.toasts[0].message).toContain('"link" for a button cell');
  });
});
