//! FILENAME: app/extensions/FloatingRange/lib/__tests__/frFormulaBar.test.ts
// PURPOSE: A floating range's SELECTED cell as the formula bar and the Name
//          Box see it (lib/frFormulaBar.ts), through Core's real external-edit
//          store (@api/externalEdit):
//          - the published address ("Float1!A1", "Float1!A1:B2", quoted
//            names) and content (formula ?? display of the ANCHOR);
//          - while the anchor's read is in flight the bar is shown NOTHING,
//            never another cell's text; a read that predates a change is
//            discarded;
//          - `beginEdit` opens the edit with the BAR owning the caret;
//          - an edit never outlives its cell's selection (Excel's click-away),
//            except while picking a reference or parked;
//          - the Name Box resolver accepts "Float1!B2" back, after the
//            extension's reload queue.
// CONTEXT: Owner finding #10 (2026-09-27), fr-edit-design.md §3.3.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FloatingRangeInfo } from "@api/floatingRanges";

type Cell = { row: number; col: number; formula?: string | null; display?: string };
const updateFloatingRangeCell = vi.fn(async (..._args: unknown[]): Promise<number[]> => []);
const getFloatingRangeCells = vi.fn(async (..._args: unknown[]): Promise<Cell[]> => []);
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

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  showToast: vi.fn(),
}));

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (cmd === "set_active_sheet") {
      return {
        sheets: [
          { index: 0, name: "Sheet1", kind: "worksheet" },
          { index: 2, name: "Canvas1", kind: "canvas" },
        ],
        activeIndex: args?.index as number,
      };
    }
    return null;
  }),
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: (cmd: string, args?: Record<string, unknown>) => tauri.invoke(cmd, args),
}));

import {
  getExternalCellTarget,
  getExternalEditSession,
  getExternalEditVersion,
  getExternalNameBoxAddress,
  isExternalSessionParked,
  switchSheetForPointMode,
} from "@api/externalEdit";
import { getExternalFormulaTarget } from "@api/editing";
import {
  installFrFormulaBarPublisher,
  refreshFrFormulaBarContent,
  createFrAddressResolver,
  FR_FORMULA_BAR_OWNER,
  FR_NAME_BOX_BUSY_MESSAGE,
} from "../frFormulaBar";
import {
  upsertFromInfo,
  resetFloatingRangeStore,
  setFrActiveSheetIndex,
  syncFloatingRangeRegions,
} from "../floatingRangeStore";
import {
  setLocalSelection,
  getLocalSelection,
  clearLocalSelection,
  moveLocalSelection,
  extendLocalSelection,
  resetFrSelection,
  isFloatingRangeSelected,
} from "../frSelection";
import { registerFloatingRangeObjectSelection } from "../frObjectSelection";
import {
  cancelFrEditor,
  destroyFrEditor,
  getFrEditorSession,
  isFrEditorOpen,
  openFrEditor,
} from "../../editor/frEditor";

const FR_ID = "fr-bar";
const HOST = 2;

function info(over: Partial<FloatingRangeInfo> = {}): FloatingRangeInfo {
  return {
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
    ...over,
  } as FloatingRangeInfo;
}

/** Cell contents the mocked backend answers with, by "row,col". */
let contents: Record<string, Cell>;

function answer(row: number, col: number): Cell[] {
  const c = contents[`${row},${col}`];
  return c ? [c] : [];
}

/** A read the test releases by hand. */
function holdNextRead(): { release: (cells: Cell[]) => void } {
  let release: (cells: Cell[]) => void = () => {};
  getFloatingRangeCells.mockImplementationOnce(
    () => new Promise<Cell[]>((resolve) => { release = resolve; }),
  );
  return { release: (cells) => release(cells) };
}

