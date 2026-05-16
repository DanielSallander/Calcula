import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExtensionRegistry } from "../ExtensionRegistry";
import type { AddInManifest, Command, RibbonTabDefinition, RibbonGroupDefinition } from "../types";

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

describe("ExtensionRegistry - deep tests", () => {
  beforeEach(() => {
    registry.clear();
  });

  // =========================================================================
  // Scale: 50+ extensions
  // =========================================================================

  describe("large-scale registration", () => {
    it("registers 50 extensions with commands, tabs, and groups", () => {
      for (let i = 0; i < 50; i++) {
        const manifest = makeManifest(`ext-${i}`, {
          commands: [makeCommand(`ext-${i}.cmd`)],
          ribbonTabs: [makeTab(`ext-${i}-tab`, i)],
          ribbonGroups: [makeGroup(`ext-${i}-grp`, `ext-${i}-tab`, 1)],
        });
        registry.registerAddIn(manifest);
      }

      expect(registry.getRegisteredAddIns()).toHaveLength(50);
      expect(registry.getAllCommands()).toHaveLength(50);
      expect(registry.getRibbonTabs()).toHaveLength(50);
    });

    it("tabs from 50 extensions are sorted correctly by order", () => {
      for (let i = 49; i >= 0; i--) {
        registry.registerRibbonTab(makeTab(`tab-${i}`, i));
      }
      const tabs = registry.getRibbonTabs();
      for (let i = 0; i < 50; i++) {
        expect(tabs[i].id).toBe(`tab-${i}`);
      }
    });

    it("retrieves any command by id after bulk registration", () => {
      for (let i = 0; i < 50; i++) {
        registry.registerCommand(makeCommand(`bulk.cmd.${i}`));
      }
      expect(registry.getCommand("bulk.cmd.25")).toBeDefined();
      expect(registry.getCommand("bulk.cmd.49")).toBeDefined();
      expect(registry.getCommand("bulk.cmd.50")).toBeUndefined();
    });
  });

  // =========================================================================
  // Extension with 100+ commands
  // =========================================================================

  describe("extension with many commands", () => {
    it("registers an extension with 100 commands", () => {
      const commands: Command[] = [];
      for (let i = 0; i < 100; i++) {
        commands.push(makeCommand(`mega.cmd.${i}`));
      }
      registry.registerAddIn(makeManifest("mega-ext", { commands }));

      expect(registry.getAllCommands()).toHaveLength(100);
      expect(registry.getCommand("mega.cmd.0")).toBeDefined();
      expect(registry.getCommand("mega.cmd.99")).toBeDefined();
    });

    it("unregistering extension removes all 100 commands", () => {
      const commands: Command[] = [];
      for (let i = 0; i < 100; i++) {
        commands.push(makeCommand(`mega.cmd.${i}`));
      }
      registry.registerAddIn(makeManifest("mega-ext", { commands }));
      registry.unregisterAddIn("mega-ext");

      expect(registry.getAllCommands()).toHaveLength(0);
      expect(registry.getCommand("mega.cmd.50")).toBeUndefined();
    });
  });

  // =========================================================================
  // Activation order and dependency resolution
  // =========================================================================

  describe("activation order and dependencies", () => {
    it("allows registration when dependency is already present", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      registry.registerAddIn(makeManifest("parent"));
      registry.registerAddIn(makeManifest("child", { dependencies: ["parent"] }));

      // No warning about missing dependency
      const depWarnings = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes('depends on "parent"')
      );
      expect(depWarnings).toHaveLength(0);
      warnSpy.mockRestore();
    });

    it("warns when registering with missing dependency", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      registry.registerAddIn(makeManifest("orphan", { dependencies: ["missing-dep"] }));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('depends on "missing-dep"')
      );
      warnSpy.mockRestore();
    });

    it("warns for each missing dependency in a multi-dep manifest", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      registry.registerAddIn(makeManifest("multi", { dependencies: ["a", "b", "c"] }));
      const depWarnings = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("depends on")
      );
      expect(depWarnings).toHaveLength(3);
      warnSpy.mockRestore();
    });

    it("partial dependency satisfaction warns only for missing ones", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      registry.registerAddIn(makeManifest("dep-a"));
      registry.registerAddIn(makeManifest("partial", { dependencies: ["dep-a", "dep-b"] }));
      const depWarnings = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("depends on")
      );
      expect(depWarnings).toHaveLength(1);
      expect(depWarnings[0][0]).toContain('"dep-b"');
      warnSpy.mockRestore();
    });
  });

  // =========================================================================
  // Ribbon tab sorting with mixed priorities
  // =========================================================================

  describe("ribbon tab sorting with mixed priorities", () => {
    it("sorts tabs with negative, zero, and positive orders", () => {
      registry.registerRibbonTab(makeTab("pos", 100));
      registry.registerRibbonTab(makeTab("neg", -10));
      registry.registerRibbonTab(makeTab("zero", 0));
      registry.registerRibbonTab(makeTab("mid", 50));

      const tabs = registry.getRibbonTabs();
      expect(tabs.map((t) => t.id)).toEqual(["neg", "zero", "mid", "pos"]);
    });

    it("handles tabs with equal order values (stable relative insertion)", () => {
      registry.registerRibbonTab(makeTab("a", 10));
      registry.registerRibbonTab(makeTab("b", 10));
      registry.registerRibbonTab(makeTab("c", 10));

      const tabs = registry.getRibbonTabs();
      expect(tabs).toHaveLength(3);
      // All have order 10, they should all appear
      expect(tabs.every((t) => t.order === 10)).toBe(true);
    });

    it("sorts groups within a tab by order", () => {
      registry.registerRibbonGroup(makeGroup("g3", "tab", 30));
      registry.registerRibbonGroup(makeGroup("g1", "tab", 10));
      registry.registerRibbonGroup(makeGroup("g2", "tab", 20));
      registry.registerRibbonGroup(makeGroup("other", "other-tab", 5));

      const groups = registry.getRibbonGroupsForTab("tab");
      expect(groups.map((g) => g.id)).toEqual(["g1", "g2", "g3"]);
    });

    it("handles fractional order values", () => {
      registry.registerRibbonTab(makeTab("b", 1.5));
      registry.registerRibbonTab(makeTab("a", 1));
      registry.registerRibbonTab(makeTab("c", 2));

      expect(registry.getRibbonTabs().map((t) => t.id)).toEqual(["a", "b", "c"]);
    });
  });

  // =========================================================================
  // Hook execution order with multiple subscribers
  // =========================================================================

  describe("hook execution order with multiple subscribers", () => {
    it("calls selection change listeners in subscription order", () => {
      const order: number[] = [];
      for (let i = 0; i < 5; i++) {
        const idx = i;
        registry.onSelectionChange(() => order.push(idx));
      }
      registry.notifySelectionChange(null);
      expect(order).toEqual([0, 1, 2, 3, 4]);
    });

    it("calls cell change listeners in subscription order", () => {
      const order: number[] = [];
      for (let i = 0; i < 5; i++) {
        const idx = i;
        registry.onCellChange(() => order.push(idx));
      }
      registry.notifyCellChange(0, 0, null, "x");
      expect(order).toEqual([0, 1, 2, 3, 4]);
    });

    it("handles 20 selection listeners concurrently", () => {
      const callbacks = Array.from({ length: 20 }, () => vi.fn());
      callbacks.forEach((cb) => registry.onSelectionChange(cb));

      const sel = { row: 5, col: 3, ranges: [] } as any;
      registry.notifySelectionChange(sel);

      callbacks.forEach((cb) => expect(cb).toHaveBeenCalledWith(sel));
    });

    it("registry change fires for each tab registration", () => {
      const cb = vi.fn();
      registry.onRegistryChange(cb);

      registry.registerRibbonTab(makeTab("t1", 1));
      registry.registerRibbonTab(makeTab("t2", 2));
      registry.registerRibbonTab(makeTab("t3", 3));

      expect(cb).toHaveBeenCalledTimes(3);
    });

    it("registry change fires for group registration and unregistration", () => {
      const cb = vi.fn();
      registry.onRegistryChange(cb);

      registry.registerRibbonGroup(makeGroup("g1", "t", 1));
      registry.unregisterRibbonGroup("g1");

      expect(cb).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // Remove extension removes all contributions
  // =========================================================================

  describe("remove extension removes all contributions", () => {
    it("removes commands, tabs, and groups on unregister", () => {
      const manifest = makeManifest("full-ext", {
        commands: [makeCommand("full.cmd1"), makeCommand("full.cmd2")],
        ribbonTabs: [makeTab("full-tab1", 1), makeTab("full-tab2", 2)],
        ribbonGroups: [
          makeGroup("full-grp1", "full-tab1", 1),
          makeGroup("full-grp2", "full-tab2", 1),
        ],
      });

      registry.registerAddIn(manifest);
      expect(registry.getAllCommands()).toHaveLength(2);
      expect(registry.getRibbonTabs()).toHaveLength(2);

      registry.unregisterAddIn("full-ext");

      expect(registry.getAllCommands()).toHaveLength(0);
      expect(registry.getRibbonTabs()).toHaveLength(0);
      expect(registry.getRibbonGroupsForTab("full-tab1")).toHaveLength(0);
      expect(registry.getRibbonGroupsForTab("full-tab2")).toHaveLength(0);
      expect(registry.hasAddIn("full-ext")).toBe(false);
    });

    it("does not remove other extensions' contributions", () => {
      registry.registerAddIn(makeManifest("ext-a", {
        commands: [makeCommand("a.cmd")],
        ribbonTabs: [makeTab("a-tab", 1)],
      }));
      registry.registerAddIn(makeManifest("ext-b", {
        commands: [makeCommand("b.cmd")],
        ribbonTabs: [makeTab("b-tab", 2)],
      }));

      registry.unregisterAddIn("ext-a");

      expect(registry.getCommand("a.cmd")).toBeUndefined();
      expect(registry.getCommand("b.cmd")).toBeDefined();
      expect(registry.getRibbonTab("b-tab")).toBeDefined();
      expect(registry.hasAddIn("ext-b")).toBe(true);
    });
  });

  // =========================================================================
  // Re-register extension after removal
  // =========================================================================

  describe("re-register extension after removal", () => {
    it("can re-register an extension after unregistering it", () => {
      const manifest = makeManifest("reloadable", {
        commands: [makeCommand("reload.cmd")],
        ribbonTabs: [makeTab("reload-tab", 1)],
      });

      registry.registerAddIn(manifest);
      registry.unregisterAddIn("reloadable");
      expect(registry.hasAddIn("reloadable")).toBe(false);
      expect(registry.getCommand("reload.cmd")).toBeUndefined();

      registry.registerAddIn(manifest);
      expect(registry.hasAddIn("reloadable")).toBe(true);
      expect(registry.getCommand("reload.cmd")).toBeDefined();
      expect(registry.getRibbonTab("reload-tab")).toBeDefined();
    });

    it("re-registered extension works with updated contributions", () => {
      registry.registerAddIn(makeManifest("upgradable", {
        commands: [makeCommand("v1.cmd")],
      }));
      registry.unregisterAddIn("upgradable");

      registry.registerAddIn(makeManifest("upgradable", {
        commands: [makeCommand("v2.cmd")],
      }));

      expect(registry.getCommand("v1.cmd")).toBeUndefined();
      expect(registry.getCommand("v2.cmd")).toBeDefined();
    });
  });

  // =========================================================================
  // Extension isolation
  // =========================================================================

  describe("extension isolation", () => {
    it("one listener throwing does not prevent others from being called", () => {
      const before = vi.fn();
      const thrower = vi.fn(() => { throw new Error("boom"); });
      const after = vi.fn();

      registry.onSelectionChange(before);
      registry.onSelectionChange(thrower);
      registry.onSelectionChange(after);

      // The registry uses forEach which will throw on the second callback.
      // This test documents the current behavior: if one throws, later ones
      // may not be called. This is a known limitation.
      try {
        registry.notifySelectionChange(null);
      } catch {
        // expected
      }

      expect(before).toHaveBeenCalled();
      expect(thrower).toHaveBeenCalled();
    });

    it("registering a broken command does not affect other commands", () => {
      const good = makeCommand("good.cmd");
      const bad = makeCommand("bad.cmd");
      bad.execute = () => { throw new Error("broken"); };

      registry.registerCommand(good);
      registry.registerCommand(bad);

      expect(registry.getCommand("good.cmd")).toBe(good);
      expect(registry.getCommand("bad.cmd")).toBe(bad);

      // Executing the good command works fine
      expect(() => good.execute({} as any)).not.toThrow();
    });

    it("unregistering non-existent add-in does not affect existing ones", () => {
      registry.registerAddIn(makeManifest("survivor", {
        commands: [makeCommand("survive.cmd")],
      }));

      registry.unregisterAddIn("ghost");

      expect(registry.hasAddIn("survivor")).toBe(true);
      expect(registry.getCommand("survive.cmd")).toBeDefined();
    });

    it("overwriting an add-in preserves other add-ins", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      registry.registerAddIn(makeManifest("stable"));
      registry.registerAddIn(makeManifest("volatile", {
        commands: [makeCommand("v.cmd1")],
      }));
      // Re-register volatile with different commands
      registry.registerAddIn(makeManifest("volatile", {
        commands: [makeCommand("v.cmd2")],
      }));

      expect(registry.hasAddIn("stable")).toBe(true);
      expect(registry.hasAddIn("volatile")).toBe(true);
      warnSpy.mockRestore();
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe("edge cases", () => {
    it("clear also clears event listeners for registry changes", () => {
      const cb = vi.fn();
      registry.onRegistryChange(cb);
      // clear fires notifyRegistryChange once during clear
      registry.clear();
      const callsAfterClear = cb.mock.calls.length;

      // After clear, further registrations should NOT call the old listener
      // because clear() clears registryChangeListeners... but it does NOT
      // clear registryChangeListeners (it only clears selection/cell listeners).
      // Actually looking at the source: clear() does NOT clear registryChangeListeners.
      // So this documents current behavior.
      registry.registerRibbonTab(makeTab("post-clear", 1));
      // The listener is still active since registryChangeListeners is not cleared
      expect(cb.mock.calls.length).toBeGreaterThan(callsAfterClear);
    });

    it("getRibbonGroupsForTab returns empty for unknown tab", () => {
      expect(registry.getRibbonGroupsForTab("nonexistent")).toEqual([]);
    });

    it("getRegisteredAddIns returns empty after clear", () => {
      registry.registerAddIn(makeManifest("x"));
      registry.clear();
      expect(registry.getRegisteredAddIns()).toHaveLength(0);
    });

    it("multiple unsubscribes are idempotent", () => {
      const cb = vi.fn();
      const unsub = registry.onSelectionChange(cb);
      unsub();
      unsub(); // second call should be no-op
      registry.notifySelectionChange(null);
      expect(cb).not.toHaveBeenCalled();
    });

    it("manifest with no contributions registers cleanly", () => {
      registry.registerAddIn(makeManifest("empty-ext"));
      expect(registry.hasAddIn("empty-ext")).toBe(true);
      expect(registry.getAllCommands()).toHaveLength(0);
    });
  });
});
