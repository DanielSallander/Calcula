//! FILENAME: app/extensions/BuiltIn/ObjectPosition/__tests__/selectedObjectKeys.test.ts
// PURPOSE: BUG-0270. While a floating object is SELECTED on a worksheet, the
//          selection owns the keyboard: Delete / Backspace remove the selected
//          object(s) as ONE undo step through each family's own delete,
//          Escape deselects, and no door that acts on Core's selection reaches
//          the active cell hidden behind the object.
// CONTEXT: A slicer selected by a click on its header left the hidden active
//          cell open to Delete (the dispatcher's Clear Contents cleared it and
//          the slicer stayed), to typing, F2, Space and Alt+Down. M8c claimed
//          the selection only while the keyboard is INSIDE the slicer.
//          Everything here goes through the REAL keybinding dispatcher
//          (initKeybindings: its window-capture listener and the built-in
//          Delete = Clear Contents), the real selection-owner store and the
//          real object-selection seam; families are fakes with recording
//          deletes, except T6b, which uses Charts' REAL provider.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let surface: "canvas" | "grid" = "grid";
vi.mock("../../../../src/core/state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/core/state/GridContext")>()),
  getGridStateSnapshot: () => ({
    surface,
    sheetContext: { activeSheetIndex: 0 },
    selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" },
  }),
}));
const undoLog: string[] = [];
vi.mock("../../../../src/core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginUndoTransaction: vi.fn(async (label: string) => {
    undoLog.push(`begin:${label}`);
  }),
  commitUndoTransaction: vi.fn(async () => {
    undoLog.push("commit");
  }),
}));
// Core's AFTER-press announcement: its `notifyGridCellPressed` is Core-only (an
// extension listens, never presses), so the test holds the listeners the
// extension registered and plays Core's part (FloatingRange's frSheetChange
// precedent).
const pressListeners = vi.hoisted(() => new Set<(press: import("@api/cellClickInterceptors").GridCellPress) => void>());
vi.mock("@api/cellClickInterceptors", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@api/cellClickInterceptors")>();
  return {
    ...orig,
    onGridCellPressed: (listener: Parameters<typeof orig.onGridCellPressed>[0]) => {
      pressListeners.add(listener);
      const off = orig.onGridCellPressed(listener);
      return () => {
        pressListeners.delete(listener);
        off();
      };
    },
  };
});
/** Core announces a handled sheet press. */
function notifyGridCellPressed(press: import("@api/cellClickInterceptors").GridCellPress): void {
  for (const listener of [...pressListeners]) listener(press);
}
// Charts' selection handler shows its contextual tab through these.
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));

import { initKeybindings, registerKeybinding, getKeybinding } from "@api/keybindings";
import { CommandRegistry } from "@api/commands";
import { registerToastSink, type ToastPayload } from "@api/notifications";
import {
  isSelectionOwned,
  refuseIfSelectionOwned,
  registerSelectionOwner,
  selectionRefusalFor,
  getSelectionOwner,
} from "@api/selectionOwner";
import { getGridRegions, registerGridOverlay, setGridRegions, type GridRegion } from "@api/gridOverlays";
import {
  getSelectedObjectRegions,
  notifyObjectSelectionChanged,
  noteWorksheetObjectPress,
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  setObjectSelectionSet,
  shouldActOnWholeObjectSelection,
  type ObjectSelectionKey,
  type ObjectSelectionProvider,
} from "@api/objectSelection";
import { noteObjectGripMenuOpen, resetObjectPosition } from "@api/objectPosition";
import type { GridCellPress } from "@api/cellClickInterceptors";
import {
  installSelectedObjectKeys,
  OBJECT_DELETE_SELECTION_COMMAND,
  OBJECT_DESELECT_COMMAND,
  SELECTED_OBJECT_OWNER_ID,
  SELECTED_OBJECT_REFUSAL_QUIET_MS,
  selectedObjectRefusal,
} from "../lib/selectedObjectKeys";
import extension from "../index";
import { createChartObjectSelectionProvider } from "../../../Charts/lib/chartObjectSelection";
import {
  resetSelectionHandlerState,
  selectChart,
  setSubSelection,
} from "../../../Charts/handlers/selectionHandler";

