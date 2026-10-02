//! FILENAME: app/extensions/MacroRecorder/__tests__/explicitRunEndToEnd.test.ts
// PURPOSE: Owner decision B (2026-09-30), composed end to end. "An APPROVED
//          application macro that the user runs EXPLICITLY ... gets the same
//          CELL access in either runtime ... Standing object scripts, and any run
//          a script starts on its own, stay restricted."
//
//          Every other test of the decision doubles the next layer: the dialog
//          test mocks the runner, the provider test mocks the runner, the runner
//          test mocks the host, the admission test hand-builds the definition.
//          Each is right about its own layer and none would notice the layers
//          drifting apart -- the runner naming the artifact differently from what
//          `admitMount` checks, a field the grant needs arriving `null` instead
//          of `undefined`. So here NOTHING between the door and the realm is
//          doubled: the Macro Recorder's real provider and `runMacroModule`, the
//          real one-off runner, the real script host and broker, and the REAL
//          worker shim (`buildWorkerContext`) running the REAL source the Macro
//          Recorder generates (`generateMacroSource`) -- so a recorded macro's own
//          `if (!context.api) throw new Error(...)` (ownerB follow-up F12; it
//          used to notify and return, so a restricted run read as "ran")
//          decides what happens, exactly as it does in the product.
//
// CONTEXT: Doubled, and only these: the Tauri boundary (the Rust mount gate
//          `check_distributed_mount_consent`, answering in a later task like real
//          IPC), Script Security, the capability sync, the toast sink, the grid
//          library's read/write/undo doors, the module store, and the Worker
//          constructor (a fake that runs the shim in-process and posts each
//          message as its own task, as a MessagePort does).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

interface StoredScript {
  id: string;
  name: string;
  description: string | null;
  source: string;
  sourcePackage: string | null;
}

const h = vi.hoisted(() => ({
  store: new Map<string, StoredScript>(),
  gate: [] as Array<{ phase: string; artifacts: unknown; trigger: unknown; explicitRun: unknown }>,
  /** The Rust gate's grants (owner decision B, F3) and the write reports the host sent (F15). */
  grantSeq: 0,
  reports: [] as Array<Record<string, unknown>>,
  refuseRunCheck: false,
  toasts: [] as string[],
  writes: [] as Array<[number, number, string]>,
  undo: [] as string[],
  /** The Rust button door's answer to a click (`run_control_action`). */
  door: null as unknown,
  /**
   * THE BACKEND'S ONE UNDO SLOT, as the doubles below share it (owner decision
   * B, follow-up F9): the cells as they stand, the open transaction's ticket,
   * and the changes recorded into it (each with the cell's value before) -- so
   * a rollback to a savepoint restores what the run overwrote.
   */
  cells: new Map<string, string>(),
  slot: null as number | null,
  ticketSeq: 0,
  slotChanges: [] as Array<{ key: string; prev: string | undefined }>,
  /** A cell write, recorded into the open transaction when one is open. */
  write(row: number, col: number, value: string): void {
    const key = `${row},${col}`;
    if (this.slot !== null) this.slotChanges.push({ key, prev: this.cells.get(key) });
    this.cells.set(key, value);
    this.writes.push([row, col, value]);
  },
  /** A frontend begin: OPENS the slot (a ticket) or JOINS what is open (null). */
  begin(): number | null {
    if (this.slot !== null) {
      this.undo.push("join");
      return null;
    }
    this.ticketSeq += 1;
    this.slot = this.ticketSeq;
    this.slotChanges = [];
    this.undo.push("begin");
    return this.slot;
  },
  /** A ticketed close: only while the slot still holds that transaction. */
  close(ticket: number | null | undefined, as: "commit" | "cancel"): void {
    if (ticket === null || ticket === undefined || ticket !== this.slot) return;
    this.slot = null;
    this.slotChanges = [];
    this.undo.push(as);
  },
}));

