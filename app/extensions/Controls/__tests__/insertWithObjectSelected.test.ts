//! FILENAME: app/extensions/Controls/__tests__/insertWithObjectSelected.test.ts
// PURPOSE: Insert Shape, Insert > Controls > Button and Insert Image stay
//          AVAILABLE while an object is selected on a worksheet (Excel parity):
//          each places its new object at Core's active cell, as it does with
//          nothing selected. Every other door the selected-object claim
//          stands in front of is still refused, and a SPECIFIC claim (a
//          floating grid's selected cell, wave-B B8) still refuses the insert.
// CONTEXT: Owner call 25 (2026-10-02) on BUG-0270. The generic "an object is
//          selected" claim (BuiltIn/ObjectPosition lib/selectedObjectKeys.ts)
//          made the three Insert-menu doors -- which ask @api/selectionOwner
//          before reading Core's selection for the anchor -- refuse with "is
//          not available while an object is selected". Excel inserts a shape,
//          a form button or a picture while a slicer or a shape is selected.
//          The claim now ADMITS the door kind "objectInsert" (SelectionOwner.
//          admits) and the three doors ask as that kind
//          (lib/insertAnchor.ts).
//          Driven through the REAL activate() and the REAL Insert menu items it
//          registers (the ModelMenu lifecycle harness), the REAL claim from
//          ObjectPosition over a fake slicer family, and an in-memory stand-in
//          for the control-metadata commands (controlPlacement.test.ts's).

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { loadHarness, settle, type Loader } from "../../ModelMenu/__tests__/lifecycleHarness";

interface Meta {
  controlType: string;
  properties: Record<string, { valueType: string; value: string }>;
}

const h = vi.hoisted(() => ({
  backend: new Map<string, Meta>(),
  toasts: [] as string[],
  picker: { calls: 0 },
}));
const key = (s: number, r: number, c: number) => `${s}:${r}:${c}`;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  listenForEvent: vi.fn(async () => () => {}),
  listenTauriEvent: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "get_active_sheet") return 0;
    if (cmd === "get_all_styles") return [];
    return null;
  }),
}));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => {}),
}));
// A WORKSHEET (the claim holds only there), default 100 x 24 cells.
vi.mock("../../../src/core/state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/state/GridContext")>()),
  getGridStateSnapshot: () => ({
    surface: "grid",
    zoom: 1,
    displayHeadings: true,
    config: { rowHeaderWidth: 50, colHeaderHeight: 24, defaultCellWidth: 100, defaultCellHeight: 24 },
    viewport: { scrollX: 0, scrollY: 0 },
    sheetContext: { activeSheetIndex: 0 },
    dimensions: { columnWidths: new Map(), rowHeights: new Map() },
    selection: { startRow: 3, startCol: 2, endRow: 3, endCol: 2, type: "cells" },
  }),
}));
vi.mock("../lib/controlApi", () => ({
  async getControlMetadata(s: number, r: number, c: number) {
    await tick();
    return h.backend.get(key(s, r, c)) ?? null;
  },
  async setControlMetadata(s: number, r: number, c: number, meta: Meta) {
    await tick();
    h.backend.set(key(s, r, c), JSON.parse(JSON.stringify(meta)));
    return meta;
  },
  async removeControlMetadata(s: number, r: number, c: number) {
    await tick();
    return h.backend.delete(key(s, r, c));
  },
  async getAllControls() {
    await tick();
    return [];
  },
  setControlProperty: vi.fn(),
  resolveControlProperties: vi.fn(async () => ({})),
}));
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/notifications")>()),
  showToast: (message: string) => {
    h.toasts.push(message);
  },
}));
// The native picker answers with a validated handle (imageIngress.test.ts pins the picker itself).
vi.mock("@api/filesystem", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  importImageViaPicker: vi.fn(async () => {
    h.picker.calls++;
    return { ref: `media:${"a".repeat(64)}`, mimeType: "image/png", width: 40, height: 20, byteLength: 100 };
  }),
}));

const CONTROLS: Loader = () => import("..");

/** Core's active cell (the selection's end), where an insert anchors. */
const ANCHOR = key(0, 3, 2);

type GridRegion = import("@api/gridOverlays").GridRegion;
const SLICER: GridRegion = {
  id: "slicer-1",
  type: "slicer",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { x: 400, y: 40, width: 150, height: 200 },
};

let ext: Awaited<ReturnType<typeof loadHarness>>["ext"];
let ui: Awaited<ReturnType<typeof loadHarness>>["ui"];
let seam: typeof import("@api/selectionOwner");
let objectSelection: typeof import("@api/objectSelection");
const slicerSelected = new Set<string>();
const cleanups: Array<() => void> = [];

type MenuItem = import("@api/uiTypes").MenuItemDefinition;
function insertItem(id: string): MenuItem {
  const walk = (items: MenuItem[] | undefined): MenuItem | null => {
    for (const item of items ?? []) {
      if (item.id === id) return item;
      const inner = walk(item.children);
      if (inner) return inner;
    }
    return null;
  };
  const found = walk(ui.getMenus().find((m) => m.id === "insert")?.items);
  if (!found) throw new Error(`no Insert menu item ${id}`);
  return found;
}

