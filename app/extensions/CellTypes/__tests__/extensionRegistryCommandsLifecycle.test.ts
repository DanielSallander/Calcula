//! FILENAME: app/extensions/CellTypes/__tests__/extensionRegistryCommandsLifecycle.test.ts
// PURPOSE: X20 (wave D). A command registered with ExtensionRegistry.
//          registerCommand is taken back with ExtensionRegistry.unregisterCommand
//          on deactivate: Standard Cell Types' four cellTypes.* commands, the
//          Checkbox extension's checkbox.toggle, and the Charts extension's
//          twelve chart.* API commands.
// CONTEXT: registerCommand had no inverse anywhere -- not on the @api facade,
//          not on the service contract, not in the shell registry -- so every
//          command registered through it outlived its extension: a ribbon or
//          cell-type button bound to cellTypes.insertCheckbox, or a script
//          running chart.filter.set, still ran the torn-down extension's code
//          after it was disabled (W21 moved two extensions to add-ins; this
//          closes the door itself). The same census found Standard Cell Types'
//          Insert > Cell Type submenu left behind.

import { describe, it, expect, vi } from "vitest";
import { loadHarness, doorsUnder, settle, type Loader } from "../../ModelMenu/__tests__/lifecycleHarness";

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  listenForEvent: vi.fn(async () => () => {}),
  listenTauriEvent: vi.fn(async () => () => {}),
}));
// No Tauri host under jsdom: every backend read answers "nothing" -- a list
// where the caller reads a list (Checkbox's style cache), so an activation's
// initial loads cannot reject unhandled.
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async (cmd: string) => (cmd === "get_all_styles" ? [] : null)),
}));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => {}),
}));

const CELL_TYPES: Loader = () => import("..");
const CHECKBOX: Loader = () => import("../../Checkbox");
const CHARTS: Loader = () => import("../../Charts");

describe("X20: ExtensionRegistry commands live exactly as long as their extension", () => {
  const CASES: [string, Loader, string[]][] = [
    [
      "Standard Cell Types",
      CELL_TYPES,
      ["cellTypes.insertCheckbox", "cellTypes.insertProgress", "cellTypes.insertButton", "cellTypes.clear"],
    ],
    ["Checkbox", CHECKBOX, ["checkbox.toggle"]],
    [
      "Charts",
      CHARTS,
      [
        "chart.filter.set",
        "chart.filter.clear",
        "chart.filter.toggleSeries",
        "chart.filter.toggleCategory",
        "chart.setDataPointOverride",
        "chart.resetToMatchStyle",
        "chart.clearDataPointOverrides",
        "chart.formatAxis",
        "chart.setGradientFill",
        "chart.undoDelete",
        "chart.applyStyle",
      ],
    ],
  ];
  for (const [name, loader, commandIds] of CASES) {
    it(`${name}: deactivate removes every door activate added -- its ExtensionRegistry commands included`, async () => {
      const { ext, context, doors } = await loadHarness(loader);
      const before = doors();
      await ext.activate(context);
      await settle();
      const added = doors().filter((d) => !before.includes(d));
      const registered = doorsUnder(added, "extension-registry/");
      for (const id of commandIds) {
        expect(registered, `${name} no longer registers ${id} -- the census is stale`).toContain(
          `extension-registry/${id}`,
        );
      }
      await ext.deactivate?.();
      await settle();
      expect(doors(), `${name} left these after deactivate (it added ${JSON.stringify(added)})`).toEqual(before);
    }, 60_000);
  }
});

