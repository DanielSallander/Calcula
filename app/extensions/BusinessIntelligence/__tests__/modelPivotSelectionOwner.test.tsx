//! FILENAME: app/extensions/BusinessIntelligence/__tests__/modelPivotSelectionOwner.test.tsx
// PURPOSE: Every "PivotTable from Model" door creates the pivot at Core's
//          ACTIVE CELL on a worksheet, so each refuses with ONE toast and
//          creates nothing while a selection owner holds the selection; each
//          creates at the active cell when nothing does. On a CANVAS the cell
//          is never used -- the pivot goes into a frame -- so there is no
//          hidden cell to protect and the door is not refused.
// CONTEXT: D4 review (wave B; BUG-0185 class). With a floating grid's cell
//          selected on a worksheet, Core's selection stays on a cell HIDDEN
//          under the floating grid. Model > PivotTable from Model... (the menu
//          door and its dialog, which even showed that hidden cell as its
//          "Destination"), the Model dialog's Insert PivotTable and the
//          Connections pane's New PivotTable all created the pivot there. The
//          neighbouring Model > Report from Design Query already refused.
//          Real components and the real BI activation; only the backend-facing
//          calls are doubled. TEST owner (@api/selectionOwner).

/* eslint-disable @typescript-eslint/naming-convention --
 * React's own act() flag is spelled IS_REACT_ACT_ENVIRONMENT. */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  created: [] as { connectionId: string; destination: { row: number; col: number; sheetIndex?: number } }[],
  grid: {
    selection: { startRow: 2, startCol: 2, endRow: 2, endCol: 2, type: "cells" },
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
    zoom: 1,
    viewport: { scrollX: 0, scrollY: 0 },
    viewportDimensions: { width: 1000, height: 600 },
  },
  surfaces: {} as Record<number, unknown>,
}));

const CONNECTION = {
  id: "c1",
  name: "Sales model",
  isConnected: true,
  connectionType: "model",
  server: "",
  database: "",
  tableCount: 1,
  measureCount: 1,
  description: "",
  lastRefreshed: null,
  connectionString: "",
};

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  useGridState: () => h.grid,
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => h.grid,
}));
vi.mock("@api/layoutSurface", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/layoutSurface")>()),
  getLayoutSurface: (i: number) => h.surfaces[i] ?? null,
}));
vi.mock("@api/dialogWindow", () => ({
  useDialogWindow: () => ({ ref: { current: null }, style: {}, resizeHandles: null }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => "C:/models/sales.json") }));
vi.mock("../../_shared/lib/bi-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../_shared/lib/bi-api")>()),
  getConnections: vi.fn(async () => [CONNECTION]),
  createConnection: vi.fn(async () => CONNECTION),
  connect: vi.fn(async () => CONNECTION),
  getModelInfo: vi.fn(async () => ({ tables: [], measures: [], relationships: [], hierarchies: [] })),
}));
vi.mock("../lib/modelPivot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/modelPivot")>()),
  createModelPivot: vi.fn(async (connectionId: string, destination: { row: number; col: number }) => {
    h.created.push({ connectionId, destination });
    return "p1";
  }),
}));

import { CreateModelPivotDialog } from "../components/CreateModelPivotDialog";
import { ModelDialog } from "../components/ModelDialog";
import { ConnectionsPane } from "../components/ConnectionsPane";
import { modelPivotDestinationAtSelection } from "../lib/modelPivot";
import BusinessIntelligence from "../index";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const toasts: ToastPayload[] = [];
let owns = false;
let release: () => void = () => {};
let root: Root | null = null;
let host: HTMLDivElement;

