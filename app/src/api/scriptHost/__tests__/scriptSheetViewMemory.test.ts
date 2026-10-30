//! FILENAME: app/src/api/scriptHost/__tests__/scriptSheetViewMemory.test.ts
// PURPOSE: A script's sheet changes -- api.deleteSheet, api.moveSheet, a
//          positioned api.addSheet, api.copySheet -- never restore ANOTHER
//          sheet's selection and scroll, and every sheet the user had looked at
//          still comes back with its own (review rev3C#2, BUG-0464).
// COVERS:  END TO END in the frontend, with nothing in between doubled: the
//          real broker (a FakeWorker sends the exact api.* calls a script
//          makes) -> the host's sheet doors -> the real @api/sheetSwitch seam
//          -> the real listeners Spreadsheet.tsx installs
//          (components/Spreadsheet/sheetSwitchListeners.ts) with the real
//          view memory. Only the backend (a model of the sheet list), the
//          grid's state store and the canvas prefetch are doubled. The user's
//          own visits go through the seam's `activateSheet` (the tab click).
// CONTEXT: The seam took the full switch whenever the active INDEX changed,
//          and the host passed no renumbering, so a delete before the active
//          sheet saved its view under its old index and restored, onto it,
//          the view a NEIGHBOUR had left under the new one. Round 4 made the
//          host tell each renumbering (scriptSheetRenumbering.test.ts pins the
//          calls); this proves what the user sees. Round 5 also fixed the
//          memory itself: a delete followed by an add handed the deleted
//          sheet's view to the new sheet (review rev3C#5).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { H2W, W2H } from "../protocol";

const hoisted = vi.hoisted(() => ({
  sheets: [] as Array<{ name: string; sheetId: string }>,
  active: 0,
  /** Core's sheet context as the grid shows it. */
  shown: { activeSheetIndex: 0, activeSheetName: "", activeSheetId: "" as string | undefined },
}));

function listing() {
  return {
    sheets: hoisted.sheets.map((s, index) => ({ index, name: s.name, sheetId: s.sheetId, visibility: "visible" })),
    activeIndex: hoisted.active,
  };
}

vi.mock("../../backend", () => ({
  invokeBackend: vi.fn().mockResolvedValue(null),
  getWorkbookProperties: vi.fn().mockRejectedValue(new Error("no backend in test")),
  emitTauriEvent: vi.fn().mockResolvedValue(undefined),
  listenTauriEvent: vi.fn().mockResolvedValue(() => undefined),
  readVirtualFile: vi.fn().mockResolvedValue(null),
  writeVirtualFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../capabilities", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  restoreAndSyncGrants: vi.fn().mockResolvedValue(undefined),
  revokeBackendCapabilities: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../mountGate", () => ({
  assertMountAllowed: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../writebackWriteGuard", () => ({
  captureWritebackWrite: vi.fn(async () => false),
  captureWritebackWrites: vi.fn(async (_id: string, writes: unknown[]) => ({
    plain: [...(writes as Array<Record<string, unknown>>)],
    drafted: [],
  })),
  workbookHasWritebackRegions: vi.fn(async () => false),
}));

/** The backend: the sheet list, with move_sheet / add_sheet / copy_sheet / delete_sheet as the Rust does them. */
vi.mock("../../lib", () => {
  const rotate = (from: number, to: number) => {
    const [moved] = hoisted.sheets.splice(from, 1);
    hoisted.sheets.splice(to, 0, moved);
  };
  const activeId = () => hoisted.sheets[hoisted.active].sheetId;
  return {
    getActiveSheet: vi.fn(async () => hoisted.active),
    getSheets: vi.fn(async () => listing()),
    getUndoState: vi.fn(async () => ({ transactionOpen: false })),
    beginUndoTransaction: vi.fn(async () => 1),
    commitUndoTransaction: vi.fn(async () => undefined),
    cancelUndoTransaction: vi.fn(async () => undefined),
    deleteSheet: vi.fn(async (index: number) => {
      const wasActive = index === hoisted.active;
      const keep = wasActive ? null : activeId();
      hoisted.sheets.splice(index, 1);
      hoisted.active = keep === null
        ? Math.min(index, hoisted.sheets.length - 1)
        : hoisted.sheets.findIndex((s) => s.sheetId === keep);
      return listing();
    }),
    moveSheet: vi.fn(async (from: number, to: number) => {
      const keep = activeId();
      rotate(from, to);
      hoisted.active = hoisted.sheets.findIndex((s) => s.sheetId === keep);
      return listing();
    }),
    addSheet: vi.fn(async (name?: string) => {
      const sheetName = name ?? `Sheet${hoisted.sheets.length + 1}`;
      hoisted.sheets.push({ name: sheetName, sheetId: `id-${sheetName}` });
      hoisted.active = hoisted.sheets.length - 1;
      return listing();
    }),
    copySheet: vi.fn(async (source: number, name?: string) => {
      const copyName = name ?? `${hoisted.sheets[source].name} (2)`;
      hoisted.sheets.splice(source + 1, 0, { name: copyName, sheetId: `id-${copyName}` });
      hoisted.active = source + 1;
      return listing();
    }),
  };
});

