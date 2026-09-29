//! FILENAME: app/src/api/__tests__/objectClipboard.test.ts
// PURPOSE: THE OBJECT CLIPBOARD (W25, the copy/duplicate half of open-items
//          2.af row 1): Copy / Paste / Duplicate of a canvas multi-selection
//          act on EVERY selected object across families -- the members each
//          family holds AND the members the selection set holds for a
//          single-select family (a second chart) -- a paste or duplicate of
//          several is ONE undo step, the copies land offset (20 / 40 / 60 px
//          per paste, kept on a canvas's page) and become the selection. A
//          family with no copy is left out and named in ONE toast.
// CONTEXT: Before, only Controls could copy at all, and its keys REFUSED a
//          selection that held anything else; a chart could not be copied by
//          any key. Families here are doubles with the real provider shape.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const log: string[] = [];
const toasts: string[] = [];
vi.mock("../../core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginUndoTransaction: vi.fn(async (label: string) => {
    log.push(`begin:${label}`);
  }),
  commitUndoTransaction: vi.fn(async () => {
    log.push("commit");
  }),
}));
vi.mock("../notifications", () => ({
  showToast: (message: string) => {
    toasts.push(message);
  },
}));

import {
  copySelectedObjects,
  duplicateSelectedObjects,
  hasObjectClipboard,
  objectClipboardSize,
  pasteObjectClipboard,
  putOnObjectClipboard,
  resetObjectClipboard,
} from "../objectClipboard";
import {
  getSelectedObjectRegions,
  getSetHeldObjectRegions,
  notifyObjectSelectionChanged,
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  setObjectSelectionSet,
  type ObjectPasteResult,
  type ObjectPasteTarget,
  type ObjectSelectionProvider,
} from "../objectSelection";
import { resetObjectGeometryProviders } from "../objectGeometry";
import { registerLayoutSurfaceProvider } from "../layoutSurface";
import { canvasObjectRef } from "../canvasSheet";
import { registerGridOverlay, getGridRegions, setGridRegions, type GridRegion } from "../gridOverlays";

function region(id: string, type: string, x: number, y = 0, width = 100, height = 50): GridRegion {
  return { id, type, startRow: 0, startCol: 0, endRow: 0, endCol: 0, floating: { x, y, width, height } };
}

function publish(r: GridRegion): void {
  setGridRegions([...getGridRegions(), r]);
}