vi.mock("@api/backend", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  invokeBackend: vi.fn(
    async (
      cmd: string,
      args?: { phase?: string; artifacts?: unknown; trigger?: unknown; explicitRun?: unknown; report?: unknown },
    ) => {
      if (cmd === "run_control_action") return h.door;
      // THE SAVEPOINT DOORS (F9), over the one slot above.
      if (cmd === "begin_undo_savepoint") {
        const ticket = h.begin();
        return { ticket, savepoint: { transaction: h.slot, changes: h.slotChanges.length } };
      }
      if (cmd === "roll_back_to_undo_savepoint") {
        h.undo.push("rollback");
        const sp = (args as { savepoint?: { transaction: number; changes: number } } | undefined)?.savepoint;
        if (!sp || sp.transaction !== h.slot || sp.changes > h.slotChanges.length) {
          return { success: false, refusal: "gone", updatedCells: [], refreshDomains: [], activeSheetIndex: 0 };
        }
        for (const change of h.slotChanges.splice(sp.changes).reverse()) {
          if (change.prev === undefined) h.cells.delete(change.key);
          else h.cells.set(change.key, change.prev);
        }
        return { success: true, refusal: null, updatedCells: [], refreshDomains: [], activeSheetIndex: 0 };
      }
      if (cmd === "audit_explicit_run_writes") {
        h.reports.push(args?.report as Record<string, unknown>);
        return 1;
      }
      if (cmd !== "check_distributed_mount_consent") return null;
      const phase = args?.phase ?? "(none)";
      h.gate.push({
        phase,
        artifacts: args?.artifacts ?? null,
        trigger: args?.trigger ?? null,
        explicitRun: args?.explicitRun ?? null,
      });
      await new Promise<void>((r) => setTimeout(r, 1));
      if (phase === "runCheck" && h.refuseRunCheck) {
        throw new Error("DISTRIBUTED_SCRIPT_NOT_CONSENTED: this application's code is not approved");
      }
      // THE RUST HALF (F3): cell access on `runAdmitted`, for the claim it is
      // shown -- the gate's own checks are pinned by its Rust tests.
      if (phase === "runAdmitted" && args?.explicitRun) {
        h.grantSeq += 1;
        return { recheckWhileRunning: false, cellAccess: true, grantId: h.grantSeq };
      }
      return { recheckWhileRunning: false };
    },
  ),
  getWorkbookProperties: vi.fn().mockRejectedValue(new Error("no backend in test")),
  emitTauriEvent: vi.fn().mockResolvedValue(undefined),
  listenTauriEvent: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("@api/scriptHost/capabilities", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  restoreAndSyncGrants: vi.fn().mockResolvedValue(undefined),
  revokeBackendCapabilities: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@api/scriptHost/mountGate", () => ({
  assertMountAllowed: vi.fn(async () => undefined),
}));
vi.mock("@api/notifications", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  showToast: (message: string) => {
    h.toasts.push(message);
  },
}));
vi.mock("@api/scriptHost/writebackWriteGuard", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  workbookHasWritebackRegions: async () => false,
  captureWritebackWrite: async () => false,
  captureWritebackWrites: async (_id: string, writes: unknown[]) => ({ plain: writes, drafted: [] }),
}));
vi.mock("@api/lib", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getSheets: async () => ({
    sheets: [
      { index: 0, name: "Sheet1" },
      { index: 1, name: "Sheet2" },
    ],
    activeIndex: 0,
  }),
  getActiveSheet: async () => 0,
  setActiveSheet: async () => ({
    sheets: [
      { index: 0, name: "Sheet1" },
      { index: 1, name: "Sheet2" },
    ],
    activeIndex: 0,
  }),
  // Style 1 is a button style: what the in-cell button's click interceptor
  // asks of the clicked cell (Controls/Button/interceptors.ts).
  getAllStyles: async () => [{}, { button: true }],
  getCell: async () => ({ display: "", styleIndex: 1 }),
  updateCell: async (row: number, col: number, value: string) => {
    h.write(row, col, value);
    return { cells: [] };
  },
  updateCellsBatch: async (updates: Array<{ row: number; col: number; value: string }>) => {
    for (const u of updates) h.write(u.row, u.col, u.value);
    return [];
  },
  beginUndoTransaction: async () => h.begin(),
  commitUndoTransaction: async (ticket?: number | null) => h.close(ticket, "commit"),
  cancelUndoTransaction: async (ticket?: number | null) => h.close(ticket, "cancel"),
}));
vi.mock("@api/grid", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  refreshGridData: vi.fn(),
  refreshGridDimensions: vi.fn(),
}));
vi.mock("@api/gridDispatch", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  dispatchGridAction: vi.fn(),
}));
// THE MODULE STORE, as both the Macro Recorder (through "@api") and the one-off
// runner (through ./workbookScripts) read it.
vi.mock("@api/workbookScripts", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listWorkbookScripts: async () => [...h.store.values()].map((s) => ({ id: s.id, name: s.name })),
  getWorkbookScript: async (id: string) => {
    const found = h.store.get(id);
    if (!found) throw new Error(`Script '${id}' not found`);
    return { ...found };
  },
}));
vi.mock("@api", async () => {
  const origin = await vi.importActual<typeof import("@api/scriptHost/scriptOrigin")>(
    "@api/scriptHost/scriptOrigin",
  );
  const scripts = await vi.importActual<typeof import("@api/workbookScripts")>("@api/workbookScripts");
  // The REAL one-off runner. Its own imports (the host, the store) resolve to
  // the doubles above, exactly as they would for the product.
  const runner = await vi.importActual<typeof import("@api/objectScriptRunner")>("@api/objectScriptRunner");
  return {
    scriptOriginForStoredRecord: origin.scriptOriginForStoredRecord,
    originTagTitle: origin.originTagTitle,
    parseModuleScriptRuntime: scripts.parseModuleScriptRuntime,
    listWorkbookScripts: async () => [...h.store.values()].map((s) => ({ id: s.id, name: s.name })),
    getWorkbookScript: async (id: string) => {
      const found = h.store.get(id);
      if (!found) throw new Error(`Script '${id}' not found`);
      return { ...found };
    },
    listWorkbookScriptRecords: async () => [],
    saveWorkbookScript: async () => undefined,
    deleteWorkbookScript: async () => undefined,
    runWorkbookScript: async () => ({
      type: "success",
      output: [],
      cellsModified: 1,
      durationMs: 1,
      screenUpdating: true,
    }),
    runObjectScriptOnce: runner.runObjectScriptOnce,
  };
});

