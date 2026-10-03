//! FILENAME: app/extensions/ScriptableObjects/__tests__/codeStatusRegistration.test.ts
// PURPOSE: What the REAL extension registers for the code-and-scripts move:
//          both transparency panels OFF the activity rail but still openable,
//          pinned to the sidebar, reachable from Developer, and the status-bar
//          indicator at the front of the left zone.
// CONTEXT: The two panels used to be rail icons. Taking an icon off the rail
//          is only safe if every other door still opens the panel: a hidden
//          panel the user once moved to the ribbon was reachable from NOWHERE
//          (the registry fix in panelRegistry.ts), and `openPanel` only opens a
//          sidebar panel -- hence `movable: false`.

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  listenForEvent: vi.fn(async () => () => {}),
  listenTauriEvent: vi.fn(async () => () => {}),
}));
// No Tauri host under jsdom: every backend read answers "nothing".
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async () => null),
}));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => {}),
}));

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { PanelDefinition, StatusBarItemDefinition } from "@api/uiTypes";
import type { ExtensionModule } from "@api/contract";
import type { CodeUnit } from "@api";
import * as ui from "@api/ui";
import { summarizeCodeInventory } from "@api/codeInventory";
import { summarizeForStatus } from "../lib/codeStatusWiring";

const panels = new Map<string, PanelDefinition>();
const openedPanels: string[] = [];
let ext: ExtensionModule;

/** A context whose doors are inert except panels (recorded), menus and the status bar (REAL). */
function context(): never {
  const inert = (): unknown =>
    new Proxy(() => () => {}, {
      get: (_t, prop) => (prop === "then" ? undefined : inert()),
      apply: () => () => {},
    });
  const real: Record<string, unknown> = {
    panels: {
      register: (def: PanelDefinition) => void panels.set(def.id, def),
      unregister: (id: string) => void panels.delete(id),
    },
    menus: {
      register: ui.registerMenu,
      unregister: ui.unregisterMenu,
      registerItem: ui.registerMenuItem,
      unregisterItem: ui.unregisterMenuItem,
      updateItem: ui.updateMenuItem,
      getAll: ui.getMenus,
      subscribe: ui.subscribeToMenus,
      notifyChanged: ui.notifyMenusChanged,
    },
    statusBar: { register: ui.registerStatusBarItem, unregister: ui.unregisterStatusBarItem },
  };
  return new Proxy(inert() as Record<string, unknown>, {
    get: (t, prop) => {
      if (prop === "ui") {
        return new Proxy(inert() as Record<string, unknown>, {
          get: (u, p) => (p in real ? real[p as string] : (u as Record<string | symbol, unknown>)[p as string]),
        });
      }
      if (prop === "invokeBackend") return vi.fn(async () => null);
      return (t as Record<string | symbol, unknown>)[prop as string];
    },
  }) as never;
}

beforeAll(async () => {
  // The facade's openPanel routes through the shell's PanelService; record it.
  ui.registerPanelService({
    registerPanel: () => undefined,
    unregisterPanel: () => undefined,
    openPanel: (id: string) => void openedPanels.push(id),
    closePanel: () => undefined,
    getPlacement: () => "sidebar",
    setPlacement: () => undefined,
    canMoveTo: () => false,
    setBadge: () => undefined,
    getBadge: () => "",
    getPanel: () => undefined,
    getAllPanels: () => [],
    onRegistryChange: () => () => undefined,
  } as unknown as Parameters<typeof ui.registerPanelService>[0]);
  for (const id of ["developer", "insert"]) ui.registerMenu({ id, label: id, order: 1, items: [] });
  ext = (await import("../index")).default;
  await ext.activate(context());
}, 30_000);

afterAll(async () => {
  await ext.deactivate?.();
});

const PANEL_IDS = {
  code: "scriptable-objects.codeInThisFile",
  permissions: "scriptable-objects.permissions",
} as const;

describe("the transparency panels leave the rail but stay reachable", () => {
  for (const [name, id] of Object.entries(PANEL_IDS)) {
    it(`${name}: hidden from the rail, pinned to the sidebar`, () => {
      const panel = panels.get(id);
      expect(panel, `${id} was not registered`).toBeDefined();
      expect(panel!.hidden).toBe(true);
      expect(panel!.movable).toBe(false);
      expect(panel!.defaultPlacement).toBe("sidebar");
    });
  }

  it("Developer lists both, by the panels' own titles, and each opens its panel", () => {
    const developer = ui.getMenus().find((m) => m.id === "developer")!;
    const byId = new Map(developer.items.map((i) => [i.id, i]));
    for (const id of Object.values(PANEL_IDS)) {
      const item = byId.get(id);
      expect(item, `Developer has no item for ${id}`).toBeDefined();
      expect(item!.label).toBe(panels.get(id)!.title);
    }
    openedPanels.length = 0;
    byId.get(PANEL_IDS.code)!.action!();
    byId.get(PANEL_IDS.permissions)!.action!();
    expect(openedPanels).toEqual([PANEL_IDS.code, PANEL_IDS.permissions]);
  });
});

describe("the status-bar indicator", () => {
  const item = (): StatusBarItemDefinition | undefined =>
    ui.getStatusBarItems().find((i) => i.id === "scriptable-objects.codeStatus");

  it("is registered on the LEFT, ahead of every other left item", () => {
    const def = item();
    expect(def, "the indicator is not registered").toBeDefined();
    expect(def!.alignment).toBe("left");
    // Calculation progress (100) and the animation transport (30) appear for a
    // while and must never shift the indicator sideways.
    expect(def!.priority).toBeGreaterThan(100);
  });

  it("its two doors open THE two panels: 'Code in This File' -> Code in This File, 'Script Permissions' -> Script Permissions", () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => root.render(React.createElement(item()!.component)));
      const trigger = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>("[data-testid='code-status']")!;
      openedPanels.length = 0;
      for (const door of ["code-status-open-code", "code-status-open-permissions"]) {
        act(() => trigger().click());
        act(() => document.querySelector<HTMLButtonElement>(`[data-testid='${door}']`)!.click());
      }
      expect(openedPanels).toEqual([PANEL_IDS.code, PANEL_IDS.permissions]);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

describe("the indicator's count IS the panel's count", () => {
  it("summarizeForStatus is summarizeCodeInventory, for every kind of unit (an application's held button code included)", () => {
    const base = {
      residence: "",
      sourcePackage: null,
      declaredCapabilities: [],
      liveGrants: null,
      tier: null,
      mounted: false,
      interpreterReach: null,
      interpreterCapabilities: null,
      source: "",
      lineCount: 0,
    };
    const units = [
      { ...base, surfaceId: "object-script", id: "o", name: "o", provenance: "local", declaredCapabilities: ["storage"], mounted: true },
      { ...base, surfaceId: "script-library", id: "l", name: "l", provenance: "distributed", sourcePackage: "lib" },
      { ...base, surfaceId: "one-off-script", id: "buttonAction:abc", name: "b", provenance: "distributed", sourcePackage: "Sales" },
      { ...base, surfaceId: "notebook-cell", id: "n", name: "n", provenance: "local", liveGrants: ["bi.query"] },
    ] as unknown as CodeUnit[];
    const panel = summarizeCodeInventory(units);
    expect(summarizeForStatus(units)).toEqual({
      total: panel.total,
      local: panel.local,
      distributed: panel.distributed,
      libraries: panel.libraries,
      beyondGrid: panel.beyondGrid,
      mounted: panel.mounted,
    });
    expect(summarizeForStatus(units)).toMatchObject({ total: 4, distributed: 2, libraries: 1, beyondGrid: 2 });
  });
});