/** The REAL insertShape the Insert > Shapes gallery is handed. */
function galleryInsertShape(): (shapeType: string) => Promise<void> {
  const item = insertItem("insert.shapes");
  const element = item.customContent!(() => {}) as { props: { insertShape: (t: string) => Promise<void> } };
  return element.props.insertShape;
}

async function insertButtonFromMenu(): Promise<void> {
  await (insertItem("insert.controls.button").action as () => Promise<void>)();
  await settle();
}

async function insertImageFromMenu(): Promise<void> {
  await (insertItem("insert.image").action as () => Promise<void>)();
  await settle();
}

beforeAll(async () => {
  const harness = await loadHarness(CONTROLS);
  ext = harness.ext;
  ui = harness.ui;
  await ext.activate(harness.context);
  await settle();
  // The modules below are imported AFTER the harness's module reset, so they
  // are the very instances the activated extension reads.
  seam = await import("@api/selectionOwner");
  objectSelection = await import("@api/objectSelection");
  const overlays = await import("@api/gridOverlays");
  const { CommandRegistry } = await import("@api/commands");
  const { installSelectedObjectKeys } = await import("../../BuiltIn/ObjectPosition/lib/selectedObjectKeys");
  const { setCurrentSelection } = await import("../Button/interceptors");
  setCurrentSelection({ startRow: 3, startCol: 2, endRow: 3, endCol: 2, type: "cells" } as never);
  cleanups.push(
    overlays.registerGridOverlay({ type: "slicer", render: () => {}, priority: 10 }),
    objectSelection.registerObjectSelectionProvider({
      types: ["slicer"],
      isSelected: (r) => slicerSelected.has(r.id),
      select: (r) => {
        slicerSelected.clear();
        slicerSelected.add(r.id);
      },
      addToSelection: (r) => void slicerSelected.add(r.id),
      removeFromSelection: (r) => void slicerSelected.delete(r.id),
      deselectAll: () => slicerSelected.clear(),
      labelOf: () => "Slicer 1",
    }),
    installSelectedObjectKeys({ commands: CommandRegistry }, "calcula.object-position"),
  );
  overlays.setGridRegions([SLICER]);
});

afterAll(async () => {
  while (cleanups.length) cleanups.pop()!();
  await ext.deactivate?.();
  await settle();
});

beforeEach(async () => {
  h.backend.clear();
  h.toasts.length = 0;
  h.picker.calls = 0;
  const { getAllFloatingControls, removeFloatingControl } = await import("../lib/floatingStore");
  for (const ctrl of getAllFloatingControls()) removeFloatingControl(ctrl.id);
  slicerSelected.clear();
  slicerSelected.add(SLICER.id);
  objectSelection.notifyObjectSelectionChanged();
  // Precondition, every time: the slicer is selected on a worksheet and the
  // generic claim holds the selection.
  expect(seam.getSelectionOwner()?.id, "precondition: the selected-object claim does not hold").toBe("selectedObject");
});

describe("with a slicer SELECTED on a worksheet, the Insert doors place their object at the active cell", () => {
  it("Insert > Shapes: a shape is written at Core's active cell, and nothing is refused", async () => {
    await galleryInsertShape()("rectangle");
    await settle();
    expect(h.toasts, "the insert was refused while an object is selected").toEqual([]);
    expect(h.backend.get(ANCHOR)?.controlType, "no shape was written at the active cell").toBe("shape");
  });

  it("Insert > Controls > Button: a button is written at Core's active cell", async () => {
    await insertButtonFromMenu();
    expect(h.toasts).toEqual([]);
    expect(h.backend.get(ANCHOR)?.controlType, "no button was written at the active cell").toBe("button");
  });

  it("Insert > Image: the picker opens and the picture is written at Core's active cell", async () => {
    await insertImageFromMenu();
    expect(h.toasts).toEqual([]);
    expect(h.picker.calls, "the image door refused before its picker").toBe(1);
    expect(h.backend.get(ANCHOR)?.controlType, "no picture was written at the active cell").toBe("image");
  });

  it("the claim still holds for every other door: a cell door is refused with the object's sentence", () => {
    expect(seam.selectionRefusalFor("Clear Contents")).toBe(
      "Clear Contents is not available while an object is selected. Press Escape or click a cell to go back to the cells. Nothing was changed.",
    );
  });
});

describe("a SPECIFIC claim (a floating grid's selected cell, wave-B B8) still refuses the insert", () => {
  let release: (() => void) | null = null;
  beforeEach(() => {
    release = seam.registerSelectionOwner({
      id: "testFloatingGrid",
      label: "a floating grid's cells",
      ownsSelection: () => true,
      refusal: (action) => `${action}: refused by the floating grid.`,
    });
  });

  it("Insert > Shapes: refused with ITS sentence, nothing written", async () => {
    try {
      await galleryInsertShape()("rectangle");
      await settle();
      expect(h.backend.size).toBe(0);
      expect(h.toasts).toEqual(["Insert Shape: refused by the floating grid."]);
    } finally {
      release?.();
    }
  });

  it("Insert > Image: refused BEFORE the picker opens", async () => {
    try {
      await insertImageFromMenu();
      expect(h.picker.calls, "the picker opened for an insert that is refused").toBe(0);
      expect(h.backend.size).toBe(0);
      expect(h.toasts).toEqual(["Insert Image: refused by the floating grid."]);
    } finally {
      release?.();
    }
  });
});
