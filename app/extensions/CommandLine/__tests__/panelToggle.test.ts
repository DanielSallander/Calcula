//! FILENAME: app/extensions/CommandLine/__tests__/panelToggle.test.ts
// PURPOSE: The command line's toggle asks the dialog registry whether the panel
//          is open. Found live 2026-09-29 (e2e fixall-calp CLI-TOGGLE): the
//          toggle mirrored the panel's `isOpen` in a flag only the MOUNTED panel
//          wrote, the X closes the panel by unmounting it, and so View > Command
//          Line / Ctrl+Shift+P could not reopen a panel closed with its X.
//
//          The registry here is the real one (`DialogExtensions`), reached the
//          way the extension reaches it: through `@api`'s show / hide /
//          isDialogOpen. The X is modelled as what it is -- a close that does
//          not go through the toggle.

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({ open: new Map<string, boolean>() }));

// The three dialog doors, over one registry map with the registry's own
// semantics (show opens, hide closes, the query reads). `@api` as a whole is
// not imported: its module-level hooks are not what is under test.
vi.mock("@api", () => ({
  showDialog: (id: string) => h.open.set(id, true),
  hideDialog: (id: string) => h.open.set(id, false),
  isDialogOpen: (id: string) => h.open.get(id) === true,
}));

import { COMMAND_LINE_DIALOG_ID, toggleAppCliPanel } from "../panelToggle";

/** The panel's own X: the dialog container closes it; the toggle never runs. */
function closeWithTheX(): void {
  h.open.set(COMMAND_LINE_DIALOG_ID, false);
}

const isOpen = (): boolean => h.open.get(COMMAND_LINE_DIALOG_ID) === true;

beforeEach(() => {
  h.open.clear();
});

describe("the command line toggle", () => {
  it("opens a closed panel and closes an open one", () => {
    toggleAppCliPanel();
    expect(isOpen()).toBe(true);
    toggleAppCliPanel();
    expect(isOpen()).toBe(false);
  });

  it("reopens a panel that was closed with its X", () => {
    toggleAppCliPanel();
    expect(isOpen(), "precondition: the toggle opened it").toBe(true);
    closeWithTheX();
    toggleAppCliPanel();
    expect(isOpen(), "the toggle 'closed' a panel the X had already closed").toBe(true);
  });

  it("closes a panel something else opened", () => {
    h.open.set(COMMAND_LINE_DIALOG_ID, true);
    toggleAppCliPanel();
    expect(isOpen(), "the toggle reopened a panel that was already open").toBe(false);
  });
});
