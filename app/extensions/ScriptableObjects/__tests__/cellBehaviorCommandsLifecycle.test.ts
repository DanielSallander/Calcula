//! FILENAME: app/extensions/ScriptableObjects/__tests__/cellBehaviorCommandsLifecycle.test.ts
// PURPOSE: The cellBehaviors.* commands the cell-behavior UX registers live
//          exactly as long as that UX: its teardown (the extension's
//          deactivate) takes every one of them away, and a re-registration
//          does not stack a second copy over a stale one.
// CONTEXT: W21 (wave C; the D3 class). registerCellBehaviorUx registered
//          "Highlight Cell Behaviors" and "Attach Cell Behavior to Selection"
//          with ExtensionRegistry.registerCommand, which has no unregister, and
//          never took them back: after deactivate a ribbon button or a
//          cell-type button bound to them still ran a torn-down UX. They are
//          now the commands of an add-in manifest, which unregisterAddIn
//          removes. The registry double below keeps the shell's bookkeeping
//          (src/shell/registries/ExtensionRegistry.ts: an add-in's commands
//          are deleted with it); the ids are read from what was ACTUALLY
//          registered, so a command added later is covered too.

/* eslint-disable @typescript-eslint/naming-convention --
 * The module double below stands in for the @api namespace object
 * ObjectScriptManager. */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@api")>();
  return {
    ...real,
    ObjectScriptManager: { registerScript: vi.fn(), mountScript: vi.fn(async () => undefined) },
    registerRowGutterWidget: vi.fn(() => () => {}),
    registerGridLayer: vi.fn(() => () => {}),
  };
});
vi.mock("@api/cellBehaviors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/cellBehaviors")>()),
  refreshCellBehaviors: vi.fn(async () => undefined),
  activeBehaviorSheet: () => 0,
}));
vi.mock("@api/objectScriptBackend", () => ({ saveObjectScript: vi.fn(async () => undefined) }));

import {
  registerExtensionRegistryService,
  type AddInManifest,
  type CommandDefinition,
  type ExtensionRegistryService,
} from "@api/extensions";
import { registerCellBehaviorUx } from "../lib/cellBehaviorUx";

/** The shell registry's command bookkeeping, recorded. */
const commands = new Map<string, CommandDefinition>();
const addIns = new Map<string, AddInManifest>();
const everRegistered: string[] = [];

const registry = {
  registerAddIn: (manifest: AddInManifest) => {
    addIns.set(manifest.id, manifest);
    for (const command of manifest.commands ?? []) {
      commands.set(command.id, command);
      everRegistered.push(command.id);
    }
  },
  unregisterAddIn: (id: string) => {
    for (const command of addIns.get(id)?.commands ?? []) commands.delete(command.id);
    addIns.delete(id);
  },
  registerCommand: (command: CommandDefinition) => {
    commands.set(command.id, command);
    everRegistered.push(command.id);
  },
  getCommand: (id: string) => commands.get(id),
  getAllCommands: () => [...commands.values()],
  onSelectionChange: () => () => {},
  onCellChange: () => () => {},
  onRegistryChange: () => () => {},
} as unknown as ExtensionRegistryService;

/** Every door of the context inert. */
function inertContext(): never {
  const inert = (): unknown =>
    new Proxy(() => () => {}, {
      get: (_t, prop) => (prop === "then" ? undefined : inert()),
      apply: () => () => {},
    });
  return inert() as never;
}

beforeEach(() => {
  commands.clear();
  addIns.clear();
  everRegistered.length = 0;
  registerExtensionRegistryService(registry);
});

describe("the cell-behavior UX's commands live exactly as long as it does", () => {
  it("teardown unregisters every command registration added", () => {
    const teardown = registerCellBehaviorUx(inertContext());
    const registered = [...new Set(everRegistered)];
    try {
      expect(registered, "the census has nothing to check").toEqual(
        expect.arrayContaining(["cellBehaviors.toggleHighlight", "cellBehaviors.attachToSelection"]),
      );
      expect(registered.filter((id) => !commands.has(id))).toEqual([]);
    } finally {
      teardown();
    }
    expect(
      registered.filter((id) => commands.has(id)),
      "cellBehaviors.* commands outlived the cell-behavior UX",
    ).toEqual([]);
  });

  it("a second registration after a teardown runs its OWN commands, one copy each", async () => {
    registerCellBehaviorUx(inertContext())();
    const teardown = registerCellBehaviorUx(inertContext());
    try {
      expect([...commands.keys()].filter((id) => id.startsWith("cellBehaviors.")).sort()).toEqual([
        "cellBehaviors.attachToSelection",
        "cellBehaviors.toggleHighlight",
      ]);
    } finally {
      teardown();
    }
  });
});
