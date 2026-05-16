import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExtensionRegistry } from "../ExtensionRegistry";
import type {
  AddInManifest,
  Command,
  RibbonTabDefinition,
  RibbonGroupDefinition,
} from "../types";

// ============================================================================
// Helpers
// ============================================================================

const registry = ExtensionRegistry;

function makeCommand(id: string, shortcut?: string): Command {
  return {
    id,
    name: `Command ${id}`,
    shortcut,
    execute: vi.fn(),
  };
}

function makeTab(id: string, order: number, color?: string): RibbonTabDefinition {
  return {
    id,
    label: `Tab ${id}`,
    order,
    color,
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

function makeManifest(
  id: string,
  opts: {
    commands?: Command[];
    ribbonTabs?: RibbonTabDefinition[];
    ribbonGroups?: RibbonGroupDefinition[];
    dependencies?: string[];
  } = {}
): AddInManifest {
  return {
    id,
    name: `Extension ${id}`,
    version: "1.0.0",
    ...opts,
  };
}

beforeEach(() => {
  registry.clear();
});

// ============================================================================
// 1. Command Registration - 100 command IDs via it.each
// ============================================================================

describe("Command registration (parameterized)", () => {
  const commandIds = Array.from({ length: 100 }, (_, i) => {
    const prefixes = [
      "ext.format",
      "ext.edit",
      "ext.view",
      "ext.data",
      "ext.tools",
      "ext.insert",
      "ext.help",
      "ext.nav",
      "ext.debug",
      "ext.custom",
    ];
    const prefix = prefixes[i % prefixes.length];
    return [`${prefix}.cmd${i}`] as const;
  });

  describe("register and retrieve", () => {
    it.each(commandIds)("registers command %s", (id) => {
      const cmd = makeCommand(id);
      registry.registerCommand(cmd);
      expect(registry.getCommand(id)).toBeDefined();
      expect(registry.getCommand(id)!.id).toBe(id);
    });
  });

  describe("has after register", () => {
    it.each(commandIds)("getCommand returns defined for %s", (id) => {
      registry.registerCommand(makeCommand(id));
      expect(registry.getCommand(id)).toBeDefined();
    });
  });

  describe("execute", () => {
    it.each(commandIds)("executes handler for %s", (id) => {
      const cmd = makeCommand(id);
      registry.registerCommand(cmd);
      const retrieved = registry.getCommand(id)!;
      retrieved.execute({} as never);
      expect(cmd.execute).toHaveBeenCalled();
    });
  });

  describe("getAllCommands includes registered", () => {
    it.each(commandIds)("getAllCommands includes %s", (id) => {
      registry.registerCommand(makeCommand(id));
      const all = registry.getAllCommands();
      expect(all.some((c) => c.id === id)).toBe(true);
    });
  });
});

// ============================================================================
// 2. Ribbon Tab Registration - 30 tabs with various orders/groups
// ============================================================================

describe("Ribbon tab registration (parameterized)", () => {
  const tabCases = Array.from({ length: 30 }, (_, i) => ({
    id: `tab-${i}`,
    order: (i * 7 + 3) % 100, // pseudo-random ordering
    groupCount: (i % 5) + 1,
    color: i % 3 === 0 ? `#${(i * 111111).toString(16).slice(0, 6)}` : undefined,
  }));

  describe("register and retrieve tabs", () => {
    it.each(tabCases)("registers tab $id with order $order", ({ id, order, color }) => {
      registry.registerRibbonTab(makeTab(id, order, color));
      const tab = registry.getRibbonTab(id);
      expect(tab).toBeDefined();
      expect(tab!.order).toBe(order);
      if (color) expect(tab!.color).toBe(color);
    });
  });

  describe("tabs sorted by order", () => {
    it.each(tabCases)("tab $id appears in correct sorted position", ({ id, order, color }) => {
      // Register this tab plus a few extras
      registry.registerRibbonTab(makeTab(id, order, color));
      registry.registerRibbonTab(makeTab(`${id}-before`, order - 1));
      registry.registerRibbonTab(makeTab(`${id}-after`, order + 1));

      const tabs = registry.getRibbonTabs();
      const orders = tabs.map((t) => t.order);
      for (let j = 1; j < orders.length; j++) {
        expect(orders[j]).toBeGreaterThanOrEqual(orders[j - 1]);
      }
    });
  });

  describe("groups for tab", () => {
    it.each(tabCases)("tab $id gets $groupCount groups", ({ id, order, groupCount }) => {
      registry.registerRibbonTab(makeTab(id, order));
      for (let g = 0; g < groupCount; g++) {
        registry.registerRibbonGroup(makeGroup(`${id}-grp-${g}`, id, g * 10));
      }
      const groups = registry.getRibbonGroupsForTab(id);
      expect(groups).toHaveLength(groupCount);
      // Check sorted
      for (let g = 1; g < groups.length; g++) {
        expect(groups[g].order).toBeGreaterThanOrEqual(groups[g - 1].order);
      }
    });
  });

  describe("unregister tab removes groups", () => {
    it.each(tabCases.slice(0, 15))(
      "unregistering tab $id removes its groups",
      ({ id, order, groupCount }) => {
        registry.registerRibbonTab(makeTab(id, order));
        for (let g = 0; g < groupCount; g++) {
          registry.registerRibbonGroup(makeGroup(`${id}-grp-${g}`, id, g));
        }
        registry.unregisterRibbonTab(id);
        expect(registry.getRibbonTab(id)).toBeUndefined();
        expect(registry.getRibbonGroupsForTab(id)).toHaveLength(0);
      }
    );
  });
});

// ============================================================================
// 3. Extension Lifecycle - 20 extension manifests via it.each
// ============================================================================

describe("Extension lifecycle (parameterized)", () => {
  const manifests = Array.from({ length: 20 }, (_, i) => ({
    id: `ext-${i}`,
    cmdCount: (i % 4) + 1,
    tabCount: i % 3,
    groupCount: i % 2,
    hasDeps: i >= 15,
    depId: i >= 15 ? `ext-${i - 1}` : undefined,
  }));

  describe("activate (registerAddIn)", () => {
    it.each(manifests)(
      "registers add-in $id with $cmdCount commands, $tabCount tabs",
      ({ id, cmdCount, tabCount, groupCount }) => {
        const commands = Array.from({ length: cmdCount }, (_, j) =>
          makeCommand(`${id}.cmd.${j}`)
        );
        const ribbonTabs = Array.from({ length: tabCount }, (_, j) =>
          makeTab(`${id}.tab.${j}`, j * 10)
        );
        const ribbonGroups = Array.from({ length: groupCount }, (_, j) =>
          makeGroup(`${id}.grp.${j}`, ribbonTabs[0]?.id ?? "orphan", j)
        );

        const manifest = makeManifest(id, { commands, ribbonTabs, ribbonGroups });
        registry.registerAddIn(manifest);

        expect(registry.hasAddIn(id)).toBe(true);
        for (const cmd of commands) {
          expect(registry.getCommand(cmd.id)).toBeDefined();
        }
      }
    );
  });

  describe("deactivate (unregisterAddIn)", () => {
    it.each(manifests)(
      "unregisters add-in $id and cleans up contributions",
      ({ id, cmdCount, tabCount }) => {
        const commands = Array.from({ length: cmdCount }, (_, j) =>
          makeCommand(`${id}.cmd.${j}`)
        );
        const ribbonTabs = Array.from({ length: tabCount }, (_, j) =>
          makeTab(`${id}.tab.${j}`, j * 10)
        );

        registry.registerAddIn(makeManifest(id, { commands, ribbonTabs }));
        registry.unregisterAddIn(id);

        expect(registry.hasAddIn(id)).toBe(false);
        for (const cmd of commands) {
          expect(registry.getCommand(cmd.id)).toBeUndefined();
        }
        for (const tab of ribbonTabs) {
          expect(registry.getRibbonTab(tab.id)).toBeUndefined();
        }
      }
    );
  });

  describe("contribute (commands accessible after registration)", () => {
    it.each(manifests)(
      "add-in $id contributes $cmdCount executable commands",
      ({ id, cmdCount }) => {
        const commands = Array.from({ length: cmdCount }, (_, j) =>
          makeCommand(`${id}.cmd.${j}`)
        );
        registry.registerAddIn(makeManifest(id, { commands }));

        const allCmds = registry.getAllCommands();
        for (const cmd of commands) {
          const found = allCmds.find((c) => c.id === cmd.id);
          expect(found).toBeDefined();
          found!.execute({} as never);
          expect(cmd.execute).toHaveBeenCalled();
        }
      }
    );
  });

  describe("dependencies", () => {
    it.each(manifests.filter((m) => m.hasDeps))(
      "add-in $id warns when dependency $depId is missing",
      ({ id, depId }) => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        registry.registerAddIn(makeManifest(id, { dependencies: [depId!] }));
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(depId!)
        );
        warnSpy.mockRestore();
      }
    );
  });
});