// THE SHELL'S ORDER: the dispatcher's listener is installed at bootstrap,
// before any extension activates, and the built-ins are registered first.
initKeybindings();

const toasts: ToastPayload[] = [];
registerToastSink((t) => toasts.push(t));
const toastTexts = (): string[] => toasts.map((t) => t.message);

const CLEAR = "core.edit.clearContents";
/** Commands the dispatcher ran (stand-ins for Core's own handlers). */
const ran: string[] = [];

function region(id: string, type: string, x = 0): GridRegion {
  return { id, type, startRow: 0, startCol: 0, endRow: 0, endCol: 0, floating: { x, y: 0, width: 10, height: 10 } };
}

interface FakeFamily {
  provider: ObjectSelectionProvider;
  deleted: string[][];
  selected: Set<string>;
  deselects: { count: number };
  owns: Set<ObjectSelectionKey>;
  refuseWith: { reason: string | null };
}

/** A family that holds several (Slicer's, Timeline's shape) and deletes through the seam. */
function family(type: string, label: string): FakeFamily {
  const selected = new Set<string>();
  const deleted: string[][] = [];
  const deselects = { count: 0 };
  const owns = new Set<ObjectSelectionKey>();
  const refuseWith: { reason: string | null } = { reason: null };
  const provider: ObjectSelectionProvider = {
    types: [type],
    isSelected: (r) => selected.has(r.id),
    select: (r) => {
      selected.clear();
      selected.add(r.id);
      notifyObjectSelectionChanged();
    },
    addToSelection: (r) => {
      selected.add(r.id);
    },
    removeFromSelection: (r) => {
      selected.delete(r.id);
    },
    deselectAll: () => {
      deselects.count++;
      selected.clear();
    },
    ownsKey: (key) => owns.has(key),
    labelOf: (r) => `${label} ${r.id}`,
    deleteObjects: async (regions) => {
      if (refuseWith.reason !== null) throw new Error(refuseWith.reason);
      deleted.push(regions.map((r) => r.id));
      for (const r of regions) selected.delete(r.id);
      setGridRegions(getGridRegions().filter((g) => !regions.some((r) => r.id === g.id)));
    },
  };
  return { provider, deleted, selected, deselects, owns, refuseWith };
}

const s1 = region("s1", "slicer", 0);
const t1 = region("t1", "timeline-slicer", 20);
const chartRegion: GridRegion = { ...region("chart-c1", "chart", 40), data: { chartId: "c1" } };

let slicers: FakeFamily;
let timelines: FakeFamily;
const cleanups: Array<() => void> = [];
let container: HTMLDivElement;

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

function install(): void {
  cleanups.push(installSelectedObjectKeys({ commands: CommandRegistry }, "calcula.object-position"));
}

beforeEach(() => {
  surface = "grid";
  ran.length = 0;
  toasts.length = 0;
  undoLog.length = 0;
  resetObjectSelectionProviders();
  resetObjectPosition();
  resetSelectionHandlerState();
  CommandRegistry.register(CLEAR, () => void ran.push(CLEAR));
  slicers = family("slicer", "Slicer");
  timelines = family("timeline-slicer", "Timeline");
  cleanups.push(
    registerGridOverlay({ type: "slicer", render: () => {}, priority: 10 }),
    registerGridOverlay({ type: "timeline-slicer", render: () => {}, priority: 11 }),
    registerGridOverlay({ type: "chart", render: () => {}, priority: 15 }),
    registerObjectSelectionProvider(slicers.provider),
    registerObjectSelectionProvider(timelines.provider),
  );
  setGridRegions([s1, t1, chartRegion]);
  container = document.createElement("div");
  container.setAttribute("data-focus-container", "spreadsheet");
  container.tabIndex = 0;
  document.body.appendChild(container);
  container.focus();
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  CommandRegistry.unregister(CLEAR);
  resetObjectSelectionProviders();
  resetObjectPosition();
  resetSelectionHandlerState();
  setGridRegions([]);
  container.remove();
  document.body.innerHTML = "";
});

// ============================================================================
// T1-T3: the claim
// ============================================================================

