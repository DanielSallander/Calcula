//! FILENAME: app/extensions/ScriptNotebook/lib/__tests__/useNotebookStore.test.ts
// PURPOSE: Tests for the ScriptNotebook Zustand store.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock notebook API
const mockListNotebooks = vi.fn();
const mockCreateNotebook = vi.fn();
const mockSaveNotebook = vi.fn();
const mockLoadNotebook = vi.fn();
const mockDeleteNotebook = vi.fn();
const mockRunNotebookCell = vi.fn();
const mockRunAllCells = vi.fn();
const mockRewindNotebook = vi.fn();
const mockRunFromCell = vi.fn();
const mockResetNotebookRuntime = vi.fn();

vi.mock("../notebookApi", () => ({
  listNotebooks: (...args: unknown[]) => mockListNotebooks(...args),
  createNotebook: (...args: unknown[]) => mockCreateNotebook(...args),
  saveNotebook: (...args: unknown[]) => mockSaveNotebook(...args),
  loadNotebook: (...args: unknown[]) => mockLoadNotebook(...args),
  deleteNotebook: (...args: unknown[]) => mockDeleteNotebook(...args),
  runNotebookCell: (...args: unknown[]) => mockRunNotebookCell(...args),
  runAllCells: (...args: unknown[]) => mockRunAllCells(...args),
  rewindNotebook: (...args: unknown[]) => mockRewindNotebook(...args),
  runFromCell: (...args: unknown[]) => mockRunFromCell(...args),
  resetNotebookRuntime: (...args: unknown[]) => mockResetNotebookRuntime(...args),
}));

vi.mock("@api/backend", () => ({
  invokeBackend: vi.fn(),
}));

import { useNotebookStore } from "../useNotebookStore";
import type { NotebookDocument, NotebookCell } from "../../types";

function makeCell(overrides: Partial<NotebookCell> = {}): NotebookCell {
  return {
    id: `cell-${Math.random()}`,
    source: "",
    lastOutput: [],
    lastError: null,
    cellsModified: 0,
    durationMs: 0,
    executionIndex: null,
    ...overrides,
  };
}

function makeNotebook(overrides: Partial<NotebookDocument> = {}): NotebookDocument {
  return {
    id: "nb-1",
    name: "Test Notebook",
    cells: [makeCell({ id: "c1", source: "// cell 1" })],
    ...overrides,
  };
}

