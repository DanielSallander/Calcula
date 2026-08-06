//! FILENAME: app/extensions/Review/handlers/__tests__/hoverHandler.test.ts
// PURPOSE: The note hover preview - mounting, teardown, delay, no-flicker, and
//          not fighting the note editor.
// CONTEXT: Regression cover for the defect where initHoverHandler had no caller
//          at all, so hovering a noted cell showed nothing.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockShowOverlay = vi.fn();
const mockHideOverlay = vi.fn();
const mockGetComment = vi.fn();
const mockGetNote = vi.fn();
const mockGetVisibleOverlays = vi.fn(() => [] as Array<{ definition: { id: string } }>);

vi.mock("@api", () => ({
  showOverlay: (...args: unknown[]) => mockShowOverlay(...args),
  hideOverlay: (...args: unknown[]) => mockHideOverlay(...args),
  getComment: (...args: unknown[]) => mockGetComment(...args),
  getNote: (...args: unknown[]) => mockGetNote(...args),
  // eslint-disable-next-line @typescript-eslint/naming-convention -- mirrors the @api export name
  OverlayExtensions: {
    getVisibleOverlays: () => mockGetVisibleOverlays(),
  },
}));

const mockGetCellFromPixel = vi.fn();
const mockGetGridStateSnapshot = vi.fn();
vi.mock("@api/grid", () => ({
  getCellFromPixel: (...args: unknown[]) => mockGetCellFromPixel(...args),
  getGridStateSnapshot: () => mockGetGridStateSnapshot(),
}));

const mockGetGridCanvas = vi.fn();
vi.mock("@api/rendering", () => ({
  getGridCanvas: () => mockGetGridCanvas(),
}));

const mockGetCommentIndicatorAt = vi.fn();
const mockGetNoteIndicatorAt = vi.fn();
vi.mock("../../lib/annotationStore", () => ({
  getCommentIndicatorAt: (...args: unknown[]) => mockGetCommentIndicatorAt(...args),
  getNoteIndicatorAt: (...args: unknown[]) => mockGetNoteIndicatorAt(...args),
}));

import {
  initHoverHandler,
  destroyHoverHandler,
  hidePreview,
  isHoverHandlerMounted,
} from "../hoverHandler";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const HOVER_DELAY = 350;

let canvas: HTMLCanvasElement;

/** Move the pointer over the grid canvas; the cell is whatever the mock says. */
function hover(clientX: number, clientY: number, buttons = 0): void {
  canvas.dispatchEvent(
    new MouseEvent("mousemove", { clientX, clientY, buttons, bubbles: true })
  );
}

function hoverElsewhere(): void {
  document.body.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
}

/** Cell lookup keyed off x: every 100px is a new column. */
function cellFromX(x: number) {
  return { row: 1, col: Math.floor(x / 100) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();

  canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect;
  document.body.appendChild(canvas);

  mockGetGridCanvas.mockReturnValue(canvas);
  mockGetGridStateSnapshot.mockReturnValue({
    config: { rowHeaderWidth: 50, colHeaderHeight: 24 },
    viewport: { scrollX: 0, scrollY: 0 },
    dimensions: { columnWidths: new Map(), rowHeights: new Map() },
    freezeConfig: { freezeRow: null, freezeCol: null },
    zoom: 1,
  });
  mockGetCellFromPixel.mockImplementation((x: number) => cellFromX(x));
  mockGetVisibleOverlays.mockReturnValue([]);
  mockGetCommentIndicatorAt.mockReturnValue(null);
  mockGetNoteIndicatorAt.mockReturnValue(null);
  mockGetNote.mockResolvedValue({
    id: "n1",
    authorName: "Ada",
    content: "check this",
  });
  mockGetComment.mockResolvedValue({
    id: "c1",
    authorName: "Ada",
    content: "why?",
    resolved: false,
    replies: [],
  });
});