describe("X20: ExtensionRegistry.unregisterCommand end to end", () => {
  it("the @api facade reaches the shell registry through the service bootstrap registers", async () => {
    vi.resetModules();
    const { bootstrapShell } = await import("@shell/bootstrap");
    const { ExtensionRegistry: shellRegistry } = await import("@shell/registries/ExtensionRegistry");
    const { ExtensionRegistry } = await import("@api/extensions");
    bootstrapShell();

    const command = { id: "x20.probe", name: "Probe", execute: () => {} };
    ExtensionRegistry.registerCommand(command);
    expect(shellRegistry.getCommand("x20.probe"), "positive control: registerCommand reached the shell").toBe(command);
    expect(ExtensionRegistry.getCommand("x20.probe")).toBe(command);

    ExtensionRegistry.unregisterCommand(command);
    expect(shellRegistry.getCommand("x20.probe"), "unregisterCommand did not reach the shell registry").toBeUndefined();
    expect(ExtensionRegistry.getAllCommands().map((c) => c.id)).not.toContain("x20.probe");

    // A command already taken back, or never registered, is ignored.
    expect(() => ExtensionRegistry.unregisterCommand(command)).not.toThrow();
    expect(() =>
      ExtensionRegistry.unregisterCommand({ id: "x20.never-registered", name: "Never", execute: () => {} }),
    ).not.toThrow();
  }, 60_000);

  it("the shell registry takes back only the command it was asked for", async () => {
    vi.resetModules();
    const { ExtensionRegistry: shellRegistry } = await import("@shell/registries/ExtensionRegistry");
    const a = { id: "x20.a", name: "A", execute: () => {} };
    const b = { id: "x20.b", name: "B", execute: () => {} };
    shellRegistry.registerCommand(a);
    shellRegistry.registerCommand(b);
    shellRegistry.unregisterCommand(a);
    expect(shellRegistry.getCommand("x20.a")).toBeUndefined();
    expect(shellRegistry.getCommand("x20.b")).toBe(b);
    shellRegistry.unregisterCommand(b);
  });
});