import { buildMacroDescription, runMacroByRef, runMacroModule } from "../lib/macroLibrary";
import { generateMacroSource } from "../lib/actionCodegen";
import { runObjectScriptOnce } from "@api/objectScriptRunner";
import { claimExplicitMacroRun, mintExplicitMacroRun } from "@api/explicitMacroRun";
import { registerMacroRunProvider, resetMacroRunProvider } from "@api/macroRunService";
import { hostResetAll } from "@api/scriptHost/host";
import { buildWorkerContext, type WorkerRuntime } from "@api/scriptHost/worker/contextShims";
import type { MountSpec } from "@api/scriptHost/protocol";
// The button doors' GESTURE handlers, as Core calls them (owner decision B,
// follow-ups F1 + F6) -- a test may reach across extensions; production may not.
import { buttonClickInterceptor, refreshStyleCache } from "../../Controls/Button/interceptors";
import { isCellReleaseClaim, type CellReleaseClaim } from "@api/cellClickInterceptors";

/**
 * An in-cell button's press is CLAIMED for its release (BUG-0258 design phase
 * 4: buttons act on release, sliding off cancels): nothing ran at the press.
 * Release it on the same cell, as Core's press session does.
 */
async function releaseOnTheButton(answer: unknown, row: number, col: number): Promise<void> {
  expect(isCellReleaseClaim(answer), "the button's press was not claimed for its release").toBe(true);
  await (answer as CellReleaseClaim).runAtRelease({ clientX: 0, clientY: 0, row, col });
}

import { clickButtonControl } from "../../Controls/lib/controlClick";
import { controlsBackend } from "../../Controls/lib/controlsBackend";
import { buttonCellType } from "../../CellTypes/types/button";
// The command line's real engine, app domain and LIVE gateway (follow-up F2).
import { createCliEngine } from "../../_shared/cli/engine";
import { createAppDomain } from "../../CommandLine/cli/appDomain";
import { createAppCliSession } from "../../CommandLine/cli/appSession";
import { createLiveAppGateway } from "../../CommandLine/cli/appGateway";

// ---------------------------------------------------------------------------
// A realm that runs the REAL worker shim over the REAL source, in-process.
// ---------------------------------------------------------------------------

type Msg = { t: string; [k: string]: unknown };

