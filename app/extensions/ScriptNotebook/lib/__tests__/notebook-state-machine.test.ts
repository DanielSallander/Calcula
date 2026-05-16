//! FILENAME: app/extensions/ScriptNotebook/lib/__tests__/notebook-state-machine.test.ts
// PURPOSE: State machine tests for the notebook store.
// CONTEXT: Models notebook and cell states, verifies transitions and execution guards.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Declare mock fns before vi.mock
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

vi.mock('../notebookApi', () => ({
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

vi.mock('@api/backend', () => ({
  invokeBackend: vi.fn(),
}));

vi.stubGlobal('dispatchEvent', vi.fn());
vi.stubGlobal('CustomEvent', class CE {
  type: string;
  detail: unknown;
  constructor(t: string, o?: { detail?: unknown }) { this.type = t; this.detail = o?.detail; }
});

import { useNotebookStore } from '../useNotebookStore';
import type { NotebookCell, NotebookDocument } from '../../types';

function makeCell(overrides: Partial<NotebookCell> = {}): NotebookCell {
  return {
    id: `cell-${Math.random()}`,
    source: '',
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
    id: 'nb-1',
    name: 'Test',
    cells: [makeCell({ id: 'c1' })],
    ...overrides,
  };
}

const getState = () => useNotebookStore.getState();

const successResponse = (idx = 1) => ({
  type: 'success' as const,
  output: ['ok'],
  cellsModified: 0,
  durationMs: 5,
  executionIndex: idx,
  screenUpdating: true,
  enableEvents: true,
});

const errorResponse = (msg = 'Error') => ({
  type: 'error' as const,
  message: msg,
  output: [],
});

describe('Notebook Store - State Machine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useNotebookStore.setState({
      notebooks: [],
      activeNotebook: null,
      isExecuting: false,
      executingCellId: null,
    });
    // Set up ALL default mocks
    mockListNotebooks.mockResolvedValue([]);
    mockSaveNotebook.mockResolvedValue(undefined);
    mockResetNotebookRuntime.mockResolvedValue(undefined);
    mockDeleteNotebook.mockResolvedValue(undefined);
    mockCreateNotebook.mockResolvedValue(makeNotebook());
    mockLoadNotebook.mockResolvedValue(makeNotebook());
    mockRunNotebookCell.mockResolvedValue(successResponse());
    mockRunAllCells.mockResolvedValue([successResponse()]);
    mockRewindNotebook.mockResolvedValue([]);
    mockRunFromCell.mockResolvedValue([]);
  });

  // ============================================================================
  // Notebook-level states: no-notebook -> has-notebook
  // ============================================================================

  it('starts in no-notebook state', () => {
    expect(getState().activeNotebook).toBeNull();
    expect(getState().isExecuting).toBe(false);
    expect(getState().executingCellId).toBeNull();
  });

  it('no-notebook -> has-notebook: createNotebook', async () => {
    const nb = makeNotebook({ name: 'Created' });
    mockCreateNotebook.mockResolvedValue(nb);
    await getState().createNotebook('Created');
    expect(getState().activeNotebook).not.toBeNull();
  });

  it('no-notebook -> has-notebook: openNotebook', async () => {
    const nb = makeNotebook({ id: 'nb-open' });
    mockLoadNotebook.mockResolvedValue(nb);
    await getState().openNotebook('nb-open');
    expect(getState().activeNotebook!.id).toBe('nb-open');
  });

  it('has-notebook -> no-notebook: closeNotebook', async () => {
    useNotebookStore.setState({ activeNotebook: makeNotebook() });
    await getState().closeNotebook();
    expect(getState().activeNotebook).toBeNull();
  });

  it('has-notebook -> no-notebook: deleteNotebook (active)', async () => {
    useNotebookStore.setState({ activeNotebook: makeNotebook({ id: 'nb-1' }) });
    await getState().deleteNotebook('nb-1');
    expect(getState().activeNotebook).toBeNull();
  });

  it('has-notebook -> has-notebook: deleteNotebook (different id)', async () => {
    useNotebookStore.setState({ activeNotebook: makeNotebook({ id: 'nb-1' }) });
    await getState().deleteNotebook('nb-other');
    expect(getState().activeNotebook!.id).toBe('nb-1');
  });

  it('has-notebook -> has-notebook: switch notebooks via openNotebook', async () => {
    useNotebookStore.setState({ activeNotebook: makeNotebook({ id: 'nb-1' }) });
    const nb2 = makeNotebook({ id: 'nb-2' });
    mockLoadNotebook.mockResolvedValue(nb2);
    await getState().openNotebook('nb-2');
    expect(getState().activeNotebook!.id).toBe('nb-2');
    expect(mockResetNotebookRuntime).toHaveBeenCalled();
  });

  // ============================================================================
  // Execution state guards
  // ============================================================================

  it('runCell transitions: not executing -> executing -> completed', async () => {
    const nb = makeNotebook({ cells: [makeCell({ id: 'c1', source: 'x' })] });
    useNotebookStore.setState({ activeNotebook: nb });
    expect(getState().isExecuting).toBe(false);
    await getState().runCell('c1');
    expect(getState().isExecuting).toBe(false);
    expect(getState().executingCellId).toBeNull();
  });

  it('execution guard: runCell blocked when isExecuting=true', async () => {
    useNotebookStore.setState({
      activeNotebook: makeNotebook({ cells: [makeCell({ id: 'c1', source: 'a' })] }),
      isExecuting: true,
    });
    await getState().runCell('c1');
    expect(mockRunNotebookCell).not.toHaveBeenCalled();
  });

  it('execution guard: runAll blocked when isExecuting=true', async () => {
    useNotebookStore.setState({ activeNotebook: makeNotebook(), isExecuting: true });
    await getState().runAll();
    expect(mockRunAllCells).not.toHaveBeenCalled();
  });

  it('execution guard: rewindToCell blocked when isExecuting=true', async () => {
    useNotebookStore.setState({ activeNotebook: makeNotebook(), isExecuting: true });
    await getState().rewindToCell('c1');
    expect(mockRewindNotebook).not.toHaveBeenCalled();
  });

  it('execution guard: runFromCell blocked when isExecuting=true', async () => {
    useNotebookStore.setState({ activeNotebook: makeNotebook(), isExecuting: true });
    await getState().runFromCell('c1');
    expect(mockRunFromCell).not.toHaveBeenCalled();
  });

  it('runCell is no-op without active notebook', async () => {
    await getState().runCell('c1');
    expect(mockRunNotebookCell).not.toHaveBeenCalled();
  });

  it('runAll is no-op without active notebook', async () => {
    await getState().runAll();
    expect(mockRunAllCells).not.toHaveBeenCalled();
  });

  // ============================================================================
  // Cell-level states: empty -> has-code -> has-output/has-error
  // ============================================================================

  it('cell starts empty', () => {
    useNotebookStore.setState({ activeNotebook: makeNotebook({ cells: [makeCell({ id: 'c1' })] }) });
    const cell = getState().activeNotebook!.cells[0];
    expect(cell.source).toBe('');
    expect(cell.lastOutput).toEqual([]);
    expect(cell.lastError).toBeNull();
    expect(cell.executionIndex).toBeNull();
  });

  it('empty -> has-code: updateCellSource', () => {
    useNotebookStore.setState({ activeNotebook: makeNotebook({ cells: [makeCell({ id: 'c1' })] }) });
    getState().updateCellSource('c1', 'let x = 42;');
    expect(getState().activeNotebook!.cells[0].source).toBe('let x = 42;');
  });

  it('has-code -> has-output: successful runCell', async () => {
    useNotebookStore.setState({
      activeNotebook: makeNotebook({ cells: [makeCell({ id: 'c1', source: 'x' })] }),
    });
    mockRunNotebookCell.mockResolvedValue(successResponse(1));
    await getState().runCell('c1');
    const cell = getState().activeNotebook!.cells[0];
    expect(cell.lastOutput).toEqual(['ok']);
    expect(cell.lastError).toBeNull();
    expect(cell.executionIndex).toBe(1);
  });

  it('has-code -> has-error: failed runCell', async () => {
    useNotebookStore.setState({
      activeNotebook: makeNotebook({ cells: [makeCell({ id: 'c1', source: 'throw' })] }),
    });
    mockRunNotebookCell.mockResolvedValue(errorResponse('ReferenceError'));
    await getState().runCell('c1');
    const cell = getState().activeNotebook!.cells[0];
    expect(cell.lastError).toBe('ReferenceError');
    expect(cell.executionIndex).toBeNull();
  });

  // ============================================================================
  // Cell management
  // ============================================================================

  it('addCell adds a new cell', () => {
    useNotebookStore.setState({ activeNotebook: makeNotebook({ cells: [makeCell({ id: 'c1' })] }) });
    getState().addCell();
    expect(getState().activeNotebook!.cells.length).toBe(2);
  });

  it('addCell after specific cell', () => {
    useNotebookStore.setState({
      activeNotebook: makeNotebook({ cells: [makeCell({ id: 'c1' }), makeCell({ id: 'c2' })] }),
    });
    getState().addCell('c1');
    expect(getState().activeNotebook!.cells.length).toBe(3);
    expect(getState().activeNotebook!.cells[0].id).toBe('c1');
    expect(getState().activeNotebook!.cells[2].id).toBe('c2');
  });

  it('removeCell keeps last cell', () => {
    useNotebookStore.setState({ activeNotebook: makeNotebook({ cells: [makeCell({ id: 'c1' })] }) });
    getState().removeCell('c1');
    expect(getState().activeNotebook!.cells.length).toBe(1);
  });

  it('removeCell removes non-last cell', () => {
    useNotebookStore.setState({
      activeNotebook: makeNotebook({ cells: [makeCell({ id: 'c1' }), makeCell({ id: 'c2' })] }),
    });
    getState().removeCell('c1');
    expect(getState().activeNotebook!.cells.length).toBe(1);
    expect(getState().activeNotebook!.cells[0].id).toBe('c2');
  });

  it('moveCellUp swaps with predecessor', () => {
    useNotebookStore.setState({
      activeNotebook: makeNotebook({ cells: [makeCell({ id: 'c1' }), makeCell({ id: 'c2' })] }),
    });
    getState().moveCellUp('c2');
    expect(getState().activeNotebook!.cells[0].id).toBe('c2');
  });

  it('moveCellDown swaps with successor', () => {
    useNotebookStore.setState({
      activeNotebook: makeNotebook({ cells: [makeCell({ id: 'c1' }), makeCell({ id: 'c2' })] }),
    });
    getState().moveCellDown('c1');
    expect(getState().activeNotebook!.cells[0].id).toBe('c2');
  });

  it('no-notebook: cell operations are safe no-ops', () => {
    getState().addCell();
    getState().removeCell('x');
    getState().updateCellSource('x', 'code');
    getState().moveCellUp('x');
    getState().moveCellDown('x');
    expect(getState().activeNotebook).toBeNull();
  });

  // ============================================================================
  // Full lifecycle
  // ============================================================================

  it('full lifecycle: open -> edit -> run success -> run error -> fix -> close', async () => {
    // Open
    const nb = makeNotebook({ cells: [makeCell({ id: 'c1' }), makeCell({ id: 'c2' })] });
    mockLoadNotebook.mockResolvedValue(nb);
    await getState().openNotebook('nb-1');

    // Edit
    getState().updateCellSource('c1', 'let a = 1;');
    getState().updateCellSource('c2', 'bad code');

    // Run c1 success
    mockRunNotebookCell.mockResolvedValue(successResponse(1));
    await getState().runCell('c1');
    expect(getState().activeNotebook!.cells[0].executionIndex).toBe(1);

    // Run c2 error
    mockRunNotebookCell.mockResolvedValue(errorResponse('SyntaxError'));
    await getState().runCell('c2');
    expect(getState().activeNotebook!.cells[1].lastError).toBe('SyntaxError');

    // Fix and re-run c2
    getState().updateCellSource('c2', 'let b = 2;');
    mockRunNotebookCell.mockResolvedValue(successResponse(2));
    await getState().runCell('c2');
    expect(getState().activeNotebook!.cells[1].lastError).toBeNull();
    expect(getState().activeNotebook!.cells[1].executionIndex).toBe(2);

    // Close
    await getState().closeNotebook();
    expect(getState().activeNotebook).toBeNull();
    expect(getState().isExecuting).toBe(false);
  });
});
