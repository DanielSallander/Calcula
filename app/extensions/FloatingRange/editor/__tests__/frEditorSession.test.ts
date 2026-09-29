//! FILENAME: app/extensions/FloatingRange/editor/__tests__/frEditorSession.test.ts
// PURPOSE: The floating range's cell editor as ONE edit SESSION with two
//          views -- its textarea and the formula bar -- registered in Core's
//          external-edit slot (@api/externalEdit):
//          - the bar mirrors in-cell typing, and a bar-begun edit never takes
//            the bar's focus;
//          - focus moving from the textarea to the bar is a HAND-OFF, not a
//            commit;
//          - a reference picked while the bar owns the caret lands at the
//            bar's caret without focusing the textarea;
//          - PARKED (a formula picking a reference on another sheet) the
//            textarea hides and its blur commits nothing; the return commits
//            to the right cell and moves the cell selection;
//          - an edit whose content never arrived writes NOTHING on an
//            untouched Enter (defect D4: it wrote "" over the cell);
//          - a session object held past its edit can never touch a newer one.
// CONTEXT: Owner findings #9/#10 (2026-09-27), fr-edit-design.md §3.2.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FloatingRangeInfo } from "@api/floatingRanges";

const updateFloatingRangeCell = vi.fn(async (..._args: unknown[]): Promise<number[]> => []);
const getFloatingRangeCells = vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []);
vi.mock("@api/floatingRanges", () => ({
  FLOATING_RANGE_MAX_ROWS: 1000,
  FLOATING_RANGE_MAX_COLS: 256,
  listFloatingRanges: vi.fn(async () => []),
  updateFloatingRange: vi.fn(async () => ({})),
  updateFloatingRangeCell: (...args: unknown[]) => updateFloatingRangeCell(...args),
  getFloatingRangeCells: (...args: unknown[]) => getFloatingRangeCells(...args),
}));

vi.mock("@api/lib", () => ({
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true })),
}));

const showToast = vi.fn();
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  showToast: (...args: unknown[]) => showToast(...args),
}));

// The point-mode sheet switch is Core's (@api/externalEdit); it reaches the
// backend's `set_active_sheet`, answered here. Sheet 2 hosts the range.
const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (cmd === "set_active_sheet") {
      const index = args?.index as number;
      return {
        sheets: [
          { index: 0, name: "Sheet1", kind: "worksheet" },
          { index: 2, name: "Canvas1", kind: "canvas" },
        ],
        activeIndex: index,
      };
    }
    return null;
  }),
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: (cmd: string, args?: Record<string, unknown>) => tauri.invoke(cmd, args),
}));

import type { OverlayRenderContext } from "@api/gridOverlays";
import { registerExternalFormulaTarget, getExternalFormulaTarget } from "@api/editing";
import {
  endExternalFormulaSession,
  getExternalEditSession,
  getExternalEditVersion,
  isExternalSessionParked,
  switchSheetForPointMode,
} from "@api/externalEdit";
import { AutocompleteEvents } from "@api/formulaAutocomplete";
import { setMoveAfterReturn, setMoveDirection } from "@api/editingPreferences";
import { enterCommitMove } from "@api/externalEdit";
import {
  openFrEditor,
  commitFrEditor,
  cancelFrEditor,
  destroyFrEditor,
  getFrEditorSession,
  isFrEditorOpen,
  layoutFrEditorForFrame,
} from "../frEditor";
import { upsertFromInfo, resetFloatingRangeStore, getFloatingRangeById } from "../../lib/floatingRangeStore";
import { getLocalSelection, setLocalSelection, clearLocalSelection } from "../../lib/frSelection";
import { getFrEditingRange } from "../../lib/frEditingRange";

const FR_ID = "fr-session";
const HOST = 2;
const INFO = {
  id: FR_ID,
  backingSheetId: "backing",
  hostSheetId: "host",
  x: 0,
  y: 0,
  rotation: 0,
  pinToGrid: false,
  rowCount: 4,
  colCount: 3,
  colWidths: {},
  rowHeights: {},
  showTitle: true,
  showColumnHeaders: true,
  showRowHeaders: true,
  name: "Float1",
  backingSheetIndex: 3,
  hostSheetIndex: HOST,
} as FloatingRangeInfo;

