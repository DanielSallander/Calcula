//! FILENAME: app/extensions/GoToSpecial/__tests__/goToDialog.test.tsx
// PURPOSE: Excel's Go To: `navigate.goTo` (F5 / Ctrl+G) opens it; Edit > Go
//          To... sits next to Find / Replace; the dialog lists where you came
//          from and the workbook's names, navigates through the Name Box's own
//          navigator (@api/referenceNavigation), says "Reference isn't valid."
//          for text that names nothing, remembers the location it left so the
//          next F5 offers the way back, and its Special... button opens Go To
//          Special.
// CONTEXT: Home tab 2026-10-04. F5 used to focus the Name Box and Ctrl+G ran
//          Go To Special; there was no Go To dialog.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  shown: [] as string[],
  navigated: [] as string[],
  outcome: { kind: "done" } as { kind: "done" } | { kind: "problem"; message: string } | { kind: "unclaimed" },
  snapshot: {
    surface: "grid",
    selection: { startRow: 4, startCol: 2, endRow: 4, endCol: 2, type: "cells" },
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
  } as Record<string, unknown>,
  executed: [] as string[],
}));

vi.mock("@api/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/ui")>()),
  showDialog: (id: string) => h.shown.push(id),
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => h.snapshot,
}));
vi.mock("@api/referenceNavigation", () => ({
  navigateToReference: async (text: string) => {
    h.navigated.push(text);
    return h.outcome;
  },
}));
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  getAllNamedRanges: async () => [{ name: "Totals", refersTo: "=Sheet1!$A$1", sheetIndex: null }],
  restoreFocusToGrid: () => {},
}));
vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  getAllTables: async () => [{ name: "Sales" }],
}));

import extension, { GO_TO_DIALOG_ID, GO_TO_MENU_ITEM_ID } from "../index";
import { GoToDialog } from "../components/GoToDialog";
import { goToReference, recentLocations, resetRecentLocations, REFERENCE_NOT_VALID } from "../lib/goTo";
import { CommandRegistry, CoreCommands, ExtensionCommands } from "@api/commands";
import { getMenus, registerMenu, unregisterMenu } from "@api/ui";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

beforeAll(() => {
  // The Edit menu as Standard Menus builds it (its last items: Find, Replace).
  registerMenu({
    id: "edit",
    label: "Edit",
    order: 20,
    items: [
      { id: "edit:find", label: "Find...", commandId: CoreCommands.FIND },
      { id: "edit:replace", label: "Replace...", commandId: CoreCommands.REPLACE },
    ],
  });
  CommandRegistry.register(ExtensionCommands.GO_TO_SPECIAL, () => {
    h.executed.push(ExtensionCommands.GO_TO_SPECIAL);
  });
  extension.activate({
    commands: {
      register: (id: string, fn: (...a: unknown[]) => unknown) => CommandRegistry.register(id, fn),
      unregister: (id: string) => CommandRegistry.unregister(id),
    },
    ui: { dialogs: { register: () => {}, unregister: () => {} } },
  } as never);
});
afterAll(() => {
  extension.deactivate?.();
  unregisterMenu("edit");
  CommandRegistry.unregister(ExtensionCommands.GO_TO_SPECIAL);
});

beforeEach(() => {
  h.shown = [];
  h.navigated = [];
  h.executed = [];
  h.outcome = { kind: "done" };
  h.snapshot = {
    surface: "grid",
    selection: { startRow: 4, startCol: 2, endRow: 4, endCol: 2, type: "cells" },
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
  };
  resetRecentLocations();
});

