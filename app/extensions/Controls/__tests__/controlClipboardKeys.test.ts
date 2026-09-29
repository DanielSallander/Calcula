//! FILENAME: app/extensions/Controls/__tests__/controlClipboardKeys.test.ts
// PURPOSE: With a floating control selected and the grid focused, Ctrl+C /
//          Ctrl+V / Ctrl+D / Ctrl+G reach CONTROLS -- copy, paste, duplicate
//          and group the control -- instead of the grid's Copy / Paste / Fill
//          Down / Go To Special acting on the cells hidden under it.
// CONTEXT: Controls handled those four in a `document` capture keydown
//          listener. The keybinding dispatcher is a `window` capture listener
//          -- strictly earlier -- and binds Ctrl+C/V/D (grid-scoped: whenever
//          the grid has focus, which it does once a control is pressed) and
//          Ctrl+G (always) to built-ins; on a match it calls preventDefault()
//          and stopPropagation(), so the Controls listener never heard them.
//          The measured consequence was not a dead key: Ctrl+D FILLED DOWN the
//          worksheet cells under the selection. The same defect Delete had
//          (Controls index.ts, `ext.controls.deleteSelection`) and the same
//          cure: guarded registry bindings, which the dispatcher prefers over
//          the unguarded built-ins while a control is selected.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The seam's canvas rule reads Core's grid-state snapshot.
let surface: "grid" | "canvas" = "grid";
vi.mock("../../../src/core/state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/state/GridContext")>()),
  getGridStateSnapshot: () => ({ surface }),
}));
const toasts: string[] = [];
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  showToast: (message: string) => {
    toasts.push(message);
  },
}));

import { CommandRegistry } from "@api/commands";
import { initKeybindings } from "@api/keybindings";
import { registerGridOverlay, setGridRegions, type GridRegion } from "@api/gridOverlays";
import {
  notifyObjectSelectionChanged,
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  setObjectSelectionSet,
} from "@api/objectSelection";
import { installControlClipboardKeys, type ControlClipboardKeyDeps } from "../lib/controlKeys";
import { objectClipboardSize, resetObjectClipboard } from "@api/objectClipboard";

initKeybindings();

let selected: string[] = [];
let clipboard = false;
const deps = {
  selectedIds: () => selected,
  hasClipboard: () => clipboard,
  copy: vi.fn(async (_ids: readonly string[]) => {}),
  paste: vi.fn(async () => {}),
  duplicate: vi.fn(async (_ids: readonly string[]) => {}),
  group: vi.fn((_ids: string[]) => {}),
} satisfies ControlClipboardKeyDeps;

const builtIns = {
  copy: vi.fn(),
  paste: vi.fn(),
  fillDown: vi.fn(),
  goToSpecial: vi.fn(),
};

let gridContainer: HTMLDivElement;
const cleanups: Array<() => void> = [];

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true, ...init });
  gridContainer.dispatchEvent(e);
  return e;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  selected = [];
  clipboard = false;
  surface = "grid";
  toasts.length = 0;
  for (const f of [deps.copy, deps.paste, deps.duplicate, deps.group, ...Object.values(builtIns)]) f.mockClear();
  // The built-ins the four keys are bound to, as the app registers them.
  CommandRegistry.register("core.clipboard.copy", builtIns.copy);
  CommandRegistry.register("core.clipboard.paste", builtIns.paste);
  CommandRegistry.register("core.edit.fillDown", builtIns.fillDown);
  CommandRegistry.register("view.goToSpecial", builtIns.goToSpecial);
  gridContainer = document.createElement("div");
  gridContainer.setAttribute("data-focus-container", "spreadsheet");
  gridContainer.tabIndex = 0;
  document.body.appendChild(gridContainer);
  gridContainer.focus();
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  for (const id of ["core.clipboard.copy", "core.clipboard.paste", "core.edit.fillDown", "view.goToSpecial"]) {
    CommandRegistry.unregister(id);
  }
  gridContainer.remove();
});

describe("the old door: a document listener never hears these keys", () => {
  it("Ctrl+D with the grid focused is taken by Fill Down before a document listener runs", async () => {
    const heard = vi.fn();
    document.addEventListener("keydown", heard, true);
    try {
      selected = ["control-0-1-1"];
      press("d");
      await settle();
    } finally {
      document.removeEventListener("keydown", heard, true);
    }
    expect(heard, "the dispatcher let the key through").not.toHaveBeenCalled();
    expect(builtIns.fillDown).toHaveBeenCalledTimes(1);
  });
});