function select(anchorRow: number, anchorCol: number, endRow = anchorRow, endCol = anchorCol): void {
  setLocalSelection({ frId: FR_ID, anchorRow, anchorCol, endRow, endCol });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

let uninstall: () => void;
let layer: HTMLElement;

beforeEach(() => {
  contents = {
    "0,0": { row: 0, col: 0, formula: "=Sheet1!E2", display: "42" },
    "1,0": { row: 1, col: 0, formula: null, display: "plain" },
    "1,1": { row: 1, col: 1, formula: "=A1*2", display: "84" },
  };
  getFloatingRangeCells.mockReset();
  getFloatingRangeCells.mockImplementation(async (...args: unknown[]) => answer(args[1] as number, args[2] as number));
  updateFloatingRangeCell.mockReset();
  updateFloatingRangeCell.mockResolvedValue([]);
  tauri.invoke.mockClear();
  resetFloatingRangeStore();
  resetFrSelection();
  layer = document.createElement("div");
  layer.setAttribute("data-grid-canvas-layer", "");
  document.body.appendChild(layer);
  upsertFromInfo(info());
  setFrActiveSheetIndex(HOST);
  syncFloatingRangeRegions();
  uninstall = installFrFormulaBarPublisher();
});

afterEach(() => {
  uninstall();
  cancelFrEditor();
  destroyFrEditor();
  layer.remove();
  resetFrSelection();
  resetFloatingRangeStore();
});

describe("the published selected cell", () => {
  it("(a) A1: its address and FORMULA; a value-only cell: its display", async () => {
    select(0, 0);
    await flush();
    expect(getExternalCellTarget()).toMatchObject({
      address: "Float1!A1",
      content: "=Sheet1!E2",
      readOnly: false,
    });
    expect(getExternalNameBoxAddress()).toBe("Float1!A1");
    select(1, 0);
    await flush();
    expect(getExternalCellTarget()).toMatchObject({ address: "Float1!A2", content: "plain" });
  });

  it("an empty cell publishes an empty string, not 'in flight'", async () => {
    select(2, 2);
    await flush();
    expect(getExternalCellTarget()).toMatchObject({ address: "Float1!C3", content: "" });
  });

  it("(b) a MOVE republishes; an EXTEND shows the range but the ANCHOR's content", async () => {
    select(0, 0);
    await flush();
    moveLocalSelection(1, 0, false, 4, 3);
    await flush();
    expect(getExternalCellTarget()?.address).toBe("Float1!A2");
    select(0, 0);
    await flush();
    extendLocalSelection(1, 1);
    await flush();
    expect(getExternalCellTarget()).toMatchObject({ address: "Float1!A1:B2", content: "=Sheet1!E2" });
  });

  it("(c) clear and reset withdraw the cell", async () => {
    select(0, 0);
    await flush();
    clearLocalSelection();
    expect(getExternalCellTarget()).toBeNull();
    select(0, 0);
    resetFrSelection();
    expect(getExternalCellTarget()).toBeNull();
  });

  it("(d) a rename is heard through the region change; a name needing quotes is quoted", async () => {
    select(0, 0);
    await flush();
    upsertFromInfo(info({ name: "Renamed" }));
    syncFloatingRangeRegions();
    expect(getExternalCellTarget()?.address).toBe("Renamed!A1");
    upsertFromInfo(info({ name: "My Float" }));
    syncFloatingRangeRegions();
    expect(getExternalNameBoxAddress()).toBe("'My Float'!A1");
  });

  it("an identical republish (an unrelated region change) does not bump the store", async () => {
    select(0, 0);
    await flush();
    const v = getExternalEditVersion();
    syncFloatingRangeRegions();
    expect(getExternalEditVersion()).toBe(v);
  });

  it("uninstalling withdraws the cell", async () => {
    select(0, 0);
    await flush();
    uninstall();
    expect(getExternalCellTarget()).toBeNull();
    uninstall = installFrFormulaBarPublisher();
  });
});

describe("reads in flight", () => {
  it("(f) while the anchor's read is in flight the bar is shown NOTHING, never the previous cell's text", async () => {
    select(0, 0);
    await flush();
    expect(getExternalCellTarget()?.content).toBe("=Sheet1!E2");
    const held = holdNextRead();
    select(1, 1);
    expect(getExternalCellTarget()).toMatchObject({ address: "Float1!B2", content: null });
    held.release(answer(1, 1));
    await flush();
    expect(getExternalCellTarget()?.content).toBe("=A1*2");
  });

  it("(e) hold A1, move to A2: A1 landing late never shows at A2", async () => {
    const a1 = holdNextRead();
    select(0, 0);
    const a2 = holdNextRead();
    select(1, 0);
    a2.release(answer(1, 0));
    await flush();
    a1.release(answer(0, 0));
    await flush();
    expect(getExternalCellTarget()).toMatchObject({ address: "Float1!A2", content: "plain" });
  });

  it("a read that PREDATES a change (a write, a recalc) is discarded when it lands late", async () => {
    const stale = holdNextRead();
    select(0, 0);
    // The cell is written; the refresh re-reads it and that read lands first.
    contents["0,0"] = { row: 0, col: 0, formula: "=NEW()", display: "1" };
    refreshFrFormulaBarContent();
    await flush();
    expect(getExternalCellTarget()?.content).toBe("=NEW()");
    stale.release([{ row: 0, col: 0, formula: "=OLD()", display: "0" }]);
    await flush();
    expect(getExternalCellTarget()?.content).toBe("=NEW()");
  });

  it("a refresh keeps the cell's own text on screen until its re-read lands (no blank frame)", async () => {
    select(0, 0);
    await flush();
    const held = holdNextRead();
    contents["0,0"] = { row: 0, col: 0, formula: "=NEW()", display: "1" };
    refreshFrFormulaBarContent();
    expect(getExternalCellTarget()?.content).toBe("=Sheet1!E2");
    held.release(answer(0, 0));
    await flush();
    expect(getExternalCellTarget()?.content).toBe("=NEW()");
  });

  it("a FAILED read leaves the content empty and is not retried in a loop", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      getFloatingRangeCells.mockRejectedValueOnce(new Error("offline"));
      select(0, 0);
      await flush();
      const calls = getFloatingRangeCells.mock.calls.length;
      syncFloatingRangeRegions(); // a republish
      await flush();
      expect(getFloatingRangeCells.mock.calls.length).toBe(calls);
      expect(getExternalCellTarget()?.content).toBeNull();
    } finally {
      errors.mockRestore();
    }
  });
});

