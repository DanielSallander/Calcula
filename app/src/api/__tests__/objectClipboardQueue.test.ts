//! FILENAME: app/src/api/__tests__/objectClipboardQueue.test.ts
// PURPOSE: The object clipboard runs Copy / Paste / Duplicate ONE AT A TIME,
//          in the order they were asked for (wave C review of W25). Every
//          creation awaits a backend round trip (`save_chart`,
//          `set_control_metadata`); side by side, a second Ctrl+V pressed or
//          key-repeated while the first was still landing JOINED the first's
//          open undo transaction (one Ctrl+Z took both pastes), and a second
//          Ctrl+D read the selection before the first's copies were selected,
//          so it duplicated the ORIGINALS again and stacked a hidden copy on
//          each visible one. Queued, each keypress is its own undo step and a
//          second Ctrl+D duplicates the first's copies (Excel's cascade).
// CONTEXT: Real objectClipboard / objectSelection / objectGeometry; only the
//          backend's begin/commit is doubled. Each family creation takes a
//          real macrotask (10 ms) -- a round trip.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const log: string[] = [];
vi.mock("../../core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginUndoTransaction: vi.fn(async (label: string) => {
    log.push(`begin:${label}`);
  }),
  commitUndoTransaction: vi.fn(async () => {
    log.push("commit");
  }),
}));
vi.mock("../notifications", () => ({ showToast: () => {} }));

import {
  copySelectedObjects,
  duplicateSelectedObjects,
  hasObjectClipboard,
  pasteObjectClipboard,
  resetObjectClipboard,
  runObjectClipboardAction,
} from "../objectClipboard";
import {
  notifyObjectSelectionChanged,
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  setObjectSelectionSet,
  type ObjectPasteTarget,
  type ObjectSelectionProvider,
} from "../objectSelection";
import { resetObjectGeometryProviders } from "../objectGeometry";
import { canvasObjectRef } from "../canvasSheet";
import { registerGridOverlay, getGridRegions, setGridRegions, type GridRegion } from "../gridOverlays";

function region(id: string, type: string, x: number, y = 0): GridRegion {
  return { id, type, startRow: 0, startCol: 0, endRow: 0, endCol: 0, floating: { x, y, width: 100, height: 50 } };
}

const made: Array<{ id: string; x: number; from: string }> = [];
let seq = 0;
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function family(type: string, kind: "chart" | "control"): ObjectSelectionProvider {
  const selected = new Set<string>();
  return {
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
    deselectAll: () => {
      selected.clear();
    },
    refOf: (r) => canvasObjectRef(kind, r.id),
    labelOf: (r) => r.id,
    copyObjects: async (regions) => {
      await tick(5); // the snapshot's own backend read
      return regions.map((r) => ({ from: r.id, x: r.floating!.x, y: r.floating!.y }));
    },
    pasteObjects: async (snaps, target: ObjectPasteTarget) => {
      const created = [];
      for (const raw of snaps) {
        const s = raw as { from: string; x: number; y: number };
        await tick(10); // save_chart / set_control_metadata
        const at = target.place({ x: s.x, y: s.y, width: 100, height: 50 });
        const id = `${s.from}+${++seq}`;
        made.push({ id, x: at.x, from: s.from });
        log.push(`create:${id}@${at.x}`);
        setGridRegions([...getGridRegions(), region(id, type, at.x, at.y)]);
        created.push(canvasObjectRef(kind, id));
      }
      return { created };
    },
  };
}

const cleanups: Array<() => void> = [];
const c1 = region("c1", "chart", 10);
const k1 = region("k1", "floating-control", 400);

beforeEach(() => {
  log.length = 0;
  made.length = 0;
  seq = 0;
  resetObjectClipboard();
  resetObjectSelectionProviders();
  resetObjectGeometryProviders();
  cleanups.push(
    registerGridOverlay({ type: "chart", render: () => {}, priority: 15 }),
    registerGridOverlay({ type: "floating-control", render: () => {}, priority: 20 }),
    registerObjectSelectionProvider(family("chart", "chart")),
    registerObjectSelectionProvider(family("floating-control", "control")),
  );
  setGridRegions([c1, k1]);
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetObjectSelectionProviders();
  resetObjectClipboard();
  setGridRegions([]);
});