describe("useNotebookStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useNotebookStore.setState({
      notebooks: [],
      activeNotebook: null,
      isExecuting: false,
      executingCellId: null,
    });
  });

  // =========================================================================
  // Initial state
  // =========================================================================

  it("has correct initial state", () => {
    const state = useNotebookStore.getState();
    expect(state.notebooks).toEqual([]);
    expect(state.activeNotebook).toBeNull();
    expect(state.isExecuting).toBe(false);
    expect(state.executingCellId).toBeNull();
  });

  // =========================================================================
  // Notebook lifecycle
  // =========================================================================

  describe("refreshNotebookList", () => {
    it("fetches and stores notebook summaries", async () => {
      const summaries = [{ id: "nb-1", name: "Nb1", cellCount: 3 }];
      mockListNotebooks.mockResolvedValue(summaries);

      await useNotebookStore.getState().refreshNotebookList();

      expect(useNotebookStore.getState().notebooks).toEqual(summaries);
    });
  });

  describe("createNotebook", () => {
    it("creates notebook and sets it as active", async () => {
      const nb = makeNotebook({ id: "nb-new" });
      mockCreateNotebook.mockResolvedValue(nb);
      mockListNotebooks.mockResolvedValue([]);

      await useNotebookStore.getState().createNotebook("My Notebook");

      expect(useNotebookStore.getState().activeNotebook).toBeTruthy();
      expect(mockCreateNotebook).toHaveBeenCalled();
    });
  });

  describe("openNotebook", () => {
    it("resets runtime and loads notebook", async () => {
      const nb = makeNotebook();
      mockResetNotebookRuntime.mockResolvedValue(undefined);
      mockLoadNotebook.mockResolvedValue(nb);

      await useNotebookStore.getState().openNotebook("nb-1");

      expect(mockResetNotebookRuntime).toHaveBeenCalledOnce();
      expect(mockLoadNotebook).toHaveBeenCalledWith("nb-1");
      expect(useNotebookStore.getState().activeNotebook).toEqual(nb);
    });
  });

  describe("closeNotebook", () => {
    it("saves, resets runtime, and clears active", async () => {
      const nb = makeNotebook();
      useNotebookStore.setState({ activeNotebook: nb });
      mockSaveNotebook.mockResolvedValue(undefined);
      mockResetNotebookRuntime.mockResolvedValue(undefined);

      await useNotebookStore.getState().closeNotebook();

      expect(mockSaveNotebook).toHaveBeenCalledWith(nb);
      expect(mockResetNotebookRuntime).toHaveBeenCalledOnce();
      expect(useNotebookStore.getState().activeNotebook).toBeNull();
    });

    it("is a no-op when no active notebook", async () => {
      await useNotebookStore.getState().closeNotebook();
      expect(mockSaveNotebook).not.toHaveBeenCalled();
    });
  });

  describe("deleteNotebook", () => {
    it("deletes and clears active if it was the active one", async () => {
      const nb = makeNotebook({ id: "nb-del" });
      useNotebookStore.setState({ activeNotebook: nb });
      mockDeleteNotebook.mockResolvedValue(undefined);
      mockListNotebooks.mockResolvedValue([]);

      await useNotebookStore.getState().deleteNotebook("nb-del");

      expect(useNotebookStore.getState().activeNotebook).toBeNull();
    });

    it("does not clear active if deleting a different notebook", async () => {
      const nb = makeNotebook({ id: "nb-keep" });
      useNotebookStore.setState({ activeNotebook: nb });
      mockDeleteNotebook.mockResolvedValue(undefined);
      mockListNotebooks.mockResolvedValue([]);

      await useNotebookStore.getState().deleteNotebook("nb-other");

      expect(useNotebookStore.getState().activeNotebook).toEqual(nb);
    });
  });

  // =========================================================================
  // Cell management
  // =========================================================================

  describe("addCell", () => {
    it("appends a cell when no afterCellId is given", () => {
      const nb = makeNotebook({ cells: [makeCell({ id: "c1" })] });
      useNotebookStore.setState({ activeNotebook: nb });
      mockSaveNotebook.mockResolvedValue(undefined);
      mockListNotebooks.mockResolvedValue([]);

      useNotebookStore.getState().addCell();

      const cells = useNotebookStore.getState().activeNotebook!.cells;
      expect(cells).toHaveLength(2);
      expect(cells[0].id).toBe("c1");
    });

    it("inserts after the specified cell", () => {
      const nb = makeNotebook({
        cells: [makeCell({ id: "c1" }), makeCell({ id: "c2" })],
      });
      useNotebookStore.setState({ activeNotebook: nb });
      mockSaveNotebook.mockResolvedValue(undefined);
      mockListNotebooks.mockResolvedValue([]);

      useNotebookStore.getState().addCell("c1");

      const cells = useNotebookStore.getState().activeNotebook!.cells;
      expect(cells).toHaveLength(3);
      expect(cells[0].id).toBe("c1");
      expect(cells[2].id).toBe("c2");
      // The new cell is at index 1
      expect(cells[1].id).not.toBe("c1");
      expect(cells[1].id).not.toBe("c2");
    });

    it("appends if afterCellId is not found", () => {
      const nb = makeNotebook({ cells: [makeCell({ id: "c1" })] });
      useNotebookStore.setState({ activeNotebook: nb });
      mockSaveNotebook.mockResolvedValue(undefined);
      mockListNotebooks.mockResolvedValue([]);

      useNotebookStore.getState().addCell("nonexistent");

      expect(useNotebookStore.getState().activeNotebook!.cells).toHaveLength(2);
    });

    it("does nothing if no active notebook", () => {
      useNotebookStore.getState().addCell();
      expect(useNotebookStore.getState().activeNotebook).toBeNull();
    });
  });

  describe("removeCell", () => {
    it("removes a cell by ID", () => {
      const nb = makeNotebook({
        cells: [makeCell({ id: "c1" }), makeCell({ id: "c2" })],
      });
      useNotebookStore.setState({ activeNotebook: nb });
      mockSaveNotebook.mockResolvedValue(undefined);
      mockListNotebooks.mockResolvedValue([]);

      useNotebookStore.getState().removeCell("c1");

      const cells = useNotebookStore.getState().activeNotebook!.cells;
      expect(cells).toHaveLength(1);
      expect(cells[0].id).toBe("c2");
    });

    it("does not remove the last cell", () => {
      const nb = makeNotebook({ cells: [makeCell({ id: "c1" })] });
      useNotebookStore.setState({ activeNotebook: nb });

      useNotebookStore.getState().removeCell("c1");

      expect(useNotebookStore.getState().activeNotebook!.cells).toHaveLength(1);
    });
  });

  describe("updateCellSource", () => {
    it("updates the source of a specific cell", () => {
      const nb = makeNotebook({
        cells: [
          makeCell({ id: "c1", source: "old" }),
          makeCell({ id: "c2", source: "keep" }),
        ],
      });
      useNotebookStore.setState({ activeNotebook: nb });

      useNotebookStore.getState().updateCellSource("c1", "new code");

      const cells = useNotebookStore.getState().activeNotebook!.cells;
      expect(cells[0].source).toBe("new code");
      expect(cells[1].source).toBe("keep");
    });
  });

  describe("moveCellUp", () => {
    it("swaps cell with the one above", () => {
      const nb = makeNotebook({
        cells: [makeCell({ id: "c1" }), makeCell({ id: "c2" }), makeCell({ id: "c3" })],
      });
      useNotebookStore.setState({ activeNotebook: nb });

      useNotebookStore.getState().moveCellUp("c2");

      const ids = useNotebookStore.getState().activeNotebook!.cells.map((c) => c.id);
      expect(ids).toEqual(["c2", "c1", "c3"]);
    });

    it("does nothing for the first cell", () => {
      const nb = makeNotebook({
        cells: [makeCell({ id: "c1" }), makeCell({ id: "c2" })],
      });
      useNotebookStore.setState({ activeNotebook: nb });

      useNotebookStore.getState().moveCellUp("c1");

      const ids = useNotebookStore.getState().activeNotebook!.cells.map((c) => c.id);
      expect(ids).toEqual(["c1", "c2"]);
    });
  });

  describe("moveCellDown", () => {
    it("swaps cell with the one below", () => {
      const nb = makeNotebook({
        cells: [makeCell({ id: "c1" }), makeCell({ id: "c2" }), makeCell({ id: "c3" })],
      });
      useNotebookStore.setState({ activeNotebook: nb });

      useNotebookStore.getState().moveCellDown("c1");

      const ids = useNotebookStore.getState().activeNotebook!.cells.map((c) => c.id);
      expect(ids).toEqual(["c2", "c1", "c3"]);
    });

    it("does nothing for the last cell", () => {
      const nb = makeNotebook({
        cells: [makeCell({ id: "c1" }), makeCell({ id: "c2" })],
      });
      useNotebookStore.setState({ activeNotebook: nb });

      useNotebookStore.getState().moveCellDown("c2");

      const ids = useNotebookStore.getState().activeNotebook!.cells.map((c) => c.id);
      expect(ids).toEqual(["c1", "c2"]);
    });
  });

  // =========================================================================
  // Execution
  // =========================================================================

  describe("runCell", () => {
    it("executes a cell and updates results on success", async () => {
      const nb = makeNotebook({
        cells: [makeCell({ id: "c1", source: "console.log(1)" })],
      });
      useNotebookStore.setState({ activeNotebook: nb });
      mockSaveNotebook.mockResolvedValue(undefined);
      mockRunNotebookCell.mockResolvedValue({
        type: "success",
        output: ["1"],
        cellsModified: 0,
        durationMs: 5,
        executionIndex: 1,
        screenUpdating: true,
        enableEvents: true,
      });

      await useNotebookStore.getState().runCell("c1");

      const state = useNotebookStore.getState();
      expect(state.isExecuting).toBe(false);
      expect(state.executingCellId).toBeNull();
      const cell = state.activeNotebook!.cells[0];
      expect(cell.lastOutput).toEqual(["1"]);
      expect(cell.lastError).toBeNull();
      expect(cell.executionIndex).toBe(1);
    });

    it("updates cell with error on failure", async () => {
      const nb = makeNotebook({
        cells: [makeCell({ id: "c1", source: "bad()" })],
      });
      useNotebookStore.setState({ activeNotebook: nb });
      mockSaveNotebook.mockResolvedValue(undefined);
      mockRunNotebookCell.mockResolvedValue({
        type: "error",
        message: "ReferenceError: bad is not defined",
        output: [],
      });

      await useNotebookStore.getState().runCell("c1");

      const cell = useNotebookStore.getState().activeNotebook!.cells[0];
      expect(cell.lastError).toBe("ReferenceError: bad is not defined");
      expect(cell.executionIndex).toBeNull();
    });

    it("does nothing if already executing", async () => {
      const nb = makeNotebook({ cells: [makeCell({ id: "c1" })] });
      useNotebookStore.setState({ activeNotebook: nb, isExecuting: true });

      await useNotebookStore.getState().runCell("c1");

      expect(mockSaveNotebook).not.toHaveBeenCalled();
    });

    it("does nothing if cell not found", async () => {
      const nb = makeNotebook({ cells: [makeCell({ id: "c1" })] });
      useNotebookStore.setState({ activeNotebook: nb });

      await useNotebookStore.getState().runCell("nonexistent");

      expect(mockSaveNotebook).not.toHaveBeenCalled();
    });
  });

  describe("runAll", () => {
    it("runs all cells and reloads notebook", async () => {
      const nb = makeNotebook({ id: "nb-1" });
      const updatedNb = makeNotebook({ id: "nb-1", name: "Updated" });
      useNotebookStore.setState({ activeNotebook: nb });
      mockSaveNotebook.mockResolvedValue(undefined);
      mockRunAllCells.mockResolvedValue([
        {
          type: "success",
          output: [],
          cellsModified: 0,
          durationMs: 1,
          executionIndex: 1,
          screenUpdating: true,
          enableEvents: true,
        },
      ]);
      mockLoadNotebook.mockResolvedValue(updatedNb);

      await useNotebookStore.getState().runAll();

      expect(mockRunAllCells).toHaveBeenCalledWith("nb-1");
      expect(useNotebookStore.getState().activeNotebook).toEqual(updatedNb);
      expect(useNotebookStore.getState().isExecuting).toBe(false);
    });

    it("does nothing if already executing", async () => {
      const nb = makeNotebook();
      useNotebookStore.setState({ activeNotebook: nb, isExecuting: true });

      await useNotebookStore.getState().runAll();

      expect(mockSaveNotebook).not.toHaveBeenCalled();
    });
  });

  describe("rewindToCell", () => {
    it("rewinds and reloads notebook", async () => {
      const nb = makeNotebook({ id: "nb-1" });
      const reloadedNb = makeNotebook({ id: "nb-1", name: "Rewound" });
      useNotebookStore.setState({ activeNotebook: nb });
      mockRewindNotebook.mockResolvedValue([]);
      mockLoadNotebook.mockResolvedValue(reloadedNb);

      await useNotebookStore.getState().rewindToCell("c1");

      expect(mockRewindNotebook).toHaveBeenCalledWith({
        notebookId: "nb-1",
        targetCellId: "c1",
      });
      expect(useNotebookStore.getState().activeNotebook).toEqual(reloadedNb);
    });
  });

  describe("runFromCell", () => {
    it("saves, runs from cell, and reloads", async () => {
      const nb = makeNotebook({ id: "nb-1" });
      const reloadedNb = makeNotebook({ id: "nb-1", name: "RunFrom" });
      useNotebookStore.setState({ activeNotebook: nb });
      mockSaveNotebook.mockResolvedValue(undefined);
      mockRunFromCell.mockResolvedValue([]);
      mockLoadNotebook.mockResolvedValue(reloadedNb);

      await useNotebookStore.getState().runFromCell("c1");

      expect(mockSaveNotebook).toHaveBeenCalled();
      expect(mockRunFromCell).toHaveBeenCalledWith({
        notebookId: "nb-1",
        targetCellId: "c1",
      });
      expect(useNotebookStore.getState().activeNotebook).toEqual(reloadedNb);
    });
  });
});