describe("T1 the claim: an object SELECTED on a worksheet owns the selection", () => {
  it("selected on a worksheet: owned, with the object's sentence, and nothing of it takes typing", () => {
    install();
    expect(isSelectionOwned(), "control: nothing selected").toBe(false);
    setObjectSelectionSet([s1], s1);
    expect(isSelectionOwned(), "a typed character, F2 or Delete would act on the cell BEHIND the slicer").toBe(true);
    expect(getSelectionOwner()?.id).toBe(SELECTED_OBJECT_OWNER_ID);
    for (const action of ["Edit Cell", "Clear Contents", "Open the In-Cell List"]) {
      expect(selectionRefusalFor(action)).toBe(selectedObjectRefusal(action));
    }
    expect(getSelectionOwner()?.receivesTyping?.() ?? false, "nothing of an object takes typing").toBe(false);
  });

  it("the sentence names the action and the way back", () => {
    expect(selectedObjectRefusal("Edit Cell")).toBe(
      "Edit Cell is not available while an object is selected. Press Escape or click a cell to go back to the cells. Nothing was changed.",
    );
  });

  it("a CANVAS has no cell behind its objects: no claim there", () => {
    install();
    surface = "canvas";
    setObjectSelectionSet([s1], s1);
    expect(isSelectionOwned(), "a canvas object claimed a cell selection that does not exist").toBe(false);
  });

  it("the claim ends with the selection and with the extension", () => {
    install();
    setObjectSelectionSet([s1], s1);
    expect(isSelectionOwned()).toBe(true);
    slicers.provider.deselectAll();
    expect(isSelectionOwned(), "the claim outlived the selection").toBe(false);
    setObjectSelectionSet([s1], s1);
    cleanups.pop()!();
    expect(isSelectionOwned(), "the claim outlived the extension").toBe(false);
  });
});

describe("T2 the generic claim stands BEHIND a specific one, whatever the order", () => {
  it("a specific owner registered AFTER it speaks first (a floating grid's cell, the keyboard inside a slicer)", () => {
    install();
    cleanups.push(
      registerSelectionOwner({
        id: "specific",
        label: "a floating grid's cells",
        ownsSelection: () => true,
        refusal: (a) => `${a}: specific.`,
        receivesTyping: () => true,
      }),
    );
    setObjectSelectionSet([s1], s1);
    expect(selectionRefusalFor("Edit Cell")).toBe("Edit Cell: specific.");
    expect(getSelectionOwner()?.receivesTyping?.()).toBe(true);
  });
});

describe("T3 a real door refuses: the grid-command bridge (Clear Contents)", () => {
  it("with an object selected the bridge refuses ONCE with the object's sentence; with none it says nothing", async () => {
    install();
    CommandRegistry.unregister(CLEAR); // the REAL bridge (CommandRegistry -> gridCommands)
    setObjectSelectionSet([s1], s1);
    await CommandRegistry.execute(CLEAR);
    expect(toastTexts()).toEqual([selectedObjectRefusal("Clear Contents")]);
    toasts.length = 0;
    slicers.provider.deselectAll();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await CommandRegistry.execute(CLEAR);
    warn.mockRestore();
    expect(toastTexts(), "control: Core's grid holds the selection, nothing refuses").toEqual([]);
  });
});

// ============================================================================
// T4-T8: Delete / Backspace
// ============================================================================

describe("T4 Delete / Backspace with an object selected on a worksheet delete the OBJECT", () => {
  for (const key of ["Delete", "Backspace"]) {
    it(`${key}: the slicer is deleted through its family, ONE undo step; the hidden cell is never cleared`, async () => {
      install();
      setObjectSelectionSet([s1], s1);
      const e = press(key);
      await settle();
      expect(e.defaultPrevented, `${key} was not taken`).toBe(true);
      expect(slicers.deleted, "Delete did not delete the selected slicer").toEqual([["s1"]]);
      expect(ran, "Delete cleared the cell behind the slicer").not.toContain(CLEAR);
      expect(undoLog).toEqual(["begin:Delete Objects", "commit"]);
      expect(getSelectedObjectRegions()).toEqual([]);
      expect(toasts).toEqual([]);
    });
  }

  it("a slicer and a timeline selected together: both deleted inside ONE undo step", async () => {
    install();
    setObjectSelectionSet([s1, t1], s1);
    press("Delete");
    await settle();
    expect(slicers.deleted).toEqual([["s1"]]);
    expect(timelines.deleted).toEqual([["t1"]]);
    expect(undoLog).toEqual(["begin:Delete Objects", "commit"]);
    expect(ran).not.toContain(CLEAR);
  });
});