/** The undo steps the log shows: each begin..commit, with what it created. */
function steps(): string[][] {
  const out: string[][] = [];
  let open: string[] | null = null;
  for (const line of log) {
    if (line.startsWith("begin:")) {
      open = [];
      out.push(open);
    } else if (line === "commit") {
      open = null;
    } else if (line.startsWith("create:")) {
      (open ?? (out[out.length] = [])).push(line.slice("create:".length));
    }
  }
  return out;
}

describe("Copy / Paste / Duplicate run one at a time, in key order", () => {
  it("two Ctrl+V pressed while the first is still landing are TWO undo steps, the second one step further", async () => {
    setObjectSelectionSet([c1, k1], c1);
    await copySelectedObjects();
    log.length = 0;
    const p1 = pasteObjectClipboard({ sheetIndex: 0 });
    await tick(3); // the second key press, 3 ms later (key repeat)
    const p2 = pasteObjectClipboard({ sheetIndex: 0 });
    await Promise.all([p1, p2]);
    expect(steps(), "the second paste JOINED the first's undo step").toEqual([
      ["c1+1@30", "k1+2@420"],
      ["c1+3@50", "k1+4@440"],
    ]);
  });

  it("two Ctrl+D pressed while the first is still landing CASCADE: the second duplicates the first's copies, as its own step", async () => {
    setObjectSelectionSet([c1, k1], c1);
    const d1 = duplicateSelectedObjects();
    await tick(3);
    const d2 = duplicateSelectedObjects();
    await Promise.all([d1, d2]);
    const fromOriginals = made.filter((m) => m.from === "c1" || m.from === "k1").map((m) => `${m.id}@${m.x}`);
    expect(fromOriginals, "BOTH duplicates copied the ORIGINALS (a hidden copy stacked on each)").toEqual([
      "c1+1@30",
      "k1+2@420",
    ]);
    expect(steps(), "each Ctrl+D is one undo step, the second 20 px from the first's copies").toEqual([
      ["c1+1@30", "k1+2@420"],
      ["c1+1+3@50", "k1+2+4@440"],
    ]);
  });

  it("Ctrl+C then Ctrl+V pressed before the copy landed: the paste is not handed to the grid, and pastes THAT copy", async () => {
    expect(hasObjectClipboard()).toBe(false);
    setObjectSelectionSet([c1], c1);
    const c = copySelectedObjects();
    expect(hasObjectClipboard(), "a queued copy did not count: Ctrl+V would fall through to the grid's paste").toBe(
      true,
    );
    const p = pasteObjectClipboard({ sheetIndex: 0 });
    await Promise.all([c, p]);
    expect(made.map((m) => `${m.id}@${m.x}`)).toEqual(["c1+1@30"]);
  });

  it("a copy that took nothing leaves the clipboard empty again once it settles", async () => {
    setObjectSelectionSet([], null);
    const c = copySelectedObjects();
    expect(hasObjectClipboard()).toBe(true);
    await c;
    expect(hasObjectClipboard()).toBe(false);
  });

  it("a failed action does not stop the next one, and a family's own door is ordered with the rest", async () => {
    const order: string[] = [];
    const bad = runObjectClipboardAction(async () => {
      await tick(5);
      order.push("bad");
      throw new Error("boom");
    });
    const own = runObjectClipboardAction(async () => {
      order.push("own");
    });
    setObjectSelectionSet([c1], c1);
    const c = copySelectedObjects().then(() => order.push("copy"));
    await expect(bad).rejects.toThrow("boom");
    await Promise.all([own, c]);
    expect(order).toEqual(["bad", "own", "copy"]);
  });
});
