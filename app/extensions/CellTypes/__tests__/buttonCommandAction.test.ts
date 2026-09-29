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

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  context: { selection: null, marker: "the shared builder's context" } as Record<string, unknown>,
  commands: new Map<string, { id: string; execute: (ctx: unknown) => unknown }>(),
  toasts: [] as { message: string; variant?: string }[],
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
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  // eslint-disable-next-line @typescript-eslint/naming-convention -- the @api export's own name
  ExtensionRegistry: { getCommand: (id: string) => h.commands.get(id) },
}));
vi.mock("@api/designMode", () => ({ getDesignMode: () => false }));
vi.mock("@api/gridDispatch", () => ({ dispatchGridAction: vi.fn() }));

import { buttonCellType } from "../types/button";

function click(action: unknown): Promise<boolean> {
  return (buttonCellType.onClick as (e: unknown) => Promise<boolean>)({
    row: 1,
    col: 1,
    params: { action },
  });
}

beforeEach(() => {
  h.commands.clear();
  h.toasts.length = 0;
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