// Review of X20 (wave D): unregisterCommand took an ID and deleted whatever
// held it, so an extension going removed a command another extension had
// registered over it under the same id -- and a third-party extension that
// had shadowed a built-in id (checkbox.toggle, chart.filter.set) left no
// command at all when it went. The removal is now tied to the registration.
describe("X20 review: a removal is tied to the registration, never to the id", () => {
  const ID = "x20.shared";
  const cmd = (name: string) => ({ id: ID, name, execute: () => name });
  async function freshShell() {
    vi.resetModules();
    return (await import("@shell/registries/ExtensionRegistry")).ExtensionRegistry;
  }

  it("A registers x, B registers x over it: A going leaves B's command live, and A never comes back", async () => {
    const registry = await freshShell();
    const a = cmd("A");
    const b = cmd("B");
    registry.registerCommand(a);
    registry.registerCommand(b);
    registry.unregisterCommand(a);
    expect(registry.getCommand(ID), "B's live command was removed by A's teardown").toBe(b);
    registry.unregisterCommand(b);
    expect(registry.getCommand(ID), "A's command came back after A had gone").toBeUndefined();
  });

  it("B going gives back the A it had registered over -- A is still active", async () => {
    const registry = await freshShell();
    const a = cmd("A");
    const b = cmd("B");
    registry.registerCommand(a);
    registry.registerCommand(b);
    registry.unregisterCommand(b);
    expect(registry.getCommand(ID), "B's teardown left no command although A still registers one").toBe(a);
    registry.unregisterCommand(a);
    expect(registry.getCommand(ID)).toBeUndefined();
    expect(registry.getAllCommands().map((c) => c.id)).not.toContain(ID);
  });

  it("three deep, taken back out of order: the most recent one still standing is live", async () => {
    const registry = await freshShell();
    const a = cmd("A");
    const b = cmd("B");
    const c = cmd("C");
    for (const command of [a, b, c]) registry.registerCommand(command);
    registry.unregisterCommand(b);
    expect(registry.getCommand(ID), "the middle one going touched the live one").toBe(c);
    registry.unregisterCommand(c);
    expect(registry.getCommand(ID), "B was taken back, yet came back").toBe(a);
    registry.unregisterCommand(a);
    expect(registry.getCommand(ID)).toBeUndefined();
  });

  it("the same object registered twice is one registration", async () => {
    const registry = await freshShell();
    const a = cmd("A");
    registry.registerCommand(a);
    registry.registerCommand(a);
    registry.unregisterCommand(a);
    expect(registry.getCommand(ID), "one unregister left the same object stacked under itself").toBeUndefined();
  });

  it("an add-in's teardown gives back the command its manifest had registered over", async () => {
    const registry = await freshShell();
    const loose = cmd("loose");
    const inAddIn = cmd("add-in");
    registry.registerCommand(loose);
    registry.registerAddIn({ id: "x20.addin", name: "Add-in", version: "1.0.0", commands: [inAddIn] });
    expect(registry.getCommand(ID), "positive control: the add-in's command is live").toBe(inAddIn);
    registry.unregisterAddIn("x20.addin");
    expect(registry.getCommand(ID), "the add-in's teardown removed a command it did not register").toBe(loose);
  });

  it("an add-in registered again under its id replaces its commands instead of stacking them", async () => {
    const registry = await freshShell();
    const v1 = cmd("v1");
    const v2 = cmd("v2");
    registry.registerAddIn({ id: "x20.addin", name: "Add-in", version: "1.0.0", commands: [v1] });
    registry.registerAddIn({ id: "x20.addin", name: "Add-in", version: "1.0.1", commands: [v2] });
    expect(registry.getCommand(ID)).toBe(v2);
    registry.unregisterAddIn("x20.addin");
    expect(registry.getCommand(ID), "the replaced manifest's command outlived the add-in").toBeUndefined();
  });

  it("through the @api facade and bootstrap's wiring: another extension's command of the same id survives", async () => {
    vi.resetModules();
    const { bootstrapShell } = await import("@shell/bootstrap");
    const { ExtensionRegistry: shellRegistry } = await import("@shell/registries/ExtensionRegistry");
    const { ExtensionRegistry } = await import("@api/extensions");
    bootstrapShell();
    const a = cmd("A");
    const b = cmd("B");
    ExtensionRegistry.registerCommand(a);
    ExtensionRegistry.registerCommand(b);
    ExtensionRegistry.unregisterCommand(a);
    expect(shellRegistry.getCommand(ID), "A's teardown through the facade removed B's command").toBe(b);
    ExtensionRegistry.unregisterCommand(b);
    expect(shellRegistry.getCommand(ID), "B's own teardown through the facade did not take B back").toBeUndefined();
  }, 60_000);

  const OWNERS: [string, Loader, string][] = [
    ["Standard Cell Types", CELL_TYPES, "cellTypes.insertCheckbox"],
    ["Checkbox", CHECKBOX, "checkbox.toggle"],
    ["Charts", CHARTS, "chart.filter.set"],
  ];
  for (const [name, loader, id] of OWNERS) {
    it(`${name} going never takes another extension's ${id} registered over its own`, async () => {
      const { ext, context, shellRegistry } = await loadHarness(loader);
      await ext.activate(context);
      await settle();
      expect(shellRegistry.getCommand(id), `positive control: ${name} registers ${id}`).toBeDefined();
      const other = { id, name: "Another extension's", execute: () => {} };
      shellRegistry.registerCommand(other);
      await ext.deactivate?.();
      await settle();
      expect(shellRegistry.getCommand(id), `${name}'s teardown removed another extension's ${id}`).toBe(other);
      shellRegistry.unregisterCommand(other);
      expect(shellRegistry.getCommand(id), `${name}'s own ${id} came back after ${name} had gone`).toBeUndefined();
    }, 60_000);

    it(`${name}'s ${id} is live again when the one registered over it goes`, async () => {
      const { ext, context, shellRegistry } = await loadHarness(loader);
      await ext.activate(context);
      await settle();
      const own = shellRegistry.getCommand(id);
      expect(own, `positive control: ${name} registers ${id}`).toBeDefined();
      const other = { id, name: "A third-party shadow", execute: () => {} };
      shellRegistry.registerCommand(other);
      shellRegistry.unregisterCommand(other);
      expect(shellRegistry.getCommand(id), `the shadow's teardown left ${name} without its ${id}`).toBe(own);
      await ext.deactivate?.();
      await settle();
      expect(shellRegistry.getCommand(id)).toBeUndefined();
    }, 60_000);
  }
});
