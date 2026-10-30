//! FILENAME: app/src/api/scriptHost/__tests__/scriptSheetRenumbering.test.ts
// PURPOSE: The script host's own sheet doors -- api.deleteSheet, api.moveSheet,
//          api.addSheet (plain and positioned), api.copySheet (plain and
//          positioned), api.renameSheet -- FOLLOW each backend answer through
//          @api/sheetSwitch with the renumbering the change made, and BEFORE
//          the script's batch resumes (review revG#3, BUG-0464).
// COVERS:  over the real broker (a FakeWorker sends the exact api.* calls a
//          script makes), with a backend model of the sheet list and the undo
//          slot: each follow carries the index a delete removed, the index an
//          add or a copy landed on, a move's two ends -- what the tab strip and
//          the command line tell for their own -- and comes right after its
//          own backend answer, ahead of the resume's begin (an IPC).
// CONTEXT: Core keeps each sheet's selection and scroll by TRUE index and
//          re-keys that memory only when told (`sheet:reorder`). The host told
//          nothing for its delete, move, positioned add or copy, so every later
//          sheet came back with its neighbour's view. And it followed AFTER
//          resumeScriptBatchAfterHistoryEnded, an IPC when the script has a
//          batch open: the wrapper's own announcement starts a tab-strip
//          reload, and one that answered in that window moved Core's context
//          alone -- the follow then judged the switch already made.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { H2W, W2H } from "../protocol";

interface ModelSheet {
  name: string;
  sheetId: string;
}

const hoisted = vi.hoisted(() => ({
  /** Everything that happened, in order: backend calls and follows. */
  log: [] as string[],
  sheets: [] as Array<{ name: string; sheetId: string }>,
  active: 0,
  nextTicket: 1,
  open: false,
}));

function listing() {
  return {
    sheets: hoisted.sheets.map((s, index) => ({ index, name: s.name, sheetId: s.sheetId, visibility: "visible" })),
    activeIndex: hoisted.active,
  };
}

vi.mock("../../sheetSwitch", () => ({
  announceSheetsChanged: vi.fn(async (_result: unknown, renumbering?: unknown) => {
    hoisted.log.push(`follow:${JSON.stringify(renumbering ?? null)}`);
  }),
  activateSheet: vi.fn(),
  changeSheetsAndFollow: vi.fn(),
}));
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
vi.mock("../../lib", () => {
  const rotate = (from: number, to: number) => {
    const [moved] = hoisted.sheets.splice(from, 1);
    hoisted.sheets.splice(to, 0, moved);
  };
  /** A sheet structure command ends the undo history, the open transaction with it. */
  const endHistory = () => {
    hoisted.open = false;
  };
  return {
    getActiveSheet: vi.fn(async () => hoisted.active),
    getSheets: vi.fn(async () => listing()),
    getUndoState: vi.fn(async () => ({ transactionOpen: hoisted.open })),
    beginUndoTransaction: vi.fn(async (label: string) => {
      hoisted.log.push(`begin:${label}`);
      if (hoisted.open) return null;
      hoisted.open = true;
      return hoisted.nextTicket++;
    }),
    commitUndoTransaction: vi.fn(async () => {
      hoisted.open = false;
    }),
    cancelUndoTransaction: vi.fn(async () => {
      hoisted.open = false;
    }),
    deleteSheet: vi.fn(async (index: number) => {
      hoisted.log.push(`deleteSheet:${index}`);
      endHistory();
      hoisted.sheets.splice(index, 1);
      if (hoisted.active >= hoisted.sheets.length || hoisted.active > index) hoisted.active = Math.max(0, hoisted.active - 1);
      return listing();
    }),
    moveSheet: vi.fn(async (from: number, to: number) => {
      hoisted.log.push(`moveSheet:${from}->${to}`);
      endHistory();
      const activeId = hoisted.sheets[hoisted.active].sheetId;
      rotate(from, to);
      hoisted.active = hoisted.sheets.findIndex((s) => s.sheetId === activeId);
      return listing();
    }),
    addSheet: vi.fn(async (name?: string) => {
      hoisted.log.push("addSheet");
      endHistory();
      const sheetName = name ?? `Sheet${hoisted.sheets.length + 1}`;
      hoisted.sheets.push({ name: sheetName, sheetId: `id-${sheetName}` });
      hoisted.active = hoisted.sheets.length - 1;
      return listing();
    }),
    copySheet: vi.fn(async (source: number, name?: string) => {
      hoisted.log.push(`copySheet:${source}`);
      endHistory();
      const copyName = name ?? `${hoisted.sheets[source].name} (2)`;
      hoisted.sheets.splice(source + 1, 0, { name: copyName, sheetId: `id-${copyName}` });
      hoisted.active = source + 1;
      return listing();
    }),
    renameSheet: vi.fn(async (index: number, newName: string) => {
      hoisted.log.push(`renameSheet:${index}`);
      endHistory();
      hoisted.sheets[index] = { ...hoisted.sheets[index], name: newName };
      return listing();
    }),
  };
});
vi.mock("../../grid", () => ({
  refreshGridData: vi.fn(),
  refreshGridDimensions: vi.fn(),
  convertFormulaStyle: vi.fn(async (f: string) => f),
}));

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
  id: "script-sheet-renumbering",
  name: "Sheet renumbering",
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

