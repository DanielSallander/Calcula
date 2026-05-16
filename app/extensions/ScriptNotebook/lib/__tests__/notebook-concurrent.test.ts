//! FILENAME: app/extensions/ScriptNotebook/lib/__tests__/notebook-concurrent.test.ts
// PURPOSE: Concurrency stress tests for the ScriptNotebook store.
// CONTEXT: Simulates rapid cell add/remove, overlapping runCell calls,
//          open/close sequences, and deletion during execution.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Mocks
// ============================================================================

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

vi.mock("../../lib/notebookApi", () => ({
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

// ============================================================================
// Helpers
// ============================================================================

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

function successResult(index: number) {
  return {
    type: "success",
    output: [`out-${index}`],
    cellsModified: 0,
    durationMs: 1,
    executionIndex: index,
    screenUpdating: true,
    enableEvents: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useNotebookStore.setState({
    notebooks: [],
    activeNotebook: null,
    isExecuting: false,
    executingCellId: null,
  });
});

// ============================================================================
// 1. Rapid cell add/remove while "running"
// ============================================================================

describe("rapid cell add/remove during execution", () => {
  it("adding 20 cells rapidly produces correct cell count", () => {
    const nb = makeNotebook({ cells: [makeCell({ id: "c1" })] });
    useNotebookStore.setState({ activeNotebook: nb });
    mockSaveNotebook.mockResolvedValue(undefined);
    mockListNotebooks.mockResolvedValue([]);

    for (let i = 0; i < 20; i++) {
      useNotebookStore.getState().addCell();
    }

    expect(useNotebookStore.getState().activeNotebook!.cells).toHaveLength(21);
  });

  it("alternating add/remove keeps store consistent", () => {
    const nb = makeNotebook({
      cells: [makeCell({ id: "c1" }), makeCell({ id: "c2" })],
    });
    useNotebookStore.setState({ activeNotebook: nb });
    mockSaveNotebook.mockResolvedValue(undefined);
    mockListNotebooks.mockResolvedValue([]);

    // Add 10, remove 5, add 5 more
    for (let i = 0; i < 10; i++) {
      useNotebookStore.getState().addCell();
    }
    const cells = useNotebookStore.getState().activeNotebook!.cells;
    expect(cells).toHaveLength(12);

    // Remove 5 cells (skip the first to avoid "last cell" guard)
    for (let i = 0; i < 5; i++) {
      const currentCells = useNotebookStore.getState().activeNotebook!.cells;
      if (currentCells.length > 1) {
        useNotebookStore.getState().removeCell(currentCells[currentCells.length - 1].id);
      }
    }
    expect(useNotebookStore.getState().activeNotebook!.cells).toHaveLength(7);

    for (let i = 0; i < 5; i++) {
      useNotebookStore.getState().addCell();
    }
    expect(useNotebookStore.getState().activeNotebook!.cells).toHaveLength(12);
  });

  it("adding cells while isExecuting flag is set does not corrupt state", () => {
    const nb = makeNotebook({ cells: [makeCell({ id: "c1" })] });
    useNotebookStore.setState({ activeNotebook: nb, isExecuting: true, executingCellId: "c1" });
    mockSaveNotebook.mockResolvedValue(undefined);
    mockListNotebooks.mockResolvedValue([]);

    // Add cells even though "executing"
    for (let i = 0; i < 5; i++) {
      useNotebookStore.getState().addCell();
    }

    const state = useNotebookStore.getState();
    expect(state.activeNotebook!.cells).toHaveLength(6);
    // Execution state is preserved
    expect(state.isExecuting).toBe(true);
    expect(state.executingCellId).toBe("c1");
  });

  it("removeCell on executing cell does not crash", () => {
    const nb = makeNotebook({
      cells: [makeCell({ id: "c1" }), makeCell({ id: "c2" })],
    });
    useNotebookStore.setState({ activeNotebook: nb, isExecuting: true, executingCellId: "c1" });
    mockSaveNotebook.mockResolvedValue(undefined);
    mockListNotebooks.mockResolvedValue([]);

    // Remove the executing cell
    useNotebookStore.getState().removeCell("c1");

    const state = useNotebookStore.getState();
    expect(state.activeNotebook!.cells).toHaveLength(1);
    expect(state.activeNotebook!.cells[0].id).toBe("c2");
  });
});

// ============================================================================
// 2. Open/close notebooks in sequence
// ============================================================================

describe("sequential open/close operations", () => {
  it("open 5 notebooks in rapid sequence - last one wins", async () => {
    const notebooks = Array.from({ length: 5 }, (_, i) =>
      makeNotebook({ id: `nb-${i}`, name: `Notebook ${i}` })
    );

    mockResetNotebookRuntime.mockResolvedValue(undefined);
    mockSaveNotebook.mockResolvedValue(undefined);

    for (let i = 0; i < 5; i++) {
      mockLoadNotebook.mockResolvedValueOnce(notebooks[i]);
    }

    // Open them sequentially (each open should work)
    for (let i = 0; i < 5; i++) {
      await useNotebookStore.getState().openNotebook(`nb-${i}`);
    }

    const state = useNotebookStore.getState();
    expect(state.activeNotebook).toBeDefined();
    expect(state.activeNotebook!.id).toBe("nb-4");
  });

  it("open then immediately close does not leave dangling state", async () => {
    const nb = makeNotebook({ id: "nb-open-close" });
    mockResetNotebookRuntime.mockResolvedValue(undefined);
    mockLoadNotebook.mockResolvedValue(nb);
    mockSaveNotebook.mockResolvedValue(undefined);

    await useNotebookStore.getState().openNotebook("nb-open-close");
    expect(useNotebookStore.getState().activeNotebook).toBeDefined();

    await useNotebookStore.getState().closeNotebook();
    expect(useNotebookStore.getState().activeNotebook).toBeNull();
    expect(useNotebookStore.getState().isExecuting).toBe(false);
  });

  it("close with no active notebook is safe to call repeatedly", async () => {
    for (let i = 0; i < 10; i++) {
      await useNotebookStore.getState().closeNotebook();
    }
    expect(mockSaveNotebook).not.toHaveBeenCalled();
    expect(useNotebookStore.getState().activeNotebook).toBeNull();
  });

  it("open-close-open cycle restores clean state", async () => {
    const nb1 = makeNotebook({ id: "nb-1", name: "First" });
    const nb2 = makeNotebook({ id: "nb-2", name: "Second" });

    mockResetNotebookRuntime.mockResolvedValue(undefined);
    mockSaveNotebook.mockResolvedValue(undefined);
    mockLoadNotebook
      .mockResolvedValueOnce(nb1)
      .mockResolvedValueOnce(nb2);

    await useNotebookStore.getState().openNotebook("nb-1");
    expect(useNotebookStore.getState().activeNotebook!.name).toBe("First");

    await useNotebookStore.getState().closeNotebook();
    await useNotebookStore.getState().openNotebook("nb-2");
    expect(useNotebookStore.getState().activeNotebook!.name).toBe("Second");
  });
});

// ============================================================================
// 3. Multiple runCell calls overlapping
// ============================================================================

describe("overlapping runCell calls", () => {
  it("second runCell is rejected while first is executing", async () => {
    const nb = makeNotebook({
      cells: [makeCell({ id: "c1" }), makeCell({ id: "c2" })],
    });
    useNotebookStore.setState({ activeNotebook: nb });

    let resolveRun!: (v: unknown) => void;
    mockSaveNotebook.mockResolvedValue(undefined);
    mockRunNotebookCell.mockImplementation(
      () => new Promise((r) => (resolveRun = r))
    );

    // Start first run
    const run1 = useNotebookStore.getState().runCell("c1");

    // Attempt second run while first is in-flight
    const run2 = useNotebookStore.getState().runCell("c2");
    await run2; // Should return immediately (isExecuting guard)

    // Second cell should NOT have been sent to backend
    // mockRunNotebookCell is called once (for c1 only)
    expect(mockRunNotebookCell).toHaveBeenCalledTimes(1);

    // Complete first run
    resolveRun(successResult(1));
    await run1;

    expect(useNotebookStore.getState().isExecuting).toBe(false);
  });

  it("runAll while runCell is in progress is rejected", async () => {
    const nb = makeNotebook({
      cells: [makeCell({ id: "c1" }), makeCell({ id: "c2" })],
    });
    useNotebookStore.setState({ activeNotebook: nb });

    let resolveRun!: (v: unknown) => void;
    mockSaveNotebook.mockResolvedValue(undefined);
    mockRunNotebookCell.mockImplementation(
      () => new Promise((r) => (resolveRun = r))
    );

    const run1 = useNotebookStore.getState().runCell("c1");

    // Try runAll while executing
    await useNotebookStore.getState().runAll();
    expect(mockRunAllCells).not.toHaveBeenCalled();

    resolveRun(successResult(1));
    await run1;
  });

  it("runCell after runAll completes works correctly", async () => {
    const nb = makeNotebook({
      cells: [makeCell({ id: "c1" }), makeCell({ id: "c2" })],
    });
    const reloadedNb = makeNotebook({
      id: "nb-1",
      cells: [
        makeCell({ id: "c1", executionIndex: 1 }),
        makeCell({ id: "c2", executionIndex: 2 }),
      ],
    });

    useNotebookStore.setState({ activeNotebook: nb });
    mockSaveNotebook.mockResolvedValue(undefined);
    mockRunAllCells.mockResolvedValue([successResult(1), successResult(2)]);
    mockLoadNotebook.mockResolvedValue(reloadedNb);

    await useNotebookStore.getState().runAll();
    expect(useNotebookStore.getState().isExecuting).toBe(false);

    // Now runCell should work
    mockRunNotebookCell.mockResolvedValue(successResult(3));
    await useNotebookStore.getState().runCell("c1");

    expect(mockRunNotebookCell).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// 4. Delete notebook while cells are "running"
// ============================================================================

describe("delete during execution", () => {
  it("deleteNotebook while cells are running clears active notebook", async () => {
    const nb = makeNotebook({ id: "nb-del" });
    useNotebookStore.setState({ activeNotebook: nb, isExecuting: true, executingCellId: "c1" });
    mockDeleteNotebook.mockResolvedValue(undefined);
    mockListNotebooks.mockResolvedValue([]);

    await useNotebookStore.getState().deleteNotebook("nb-del");

    const state = useNotebookStore.getState();
    expect(state.activeNotebook).toBeNull();
  });

  it("deleting a different notebook while executing preserves active", async () => {
    const nb = makeNotebook({ id: "nb-active" });
    useNotebookStore.setState({ activeNotebook: nb, isExecuting: true, executingCellId: "c1" });
    mockDeleteNotebook.mockResolvedValue(undefined);
    mockListNotebooks.mockResolvedValue([]);

    await useNotebookStore.getState().deleteNotebook("nb-other");

    const state = useNotebookStore.getState();
    expect(state.activeNotebook).toBeDefined();
    expect(state.activeNotebook!.id).toBe("nb-active");
    expect(state.isExecuting).toBe(true);
  });

  it("rapid create-delete cycles do not leak state", async () => {
    mockListNotebooks.mockResolvedValue([]);
    mockDeleteNotebook.mockResolvedValue(undefined);

    for (let i = 0; i < 10; i++) {
      const nb = makeNotebook({ id: `nb-cycle-${i}` });
      mockCreateNotebook.mockResolvedValueOnce(nb);
      await useNotebookStore.getState().createNotebook(`Cycle ${i}`);
      await useNotebookStore.getState().deleteNotebook(`nb-cycle-${i}`);
    }

    expect(useNotebookStore.getState().activeNotebook).toBeNull();
  });
});

// ============================================================================
// 5. Cell source updates during execution
// ============================================================================

describe("cell source updates during execution", () => {
  it("updateCellSource while executing does not corrupt cell list", async () => {
    const nb = makeNotebook({
      cells: [
        makeCell({ id: "c1", source: "original" }),
        makeCell({ id: "c2", source: "keep" }),
      ],
    });
    useNotebookStore.setState({ activeNotebook: nb, isExecuting: true, executingCellId: "c1" });

    // Update source of both cells during "execution"
    useNotebookStore.getState().updateCellSource("c1", "modified-during-exec");
    useNotebookStore.getState().updateCellSource("c2", "also-modified");

    const cells = useNotebookStore.getState().activeNotebook!.cells;
    expect(cells).toHaveLength(2);
    expect(cells[0].source).toBe("modified-during-exec");
    expect(cells[1].source).toBe("also-modified");
  });

  it("rapid updateCellSource 50 times converges to final value", () => {
    const nb = makeNotebook({ cells: [makeCell({ id: "c1", source: "" })] });
    useNotebookStore.setState({ activeNotebook: nb });

    for (let i = 0; i < 50; i++) {
      useNotebookStore.getState().updateCellSource("c1", `version-${i}`);
    }

    expect(useNotebookStore.getState().activeNotebook!.cells[0].source).toBe("version-49");
  });

  it("moveCellUp/Down rapidly does not lose cells", () => {
    const nb = makeNotebook({
      cells: [
        makeCell({ id: "c1" }),
        makeCell({ id: "c2" }),
        makeCell({ id: "c3" }),
        makeCell({ id: "c4" }),
      ],
    });
    useNotebookStore.setState({ activeNotebook: nb });

    // Shuffle cells rapidly
    for (let i = 0; i < 20; i++) {
      useNotebookStore.getState().moveCellDown("c1");
      useNotebookStore.getState().moveCellUp("c4");
    }

    const cells = useNotebookStore.getState().activeNotebook!.cells;
    expect(cells).toHaveLength(4);
    const ids = cells.map((c) => c.id).sort();
    expect(ids).toEqual(["c1", "c2", "c3", "c4"]);
  });
});