afterEach(() => {
  destroyHoverHandler();
  canvas.remove();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Mount / unmount
// ---------------------------------------------------------------------------

describe("mounting", () => {
  it("is not mounted until initHoverHandler runs", () => {
    expect(isHoverHandlerMounted()).toBe(false);
    mockGetNoteIndicatorAt.mockReturnValue({ row: 1, col: 1 });

    hover(150, 40);
    vi.advanceTimersByTime(HOVER_DELAY * 2);

    expect(mockShowOverlay).not.toHaveBeenCalled();
  });

  it("registers exactly one set of listeners even if activated twice", () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    initHoverHandler();
    const afterFirst = addSpy.mock.calls.length;
    initHoverHandler();

    expect(addSpy.mock.calls.length).toBe(afterFirst);
    expect(isHoverHandlerMounted()).toBe(true);
    addSpy.mockRestore();
  });

  it("removes every listener it added on teardown", () => {
    const added: string[] = [];
    const removed: string[] = [];
    const addSpy = vi
      .spyOn(document, "addEventListener")
      .mockImplementation(((type: string) => {
        added.push(type);
      }) as never);
    const removeSpy = vi
      .spyOn(document, "removeEventListener")
      .mockImplementation(((type: string) => {
        removed.push(type);
      }) as never);

    initHoverHandler();
    destroyHoverHandler();

    expect(added.sort()).toEqual(removed.sort());
    expect(added.length).toBeGreaterThan(0);
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it("cannot survive deactivation: a pending preview never appears", async () => {
    initHoverHandler();
    mockGetNoteIndicatorAt.mockReturnValue({ row: 1, col: 1 });
    hover(150, 40);

    destroyHoverHandler();
    await vi.advanceTimersByTimeAsync(HOVER_DELAY * 2);

    expect(mockShowOverlay).not.toHaveBeenCalled();
    expect(isHoverHandlerMounted()).toBe(false);
  });

  it("stops reacting to the pointer after teardown", async () => {
    initHoverHandler();
    destroyHoverHandler();
    mockGetNoteIndicatorAt.mockReturnValue({ row: 1, col: 1 });

    hover(150, 40);
    await vi.advanceTimersByTimeAsync(HOVER_DELAY * 2);

    expect(mockShowOverlay).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Preview behaviour
// ---------------------------------------------------------------------------

describe("hover preview", () => {
  beforeEach(() => {
    initHoverHandler();
  });

  it("shows the note after the hover delay", async () => {
    mockGetNoteIndicatorAt.mockReturnValue({ row: 1, col: 1 });

    hover(150, 40);
    expect(mockShowOverlay).not.toHaveBeenCalled(); // not immediately

    await vi.advanceTimersByTimeAsync(HOVER_DELAY);

    expect(mockShowOverlay).toHaveBeenCalledTimes(1);
    const [id, options] = mockShowOverlay.mock.calls[0] as [
      string,
      { data: Record<string, unknown> },
    ];
    expect(id).toBe("annotation-preview");
    expect(options.data).toMatchObject({
      type: "note",
      authorName: "Ada",
      content: "check this",
    });
  });

  it("prefers the comment when a cell carries both", async () => {
    mockGetNoteIndicatorAt.mockReturnValue({ row: 1, col: 1 });
    mockGetCommentIndicatorAt.mockReturnValue({ row: 1, col: 1, resolved: false });

    hover(150, 40);
    await vi.advanceTimersByTimeAsync(HOVER_DELAY);

    expect((mockShowOverlay.mock.calls[0][1] as { data: { type: string } }).data.type).toBe(
      "comment"
    );
  });

  it("shows nothing for a cell without an indicator", async () => {
    hover(150, 40);
    await vi.advanceTimersByTimeAsync(HOVER_DELAY * 2);

    expect(mockShowOverlay).not.toHaveBeenCalled();
    expect(mockGetNote).not.toHaveBeenCalled();
  });

  it("does not re-show or restart while the pointer stays in the same cell", async () => {
    mockGetNoteIndicatorAt.mockReturnValue({ row: 1, col: 1 });

    hover(150, 40);
    await vi.advanceTimersByTimeAsync(HOVER_DELAY / 2);
    hover(170, 45); // same cell, still moving
    hover(190, 48);
    await vi.advanceTimersByTimeAsync(HOVER_DELAY / 2);

    // The delay was NOT restarted by the intra-cell movement...
    expect(mockShowOverlay).toHaveBeenCalledTimes(1);

    hover(195, 49); // ...and moving again does not re-show (no flicker)
    await vi.advanceTimersByTimeAsync(HOVER_DELAY * 2);
    expect(mockShowOverlay).toHaveBeenCalledTimes(1);
    expect(mockHideOverlay).not.toHaveBeenCalled();
  });

  it("cancels a pending preview when the pointer moves to another cell", async () => {
    mockGetNoteIndicatorAt.mockImplementation((_row: number, col: number) =>
      col === 1 ? { row: 1, col: 1 } : null
    );

    hover(150, 40);
    await vi.advanceTimersByTimeAsync(HOVER_DELAY - 50);
    hover(350, 40); // different cell, no annotation
    await vi.advanceTimersByTimeAsync(HOVER_DELAY * 2);

    expect(mockShowOverlay).not.toHaveBeenCalled();
  });

  it("hides a visible preview when the pointer leaves the annotated cell", async () => {
    mockGetNoteIndicatorAt.mockImplementation((_row: number, col: number) =>
      col === 1 ? { row: 1, col: 1 } : null
    );

    hover(150, 40);
    await vi.advanceTimersByTimeAsync(HOVER_DELAY);
    expect(mockShowOverlay).toHaveBeenCalledTimes(1);

    hover(350, 40);
    expect(mockHideOverlay).toHaveBeenCalledWith("annotation-preview");
  });

  it("hides the preview when the pointer leaves the grid canvas", async () => {
    mockGetNoteIndicatorAt.mockReturnValue({ row: 1, col: 1 });

    hover(150, 40);
    await vi.advanceTimersByTimeAsync(HOVER_DELAY);
    hoverElsewhere();

    expect(mockHideOverlay).toHaveBeenCalledWith("annotation-preview");
  });

  it("hides the preview on scroll", async () => {
    mockGetNoteIndicatorAt.mockReturnValue({ row: 1, col: 1 });

    hover(150, 40);
    await vi.advanceTimersByTimeAsync(HOVER_DELAY);
    document.dispatchEvent(new Event("wheel", { bubbles: true }));

    expect(mockHideOverlay).toHaveBeenCalledWith("annotation-preview");
  });

  it("ignores hovering over headers (no cell under the pointer)", async () => {
    mockGetNoteIndicatorAt.mockReturnValue({ row: 1, col: 1 });
    mockGetCellFromPixel.mockReturnValue(null);

    hover(10, 10);
    await vi.advanceTimersByTimeAsync(HOVER_DELAY * 2);

    expect(mockShowOverlay).not.toHaveBeenCalled();
  });

  it("does not preview mid-drag", async () => {
    mockGetNoteIndicatorAt.mockReturnValue({ row: 1, col: 1 });

    hover(150, 40, 1); // primary button held: selection drag
    await vi.advanceTimersByTimeAsync(HOVER_DELAY * 2);

    expect(mockShowOverlay).not.toHaveBeenCalled();
  });

  it("does not fight the note editor while it is open", async () => {
    mockGetNoteIndicatorAt.mockReturnValue({ row: 1, col: 1 });
    mockGetVisibleOverlays.mockReturnValue([{ definition: { id: "note-editor" } }]);

    hover(150, 40);
    await vi.advanceTimersByTimeAsync(HOVER_DELAY * 2);

    expect(mockShowOverlay).not.toHaveBeenCalled();
  });

  it("does not show a preview that the editor opened during the delay", async () => {
    mockGetNoteIndicatorAt.mockReturnValue({ row: 1, col: 1 });

    hover(150, 40);
    await vi.advanceTimersByTimeAsync(HOVER_DELAY - 50);
    mockGetVisibleOverlays.mockReturnValue([{ definition: { id: "comment-panel" } }]);
    await vi.advanceTimersByTimeAsync(HOVER_DELAY);

    expect(mockShowOverlay).not.toHaveBeenCalled();
  });

  it("drops a fetch that resolves after the pointer moved on", async () => {
    mockGetNoteIndicatorAt.mockReturnValue({ row: 1, col: 1 });
    let resolveNote: (v: unknown) => void = () => {};
    mockGetNote.mockReturnValue(
      new Promise((resolve) => {
        resolveNote = resolve;
      })
    );

    hover(150, 40);
    await vi.advanceTimersByTimeAsync(HOVER_DELAY);
    hidePreview(); // e.g. the click handler opened the editor
    resolveNote({ id: "n1", authorName: "Ada", content: "late" });
    await Promise.resolve();

    expect(mockShowOverlay).not.toHaveBeenCalled();
  });

  it("hidePreview hides a visible preview", async () => {
    mockGetNoteIndicatorAt.mockReturnValue({ row: 1, col: 1 });

    hover(150, 40);
    await vi.advanceTimersByTimeAsync(HOVER_DELAY);
    hidePreview();

    expect(mockHideOverlay).toHaveBeenCalledWith("annotation-preview");
  });

  it("hidePreview does not hide anything when no preview is up", () => {
    hidePreview();
    expect(mockHideOverlay).not.toHaveBeenCalled();
  });
});