/** Sales, Costs, Summary, Notes -- Sales active -- and the script's batch OPEN. */
async function setUp(): Promise<void> {
  hoisted.sheets = ["Sales", "Costs", "Summary", "Notes"].map((name): ModelSheet => ({ name, sheetId: `id-${name}` }));
  hoisted.active = 0;
  await wire("api.beginBatch", ["Script edits"]);
  hoisted.log.length = 0;
}

/** The log from the backend call that `step` names on. */
function from(step: string): string[] {
  const at = hoisted.log.findIndex((entry) => entry.startsWith(step));
  expect(at, `${step} never reached the backend: ${JSON.stringify(hoisted.log)}`).toBeGreaterThan(-1);
  return hoisted.log.slice(at);
}

beforeEach(async () => {
  FakeWorker.last = null;
  nextCallId = 1;
  hoisted.log.length = 0;
  hoisted.open = false;
  hoisted.nextTicket = 1;
  globalScope.Worker = FakeWorker as unknown as typeof Worker;
  vi.resetModules();
  host = await import("../host");
  await host.hostMountScript(definition);
  await setUp();
});

afterEach(() => {
  host.hostResetAll();
  globalScope.Worker = originalWorker;
});

describe("the script host's sheet doors tell the renumbering, and follow before the batch resumes (revG#3)", () => {
  // SABOTAGE: drop `{ removedIndex: result.removedIndex }` from the
  // api.deleteSheet door -- the follow carries null.
  it("api.deleteSheet: the follow carries the index it removed, then the batch resumes", async () => {
    await wire("api.deleteSheet", ["Costs"]);
    expect(from("deleteSheet")).toEqual([
      "deleteSheet:1",
      'follow:{"removedIndex":1}',
      "begin:Script edits",
    ]);
  });

  // SABOTAGE: put the api.moveSheet door's resume back ahead of its follow --
  // the begin (an IPC) lands between the backend's answer and the follow.
  it("api.moveSheet: the follow carries the rotate, ahead of the resume", async () => {
    await wire("api.moveSheet", ["Sales", 2]);
    expect(from("moveSheet")).toEqual([
      "moveSheet:0->2",
      'follow:{"moved":{"fromIndex":0,"toIndex":2}}',
      "begin:Script edits",
    ]);
  });

  it("api.renameSheet: followed before the resume (no renumbering)", async () => {
    await wire("api.renameSheet", ["Costs", "Spend"]);
    expect(from("renameSheet")).toEqual(["renameSheet:1", "follow:null", "begin:Script edits"]);
  });

  it("api.addSheet: the follow carries where the new sheet landed", async () => {
    await wire("api.addSheet", ["Report"]);
    expect(from("addSheet")).toEqual(["addSheet", 'follow:{"insertedIndex":4}', "begin:Script edits"]);
  });

  // SABOTAGE: drop the follow after the positioned add's move -- the rotate
  // is never told and the log ends on the add's follow and the resume.
  it("a POSITIONED api.addSheet: the add followed with its landing, then the move with its rotate, each from its own answer", async () => {
    const added = await wire("api.addSheet", ["Report", { before: "Costs" }]);
    expect(added).toEqual({ index: 1, name: "Report" });
    expect(from("addSheet")).toEqual([
      "addSheet",
      'follow:{"insertedIndex":4}',
      "moveSheet:4->1",
      'follow:{"moved":{"fromIndex":4,"toIndex":1}}',
      "begin:Script edits",
    ]);
  });

  it("api.copySheet: the follow carries where the copy landed", async () => {
    await wire("api.copySheet", ["Sales"]);
    expect(from("copySheet")).toEqual(["copySheet:0", 'follow:{"insertedIndex":1}', "begin:Script edits"]);
  });

  it("a POSITIONED api.copySheet: the copy followed with its landing, then the move with its rotate", async () => {
    const copied = await wire("api.copySheet", ["Sales", "Sales copy", { after: "Notes" }]);
    expect(copied).toEqual({ index: 4, name: "Sales copy" });
    expect(from("copySheet")).toEqual([
      "copySheet:0",
      'follow:{"insertedIndex":1}',
      "moveSheet:1->4",
      'follow:{"moved":{"fromIndex":1,"toIndex":4}}',
      "begin:Script edits",
    ]);
  });
});