describe("T5 the generic Delete stands down", () => {
  it("a) the family owns Delete (the keyboard inside the slicer): nothing deleted; the claim refuses Clear Contents", async () => {
    install();
    CommandRegistry.unregister(CLEAR); // the real bridge, which asks the claim
    setObjectSelectionSet([s1], s1);
    slicers.owns.add("Delete");
    press("Delete");
    await settle();
    expect(slicers.deleted, "Delete INSIDE the slicer deleted it").toEqual([]);
    expect(toastTexts()).toEqual([selectedObjectRefusal("Clear Contents")]);
  });

  it("b) a button outside the grid has the keyboard: nothing deleted, the key is not taken", async () => {
    install();
    setObjectSelectionSet([s1], s1);
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    const e = press("Delete");
    await settle();
    expect(slicers.deleted, "a task pane's button + Delete destroyed the slicer").toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });

  it("c) a text field has the keyboard: nothing deleted", async () => {
    install();
    setObjectSelectionSet([s1], s1);
    const input = document.createElement("input");
    container.appendChild(input);
    input.focus();
    press("Delete");
    await settle();
    expect(slicers.deleted).toEqual([]);
    expect(ran).not.toContain(CLEAR);
  });

  it("d) an object's grip menu is open (its keys are its own): nothing deleted", async () => {
    install();
    setObjectSelectionSet([s1], s1);
    const closeMenu = noteObjectGripMenuOpen();
    try {
      press("Delete");
      await settle();
      expect(slicers.deleted, "Delete behind an open grip menu deleted the object").toEqual([]);
    } finally {
      closeMenu();
    }
  });

  it("e) positive control: nothing selected -- Delete is Clear Contents again", async () => {
    install();
    const e = press("Delete");
    await settle();
    expect(ran).toEqual([CLEAR]);
    expect(e.defaultPrevented).toBe(true);
    expect(slicers.deleted).toEqual([]);
  });
});

describe("T6 a family's OWN door keeps the key", () => {
  it("a) a guarded family door registered EARLIER wins the tie (registration order): only it runs", async () => {
    const ownDoor: string[] = [];
    CommandRegistry.register("test.chartDoor", () => void ownDoor.push("chart"));
    cleanups.push(() => CommandRegistry.unregister("test.chartDoor"));
    let chartSelected = true;
    cleanups.push(
      registerKeybinding(
        {
          id: "test.chartDoor.delete",
          combo: "Delete",
          commandId: "test.chartDoor",
          label: "Delete Chart Selection",
          category: "Editing",
          context: "not-editing",
          source: "extension",
          extensionId: "test.charts",
        },
        () => chartSelected,
      ),
    );
    install();
    setObjectSelectionSet([s1], s1);
    press("Delete");
    await settle();
    expect(ownDoor).toEqual(["chart"]);
    expect(slicers.deleted, "the generic Delete beat the family's own door").toEqual([]);
    chartSelected = false;
    press("Delete");
    await settle();
    expect(slicers.deleted, "control: with the family door off, the generic deletes").toEqual([["s1"]]);
  });

  it("b) Charts' REAL provider: Backspace on a chart's TITLE never deletes the whole chart", async () => {
    const deleteCharts = vi.fn(async () => []);
    cleanups.push(
      registerObjectSelectionProvider(
        createChartObjectSelectionProvider({
          emitSelection: () => {},
          invalidateChart: () => {},
          refresh: () => {},
          deleteCharts,
        }),
      ),
    );
    install();
    selectChart("c1");
    setSubSelection("c1", { level: "element", elementId: "title" });
    expect(getSelectedObjectRegions().map((r) => r.id), "fixture: the chart is selected").toEqual(["chart-c1"]);
    press("Backspace");
    await settle();
    expect(deleteCharts, "Backspace on the chart's title deleted the whole chart").not.toHaveBeenCalled();
  });
});

