//! FILENAME: app/src/shell/registries/__tests__/dialogIsOpen.test.ts
// PURPOSE: `DialogExtensions.isDialogOpen` is the registry's own answer, by
//          whichever path the dialog was opened or closed -- the query a
//          toggle must ask instead of mirroring a component's `isOpen`
//          (the command line's toggle, CLI-TOGGLE, 2026-09-29).

import { describe, it, expect, afterEach } from "vitest";
import { DialogExtensions } from "../dialogExtensions";

const ID = "dialog-is-open-probe";
const Empty = () => null;

afterEach(() => {
  DialogExtensions.unregisterDialog(ID);
});

describe("DialogExtensions.isDialogOpen", () => {
  it("is false for an unknown dialog and for a registered, closed one", () => {
    expect(DialogExtensions.isDialogOpen(ID)).toBe(false);
    DialogExtensions.registerDialog({ id: ID, component: Empty });
    expect(DialogExtensions.isDialogOpen(ID)).toBe(false);
  });

  it("follows open and close, and agrees with getOpenDialogs", () => {
    DialogExtensions.registerDialog({ id: ID, component: Empty });
    DialogExtensions.openDialog(ID);
    expect(DialogExtensions.isDialogOpen(ID)).toBe(true);
    expect(DialogExtensions.getOpenDialogs().some((d) => d.definition.id === ID)).toBe(true);
    DialogExtensions.closeDialog(ID);
    expect(DialogExtensions.isDialogOpen(ID)).toBe(false);
    expect(DialogExtensions.getOpenDialogs().some((d) => d.definition.id === ID)).toBe(false);
  });

  it("is false again once the dialog is unregistered while open", () => {
    DialogExtensions.registerDialog({ id: ID, component: Empty });
    DialogExtensions.openDialog(ID);
    DialogExtensions.unregisterDialog(ID);
    expect(DialogExtensions.isDialogOpen(ID)).toBe(false);
  });
});