// ============================================================================
// 4. Hook Execution - 30 hook combos
// ============================================================================

describe("Hook execution (parameterized)", () => {
  const selectionCases = Array.from({ length: 10 }, (_, i) => ({
    label: `selection-${i}`,
    selection: i % 2 === 0
      ? { startRow: i, startCol: i + 1, endRow: i + 5, endCol: i + 3 }
      : null,
  }));

  const cellChangeCases = Array.from({ length: 10 }, (_, i) => ({
    label: `cell-change-${i}`,
    row: i * 3,
    col: i * 2,
    oldValue: i % 3 === 0 ? null : `old-${i}`,
    newValue: i % 4 === 0 ? null : `new-${i}`,
  }));

  const registryChangeCases = Array.from({ length: 10 }, (_, i) => ({
    label: `registry-change-${i}`,
    tabId: `trigger-tab-${i}`,
    order: i * 5,
  }));

  describe("selection change hooks", () => {
    it.each(selectionCases)(
      "fires callback for $label",
      ({ selection }) => {
        const cb = vi.fn();
        const cleanup = registry.onSelectionChange(cb);

        registry.notifySelectionChange(selection as never);
        expect(cb).toHaveBeenCalledWith(selection);

        cleanup();
        registry.notifySelectionChange(selection as never);
        expect(cb).toHaveBeenCalledTimes(1);
      }
    );
  });

  describe("cell change hooks", () => {
    it.each(cellChangeCases)(
      "fires callback for $label (row=$row, col=$col)",
      ({ row, col, oldValue, newValue }) => {
        const cb = vi.fn();
        const cleanup = registry.onCellChange(cb);

        registry.notifyCellChange(row, col, oldValue, newValue);
        expect(cb).toHaveBeenCalledWith(row, col, oldValue, newValue);

        cleanup();
        registry.notifyCellChange(row, col, oldValue, newValue);
        expect(cb).toHaveBeenCalledTimes(1);
      }
    );
  });

  describe("registry change hooks", () => {
    it.each(registryChangeCases)(
      "fires callback for $label when tab $tabId registered",
      ({ tabId, order }) => {
        const cb = vi.fn();
        const cleanup = registry.onRegistryChange(cb);

        registry.registerRibbonTab(makeTab(tabId, order));
        expect(cb).toHaveBeenCalled();

        const countBefore = cb.mock.calls.length;
        cleanup();
        registry.registerRibbonTab(makeTab(`${tabId}-extra`, order + 1));
        expect(cb).toHaveBeenCalledTimes(countBefore);
      }
    );
  });
});
