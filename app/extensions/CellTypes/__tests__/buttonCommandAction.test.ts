//! FILENAME: app/extensions/CellTypes/__tests__/buttonCommandAction.test.ts
// PURPOSE: A `calcula.button` cell bound to a command runs it with the ONE
//          CommandContext builder (@api/commandDispatch buildCommandContext),
//          not a hand-kept copy of it.
// CONTEXT: Z11 (wave F; wave E core report NEEDS 4). runButtonAction built its
//          own CommandContext -- selection, getCellValue, setCellValue,
//          refreshGrid -- line for line the same as buildCommandContext: a
//          second source of truth that drifts on the first change to either.
//          The button still binds an EXTENSION-registry command only (what its
//          dialog offers); executeCommandAnywhere is deliberately NOT used, as
//          it would widen a button -- which can arrive inside a distributed
//          workbook -- to every CommandRegistry command.
//
//          Since phase 4 of BUG-0257 the Rust button door decides that a click
//          is the user's own command (`run_control_action` answers
//          `command`); running it is the one thing only the page can do, and
//          what this file pins (through lib/buttonCommandRun.ts, plan_M8 S2).

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  context: { selection: null, marker: "the shared builder's context" } as Record<string, unknown>,
  commands: new Map<string, { id: string; execute: (ctx: unknown) => unknown }>(),
  toasts: [] as { message: string; variant?: string }[],
  /** The command the door names for this click. */
  doorCommand: "",
  /** The application the door names with it (null: the user's own button). */
  doorApplication: null as string | null,
  /** Every other backend call the click made. */
  calls: [] as { cmd: string; args: unknown }[],
}));

// The button door, as Rust answers a click on the user's own command button.
vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  invokeBackend: async (cmd: string, args?: unknown) => {
    if (cmd === "run_control_action") {
      return { kind: "command", commandId: h.doorCommand, application: h.doorApplication };
    }
    h.calls.push({ cmd, args });
    return undefined;
  },
}));

vi.mock("@api/commandDispatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/commandDispatch")>()),
  buildCommandContext: () => h.context,
}));
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/notifications")>()),
  showToast: (message: string, options?: { variant?: string }) => {
    h.toasts.push({ message, variant: options?.variant });
  },
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

async function click(action: { kind: string; commandId: string }): Promise<boolean> {
  h.doorCommand = action.commandId;
  const answer = await (buttonCellType.onClick as (e: unknown) => Promise<unknown>)({
    row: 1,
    col: 1,
    params: { action },
  });
  await releaseOnTheButton(answer, 1, 1);
  return true;
}

beforeEach(() => {
  h.commands.clear();
  h.toasts.length = 0;
  h.doorApplication = null;
  h.calls.length = 0;
});

describe("a button bound to a command", () => {
  it("runs the command with the context buildCommandContext builds", async () => {
    const execute = vi.fn();
    h.commands.set("test.button.run", { id: "test.button.run", execute });
    await click({ kind: "command", commandId: "test.button.run" });
    expect(execute, "the button did not run its command").toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0], "the button built its own CommandContext instead of the shared one").toBe(
      h.context,
    );
    expect(h.toasts).toEqual([]);
  });

  it("a command nobody registered says so (control)", async () => {
    await click({ kind: "command", commandId: "test.button.nowhere" });
    expect(h.toasts.map((t) => t.message)).toEqual(['Button command "test.button.nowhere" is not registered']);
  });

  it("a command that fails says why (control)", async () => {
    h.commands.set("test.button.fail", {
      id: "test.button.fail",
      execute: () => {
        throw new Error("nope");
      },
    });
    await click({ kind: "command", commandId: "test.button.fail" });
    expect(h.toasts.map((t) => t.message)).toEqual(["Button command failed: nope"]);
  });
});

describe("a command the door names WITH an application (plan_M8 S1 + S2)", () => {
  // The door answers `command` with the application only after Rust's half
  // said yes (Calcula's list, the approval under its own key, the private-sheet
  // rule). The page's half follows (lib/buttonCommandRun.ts): the command's
  // LIVE registration must opt in (`distributableTrigger`) -- this one does
  // not -- so it never runs as the user's own, it is said, and it is recorded.
  // The whole rule is pinned in buttonCommandAllowlist.test.ts.
  //
  // SABOTAGE: route every `command` answer to the user's-own path in
  // runButtonCellCommand (lib/buttonCommandRun.ts) -> execute runs, red.
  it("is never run as the user's own command, and the refusal is said and recorded", async () => {
    const execute = vi.fn();
    h.commands.set("test.reader.refresh", { id: "test.reader.refresh", execute });
    h.doorApplication = "Sales";
    await click({ kind: "command", commandId: "test.reader.refresh" });
    expect(execute, "an application's command ran as the user's own").not.toHaveBeenCalled();
    expect(h.toasts.map((t) => t.message)).toEqual([
      "This button came with the application 'Sales' and asks to run the command \"test.reader.refresh\", but " +
        "it is not on Calcula's list of commands a button from an application may run, so it did not run. To run " +
        "a command yourself, give the button an action of your own (Insert > Cell Type > Button).",
    ]);
    expect(h.calls.map((c) => c.cmd), "the page's refusal left no row").toEqual(["audit_button_refusal"]);
    expect(h.calls[0].args).toMatchObject({
      kind: "cell",
      row: 1,
      col: 1,
      refused: 'the command "test.reader.refresh"',
      reason: "commandNotAllowed",
    });
    expect(h.calls.map((c) => c.cmd), "nothing was authorized").not.toContain("authorize_button_command");
  });

  it("the user's own command (no application) still runs (control)", async () => {
    const execute = vi.fn();
    h.commands.set("test.button.run", { id: "test.button.run", execute });
    await click({ kind: "command", commandId: "test.button.run" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(h.calls.map((c) => c.cmd)).not.toContain("audit_button_refusal");
  });
});
