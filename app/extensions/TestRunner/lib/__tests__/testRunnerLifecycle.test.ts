//! FILENAME: app/extensions/TestRunner/lib/__tests__/testRunnerLifecycle.test.ts
// PURPOSE: Everything the Test Runner adds on activate -- its test.* commands
//          and its Developer menu items -- is gone after deactivate.
// CONTEXT: W21 (wave C; the D3 class, reported by WP-DOORS in wave B). The
//          Test Runner registered test.runAll / test.runSuite / test.runMacro /
//          test.showPanel and two Developer menu items and took none of them
//          back: after deactivate "Run All Tests" still ran against a cleared
//          suite list and opened a pane that was no longer registered. The ids
//          are read from what activate ACTUALLY registered, so a command or an
//          item added later is covered without editing this file.

import { describe, it, expect, vi } from "vitest";

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  listenForEvent: vi.fn(async () => () => {}),
  listenTauriEvent: vi.fn(async () => () => {}),
}));

import { CommandRegistry } from "@api/commands";
import { getMenus, registerMenu, unregisterMenu, type MenuItemDefinition } from "@api/ui";
import extension from "../../index";

/** Every door inert, except `commands`, which are REAL and recorded. */
function recordingContext(registered: string[]): never {
  const inert = (): unknown =>
    new Proxy(() => () => {}, {
      get: (_t, prop) => (prop === "then" ? undefined : inert()),
      apply: () => () => {},
    });
  return new Proxy(inert() as Record<string, unknown>, {
    get: (t, prop) => {
      if (prop === "commands") {
        return {
          register: (id: string, fn: (...a: unknown[]) => unknown, opts?: unknown) => {
            registered.push(id);
            CommandRegistry.register(id, fn, opts as never);
          },
          unregister: (id: string) => CommandRegistry.unregister(id),
          execute: (id: string, args?: unknown) => CommandRegistry.execute(id, args),
          has: (id: string) => CommandRegistry.has(id),
        };
      }
      return (t as Record<string | symbol, unknown>)[prop as string];
    },
  }) as never;
}

/** Every menu-bar item at any depth, as "menu/id". */
function menuDoors(): string[] {
  const out: string[] = [];
  const walk = (menuId: string, items: MenuItemDefinition[] | undefined): void => {
    for (const item of items ?? []) {
      out.push(`${menuId}/${item.id}`);
      walk(menuId, item.children);
    }
  };
  for (const menu of getMenus()) walk(menu.id, menu.items);
  return out.sort();
}

describe("the Test Runner's commands and menu items live exactly as long as it does", () => {
  it("deactivate removes every command and Developer menu item activate added", async () => {
    // The Developer menu exists before the Test Runner adds to it.
    registerMenu({ id: "developer", label: "Developer", order: 90, items: [] });
    const before = menuDoors();
    const registered: string[] = [];
    try {
      await extension.activate(recordingContext(registered));
      const added = menuDoors().filter((door) => !before.includes(door));
      try {
        expect(registered, "the census has nothing to check").toEqual(
          expect.arrayContaining(["test.runAll", "test.showPanel"]),
        );
        expect(added, "the census sees no menu item").toEqual(
          expect.arrayContaining(["developer/test-runner.run-all", "developer/test-runner.show-panel"]),
        );
      } finally {
        await extension.deactivate?.();
      }
      expect(
        registered.filter((id) => CommandRegistry.has(id)),
        "the Test Runner left these commands registered after deactivate",
      ).toEqual([]);
      expect(
        menuDoors().filter((door) => !before.includes(door)),
        `the Test Runner left these menu items after deactivate (it added ${JSON.stringify(added)})`,
      ).toEqual([]);
    } finally {
      unregisterMenu("developer");
    }
  });
});
