//! FILENAME: app/extensions/ScriptableObjects/__tests__/codeStatusRegistration.test.ts
// PURPOSE: What the REAL extension registers for the code-and-scripts move:
//          "Code in This File" and "Script Permissions" as DIALOG WINDOWS (no
//          panel, no rail icon), reachable from Developer and from the
//          status-bar indicator, which sits at the front of the left zone.
// CONTEXT: The two used to be activity-bar icons, then hidden sidebar panels;
//          since 2026-10-04 (owner decision) they are dialogs, like Insert
//          Chart. Every door shows them BY ID -- Settings > Script Security
//          does too, from another extension -- so the ids are pinned here.

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
import type { DialogDefinition, PanelDefinition, StatusBarItemDefinition } from "@api/uiTypes";
import type { ExtensionModule } from "@api/contract";
import type { CodeUnit } from "@api";
import * as ui from "@api/ui";
import { summarizeCodeInventory } from "@api/codeInventory";
import { summarizeForStatus } from "../lib/codeStatusWiring";

const panels = new Map<string, PanelDefinition>();
const dialogs = new Map<string, DialogDefinition>();
const shown: Array<[string, Record<string, unknown> | undefined]> = [];
let ext: ExtensionModule;

/** A context whose doors are inert except panels + dialogs (recorded), menus and the status bar (REAL). */
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
    dialogs: {
      register: (def: DialogDefinition) => void dialogs.set(def.id, def),
      unregister: (id: string) => void dialogs.delete(id),
      show: (id: string, data?: Record<string, unknown>) => void shown.push([id, data]),
      hide: () => undefined,
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
  for (const id of ["developer", "insert"]) ui.registerMenu({ id, label: id, order: 1, items: [] });
  ext = (await import("../index")).default;
  await ext.activate(context());
}, 30_000);

afterAll(async () => {
  await ext.deactivate?.();
});

/** The ids every door shows the dialogs by (Settings > Script Security uses the first). */
const DIALOG_IDS = {
  code: "scriptable-objects.codeInThisFile",
  permissions: "scriptable-objects.permissions",
} as const;

describe("the transparency surfaces are DIALOGS", () => {
  for (const [name, id] of Object.entries(DIALOG_IDS)) {
    it(`${name}: registered as a dialog under ${id}, and as no panel at all`, () => {
      expect(dialogs.get(id), `${id} is not a registered dialog`).toBeDefined();
      expect(panels.has(id), `${id} is still a panel (it would fold out of the sidebar)`).toBe(false);
    });
  }

  it("Developer lists both, and each shows its dialog", () => {
    const developer = ui.getMenus().find((m) => m.id === "developer")!;
    const byId = new Map(developer.items.map((i) => [i.id, i]));
    expect(byId.get(DIALOG_IDS.code)?.label).toBe("Code in This File...");
    expect(byId.get(DIALOG_IDS.permissions)?.label).toBe("Script Permissions...");
    shown.length = 0;
    byId.get(DIALOG_IDS.code)!.action!();
    byId.get(DIALOG_IDS.permissions)!.action!();
    expect(shown.map(([id]) => id)).toEqual([DIALOG_IDS.code, DIALOG_IDS.permissions]);
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

  it("its two doors show THE two dialogs: 'Code in This File' -> Code in This File, 'Script Permissions' -> Script Permissions", () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => root.render(React.createElement(item()!.component)));
      const trigger = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>("[data-testid='code-status']")!;
      shown.length = 0;
      for (const door of ["code-status-open-code", "code-status-open-permissions"]) {
        act(() => trigger().click());
        act(() => document.querySelector<HTMLButtonElement>(`[data-testid='${door}']`)!.click());
      }
      expect(shown.map(([id]) => id)).toEqual([DIALOG_IDS.code, DIALOG_IDS.permissions]);
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