describe("with a control selected, the keys are Controls'", () => {
  beforeEach(() => {
    cleanups.push(installControlClipboardKeys("calcula.controls", deps));
    selected = ["control-0-1-1"];
  });

  it("Ctrl+D duplicates the control -- and Fill Down does not run", async () => {
    press("d");
    await settle();
    expect(deps.duplicate).toHaveBeenCalledWith(["control-0-1-1"]);
    expect(builtIns.fillDown, "Ctrl+D filled down the cells under the control").not.toHaveBeenCalled();
  });

  it("Ctrl+C copies the control -- and the cell copy does not run", async () => {
    press("c");
    await settle();
    expect(deps.copy).toHaveBeenCalledWith(["control-0-1-1"]);
    expect(builtIns.copy).not.toHaveBeenCalled();
  });

  it("Ctrl+V pastes the copied control while one is on the control clipboard", async () => {
    clipboard = true;
    press("v");
    await settle();
    expect(deps.paste).toHaveBeenCalledTimes(1);
    expect(builtIns.paste).not.toHaveBeenCalled();
  });

  it("Ctrl+G groups two or more selected controls", async () => {
    selected = ["control-0-1-1", "control-0-2-2"];
    press("g");
    await settle();
    expect(deps.group).toHaveBeenCalledWith(["control-0-1-1", "control-0-2-2"]);
    expect(builtIns.goToSpecial).not.toHaveBeenCalled();
  });

  it("control: Ctrl+V with an EMPTY control clipboard is the grid's paste", async () => {
    press("v");
    await settle();
    expect(deps.paste).not.toHaveBeenCalled();
    expect(builtIns.paste).toHaveBeenCalledTimes(1);
  });

  it("control: Ctrl+G with ONE control is Go To Special", async () => {
    press("g");
    await settle();
    expect(deps.group).not.toHaveBeenCalled();
    expect(builtIns.goToSpecial).toHaveBeenCalledTimes(1);
  });

  it("control: nothing selected -- every key is the grid's again", async () => {
    selected = [];
    press("d");
    press("c");
    await settle();
    expect(deps.duplicate).not.toHaveBeenCalled();
    expect(deps.copy).not.toHaveBeenCalled();
    expect(builtIns.fillDown).toHaveBeenCalledTimes(1);
    expect(builtIns.copy).toHaveBeenCalledTimes(1);
  });

  it("control: focus outside the grid (a task pane button) -- Controls does not act", async () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    try {
      const e = new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true, cancelable: true });
      button.dispatchEvent(e);
      await settle();
    } finally {
      button.remove();
    }
    expect(deps.duplicate).not.toHaveBeenCalled();
  });
});

describe("SEVERAL selected controls (wave A review: only the first was acted on)", () => {
  beforeEach(() => {
    cleanups.push(installControlClipboardKeys("calcula.controls", deps));
    selected = ["control-0-1-1", "control-0-2-2", "control-0-3-3"];
  });

  it("Ctrl+D duplicates EVERY selected control", async () => {
    press("d");
    await settle();
    expect(deps.duplicate, "Ctrl+D duplicated only the first selected control").toHaveBeenCalledWith([
      "control-0-1-1",
      "control-0-2-2",
      "control-0-3-3",
    ]);
    expect(builtIns.fillDown).not.toHaveBeenCalled();
  });

  it("Ctrl+C copies EVERY selected control", async () => {
    press("c");
    await settle();
    expect(deps.copy, "Ctrl+C copied only the first selected control").toHaveBeenCalledWith([
      "control-0-1-1",
      "control-0-2-2",
      "control-0-3-3",
    ]);
  });
});