describe("T7 on a CANVAS: one slicer selected -- no family door, no spanning selection -- Delete deletes it", () => {
  it("the dead key is closed: deleted through its family as ONE undo step", async () => {
    install();
    surface = "canvas";
    setObjectSelectionSet([s1], s1);
    const e = press("Delete");
    await settle();
    expect(e.defaultPrevented).toBe(true);
    expect(slicers.deleted, "Delete with ONE slicer selected on a canvas did nothing").toEqual([["s1"]]);
    expect(undoLog).toEqual(["begin:Delete Objects", "commit"]);
  });
});

describe("T8 a REFUSED delete (a protected sheet): the key is taken, the object stays, ONE toast says why", () => {
  it("nothing reaches the cell, the slicer stays selected and is named with the reason", async () => {
    install();
    slicers.refuseWith.reason = "The sheet is protected.";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    setObjectSelectionSet([s1], s1);
    const e = press("Delete");
    await settle();
    err.mockRestore();
    expect(e.defaultPrevented).toBe(true);
    expect(ran).not.toContain(CLEAR);
    expect(getSelectedObjectRegions().map((r) => r.id)).toEqual(["s1"]);
    expect(toastTexts()).toEqual([
      "Delete Objects: 1 selected object was not deleted (Slicer s1). The sheet is protected.",
    ]);
  });
});

// ============================================================================
// T9: Escape
// ============================================================================

describe("T9 Escape on a worksheet goes back to the cells", () => {
  it("deselects every object (every family is asked) and ends the claim", async () => {
    install();
    setObjectSelectionSet([s1], s1);
    const before = timelines.deselects.count;
    const e = press("Escape");
    await settle();
    expect(e.defaultPrevented, "Escape was not taken").toBe(true);
    expect(getSelectedObjectRegions(), "Escape did not deselect the slicer").toEqual([]);
    expect(timelines.deselects.count).toBeGreaterThan(before);
    expect(isSelectionOwned()).toBe(false);
  });

  it("stands down while a family owns Escape (a chart below chart level, an open menu, the keyboard inside)", async () => {
    install();
    setObjectSelectionSet([s1], s1);
    slicers.owns.add("Escape");
    const e = press("Escape");
    await settle();
    expect(e.defaultPrevented).toBe(false);
    expect(getSelectedObjectRegions().map((r) => r.id)).toEqual(["s1"]);
  });

  it("stands down on a CANVAS (its own Escape answers there)", async () => {
    install();
    surface = "canvas";
    setObjectSelectionSet([s1], s1);
    const e = press("Escape");
    await settle();
    expect(e.defaultPrevented).toBe(false);
    expect(getSelectedObjectRegions().map((r) => r.id)).toEqual(["s1"]);
  });

  it("stands down while a grip menu is open, and with the keyboard outside the grid", async () => {
    install();
    setObjectSelectionSet([s1], s1);
    const closeMenu = noteObjectGripMenuOpen();
    expect(press("Escape").defaultPrevented).toBe(false);
    closeMenu();
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    expect(press("Escape").defaultPrevented).toBe(false);
    expect(getSelectedObjectRegions().map((r) => r.id)).toEqual(["s1"]);
  });

  it("positive control: nothing selected -- Escape is not taken", () => {
    install();
    expect(press("Escape").defaultPrevented).toBe(false);
  });
});

// ============================================================================
// T10-T11: the extension wires it, and activates after every family
// ============================================================================

describe("T10 the Size and Position extension installs and removes it", () => {
  it("activate: the claim, both commands and the three bindings; deactivate: none of them", async () => {
    await extension.activate({ commands: CommandRegistry } as never);
    try {
      expect(CommandRegistry.has(OBJECT_DELETE_SELECTION_COMMAND)).toBe(true);
      expect(CommandRegistry.has(OBJECT_DESELECT_COMMAND)).toBe(true);
      for (const id of [
        "ext.objectPosition.deleteSelection.delete",
        "ext.objectPosition.deleteSelection.backspace",
        "ext.objectPosition.deselect",
      ]) {
        expect(getKeybinding(id), `${id} was not registered`).toBeDefined();
      }
      setObjectSelectionSet([s1], s1);
      expect(getSelectionOwner()?.id, "the claim was not registered").toBe(SELECTED_OBJECT_OWNER_ID);
    } finally {
      await extension.deactivate?.();
    }
    expect(CommandRegistry.has(OBJECT_DELETE_SELECTION_COMMAND)).toBe(false);
    expect(CommandRegistry.has(OBJECT_DESELECT_COMMAND)).toBe(false);
    expect(getKeybinding("ext.objectPosition.deleteSelection.delete")).toBeUndefined();
    expect(getKeybinding("ext.objectPosition.deleteSelection.backspace")).toBeUndefined();
    expect(getKeybinding("ext.objectPosition.deselect")).toBeUndefined();
    expect(isSelectionOwned(), "the claim outlived deactivate").toBe(false);
  });
});