// The seam's own backend switch (`activateSheet`, the user's tab click).
vi.mock("../../../core/lib/tauri-api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  setActiveSheet: vi.fn(async (index: number) => {
    hoisted.active = index;
    return listing();
  }),
}));
vi.mock("../../../core/lib/sheetSwitchPrefetch", () => ({
  primeSheetSwitch: vi.fn(async () => undefined),
}));
vi.mock("../../../core/state/GridContext", () => ({
  getGridStateSnapshot: () => ({ sheetContext: { ...hoisted.shown } }),
}));
// Core's store: a sheet-context dispatch moves the context the seam reads.
vi.mock("../../gridDispatch", () => ({
  dispatchGridAction: (action: { type: string; payload?: { index?: number; name?: string; sheetId?: string } }) => {
    if (/ACTIVE_SHEET/i.test(action.type) && typeof action.payload?.index === "number") {
      hoisted.shown = {
        activeSheetIndex: action.payload.index,
        activeSheetName: action.payload.name ?? "",
        activeSheetId: action.payload.sheetId,
      };
    }
  },
}));
vi.mock("../../grid", () => ({
  setActiveSheet: (index: number, name: string, surface?: string, sheetId?: string) => ({
    type: "SET_ACTIVE_SHEET",
    payload: { index, name, surface, sheetId },
  }),
  refreshGridData: vi.fn(),
  refreshGridDimensions: vi.fn(),
  convertFormulaStyle: vi.fn(async (f: string) => f),
}));

import { activateSheet } from "../../sheetSwitch";
import { SheetViewMemory, listenForSheetSwitches } from "../../../core/components/Spreadsheet/sheetSwitchListeners";

class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((e: MessageEvent<W2H>) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  received: H2W[] = [];

  constructor() {
    FakeWorker.last = this;
  }

  postMessage(msg: H2W): void {
    this.received.push(msg);
    if (msg.t === "mount") this.emit({ t: "mounted", ok: true });
  }

  terminate(): void {
    /* nothing to clean up */
  }

  emit(data: W2H): void {
    this.onmessage?.({ data } as MessageEvent<W2H>);
  }

  async call(callId: number, method: string, args: unknown[]): Promise<{ ok: boolean; value?: unknown; error?: { message?: string } }> {
    this.emit({ t: "call", callId, method, args } as W2H);
    for (let i = 0; i < 200; i++) {
      const result = this.received.find(
        (m): m is Extract<H2W, { t: "callResult" }> => m.t === "callResult" && m.callId === callId,
      );
      if (result) return result as { ok: boolean; value?: unknown; error?: { message?: string } };
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`callResult for ${method} (id ${callId}) never arrived`);
  }
}

const globalScope = globalThis as unknown as Record<string, unknown>;
const originalWorker = globalScope.Worker;

type HostModule = typeof import("../host");
let host: HostModule;

const definition = {
  id: "script-sheet-view-memory",
  name: "Sheet view memory",
  objectType: "workbook",
  instanceId: null,
  source: "function setup(context) {}",
  accessLevel: "unlocked" as const,
  apiVersion: "1.0.0",
};

let nextCallId = 1;
async function wire(method: string, args: unknown[]) {
  const result = await FakeWorker.last!.call(nextCallId++, method, args);
  if (!result.ok) throw new Error(`${method} failed: ${result.error?.message}`);
  return result.value;
}

// ---- The grid: the view on screen, saved and restored by the REAL listeners ----

/** What the grid shows: a selection-and-scroll, spelled "<sheet>@<cell>". */
const grid = { view: "A1" };
let memory: SheetViewMemory<string>;
let stopListening: () => void = () => {};

/** The sheet on screen, by its stable id (Core's context). */
const onScreen = (): string | undefined => hoisted.shown.activeSheetId;
const indexOf = (name: string): number => hoisted.sheets.findIndex((s) => s.name === name);

/** The user clicks `name`'s tab (the seam's activateSheet: the tab click, step for step). */
async function visit(name: string): Promise<void> {
  await activateSheet(indexOf(name));
  expect(onScreen()).toBe(`id-${name}`);
}

/** The user selects and scrolls on the sheet on screen. */
function look(cell: string): void {
  grid.view = `${hoisted.shown.activeSheetName}@${cell}`;
}

/** Visit every named sheet and read back the view it opened with. */
async function viewsOnRevisit(...names: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of names) {
    await visit(name);
    out[name] = grid.view;
  }
  return out;
}

