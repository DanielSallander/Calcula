//! FILENAME: app/extensions/BuiltIn/StandardMenus/__tests__/standardMenusMenuLifecycle.test.tsx
// PURPOSE: The menus Standard Menus BUILDS live exactly as long as it does:
//          Edit and Format (registered by activate) go on deactivate; File,
//          View and Insert (registered by its shell component) go when that
//          component leaves the shell frame. Items OTHER extensions added to
//          those menus are not taken with them: they come back, once each, when
//          the menus are built again.
// CONTEXT: W20 (wave C). @api/ui had no unregisterMenu, so Standard Menus'
//          menus survived its own deactivate by construction (allowed on
//          purpose in builtinMenusLifecycle.test.ts until now). The registry
//          is REAL here and starts empty -- no menu is pre-registered for the
//          extension to replace, so every menu it leaves behind shows.

import { describe, it, expect, vi, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  listenForEvent: vi.fn(async () => () => {}),
  listenTauriEvent: vi.fn(async () => () => {}),
}));

// The shell component's menus come from three hooks that read the grid, the
// task panes and the backend; this file is about the component's REGISTRATION
// lifecycle, so each hook hands back a fixed menu.
vi.mock("../FileMenu", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../FileMenu")>()),
  useFileMenu: () => ({ menu: FILE_MENU, handlers: {} }),
}));
vi.mock("../ViewMenu", () => ({
  useViewMenu: () => ({ menu: VIEW_MENU, handlers: {}, freezeState: { row: false, col: false } }),
}));
vi.mock("../InsertMenu", () => ({
  useInsertMenu: () => ({ menu: INSERT_MENU }),
}));

const FILE_MENU = { id: "file", label: "File", order: 10, items: [{ id: "file:new", label: "New" }] };
const VIEW_MENU = { id: "view", label: "View", order: 40, items: [{ id: "view:zoom", label: "Zoom" }] };
const INSERT_MENU = { id: "insert", label: "Insert", order: 30, items: [{ id: "insert.table", label: "Table..." }] };

type Ui = typeof import("@api/ui");

/** Every door of the context inert, except `commands`, which are REAL. */
async function context(): Promise<never> {
  const { CommandRegistry } = await import("@api/commands");
  const inert = (): unknown =>
    new Proxy(() => () => {}, {
      get: (_t, prop) => (prop === "then" ? undefined : inert()),
      apply: () => () => {},
    });
  return new Proxy(inert() as Record<string, unknown>, {
    get: (t, prop) =>
      prop === "commands"
        ? {
            register: (id: string, fn: (...a: unknown[]) => unknown) => CommandRegistry.register(id, fn),
            unregister: (id: string) => CommandRegistry.unregister(id),
            execute: (id: string) => CommandRegistry.execute(id),
          }
        : (t as Record<string | symbol, unknown>)[prop as string],
  }) as never;
}

function menuIds(ui: Ui): string[] {
  return ui.getMenus().map((m) => m.id).sort();
}

function itemIds(ui: Ui, menuId: string): string[] {
  return ui.getMenus().find((m) => m.id === menuId)?.items.map((i) => i.id) ?? [];
}

beforeEach(() => {
  vi.resetModules();
});

describe("Standard Menus: the Edit and Format menus go with the extension", () => {
  it("deactivate removes Edit and Format; another extension's Edit item survives and returns once", async () => {
    const ui = await import("@api/ui");
    const ext = (await import("../index")).default;
    // Another extension (say Format Painter) adds to Edit before Standard
    // Menus builds it -- the order the shell's activation can produce.
    ui.registerMenuItem("edit", { id: "edit:foreign", label: "Another extension's item" });
    expect(menuIds(ui)).toEqual([]);

    await ext.activate(await context());
    expect(menuIds(ui)).toEqual(["edit", "format"]);
    expect(itemIds(ui, "edit")).toContain("edit:foreign");

    await ext.deactivate?.();
    expect(menuIds(ui), "Standard Menus left its menus behind after deactivate").toEqual([]);

    await ext.activate(await context());
    try {
      expect(itemIds(ui, "edit").filter((id) => id === "edit:foreign")).toHaveLength(1);
      expect(itemIds(ui, "edit")).toContain("edit:undo");
    } finally {
      await ext.deactivate?.();
    }
  });
});

describe("Standard Menus: the File, View and Insert menus go with its shell component", () => {
  it("the component registers them while mounted and removes them on unmount", async () => {
    const ui = await import("@api/ui");
    const { StandardMenus } = await import("../StandardMenus");
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => {
      root.render(React.createElement(StandardMenus));
    });
    try {
      expect(menuIds(ui)).toEqual(["file", "insert", "view"]);
    } finally {
      act(() => {
        root.unmount();
      });
    }
    expect(menuIds(ui), "the shell component left its menus behind after unmount").toEqual([]);
  });

  it("unregistering the extension's shell component unmounts it with its menus (the deactivate path)", async () => {
    const ui = await import("@api/ui");
    const ext = (await import("../index")).default;
    await ext.activate(await context());
    const shell = ui.getShellComponents().find((c) => c.id === "standard-menus");
    expect(shell, "Standard Menus contributed no shell component").toBeTruthy();

    // The shell renders the registered components; render what is registered
    // now, and re-render with what is registered after deactivate.
    const host = document.createElement("div");
    const root = createRoot(host);
    const Frame = (): React.ReactElement =>
      React.createElement(
        React.Fragment,
        null,
        ...ui.getShellComponents().map((c) => React.createElement(c.component, { key: c.id })),
      );
    act(() => {
      root.render(React.createElement(Frame));
    });
    try {
      expect(menuIds(ui)).toEqual(["edit", "file", "format", "insert", "view"]);
      await ext.deactivate?.();
      act(() => {
        root.render(React.createElement(Frame, { key: "after" }));
      });
      expect(menuIds(ui), "menus outlived Standard Menus' deactivate").toEqual([]);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });
});
