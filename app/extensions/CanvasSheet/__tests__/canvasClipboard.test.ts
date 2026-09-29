//! FILENAME: app/extensions/CanvasSheet/__tests__/canvasClipboard.test.ts
// PURPOSE: Ctrl+C / Ctrl+V / Ctrl+D on a CANVAS copy, paste and duplicate EVERY
//          selected object -- across families, set-held members included --
//          through the REAL keybinding dispatcher, with Controls' own key door
//          installed beside the canvas's (W25, open-items 2.af row 1).
// CONTEXT: Controls registers its Ctrl+C / Ctrl+V / Ctrl+D bindings before the
//          canvas does, so on a tie Controls wins. Before W25 its door REFUSED
//          a selection that held another family's object (a toast, nothing
//          copied), and a selection with no control in it fell through to the
//          grid's Copy / Paste / Fill Down, which copy nothing on a page
//          without cells. Now Controls stands aside on a canvas and the
//          canvas's door acts on the whole selection through the object
//          clipboard.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let surface: "canvas" | "grid" = "canvas";
vi.mock("../../../src/core/state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/state/GridContext")>()),
  getGridStateSnapshot: () => ({ surface, sheetContext: { activeSheetIndex: 0 } }),
}));
const log: string[] = [];
vi.mock("../../../src/core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginUndoTransaction: vi.fn(async (label: string) => {
    log.push(`begin:${label}`);
  }),
  commitUndoTransaction: vi.fn(async () => {
    log.push("commit");
  }),
}));
const toasts: string[] = [];
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  showToast: (message: string) => {
    toasts.push(message);
  },
}));
let subscribed = false;
vi.mock("../lib/canvasSheetStore", () => ({
  getCanvasSheetSnapshot: () => ({ activeSubscribed: subscribed }),
}));

import { CommandRegistry } from "@api/commands";
import { initKeybindings } from "@api/keybindings";
import { getGridRegions, registerGridOverlay, setGridRegions, type GridRegion } from "@api/gridOverlays";
import {
  getSelectedObjectRegions,
  notifyObjectSelectionChanged,
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  setObjectSelectionSet,
  type ObjectPasteTarget,
  type ObjectSelectionKey,
  type ObjectSelectionProvider,
} from "@api/objectSelection";
import { hasObjectClipboard, objectClipboardSize, resetObjectClipboard } from "@api/objectClipboard";
import { canvasObjectRef } from "@api/canvasSheet";
import { installCanvasObjectClipboard } from "../lib/canvasClipboard";
import { SUBSCRIBED_NOTE } from "../lib/canvasNotes";
import { installControlClipboardKeys } from "../../Controls/lib/controlKeys";

initKeybindings();

function region(id: string, type: string, x: number): GridRegion {
  return { id, type, startRow: 0, startCol: 0, endRow: 0, endCol: 0, floating: { x, y: 10, width: 50, height: 20 } };
}

const made: string[] = [];
let seq = 0;
let innerOwnsClipboard = false;

/** A family with the real provider shape; `multi` = holds several itself (Controls). */
function family(type: string, kind: "chart" | "control", multi: boolean): ObjectSelectionProvider {
  const selected = new Set<string>();
  const p: ObjectSelectionProvider = {
    types: [type],
    isSelected: (r) => selected.has(r.id),
    select: (r) => {
      selected.clear();
      selected.add(r.id);
      notifyObjectSelectionChanged();
    },
    deselectAll: () => {
      selected.clear();
    },
    refOf: (r) => canvasObjectRef(kind, r.id),
    labelOf: (r) => r.id,
    copyObjects: (regions) => regions.map((r) => ({ from: r.id, x: r.floating!.x, y: r.floating!.y })),
    pasteObjects: async (snaps, target: ObjectPasteTarget) => {
      const created = [];
      for (const raw of snaps) {
        const s = raw as { from: string; x: number; y: number };
        const at = target.place({ x: s.x, y: s.y, width: 50, height: 20 });
        const id = `${s.from}+${++seq}`;
        made.push(`${id}@${at.x}`);
        setGridRegions([...getGridRegions(), region(id, type, at.x)]);
        created.push(canvasObjectRef(kind, id));
      }
      return { created };
    },
    ownsKey: (key: ObjectSelectionKey) => key === "Clipboard" && innerOwnsClipboard && type === "floating-range",
  };
  if (multi) {
    p.addToSelection = (r) => {
      selected.add(r.id);
    };
    p.removeFromSelection = (r) => {
      selected.delete(r.id);
    };
  }
  return p;
}