describe("beginEdit: an edit opened from the bar", () => {
  it("(g) opens on the ANCHOR with the bar owning the caret, focus untouched, registered", async () => {
    const barEl = document.createElement("input");
    barEl.setAttribute("data-formula-bar", "true");
    document.body.appendChild(barEl);
    try {
      select(1, 1, 2, 2);
      await flush();
      barEl.focus();
      const session = getExternalCellTarget()!.beginEdit();
      expect(session).not.toBeNull();
      expect(session).toBe(getFrEditorSession());
      expect(session).toBe(getExternalEditSession());
      expect(session!.getView()).toBe("bar");
      expect(session!.anchor).toEqual({ row: 1, col: 1 });
      expect(document.activeElement).toBe(barEl);
      // The cached content is shown at once (provisionally).
      expect(session!.getText()).toBe("=A1*2");
    } finally {
      barEl.remove();
    }
  });

  it("focused mid-refresh, the edit starts from what the bar SHOWED (no blank flash), unmarked", async () => {
    select(0, 0);
    await flush();
    holdNextRead(); // the refresh's re-read never lands in this test
    holdNextRead(); // nor the edit's own load
    refreshFrFormulaBarContent();
    expect(getExternalCellTarget()?.content).toBe("=Sheet1!E2");
    const session = getExternalCellTarget()!.beginEdit()!;
    expect(session.getText()).toBe("=Sheet1!E2");
    // Provisional only: an untouched commit still writes nothing.
    await session.commit(null);
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
  });

  it("with a SEED (fx) the text is the seed", async () => {
    select(0, 0);
    await flush();
    const session = getExternalCellTarget()!.beginEdit("=");
    expect(session!.getText()).toBe("=");
  });

  it("an edit already open is ADOPTED, not reopened", async () => {
    select(0, 0);
    await flush();
    openFrEditor(FR_ID, 0, 0, "=1");
    const open = getFrEditorSession();
    const session = getExternalCellTarget()!.beginEdit();
    expect(session).toBe(open);
    expect(session!.getView()).toBe("bar");
    expect(session!.getText()).toBe("=1");
  });

  it("a cell target held after its selection went away begins nothing", async () => {
    select(0, 0);
    await flush();
    const held = getExternalCellTarget()!;
    clearLocalSelection();
    expect(held.beginEdit()).toBeNull();
    expect(isFrEditorOpen()).toBe(false);
  });
});

