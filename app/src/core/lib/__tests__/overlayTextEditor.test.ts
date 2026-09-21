//! FILENAME: app/src/core/lib/__tests__/overlayTextEditor.test.ts
// PURPOSE: Hold the overlay text editor to the traps that have actually
//          SHIPPED as bugs in this codebase, not to its happy path.
//
//          Each block below names the defect it is standing in for:
//            - a reference pick that committed the editor under the user
//              (the picking click blurs the element, and a blur used to mean
//              "the user left");
//            - a suppress flag that LATCHED, because the pick's click is
//              preventDefault()ed by the grid so no blur ever arrives to clear
//              it, and then swallowed an unrelated later commit;
//            - a stale teardown that cleared the module slot and killed the
//              editor the user had just opened;
//            - a keystroke that fell through to the grid and cleared cells.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  openOverlayTextEditor,
  getActiveOverlayTextEditor,
  isOverlayTextEditorOpen,
  isOverlayTextEditorElement,
  getGridCanvasLayer,
  OVERLAY_TEXT_EDITOR_ATTR,
  SUPPRESS_BLUR_MS,
  BLUR_COMMIT_DELAY_MS,
  DEFAULT_FONT_LOGICAL_PX,
  type OverlayTextEditorRect,
} from "../overlayTextEditor";
import { getExternalFormulaTarget } from "../formulaEditTarget";
import { POINTER_CLAIM_ATTR } from "../pointerClaims";

// The grid is not mounted in a unit test, so the snapshot every layout frame
// reads is supplied here. Zoom and the header gutters are the two things the
// layout rules actually depend on.
const state = vi.hoisted(() => ({
  current: {
    zoom: 1,
    config: { rowHeaderWidth: 22, colHeaderHeight: 20 },
    displayHeadings: true,
  } as unknown as Record<string, unknown>,
}));

vi.mock("../../state/GridContext", () => ({
  getGridStateSnapshot: () => state.current,
}));

function setGridState(zoom: number, displayHeadings = true): void {
  state.current = {
    zoom,
    config: { rowHeaderWidth: 22, colHeaderHeight: 20 },
    displayHeadings,
  } as unknown as Record<string, unknown>;
}

const RECT: OverlayTextEditorRect = { x: 100, y: 50, width: 200, height: 30 };

let layer: HTMLDivElement;

function openTestEditor(
  overrides: Partial<Parameters<typeof openOverlayTextEditor>[0]> = {},
): {
  handle: ReturnType<typeof openOverlayTextEditor>;
  onCommit: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
} {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  const handle = openOverlayTextEditor({
    getRect: () => RECT,
    onCommit,
    onCancel,
    ...overrides,
  });
  return { handle, onCommit, onCancel };
}

function keydown(el: HTMLElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  vi.useFakeTimers();
  setGridState(1);
  layer = document.createElement("div");
  layer.setAttribute("data-grid-canvas-layer", "");
  document.body.appendChild(layer);
});

