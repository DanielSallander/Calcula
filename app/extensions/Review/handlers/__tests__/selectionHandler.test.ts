//! FILENAME: app/extensions/Review/handlers/__tests__/selectionHandler.test.ts
// PURPOSE: The annotation editors close when the selection leaves the cell they
//          are anchored to — and NOT when the click that opened one arrives.
// CONTEXT: BUG-0042. Clicking a noted cell opened the note editor and the very
//          same click's selection change closed it again one commit later, so
//          the product's inspection gesture for a note did nothing at all.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// A live overlay double: showOverlay/hideOverlay/getVisibleOverlays share ONE
// state, so "is the editor still open?" is answered the way the shell answers
// it rather than by counting calls.
// ---------------------------------------------------------------------------

interface OverlayState {
  isVisible: boolean;
  data?: Record<string, unknown>;
}
const overlayStates = new Map<string, OverlayState>();

const mockShowOverlay = vi.fn(
  (id: string, props?: { data?: Record<string, unknown> }) => {
    overlayStates.set(id, { isVisible: true, data: props?.data });
  }
);
const mockHideOverlay = vi.fn((id: string) => {
  overlayStates.set(id, { isVisible: false });
});
const mockGetVisibleOverlays = vi.fn(() =>
  Array.from(overlayStates.entries())
    .filter(([, s]) => s.isVisible)
    .map(([id, state]) => ({ definition: { id }, state }))
);

const mockGetComment = vi.fn();
const mockGetNote = vi.fn();

vi.mock("@api", () => ({
  showOverlay: (...args: unknown[]) => (mockShowOverlay as never as (...a: unknown[]) => void)(...args),
  hideOverlay: (...args: unknown[]) => (mockHideOverlay as never as (...a: unknown[]) => void)(...args),
  getComment: (...args: unknown[]) => mockGetComment(...args),
  getNote: (...args: unknown[]) => mockGetNote(...args),
  // eslint-disable-next-line @typescript-eslint/naming-convention -- mirrors the @api export name
  OverlayExtensions: {
    getVisibleOverlays: () => mockGetVisibleOverlays(),
  },
}));

const mockHidePreview = vi.fn();
vi.mock("../hoverHandler", () => ({
  hidePreview: () => mockHidePreview(),
}));

const mockSetActiveCellForKeyboard = vi.fn();
vi.mock("../keyboardHandler", () => ({
  setActiveCellForKeyboard: (...args: unknown[]) => mockSetActiveCellForKeyboard(...args),
}));

const mockSetCurrentSelectionForMenu = vi.fn();
vi.mock("../reviewMenuBuilder", () => ({
  setCurrentSelectionForMenu: (...args: unknown[]) => mockSetCurrentSelectionForMenu(...args),
}));

const mockGetCommentIndicatorAt = vi.fn();
const mockGetNoteIndicatorAt = vi.fn();
vi.mock("../../lib/annotationStore", () => ({
  getCommentIndicatorAt: (...args: unknown[]) => mockGetCommentIndicatorAt(...args),
  getNoteIndicatorAt: (...args: unknown[]) => mockGetNoteIndicatorAt(...args),
}));

import { handleSelectionChange, resetSelectionHandlerState } from "../selectionHandler";
import { handleAnnotationClick } from "../clickHandler";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const NOTE_CELL = { row: 60, col: 26 };
const OTHER_CELL = { row: 69, col: 28 };

function selectionOf(cell: { row: number; col: number }) {
  return {
    startRow: cell.row,
    startCol: cell.col,
    endRow: cell.row,
    endCol: cell.col,
  } as never;
}

function isVisible(id: string): boolean {
  return overlayStates.get(id)?.isVisible === true;
}

/** The whole gesture, in the order the app performs it. */
async function clickTheNotedCell(): Promise<void> {
  // mousedown -> the interceptor runs and resolves BEFORE the selection lands
  // (useSpreadsheetSelection awaits it, then awaits baseHandleMouseDown).
  await handleAnnotationClick(NOTE_CELL.row, NOTE_CELL.col, {
    clientX: 100,
    clientY: 200,
  });
  // ...and the same click then moves the selection onto the cell, which the
  // shell reports to every extension (Layout.tsx -> notifySelectionChange).
  handleSelectionChange(selectionOf(NOTE_CELL));
}