interface Snap {
  from: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A family that can copy: snapshots are {from, x, y, w, h}; a paste creates a
 * NEW region per snapshot at `target.place(rect)`, publishes it and names it.
 * `refuse` makes the paste of a given source refuse (with a reason).
 */
function copyingFamily(type: string, kind: "chart" | "control", multi: boolean) {
  const selected = new Set<string>();
  const made: Array<{ id: string; x: number; y: number; sheet: number }> = [];
  const refuse = new Map<string, string>();
  let seq = 0;
  const provider: ObjectSelectionProvider = {
    types: [type],
    isSelected: (r) => selected.has(r.id),
    select: (r) => {
      selected.clear();
      selected.add(r.id);
      notifyObjectSelectionChanged();
    },
    deselectAll: () => {
      if (selected.size === 0) return;
      selected.clear();
      notifyObjectSelectionChanged();
    },
    refOf: (r) => canvasObjectRef(kind, r.id),
    labelOf: (r) => `${type} ${r.id}`,
    copyObjects: (regions) =>
      regions.map((r) => {
        log.push(`copy:${type}:${r.id}`);
        const f = r.floating!;
        return { from: r.id, x: f.x, y: f.y, width: f.width, height: f.height } satisfies Snap;
      }),
    pasteObjects: async (snapshots, target: ObjectPasteTarget): Promise<ObjectPasteResult> => {
      const created = [];
      const refused: string[] = [];
      for (const raw of snapshots) {
        const s = raw as Snap;
        await Promise.resolve();
        if (refuse.has(s.from)) {
          log.push(`refused:${type}:${s.from}`);
          refused.push(refuse.get(s.from)!);
          continue;
        }
        const at = target.place({ x: s.x, y: s.y, width: s.width, height: s.height });
        const id = `${s.from}-copy${++seq}`;
        log.push(`create:${type}:${id}@${at.x},${at.y}`);
        made.push({ id, x: at.x, y: at.y, sheet: target.sheetIndex });
        publish(region(id, type, at.x, at.y, s.width, s.height));
        created.push(canvasObjectRef(kind, id));
      }
      return { created, refused };
    },
  };
  if (multi) {
    provider.addToSelection = (r) => {
      selected.add(r.id);
    };
    provider.removeFromSelection = (r) => {
      selected.delete(r.id);
    };
  }
  return { provider, made, refuse, selected };
}

/** A family that cannot copy (a slicer): select only. */
function plainFamily(type: string) {
  let selected: string | null = null;
  const provider: ObjectSelectionProvider = {
    types: [type],
    isSelected: (r) => r.id === selected,
    select: (r) => {
      selected = r.id;
    },
    deselectAll: () => {
      selected = null;
    },
    labelOf: (r) => `Slicer_${r.id}`,
  };
  return { provider };
}

const cleanups: Array<() => void> = [];
let charts: ReturnType<typeof copyingFamily>;
let controls: ReturnType<typeof copyingFamily>;
const c1 = region("c1", "chart", 10, 10);
const c2 = region("c2", "chart", 200, 10);
const k1 = region("k1", "floating-control", 400, 10, 80, 24);
const s1 = region("s1", "slicer", 600, 10);

beforeEach(() => {
  log.length = 0;
  toasts.length = 0;
  resetObjectClipboard();
  resetObjectSelectionProviders();
  resetObjectGeometryProviders();
  charts = copyingFamily("chart", "chart", false);
  controls = copyingFamily("floating-control", "control", true);
  cleanups.push(
    registerGridOverlay({ type: "chart", render: () => {}, priority: 15 }),
    registerGridOverlay({ type: "floating-control", render: () => {}, priority: 20 }),
    registerGridOverlay({ type: "slicer", render: () => {}, priority: 16 }),
    registerObjectSelectionProvider(charts.provider),
    registerObjectSelectionProvider(controls.provider),
    registerObjectSelectionProvider(plainFamily("slicer").provider),
  );
  setGridRegions([c1, c2, k1, s1]);
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetObjectSelectionProviders();
  resetObjectClipboard();
  setGridRegions([]);
});

describe("Copy of a multi-selection across families", () => {
  it("copies EVERY copyable member -- the set-held second chart too -- and names the rest in ONE toast", async () => {
    setObjectSelectionSet([c1, c2, k1, s1], c1);
    expect(getSetHeldObjectRegions().map((r) => r.id), "precondition: c2 is set-held").toEqual(["c2"]);

    const out = await copySelectedObjects();

    expect(log.filter((l) => l.startsWith("copy:")).sort(), "a member was not copied").toEqual([
      "copy:chart:c1",
      "copy:chart:c2",
      "copy:floating-control:k1",
    ]);
    expect(objectClipboardSize()).toBe(3);
    expect(out).toEqual({ acted: 3, unsupported: 1, failed: 0 });
    expect(toasts.length).toBe(1);
    expect(toasts[0]).toMatch(/^Copy: 1 selected object was not copied \(Slicer_s1\)/);
    // A copy writes nothing and opens no undo step.
    expect(log.some((l) => l.startsWith("begin:"))).toBe(false);
  });

  it("control: a copy of ONLY objects that cannot be copied keeps the clipboard as it was", async () => {
    setObjectSelectionSet([c1], c1);
    await copySelectedObjects();
    expect(objectClipboardSize()).toBe(1);
    setObjectSelectionSet([s1], s1);
    const out = await copySelectedObjects();
    expect(out.acted).toBe(0);
    expect(objectClipboardSize(), "a refused copy emptied the clipboard").toBe(1);
    expect(toasts[0]).toContain("the clipboard still holds what it held");
  });
});

describe("Paste", () => {
  it("creates EVERY copied object -- across families -- as ONE undo step, offset, and SELECTS them all", async () => {
    setObjectSelectionSet([c1, c2, k1], c1);
    await copySelectedObjects();
    log.length = 0;

    await pasteObjectClipboard({ sheetIndex: 0 });

    const creates = log.filter((l) => l.startsWith("create:"));
    expect(creates.length, "the paste did not create every copied object").toBe(3);
    expect(log[0], "the paste was not ONE undo step").toBe("begin:Paste Objects");
    expect(log[log.length - 1]).toBe("commit");
    expect(log.filter((l) => l.startsWith("begin:")).length).toBe(1);
    // Offset one step (20 px) from where each original stood.
    expect(charts.made.map((m) => [m.x, m.y])).toEqual([
      [30, 30],
      [220, 30],
    ]);
    expect(controls.made.map((m) => [m.x, m.y])).toEqual([[420, 30]]);
    // The copies ARE the selection now -- across families, the second chart
    // held by the set -- and the originals are not.
    const selected = getSelectedObjectRegions().map((r) => r.id).sort();
    expect(selected, "the pasted objects did not become the selection").toEqual(
      [...charts.made.map((m) => m.id), ...controls.made.map((m) => m.id)].sort(),
    );
    expect(toasts).toEqual([]);
  });

  it("each paste lands one more step from the ORIGINALS: 20, 40, 60 px (the cascade)", async () => {
    setObjectSelectionSet([c1], c1);
    await copySelectedObjects();
    await pasteObjectClipboard({ sheetIndex: 0 });
    await pasteObjectClipboard({ sheetIndex: 0 });
    await pasteObjectClipboard({ sheetIndex: 0 });
    expect(charts.made.map((m) => m.x)).toEqual([30, 50, 70]);
    // A new copy restarts the cascade.
    setObjectSelectionSet([c2], c2);
    await copySelectedObjects();
    await pasteObjectClipboard({ sheetIndex: 0 });
    expect(charts.made[charts.made.length - 1].x).toBe(220);
  });

  it("control: ONE object needs no transaction (its own write is one undo step)", async () => {
    setObjectSelectionSet([k1], k1);
    await copySelectedObjects();
    log.length = 0;
    await pasteObjectClipboard({ sheetIndex: 0 });
    expect(log.some((l) => l.startsWith("begin:"))).toBe(false);
    expect(controls.made.length).toBe(1);
  });

  it("a copy a family REFUSES is counted in one toast with its reason; the rest are created and selected", async () => {
    setObjectSelectionSet([c1, k1], c1);
    await copySelectedObjects();
    controls.refuse.set("k1", "Sheet is protected.");
    await pasteObjectClipboard({ sheetIndex: 0 });
    expect(charts.made.length).toBe(1);
    expect(controls.made.length).toBe(0);
    expect(toasts.length).toBe(1);
    expect(toasts[0]).toBe("Paste: 1 of 2 objects could not be pasted. Sheet is protected.");
    expect(getSelectedObjectRegions().map((r) => r.id)).toEqual([charts.made[0].id]);
  });

  it("on a CANVAS the copies stay on the page (clamped like a co-moved member)", async () => {
    cleanups.push(
      registerLayoutSurfaceProvider({
        get: () => ({ snapToGrid: false, gridSize: 10, showGrid: false, page: { width: 250, height: 400 }, editable: true }),
      }),
    );
    setObjectSelectionSet([c2], c2);
    await copySelectedObjects();
    await pasteObjectClipboard({ sheetIndex: 0 });
    // c2 stands at x=200, width 100: +20 would leave the 250 px page.
    expect(charts.made[0].x, "the pasted chart left the page").toBe(150);
    expect(charts.made[0].y).toBe(30);
  });

  it("a READ-ONLY page (a subscribed canvas) takes no pasted objects: one toast, nothing created", async () => {
    cleanups.push(
      registerLayoutSurfaceProvider({
        get: () => ({ snapToGrid: false, gridSize: 10, showGrid: false, page: { width: 900, height: 900 }, editable: false }),
      }),
    );
    setObjectSelectionSet([c1], c1);
    await copySelectedObjects();
    await pasteObjectClipboard({ sheetIndex: 0 });
    expect(charts.made.length).toBe(0);
    expect(toasts).toEqual(["Paste: objects cannot be added to this page -- it is read-only. Nothing was changed."]);
  });

  it("the LAST copy wins: a family's own copy door replaces a cross-family copy", async () => {
    setObjectSelectionSet([c1, k1], c1);
    await copySelectedObjects();
    putOnObjectClipboard("floating-control", [{ from: "k1", x: 0, y: 0, width: 10, height: 10 }]);
    expect(objectClipboardSize()).toBe(1);
    await pasteObjectClipboard({ sheetIndex: 0 });
    expect(charts.made.length, "the older chart copy was pasted").toBe(0);
    expect(controls.made.map((m) => [m.x, m.y])).toEqual([[20, 20]]);
  });
});

describe("Duplicate", () => {
  it("duplicates EVERY selected object across families as ONE undo step, 20 px on, and selects the copies", async () => {
    setObjectSelectionSet([c1, c2, k1, s1], c1);
    const out = await duplicateSelectedObjects();
    expect(log.filter((l) => l.startsWith("begin:"))).toEqual(["begin:Duplicate Objects"]);
    expect(log[log.length - 1]).toBe("commit");
    expect(charts.made.map((m) => [m.x, m.y])).toEqual([
      [30, 30],
      [220, 30],
    ]);
    expect(controls.made.map((m) => [m.x, m.y])).toEqual([[420, 30]]);
    expect(out).toEqual({ acted: 3, unsupported: 1, failed: 0 });
    // The slicer could not be duplicated: named, once.
    expect(toasts.length).toBe(1);
    expect(toasts[0]).toMatch(/^Duplicate: 1 selected object was not duplicated \(Slicer_s1\)/);
    const selected = getSelectedObjectRegions().map((r) => r.id).sort();
    expect(selected).toEqual([...charts.made.map((m) => m.id), ...controls.made.map((m) => m.id)].sort());
    // Duplicate leaves the clipboard alone.
    expect(hasObjectClipboard()).toBe(false);
  });

  it("a member left out AND a copy refused are named in ONE toast, not two", async () => {
    setObjectSelectionSet([c1, k1, s1], c1);
    controls.refuse.set("k1", "Sheet is protected.");
    await duplicateSelectedObjects();
    expect(charts.made.length).toBe(1);
    expect(toasts.length, "one Duplicate raised more than one toast").toBe(1);
    expect(toasts[0]).toContain("Slicer_s1");
    expect(toasts[0]).toContain("1 of 2 objects could not be duplicated. Sheet is protected.");
  });
});