afterEach(() => {
  getActiveOverlayTextEditor()?.cancel();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

// ============================================================================
// Mounting, claiming, layout
// ============================================================================

describe("overlay text editor: mounting", () => {
  it("mounts into the canvas layer and CLAIMS the pointer", () => {
    const { handle } = openTestEditor({ initialText: "Revenue" });

    const el = handle.getElement();
    expect(el).not.toBeNull();
    expect(el!.parentElement).toBe(layer);
    expect(el!.hasAttribute(OVERLAY_TEXT_EDITOR_ATTR)).toBe(true);
    // MANDATORY: the tag list in overlayMoveHandlers is not allowed to be what
    // keeps this element's gestures — it is a census of the widgets that
    // existed when it was written.
    expect(el!.getAttribute(POINTER_CLAIM_ATTR)).toBe("overlay-text-editor");
    expect(handle.getText()).toBe("Revenue");
    expect(isOverlayTextEditorOpen()).toBe(true);
    expect(isOverlayTextEditorElement(el)).toBe(true);
    expect(getGridCanvasLayer()).toBe(layer);
  });

  it("without a canvas layer it opens nothing and collects no text", () => {
    layer.remove();
    const { handle, onCommit } = openTestEditor();
    expect(handle.isOpen()).toBe(false);
    expect(handle.getElement()).toBeNull();
    handle.commit();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("positions in logical px MULTIPLIED by zoom, font included", () => {
    setGridState(2);
    const { handle } = openTestEditor({ font: { sizePx: 20 } });
    const el = handle.getElement()!;
    expect(el.style.display).toBe("block");
    expect(el.style.left).toBe("200px");
    expect(el.style.top).toBe("100px");
    expect(el.style.width).toBe("400px");
    expect(el.style.height).toBe("60px");
    expect(el.style.fontSize).toBe("40px");
  });

  it("defaults the font to Excel's 11pt in logical px", () => {
    const { handle } = openTestEditor();
    expect(handle.getElement()!.style.fontSize).toBe(`${DEFAULT_FONT_LOGICAL_PX}px`);
  });

  it("clips behind the header gutters, and a null rect hides without closing", () => {
    // Entirely inside the row-header gutter (22 logical px).
    const behindHeader = openOverlayTextEditor({
      getRect: () => ({ x: 0, y: 40, width: 10, height: 30 }),
      onCommit: vi.fn(),
      onCancel: vi.fn(),
    });
    expect(behindHeader.getElement()!.style.display).toBe("none");
    behindHeader.cancel();

    let rect: OverlayTextEditorRect | null = RECT;
    const hidden = openOverlayTextEditor({
      getRect: () => rect,
      onCommit: vi.fn(),
      onCancel: vi.fn(),
    });
    expect(hidden.getElement()!.style.display).toBe("block");
    rect = null;
    // The next frame re-reads getRect; drive one by hand rather than waiting.
    hidden.setText(hidden.getText());
    vi.advanceTimersByTime(64);
    expect(hidden.getElement()!.style.display).toBe("none");
    expect(hidden.isOpen()).toBe(true);
    hidden.cancel();
  });
});

// ============================================================================
// Trap: a reference pick is not a departure
// ============================================================================

describe("overlay text editor: formula reference picking", () => {
  it("registers as the external formula target only when asked", () => {
    const plain = openTestEditor();
    expect(getExternalFormulaTarget()?.isExpectingReference() ?? false).toBe(false);
    plain.handle.cancel();

    const { handle } = openTestEditor({ acceptsFormulaReferences: true, initialText: "=" });
    expect(getExternalFormulaTarget()).not.toBeNull();
    expect(getExternalFormulaTarget()!.isExpectingReference()).toBe(true);
    handle.cancel();
  });

  it("a picked reference is inserted SHEET-QUALIFIED at the cursor", () => {
    const { handle } = openTestEditor({ acceptsFormulaReferences: true, initialText: "=" });
    getExternalFormulaTarget()!.insertReference({
      sheetName: "Sheet1",
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
    });
    expect(handle.getText()).toBe("=Sheet1!A1");
  });

  it("A PICK DOES NOT COMMIT THE EDITOR, even when the pick's click blurred it", () => {
    const { handle, onCommit } = openTestEditor({
      acceptsFormulaReferences: true,
      initialText: "=",
    });
    getExternalFormulaTarget()!.insertReference({
      sheetName: "Sheet1",
      startRow: 1,
      startCol: 1,
      endRow: 1,
      endCol: 1,
    });

    // The picking click took focus away; the suppress flag is the only thing
    // standing between this blur and a commit of a half-typed formula.
    handle.getElement()!.blur();
    vi.advanceTimersByTime(BLUR_COMMIT_DELAY_MS + 10);

    expect(onCommit).not.toHaveBeenCalled();
    expect(handle.isOpen()).toBe(true);
    expect(handle.getText()).toBe("=Sheet1!B2");
  });

  it("a grid press while a reference is expected does not commit either", () => {
    const { handle, onCommit } = openTestEditor({
      acceptsFormulaReferences: true,
      initialText: "=",
    });
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onCommit).not.toHaveBeenCalled();
    expect(handle.isOpen()).toBe(true);
  });

  it("THE SUPPRESS FLAG EXPIRES: a later, unrelated blur still commits", () => {
    const { handle, onCommit } = openTestEditor({
      acceptsFormulaReferences: true,
      initialText: "=",
    });
    getExternalFormulaTarget()!.insertReference({
      sheetName: "Sheet1",
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
    });

    // No blur arrives at all — which is exactly the live case, because the
    // grid preventDefault()s the picking press. An UNBOUNDED flag survives
    // here and swallows the next genuine departure.
    vi.advanceTimersByTime(SUPPRESS_BLUR_MS + 50);
    expect(onCommit).not.toHaveBeenCalled();

    handle.getElement()!.blur();
    vi.advanceTimersByTime(BLUR_COMMIT_DELAY_MS + 10);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("=Sheet1!A1");
  });

  it("a refocus inside the blur window is not a departure at all", () => {
    const { handle, onCommit } = openTestEditor({ initialText: "Title" });
    handle.getElement()!.blur();
    handle.focus();
    vi.advanceTimersByTime(BLUR_COMMIT_DELAY_MS + 10);
    expect(onCommit).not.toHaveBeenCalled();
    expect(handle.isOpen()).toBe(true);
  });
});

// ============================================================================
// Trap: identity-checked teardown
// ============================================================================

describe("overlay text editor: session identity", () => {
  it("A STALE TEARDOWN CANNOT KILL A NEWER SESSION", () => {
    const first = openTestEditor({ initialText: "first" });
    const second = openTestEditor({ initialText: "second" });

    // Opening the second FINISHED the first (Excel's rule), once.
    expect(first.onCommit).toHaveBeenCalledTimes(1);
    expect(first.onCommit).toHaveBeenCalledWith("first");
    expect(first.handle.isOpen()).toBe(false);

    const liveEl = second.handle.getElement()!;
    expect(liveEl.isConnected).toBe(true);

    // Every close path on the dead handle must be inert.
    first.handle.cancel();
    first.handle.commit();
    first.handle.setText("clobber");

    expect(first.onCancel).not.toHaveBeenCalled();
    expect(first.onCommit).toHaveBeenCalledTimes(1);
    expect(second.onCommit).not.toHaveBeenCalled();
    expect(second.onCancel).not.toHaveBeenCalled();
    expect(second.handle.isOpen()).toBe(true);
    expect(second.handle.getText()).toBe("second");
    expect(liveEl.isConnected).toBe(true);
    expect(isOverlayTextEditorElement(liveEl)).toBe(true);
    expect(getActiveOverlayTextEditor()!.sessionId).toBe(second.handle.sessionId);
  });

  it("a stale session's deferred blur cannot commit the newer one", () => {
    const first = openTestEditor({ initialText: "first" });
    first.handle.getElement()!.blur();
    // The blur is pending. A new session opens before it fires.
    const second = openTestEditor({ initialText: "second" });
    vi.advanceTimersByTime(BLUR_COMMIT_DELAY_MS + 10);

    expect(second.onCommit).not.toHaveBeenCalled();
    expect(second.handle.isOpen()).toBe(true);
    // The first was committed by the open, not twice by its own stale blur.
    expect(first.onCommit).toHaveBeenCalledTimes(1);
  });

  it("closing removes the element, the claim and the formula target", () => {
    const { handle } = openTestEditor({ acceptsFormulaReferences: true, initialText: "=" });
    const el = handle.getElement()!;
    handle.commit();
    expect(el.isConnected).toBe(false);
    expect(getExternalFormulaTarget()).toBeNull();
    expect(isOverlayTextEditorOpen()).toBe(false);
    expect(handle.getElement()).toBeNull();
  });
});

// ============================================================================
// Keys
// ============================================================================

describe("overlay text editor: keys", () => {
  it("Enter COMMITS under the cell rule (enterInserts false)", () => {
    const { handle, onCommit } = openTestEditor({ initialText: "abc" });
    const e = keydown(handle.getElement()!, "Enter");
    expect(e.defaultPrevented).toBe(true);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("abc");
    expect(handle.isOpen()).toBe(false);
  });

  it("Enter INSERTS under the chart-title rule (enterInserts true)", () => {
    const { handle, onCommit, onCancel } = openTestEditor({
      initialText: "abc",
      enterInserts: true,
    });
    const e = keydown(handle.getElement()!, "Enter");
    // Not prevented: the textarea's own newline insertion is left alone.
    expect(e.defaultPrevented).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(handle.isOpen()).toBe(true);
  });

  it("Alt+Enter inserts under BOTH rules", () => {
    const { handle, onCommit } = openTestEditor({ initialText: "abc" });
    const e = keydown(handle.getElement()!, "Enter", { altKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
    expect(handle.isOpen()).toBe(true);
  });

  it("Escape cancels under the cell rule and COMMITS under the chart-title rule", () => {
    const cell = openTestEditor({ initialText: "abc" });
    keydown(cell.handle.getElement()!, "Escape");
    expect(cell.onCancel).toHaveBeenCalledTimes(1);
    expect(cell.onCommit).not.toHaveBeenCalled();

    const title = openTestEditor({ initialText: "abc", enterInserts: true });
    keydown(title.handle.getElement()!, "Escape");
    expect(title.onCommit).toHaveBeenCalledTimes(1);
    expect(title.onCommit).toHaveBeenCalledWith("abc");
    expect(title.onCancel).not.toHaveBeenCalled();
  });

  it("Tab commits", () => {
    const { handle, onCommit } = openTestEditor({ initialText: "abc" });
    const e = keydown(handle.getElement()!, "Tab");
    expect(e.defaultPrevented).toBe(true);
    expect(onCommit).toHaveBeenCalledWith("abc");
    expect(handle.isOpen()).toBe(false);
  });

  it("A KEYSTROKE DOES NOT REACH THE GRID", () => {
    const onLayer = vi.fn();
    const onAncestor = vi.fn();
    layer.addEventListener("keydown", onLayer);
    document.body.addEventListener("keydown", onAncestor);

    const { handle } = openTestEditor({ initialText: "abc", enterInserts: true });
    for (const key of ["a", "Delete", "ArrowDown", "Enter", "Escape"]) {
      const live = getActiveOverlayTextEditor();
      if (!live) break;
      keydown(live.getElement()!, key);
    }

    expect(onLayer).not.toHaveBeenCalled();
    expect(onAncestor).not.toHaveBeenCalled();
    layer.removeEventListener("keydown", onLayer);
    document.body.removeEventListener("keydown", onAncestor);
    handle.cancel();
  });
});

// ============================================================================
// Commit by leaving
// ============================================================================

describe("overlay text editor: leaving commits", () => {
  it("a press outside commits — the gesture a chart title has instead of Enter", () => {
    const { handle, onCommit } = openTestEditor({ initialText: "Sales", enterInserts: true });
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Sales");
    expect(handle.isOpen()).toBe(false);
  });

  it("a press INSIDE the editor changes nothing", () => {
    const { handle, onCommit } = openTestEditor({ initialText: "Sales" });
    handle.getElement()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onCommit).not.toHaveBeenCalled();
    expect(handle.isOpen()).toBe(true);
  });

  it("a genuine blur commits after the deferral, and only once", () => {
    const { handle, onCommit } = openTestEditor({ initialText: "Sales" });
    handle.getElement()!.blur();
    expect(onCommit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(BLUR_COMMIT_DELAY_MS + 10);
    expect(onCommit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
