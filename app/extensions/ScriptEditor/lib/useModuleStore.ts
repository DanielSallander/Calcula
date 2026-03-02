//! FILENAME: app/extensions/ScriptEditor/lib/useModuleStore.ts
// PURPOSE: Zustand store for managing script modules in the Advanced Editor.
// CONTEXT: Tracks the list of modules, active selection, and dirty state.
//          Modules are persisted to the Rust backend via Tauri commands.

import { create } from "zustand";
import type { ScriptSummary, WorkbookScript } from "../types";
import {
  listScripts,
  getScript,
  saveScript,
  deleteScript as deleteScriptApi,
  renameScript as renameScriptApi,
} from "./scriptApi";

// ============================================================================
// Types
// ============================================================================

interface ModuleState {
  /** List of all script modules (lightweight summaries) */
  modules: ScriptSummary[];
  /** ID of the currently active/open module */
  activeModuleId: string | null;
  /** Set of module IDs that have unsaved changes */
  dirtyModuleIds: string[];
  /** Whether the initial load from backend has completed */
  loaded: boolean;
  /** Whether the navigation pane is visible */
  navPaneVisible: boolean;
}

interface ModuleActions {
  /** Load the module list from the backend. Creates a default module if none exist. */
  loadModules: () => Promise<void>;
  /** Create a new module with an auto-generated name. Returns the new module ID. */
  createModule: () => Promise<string>;
  /** Select a module as active (does NOT load its source — the editor component does that). */
  selectModule: (id: string) => void;
  /** Mark a module as having unsaved changes. */
  markDirty: (id: string) => void;
  /** Mark a module as clean (saved). */
  markClean: (id: string) => void;
  /** Save a module's source code to the backend. */
  saveModule: (id: string, source: string) => Promise<void>;
  /** Delete a module by ID. Cannot delete the last module. */
  removeModule: (id: string) => Promise<boolean>;
  /** Rename a module. */
  renameModule: (id: string, newName: string) => Promise<void>;
  /** Duplicate a module. Returns the new module ID. */
  duplicateModule: (id: string) => Promise<string>;
  /** Toggle the navigation pane visibility. */
  toggleNavPane: () => void;
}

// ============================================================================
// Helpers
// ============================================================================

/** Generate a unique ID for a new module. */
function generateId(): string {
  return `script_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

/** Find the next available "ModuleN" name. */
function nextModuleName(modules: ScriptSummary[]): string {
  const existingNumbers = modules
    .map((m) => {
      const match = m.name.match(/^Module(\d+)$/);
      return match ? parseInt(match[1], 10) : 0;
    })
    .filter((n) => n > 0);

  const maxNumber = existingNumbers.length > 0 ? Math.max(...existingNumbers) : 0;
  return `Module${maxNumber + 1}`;
}

// ============================================================================
// Default source template for new modules
// ============================================================================

const DEFAULT_SOURCE = `// Calcula Script
// Use the Calcula API to read/write spreadsheet data.
// Type "Calcula." to see available methods.

`;

// ============================================================================
// Store
// ============================================================================

export const useModuleStore = create<ModuleState & ModuleActions>()(
  (set, get) => ({
    // -- State --
    modules: [],
    activeModuleId: null,
    dirtyModuleIds: [],
    loaded: false,
    navPaneVisible: true,

    // -- Actions --

    loadModules: async () => {
      const modules = await listScripts();

      if (modules.length === 0) {
        // No modules exist — create a default one
        const id = generateId();
        const defaultModule: WorkbookScript = {
          id,
          name: "Module1",
          description: null,
          source: DEFAULT_SOURCE,
        };
        await saveScript(defaultModule);
        set({
          modules: [{ id, name: "Module1" }],
          activeModuleId: id,
          loaded: true,
        });
      } else {
        set({
          modules,
          activeModuleId: modules[0].id,
          loaded: true,
        });
      }
    },

    createModule: async () => {
      const { modules } = get();
      const id = generateId();
      const name = nextModuleName(modules);
      const newModule: WorkbookScript = {
        id,
        name,
        description: null,
        source: DEFAULT_SOURCE,
      };
      await saveScript(newModule);
      set({
        modules: [...modules, { id, name }],
        activeModuleId: id,
      });
      return id;
    },

    selectModule: (id: string) => {
      set({ activeModuleId: id });
    },

    markDirty: (id: string) => {
      const { dirtyModuleIds } = get();
      if (!dirtyModuleIds.includes(id)) {
        set({ dirtyModuleIds: [...dirtyModuleIds, id] });
      }
    },

    markClean: (id: string) => {
      const { dirtyModuleIds } = get();
      set({ dirtyModuleIds: dirtyModuleIds.filter((d) => d !== id) });
    },

    saveModule: async (id: string, source: string) => {
      const { modules } = get();
      const mod = modules.find((m) => m.id === id);
      if (!mod) return;

      const script: WorkbookScript = {
        id,
        name: mod.name,
        description: null,
        source,
      };
      await saveScript(script);

      // Mark as clean
      const { dirtyModuleIds } = get();
      set({ dirtyModuleIds: dirtyModuleIds.filter((d) => d !== id) });
    },

    removeModule: async (id: string) => {
      const { modules, activeModuleId } = get();
      if (modules.length <= 1) return false;

      await deleteScriptApi(id);
      const newModules = modules.filter((m) => m.id !== id);

      // If deleting the active module, switch to another
      let newActiveId = activeModuleId;
      if (activeModuleId === id) {
        newActiveId = newModules[0]?.id ?? null;
      }

      // Clean up dirty state
      const { dirtyModuleIds } = get();
      set({
        modules: newModules,
        activeModuleId: newActiveId,
        dirtyModuleIds: dirtyModuleIds.filter((d) => d !== id),
      });
      return true;
    },

    renameModule: async (id: string, newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed) return;

      await renameScriptApi(id, trimmed);

      const { modules } = get();
      set({
        modules: modules.map((m) =>
          m.id === id ? { ...m, name: trimmed } : m,
        ),
      });
    },

    duplicateModule: async (id: string) => {
      const original = await getScript(id);
      const { modules } = get();
      const newId = generateId();
      const newName = `${original.name} (Copy)`;

      const duplicate: WorkbookScript = {
        id: newId,
        name: newName,
        description: original.description,
        source: original.source,
      };
      await saveScript(duplicate);

      set({
        modules: [...modules, { id: newId, name: newName }],
        activeModuleId: newId,
      });
      return newId;
    },

    toggleNavPane: () => {
      set((state) => ({ navPaneVisible: !state.navPaneVisible }));
    },
  }),
);