// ============================================================================
// T12: a press ON THE SHEET ends the claim, even one that changes nothing
// ============================================================================

describe("T12 a press on the sheet that leaves Core's selection unchanged still ends the claim (review finding 6)", () => {
  // Families drop their selection when Core's selection CHANGES. Two presses
  // change nothing: a click on the cell Core already has active (Controls
  // dedupes the identical selection), and a right-press INSIDE the selection
  // (Core keeps it for the context menu). Both left the object selected and
  // the claim on, so typing and the grid menu's Clear Contents were refused
  // with "click a cell" right after the user had clicked one.
  const cellPress = (over: Partial<GridCellPress> = {}): GridCellPress => ({
    row: 0,
    col: 0,
    button: 0,
    shiftKey: false,
    ctrlKey: false,
    target: "cell",
    keptSelection: false,
    ...over,
  });

  it("a left click on the ACTIVE cell deselects the object and ends the claim", () => {
    install();
    setObjectSelectionSet([s1], s1);
    expect(isSelectionOwned(), "fixture: the slicer is selected").toBe(true);
    notifyGridCellPressed(cellPress());
    expect(getSelectedObjectRegions(), "a click on the active cell left the slicer selected").toEqual([]);
    expect(isSelectionOwned(), "the user clicked a cell and the keyboard is still refused").toBe(false);
  });

  it("a right-press INSIDE the selection (the grid's context menu) deselects every family's object", () => {
    install();
    setObjectSelectionSet([s1, t1], s1);
    notifyGridCellPressed(cellPress({ button: 2, keptSelection: true }));
    expect(getSelectedObjectRegions(), "the grid menu would open with the objects still selected").toEqual([]);
    expect(isSelectionOwned()).toBe(false);
  });

  it("a row or column HEADER press ends it too", () => {
    install();
    setObjectSelectionSet([s1], s1);
    notifyGridCellPressed(cellPress({ target: "row", col: -1 }));
    expect(getSelectedObjectRegions()).toEqual([]);
  });

  it("with nothing selected a cell press deselects nobody (no family is asked)", () => {
    install();
    notifyGridCellPressed(cellPress());
    expect(slicers.deselects.count + timelines.deselects.count, "a plain cell click churned every family").toBe(0);
  });

  it("removed with the extension: after the cleanup a cell press leaves the selection alone", () => {
    install();
    cleanups.pop()!();
    setObjectSelectionSet([s1], s1);
    notifyGridCellPressed(cellPress());
    expect(getSelectedObjectRegions().map((r) => r.id)).toEqual(["s1"]);
  });
});

// ============================================================================
// T13: a chart clicked BEFORE a slicer on a worksheet (Charts' REAL provider)
// ============================================================================

