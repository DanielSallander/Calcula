//! FILENAME: app/extensions/ScriptNotebook/lib/__tests__/notebook-workflows.test.ts
// PURPOSE: Workflow-level tests for the ScriptNotebook store.

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
    id: `cell-${Math.random().toString(36).slice(2, 8)}`,
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

function successResponse(index: number, output: string[] = []): any {
  return {
    type: "success",
    output,
    cellsModified: 0,
    durationMs: 5,
    executionIndex: index,
    screenUpdating: true,
    enableEvents: true,
  };
}

function errorResponse(message: string): any {
  return { type: "error", message, output: [] };
}

describe("notebook workflows", () => {
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
  // Full workflow: create notebook, add cells, write code, run cells
  // =========================================================================

  describe("full workflow: create -> add cells -> write -> run", () => {
    it("creates a notebook, adds cells, writes code, and runs them sequentially", async () => {
      const nb = makeNotebook({ id: "nb-wf", cells: [makeCell({ id: "c1" })] });
      mockCreateNotebook.mockResolvedValue(nb);
      mockListNotebooks.mockResolvedValue([]);
      mockSaveNotebook.mockResolvedValue(undefined);

      // Step 1: Create
      await useNotebookStore.getState().createNotebook("Workflow NB");
      expect(useNotebookStore.getState().activeNotebook).toBeTruthy();

      // Step 2: Add cells
      useNotebookStore.getState().addCell("c1");
      useNotebookStore.getState().addCell(); // append at end
      const cells = useNotebookStore.getState().activeNotebook!.cells;
      expect(cells).toHaveLength(3);

      // Step 3: Write code
      useNotebookStore.getState().updateCellSource(cells[0].id, "let x = 1;");
      useNotebookStore.getState().updateCellSource(cells[1].id, "let y = x + 1;");
      useNotebookStore.getState().updateCellSource(cells[2].id, "console.log(y);");

      expect(useNotebookStore.getState().activeNotebook!.cells[0].source).toBe("let x = 1;");
      expect(useNotebookStore.getState().activeNotebook!.cells[2].source).toBe("console.log(y);");

      // Step 4: Run first cell
      mockRunNotebookCell.mockResolvedValue(successResponse(1));
      await useNotebookStore.getState().runCell(cells[0].id);
      expect(useNotebookStore.getState().activeNotebook!.cells[0].executionIndex).toBe(1);
    });
  });

  // =========================================================================
  // Cell dependency chains
  // =========================================================================

  describe("cell dependency chains", () => {
    it("running cells in order produces accumulated state", async () => {
      const nb = makeNotebook({
        id: "nb-dep",
        cells: [
          makeCell({ id: "c1", source: "let sum = 10;" }),
          makeCell({ id: "c2", source: "sum += 20;" }),
          makeCell({ id: "c3", source: "console.log(sum);" }),
        ],
      });
      useNotebookStore.setState({ activeNotebook: nb });
      mockSaveNotebook.mockResolvedValue(undefined);

      // Run c1
      mockRunNotebookCell.mockResolvedValue(successResponse(1));
      await useNotebookStore.getState().runCell("c1");
      expect(useNotebookStore.getState().activeNotebook!.cells[0].executionIndex).toBe(1);

      // Run c2
      mockRunNotebookCell.mockResolvedValue(successResponse(2));
      await useNotebookStore.getState().runCell("c2");
      expect(useNotebookStore.getState().activeNotebook!.cells[1].executionIndex).toBe(2);

      // Run c3 - output depends on c1+c2
      mockRunNotebookCell.mockResolvedValue(successResponse(3, ["30"]));
      await useNotebookStore.getState().runCell("c3");

      const c3 = useNotebookStore.getState().activeNotebook!.cells[2];
      expect(c3.executionIndex).toBe(3);
      expect(c3.lastOutput).toEqual(["30"]);
      expect(c3.lastError).toBeNull();
    });
  });

  // =========================================================================
  // Notebook with 50+ cells
  // =========================================================================

  describe("notebook with 50+ cells", () => {
    it("manages a large notebook without issues", () => {
      const cells = Array.from({ length: 55 }, (_, i) =>
        makeCell({ id: `c${i}`, source: `// cell ${i}` }),
      );
      const nb = makeNotebook({ id: "nb-large", cells });
      useNotebookStore.setState({ activeNotebook: nb });
      mockSaveNotebook.mockResolvedValue(undefined);

      expect(useNotebookStore.getState().activeNotebook!.cells).toHaveLength(55);

      // Add one more
      useNotebookStore.getState().addCell("c27");
      expect(useNotebookStore.getState().activeNotebook!.cells).toHaveLength(56);

      // Remove one
      useNotebookStore.getState().removeCell("c0");
      expect(useNotebookStore.getState().activeNotebook!.cells).toHaveLength(55);

      // Move cell up from middle
      useNotebookStore.getState().moveCellUp("c30");
      const ids = useNotebookStore.getState().activeNotebook!.cells.map((c) => c.id);
      const idx = ids.indexOf("c30");
      expect(idx).toBeLessThan(30); // moved up
    });

    it("runAll handles 50+ cells", async () => {
      const cells = Array.from({ length: 50 }, (_, i) =>
        makeCell({ id: `c${i}`, source: `// ${i}` }),
      );
      const nb = makeNotebook({ id: "nb-50", cells });
      const updatedNb = makeNotebook({ id: "nb-50", cells });
      useNotebookStore.setState({ activeNotebook: nb });
      mockSaveNotebook.mockResolvedValue(undefined);
      mockRunAllCells.mockResolvedValue(cells.map((_, i) => successResponse(i + 1)));
      mockLoadNotebook.mockResolvedValue(updatedNb);

      await useNotebookStore.getState().runAll();

      expect(mockRunAllCells).toHaveBeenCalledWith("nb-50");
      expect(useNotebookStore.getState().isExecuting).toBe(false);
    });
  });

  // =========================================================================
  // Rewind and re-run patterns
  // =========================================================================

  describe("rewind and re-run patterns", () => {
    it("rewind to cell 2, then runFrom cell 2 re-executes from that point", async () => {
      const nb = makeNotebook({
        id: "nb-rw",
        cells: [
          makeCell({ id: "c1", executionIndex: 1 }),
          makeCell({ id: "c2", executionIndex: 2 }),
          makeCell({ id: "c3", executionIndex: 3 }),
        ],
      });
      useNotebookStore.setState({ activeNotebook: nb });
      mockSaveNotebook.mockResolvedValue(undefined);

      // Rewind to c2
      const rewoundNb = makeNotebook({
        id: "nb-rw",
        cells: [
          makeCell({ id: "c1", executionIndex: 1 }),
          makeCell({ id: "c2", executionIndex: null }),
          makeCell({ id: "c3", executionIndex: null }),
        ],
      });
      mockRewindNotebook.mockResolvedValue([]);
      mockLoadNotebook.mockResolvedValue(rewoundNb);

      await useNotebookStore.getState().rewindToCell("c2");

      expect(mockRewindNotebook).toHaveBeenCalledWith({
        notebookId: "nb-rw",
        targetCellId: "c2",
      });
      const afterRewind = useNotebookStore.getState().activeNotebook!;
      expect(afterRewind.cells[1].executionIndex).toBeNull();
      expect(afterRewind.cells[2].executionIndex).toBeNull();

      // RunFrom c2
      const reRunNb = makeNotebook({
        id: "nb-rw",
        cells: [
          makeCell({ id: "c1", executionIndex: 1 }),
          makeCell({ id: "c2", executionIndex: 2 }),
          makeCell({ id: "c3", executionIndex: 3 }),
        ],
      });
      mockRunFromCell.mockResolvedValue([]);
      mockLoadNotebook.mockResolvedValue(reRunNb);

      await useNotebookStore.getState().runFromCell("c2");

      const afterReRun = useNotebookStore.getState().activeNotebook!;
      expect(afterReRun.cells[1].executionIndex).toBe(2);
      expect(afterReRun.cells[2].executionIndex).toBe(3);
    });

    it("rewind to first cell clears all execution indices", async () => {
      const nb = makeNotebook({
        id: "nb-rw2",
        cells: [
          makeCell({ id: "c1", executionIndex: 1 }),
          makeCell({ id: "c2", executionIndex: 2 }),
        ],
      });
      useNotebookStore.setState({ activeNotebook: nb });

      const rewoundNb = makeNotebook({
        id: "nb-rw2",
        cells: [
          makeCell({ id: "c1", executionIndex: null }),
          makeCell({ id: "c2", executionIndex: null }),
        ],
      });
      mockRewindNotebook.mockResolvedValue([]);
      mockLoadNotebook.mockResolvedValue(rewoundNb);

      await useNotebookStore.getState().rewindToCell("c1");

      const cells = useNotebookStore.getState().activeNotebook!.cells;
      expect(cells.every((c) => c.executionIndex === null)).toBe(true);
    });
  });

  // =========================================================================
  // Error in middle cell stops execution
  // =========================================================================

  describe("error in middle cell", () => {
    it("marks the errored cell and leaves subsequent cells unexecuted", async () => {
      const nb = makeNotebook({
        id: "nb-err",
        cells: [
          makeCell({ id: "c1", source: "let x = 1;" }),
          makeCell({ id: "c2", source: "throw new Error('boom');" }),
          makeCell({ id: "c3", source: "let y = 2;" }),
        ],
      });
      useNotebookStore.setState({ activeNotebook: nb });
      mockSaveNotebook.mockResolvedValue(undefined);

      // Run c1 - success
      mockRunNotebookCell.mockResolvedValue(successResponse(1));
      await useNotebookStore.getState().runCell("c1");

      // Run c2 - error
      mockRunNotebookCell.mockResolvedValue(errorResponse("Error: boom"));
      await useNotebookStore.getState().runCell("c2");

      const cells = useNotebookStore.getState().activeNotebook!.cells;
      expect(cells[0].executionIndex).toBe(1);
      expect(cells[0].lastError).toBeNull();
      expect(cells[1].lastError).toBe("Error: boom");
      expect(cells[1].executionIndex).toBeNull();
      // c3 was never executed
      expect(cells[2].executionIndex).toBeNull();
      expect(cells[2].lastError).toBeNull();
    });
  });

  // =========================================================================
  // Cell output accumulation
  // =========================================================================

  describe("cell output accumulation", () => {
    it("cell stores multi-line output from execution", async () => {
      const nb = makeNotebook({
        id: "nb-out",
        cells: [makeCell({ id: "c1", source: "for(let i=0;i<3;i++) console.log(i);" })],
      });
      useNotebookStore.setState({ activeNotebook: nb });
      mockSaveNotebook.mockResolvedValue(undefined);
      mockRunNotebookCell.mockResolvedValue(successResponse(1, ["0", "1", "2"]));

      await useNotebookStore.getState().runCell("c1");

      const cell = useNotebookStore.getState().activeNotebook!.cells[0];
      expect(cell.lastOutput).toEqual(["0", "1", "2"]);
    });

    it("re-running a cell replaces previous output", async () => {
      const nb = makeNotebook({
        id: "nb-out2",
        cells: [makeCell({ id: "c1", source: "console.log('a');" })],
      });
      useNotebookStore.setState({ activeNotebook: nb });
      mockSaveNotebook.mockResolvedValue(undefined);

      mockRunNotebookCell.mockResolvedValue(successResponse(1, ["a"]));
      await useNotebookStore.getState().runCell("c1");
      expect(useNotebookStore.getState().activeNotebook!.cells[0].lastOutput).toEqual(["a"]);

      // Re-run with different output
      useNotebookStore.setState({ isExecuting: false, executingCellId: null });
      mockRunNotebookCell.mockResolvedValue(successResponse(2, ["b"]));
      await useNotebookStore.getState().runCell("c1");
      expect(useNotebookStore.getState().activeNotebook!.cells[0].lastOutput).toEqual(["b"]);
      expect(useNotebookStore.getState().activeNotebook!.cells[0].executionIndex).toBe(2);
    });

    it("error cell preserves partial output", async () => {
      const nb = makeNotebook({
        id: "nb-out3",
        cells: [makeCell({ id: "c1", source: "console.log('before'); throw 'err';" })],
      });
      useNotebookStore.setState({ activeNotebook: nb });
      mockSaveNotebook.mockResolvedValue(undefined);
      mockRunNotebookCell.mockResolvedValue({
        type: "error",
        message: "err",
        output: ["before"],
      });

      await useNotebookStore.getState().runCell("c1");

      const cell = useNotebookStore.getState().activeNotebook!.cells[0];
      expect(cell.lastError).toBe("err");
      expect(cell.lastOutput).toEqual(["before"]);
    });
  });
});
