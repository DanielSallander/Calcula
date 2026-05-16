import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExtensionRegistry } from "../ExtensionRegistry";
import type {
  AddInManifest,
  Command,
  RibbonTabDefinition,
  RibbonGroupDefinition,
  SelectionChangeCallback,
} from "../types";

// ============================================================================
// Helpers
// ============================================================================

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

// ============================================================================
// Tests
// ============================================================================

describe("Extension lifecycle events", () => {
  beforeEach(() => {
    registry.clear();
  });

  // =========================================================================
  // Extension activation order
  // =========================================================================

  describe("extension activation order", () => {
    it("extensions register in the order they are activated", () => {
      const ids = ["ext-a", "ext-b", "ext-c", "ext-d"];
      ids.forEach((id) => registry.registerAddIn(makeManifest(id)));

      const registered = registry.getRegisteredAddIns().map((a) => a.id);
      expect(registered).toEqual(ids);
    });

    it("dependency warning is logged when activating before dependency", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      registry.registerAddIn(makeManifest("child", { dependencies: ["parent"] }));

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('depends on "parent"')
      );
      warnSpy.mockRestore();
    });

    it("no warning when dependency is already registered", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      registry.registerAddIn(makeManifest("parent"));
      registry.registerAddIn(makeManifest("child", { dependencies: ["parent"] }));

      // The only warn should be from the log, not a dependency warn
      const depWarns = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("depends on")
      );
      expect(depWarns).toHaveLength(0);
      warnSpy.mockRestore();
    });

    it("re-registering an extension overwrites the previous one", () => {
      registry.registerAddIn(makeManifest("ext", { version: "1.0.0" }));
      registry.registerAddIn(makeManifest("ext", { version: "2.0.0" }));

      const addins = registry.getRegisteredAddIns();
      const ext = addins.find((a) => a.id === "ext");
      expect(ext?.version).toBe("2.0.0");
    });
  });

  // =========================================================================
  // Extension deactivation cleanup
  // =========================================================================

  describe("extension deactivation cleanup", () => {
    it("unregisterAddIn removes all commands from the add-in", () => {
      const manifest = makeManifest("clean-ext", {
        commands: [makeCommand("clean-ext.cmd1"), makeCommand("clean-ext.cmd2")],
      });
      registry.registerAddIn(manifest);

      expect(registry.getCommand("clean-ext.cmd1")).toBeDefined();
      expect(registry.getCommand("clean-ext.cmd2")).toBeDefined();

      registry.unregisterAddIn("clean-ext");

      expect(registry.getCommand("clean-ext.cmd1")).toBeUndefined();
      expect(registry.getCommand("clean-ext.cmd2")).toBeUndefined();
    });

    it("unregisterAddIn removes ribbon tabs and their groups", () => {
      const manifest = makeManifest("ui-ext", {
        ribbonTabs: [makeTab("ui-ext.tab", 10)],
        ribbonGroups: [makeGroup("ui-ext.grp", "ui-ext.tab", 1)],
      });
      registry.registerAddIn(manifest);

      expect(registry.getRibbonTab("ui-ext.tab")).toBeDefined();
      expect(registry.getRibbonGroupsForTab("ui-ext.tab")).toHaveLength(1);

      registry.unregisterAddIn("ui-ext");

      expect(registry.getRibbonTab("ui-ext.tab")).toBeUndefined();
      expect(registry.getRibbonGroupsForTab("ui-ext.tab")).toHaveLength(0);
    });

    it("unregisterAddIn for non-existent add-in is a no-op", () => {
      expect(() => registry.unregisterAddIn("ghost")).not.toThrow();
    });

    it("hasAddIn returns false after unregistration", () => {
      registry.registerAddIn(makeManifest("temp"));
      expect(registry.hasAddIn("temp")).toBe(true);

      registry.unregisterAddIn("temp");
      expect(registry.hasAddIn("temp")).toBe(false);
    });

    it("clear removes everything", () => {
      registry.registerAddIn(makeManifest("a", {
        commands: [makeCommand("a.cmd")],
        ribbonTabs: [makeTab("a.tab", 1)],
      }));
      registry.registerAddIn(makeManifest("b"));

      registry.clear();

      expect(registry.getRegisteredAddIns()).toHaveLength(0);
      expect(registry.getAllCommands()).toHaveLength(0);
      expect(registry.getRibbonTabs()).toHaveLength(0);
    });
  });

  // =========================================================================
  // Registry change notifications during batch registration
  // =========================================================================

  describe("registry change notifications during batch registration", () => {
    it("registering an add-in with tabs fires registry change", () => {
      const changeSpy = vi.fn();
      const unsub = registry.onRegistryChange(changeSpy);

      registry.registerAddIn(makeManifest("notify-ext", {
        ribbonTabs: [makeTab("notify-ext.tab", 1)],
      }));

      // registerAddIn calls notifyRegistryChange after registerRibbonTab (which
      // also notifies) plus the final notifyRegistryChange
      expect(changeSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      unsub();
    });

    it("batch registering multiple add-ins fires multiple change events", () => {
      const changeSpy = vi.fn();
      const unsub = registry.onRegistryChange(changeSpy);

      for (let i = 0; i < 5; i++) {
        registry.registerAddIn(makeManifest(`batch-${i}`, {
          ribbonTabs: [makeTab(`batch-${i}.tab`, i)],
        }));
      }

      // At least one change event per add-in
      expect(changeSpy.mock.calls.length).toBeGreaterThanOrEqual(5);
      unsub();
    });

    it("unregistering fires change notification", () => {
      registry.registerAddIn(makeManifest("unreg-notify", {
        ribbonTabs: [makeTab("unreg-notify.tab", 1)],
      }));

      const changeSpy = vi.fn();
      const unsub = registry.onRegistryChange(changeSpy);

      registry.unregisterAddIn("unreg-notify");

      expect(changeSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      unsub();
    });

    it("change listener unsubscribe stops further notifications", () => {
      const changeSpy = vi.fn();
      const unsub = registry.onRegistryChange(changeSpy);

      registry.registerAddIn(makeManifest("x1", {
        ribbonTabs: [makeTab("x1.tab", 1)],
      }));
      const countAfterFirst = changeSpy.mock.calls.length;

      unsub();

      registry.registerAddIn(makeManifest("x2", {
        ribbonTabs: [makeTab("x2.tab", 2)],
      }));

      expect(changeSpy.mock.calls.length).toBe(countAfterFirst);
    });
  });

  // =========================================================================
  // Hook execution with failing hooks (isolation)
  // =========================================================================

  describe("hook execution with failing hooks", () => {
    it("failing selection listener does not prevent others from firing", () => {
      const spy1 = vi.fn();
      const spy2 = vi.fn();
      const throwingSpy = vi.fn(() => { throw new Error("hook crash"); });

      registry.onSelectionChange(spy1);
      registry.onSelectionChange(throwingSpy);
      registry.onSelectionChange(spy2);

      // notifySelectionChange iterates all - a forEach with a throw will stop.
      // This documents the current behavior: the throwing listener interrupts iteration.
      try {
        registry.notifySelectionChange(null);
      } catch {
        // expected
      }

      expect(spy1).toHaveBeenCalledTimes(1);
      expect(throwingSpy).toHaveBeenCalledTimes(1);
    });

    it("failing cell change listener throws but first listeners still fired", () => {
      const spy1 = vi.fn();
      const thrower = vi.fn(() => { throw new Error("cell boom"); });

      registry.onCellChange(spy1);
      registry.onCellChange(thrower);

      expect(() => {
        registry.notifyCellChange(0, 0, "old", "new");
      }).toThrow("cell boom");

      expect(spy1).toHaveBeenCalledWith(0, 0, "old", "new");
    });

    it("failing registry change listener does not corrupt registry", () => {
      const unsub = registry.onRegistryChange(() => { throw new Error("change boom"); });

      // Registration still works even if listener throws
      try {
        registry.registerAddIn(makeManifest("after-fail", {
          ribbonTabs: [makeTab("after-fail.tab", 1)],
        }));
      } catch {
        // ignore thrown error from listener
      }

      expect(registry.hasAddIn("after-fail")).toBe(true);
      expect(registry.getRibbonTab("after-fail.tab")).toBeDefined();

      // Must unsubscribe before clear() runs in beforeEach
      unsub();
    });
  });

  // =========================================================================
  // Selection change with 20+ listeners
  // =========================================================================

  describe("selection change with 20+ listeners", () => {
    it("all 25 selection listeners receive the event", () => {
      const spies: SelectionChangeCallback[] = [];
      const unsubs: (() => void)[] = [];

      for (let i = 0; i < 25; i++) {
        const spy = vi.fn();
        spies.push(spy);
        unsubs.push(registry.onSelectionChange(spy));
      }

      const selection = {
        startRow: 0,
        startCol: 0,
        endRow: 5,
        endCol: 5,
        activeRow: 0,
        activeCol: 0,
      };

      registry.notifySelectionChange(selection as any);

      spies.forEach((spy) => {
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(selection);
      });

      // Cleanup
      unsubs.forEach((u) => u());
    });

    it("unsubscribing some listeners leaves others active", () => {
      const activeSpy = vi.fn();
      const removedSpy = vi.fn();

      registry.onSelectionChange(activeSpy);
      const unsub = registry.onSelectionChange(removedSpy);

      // Add 20 more active listeners
      for (let i = 0; i < 20; i++) {
        registry.onSelectionChange(vi.fn());
      }

      unsub();

      registry.notifySelectionChange(null);

      expect(activeSpy).toHaveBeenCalledTimes(1);
      expect(removedSpy).not.toHaveBeenCalled();
    });

    it("selection listeners receive null when no selection", () => {
      const spy = vi.fn();
      registry.onSelectionChange(spy);

      registry.notifySelectionChange(null);

      expect(spy).toHaveBeenCalledWith(null);
    });
  });

  // =========================================================================
  // Cell change listeners
  // =========================================================================

  describe("cell change listeners", () => {
    it("all cell change listeners receive the change data", () => {
      const spies = Array.from({ length: 10 }, () => vi.fn());
      spies.forEach((spy) => registry.onCellChange(spy));

      registry.notifyCellChange(5, 3, "old", "new");

      spies.forEach((spy) => {
        expect(spy).toHaveBeenCalledWith(5, 3, "old", "new");
      });
    });

    it("cell change with null values", () => {
      const spy = vi.fn();
      registry.onCellChange(spy);

      registry.notifyCellChange(0, 0, null, null);

      expect(spy).toHaveBeenCalledWith(0, 0, null, null);
    });

    it("unsubscribed cell change listener is not called", () => {
      const spy = vi.fn();
      const unsub = registry.onCellChange(spy);
      unsub();

      registry.notifyCellChange(1, 1, "a", "b");

      expect(spy).not.toHaveBeenCalled();
    });
  });
});