function refusals(): ToastPayload[] {
  return toasts.filter((t) => t.message.includes("the selection belongs to"));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

async function mount(element: React.ReactElement): Promise<void> {
  root = createRoot(host);
  await act(async () => {
    root!.render(element);
    await settle();
  });
}

async function clickButton(label: string): Promise<void> {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
  if (!button) throw new Error(`no '${label}' button in: ${host.textContent?.slice(0, 300)}`);
  await act(async () => {
    button.click();
    await settle();
  });
}

/** A canvas on sheet 1, the active sheet. */
function onCanvas(): void {
  h.surfaces[1] = { snapToGrid: false, gridSize: 16, showGrid: true, page: { width: 1280, height: 720 }, editable: true };
  h.grid.sheetContext = { activeSheetIndex: 1, activeSheetName: "Report" };
}

beforeEach(() => {
  h.created.length = 0;
  h.surfaces = {};
  h.grid.sheetContext = { activeSheetIndex: 0, activeSheetName: "Sheet1" };
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  owns = false;
  release = registerSelectionOwner({ id: "test-owner", label: "the test object's cells", ownsSelection: () => owns });
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(async () => {
  release();
  if (root) {
    const r = root;
    await act(async () => {
      r.unmount();
    });
    root = null;
  }
  host.remove();
});

// ----------------------------------------------------------------------------
// The one decision every door asks
// ----------------------------------------------------------------------------

describe("modelPivotDestinationAtSelection", () => {
  it("owned, on a worksheet: null, one toast", () => {
    owns = true;
    expect(modelPivotDestinationAtSelection(h.grid)).toBeNull();
    expect(refusals().length).toBe(1);
  });

  it("owned, on a canvas: the destination (a frame is used, not the cell), no toast", () => {
    owns = true;
    onCanvas();
    expect(modelPivotDestinationAtSelection(h.grid)).toEqual({ row: 2, col: 2, sheetIndex: 1 });
    expect(refusals()).toEqual([]);
  });

  it("positive control: not owned -> the active cell on the active sheet", () => {
    expect(modelPivotDestinationAtSelection(h.grid)).toEqual({ row: 2, col: 2, sheetIndex: 0 });
    expect(refusals()).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// Model > PivotTable from Model... (the menu door and its dialog)
// ----------------------------------------------------------------------------

describe("Model > PivotTable from Model... (menu door)", () => {
  async function menuDoor(): Promise<{ run: () => unknown; shown: string[] }> {
    const items = new Map<string, { action?: () => unknown }>();
    const shown: string[] = [];
    const inert = (): unknown =>
      new Proxy(() => () => {}, {
        get: (_t, prop) => (prop === "then" ? undefined : inert()),
        apply: () => () => {},
      });
    const context = new Proxy(inert() as Record<string, unknown>, {
      get: (t, prop) => {
        if (prop === "ui") {
          return new Proxy(inert() as Record<string, unknown>, {
            get: (u, p) => {
              if (p === "menus") {
                return {
                  registerItem: (_menu: string, item: { id: string; action?: () => unknown }) => void items.set(item.id, item),
                  unregisterItem: (_menu: string, id: string) => void items.delete(id),
                };
              }
              if (p === "dialogs") {
                return { register: () => {}, unregister: () => {}, show: (id: string) => void shown.push(id) };
              }
              return (u as Record<string | symbol, unknown>)[p as string];
            },
          });
        }
        return (t as Record<string | symbol, unknown>)[prop as string];
      },
    }) as never;
    await BusinessIntelligence.activate(context);
    const item = items.get("model:insertPivot");
    if (!item?.action) throw new Error("no model:insertPivot menu item");
    return { run: item.action, shown };
  }

  afterEach(async () => {
    await BusinessIntelligence.deactivate?.();
  });

  it("owned, on a worksheet: opens no dialog (it would show the hidden cell as its destination); one toast", async () => {
    const door = await menuDoor();
    owns = true;
    await door.run();
    expect(door.shown, "the dialog opened over Core's hidden active cell").toEqual([]);
    expect(refusals().length).toBe(1);
  });

  it("positive control: not owned -> the dialog opens", async () => {
    const door = await menuDoor();
    await door.run();
    expect(door.shown).toEqual(["bi:createModelPivotDialog"]);
    expect(refusals()).toEqual([]);
  });
});

describe("the PivotTable from Model dialog's Insert PivotTable", () => {
  const open = () => mount(<CreateModelPivotDialog isOpen={true} onClose={() => {}} {...({} as object)} /> as never);

  it("owned, on a worksheet: creates nothing at Core's hidden active cell; one toast", async () => {
    await open();
    owns = true;
    await clickButton("Insert PivotTable");
    expect(h.created, "a model pivot was created at Core's HIDDEN active cell (C3)").toEqual([]);
    expect(refusals().length).toBe(1);
  });

  it("owned, on a canvas: creates the pivot (in a frame), no toast", async () => {
    onCanvas();
    await open();
    owns = true;
    await clickButton("Insert PivotTable");
    expect(h.created).toEqual([{ connectionId: "c1", destination: { row: 2, col: 2, sheetIndex: 1 } }]);
    expect(refusals()).toEqual([]);
  });

  it("positive control: not owned -> created at C3", async () => {
    await open();
    await clickButton("Insert PivotTable");
    expect(h.created).toEqual([{ connectionId: "c1", destination: { row: 2, col: 2, sheetIndex: 0 } }]);
    expect(refusals()).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// W23 (wave C): the dialog's "Destination" line says where the pivot GOES
// ----------------------------------------------------------------------------

describe("the PivotTable from Model dialog's Destination line", () => {
  const open = () => mount(<CreateModelPivotDialog isOpen={true} onClose={() => {}} {...({} as object)} /> as never);

  function destinationLine(): string {
    const line = [...host.querySelectorAll("div")]
      .map((d) => d.textContent ?? "")
      .find((t) => t.startsWith("Destination:"));
    if (line === undefined) throw new Error(`no Destination line in: ${host.textContent?.slice(0, 300)}`);
    return line;
  }

  it("on a canvas it names the canvas frame, never a cell (the cell is not used there)", async () => {
    onCanvas();
    await open();
    expect(destinationLine(), "the dialog named a cell the canvas pivot does not use").not.toMatch(/Cell/);
    expect(destinationLine()).toMatch(/canvas/i);
  });

  it("positive control: on a worksheet it names the active cell", async () => {
    await open();
    expect(destinationLine()).toBe("Destination: Cell C3");
  });
});

// ----------------------------------------------------------------------------
// Model > New Model Connection... > Insert PivotTable
// ----------------------------------------------------------------------------

describe("the Model dialog's Insert PivotTable (after creating a connection)", () => {
  async function createConnectionThenInsert(): Promise<void> {
    await mount(<ModelDialog isOpen={true} onClose={() => {}} {...({} as object)} /> as never);
    await clickButton("Browse");
    await clickButton("Create Connection");
  }

  it("owned, on a worksheet: creates nothing; one toast", async () => {
    await createConnectionThenInsert();
    owns = true;
    await clickButton("Insert PivotTable");
    expect(h.created, "a model pivot was created at Core's HIDDEN active cell (C3)").toEqual([]);
    expect(refusals().length).toBe(1);
  });

  it("positive control: not owned -> created at C3", async () => {
    await createConnectionThenInsert();
    await clickButton("Insert PivotTable");
    expect(h.created).toEqual([{ connectionId: "c1", destination: { row: 2, col: 2, sheetIndex: 0 } }]);
    expect(refusals()).toEqual([]);
  });

  // W23's sibling (wave C review): this dialog printed "Destination: Cell C3"
  // on a canvas too, where createModelPivot puts the pivot in a frame and the
  // cell is never used. Both dialogs now read the one label (lib/modelPivot.ts
  // modelPivotDestinationLabel).
  function destinationLine(): string {
    const line = [...host.querySelectorAll("div")]
      .map((d) => d.textContent ?? "")
      .find((t) => t.startsWith("Destination:"));
    if (line === undefined) throw new Error(`no Destination line in: ${host.textContent?.slice(0, 300)}`);
    return line;
  }

  it("on a canvas its Destination line names the canvas frame, never a cell", async () => {
    onCanvas();
    await createConnectionThenInsert();
    expect(destinationLine(), "the Model dialog named a cell the canvas pivot does not use").not.toMatch(/Cell/);
    expect(destinationLine()).toMatch(/canvas/i);
  });

  it("positive control: on a worksheet its Destination line names the active cell", async () => {
    await createConnectionThenInsert();
    expect(destinationLine()).toBe("Destination: Cell C3");
  });
});

// ----------------------------------------------------------------------------
// Data > Connections pane > New PivotTable
// ----------------------------------------------------------------------------

describe("the Connections pane's New PivotTable", () => {
  const open = () => mount(<ConnectionsPane {...({} as never)} />);

  it("owned, on a worksheet: creates nothing; one toast", async () => {
    await open();
    owns = true;
    await clickButton("New PivotTable");
    expect(h.created, "a model pivot was created at Core's HIDDEN active cell (C3)").toEqual([]);
    expect(refusals().length).toBe(1);
  });

  it("positive control: not owned -> created at C3", async () => {
    await open();
    await clickButton("New PivotTable");
    expect(h.created).toEqual([{ connectionId: "c1", destination: { row: 2, col: 2, sheetIndex: 0 } }]);
    expect(refusals()).toEqual([]);
  });
});