describe("(h) an edit never outlives its cell's selection", () => {
  it("dropping the selection COMMITS a bar-hosted edit (Excel's click-away)", async () => {
    select(0, 0);
    await flush();
    const session = getExternalCellTarget()!.beginEdit("7")!;
    expect(session.getText()).toBe("7");
    clearLocalSelection();
    await flush();
    expect(updateFloatingRangeCell).toHaveBeenCalledWith(FR_ID, 0, 0, "7");
    expect(isFrEditorOpen()).toBe(false);
  });

  it("moving the selection to another cell commits too", async () => {
    select(0, 0);
    await flush();
    getExternalCellTarget()!.beginEdit("8");
    select(1, 0);
    await flush();
    expect(updateFloatingRangeCell).toHaveBeenCalledWith(FR_ID, 0, 0, "8");
  });

  it("an EXTEND that keeps the anchor does not", async () => {
    select(0, 0);
    await flush();
    getExternalCellTarget()!.beginEdit("8");
    extendLocalSelection(1, 1);
    await flush();
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
    expect(isFrEditorOpen()).toBe(true);
  });

  it("NOT while a reference is being picked (the click feeds the edit)", async () => {
    select(0, 0);
    await flush();
    getExternalCellTarget()!.beginEdit("=");
    expect(getExternalFormulaTarget()?.isExpectingReference()).toBe(true);
    clearLocalSelection();
    await flush();
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
    expect(isFrEditorOpen()).toBe(true);
  });

  it("NOT while the edit is parked on another sheet", async () => {
    select(0, 0);
    await flush();
    const session = getExternalCellTarget()!.beginEdit("=")!;
    await switchSheetForPointMode(0, vi.fn());
    expect(isExternalSessionParked()).toBe(true);
    // A complete formula: no longer expecting, only the park protects it.
    session.setText("=Sheet1!E2", 10);
    expect(getExternalFormulaTarget()?.isExpectingReference()).toBe(false);
    clearLocalSelection();
    await flush();
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
    expect(isFrEditorOpen()).toBe(true);
  });
});

describe("(7) Enter in the bar moves the cell WITH the teardown, before the write lands", () => {
  it("a key typed while the write is in flight edits the NEXT cell; the committed value is never overwritten", async () => {
    select(0, 0);
    await flush();
    const first = getExternalCellTarget()!.beginEdit()!;
    first.setText("5", 1);
    let land: () => void = () => {};
    updateFloatingRangeCell.mockImplementationOnce(
      () => new Promise<number[]>((resolve) => { land = () => resolve([]); }),
    );
    const committing = first.commit("down");
    // FormulaInput.handleChange on the next keystroke, inside the IPC + recalc
    // window: begin an edit on the published cell, then set its text.
    const second = getExternalCellTarget()!.beginEdit()!;
    second.setText("6", 1);
    land();
    await committing;
    await flush();
    // ONE write, the committed value; the "6" belongs to the next cell's edit.
    expect(updateFloatingRangeCell.mock.calls).toEqual([[FR_ID, 0, 0, "5"]]);
    expect(second.anchor).toEqual({ row: 1, col: 0 });
    expect(isFrEditorOpen()).toBe(true);
    expect(getLocalSelection()).toMatchObject({ anchorRow: 1, anchorCol: 0 });
  });
});

