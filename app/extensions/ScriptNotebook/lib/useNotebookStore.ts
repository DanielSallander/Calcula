//! FILENAME: app/extensions/ScriptNotebook/lib/useNotebookStore.ts
// PURPOSE: Zustand store for notebook state management.
// CONTEXT: Manages the active notebook, cell list, and execution state.

import { create } from "zustand";
import type {
  NotebookDocument,
  NotebookCell,
  NotebookCellResponse,
  NotebookSummary,
} from "../types";
import * as api from "./notebookApi";

/** Check if the last response in a batch has screenUpdating=false (suppressed). */
function shouldSuppressRefresh(responses: NotebookCellResponse[]): boolean {
  const last = responses[responses.length - 1];
  return last?.type === "success" && last.screenUpdating === false;
}

/**
 * The model.* ops throw this sentinel when a cell calls the model API without
 * the capability granted for this notebook's surface. Format (from
 * core/script-engine/src/ops/model.rs):
 *   BI_CONSENT_REQUIRED capability=bi.query surface=notebook:{id} — ...
 */
const BI_CONSENT_SENTINEL = "BI_CONSENT_REQUIRED";

/** Extract the requested capability from a consent-sentinel error, or null. */
function parseBiConsentCapability(message: string | undefined): string | null {
  if (!message || !message.includes(BI_CONSENT_SENTINEL)) return null;
  const m = message.match(/capability=([a-z.]+)/);
  return m ? m[1] : "bi.query";
}

/**
 * JIT consent for notebook model access: prompt, and on approval mirror the
 * grant into the authoritative backend CapabilityStore (session-scoped).
 * Returns true when granted (caller should retry the run once).
 */
async function promptAndGrantBiCapability(
  notebookId: string,
  message: string,
): Promise<boolean> {
  const capability = parseBiConsentCapability(message);
  if (!capability) return false;
  const what =
    capability === "bi.sql"
      ? "run read-only SQL against its data sources"
      : "run read-only queries against this workbook's Calcula models";
  const ok = window.confirm(
    `This notebook wants to ${what}.\n\n` +
      `Capability: ${capability} (read-only; every call is recorded in the audit log)\n\n` +
      `Allow for this session?`,
  );
  if (!ok) return false;
  await api.grantNotebookBiCapability(notebookId, capability);
  return true;
}

/** True when the LAST response of a batch is a consent-sentinel error. */
function batchNeedsBiConsent(responses: NotebookCellResponse[]): string | null {
  const last = responses[responses.length - 1];
  if (last?.type === "error") return parseBiConsentCapability(last.message) ? last.message : null;
  return null;
}

/** Dispatch deferred actions from the last successful response in a batch. */
function dispatchBatchDeferredActions(responses: NotebookCellResponse[]): void {
  const last = responses[responses.length - 1];
  if (
    last?.type === "success" &&
    last.deferredActions &&
    last.deferredActions.length > 0
  ) {
    window.dispatchEvent(
      new CustomEvent("script:deferred-actions", {
        detail: last.deferredActions,
      })
    );
  }
}

interface NotebookState {
  /** All notebooks in the workbook (summaries). */
  notebooks: NotebookSummary[];
  /** The currently active notebook document (full, with cells). */
  activeNotebook: NotebookDocument | null;
  /** Whether a cell is currently executing. */
  isExecuting: boolean;
  /** ID of the cell currently being executed. */
  executingCellId: string | null;

  // Actions
  refreshNotebookList: () => Promise<void>;
  createNotebook: (name: string) => Promise<void>;
  openNotebook: (id: string) => Promise<void>;
  closeNotebook: () => Promise<void>;
  deleteNotebook: (id: string) => Promise<void>;
  saveActiveNotebook: () => Promise<void>;

  // Cell management
  addCell: (afterCellId?: string) => void;
  removeCell: (cellId: string) => void;
  updateCellSource: (cellId: string, source: string) => void;
  moveCellUp: (cellId: string) => void;
  moveCellDown: (cellId: string) => void;

  // Execution
  runCell: (cellId: string) => Promise<void>;
  runAll: () => Promise<void>;
  rewindToCell: (cellId: string) => Promise<void>;
  runFromCell: (cellId: string) => Promise<void>;
}

let cellCounter = 0;

function generateCellId(): string {
  cellCounter += 1;
  return `cell-${Date.now()}-${cellCounter}`;
}

function createEmptyCell(): NotebookCell {
  return {
    id: generateCellId(),
    source: "",
    lastOutput: [],
    lastError: null,
    cellsModified: 0,
    durationMs: 0,
    executionIndex: null,
  };
}