describe("T13 worksheet: a chart clicked, then a slicer -- Delete deletes the SLICER (review finding 2)", () => {
  // Before worksheet press parity both stayed selected; Charts owns Delete
  // whenever a chart is selected, so its door won and deleted the chart the
  // user clicked EARLIER, leaving the slicer just clicked selected and
  // standing (a second Delete, a second undo step).
  function realCharts(): ReturnType<typeof vi.fn> {
    const deleteCharts = vi.fn(async () => []);
    cleanups.push(
      registerObjectSelectionProvider(
        createChartObjectSelectionProvider({ emitSelection: () => {}, invalidateChart: () => {}, refresh: () => {}, deleteCharts }),
      ),
    );
    return deleteCharts;
  }

  it("a plain press on the slicer deselects the chart; Delete then deletes the slicer alone, as ONE undo step", async () => {
    const deleteCharts = realCharts();
    install();
    selectChart("c1"); // the chart's own press handler
    noteWorksheetObjectPress(s1); // Core, before the slicer hears its press
    slicers.provider.select(s1); // the slicer's own press handler
    expect(getSelectedObjectRegions().map((r) => r.id), "the chart clicked EARLIER is still selected").toEqual(["s1"]);
    const e = press("Delete");
    await settle();
    expect(e.defaultPrevented).toBe(true);
    expect(deleteCharts, "Delete deleted the chart the user clicked BEFORE the slicer").not.toHaveBeenCalled();
    expect(slicers.deleted, "the slicer just clicked was left standing").toEqual([["s1"]]);
    expect(undoLog).toEqual(["begin:Delete Objects", "commit"]);
    expect(getSelectedObjectRegions()).toEqual([]);
  });

  it("a Ctrl press keeps the chart: a deliberate selection, which the chart's own door hands to the WHOLE delete", () => {
    realCharts();
    install();
    selectChart("c1");
    noteWorksheetObjectPress(s1, { ctrlKey: true });
    slicers.provider.addToSelection!(s1);
    expect(getSelectedObjectRegions().map((r) => r.id).sort()).toEqual(["chart-c1", "s1"]);
    expect(shouldActOnWholeObjectSelection(), "Charts' door would delete the chart and leave the slicer").toBe(true);
  });
});

// ============================================================================
// T14: one toast per sentence while the object stays selected
// ============================================================================

describe("T14 a refused keystroke repeats SILENTLY while the same object stays selected (review finding 5)", () => {
  // Typing a word with a slicer selected queued one identical toast per
  // character (Excel says nothing at all). Every refusal still refuses --
  // nothing reaches the cell -- but each sentence is SAID once per selection.
  it("the same refusal three times is ONE toast; the door refuses every time", async () => {
    install();
    CommandRegistry.unregister(CLEAR); // the REAL bridge, which asks the claim
    setObjectSelectionSet([s1], s1);
    for (let i = 0; i < 3; i++) await CommandRegistry.execute(CLEAR);
    expect(toastTexts(), "a toast per refused keystroke").toEqual([selectedObjectRefusal("Clear Contents")]);
    expect(isSelectionOwned(), "the quiet repeat ended the claim").toBe(true);
  });

  it("a DIFFERENT action is still said (once), and a NEW selection says it again", async () => {
    install();
    CommandRegistry.unregister(CLEAR);
    setObjectSelectionSet([s1], s1);
    await CommandRegistry.execute(CLEAR);
    expect(refuseIfSelectionOwned("Edit Cell")).toBe(true);
    expect(refuseIfSelectionOwned("Edit Cell")).toBe(true);
    expect(toastTexts()).toEqual([selectedObjectRefusal("Clear Contents"), selectedObjectRefusal("Edit Cell")]);
    toasts.length = 0;
    setObjectSelectionSet([t1], t1); // another object selected: a new episode
    expect(refuseIfSelectionOwned("Edit Cell")).toBe(true);
    expect(toastTexts(), "the refusal for a NEW selection was swallowed").toEqual([selectedObjectRefusal("Edit Cell")]);
  });

  it("once its toast has had time to go, the same refusal is said again", () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      install();
      setObjectSelectionSet([s1], s1);
      expect(refuseIfSelectionOwned("Edit Cell")).toBe(true);
      now += SELECTED_OBJECT_REFUSAL_QUIET_MS - 1;
      expect(refuseIfSelectionOwned("Edit Cell")).toBe(true);
      expect(toastTexts().length, "a second copy while the first toast is still on screen").toBe(1);
      now += 2;
      expect(refuseIfSelectionOwned("Edit Cell")).toBe(true);
      expect(toastTexts().length, "after the toast went, the refusal was never said again").toBe(2);
    } finally {
      clock.mockRestore();
    }
  });
});

// ============================================================================
// T15: the commands re-check at RUN time; the claim follows the published regions
// ============================================================================