describe("navigate.goTo and the Edit menu", () => {
  it("F5 / Ctrl+G's command opens the Go To dialog", async () => {
    await CommandRegistry.execute(ExtensionCommands.GO_TO);
    expect(h.shown).toEqual([GO_TO_DIALOG_ID]);
  });

  it("Edit > Go To... follows Find... and Replace..., running the command, Ctrl+G shown", () => {
    const edit = getMenus().find((m) => m.id === "edit")!;
    const ids = edit.items.map((i) => i.id);
    expect(ids.slice(-3)).toEqual(["edit:find", "edit:replace", GO_TO_MENU_ITEM_ID]);
    expect(edit.items.at(-1)).toMatchObject({ label: "Go To...", commandId: ExtensionCommands.GO_TO, shortcut: "Ctrl+G" });
  });
});

describe("goToReference", () => {
  it("navigates through the shared navigator and remembers where it came FROM", async () => {
    await goToReference(" Data!A1 ");
    expect(h.navigated).toEqual(["Data!A1"]);
    expect(recentLocations()).toEqual(["Sheet1!$C$5"]);
  });

  it("a range and a quoted sheet are spelled the way a reference is", async () => {
    h.snapshot = { ...h.snapshot, selection: { startRow: 9, startCol: 3, endRow: 1, endCol: 1, type: "cells" }, sheetContext: { activeSheetIndex: 1, activeSheetName: "My Sheet" } };
    await goToReference("A1");
    expect(recentLocations()).toEqual(["'My Sheet'!$B$2:$D$10"]);
  });

  it("keeps the four most recent, newest first, without repeats", async () => {
    for (const [r, c] of [[0, 0], [1, 1], [0, 0], [2, 2], [3, 3], [4, 4]]) {
      h.snapshot = { ...h.snapshot, selection: { startRow: r, startCol: c, endRow: r, endCol: c, type: "cells" } };
      await goToReference("Z1");
    }
    expect(recentLocations()).toEqual(["Sheet1!$E$5", "Sheet1!$D$4", "Sheet1!$C$3", "Sheet1!$A$1"]);
  });

  it("text that names nothing is Excel's 'Reference isn't valid.', and nothing is remembered", async () => {
    h.outcome = { kind: "unclaimed" };
    expect(await goToReference("nothing")).toEqual({ kind: "problem", message: REFERENCE_NOT_VALID });
    expect(recentLocations()).toEqual([]);
  });
});

describe("the Go To dialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onClose = vi.fn();

  const q = <T extends HTMLElement>(id: string): T => {
    const el = container.querySelector(`[data-testid='${id}']`);
    if (!el) throw new Error(`no ${id}`);
    return el as T;
  };
  async function settle(): Promise<void> {
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
  }
  async function render(): Promise<void> {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<GoToDialog isOpen={true} onClose={onClose} />);
    });
    await settle();
  }

  beforeEach(() => onClose.mockClear());
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("lists where you came from first, then the names and tables; the newest fills Reference", async () => {
    await goToReference("B2"); // leaves Sheet1!$C$5 behind
    await render();
    const rows = [...container.querySelectorAll("[role='option']")].map((r) => r.textContent);
    expect(rows).toEqual(["Sheet1!$C$5", "Sales", "Totals"]);
    expect(q<HTMLInputElement>("go-to-reference").value).toBe("Sheet1!$C$5");
  });

  it("picking a row fills Reference; OK goes there and closes", async () => {
    await render();
    await act(async () => q("go-to-item-1").click());
    expect(q<HTMLInputElement>("go-to-reference").value).toBe("Totals");
    await act(async () => q("go-to-ok").click());
    await settle();
    expect(h.navigated).toEqual(["Totals"]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("an invalid reference keeps the dialog open with Excel's sentence", async () => {
    h.outcome = { kind: "unclaimed" };
    await render();
    await act(async () => q("go-to-ok").click());
    await settle();
    expect(q("go-to-error").textContent).toBe(REFERENCE_NOT_VALID);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Special... closes Go To and opens Go To Special", async () => {
    await render();
    await act(async () => q("go-to-special").click());
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(h.executed).toEqual([ExtensionCommands.GO_TO_SPECIAL]);
  });
});
