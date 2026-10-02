//! FILENAME: app/extensions/CanvasSheet/__tests__/canvasDelete.test.ts
// PURPOSE: Delete / Backspace on a canvas MULTI-selection delete EVERY selected
//          object -- across families, set-held members included -- through
//          the real keybinding dispatcher (open-items 2.af row 1).
// CONTEXT: The dispatcher runs ONE winner per key; each family's own Delete
//          binding acted on what that family held. The canvas binding
//          (lib/canvasDelete.ts) covers a selection none of the families'
//          bindings matches; the families' own doors hand a spanning selection
//          to the same seam call (pinned in canvasDeleteWiring below).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let surface: "canvas" | "grid" = "canvas";
// The seam's canvas rule (`shouldActOnWholeObjectSelection`, @api/objectSelection)
// reads Core's grid-state snapshot.
vi.mock("../../../src/core/state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/state/GridContext")>()),
  getGridStateSnapshot: () => ({ surface }),
}));
vi.mock("../../../src/core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginUndoTransaction: vi.fn(async () => {}),
  commitUndoTransaction: vi.fn(async () => {}),
}));

import { initKeybindings } from "@api/keybindings";
import { getGridRegions, registerGridOverlay, setGridRegions, type GridRegion } from "@api/gridOverlays";
import {
  getSelectedObjectRegions,
  notifyObjectSelectionChanged,
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  setObjectSelectionSet,
  type ObjectSelectionProvider,
} from "@api/objectSelection";
import { CANVAS_DELETE_SELECTION_COMMAND, installCanvasObjectDelete } from "../lib/canvasDelete";
import { CommandRegistry } from "@api/commands";

initKeybindings();

function region(id: string, type: string, x = 0): GridRegion {
  return { id, type, startRow: 0, startCol: 0, endRow: 0, endCol: 0, floating: { x, y: 0, width: 10, height: 10 } };
}

const deleted: string[] = [];

/** A single-select family that deletes through the seam (Charts' shape). */
function singleFamily(type: string): ObjectSelectionProvider {
  let selected: string | null = null;
  return {
    types: [type],
    isSelected: (r) => r.id === selected,
    select: (r) => {
      selected = r.id;
      notifyObjectSelectionChanged();
    },
    deselectAll: () => {
      selected = null;
    },
    deleteObjects: async (regions) => {
      for (const r of regions) deleted.push(r.id);
      if (regions.some((r) => r.id === selected)) selected = null;
      setGridRegions(getGridRegions().filter((g) => !regions.some((r) => r.id === g.id)));
    },
  };
}

const c1 = region("c1", "chart", 0);
const c2 = region("c2", "chart", 20);
const p1 = region("p1", "pivot-visual", 40);
const cleanups: Array<() => void> = [];
let gridContainer: HTMLDivElement;

function press(key: "Delete" | "Backspace"): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  gridContainer.dispatchEvent(e);
  return e;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  surface = "canvas";
  deleted.length = 0;
  resetObjectSelectionProviders();
  cleanups.push(
    registerGridOverlay({ type: "chart", render: () => {}, priority: 15 }),
    registerGridOverlay({ type: "pivot-visual", render: () => {}, priority: 12 }),
    registerObjectSelectionProvider(singleFamily("chart")),
    registerObjectSelectionProvider(singleFamily("pivot-visual")),
    ...installCanvasObjectDelete("calcula.canvas-sheet"),
  );
  setGridRegions([c1, c2, p1]);
  gridContainer = document.createElement("div");
  gridContainer.setAttribute("data-focus-container", "spreadsheet");
  gridContainer.tabIndex = 0;
  document.body.appendChild(gridContainer);
  gridContainer.focus();
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetObjectSelectionProviders();
  setGridRegions([]);
  gridContainer.remove();
});

describe("Delete on a canvas multi-selection", () => {
  it("deletes every selected object: both charts (one set-held) and the pivot box", async () => {
    setObjectSelectionSet([c1, c2, p1], c1);
    const e = press("Delete");
    await settle();
    expect(e.defaultPrevented).toBe(true);
    expect(deleted.sort(), "a member of the selection was left standing").toEqual(["c1", "c2", "p1"]);
    expect(getSelectedObjectRegions()).toEqual([]);
  });

  it("Backspace does the same", async () => {
    setObjectSelectionSet([c2, p1], p1);
    press("Backspace");
    await settle();
    expect(deleted.sort()).toEqual(["c2", "p1"]);
  });

  it("control: ONE selected object is its family's own Delete (the canvas binding stands aside)", async () => {
    setObjectSelectionSet([c1], c1);
    press("Delete");
    await settle();
    expect(deleted).toEqual([]);
  });

  it("control: on a worksheet the canvas binding never applies", async () => {
    surface = "grid";
    setObjectSelectionSet([c1, c2, p1], c1);
    press("Delete");
    await settle();
    expect(deleted).toEqual([]);
  });

  // The seam's whole-selection rule answers on a worksheet too since worksheets
  // gained press parity (BUG-0270 review); the canvas command keeps its OWN
  // canvas check, so the palette or a script running it on a worksheet does
  // nothing (the families' doors and the generic object Delete answer there).
  it("the command run from the palette or a script on a WORKSHEET deletes nothing", async () => {
    surface = "grid";
    setObjectSelectionSet([c1, c2, p1], c1);
    await CommandRegistry.execute(CANVAS_DELETE_SELECTION_COMMAND);
    await settle();
    expect(deleted, "the canvas command deleted a worksheet selection").toEqual([]);
    surface = "canvas";
    await CommandRegistry.execute(CANVAS_DELETE_SELECTION_COMMAND);
    await settle();
    expect(deleted.sort(), "control: on a canvas the command deletes the whole selection").toEqual(["c1", "c2", "p1"]);
  });
});

describe("the families' own Delete doors hand a spanning selection to the seam", () => {
  it("Charts' Delete action and Controls' delete-selected both delegate before acting on their own share", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const charts = readFileSync(resolve(__dirname, "../../Charts/index.ts"), "utf8");
    const chartAt = charts.indexOf("const runChartDeleteAction = (): void => {");
    const chartBody = charts.slice(chartAt, charts.indexOf("isChartTextElement", chartAt));
    expect(chartBody).toMatch(/if \(shouldActOnWholeObjectSelection\(\)\) \{\s*void deleteSelectedObjects\(\);\s*return;/);

    const controls = readFileSync(resolve(__dirname, "../../Controls/index.ts"), "utf8");
    const ctrlAt = controls.indexOf("async function deleteSelectedControls(): Promise<void> {");
    const ctrlBody = controls.slice(ctrlAt, controls.indexOf("async function deleteControlsWithGroups", ctrlAt));
    expect(ctrlBody).toMatch(/if \(shouldActOnWholeObjectSelection\(\)\) \{\s*await deleteSelectedObjects\(\);\s*return;/);
  });

  it("the canvas activates the binding", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../index.ts"), "utf8");
    expect(src).toContain("cleanupFns.push(...installCanvasObjectDelete(extension.manifest.id));");
  });
});