export const useNotebookStore = create<NotebookState>((set, get) => ({
  notebooks: [],
  activeNotebook: null,
  isExecuting: false,
  executingCellId: null,

  refreshNotebookList: async () => {
    const notebooks = await api.listNotebooks();
    set({ notebooks });
  },

  createNotebook: async (name: string) => {
    const id = `nb-${Date.now()}`;
    const notebook = await api.createNotebook(id, name);
    set({ activeNotebook: notebook });
    await get().refreshNotebookList();
  },

  openNotebook: async (id: string) => {
    // Reset runtime when switching notebooks
    await api.resetNotebookRuntime();
    const notebook = await api.loadNotebook(id);
    set({ activeNotebook: notebook });
  },

  closeNotebook: async () => {
    const { activeNotebook } = get();
    if (activeNotebook) {
      // Save before closing
      await api.saveNotebook(activeNotebook);
      await api.resetNotebookRuntime();
    }
    set({ activeNotebook: null });
  },

  deleteNotebook: async (id: string) => {
    await api.deleteNotebook(id);
    const { activeNotebook } = get();
    if (activeNotebook?.id === id) {
      set({ activeNotebook: null });
    }
    await get().refreshNotebookList();
  },

  saveActiveNotebook: async () => {
    const { activeNotebook } = get();
    if (activeNotebook) {
      await api.saveNotebook(activeNotebook);
    }
  },

  // Cell management
  addCell: (afterCellId?: string) => {
    const { activeNotebook } = get();
    if (!activeNotebook) return;

    const newCell = createEmptyCell();
    const cells = [...activeNotebook.cells];

    if (afterCellId) {
      const idx = cells.findIndex((c) => c.id === afterCellId);
      if (idx >= 0) {
        cells.splice(idx + 1, 0, newCell);
      } else {
        cells.push(newCell);
      }
    } else {
      cells.push(newCell);
    }

    const updated = { ...activeNotebook, cells };
    set({ activeNotebook: updated });
    // Save and refresh list so cell count stays in sync
    api.saveNotebook(updated).then(() => get().refreshNotebookList());
  },

  removeCell: (cellId: string) => {
    const { activeNotebook } = get();
    if (!activeNotebook) return;

    // Don't remove the last cell
    if (activeNotebook.cells.length <= 1) return;

    const cells = activeNotebook.cells.filter((c) => c.id !== cellId);
    const updated = { ...activeNotebook, cells };
    set({ activeNotebook: updated });
    // Save and refresh list so cell count stays in sync
    api.saveNotebook(updated).then(() => get().refreshNotebookList());
  },

  updateCellSource: (cellId: string, source: string) => {
    const { activeNotebook } = get();
    if (!activeNotebook) return;

    const cells = activeNotebook.cells.map((c) =>
      c.id === cellId ? { ...c, source } : c,
    );
    set({
      activeNotebook: { ...activeNotebook, cells },
    });
  },

  moveCellUp: (cellId: string) => {
    const { activeNotebook } = get();
    if (!activeNotebook) return;

    const cells = [...activeNotebook.cells];
    const idx = cells.findIndex((c) => c.id === cellId);
    if (idx > 0) {
      [cells[idx - 1], cells[idx]] = [cells[idx], cells[idx - 1]];
      set({ activeNotebook: { ...activeNotebook, cells } });
    }
  },

  moveCellDown: (cellId: string) => {
    const { activeNotebook } = get();
    if (!activeNotebook) return;

    const cells = [...activeNotebook.cells];
    const idx = cells.findIndex((c) => c.id === cellId);
    if (idx >= 0 && idx < cells.length - 1) {
      [cells[idx], cells[idx + 1]] = [cells[idx + 1], cells[idx]];
      set({ activeNotebook: { ...activeNotebook, cells } });
    }
  },

  // Execution
  runCell: async (cellId: string) => {
    const { activeNotebook } = get();
    if (!activeNotebook || get().isExecuting) return;

    const cell = activeNotebook.cells.find((c) => c.id === cellId);
    if (!cell) return;

    set({ isExecuting: true, executingCellId: cellId });

    try {
      // Save first so backend has latest sources
      await api.saveNotebook(activeNotebook);

      let response = await api.runNotebookCell({
        notebookId: activeNotebook.id,
        cellId,
        source: cell.source,
      });

      // JIT model-access consent: a consent-sentinel error means the cell
      // called model.* without the capability. Prompt once; on approval,
      // grant for the session and retry the cell.
      if (
        response.type === "error" &&
        parseBiConsentCapability(response.message) &&
        (await promptAndGrantBiCapability(activeNotebook.id, response.message))
      ) {
        response = await api.runNotebookCell({
          notebookId: activeNotebook.id,
          cellId,
          source: cell.source,
        });
      }

      // Update the cell with execution results
      const cells = activeNotebook.cells.map((c) => {
        if (c.id !== cellId) return c;
        if (response.type === "success") {
          return {
            ...c,
            lastOutput: response.output,
            lastError: null,
            cellsModified: response.cellsModified,
            durationMs: response.durationMs,
            executionIndex: response.executionIndex,
          };
        } else {
          return {
            ...c,
            lastOutput: response.output,
            lastError: response.message,
            executionIndex: null,
          };
        }
      });

      set({
        activeNotebook: { ...activeNotebook, cells },
      });

      // Refresh grid to show cell changes (unless screenUpdating was set to false)
      if (response.type !== "success" || response.screenUpdating !== false) {
        window.dispatchEvent(new CustomEvent("grid:refresh"));
      }

      // Process deferred actions from Application object
      if (
        response.type === "success" &&
        response.deferredActions &&
        response.deferredActions.length > 0
      ) {
        window.dispatchEvent(
          new CustomEvent("script:deferred-actions", {
            detail: response.deferredActions,
          })
        );
      }
    } catch (err) {
      console.error("[ScriptNotebook] Run cell error:", err);
    } finally {
      set({ isExecuting: false, executingCellId: null });
    }
  },

  runAll: async () => {
    const { activeNotebook } = get();
    if (!activeNotebook || get().isExecuting) return;

    set({ isExecuting: true });

    try {
      await api.saveNotebook(activeNotebook);
      let responses = await api.runAllCells(activeNotebook.id);

      // JIT model-access consent: run-all stops on the first error, so a
      // consent sentinel is always the LAST response. Grant + rerun once.
      const consentMsg = batchNeedsBiConsent(responses);
      if (consentMsg && (await promptAndGrantBiCapability(activeNotebook.id, consentMsg))) {
        responses = await api.runAllCells(activeNotebook.id);
      }

      // Reload the notebook to get updated cell states
      const updated = await api.loadNotebook(activeNotebook.id);
      set({ activeNotebook: updated });

      if (!shouldSuppressRefresh(responses)) {
        window.dispatchEvent(new CustomEvent("grid:refresh"));
      }
      dispatchBatchDeferredActions(responses);
    } catch (err) {
      console.error("[ScriptNotebook] Run all error:", err);
    } finally {
      set({ isExecuting: false, executingCellId: null });
    }
  },

  rewindToCell: async (cellId: string) => {
    const { activeNotebook } = get();
    if (!activeNotebook || get().isExecuting) return;

    set({ isExecuting: true });

    try {
      let responses = await api.rewindNotebook({
        notebookId: activeNotebook.id,
        targetCellId: cellId,
      });

      // Replay can hit the consent gate too (session grants are in-memory,
      // so a granted-then-restarted session re-prompts). Grant + retry once.
      const consentMsg = batchNeedsBiConsent(responses);
      if (consentMsg && (await promptAndGrantBiCapability(activeNotebook.id, consentMsg))) {
        responses = await api.rewindNotebook({
          notebookId: activeNotebook.id,
          targetCellId: cellId,
        });
      }

      // Reload the notebook to get updated cell states
      const updated = await api.loadNotebook(activeNotebook.id);
      set({ activeNotebook: updated });

      if (!shouldSuppressRefresh(responses)) {
        window.dispatchEvent(new CustomEvent("grid:refresh"));
      }
      dispatchBatchDeferredActions(responses);
    } catch (err) {
      console.error("[ScriptNotebook] Rewind error:", err);
    } finally {
      set({ isExecuting: false, executingCellId: null });
    }
  },

  runFromCell: async (cellId: string) => {
    const { activeNotebook } = get();
    if (!activeNotebook || get().isExecuting) return;

    set({ isExecuting: true });

    try {
      await api.saveNotebook(activeNotebook);
      let responses = await api.runFromCell({
        notebookId: activeNotebook.id,
        targetCellId: cellId,
      });

      const consentMsg = batchNeedsBiConsent(responses);
      if (consentMsg && (await promptAndGrantBiCapability(activeNotebook.id, consentMsg))) {
        responses = await api.runFromCell({
          notebookId: activeNotebook.id,
          targetCellId: cellId,
        });
      }

      const updated = await api.loadNotebook(activeNotebook.id);
      set({ activeNotebook: updated });

      if (!shouldSuppressRefresh(responses)) {
        window.dispatchEvent(new CustomEvent("grid:refresh"));
      }
      dispatchBatchDeferredActions(responses);
    } catch (err) {
      console.error("[ScriptNotebook] Run from error:", err);
    } finally {
      set({ isExecuting: false, executingCellId: null });
    }
  },
}));