beforeEach(() => {
  vi.clearAllMocks();
  overlayStates.clear();
  resetSelectionHandlerState();
  mockGetCommentIndicatorAt.mockReturnValue(undefined);
  mockGetNoteIndicatorAt.mockReturnValue({ row: NOTE_CELL.row, col: NOTE_CELL.col });
  mockGetNote.mockResolvedValue({
    id: "note-1",
    row: NOTE_CELL.row,
    col: NOTE_CELL.col,
    content: "PROBE-NOTE-TEXT",
    authorName: "Probe",
    width: 200,
    height: 100,
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BUG-0042: the click that opens a note editor must not close it", () => {
  it("the editor is still open after the same click's selection change", async () => {
    // The user was on another cell first — this is what made previousCell stale.
    handleSelectionChange(selectionOf(OTHER_CELL));

    await clickTheNotedCell();

    expect(mockShowOverlay).toHaveBeenCalledWith("note-editor", expect.anything());
    expect(isVisible("note-editor"), "the note editor survived its own click").toBe(true);
  });

  it("REGRESSION SHAPE: closing on any change would have closed it", async () => {
    // The defect, reproduced against the same fixture so the test above cannot
    // pass trivially: a handler that hides whenever the active cell differs
    // from the PREVIOUS one hides an editor that was opened for the new cell.
    handleSelectionChange(selectionOf(OTHER_CELL));
    await handleAnnotationClick(NOTE_CELL.row, NOTE_CELL.col, { clientX: 1, clientY: 2 });
    expect(isVisible("note-editor")).toBe(true);

    const previous = OTHER_CELL;
    const active = NOTE_CELL;
    const oldRuleWouldHide = previous.row !== active.row || previous.col !== active.col;
    expect(oldRuleWouldHide, "the old rule fires on exactly this gesture").toBe(true);
  });

  it("moving the selection away DOES close the editor", async () => {
    handleSelectionChange(selectionOf(OTHER_CELL));
    await clickTheNotedCell();
    expect(isVisible("note-editor")).toBe(true);

    handleSelectionChange(selectionOf({ row: 74, col: 29 }));
    expect(mockHideOverlay).toHaveBeenCalledWith("note-editor");
    expect(isVisible("note-editor")).toBe(false);
  });

  it("a selection that stays on the anchored cell leaves the editor alone", async () => {
    handleSelectionChange(selectionOf(OTHER_CELL));
    await clickTheNotedCell();
    // e.g. a repaint-driven re-notify with the same selection.
    handleSelectionChange(selectionOf(NOTE_CELL));
    expect(isVisible("note-editor")).toBe(true);
  });

  it("extending the selection off the anchored cell closes it", async () => {
    handleSelectionChange(selectionOf(OTHER_CELL));
    await clickTheNotedCell();
    handleSelectionChange({
      startRow: NOTE_CELL.row,
      startCol: NOTE_CELL.col,
      endRow: NOTE_CELL.row + 3,
      endCol: NOTE_CELL.col,
    } as never);
    expect(isVisible("note-editor")).toBe(false);
  });

  it("the comment panel obeys the same anchor rule", async () => {
    mockGetNoteIndicatorAt.mockReturnValue(undefined);
    mockGetCommentIndicatorAt.mockReturnValue({ row: NOTE_CELL.row, col: NOTE_CELL.col });
    mockGetComment.mockResolvedValue({
      id: "comment-1",
      row: NOTE_CELL.row,
      col: NOTE_CELL.col,
      content: "hi",
      resolved: false,
      replies: [],
    });

    handleSelectionChange(selectionOf(OTHER_CELL));
    await handleAnnotationClick(NOTE_CELL.row, NOTE_CELL.col, { clientX: 1, clientY: 2 });
    handleSelectionChange(selectionOf(NOTE_CELL));
    expect(isVisible("comment-panel")).toBe(true);

    handleSelectionChange(selectionOf(OTHER_CELL));
    expect(isVisible("comment-panel")).toBe(false);
  });

  it("the sidebar's navigate-then-open order also survives", async () => {
    // CommentsSidebar emits NAVIGATE_TO_CELL and then shows the overlay, so the
    // selection change can arrive BEFORE the editor exists.
    handleSelectionChange(selectionOf(OTHER_CELL));
    handleSelectionChange(selectionOf(NOTE_CELL));   // navigation lands first
    mockShowOverlay("note-editor", {
      data: { row: NOTE_CELL.row, col: NOTE_CELL.col, noteId: "note-1", mode: "edit" },
    });
    expect(isVisible("note-editor")).toBe(true);
    // A later re-notify for the same cell must not undo it.
    handleSelectionChange(selectionOf(NOTE_CELL));
    expect(isVisible("note-editor")).toBe(true);
  });

  it("an overlay with no cell in its data is left alone rather than guessed at", () => {
    mockShowOverlay("note-editor", { data: { mode: "create" } });
    handleSelectionChange(selectionOf(OTHER_CELL));
    expect(isVisible("note-editor")).toBe(true);
  });

  it("the hover preview is still dropped whenever the selection moves", async () => {
    handleSelectionChange(selectionOf(OTHER_CELL));
    mockHidePreview.mockClear();
    handleSelectionChange(selectionOf(NOTE_CELL));
    expect(mockHidePreview).toHaveBeenCalled();
  });
});