describe("a CANVAS selection that also holds another family's object", () => {
  const k1: GridRegion = {
    id: "control-0-1-1", type: "floating-control", startRow: 0, startCol: 0, endRow: 0, endCol: 0,
    floating: { x: 0, y: 0, width: 10, height: 10 },
  };
  const c1: GridRegion = {
    id: "chart-c1", type: "chart", startRow: 0, startCol: 0, endRow: 0, endCol: 0,
    floating: { x: 50, y: 0, width: 10, height: 10 }, data: { name: "Sales" },
  };
  let chartSelected = false;

  beforeEach(() => {
    resetObjectSelectionProviders();
    chartSelected = false;
    cleanups.push(
      registerGridOverlay({ type: "floating-control", render: () => {}, priority: 20 }),
      registerGridOverlay({ type: "chart", render: () => {}, priority: 15 }),
      registerObjectSelectionProvider({
        types: ["floating-control"],
        isSelected: (r) => selected.includes(r.id),
        select: (r) => {
          selected = [r.id];
          notifyObjectSelectionChanged();
        },
        deselectAll: () => {
          selected = [];
        },
        addToSelection: (r) => {
          if (!selected.includes(r.id)) selected = [...selected, r.id];
        },
        removeFromSelection: (r) => {
          selected = selected.filter((id) => id !== r.id);
        },
      }),
      registerObjectSelectionProvider({
        types: ["chart"],
        isSelected: () => chartSelected,
        select: () => {
          chartSelected = true;
          notifyObjectSelectionChanged();
        },
        deselectAll: () => {
          chartSelected = false;
        },
        labelOf: (r) => (r.data?.name as string) ?? null,
      }),
      installControlClipboardKeys("calcula.controls", deps),
      () => {
        resetObjectSelectionProviders();
        setGridRegions([]);
      },
    );
    setGridRegions([k1, c1]);
    setObjectSelectionSet([k1, c1], k1);
    expect(selected).toEqual(["control-0-1-1"]);
    expect(chartSelected).toBe(true);
  });

  it("on a CANVAS Controls' Ctrl+C / Ctrl+D STAND ASIDE (the canvas's door acts on the whole selection, W25)", async () => {
    // The wave A interim REFUSED this selection with a toast. Now the canvas's
    // own door (CanvasSheet lib/canvasClipboard.ts, not installed here) copies
    // every family's objects; Controls must not win the tie and act on the
    // controls alone. With no canvas door installed the key reaches the
    // built-in -- proof that Controls' binding did not claim it.
    surface = "canvas";
    press("c");
    press("d");
    await settle();
    expect(deps.copy, "Controls' door copied the controls alone on a canvas").not.toHaveBeenCalled();
    expect(deps.duplicate, "Controls' door duplicated the controls alone on a canvas").not.toHaveBeenCalled();
    expect(builtIns.copy, "Controls' binding claimed Ctrl+C on a canvas (the canvas door must win it)").toHaveBeenCalledTimes(1);
    expect(builtIns.fillDown, "Controls' binding claimed Ctrl+D on a canvas").toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([]);
  });

  it("on a CANVAS Controls' Copy command (palette, script) hands the WHOLE selection to the object clipboard", async () => {
    surface = "canvas";
    resetObjectClipboard();
    // The families' copy halves, so the object clipboard can take both.
    cleanups.push(
      registerObjectSelectionProvider({
        types: ["floating-control"],
        isSelected: (r) => selected.includes(r.id),
        select: (r) => {
          selected = [r.id];
        },
        deselectAll: () => {
          selected = [];
        },
        addToSelection: (r) => {
          if (!selected.includes(r.id)) selected = [...selected, r.id];
        },
        copyObjects: (regions) => regions.map((r) => ({ id: r.id })),
        pasteObjects: async () => ({ created: [] }),
      }),
      registerObjectSelectionProvider({
        types: ["chart"],
        isSelected: () => chartSelected,
        select: () => {
          chartSelected = true;
        },
        deselectAll: () => {
          chartSelected = false;
        },
        copyObjects: (regions) => regions.map((r) => ({ id: r.id })),
        pasteObjects: async () => ({ created: [] }),
      }),
    );
    setObjectSelectionSet([k1, c1], k1);
    await CommandRegistry.execute("ext.controls.copySelection");
    await settle();
    expect(objectClipboardSize(), "the command copied part of the selection").toBe(2);
    expect(deps.copy).not.toHaveBeenCalled();
    resetObjectClipboard();
  });

  it("control: on a WORKSHEET the same selection is Controls' own act (the seam's rule is canvas-only)", async () => {
    surface = "grid";
    press("d");
    await settle();
    expect(deps.duplicate).toHaveBeenCalledWith(["control-0-1-1"]);
    expect(toasts).toEqual([]);
  });
});

describe("activate() wires the registry door and retires the listener's copies", () => {
  it("installs the keys, and the document listener no longer claims Ctrl+C/V/D/G", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../index.ts"), "utf8");
    expect(src).toContain('installControlClipboardKeys("calcula.controls", {');
    // Every selected control: the multi acts are the ones wired in.
    expect(src).toContain("      copy: copyControls,");
    expect(src).toContain("      duplicate: duplicateControls,");
    const at = src.indexOf("const handleControlKeyboard = async (e: KeyboardEvent) => {");
    const body = src.slice(at, src.indexOf('document.addEventListener("keydown", handleControlKeyboard, true);', at));
    expect(body).not.toMatch(/e\.key === "[cvdg]"/);
  });
});