describe("T15 review finding 10: the gaps no test failed on", () => {
  it("object.deleteSelection run from the palette or a script with the keyboard OUTSIDE the grid deletes nothing", async () => {
    install();
    setObjectSelectionSet([s1], s1);
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    await CommandRegistry.execute(OBJECT_DELETE_SELECTION_COMMAND);
    await settle();
    expect(slicers.deleted, "the command deleted the slicer without asking where the keyboard is").toEqual([]);
    container.focus();
    await CommandRegistry.execute(OBJECT_DELETE_SELECTION_COMMAND);
    await settle();
    expect(slicers.deleted, "control: with the grid's keyboard the command deletes").toEqual([["s1"]]);
  });

  it("object.deleteSelection deletes nothing while a family owns Delete (the keyboard inside the slicer)", async () => {
    install();
    setObjectSelectionSet([s1], s1);
    slicers.owns.add("Delete");
    await CommandRegistry.execute(OBJECT_DELETE_SELECTION_COMMAND);
    await settle();
    expect(slicers.deleted).toEqual([]);
  });

  it("object.deselect run on a CANVAS deselects nothing (the canvas's own Escape answers there)", async () => {
    install();
    surface = "canvas";
    setObjectSelectionSet([s1], s1);
    await CommandRegistry.execute(OBJECT_DESELECT_COMMAND);
    expect(getSelectedObjectRegions().map((r) => r.id)).toEqual(["s1"]);
  });

  it("the claim ends when the object's region is UNPUBLISHED (a sheet switch, File > New) while its family still holds its id", () => {
    install();
    setObjectSelectionSet([s1], s1);
    expect(isSelectionOwned()).toBe(true);
    setGridRegions([t1, chartRegion]);
    expect(slicers.selected.has("s1"), "fixture: the family still holds the id").toBe(true);
    expect(isSelectionOwned(), "a slicer that is no longer on the sheet kept the keyboard refused").toBe(false);
  });
});

// Owner call 25 (2026-10-02, Excel parity): Insert Shape, Insert > Controls >
// Button and Insert Image stay available while an object is selected. The
// claim ADMITS that kind of door and nothing else; the doors themselves are
// driven through the real Insert menu in
// Controls/__tests__/insertWithObjectSelected.test.ts.
describe("T16 the claim admits the object-insert doors, and only them (owner call 25)", () => {
  it("an object selected on a worksheet: an objectInsert door passes, silently; every other door is still refused", () => {
    install();
    setObjectSelectionSet([s1], s1);
    expect(getSelectionOwner()?.id, "precondition: the claim holds").toBe(SELECTED_OBJECT_OWNER_ID);
    expect(getSelectionOwner()?.admits ?? [], "the claim no longer admits the object inserts").toEqual(["objectInsert"]);
    expect(refuseIfSelectionOwned("Insert Shape", "objectInsert"), "Insert Shape refused with a slicer selected").toBe(
      false,
    );
    expect(selectionRefusalFor("Insert Image", "objectInsert")).toBeNull();
    expect(toasts, "an admitted insert announced a refusal").toEqual([]);
    // Every other door, the same Insert action included when it does not ask as an insert.
    for (const action of ["Edit Cell", "Clear Contents", "Insert Table"]) {
      expect(selectionRefusalFor(action), `${action} passed the claim`).toBe(selectedObjectRefusal(action));
    }
  });
});

describe("T11 it activates AFTER every object family and the canvas (a family's own Delete wins the tie)", () => {
  it("extensions/manifest.ts lists ObjectPositionExtension after Charts, FloatingRange, Pivot, Slicer, Timeline, Controls and CanvasSheet", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const manifest = readFileSync(path.resolve(__dirname, "../../../manifest.ts"), "utf8").replace(/\/\/.*$/gm, "");
    const list = manifest.slice(manifest.indexOf("export const builtInExtensions"));
    const at = (name: string): number => {
      const m = new RegExp(`\\n\\s*${name},\\n`).exec(list);
      expect(m, `${name} is not in the activation order`).not.toBeNull();
      return m!.index;
    };
    const objectPosition = at("ObjectPositionExtension");
    for (const family of [
      "ChartExtension",
      "FloatingRangeExtension",
      "PivotExtension",
      "SlicerExtension",
      "TimelineSlicerExtension",
      "ControlsExtension",
      "CanvasSheetExtension",
    ]) {
      expect(at(family), `${family} activates AFTER the generic Delete: its own door would lose the tie`).toBeLessThan(
        objectPosition,
      );
    }
  });
});