/** A family that cannot copy (a floating range): selects, and may own the clipboard keys. */
function rangeFamily(): ObjectSelectionProvider {
  let selected: string | null = null;
  return {
    types: ["floating-range"],
    isSelected: (r) => r.id === selected,
    select: (r) => {
      selected = r.id;
    },
    deselectAll: () => {
      selected = null;
    },
    labelOf: (r) => `Grid ${r.id}`,
    ownsKey: (key: ObjectSelectionKey) => key === "Clipboard" && innerOwnsClipboard,
  };
}

const controlsDoor = {
  selectedIds: () => getSelectedObjectRegions().filter((r) => r.type === "floating-control").map((r) => r.id),
  hasClipboard: () => hasObjectClipboard(),
  copy: vi.fn(async (_ids: readonly string[]) => {}),
  paste: vi.fn(async () => {}),
  duplicate: vi.fn(async (_ids: readonly string[]) => {}),
  group: vi.fn((_ids: string[]) => {}),
};
const builtIns = { copy: vi.fn(), paste: vi.fn(), fillDown: vi.fn() };

const c1 = region("c1", "chart", 0);
const c2 = region("c2", "chart", 100);
const k1 = region("k1", "floating-control", 200);
const r1 = region("r1", "floating-range", 300);
const cleanups: Array<() => void> = [];
let gridContainer: HTMLDivElement;

function press(key: string): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true });
  gridContainer.dispatchEvent(e);
  return e;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  surface = "canvas";
  subscribed = false;
  innerOwnsClipboard = false;
  log.length = 0;
  toasts.length = 0;
  made.length = 0;
  seq = 0;
  resetObjectClipboard();
  resetObjectSelectionProviders();
  for (const f of [controlsDoor.copy, controlsDoor.paste, controlsDoor.duplicate, ...Object.values(builtIns)]) f.mockClear();
  CommandRegistry.register("core.clipboard.copy", builtIns.copy);
  CommandRegistry.register("core.clipboard.paste", builtIns.paste);
  CommandRegistry.register("core.edit.fillDown", builtIns.fillDown);
  cleanups.push(
    registerGridOverlay({ type: "chart", render: () => {}, priority: 15 }),
    registerGridOverlay({ type: "floating-control", render: () => {}, priority: 20 }),
    registerGridOverlay({ type: "floating-range", render: () => {}, priority: 14 }),
    registerObjectSelectionProvider(family("chart", "chart", false)),
    registerObjectSelectionProvider(family("floating-control", "control", true)),
    registerObjectSelectionProvider(rangeFamily()),
    // Controls' door FIRST, as the app activates it: it would win a tie.
    installControlClipboardKeys("calcula.controls", controlsDoor),
    ...installCanvasObjectClipboard("calcula.canvas-sheet"),
  );
  setGridRegions([c1, c2, k1, r1]);
  gridContainer = document.createElement("div");
  gridContainer.setAttribute("data-focus-container", "spreadsheet");
  gridContainer.tabIndex = 0;
  document.body.appendChild(gridContainer);
  gridContainer.focus();
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  for (const id of ["core.clipboard.copy", "core.clipboard.paste", "core.edit.fillDown"]) CommandRegistry.unregister(id);
  resetObjectSelectionProviders();
  resetObjectClipboard();
  setGridRegions([]);
  gridContainer.remove();
});

