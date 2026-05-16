//! FILENAME: app/extensions/ScriptEditor/lib/__tests__/module-workflows.test.ts
// PURPOSE: Workflow-level tests for the ScriptEditor module store.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the scriptApi module
const mockListScripts = vi.fn();
const mockGetScript = vi.fn();
const mockSaveScript = vi.fn();
const mockDeleteScript = vi.fn();
const mockRenameScript = vi.fn();

vi.mock("../scriptApi", () => ({
  listScripts: (...args: unknown[]) => mockListScripts(...args),
  getScript: (...args: unknown[]) => mockGetScript(...args),
  saveScript: (...args: unknown[]) => mockSaveScript(...args),
  deleteScript: (...args: unknown[]) => mockDeleteScript(...args),
  renameScript: (...args: unknown[]) => mockRenameScript(...args),
}));

vi.mock("@api/backend", () => ({
  invokeBackend: vi.fn(),
}));

import { useModuleStore } from "../useModuleStore";

describe("module workflows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useModuleStore.setState({
      modules: [],
      activeModuleId: null,
      dirtyModuleIds: [],
      loaded: false,
      navPaneVisible: true,
    });
  });

  // =========================================================================
  // Full workflow: create module, write code, save, rename, duplicate
  // =========================================================================

  describe("full workflow: create -> write -> save -> rename -> duplicate", () => {
    it("performs the complete module lifecycle", async () => {
      mockSaveScript.mockResolvedValue(undefined);
      mockRenameScript.mockResolvedValue(undefined);

      // Step 1: Create
      const id = await useModuleStore.getState().createModule();
      expect(id).toBeTruthy();
      expect(useModuleStore.getState().modules).toHaveLength(1);
      expect(useModuleStore.getState().activeModuleId).toBe(id);

      // Step 2: Mark dirty (simulating user typing)
      useModuleStore.getState().markDirty(id!);
      expect(useModuleStore.getState().dirtyModuleIds).toContain(id);

      // Step 3: Save
      await useModuleStore.getState().saveModule(id!, "function hello() { return 42; }");
      expect(useModuleStore.getState().dirtyModuleIds).not.toContain(id);
      expect(mockSaveScript).toHaveBeenCalledWith(
        expect.objectContaining({ id, source: "function hello() { return 42; }" }),
      );

      // Step 4: Rename
      await useModuleStore.getState().renameModule(id!, "UtilityModule");
      expect(useModuleStore.getState().modules[0].name).toBe("UtilityModule");

      // Step 5: Duplicate
      mockGetScript.mockResolvedValue({
        id,
        name: "UtilityModule",
        source: "function hello() { return 42; }",
        description: "",
      });
      await useModuleStore.getState().duplicateModule(id!);
      expect(useModuleStore.getState().modules).toHaveLength(2);
      expect(useModuleStore.getState().modules[1].name).toBe("UtilityModule (Copy)");
    });
  });

  // =========================================================================
  // 20+ modules management
  // =========================================================================

  describe("20+ modules management", () => {
    it("handles creating and managing 25 modules", async () => {
      mockSaveScript.mockResolvedValue(undefined);

      for (let i = 0; i < 25; i++) {
        await useModuleStore.getState().createModule();
      }

      expect(useModuleStore.getState().modules).toHaveLength(25);

      // All modules have unique IDs
      const ids = useModuleStore.getState().modules.map((m) => m.id);
      expect(new Set(ids).size).toBe(25);

      // Active module is the last created one
      const lastId = ids[ids.length - 1];
      expect(useModuleStore.getState().activeModuleId).toBe(lastId);
    });

    it("loads 20+ existing modules from backend", async () => {
      const modules = Array.from({ length: 22 }, (_, i) => ({
        id: `mod-${i}`,
        name: `Module${i + 1}`,
      }));
      mockListScripts.mockResolvedValue(modules);

      await useModuleStore.getState().loadModules();

      expect(useModuleStore.getState().modules).toHaveLength(22);
      expect(useModuleStore.getState().activeModuleId).toBe("mod-0");
      expect(useModuleStore.getState().loaded).toBe(true);
    });

    it("can delete modules down from 20+ while switching active correctly", async () => {
      mockSaveScript.mockResolvedValue(undefined);
      mockDeleteScript.mockResolvedValue(undefined);

      // Start with 5 modules
      const modules = Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        name: `Module${i + 1}`,
      }));
      useModuleStore.setState({ modules, activeModuleId: "m0" });

      // Delete m0 (active) - should switch to next
      await useModuleStore.getState().removeModule("m0");
      expect(useModuleStore.getState().modules).toHaveLength(4);
      expect(useModuleStore.getState().activeModuleId).toBe("m1");

      // Delete m4 (not active) - active stays
      await useModuleStore.getState().removeModule("m4");
      expect(useModuleStore.getState().modules).toHaveLength(3);
      expect(useModuleStore.getState().activeModuleId).toBe("m1");
    });
  });

  // =========================================================================
  // Module naming conflicts
  // =========================================================================

  describe("module naming conflicts", () => {
    it("auto-increment skips existing numbers", async () => {
      mockSaveScript.mockResolvedValue(undefined);

      useModuleStore.setState({
        modules: [
          { id: "a", name: "Module1" },
          { id: "b", name: "Module2" },
          { id: "c", name: "Module3" },
        ],
      });

      await useModuleStore.getState().createModule();
      const newest = useModuleStore.getState().modules[3];
      // Should be Module4 (next after highest existing)
      expect(newest.name).toBe("Module4");
    });

    it("handles gaps in numbering", async () => {
      mockSaveScript.mockResolvedValue(undefined);

      useModuleStore.setState({
        modules: [
          { id: "a", name: "Module1" },
          { id: "b", name: "Module10" },
        ],
      });

      await useModuleStore.getState().createModule();
      const newest = useModuleStore.getState().modules[2];
      // Auto-increment picks max+1
      expect(newest.name).toBe("Module11");
    });

    it("rename to empty string is rejected", async () => {
      useModuleStore.setState({ modules: [{ id: "m1", name: "Original" }] });

      await useModuleStore.getState().renameModule("m1", "");
      expect(useModuleStore.getState().modules[0].name).toBe("Original");
      expect(mockRenameScript).not.toHaveBeenCalled();
    });

    it("rename trims and allows valid new name", async () => {
      mockRenameScript.mockResolvedValue(undefined);
      useModuleStore.setState({ modules: [{ id: "m1", name: "Old" }] });

      await useModuleStore.getState().renameModule("m1", "  NewName  ");
      expect(useModuleStore.getState().modules[0].name).toBe("NewName");
    });

    it("duplicate appends (Copy) suffix", async () => {
      mockSaveScript.mockResolvedValue(undefined);
      mockGetScript.mockResolvedValue({
        id: "m1",
        name: "MyModule",
        source: "code",
        description: "",
      });
      useModuleStore.setState({ modules: [{ id: "m1", name: "MyModule" }] });

      await useModuleStore.getState().duplicateModule("m1");

      const names = useModuleStore.getState().modules.map((m) => m.name);
      expect(names).toContain("MyModule");
      expect(names).toContain("MyModule (Copy)");
    });
  });

  // =========================================================================
  // Dirty state tracking across multiple modules
  // =========================================================================

  describe("dirty state tracking across multiple modules", () => {
    it("tracks dirty state independently for each module", () => {
      useModuleStore.setState({
        modules: [
          { id: "m1", name: "A" },
          { id: "m2", name: "B" },
          { id: "m3", name: "C" },
        ],
      });

      useModuleStore.getState().markDirty("m1");
      useModuleStore.getState().markDirty("m3");

      const dirty = useModuleStore.getState().dirtyModuleIds;
      expect(dirty).toContain("m1");
      expect(dirty).not.toContain("m2");
      expect(dirty).toContain("m3");
    });

    it("saving one module only cleans that module", async () => {
      mockSaveScript.mockResolvedValue(undefined);
      useModuleStore.setState({
        modules: [
          { id: "m1", name: "A" },
          { id: "m2", name: "B" },
        ],
        dirtyModuleIds: ["m1", "m2"],
      });

      await useModuleStore.getState().saveModule("m1", "saved code");

      const dirty = useModuleStore.getState().dirtyModuleIds;
      expect(dirty).not.toContain("m1");
      expect(dirty).toContain("m2");
    });

    it("deleting a dirty module removes it from dirty list", async () => {
      mockDeleteScript.mockResolvedValue(undefined);
      useModuleStore.setState({
        modules: [
          { id: "m1", name: "A" },
          { id: "m2", name: "B" },
        ],
        activeModuleId: "m2",
        dirtyModuleIds: ["m1"],
      });

      await useModuleStore.getState().removeModule("m1");

      expect(useModuleStore.getState().dirtyModuleIds).not.toContain("m1");
    });

    it("marking dirty multiple times does not duplicate", () => {
      useModuleStore.getState().markDirty("m1");
      useModuleStore.getState().markDirty("m1");
      useModuleStore.getState().markDirty("m1");

      expect(
        useModuleStore.getState().dirtyModuleIds.filter((d) => d === "m1"),
      ).toHaveLength(1);
    });

    it("markClean on non-dirty module is safe", () => {
      useModuleStore.setState({ dirtyModuleIds: ["m2"] });
      useModuleStore.getState().markClean("m99");
      expect(useModuleStore.getState().dirtyModuleIds).toEqual(["m2"]);
    });

    it("all modules can be dirty simultaneously", () => {
      const ids = Array.from({ length: 10 }, (_, i) => `m${i}`);
      useModuleStore.setState({
        modules: ids.map((id) => ({ id, name: id })),
      });

      for (const id of ids) {
        useModuleStore.getState().markDirty(id);
      }

      expect(useModuleStore.getState().dirtyModuleIds).toHaveLength(10);
    });

    it("saving all dirty modules clears dirty list", async () => {
      mockSaveScript.mockResolvedValue(undefined);
      useModuleStore.setState({
        modules: [
          { id: "m1", name: "A" },
          { id: "m2", name: "B" },
          { id: "m3", name: "C" },
        ],
        dirtyModuleIds: ["m1", "m2", "m3"],
      });

      await useModuleStore.getState().saveModule("m1", "code1");
      await useModuleStore.getState().saveModule("m2", "code2");
      await useModuleStore.getState().saveModule("m3", "code3");

      expect(useModuleStore.getState().dirtyModuleIds).toHaveLength(0);
    });
  });

  // =========================================================================
  // Module selection
  // =========================================================================

  describe("module selection across operations", () => {
    it("creating a new module always selects it", async () => {
      mockSaveScript.mockResolvedValue(undefined);
      useModuleStore.setState({
        modules: [{ id: "m1", name: "First" }],
        activeModuleId: "m1",
      });

      const newId = await useModuleStore.getState().createModule();
      expect(useModuleStore.getState().activeModuleId).toBe(newId);
    });

    it("selectModule changes active without side effects", () => {
      useModuleStore.setState({
        modules: [
          { id: "m1", name: "A" },
          { id: "m2", name: "B" },
        ],
        activeModuleId: "m1",
        dirtyModuleIds: ["m1"],
      });

      useModuleStore.getState().selectModule("m2");

      expect(useModuleStore.getState().activeModuleId).toBe("m2");
      // Dirty state unchanged
      expect(useModuleStore.getState().dirtyModuleIds).toContain("m1");
    });
  });
});
