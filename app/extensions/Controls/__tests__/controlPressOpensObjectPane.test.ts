//! FILENAME: app/extensions/Controls/__tests__/controlPressOpensObjectPane.test.ts
// PURPOSE: A press on a FLOATING control no longer opens the `control-properties`
//          task pane (WP-C S13, D-PANE): its Properties are a tab of the ONE
//          object pane, which the ObjectPane policy opens at the release. And
//          activate() registers the controls' object-pane and format
//          providers, so that pane has something to show.
// CONTEXT: Driven through the REAL activate() and the window event Core
//          dispatches on a press (`floatingObject:selected`) -- the
//          pageNavigatorDesignPress.test.ts harness -- with @api/ui's
//          openTaskPane doubled, because that call is exactly what used to
//          happen on every press of a shape, a picture or a Design-Mode button.
//          SABOTAGE (run once, then restored): put the old opener back into
//          handleFloatingSelected (`openTaskPane(PROPERTIES_PANE_ID, ...)`)
//          -> the press assertions go red.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { loadHarness, settle, type Loader } from "../../ModelMenu/__tests__/lifecycleHarness";

const h = vi.hoisted(() => ({
  opened: [] as Array<{ id: string; data: unknown }>,
}));

vi.mock("@api/ui", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openTaskPane: (id: string, data?: unknown) => {
    h.opened.push({ id, data });
  },
}));
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
    if (cmd === "get_sheets") return { sheets: [], activeIndex: 0 };
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
  }),
}));

const CONTROLS: Loader = () => import("..");

const SHAPE_ID = "control-0-2-1";
const BUTTON_ID = "control-0-5-1";

async function invokeBackend(command: string): Promise<unknown> {
  if (command === "get_all_controls") {
    const s = (v: number | string) => ({ valueType: "static" as const, value: String(v) });
    const floating = (x: number, y: number) => ({
      embedded: s("false"),
      pinToGrid: s("false"),
      x: s(x),
      y: s(y),
      width: s(120),
      height: s(60),
    });
    return [
      { sheetIndex: 0, row: 2, col: 1, metadata: { controlType: "shape", properties: { ...floating(64, 64), shapeType: s("rectangle") } } },
      { sheetIndex: 0, row: 5, col: 1, metadata: { controlType: "button", properties: { ...floating(300, 64), text: s("Go") } } },
    ];
  }
  return null;
}

let ext: Awaited<ReturnType<typeof loadHarness>>["ext"];
let overlays: typeof import("@api/gridOverlays");
let designMode: typeof import("../lib/designMode");
let selection: typeof import("../Button/floatingSelection");

/** Core's press on a control, as pressZone dispatches it (a frame press). */
function corePress(regionId: string): void {
  const r = overlays.getGridRegions().find((g) => g.id === regionId);
  if (!r) throw new Error(`${regionId} published no region`);
  window.dispatchEvent(
    new CustomEvent("floatingObject:selected", {
      detail: {
        regionId: r.id,
        regionType: r.type,
        data: r.data,
        zone: "frame",
        part: null,
        canvasX: 0,
        canvasY: 0,
        ctrlKey: false,
        shiftKey: false,
      },
    }),
  );
}

beforeAll(async () => {
  const harness = await loadHarness(CONTROLS, { invokeBackend });
  ext = harness.ext;
  await ext.activate(harness.context);
  await settle();
  overlays = await import("@api/gridOverlays");
  designMode = await import("../lib/designMode");
  selection = await import("../Button/floatingSelection");
  expect(overlays.getGridRegions().some((g) => g.id === SHAPE_ID), "precondition: the shape is loaded").toBe(true);
});

afterAll(async () => {
  await ext.deactivate?.();
  await settle();
});

beforeEach(async () => {
  h.opened.length = 0;
  selection.deselectFloatingControl();
  designMode.setDesignMode(false);
  await settle();
});

const propertiesOpens = () => h.opened.filter((o) => o.id === "control-properties");

describe("a press on a floating control opens no control-properties pane", () => {
  it("a shape press SELECTS it and opens nothing", async () => {
    corePress(SHAPE_ID);
    await settle();
    expect(selection.isFloatingControlSelected(SHAPE_ID)).toBe(true);
    expect(propertiesOpens()).toEqual([]);
  });

  it("a Design-Mode button press SELECTS it and opens nothing", async () => {
    designMode.setDesignMode(true);
    await settle();
    h.opened.length = 0;
    corePress(BUTTON_ID);
    await settle();
    expect(selection.isFloatingControlSelected(BUTTON_ID)).toBe(true);
    expect(propertiesOpens()).toEqual([]);
  });
});

describe("activate registers the controls' object-pane and format providers", () => {
  it("the object pane and the Format tab answer for floating-control regions", async () => {
    const pane = await import("@api/objectPane");
    const format = await import("@api/objectFormat");
    expect(pane.hasObjectPaneProvider("floating-control")).toBe(true);
    expect(format.hasObjectFormatProvider("floating-control")).toBe(true);
    const shape = overlays.getGridRegions().find((g) => g.id === SHAPE_ID)!;
    expect(pane.getObjectPaneProvider(shape)?.tabs(shape).map((t) => t.id)).toEqual(["properties"]);
  });
});