describe("Ctrl+C / Ctrl+V / Ctrl+D on a canvas multi-selection", () => {
  it("Ctrl+C copies EVERY selected object -- two charts (one set-held) and a shape -- and nothing else runs", async () => {
    setObjectSelectionSet([c1, c2, k1], c1);
    const e = press("c");
    await settle();
    expect(e.defaultPrevented).toBe(true);
    expect(objectClipboardSize(), "the canvas copy left members out (or Controls refused it)").toBe(3);
    expect(controlsDoor.copy, "Controls' own door acted on the controls alone").not.toHaveBeenCalled();
    expect(builtIns.copy, "the grid's cell copy ran on a canvas").not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
  });

  it("Ctrl+V pastes every copied object as ONE undo step, and the copies become the selection", async () => {
    setObjectSelectionSet([c1, c2, k1], c1);
    press("c");
    await settle();
    log.length = 0;
    press("v");
    await settle();
    expect(made).toEqual(["c1+1@20", "c2+2@120", "k1+3@220"]);
    expect(log[0]).toBe("begin:Paste Objects");
    expect(log.filter((l) => l.startsWith("begin:")).length, "the paste was more than one undo step").toBe(1);
    expect(getSelectedObjectRegions().map((r) => r.id).sort()).toEqual(["c1+1", "c2+2", "k1+3"]);
    expect(builtIns.paste).not.toHaveBeenCalled();
    expect(controlsDoor.paste).not.toHaveBeenCalled();
  });

  it("Ctrl+D duplicates every selected object as ONE undo step, the copies selected; Fill Down does not run", async () => {
    setObjectSelectionSet([c1, c2, k1], k1);
    press("d");
    await settle();
    expect(made.sort()).toEqual(["c1+1@20", "c2+2@120", "k1+3@220"].sort());
    expect(log.filter((l) => l.startsWith("begin:"))).toEqual(["begin:Duplicate Objects"]);
    expect(getSelectedObjectRegions().length).toBe(3);
    expect(builtIns.fillDown, "Ctrl+D filled down on a canvas").not.toHaveBeenCalled();
    expect(controlsDoor.duplicate).not.toHaveBeenCalled();
  });

  it("a member that cannot be copied (a floating grid) is left out and named in ONE toast", async () => {
    setObjectSelectionSet([c1, r1], c1);
    press("c");
    await settle();
    expect(objectClipboardSize()).toBe(1);
    expect(toasts.length).toBe(1);
    expect(toasts[0]).toContain("Grid r1");
  });

  it("Ctrl+V with NOTHING selected pastes onto the page (a canvas has no cells to paste into)", async () => {
    setObjectSelectionSet([c1], c1);
    press("c");
    await settle();
    setObjectSelectionSet([]);
    press("v");
    await settle();
    expect(made).toEqual(["c1+1@20"]);
    expect(builtIns.paste).not.toHaveBeenCalled();
  });

  it("control: an INNER selection that owns the clipboard keys (a floating grid's cell) keeps them", async () => {
    setObjectSelectionSet([r1, c1], r1);
    innerOwnsClipboard = true;
    press("c");
    await settle();
    expect(objectClipboardSize(), "the canvas copied objects from under a cell selection").toBe(0);
    expect(builtIns.copy).toHaveBeenCalledTimes(1);
  });

  it("control: on a SUBSCRIBED canvas Ctrl+D and Ctrl+V are refused with the canvas's sentence; Ctrl+C still copies", async () => {
    subscribed = true;
    setObjectSelectionSet([c1], c1);
    press("c");
    await settle();
    expect(objectClipboardSize()).toBe(1);
    press("d");
    press("v");
    await settle();
    expect(made).toEqual([]);
    expect(toasts).toEqual([SUBSCRIBED_NOTE, SUBSCRIBED_NOTE]);
    expect(builtIns.fillDown).not.toHaveBeenCalled();
    expect(builtIns.paste).not.toHaveBeenCalled();
  });

  it("control: on a WORKSHEET the canvas door stands aside and Controls' own door acts", async () => {
    surface = "grid";
    setObjectSelectionSet([k1], k1);
    press("c");
    press("d");
    await settle();
    expect(controlsDoor.copy).toHaveBeenCalledWith(["k1"]);
    expect(controlsDoor.duplicate).toHaveBeenCalledWith(["k1"]);
    expect(made).toEqual([]);
  });

  it("control: Controls' commands run on a canvas (palette, script) hand the WHOLE selection over", async () => {
    setObjectSelectionSet([c1, k1], k1);
    await CommandRegistry.execute("ext.controls.copySelection");
    await settle();
    expect(objectClipboardSize()).toBe(2);
    expect(controlsDoor.copy).not.toHaveBeenCalled();
    await CommandRegistry.execute("ext.controls.duplicateSelection");
    await settle();
    expect(made.length).toBe(2);
  });
});