describe("(i) the Name Box resolver", () => {
  it("while this extension's edit PICKS a reference, every entry is refused where the grid stands", async () => {
    select(0, 0);
    await flush();
    getExternalCellTarget()!.beginEdit("=SUM(");
    const resolve = createFrAddressResolver(async () => {});
    for (const text of ["Sheet3!A1", "B5", "Float1!B2", "MyName"]) {
      const resolution = resolve(text);
      expect(resolution, text).not.toBeNull();
      expect(resolution!.hostSheetIndex, text).toBe(HOST);
      await expect(resolution!.go(), text).resolves.toBe(FR_NAME_BOX_BUSY_MESSAGE);
    }
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
    expect(isFrEditorOpen()).toBe(true);
    expect(getLocalSelection()).toMatchObject({ anchorRow: 0, anchorCol: 0 });
  });

  it("an edit that is NOT picking (a plain value) leaves the box alone", async () => {
    select(0, 0);
    await flush();
    getExternalCellTarget()!.beginEdit("5");
    const resolve = createFrAddressResolver(async () => {});
    expect(resolve("Sheet3!A1")).toBeNull();
    expect(resolve("Float1!B2")?.hostSheetIndex).toBe(HOST);
  });

  it("claims its own names (any case, quoted or not) and declines everything else", () => {
    const resolve = createFrAddressResolver(async () => {});
    expect(resolve("Float1!B2")?.hostSheetIndex).toBe(HOST);
    expect(resolve("float1!$B$2:$C$3")).not.toBeNull();
    expect(resolve("'Float1'!A1")).not.toBeNull();
    expect(resolve("Nope!A1")).toBeNull();
    expect(resolve("B2")).toBeNull();
    expect(resolve("Float1")).toBeNull();
  });

  it("go() waits for the reload queue, then selects the object AND the cells", async () => {
    const offProvider = registerFloatingRangeObjectSelection();
    try {
      let releaseQueue: () => void = () => {};
      // A re-sync the Name Box's own sheet switch queued: it resets the
      // selection when it runs.
      const queue = new Promise<void>((r) => { releaseQueue = r; }).then(() => resetFrSelection());
      const resolution = createFrAddressResolver(() => queue)("Float1!B2:C3")!;
      const going = resolution.go();
      releaseQueue();
      await expect(going).resolves.toBeNull();
      expect(getLocalSelection()).toEqual({
        frId: FR_ID,
        anchorRow: 1,
        anchorCol: 1,
        endRow: 2,
        endCol: 2,
      });
      expect(isFloatingRangeSelected(FR_ID)).toBe(true);
      await flush();
      expect(getExternalNameBoxAddress()).toBe("Float1!B2:C3");
    } finally {
      offProvider();
    }
  });

  it("an address outside the range is refused with a sentence, and selects nothing", async () => {
    const problem = await createFrAddressResolver(async () => {})("Float1!Z999")!.go();
    expect(problem).toBe('"Float1!Z999" is outside the floating range "Float1" (A1:C4).');
    expect(getLocalSelection()).toBeNull();
  });

  it("a range deleted meanwhile is refused with a sentence", async () => {
    const resolution = createFrAddressResolver(async () => {})("Float1!A1")!;
    resetFloatingRangeStore();
    await expect(resolution.go()).resolves.toBe('The floating range "Float1" no longer exists.');
  });
});

describe("owner key", () => {
  it("is the one the design names", () => {
    expect(FR_FORMULA_BAR_OWNER).toBe("floatingRange");
  });
});
