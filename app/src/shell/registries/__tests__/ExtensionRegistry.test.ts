import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExtensionRegistry } from "../ExtensionRegistry";
import type { AddInManifest, Command, RibbonTabDefinition, RibbonGroupDefinition } from "../types";

// Cast to access the singleton for testing
const registry = ExtensionRegistry;

function makeCommand(id: string): Command {
  return {
    id,
    name: `Command ${id}`,
    execute: vi.fn(),
  };
}

function makeTab(id: string, order: number): RibbonTabDefinition {
  return {
    id,
    label: `Tab ${id}`,
    order,
    component: (() => null) as unknown as RibbonTabDefinition["component"],
  };
}

function makeGroup(id: string, tabId: string, order: number): RibbonGroupDefinition {
  return {
    id,
    tabId,
    label: `Group ${id}`,
    order,
    component: (() => null) as unknown as RibbonGroupDefinition["component"],
  };
}

function makeManifest(id: string, overrides?: Partial<AddInManifest>): AddInManifest {
  return {
    id,
    name: `AddIn ${id}`,
    version: "1.0.0",
    ...overrides,
  };
}

describe("ExtensionRegistry", () => {
  beforeEach(() => {
    registry.clear();
  });

  // =========================================================================
  // Command Registration
  // =========================================================================

  describe("commands", () => {
    it("registers and retrieves a command", () => {
      const cmd = makeCommand("test.cmd");
      registry.registerCommand(cmd);
      expect(registry.getCommand("test.cmd")).toBe(cmd);
    });

    it("returns undefined for unregistered command", () => {
      expect(registry.getCommand("nonexistent")).toBeUndefined();
    });

    it("overwrites duplicate command with warning", () => {
      const cmd1 = makeCommand("dup");
      const cmd2 = makeCommand("dup");
      registry.registerCommand(cmd1);
      registry.registerCommand(cmd2);
      expect(registry.getCommand("dup")).toBe(cmd2);
    });

    it("getAllCommands returns all registered commands", () => {
      registry.registerCommand(makeCommand("a"));
      registry.registerCommand(makeCommand("b"));
      expect(registry.getAllCommands()).toHaveLength(2);
    });
  });

  // =========================================================================
  // Ribbon Registration
  // =========================================================================

  describe("ribbon tabs", () => {
    it("registers and retrieves tabs sorted by order", () => {
      registry.registerRibbonTab(makeTab("z", 20));
      registry.registerRibbonTab(makeTab("a", 10));
      const tabs = registry.getRibbonTabs();
      expect(tabs[0].id).toBe("a");
      expect(tabs[1].id).toBe("z");
    });

    it("getRibbonTab returns specific tab", () => {
      registry.registerRibbonTab(makeTab("home", 1));
      expect(registry.getRibbonTab("home")?.label).toBe("Tab home");
      expect(registry.getRibbonTab("missing")).toBeUndefined();
    });

    it("unregisterRibbonTab removes tab and its groups", () => {
      registry.registerRibbonTab(makeTab("tab1", 1));
      registry.registerRibbonGroup(makeGroup("g1", "tab1", 1));
      registry.registerRibbonGroup(makeGroup("g2", "tab1", 2));
      registry.registerRibbonGroup(makeGroup("g3", "other", 1));

      registry.unregisterRibbonTab("tab1");

      expect(registry.getRibbonTab("tab1")).toBeUndefined();
      expect(registry.getRibbonGroupsForTab("tab1")).toHaveLength(0);
      // Groups for other tab should remain
      expect(registry.getRibbonGroupsForTab("other")).toHaveLength(1);
    });
  });

  describe("ribbon groups", () => {
    it("returns groups for a tab sorted by order", () => {
      registry.registerRibbonGroup(makeGroup("g2", "tab1", 20));
      registry.registerRibbonGroup(makeGroup("g1", "tab1", 10));
      registry.registerRibbonGroup(makeGroup("g3", "tab2", 5));

      const groups = registry.getRibbonGroupsForTab("tab1");
      expect(groups).toHaveLength(2);
      expect(groups[0].id).toBe("g1");
      expect(groups[1].id).toBe("g2");
    });

    it("unregisterRibbonGroup removes a single group", () => {
      registry.registerRibbonGroup(makeGroup("g1", "tab1", 1));
      registry.unregisterRibbonGroup("g1");
      expect(registry.getRibbonGroupsForTab("tab1")).toHaveLength(0);
    });
  });

  // =========================================================================
  // Add-In Registration
  // =========================================================================

  describe("add-ins", () => {
    it("registers an add-in with all contributions", () => {
      const manifest = makeManifest("my-addon", {
        commands: [makeCommand("cmd1")],
        ribbonTabs: [makeTab("tab1", 1)],
        ribbonGroups: [makeGroup("g1", "tab1", 1)],
      });

      registry.registerAddIn(manifest);

      expect(registry.hasAddIn("my-addon")).toBe(true);
      expect(registry.getCommand("cmd1")).toBeDefined();
      expect(registry.getRibbonTab("tab1")).toBeDefined();
      expect(registry.getRibbonGroupsForTab("tab1")).toHaveLength(1);
    });

    it("unregisters an add-in and removes its contributions", () => {
      const manifest = makeManifest("my-addon", {
        commands: [makeCommand("cmd1")],
        ribbonTabs: [makeTab("tab1", 1)],
        ribbonGroups: [makeGroup("g1", "tab1", 1)],
      });

      registry.registerAddIn(manifest);
      registry.unregisterAddIn("my-addon");

      expect(registry.hasAddIn("my-addon")).toBe(false);
      expect(registry.getCommand("cmd1")).toBeUndefined();
      expect(registry.getRibbonTab("tab1")).toBeUndefined();
    });

    it("unregisterAddIn is a no-op for unknown add-in", () => {
      registry.unregisterAddIn("nonexistent");
      // Should not throw
    });

    it("warns about missing dependencies", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const manifest = makeManifest("child", { dependencies: ["parent"] });
      registry.registerAddIn(manifest);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('depends on "parent"')
      );
      warnSpy.mockRestore();
    });

    it("getRegisteredAddIns returns all add-ins", () => {
      registry.registerAddIn(makeManifest("a"));
      registry.registerAddIn(makeManifest("b"));
      expect(registry.getRegisteredAddIns()).toHaveLength(2);
    });
  });

  // =========================================================================
  // Event Hooks
  // =========================================================================

  describe("events", () => {
    it("notifies selection change listeners", () => {
      const cb = vi.fn();
      registry.onSelectionChange(cb);

      const sel = { row: 1, col: 2, ranges: [] } as any;
      registry.notifySelectionChange(sel);

      expect(cb).toHaveBeenCalledWith(sel);
    });

    it("unsubscribes selection change listener", () => {
      const cb = vi.fn();
      const unsub = registry.onSelectionChange(cb);
      unsub();
      registry.notifySelectionChange(null);
      expect(cb).not.toHaveBeenCalled();
    });

    it("notifies cell change listeners", () => {
      const cb = vi.fn();
      registry.onCellChange(cb);
      registry.notifyCellChange(1, 2, "old", "new");
      expect(cb).toHaveBeenCalledWith(1, 2, "old", "new");
    });

    it("unsubscribes cell change listener", () => {
      const cb = vi.fn();
      const unsub = registry.onCellChange(cb);
      unsub();
      registry.notifyCellChange(0, 0, null, "x");
      expect(cb).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Registry Change Subscription
  // =========================================================================

  describe("registry change subscription", () => {
    it("notifies on tab registration", () => {
      const cb = vi.fn();
      registry.onRegistryChange(cb);
      registry.registerRibbonTab(makeTab("t", 1));
      expect(cb).toHaveBeenCalled();
    });

    it("notifies on add-in registration", () => {
      const cb = vi.fn();
      registry.onRegistryChange(cb);
      registry.registerAddIn(makeManifest("x"));
      expect(cb).toHaveBeenCalled();
    });

    it("unsubscribes registry change listener", () => {
      const cb = vi.fn();
      const unsub = registry.onRegistryChange(cb);
      unsub();
      registry.registerRibbonTab(makeTab("t", 1));
      expect(cb).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Clear
  // =========================================================================

  describe("clear", () => {
    it("removes all registrations", () => {
      registry.registerCommand(makeCommand("c"));
      registry.registerRibbonTab(makeTab("t", 1));
      registry.registerRibbonGroup(makeGroup("g", "t", 1));
      registry.registerAddIn(makeManifest("a"));

      registry.clear();

      expect(registry.getAllCommands()).toHaveLength(0);
      expect(registry.getRibbonTabs()).toHaveLength(0);
      expect(registry.getRegisteredAddIns()).toHaveLength(0);
    });
  });
});