class ShimWorker {
  static all: ShimWorker[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  terminated = false;
  spec: MountSpec | null = null;
  private rt: WorkerRuntime | null = null;
  constructor() {
    ShimWorker.all.push(this);
  }
  postMessage(msg: Msg): void {
    if (this.terminated) return;
    if (msg.t === "mount") {
      this.spec = msg.spec as MountSpec;
      setTimeout(() => void this.run(), 0);
    } else if (msg.t === "callResult") {
      this.rt?.settleCall(
        msg.callId as number,
        msg.ok as boolean,
        msg.value,
        msg.error as Parameters<WorkerRuntime["settleCall"]>[3],
      );
    }
  }
  private send(data: Msg): void {
    setTimeout(() => {
      if (!this.terminated) this.onmessage?.({ data } as MessageEvent);
    }, 0);
  }
  private async run(): Promise<void> {
    const spec = this.spec as MountSpec;
    const { context, rt } = buildWorkerContext(spec, (m) => this.send(m as unknown as Msg));
    this.rt = rt;
    try {
      const setup = new Function(`${spec.source}\nreturn typeof setup === "function" ? setup : null;`)() as
        | ((c: unknown) => unknown)
        | null;
      if (setup) await setup(context);
      this.send({ t: "mounted", ok: true });
    } catch (err) {
      this.send({ t: "mounted", ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  terminate(): void {
    this.terminated = true;
  }
}

const g = globalThis as unknown as Record<string, unknown>;
const originalWorker = g.Worker;

// ---------------------------------------------------------------------------
// The application's macros, as the Macro Recorder generated them.
// ---------------------------------------------------------------------------

/** What the recorder saves for "type OWNER-B into A1", object-script target, defaults on. */
const RECORDED_CELLS = generateMacroSource(
  [
    {
      seq: 1,
      sheetIndex: 0,
      event: { kind: "cellWrites", writes: [{ row: 0, col: 0, value: "OWNER-B", invariant: false }] },
    },
  ] as Parameters<typeof generateMacroSource>[0],
  { target: "objectScript", wrapper: "objectScript", name: "Owner B", recordedAt: "T" },
).source;

/** The same macro, also making the cell bold -- outside cell access. */
const RECORDED_FORMATS = RECORDED_CELLS.replace(
  /(await api\.(?:setCellValue|updateCellsBatch)\([^\n]*\n)/,
  "$1    await api.setRangeFormat(0, 0, 0, 0, { bold: true });\n",
);

const OBJECT_SCRIPT = buildMacroDescription({ runtime: "objectScript", actionCount: 1, recordedAt: "T" });

const CELLS: StoredScript = {
  id: "macro-owner-b",
  name: "Owner B",
  description: OBJECT_SCRIPT,
  source: RECORDED_CELLS,
  sourcePackage: "Sales",
};
const FORMATS: StoredScript = {
  id: "macro-owner-b-formats",
  name: "Owner B formats",
  description: OBJECT_SCRIPT,
  source: RECORDED_FORMATS,
  sourcePackage: "Sales",
};

/** Developer > Macros > Run: exactly the call MacroLibraryDialog makes. */
function runFromMacrosDialog(record: StoredScript, source = record.source) {
  return runMacroModule({
    id: record.id,
    name: record.name,
    source,
    description: record.description,
    sourcePackage: record.sourcePackage,
    storedSource: record.source,
    explicitRun: mintExplicitMacroRun("macrosDialog", record.id),
  });
}

/** What the recorded scaffold throws without cell access (follow-up F12). */
const NEEDS_CELL_ACCESS = /needs cell access, and this run has none/;
const restrictedToast = (): boolean => h.toasts.some((t) => NEEDS_CELL_ACCESS.test(t));

let unregister: () => void = () => undefined;

beforeEach(() => {
  h.store.clear();
  h.store.set(CELLS.id, CELLS);
  h.store.set(FORMATS.id, FORMATS);
  h.gate.length = 0;
  h.reports.length = 0;
  h.refuseRunCheck = false;
  h.toasts.length = 0;
  h.writes.length = 0;
  h.undo.length = 0;
  h.door = null;
  h.cells.clear();
  h.slot = null;
  h.slotChanges = [];
  ShimWorker.all = [];
  g.Worker = ShimWorker as unknown as typeof Worker;
  // The Macro Recorder's REAL provider, as its activate() registers it.
  unregister = registerMacroRunProvider({ runMacroByRef });
});
afterEach(() => {
  unregister();
  resetMacroRunProvider();
  hostResetAll();
  g.Worker = originalWorker;
});

describe("fixtures are what the recorder really saves", () => {
  it("the recorded macro is the scaffold that THROWS without context.api", () => {
    expect(RECORDED_CELLS).toContain("if (!context.api) {");
    expect(RECORDED_CELLS).toContain("throw new Error(");
    expect(RECORDED_CELLS).toMatch(NEEDS_CELL_ACCESS);
    expect(RECORDED_CELLS).toContain("await api.setActiveSheet(0);");
    expect(RECORDED_CELLS).toContain("await api.beginBatch(");
    expect(RECORDED_CELLS).toMatch(/"OWNER-B"/);
    expect(RECORDED_FORMATS).toContain("await api.setRangeFormat(0, 0, 0, 0, { bold: true });");
  });
});

describe("you run an approved application's recorded macro: it changes its cell", () => {
  // SABOTAGE: drop `explicitRun: entry.explicitRun,` from runMacroModule's
  // runObjectScriptOnce call (MacroRecorder/lib/macroLibrary.ts) -> the realm is
  // restricted, the recorded scaffold bails out, and nothing is written.
  it("Developer > Macros > Run writes the cell, as ONE undo step, after both gate checks", async () => {
    const result = await runFromMacrosDialog(CELLS);
    expect(result.type, JSON.stringify(result)).toBe("success");
    expect(h.writes, `the macro wrote nothing; toasts: ${JSON.stringify(h.toasts)}`).toEqual([
      [0, 0, "OWNER-B"],
    ]);
    // ONE undo step (F9): the run's savepoint OPENED it, the recorded batch
    // JOINED it, and the run's end committed it.
    expect(h.undo).toEqual(["begin", "join", "commit"]);
    expect(h.slot, "the run left its step open").toBeNull();
    expect(restrictedToast()).toBe(false);
    // The realm kept the restricted tier; only the narrow flag was added.
    expect(ShimWorker.all).toHaveLength(1);
    expect(ShimWorker.all[0].spec?.tier).toBe("restricted");
    expect(ShimWorker.all[0].spec?.explicitRunCells).toBe(true);
    // The Rust gate judged the EXACT stored bytes under the stored id, twice --
    // and was shown the person's claim both times (owner decision B, F3).
    expect(h.gate.map((x) => x.phase)).toEqual(["runCheck", "runAdmitted"]);
    for (const asked of h.gate) {
      expect(asked.artifacts).toEqual([{ id: CELLS.id, source: CELLS.source }]);
      expect(asked.explicitRun).toEqual({ door: "macrosDialog", macroId: CELLS.id });
    }
    // WHAT IT WROTE reached the persistent trail, once, against Rust's grant
    // (F15): Sheet1!A1, the run completed.
    // SABOTAGE: drop the `noteGrantedRunWrite(` line in recordScriptWrite
    // (host.ts) -> the report names no sheet.
    await vi.waitFor(() => expect(h.reports).toHaveLength(1));
    expect(h.reports[0]).toEqual({
      grantId: h.grantSeq,
      completed: true,
      rolledBack: false,
      failedCalls: 0,
      countsCapped: false,
      sheets: [{ sheet: 0, cellsModified: 1, firstRow: 0, lastRow: 0, firstCol: 0, lastCol: 0 }],
    });
  });
});

// ---------------------------------------------------------------------------
// THE OWNER'S F9 PIN (owner decision B; the recommendation, approved): a run
// with cell access that fails part-way is UNDONE as one step -- all or nothing,
// like the module runtime -- and the person is told it stopped and that nothing
// was changed. The macro is the recorder's own scaffold, writing TWO cells and
// throwing before its commit.
// ---------------------------------------------------------------------------

/** What the recorder saves for "type ONE into A1, TWO into A2" -- then a throw before the commit. */
const RECORDED_THROWS = generateMacroSource(
  [
    {
      seq: 1,
      sheetIndex: 0,
      event: { kind: "cellWrites", writes: [{ row: 0, col: 0, value: "ONE", invariant: false }] },
    },
    {
      seq: 2,
      sheetIndex: 0,
      event: { kind: "cellWrites", writes: [{ row: 1, col: 0, value: "TWO", invariant: false }] },
    },
  ] as Parameters<typeof generateMacroSource>[0],
  { target: "objectScript", wrapper: "objectScript", name: "Owner B throws", recordedAt: "T" },
).source.replace(
  "await api.commitBatch();",
  'throw new Error("stopped on purpose after two writes");\n    await api.commitBatch();',
);

const THROWS: StoredScript = {
  id: "macro-owner-b-throws",
  name: "Owner B throws",
  description: OBJECT_SCRIPT,
  source: RECORDED_THROWS,
  sourcePackage: "Sales",
};

describe("a run with cell access that fails part-way is undone as ONE step (F9)", () => {
  // SABOTAGE: in host.ts closeGrantedRunStep, commit a failed run instead of
  // taking it back (skip the `roll_back_to_undo_savepoint` call) -> A1 keeps
  // ONE, A2 keeps TWO, and the message says they could not be undone.
  it("the recorded macro throws after TWO writes: both are taken back, and you are told nothing was changed", async () => {
    expect(RECORDED_THROWS, "fixture: the throw sits after both writes, before the commit").toMatch(
      /"ONE"[\s\S]*"TWO"[\s\S]*stopped on purpose after two writes[\s\S]*commitBatch/,
    );
    h.store.set(THROWS.id, THROWS);
    h.cells.set("0,0", "THE USER'S"); // A1 held a value of the user's before the run

    const result = await runFromMacrosDialog(THROWS);

    // POSITIVE CONTROL: the realm had cell access, and BOTH writes really landed live.
    expect(ShimWorker.all[0].spec?.explicitRunCells).toBe(true);
    expect(h.writes).toEqual([
      [0, 0, "ONE"],
      [1, 0, "TWO"],
    ]);
    // ...and both were taken back: A1 holds the user's value again, A2 nothing.
    expect(h.cells.get("0,0")).toBe("THE USER'S");
    expect(h.cells.has("1,0"), "A2 kept the failed run's write").toBe(false);
    // ONE step, and nothing left of it: the savepoint opened it, the recorded
    // batch joined it, the rollback emptied it, the run's end closed it.
    expect(h.undo).toEqual(["begin", "join", "rollback", "commit"]);
    expect(h.slot).toBeNull();
    // What the person reads.
    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.message).toContain('"Owner B throws" stopped before it finished: stopped on purpose after two writes.');
      expect(result.message).toContain("Every change it had made was undone, so nothing was changed.");
    }
    // The trail says it ran, what it wrote, and that it was taken back.
    await vi.waitFor(() => expect(h.reports).toHaveLength(1));
    expect(h.reports[0]).toMatchObject({
      completed: false,
      rolledBack: true,
      sheets: [{ sheet: 0, cellsModified: 2, firstRow: 0, lastRow: 1, firstCol: 0, lastCol: 0 }],
    });
  });

  it("CONTROL: the same macro WITHOUT the throw keeps both writes, as ONE step", async () => {
    const completes: StoredScript = {
      ...THROWS,
      id: "macro-owner-b-completes",
      source: RECORDED_THROWS.replace('throw new Error("stopped on purpose after two writes");', ""),
    };
    h.store.set(completes.id, completes);
    const result = await runFromMacrosDialog(completes);
    expect(result.type, JSON.stringify(result)).toBe("success");
    expect(h.cells.get("0,0")).toBe("ONE");
    expect(h.cells.get("1,0")).toBe("TWO");
    expect(h.undo).toEqual(["begin", "join", "commit"]);
  });
});

describe("any run a script starts stays restricted", () => {
  // SABOTAGE: make runMacroByRef forward
  // `options.explicitRun ?? mintExplicitMacroRun("macrosDialog", macroId)` ->
  // the run api.runMacro started is granted and the cell is written.
  it("a LOCAL unlocked script's api.runMacro runs the same macro WITHOUT cell access", async () => {
    // The user's own unlocked one-off script: not in the store, so it is local.
    // The macro's scaffold throws without cell access (F12), so the macro --
    // and the script's runMacro call -- FAIL, saying how to get cell access,
    // instead of reporting a run that changed nothing.
    await expect(
      runObjectScriptOnce({
        name: "Driver",
        source: `function setup(context) { return context.api.runMacro("${CELLS.id}"); }\n`,
      }),
    ).rejects.toThrow(NEEDS_CELL_ACCESS);
    // POSITIVE CONTROL: the macro really was started, and really was admitted.
    expect(ShimWorker.all, "the macro's realm was never mounted").toHaveLength(2);
    const macroRealm = ShimWorker.all[1];
    expect(macroRealm.spec?.source).toBe(CELLS.source);
    expect(h.gate.map((x) => x.phase)).toEqual(["runCheck", "runAdmitted"]);
    // ...restricted: no grant flag, so the recorded scaffold found no context.api.
    expect(macroRealm.spec?.tier).toBe("restricted");
    expect(macroRealm.spec?.explicitRunCells).toBeUndefined();
    expect(h.writes, "a script-started run changed a cell").toEqual([]);
    // ...and the Rust gate was shown no person's claim for it (F3), so its run
    // row says it ran restricted, and no write report follows (F15).
    expect(h.gate.map((x) => x.explicitRun)).toEqual([null, null]);
    expect(h.reports).toEqual([]);
  });

  it("CONTROL: the very same macro, run by you right after, does write", async () => {
    await expect(
      runObjectScriptOnce({
        name: "Driver",
        source: `function setup(context) { return context.api.runMacro("${CELLS.id}"); }\n`,
      }),
    ).rejects.toThrow(NEEDS_CELL_ACCESS);
    expect(h.writes).toEqual([]);
    const result = await runFromMacrosDialog(CELLS);
    expect(result.type).toBe("success");
    expect(h.writes).toEqual([[0, 0, "OWNER-B"]]);
  });
});

describe("the command-line door (follow-up F2)", () => {
  // SABOTAGE: drop the pass from appWriters.ts runMacro (call
  // `s.gateway.runMacroByRef(match.id)`) -> the realm is restricted, the
  // scaffold throws, the line fails and nothing is written.
  it("`run Owner B` typed at the command line writes the cell, as ONE undo step", async () => {
    const session = createAppCliSession(createLiveAppGateway());
    const engine = createCliEngine([{ domain: createAppDomain(), session }], "app");
    const lines: Array<{ cls: string; text: string }> = [];
    const io = { print: (text: string, cls?: string) => lines.push({ cls: cls ?? "out", text }), clear: () => undefined };
    const outcome = await engine.executeRun(engine.planRun("run Owner B"), io as never);
    expect(outcome.ok, JSON.stringify(lines)).toBe(true);
    expect(h.writes, `the line wrote nothing; output: ${JSON.stringify(lines)}`).toEqual([[0, 0, "OWNER-B"]]);
    expect(h.undo).toEqual(["begin", "join", "commit"]);
    expect(ShimWorker.all).toHaveLength(1);
    expect(ShimWorker.all[0].spec?.tier).toBe("restricted");
    expect(ShimWorker.all[0].spec?.explicitRunCells).toBe(true);
    // No button: the command line names none, on either of the gate's questions.
    expect(h.gate.map((x) => [x.phase, x.trigger])).toEqual([
      ["runCheck", null],
      ["runAdmitted", null],
    ]);
  });
});

describe("the button door (follow-ups F1 + F6)", () => {
  const TRIGGER = { kind: "buttonControl" as const, sheetIndex: 0, row: 3, col: 1 };

  // F12: the restricted run FAILS saying how to get cell access -- it used to
  // resolve, so the seam (and the Rust run row) said "ran" for a macro that
  // changed nothing.
  // SABOTAGE: restore the scaffold's `context.notify(...); return;` guard
  // (actionCodegen.ts wrapObjectScript) -> the outcome is "ran" again.
  it("a button's run WITHOUT a pass -- any caller that is not a person's gesture -- stays restricted", async () => {
    const outcome = await runMacroByRef(CELLS.id, { requirePackage: "Sales", trigger: TRIGGER });
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.message).toMatch(NEEDS_CELL_ACCESS);
    expect(h.writes).toEqual([]);
  });

  it("a button pass + the verified button trigger writes the cell", async () => {
    const outcome = await runMacroByRef(CELLS.id, {
      requirePackage: "Sales",
      trigger: TRIGGER,
      explicitRun: mintExplicitMacroRun("button", CELLS.id),
    });
    expect(outcome.status).toBe("ran");
    expect(h.writes).toEqual([[0, 0, "OWNER-B"]]);
    // The Rust gate was handed the button on both questions.
    expect(h.gate.map((x) => x.trigger)).toEqual([TRIGGER, TRIGGER]);
  });

  it("a button CELL's pass + its verified buttonCell trigger writes the cell (F6)", async () => {
    const cell = { kind: "buttonCell" as const, sheetIndex: 0, row: 5, col: 2 };
    const outcome = await runMacroByRef(CELLS.id, {
      requirePackage: "Sales",
      trigger: cell,
      explicitRun: mintExplicitMacroRun("button", CELLS.id),
    });
    expect(outcome.status).toBe("ran");
    expect(h.writes).toEqual([[0, 0, "OWNER-B"]]);
    expect(h.gate.map((x) => x.trigger)).toEqual([cell, cell]);
  });
});

// ---------------------------------------------------------------------------
// FROM THE GESTURE: a person's click, through the real button routes, to the
// realm. Only the Rust door's ANSWER and the control's stored metadata are
// doubled on top of the doubles above; the pass is minted where the product
// mints it -- in the gesture handler -- and nowhere in this test.
// ---------------------------------------------------------------------------

describe("a person's click on the application's button runs its recorded macro WITH cell access", () => {
  const STAMP = JSON.stringify({ workspace: "ws", application: "Sales", version: "1.0.0" });

  beforeEach(async () => {
    controlsBackend.set(async <T,>(cmd: string): Promise<T> =>
      (cmd === "get_control_metadata"
        ? {
            controlType: "button",
            properties: {
              text: { valueType: "static", value: "Owner B" },
              heldMacroRef: { valueType: "static", value: CELLS.id },
              heldFrom: { valueType: "static", value: STAMP },
            },
          }
        : null) as T,
    );
    await refreshStyleCache();
  });

  // SABOTAGE: drop the gesture argument from buttonClickInterceptor's
  // executeButtonAction call (Controls/Button/interceptors.ts) -> the realm is
  // restricted, the recorded scaffold bails out, nothing is written.
  it("the in-cell button control: Core's click interceptor -> the door's `link` -> the realm writes", async () => {
    h.door = { kind: "link" };
    await releaseOnTheButton(await buttonClickInterceptor(3, 1, { clientX: 0, clientY: 0 }), 3, 1);
    expect(h.writes, `the click wrote nothing; toasts: ${JSON.stringify(h.toasts)}`).toEqual([[0, 0, "OWNER-B"]]);
    expect(restrictedToast()).toBe(false);
    expect(ShimWorker.all[0].spec?.tier).toBe("restricted");
    expect(ShimWorker.all[0].spec?.explicitRunCells).toBe(true);
    // The button the click named, on both of the gate's questions.
    expect(h.gate.map((x) => x.trigger)).toEqual([TRIGGER_OF(3, 1, "buttonControl"), TRIGGER_OF(3, 1, "buttonControl")]);
  });

  // SABOTAGE: drop the mint from buttonCellType.onClick (CellTypes/types/
  // button.ts) -> restricted, nothing written.
  it("the button CELL: its type's onClick -> the door's `macro` -> the realm writes (F6)", async () => {
    h.door = { kind: "macro", macroId: CELLS.id, application: "Sales" };
    const answer = await buttonCellType.onClick?.({
      row: 5,
      col: 2,
      typeId: "calcula.button",
      params: {},
      event: { clientX: 0, clientY: 0 },
    } as never);
    expect(h.writes, "the button cell ran on the PRESS").toEqual([]);
    await releaseOnTheButton(answer, 5, 2);
    expect(h.writes, `the click wrote nothing; toasts: ${JSON.stringify(h.toasts)}`).toEqual([[0, 0, "OWNER-B"]]);
    expect(restrictedToast()).toBe(false);
    expect(ShimWorker.all[0].spec?.explicitRunCells).toBe(true);
    expect(h.gate.map((x) => x.trigger)).toEqual([TRIGGER_OF(5, 2, "buttonCell"), TRIGGER_OF(5, 2, "buttonCell")]);
  });

  it("CONTROL: the same route reached WITHOUT a person's gesture runs the same macro restricted", async () => {
    h.door = { kind: "link" };
    // What any other caller of the shared click would do: no gesture to hand down.
    await clickButtonControl(0, 3, 1, () => undefined);
    expect(ShimWorker.all, "the macro's realm was never mounted").toHaveLength(1);
    expect(ShimWorker.all[0].spec?.explicitRunCells).toBeUndefined();
    expect(h.writes, "a click no person made changed a cell").toEqual([]);
    expect(restrictedToast(), JSON.stringify(h.toasts)).toBe(true);
  });
});

/** The trigger a click on (row, col) of the active sheet (0) names. */
function TRIGGER_OF(row: number, col: number, kind: "buttonControl" | "buttonCell") {
  return { kind, sheetIndex: 0, row, col };
}

describe("nothing else changes", () => {
  it("a recorded macro that also FORMATS is refused before anything runs, naming the call", async () => {
    const result = await runFromMacrosDialog(FORMATS);
    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.message).toContain("api.setRangeFormat");
      expect(result.message).toContain("Nothing was changed");
    }
    expect(ShimWorker.all, "a realm was mounted for a refused run").toHaveLength(0);
    expect(h.gate).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  it("an application you have NOT approved: the pass is worth nothing", async () => {
    h.refuseRunCheck = true;
    const result = await runFromMacrosDialog(CELLS);
    expect(result.type).toBe("error");
    if (result.type === "error") expect(result.message).toContain("DISTRIBUTED_SCRIPT_NOT_CONSENTED");
    expect(ShimWorker.all).toHaveLength(0);
    expect(h.writes).toEqual([]);
  });

  it("an EDITED application macro is refused, and its pass is spent", async () => {
    const pass = mintExplicitMacroRun("macrosDialog", CELLS.id);
    const result = await runMacroModule({
      id: CELLS.id,
      name: CELLS.name,
      source: CELLS.source.replace("OWNER-B", "EDITED"),
      description: CELLS.description,
      sourcePackage: CELLS.sourcePackage,
      storedSource: CELLS.source,
      explicitRun: pass,
    });
    expect(result.type).toBe("error");
    expect(ShimWorker.all).toHaveLength(0);
    expect(h.writes).toEqual([]);
    expect(claimExplicitMacroRun(pass)).toBeNull();
  });
});
