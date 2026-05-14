//! FILENAME: app/extensions/ScriptEditor/lib/__tests__/useModuleStore.test.ts
// PURPOSE: Tests for the ScriptEditor module Zustand store.

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

describe("useModuleStore", () => {
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
  // Initial state
  // =========================================================================

  it("has correct initial state", () => {
    const state = useModuleStore.getState();
    expect(state.modules).toEqual([]);
    expect(state.activeModuleId).toBeNull();
    expect(state.dirtyModuleIds).toEqual([]);
    expect(state.loaded).toBe(false);
    expect(state.navPaneVisible).toBe(true);
  });

  // =========================================================================
  // loadModules
  // =========================================================================

  describe("loadModules", () => {
    it("creates a default module when none exist", async () => {
      mockListScripts.mockResolvedValue([]);
      mockSaveScript.mockResolvedValue(undefined);

      await useModuleStore.getState().loadModules();

      const state = useModuleStore.getState();
      expect(state.loaded).toBe(true);
      expect(state.modules).toHaveLength(1);
      expect(state.modules[0].name).toBe("Module1");
      expect(state.activeModuleId).toBe(state.modules[0].id);
      expect(mockSaveScript).toHaveBeenCalledOnce();
    });

    it("loads existing modules and selects the first", async () => {
      const modules = [
        { id: "s1", name: "Main" },
        { id: "s2", name: "Utils" },
      ];
      mockListScripts.mockResolvedValue(modules);

      await useModuleStore.getState().loadModules();

      const state = useModuleStore.getState();
      expect(state.modules).toEqual(modules);
      expect(state.activeModuleId).toBe("s1");
      expect(state.loaded).toBe(true);
      expect(mockSaveScript).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // createModule
  // =========================================================================

  describe("createModule", () => {
    it("generates auto-incremented names", async () => {
      mockSaveScript.mockResolvedValue(undefined);

      useModuleStore.setState({
        modules: [
          { id: "a", name: "Module1" },
          { id: "b", name: "Module3" },
        ],
      });

      await useModuleStore.getState().createModule();

      const state = useModuleStore.getState();
      expect(state.modules).toHaveLength(3);
      expect(state.modules[2].name).toBe("Module4");
    });

    it("starts at Module1 when no ModuleN pattern exists", async () => {
      mockSaveScript.mockResolvedValue(undefined);

      useModuleStore.setState({
        modules: [{ id: "x", name: "CustomName" }],
      });

      await useModuleStore.getState().createModule();

      const state = useModuleStore.getState();
      expect(state.modules[1].name).toBe("Module1");
    });

    it("sets the new module as active", async () => {
      mockSaveScript.mockResolvedValue(undefined);
      useModuleStore.setState({ modules: [] });

      const newId = await useModuleStore.getState().createModule();

      expect(useModuleStore.getState().activeModuleId).toBe(newId);
    });
  });

  // =========================================================================
  // selectModule
  // =========================================================================

  describe("selectModule", () => {
    it("sets the active module", () => {
      useModuleStore.getState().selectModule("abc");
      expect(useModuleStore.getState().activeModuleId).toBe("abc");
    });
  });

  // =========================================================================
  // Dirty state
  // =========================================================================

  describe("markDirty / markClean", () => {
    it("marks a module dirty", () => {
      useModuleStore.getState().markDirty("m1");
      expect(useModuleStore.getState().dirtyModuleIds).toContain("m1");
    });

    it("does not duplicate dirty IDs", () => {
      useModuleStore.getState().markDirty("m1");
      useModuleStore.getState().markDirty("m1");
      expect(
        useModuleStore.getState().dirtyModuleIds.filter((d) => d === "m1"),
      ).toHaveLength(1);
    });

    it("marks a module clean", () => {
      useModuleStore.setState({ dirtyModuleIds: ["m1", "m2"] });
      useModuleStore.getState().markClean("m1");
      expect(useModuleStore.getState().dirtyModuleIds).toEqual(["m2"]);
    });

    it("markClean is safe for non-dirty IDs", () => {
      useModuleStore.setState({ dirtyModuleIds: ["m2"] });
      useModuleStore.getState().markClean("m99");
      expect(useModuleStore.getState().dirtyModuleIds).toEqual(["m2"]);
    });
  });

  // =========================================================================
  // saveModule
  // =========================================================================

  describe("saveModule", () => {
    it("saves to backend and marks clean", async () => {
      mockSaveScript.mockResolvedValue(undefined);

      useModuleStore.setState({
        modules: [{ id: "m1", name: "Test" }],
        dirtyModuleIds: ["m1"],
      });

      await useModuleStore.getState().saveModule("m1", "const x = 1;");

      expect(mockSaveScript).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "m1",
          name: "Test",
          source: "const x = 1;",
        }),
      );
      expect(useModuleStore.getState().dirtyModuleIds).not.toContain("m1");
    });

    it("does nothing for unknown module ID", async () => {
      useModuleStore.setState({ modules: [] });
      await useModuleStore.getState().saveModule("nonexistent", "code");
      expect(mockSaveScript).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // removeModule
  // =========================================================================

  describe("removeModule", () => {
    it("cannot remove the last module", async () => {
      useModuleStore.setState({
        modules: [{ id: "only", name: "Only" }],
        activeModuleId: "only",
      });

      const result = await useModuleStore.getState().removeModule("only");

      expect(result).toBe(false);
      expect(mockDeleteScript).not.toHaveBeenCalled();
      expect(useModuleStore.getState().modules).toHaveLength(1);
    });

    it("removes a module and switches active if needed", async () => {
      mockDeleteScript.mockResolvedValue(undefined);

      useModuleStore.setState({
        modules: [
          { id: "m1", name: "A" },
          { id: "m2", name: "B" },
        ],
        activeModuleId: "m1",
        dirtyModuleIds: ["m1"],
      });

      const result = await useModuleStore.getState().removeModule("m1");

      expect(result).toBe(true);
      const state = useModuleStore.getState();
      expect(state.modules).toHaveLength(1);
      expect(state.activeModuleId).toBe("m2");
      expect(state.dirtyModuleIds).not.toContain("m1");
    });

    it("does not switch active when deleting a non-active module", async () => {
      mockDeleteScript.mockResolvedValue(undefined);

      useModuleStore.setState({
        modules: [
          { id: "m1", name: "A" },
          { id: "m2", name: "B" },
        ],
        activeModuleId: "m1",
      });

      await useModuleStore.getState().removeModule("m2");

      expect(useModuleStore.getState().activeModuleId).toBe("m1");
    });
  });

  // =========================================================================
  // renameModule
  // =========================================================================

  describe("renameModule", () => {
    it("renames a module and updates the list", async () => {
      mockRenameScript.mockResolvedValue(undefined);
      useModuleStore.setState({ modules: [{ id: "m1", name: "Old" }] });

      await useModuleStore.getState().renameModule("m1", "New");

      expect(mockRenameScript).toHaveBeenCalledWith("m1", "New");
      expect(useModuleStore.getState().modules[0].name).toBe("New");
    });

    it("trims whitespace from names", async () => {
      mockRenameScript.mockResolvedValue(undefined);
      useModuleStore.setState({ modules: [{ id: "m1", name: "Old" }] });

      await useModuleStore.getState().renameModule("m1", "  Spaced  ");

      expect(mockRenameScript).toHaveBeenCalledWith("m1", "Spaced");
      expect(useModuleStore.getState().modules[0].name).toBe("Spaced");
    });

    it("ignores empty/whitespace-only names", async () => {
      useModuleStore.setState({ modules: [{ id: "m1", name: "Keep" }] });

      await useModuleStore.getState().renameModule("m1", "   ");

      expect(mockRenameScript).not.toHaveBeenCalled();
      expect(useModuleStore.getState().modules[0].name).toBe("Keep");
    });
  });

  // =========================================================================
  // duplicateModule
  // =========================================================================

  describe("duplicateModule", () => {
    it("creates a copy with ' (Copy)' suffix", async () => {
      const original = {
        id: "m1",
        name: "MyScript",
        description: "desc",
        source: "console.log('hi');",
      };
      mockGetScript.mockResolvedValue(original);
      mockSaveScript.mockResolvedValue(undefined);

      useModuleStore.setState({ modules: [{ id: "m1", name: "MyScript" }] });

      await useModuleStore.getState().duplicateModule("m1");

      const state = useModuleStore.getState();
      expect(state.modules).toHaveLength(2);
      expect(state.modules[1].name).toBe("MyScript (Copy)");
      expect(state.activeModuleId).toBe(state.modules[1].id);
      expect(mockSaveScript).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "MyScript (Copy)",
          source: "console.log('hi');",
          description: "desc",
        }),
      );
    });
  });

  // =========================================================================
  // toggleNavPane
  // =========================================================================

  describe("toggleNavPane", () => {
    it("toggles visibility", () => {
      expect(useModuleStore.getState().navPaneVisible).toBe(true);
      useModuleStore.getState().toggleNavPane();
      expect(useModuleStore.getState().navPaneVisible).toBe(false);
      useModuleStore.getState().toggleNavPane();
      expect(useModuleStore.getState().navPaneVisible).toBe(true);
    });
  });
});