beforeEach(async () => {
  FakeWorker.last = null;
  nextCallId = 1;
  globalScope.Worker = FakeWorker as unknown as typeof Worker;
  hoisted.sheets = ["Sales", "Costs", "Summary", "Notes"].map((name) => ({ name, sheetId: `id-${name}` }));
  hoisted.active = 0;
  hoisted.shown = { activeSheetIndex: 0, activeSheetName: "Sales", activeSheetId: "id-Sales" };
  grid.view = "A1";
  memory = new SheetViewMemory<string>();
  memory.showing(0);
  stopListening = listenForSheetSwitches(memory, {
    captureView: () => grid.view,
    showView: (_index, view) => {
      grid.view = view ?? "A1";
    },
    focusGrid: () => undefined,
  });
  vi.resetModules();
  host = await import("../host");
  await host.hostMountScript(definition);
  // The user's session: each sheet looked at somewhere of its own; Notes on screen.
  look("C5");
  await visit("Costs");
  look("D9");
  await visit("Summary");
  look("J400");
  await visit("Notes");
  look("B2");
});

afterEach(() => {
  stopListening();
  host.hostResetAll();
  globalScope.Worker = originalWorker;
});

describe("a script's sheet change restores no other sheet's view (review rev3C#2)", () => {
  // SABOTAGE: drop `{ removedIndex: result.removedIndex }` from the host's
  // api.deleteSheet door -> the seam's backstop keeps Notes' own view on
  // screen, but Summary then comes back with the deleted Costs' D9 (and the
  // last test below restores Summary's J400 onto Notes).
  it("api.deleteSheet of a sheet BEFORE the active one: Notes keeps its own view, the others theirs", async () => {
    await wire("api.deleteSheet", ["Costs"]);
    expect(onScreen()).toBe("id-Notes");
    expect(grid.view, "the sheet on screen took another sheet's selection and scroll").toBe("Notes@B2");
    expect(await viewsOnRevisit("Sales", "Summary", "Notes")).toEqual({
      Sales: "Sales@C5",
      Summary: "Summary@J400",
      Notes: "Notes@B2",
    });
  });

  // SABOTAGE: drop `{ moved: ... }` from the host's api.moveSheet door -> Sales
  // comes back with Summary's J400.
  it("api.moveSheet of ANOTHER sheet past the active one, and of the active sheet itself", async () => {
    await wire("api.moveSheet", ["Sales", 3]); // Costs, Summary, Notes, Sales
    expect(onScreen()).toBe("id-Notes");
    expect(grid.view).toBe("Notes@B2");
    await wire("api.moveSheet", ["Notes", 0]); // Notes, Costs, Summary, Sales
    expect(onScreen()).toBe("id-Notes");
    expect(grid.view).toBe("Notes@B2");
    expect(await viewsOnRevisit("Sales", "Costs", "Summary", "Notes")).toEqual({
      Sales: "Sales@C5",
      Costs: "Costs@D9",
      Summary: "Summary@J400",
      Notes: "Notes@B2",
    });
  });

  it("a POSITIONED api.addSheet: the new sheet opens empty, and every other sheet keeps its own view", async () => {
    await wire("api.addSheet", ["Report", { before: "Costs" }]);
    expect(onScreen()).toBe("id-Report");
    expect(grid.view, "the new sheet opened with another sheet's view").toBe("A1");
    look("E3");
    expect(await viewsOnRevisit("Sales", "Costs", "Summary", "Notes", "Report")).toEqual({
      Sales: "Sales@C5",
      Costs: "Costs@D9",
      Summary: "Summary@J400",
      Notes: "Notes@B2",
      Report: "Report@E3",
    });
  });

  it("api.copySheet, plain and positioned: each copy opens empty, every other sheet keeps its own view", async () => {
    await wire("api.copySheet", ["Sales"]); // Sales, Sales (2), Costs, Summary, Notes
    expect(onScreen()).toBe("id-Sales (2)");
    expect(grid.view).toBe("A1");
    await wire("api.copySheet", ["Costs", "Costs copy", { after: "Notes" }]);
    expect(onScreen()).toBe("id-Costs copy");
    expect(grid.view).toBe("A1");
    expect(await viewsOnRevisit("Sales", "Costs", "Summary", "Notes")).toEqual({
      Sales: "Sales@C5",
      Costs: "Costs@D9",
      Summary: "Summary@J400",
      Notes: "Notes@B2",
    });
  });

  // SABOTAGE (rev3C#5): read a removal as a plain rotate in
  // renumberedSheetIndex -> the deleted Summary's J400 is parked at the far
  // index and handed to Report.
  it("api.deleteSheet of the ACTIVE sheet, then api.addSheet: the new sheet never opens at the deleted one's view (review rev3C#5)", async () => {
    await visit("Summary");
    expect(grid.view).toBe("Summary@J400");
    await wire("api.deleteSheet", ["Summary"]); // lands on Notes, now at 2
    expect(onScreen()).toBe("id-Notes");
    expect(grid.view).toBe("Notes@B2");
    await wire("api.addSheet", ["Report"]); // appended at 3
    expect(onScreen()).toBe("id-Report");
    expect(grid.view, "the new sheet opened at the DELETED sheet's selection and scroll").toBe("A1");
  });
});