function overlayCtx(): OverlayRenderContext {
  return {
    config: { rowHeaderWidth: 0, colHeaderHeight: 0 },
    viewport: { scrollX: 0, scrollY: 0 },
    canvasWidth: 2000,
    canvasHeight: 2000,
  } as unknown as OverlayRenderContext;
}

function textarea(): HTMLTextAreaElement {
  return document.querySelector("textarea[data-fr-editor]") as HTMLTextAreaElement;
}

function typeInto(el: HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.setSelectionRange(value.length, value.length);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** The formula bar's editor, as Core recognises it (`isFormulaBarElement`). */
function makeBar(): HTMLInputElement {
  const bar = document.createElement("input");
  bar.setAttribute("data-formula-bar", "true");
  document.body.appendChild(bar);
  return bar;
}

let layer: HTMLElement;
let bar: HTMLInputElement;

beforeEach(() => {
  updateFloatingRangeCell.mockReset();
  updateFloatingRangeCell.mockResolvedValue([]);
  getFloatingRangeCells.mockReset();
  getFloatingRangeCells.mockResolvedValue([]);
  tauri.invoke.mockClear();
  showToast.mockClear();
  resetFloatingRangeStore();
  clearLocalSelection();
  layer = document.createElement("div");
  layer.setAttribute("data-grid-canvas-layer", "");
  document.body.appendChild(layer);
  bar = makeBar();
  upsertFromInfo(INFO);
});

afterEach(() => {
  vi.useRealTimers();
  cancelFrEditor();
  destroyFrEditor();
  layer.remove();
  bar.remove();
  resetFloatingRangeStore();
  clearLocalSelection();
});

describe("one session, registered in Core's slot", () => {
  it("(a) in-cell typing is the session's text, and the bar hears it", () => {
    openFrEditor(FR_ID, 0, 0, null);
    const session = getFrEditorSession();
    expect(session).not.toBeNull();
    // THE session: the pick slot's, so the bar and a grid pick share it.
    expect(getExternalEditSession()).toBe(session);
    expect(session!.getView()).toBe("cell");
    expect(session!.hostSheetIndex).toBe(HOST);
    expect(session!.anchor).toEqual({ row: 0, col: 0 });
    expect(session!.address).toBe("Float1!A1");

    const before = getExternalEditVersion();
    typeInto(textarea(), "=");
    expect(session!.getText()).toBe("=");
    expect(getExternalEditVersion()).toBeGreaterThan(before);
  });

  it("the address follows a rename during the edit", () => {
    openFrEditor(FR_ID, 1, 2, "x");
    getFloatingRangeById(FR_ID)!.name = "My Float";
    expect(getFrEditorSession()!.address).toBe("'My Float'!C2");
  });

  it("announces the edited range, so its resize handles stand down", async () => {
    expect(getFrEditingRange()).toBeNull();
    openFrEditor(FR_ID, 0, 0, "7");
    expect(getFrEditingRange()).toBe(FR_ID);
    await commitFrEditor(null);
    expect(getFrEditingRange()).toBeNull();
  });

  it("(b) a BAR-begun edit leaves the focus on the bar", () => {
    bar.focus();
    expect(document.activeElement).toBe(bar);
    openFrEditor(FR_ID, 0, 0, null, { focus: false, view: "bar" });
    expect(document.activeElement).toBe(bar);
    expect(textarea().style.display).toBe("block");
    expect(getFrEditorSession()!.getView()).toBe("bar");
    expect(getExternalEditSession()).toBe(getFrEditorSession());
  });

  it("the bar's caret decides whether a reference is expected", () => {
    openFrEditor(FR_ID, 0, 0, "=SUM(1)", { focus: false, view: "bar" });
    const s = getFrEditorSession()!;
    const target = getExternalFormulaTarget()!;
    s.setCursor(5); // just after "=SUM("
    expect(target.isExpectingReference()).toBe(true);
    s.setCursor(7); // after ")"
    expect(target.isExpectingReference()).toBe(false);
  });
});

describe("focus hand-off between the two views", () => {
  it("(c) the textarea losing focus TO THE BAR is a hand-off, never a commit", () => {
    vi.useFakeTimers();
    openFrEditor(FR_ID, 0, 0, null);
    typeInto(textarea(), "=1+");
    bar.focus(); // blurs the textarea
    vi.advanceTimersByTime(200);
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
    expect(isFrEditorOpen()).toBe(true);
    expect(getFrEditorSession()!.getView()).toBe("bar");
  });

  it("a genuine departure still commits (the hand-off is the only exception)", () => {
    vi.useFakeTimers();
    openFrEditor(FR_ID, 0, 0, null);
    typeInto(textarea(), "42");
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    try {
      elsewhere.focus();
      vi.advanceTimersByTime(200);
      expect(updateFloatingRangeCell).toHaveBeenCalledWith(FR_ID, 0, 0, "42");
    } finally {
      elsewhere.remove();
    }
  });

  it("(fx) the BAR adopted the edit before a dialog took the focus: the blur commits nothing", () => {
    // Review 2026-09-27 (FR finding 8): fx adopts the edit into the bar, then
    // the Insert Function dialog focuses its search box. "=SUM(A1" no longer
    // expects a reference, so only the view protects it: committed, the
    // function the user then chose had no edit to land in.
    vi.useFakeTimers();
    openFrEditor(FR_ID, 0, 0, null);
    typeInto(textarea(), "=SUM(A1");
    const s = getFrEditorSession()!;
    s.adoptBarView();
    const search = document.createElement("input");
    document.body.appendChild(search);
    try {
      search.focus();
      vi.advanceTimersByTime(200);
      expect(updateFloatingRangeCell).not.toHaveBeenCalled();
      expect(getExternalEditSession()).toBe(s);
      // The dialog's choice lands in the same session.
      s.setText("=SUM(A1,", 8);
      expect(textarea().value).toBe("=SUM(A1,");
    } finally {
      search.remove();
    }
  });

  it("a formula still EXPECTING a reference is never blur-committed (InlineEditor's rule)", () => {
    vi.useFakeTimers();
    openFrEditor(FR_ID, 0, 0, null);
    typeInto(textarea(), "=SUM(");
    const search = document.createElement("input");
    document.body.appendChild(search);
    try {
      search.focus();
      vi.advanceTimersByTime(200);
      expect(updateFloatingRangeCell).not.toHaveBeenCalled();
      expect(isFrEditorOpen()).toBe(true);
    } finally {
      search.remove();
    }
  });

  it("focusing the textarea again gives it the caret back (view cell)", () => {
    openFrEditor(FR_ID, 0, 0, "=", { focus: false, view: "bar" });
    const s = getFrEditorSession()!;
    const before = getExternalEditVersion();
    textarea().focus();
    expect(s.getView()).toBe("cell");
    expect(getExternalEditVersion()).toBeGreaterThan(before);
  });

  it("adoptBarView: notifies on a change only", () => {
    openFrEditor(FR_ID, 0, 0, "=A");
    const s = getFrEditorSession()!;
    const v0 = getExternalEditVersion();
    s.adoptBarView();
    expect(s.getView()).toBe("bar");
    const v1 = getExternalEditVersion();
    expect(v1).toBeGreaterThan(v0);
    s.adoptBarView();
    expect(getExternalEditVersion()).toBe(v1);
  });
});

describe("the bar view writes the session", () => {
  it("(d) a pick while the BAR owns the caret inserts there and never focuses the textarea", () => {
    bar.focus();
    openFrEditor(FR_ID, 0, 0, "=", { focus: false, view: "bar" });
    const s = getFrEditorSession()!;
    s.setCursor(1);
    const before = getExternalEditVersion();
    getExternalFormulaTarget()!.insertReference({
      sheetName: "Sheet1",
      startRow: 1,
      startCol: 4,
      endRow: 1,
      endCol: 4,
    });
    expect(s.getText()).toBe("=Sheet1!E2");
    expect(s.getCursor()).toBe(10);
    expect(document.activeElement).toBe(bar);
    expect(getExternalEditVersion()).toBeGreaterThan(before);
  });

  it("a pick while the TEXTAREA owns the caret keeps the textarea focused (unchanged)", () => {
    openFrEditor(FR_ID, 0, 0, "=");
    getExternalFormulaTarget()!.insertReference({
      sheetName: "Sheet1",
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
    });
    expect(textarea().value).toBe("=Sheet1!A1");
    expect(document.activeElement).toBe(textarea());
  });

  it("(j) setText with the same text and caret is a no-op: no notify", () => {
    openFrEditor(FR_ID, 0, 0, "=A1", { focus: false, view: "bar" });
    const s = getFrEditorSession()!;
    s.setText("=A1+", 4);
    const v = getExternalEditVersion();
    s.setText("=A1+", 4);
    expect(getExternalEditVersion()).toBe(v);
    s.setText("=A1+", 2);
    expect(getExternalEditVersion()).toBeGreaterThan(v);
    expect(s.getCursor()).toBe(2);
  });

  it("setText never changes the view, and commit writes the bar's text", async () => {
    openFrEditor(FR_ID, 0, 0, null, { focus: false, view: "bar" });
    const s = getFrEditorSession()!;
    s.setText("=5", 2);
    expect(s.getView()).toBe("bar");
    expect(textarea().value).toBe("=5");
    await expect(s.commit(null)).resolves.toBe(true);
    expect(updateFloatingRangeCell).toHaveBeenCalledWith(FR_ID, 0, 0, "=5");
    expect(getExternalEditSession()).toBeNull();
  });

  it("a REFUSED write resolves false (the user was told)", async () => {
    updateFloatingRangeCell.mockRejectedValueOnce(new Error("locked"));
    openFrEditor(FR_ID, 0, 0, "9");
    await expect(getFrEditorSession()!.commit(null)).resolves.toBe(false);
    expect(showToast).toHaveBeenCalled();
  });

  it("(i) autocomplete ACCEPTED while the BAR is focused is the bar's to apply, not the textarea's", () => {
    openFrEditor(FR_ID, 0, 0, "=SU", { focus: false, view: "bar" });
    bar.focus();
    window.dispatchEvent(
      new CustomEvent(AutocompleteEvents.ACCEPTED, {
        detail: { newValue: "=SUM(", newCursorPosition: 5 },
      }),
    );
    expect(textarea().value).toBe("=SU");
  });

  it("autocomplete ACCEPTED while the TEXTAREA is focused applies and notifies", () => {
    openFrEditor(FR_ID, 0, 0, "=SU");
    const v = getExternalEditVersion();
    window.dispatchEvent(
      new CustomEvent(AutocompleteEvents.ACCEPTED, {
        detail: { newValue: "=SUM(", newCursorPosition: 5 },
      }),
    );
    expect(textarea().value).toBe("=SUM(");
    expect(getExternalEditVersion()).toBeGreaterThan(v);
  });
});

describe("content that never arrived (defect D4)", () => {
  it("(h) an untouched edit whose read is still in flight writes NOTHING on Enter", async () => {
    let release: (cells: unknown[]) => void = () => {};
    getFloatingRangeCells.mockImplementationOnce(
      () => new Promise<unknown[]>((resolve) => { release = resolve; }),
    );
    openFrEditor(FR_ID, 0, 0, null, { focus: false, view: "bar", provisional: "=OLD()" });
    const s = getFrEditorSession()!;
    expect(s.getText()).toBe("=OLD()");
    await expect(s.commit("down")).resolves.toBe(true);
    release([{ row: 0, col: 0, formula: "=REAL()", display: "1" }]);
    await flush();
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
  });

  it("an edit whose read FAILED writes nothing either (a transient failure must not blank the cell)", async () => {
    getFloatingRangeCells.mockRejectedValueOnce(new Error("offline"));
    openFrEditor(FR_ID, 0, 0, null);
    await flush();
    await commitFrEditor(null);
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
  });

  it("once the content arrived, it replaces the provisional text and the bar hears it", async () => {
    getFloatingRangeCells.mockResolvedValueOnce([{ row: 0, col: 0, formula: "=REAL()", display: "1" }]);
    openFrEditor(FR_ID, 0, 0, null, { focus: false, view: "bar", provisional: "=OLD()" });
    const v = getExternalEditVersion();
    await flush();
    const s = getFrEditorSession()!;
    expect(s.getText()).toBe("=REAL()");
    expect(s.getCursor()).toBe(7);
    expect(getExternalEditVersion()).toBeGreaterThan(v);
  });
});

describe("parked on another sheet", () => {
  it("(e) parking hides the textarea; its blur commits nothing", async () => {
    vi.useFakeTimers();
    openFrEditor(FR_ID, 0, 0, null);
    typeInto(textarea(), "=");
    await switchSheetForPointMode(0, vi.fn());
    expect(isExternalSessionParked()).toBe(true);
    expect(textarea().style.display).toBe("none");
    expect(getFrEditorSession()!.getView()).toBe("bar");
    // The hide is what blurs it (WebView2 does this asynchronously); nothing
    // else holds the focus -- not even the bar.
    textarea().blur();
    vi.advanceTimersByTime(200);
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
    expect(isFrEditorOpen()).toBe(true);
  });

  it("(f) a frame laid out while parked keeps the textarea hidden", async () => {
    openFrEditor(FR_ID, 0, 0, "=");
    await switchSheetForPointMode(0, vi.fn());
    layoutFrEditorForFrame(getFloatingRangeById(FR_ID)!, 100, 50, overlayCtx());
    expect(textarea().style.display).toBe("none");
  });

  it("(g) Enter from parked returns to the host FIRST, writes the picked formula, moves the cell", async () => {
    setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
    openFrEditor(FR_ID, 0, 0, null);
    typeInto(textarea(), "=");
    await switchSheetForPointMode(0, vi.fn());
    getExternalFormulaTarget()!.insertReference({
      sheetName: "Sheet1",
      startRow: 1,
      startCol: 4,
      endRow: 1,
      endCol: 4,
    });
    let parkedAtWrite: boolean | null = null;
    updateFloatingRangeCell.mockImplementationOnce(async () => {
      parkedAtWrite = isExternalSessionParked();
      return [];
    });
    tauri.invoke.mockClear();
    await expect(endExternalFormulaSession("commit", "down", vi.fn())).resolves.toBe(true);
    await flush();
    expect(tauri.invoke).toHaveBeenCalledWith("set_active_sheet", { index: HOST });
    expect(parkedAtWrite).toBe(false);
    expect(updateFloatingRangeCell).toHaveBeenCalledWith(FR_ID, 0, 0, "=Sheet1!E2");
    expect(getLocalSelection()).toMatchObject({ anchorRow: 1, anchorCol: 0 });
  });

  it("(k) un-parking re-shows the textarea; focusCellView resumes at the stored caret", async () => {
    openFrEditor(FR_ID, 0, 0, null);
    typeInto(textarea(), "=1+");
    await switchSheetForPointMode(0, vi.fn());
    // WebView2 blurs the hidden textarea; jsdom does not, so do it here.
    textarea().blur();
    const s = getFrEditorSession()!;
    s.setCursor(2);
    // Parked: the in-place view cannot take the caret.
    s.focusCellView();
    expect(document.activeElement).not.toBe(textarea());
    expect(s.getView()).toBe("bar");
    await switchSheetForPointMode(HOST, vi.fn());
    expect(isExternalSessionParked()).toBe(false);
    expect(textarea().style.display).toBe("block");
    s.focusCellView();
    expect(document.activeElement).toBe(textarea());
    expect(textarea().selectionStart).toBe(2);
    expect(s.getView()).toBe("cell");
  });

  it("cancel from parked returns first and writes nothing", async () => {
    openFrEditor(FR_ID, 0, 0, null);
    typeInto(textarea(), "=");
    await switchSheetForPointMode(0, vi.fn());
    tauri.invoke.mockClear();
    await expect(endExternalFormulaSession("cancel", null, vi.fn())).resolves.toBe(true);
    expect(tauri.invoke).toHaveBeenCalledWith("set_active_sheet", { index: HOST });
    expect(isFrEditorOpen()).toBe(false);
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
  });
});

describe("a session object held past its edit", () => {
  it("(l) cannot write into, commit or cancel a NEWER edit", async () => {
    openFrEditor(FR_ID, 0, 0, "old");
    const stale = getFrEditorSession()!;
    await commitFrEditor(null);
    updateFloatingRangeCell.mockClear();

    openFrEditor(FR_ID, 1, 1, "new");
    stale.setText("hijack", 6);
    expect(textarea().value).toBe("new");
    expect(stale.getText()).toBe("");
    stale.cancel();
    expect(isFrEditorOpen()).toBe(true);
    await expect(stale.commit(null)).resolves.toBe(false);
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
  });

  it("a stale pick target cannot insert into a newer edit either", async () => {
    openFrEditor(FR_ID, 0, 0, "=");
    const staleTarget = getExternalFormulaTarget()!;
    await commitFrEditor(null);
    openFrEditor(FR_ID, 1, 1, "=");
    staleTarget.insertReference({ sheetName: "Sheet1", startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
    expect(textarea().value).toBe("=");
  });

  it("another registration (the chart text editor) replaces the slot; the FR edit stays open", () => {
    openFrEditor(FR_ID, 0, 0, "=");
    const off = registerExternalFormulaTarget({
      isExpectingReference: () => false,
      insertReference: () => {},
    });
    try {
      expect(getExternalEditSession()).toBeNull();
      expect(isFrEditorOpen()).toBe(true);
    } finally {
      off();
    }
  });
});

// E4: a floating-grid commit follows the user's Move-after-Return preference
// (File > Options > Editing), as Core's own in-cell editor does. Every Enter
// door passed a hard-coded "down" / "up".
describe("Enter follows the Move-after-Return preference (E4)", () => {
  afterEach(() => {
    setMoveAfterReturn(true);
    setMoveDirection("down");
  });

  async function enterAt(row: number, col: number, init: KeyboardEventInit = {}): Promise<void> {
    setLocalSelection({ frId: FR_ID, anchorRow: row, anchorCol: col, endRow: row, endCol: col });
    openFrEditor(FR_ID, row, col, "7");
    textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }));
    await flush();
  }

  it("Move-after-Return OFF: Enter commits and the selection STAYS on the cell", async () => {
    setMoveAfterReturn(false);
    await enterAt(1, 1);
    expect(updateFloatingRangeCell).toHaveBeenCalledWith(FR_ID, 1, 1, "7");
    expect(getLocalSelection()).toMatchObject({ anchorRow: 1, anchorCol: 1 });
  });

  it("direction RIGHT: Enter moves right, Shift+Enter moves left", async () => {
    setMoveDirection("right");
    await enterAt(1, 1);
    expect(getLocalSelection()).toMatchObject({ anchorRow: 1, anchorCol: 2 });
    await enterAt(1, 1, { shiftKey: true });
    expect(getLocalSelection()).toMatchObject({ anchorRow: 1, anchorCol: 0 });
  });

  it("control: the default (on, down) still moves down, and Shift+Enter up", async () => {
    await enterAt(1, 1);
    expect(getLocalSelection()).toMatchObject({ anchorRow: 2, anchorCol: 1 });
    await enterAt(1, 1, { shiftKey: true });
    expect(getLocalSelection()).toMatchObject({ anchorRow: 0, anchorCol: 1 });
  });

  it("enterCommitMove is the one rule every Enter door asks", () => {
    expect(enterCommitMove(false)).toBe("down");
    expect(enterCommitMove(true)).toBe("up");
    setMoveDirection("left");
    expect(enterCommitMove(false)).toBe("left");
    expect(enterCommitMove(true)).toBe("right");
    setMoveDirection("none");
    expect(enterCommitMove(false)).toBeNull();
    setMoveDirection("down");
    setMoveAfterReturn(false);
    expect(enterCommitMove(true)).toBeNull();
  });
});

// E2: a header pick (whole column/row), the select-all corner and a
// GETPIVOTDATA pick arrive as already-built, sheet-qualified TEXT
// (ExternalFormulaTarget.insertText); the range's edit takes it at the caret.
describe("text picks reach the range's edit (E2)", () => {
  it("insertText lands at the caret and marks the edit touched", async () => {
    openFrEditor(FR_ID, 0, 0, "=SUM(");
    const target = getExternalFormulaTarget()!;
    expect(target.isExpectingReference()).toBe(true);
    target.insertText!("Sheet1!C:C");
    expect(textarea().value).toBe("=SUM(Sheet1!C:C");
    await commitFrEditor(null);
    expect(updateFloatingRangeCell).toHaveBeenCalledWith(FR_ID, 0, 0, "=SUM(Sheet1!C:C");
  });

  it("a stale target's insertText cannot write into a newer edit", async () => {
    openFrEditor(FR_ID, 0, 0, "=");
    const stale = getExternalFormulaTarget()!;
    await commitFrEditor(null);
    openFrEditor(FR_ID, 1, 1, "=");
    stale.insertText!("Sheet1!1:1");
    expect(textarea().value).toBe("=");
  });
});
