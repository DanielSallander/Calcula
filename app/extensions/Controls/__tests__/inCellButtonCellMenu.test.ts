//! FILENAME: app/extensions/Controls/__tests__/inCellButtonCellMenu.test.ts
// PURPOSE: "Make this my own…" reaches an IN-CELL (embedded) button control
//          through Core's CELL menu (owner question 8, 2026-10-02): the REAL
//          activate() notes, from the very read that loads the sheet's
//          controls, which in-cell buttons hold an application's code, and the
//          cell-menu item it registers offers the entry on exactly those --
//          never on the author's own in-cell button, never on a FLOATING one
//          (its own object menu carries it), and choosing it runs the
//          Properties pane's flow on that cell.
// CONTEXT: An in-cell button control's right-click is Core's cell menu, whose
//          `visible()` is synchronous, so the answer has to be known before
//          the right-click (lib/heldEmbeddedButtons.ts). Legacy buttons default
//          to in-cell, so without this the commonest held button had no
//          right-click route at all. Driven through the ModelMenu lifecycle
//          harness, with an in-memory stand-in for the control commands.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { loadHarness, settle, type Loader } from "../../ModelMenu/__tests__/lifecycleHarness";

type Props = Record<string, { valueType: string; value: string }>;
interface Meta {
  controlType: string;
  properties: Props;
}

const h = vi.hoisted(() => ({
  backend: new Map<string, Meta>(),
  adopted: [] as unknown[][],
  confirm: vi.fn(),
  toasts: [] as string[],
}));
const key = (s: number, r: number, c: number) => `${s}:${r}:${c}`;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const STAMP = JSON.stringify({ workspace: "ws", application: "Sales", version: "1.2.0" });
/** A button whose code came with the application 'Sales': HELD, no live code. In-cell by default. */
const held = (extra: Props = {}): Props => ({
  text: { valueType: "static", value: "Run report" },
  heldOnSelect: { valueType: "static", value: "Report();" },
  heldFrom: { valueType: "static", value: STAMP },
  ...extra,
});
const own: Props = { onSelect: { valueType: "static", value: "Mine();" } };
const FLOATING: Props = {
  embedded: { valueType: "static", value: "false" },
  x: { valueType: "static", value: "500" },
  y: { valueType: "static", value: "40" },
  width: { valueType: "static", value: "80" },
  height: { valueType: "static", value: "24" },
};

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
    selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" },
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
  // The one read that loads the sheet's controls.
  async getAllControls(sheetIndex: number) {
    await tick();
    return [...h.backend.entries()]
      .map(([k, metadata]) => {
        const [s, row, col] = k.split(":").map(Number);
        return { sheetIndex: s, row, col, metadata };
      })
      .filter((entry) => entry.sheetIndex === sheetIndex);
  },
  async adoptHeldButtonCode(...a: unknown[]) {
    await tick();
    h.adopted.push(a);
    return { controlType: "button", properties: { onSelect: { valueType: "static", value: String(a[3] ?? "") } } };
  },
  setControlProperty: vi.fn(),
  resolveControlProperties: vi.fn(async () => ({})),
}));
// The Tauri shape of the confirm: a Promise, never a synchronous boolean.
vi.mock("@api/dialogs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  confirmAsync: (...a: unknown[]) => h.confirm(...a),
}));
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/notifications")>()),
  showToast: (message: string) => {
    h.toasts.push(message);
  },
}));

const CONTROLS: Loader = () => import("..");

// Seeded BEFORE activation: activate()'s first load is the read under test.
h.backend.set(key(0, 6, 2), { controlType: "button", properties: held() });
h.backend.set(key(0, 6, 3), { controlType: "button", properties: own });
h.backend.set(key(0, 6, 4), { controlType: "button", properties: held(FLOATING) });

type GridItem = import("@api/extensions").GridContextMenuItem;
type MenuContext = import("@api/extensions").GridMenuContext;
let ext: Awaited<ReturnType<typeof loadHarness>>["ext"];
let cellItems: () => GridItem[];

const ITEM_ID = "controls.makeHeldCodeOwn";
const at = (sheetIndex: number, row: number, col: number): MenuContext =>
  ({
    selection: { startRow: row, startCol: col, endRow: row, endCol: col, type: "cells" },
    clickedCell: { row, col },
    isWithinSelection: true,
    sheetIndex,
    sheetName: "Sheet1",
    dimensions: {},
  }) as unknown as MenuContext;
const offered = (context: MenuContext): boolean => {
  const item = cellItems().find((i) => i.id === ITEM_ID);
  expect(item, "the cell menu carries no Make this my own item").toBeDefined();
  return typeof item!.visible === "function" ? item!.visible(context) : item!.visible !== false;
};

beforeAll(async () => {
  const harness = await loadHarness(CONTROLS);
  ext = harness.ext;
  await ext.activate(harness.context);
  await settle();
  await settle();
  cellItems = () => harness.extensions.gridExtensions.getContextMenuItems();
}, 30_000);

afterAll(async () => {
  await ext.deactivate?.();
  await settle();
});

beforeEach(() => {
  h.adopted.length = 0;
  h.confirm.mockReset();
  h.toasts.length = 0;
});

describe("the cell menu offers Make this my own… on an in-cell button control the LOAD found holding code", () => {
  it("offered on the held in-cell button; not on the author's own, nor on a floating one", () => {
    expect(offered(at(0, 6, 2)), "the held in-cell button has no right-click entry").toBe(true);
    expect(offered(at(0, 6, 3)), "offered on the author's own in-cell button").toBe(false);
    expect(offered(at(0, 6, 4)), "offered on a FLOATING button's cell (its object menu carries it)").toBe(false);
    expect(offered(at(0, 9, 9)), "offered on a cell with no control").toBe(false);
    expect(offered(at(1, 6, 2)), "offered on another sheet's cell").toBe(false);
  });

  it("choosing it shows the code in the pane's confirm and, on a yes, makes it the author's own", async () => {
    h.confirm.mockReturnValue(Promise.resolve(true));
    const item = cellItems().find((i) => i.id === ITEM_ID)!;
    await item.onClick(at(0, 6, 2));
    await settle();
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(String(h.confirm.mock.calls[0][0])).toContain("OnSelect:\nReport();");
    expect(h.adopted).toEqual([[0, 6, 2, "Report();", null]]);
    expect(h.toasts).toEqual([]);
  });
});
