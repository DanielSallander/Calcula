//! FILENAME: app/src/api/scriptHost/__tests__/explicitRunAdmission.test.ts
// PURPOSE: Owner decision B (2026-09-30) at the one place a realm is admitted.
//          "An APPROVED application macro that the user runs EXPLICITLY ...
//          gets the same CELL access in either runtime ... Standing object
//          scripts, and any run a script starts on its own, stay restricted."
//
//          `admitMount` claims (spends) the person's pass FIRST, runs every gate
//          unchanged, and only then decides cell access; `mountWorker` honours it
//          for the first realm only; "mounted" ends it; a run-only realm wires no
//          hook; and the working-copy standing recheck still runs before every
//          call (the grant is never a way past it).
//
// CONTEXT: Only the Tauri boundary is doubled, the way mountedAfterGatedCalls
//          .test.ts doubles it: the backend door (answering in a LATER task, as
//          real IPC does), the Script Security gate, the capability sync, the
//          toast sink, the grid library's read/write doors and the writeback
//          guard. The realm is a fake Worker that posts each message as its own
//          task, as a MessagePort does.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  gate: [] as Array<{ phase: string; trigger: unknown; explicitRun: unknown }>,
  toasts: [] as { message: string; variant?: string; type?: string }[],
  mountAnswer: { recheckWhileRunning: false } as Record<string, unknown> | null,
  /**
   * How the Rust gate answers a `runAdmitted` question that carries a claim
   * (owner decision B, F3): "grant" (cellAccess + a fresh grantId, as Rust
   * does when everything it sees agrees), "refuse" (cellAccess false), "noId"
   * (cellAccess without a usable grantId), "absent" (an old backend that says
   * nothing about cell access).
   */
  rust: "grant" as "grant" | "refuse" | "noId" | "absent",
  grantSeq: 0,
  /**
   * The run's ONE undo step (owner decision B, follow-up F9), as the backend
   * hears it, in order: "savepoint <ticket|join>", "commit <ticket>",
   * "cancel <ticket>", "rollback <transaction>/<changes>", and every write
   * ("write r,c") so a test can see what landed before the step closed.
   */
  undo: [] as string[],
  /** How `begin_undo_savepoint` answers: open the step, join a caller's, or name no point. */
  savepoint: "open" as "open" | "join" | "unnamed" | "throw",
  /** How `roll_back_to_undo_savepoint` answers. */
  rollBack: "ok" as "ok" | "refuse" | "throw",
  /** The cells a successful rollback says it took back (Rust `takenBackCells`). */
  takenBack: [] as Array<{ sheet: number; row: number; col: number }>,
  /** How `begin_undo_savepoint` explains a missing point, when it does (Rust `refused`). */
  savepointRefused: null as string | null,
  stepSeq: 900,
  /** Every `audit_explicit_run_writes` report the host sent (F15). */
  reports: [] as Array<Record<string, unknown>>,
  reportFails: false,
  /** While set, an active-sheet cell write waits for it (a write in flight). */
  writeGate: null as Promise<void> | null,
  standing: "allow" as "allow" | "refuse",
  refuseRunCheck: false,
  writes: [] as Array<[number, number, string]>,
  reads: [] as Array<[number, number]>,
  /** Every formatting the grid library was asked to apply or clear. */
  formats: [] as string[],
  /** Every sheet the grid library was asked to activate. */
  activations: [] as number[],
  /** Every merge pattern a fill asked the fill engine to repeat. */
  merges: [] as string[],
}));

vi.mock("../../backend", () => ({
  invokeBackend: vi.fn(
    async (cmd: string, args?: { phase?: string; trigger?: unknown; explicitRun?: unknown; report?: unknown }) => {
      if (cmd === "begin_undo_savepoint") {
        await new Promise<void>((r) => setTimeout(r, 1));
        if (h.savepoint === "throw") throw new Error("the undo history is unavailable");
        h.stepSeq += 1;
        const ticket = h.savepoint === "join" ? null : h.stepSeq;
        h.undo.push(`savepoint ${ticket ?? "join"}`);
        return {
          ticket,
          savepoint:
            h.savepoint === "unnamed"
              ? null
              : h.savepoint === "join"
                ? { transaction: 7, changes: 3 }
                : { transaction: h.stepSeq, changes: 0 },
          ...(h.savepoint === "unnamed" && h.savepointRefused ? { refused: h.savepointRefused } : {}),
        };
      }
      if (cmd === "roll_back_to_undo_savepoint") {
        const sp = (args as { savepoint?: { transaction: number; changes: number } } | undefined)?.savepoint;
        h.undo.push(`rollback ${sp?.transaction}/${sp?.changes}`);
        await new Promise<void>((r) => setTimeout(r, 1));
        if (h.rollBack === "throw") throw new Error("the backend went away");
        if (h.rollBack === "refuse") return { success: false, refusal: "the undo step it was recorded in is no longer open", updatedCells: [], refreshDomains: [], activeSheetIndex: 0 };
        return { success: true, refusal: null, updatedCells: [], refreshDomains: [], activeSheetIndex: 0, takenBackCells: h.takenBack };
      }
      if (cmd === "audit_explicit_run_writes") {
        await new Promise<void>((r) => setTimeout(r, 1));
        if (h.reportFails) throw new Error("the trail is unavailable");
        h.reports.push(args?.report as Record<string, unknown>);
        return 1;
      }
      if (cmd !== "check_distributed_mount_consent") return null;
      const phase = args?.phase ?? "(none)";
      h.gate.push({ phase, trigger: args?.trigger ?? null, explicitRun: args?.explicitRun ?? null });
      await new Promise<void>((r) => setTimeout(r, 1));
      if (phase === "runCheck" && h.refuseRunCheck) {
        throw new Error("DISTRIBUTED_SCRIPT_NOT_CONSENTED: this application's code is not approved");
      }
      if (phase === "standing") {
        if (h.standing === "refuse") throw new Error("APPLICATION_CODE_BESIDE_PRIVATE_SHEETS: refused while running");
        return { recheckWhileRunning: true };
      }
      // THE RUST HALF (F3): cell access is answered on `runAdmitted`, for a
      // claim the page showed it, and never otherwise.
      if (phase === "runAdmitted" && args?.explicitRun && h.mountAnswer && h.rust !== "absent") {
        if (h.rust === "refuse") return { ...h.mountAnswer, cellAccess: false, grantId: null };
        if (h.rust === "noId") return { ...h.mountAnswer, cellAccess: true, grantId: null };
        h.grantSeq += 1;
        return { ...h.mountAnswer, cellAccess: true, grantId: h.grantSeq };
      }
      return h.mountAnswer;
    },
  ),
  getWorkbookProperties: vi.fn().mockRejectedValue(new Error("no backend in test")),
  emitTauriEvent: vi.fn().mockResolvedValue(undefined),
  listenTauriEvent: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("../capabilities", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  restoreAndSyncGrants: vi.fn().mockResolvedValue(undefined),
  revokeBackendCapabilities: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../mountGate", () => ({
  assertMountAllowed: vi.fn(async () => undefined),
}));
vi.mock("../../notifications", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  showToast: (message: string, options?: { variant?: string; type?: string }) => {
    h.toasts.push({ message, variant: options?.variant, type: options?.type });
  },
}));
vi.mock("../writebackWriteGuard", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  workbookHasWritebackRegions: async () => false,
  captureWritebackWrite: async () => false,
  captureWritebackWrites: async (_id: string, writes: unknown[]) => ({ plain: writes, drafted: [] }),
}));
vi.mock("../../lib", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getSheets: async () => ({
    sheets: [
      { index: 0, name: "Sheet1" },
      { index: 1, name: "Sheet2" },
    ],
    activeIndex: 0,
  }),
  getActiveSheet: async () => 0,
  getCell: async (row: number, col: number) => {
    h.reads.push([row, col]);
    return { display: "R" };
  },
  updateCell: async (row: number, col: number, value: string) => {
    // A write the test holds open until it releases it.
    if (h.writeGate) await h.writeGate;
    h.writes.push([row, col, value]);
    h.undo.push(`write ${row},${col}`);
    return { cells: [] };
  },
  // An off-sheet write (api.setCellValue with a sheet ref): written there.
  updateCellOnSheets: async (sheets: number[], row: number, col: number, value: string) => {
    h.writes.push([row, col, value]);
    return sheets;
  },
  updateCellsBatch: async (updates: Array<{ row: number; col: number; value: string }>) => {
    for (const u of updates) h.writes.push([u.row, u.col, u.value]);
    return [];
  },
  setActiveSheet: async (index: number) => {
    h.activations.push(index);
    return {
      sheets: [
        { index: 0, name: "Sheet1" },
        { index: 1, name: "Sheet2" },
      ],
      activeIndex: index,
    };
  },
  applyFormatting: async (rows: number[], cols: number[]) => {
    h.formats.push(`apply ${rows.join(",")}x${cols.join(",")}`);
    return { cells: [] };
  },
  applyFormattingToSheets: async (sheets: number[]) => {
    h.formats.push(`apply on sheets ${sheets.join(",")}`);
    return [];
  },
  clearRangeWithOptions: async (sr: number, sc: number, er: number, ec: number, what: string) => {
    h.formats.push(`clear ${what} ${sr},${sc}:${er},${ec}`);
    return { cells: [] };
  },
  // The fill's band and its one undo step.
  getViewportCells: async () => [{ row: 0, col: 0, display: "seed", styleIndex: 2 }],
  getUndoState: async () => ({ transactionOpen: false }),
  beginUndoTransaction: async () => 1,
  commitUndoTransaction: async (ticket?: number | null) => {
    h.undo.push(`commit ${ticket ?? "bare"}`);
  },
  cancelUndoTransaction: async (ticket?: number | null) => {
    h.undo.push(`cancel ${ticket ?? "bare"}`);
  },
}));
// The fill engine is the drag's own; only its merge step (a backend reach) is
// recorded instead of run.
vi.mock("../../../core/lib/fillEngine", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  replicateMergeRegions: async (
    src: { startRow: number; endRow: number },
    target: { startRow: number; endRow: number },
    direction: string,
  ) => {
    h.merges.push(`${direction} ${src.startRow}-${src.endRow} -> ${target.startRow}-${target.endRow}`);
  },
}));
vi.mock("../../grid", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  refreshGridData: vi.fn(),
  refreshGridDimensions: vi.fn(),
}));
vi.mock("../../gridDispatch", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  dispatchGridAction: vi.fn(),
}));

import { mintExplicitMacroRun, type ExplicitMacroRun } from "../../explicitMacroRun";
import {
  explicitRunFormatRefusalMessage,
  explicitRunRefusalMessage,
  runOnlyRefusalMessage,
} from "../explicitRunGrant";
import { listMountedHandles } from "../broker";
import type { HostMountDefinition } from "../host";

// ---------------------------------------------------------------------------
// The fake realm
// ---------------------------------------------------------------------------

type Msg = { t: string; [k: string]: unknown };

class FakeWorker {
  static all: FakeWorker[] = [];
  /** What each new realm does when it is told to mount. Default: settle ok. */
  static onMount: (w: FakeWorker, spec: Record<string, unknown>) => void = (w) => {
    w.send({ t: "mounted", ok: true });
  };
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  terminated = false;
  received: Msg[] = [];
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(msg: Msg): void {
    if (this.terminated) return;
    this.received.push(msg);
    if (msg.t === "mount") FakeWorker.onMount(this, msg.spec as Record<string, unknown>);
  }
  /** The realm posts `data` as its own task (MessagePort ordering). */
  send(data: Msg): void {
    setTimeout(() => {
      if (!this.terminated) this.onmessage?.({ data } as MessageEvent);
    }, 0);
  }
  terminate(): void {
    this.terminated = true;
  }
  mountSpec(): Record<string, unknown> {
    const m = this.received.find((r) => r.t === "mount");
    return (m?.spec ?? {}) as Record<string, unknown>;
  }
  callResult(callId: number): Msg | undefined {
    return this.received.find((r) => r.t === "callResult" && r.callId === callId);
  }
}

const g = globalThis as unknown as Record<string, unknown>;
const originalWorker = g.Worker;

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise<void>((r) => setTimeout(r, 5));
}

const SRC = "function setup(context) {\n  return context.api.setCellValue(0, 0, 'OWNER-B');\n}\n";
let seq = 0;

/** The one-off runner's definition for an application's macro, as it builds it. */
function appRun(overrides: Partial<HostMountDefinition> = {}): HostMountDefinition {
  seq += 1;
  return {
    id: `__calcula_macro_macro-b_test_${seq}`,
    name: "Macro B",
    objectType: "workbook",
    instanceId: null,
    source: SRC,
    accessLevel: "restricted",
    provenance: "distributed",
    packageName: "Sales",
    declaredCapabilities: [],
    consentSurface: "object-script",
    consentArtifacts: [{ id: "macro-b", source: SRC }],
    consentRun: true,
    apiVersion: "1.0.0",
    ...overrides,
  };
}

async function host(): Promise<typeof import("../host")> {
  return import("../host");
}

/** Mount and report what the realm was told and what the host holds. */
async function mount(definition: HostMountDefinition): Promise<{
  spec: Record<string, unknown>;
  handleAtMount: { tier: string; explicitRun?: { cells: boolean } } | undefined;
  worker: FakeWorker;
}> {
  let handleAtMount: { tier: string; explicitRun?: { cells: boolean } } | undefined;
  const previous = FakeWorker.onMount;
  FakeWorker.onMount = (w, spec) => {
    const handle = listMountedHandles().find((x) => x.scriptId === spec.scriptId);
    handleAtMount = handle
      ? { tier: handle.tier, explicitRun: handle.explicitRun ? { ...handle.explicitRun } : undefined }
      : undefined;
    previous(w, spec);
  };
  try {
    await (await host()).hostMountScript(definition);
  } finally {
    FakeWorker.onMount = previous;
  }
  const worker = FakeWorker.all[FakeWorker.all.length - 1];
  return { spec: worker.mountSpec(), handleAtMount, worker };
}

beforeEach(() => {
  h.gate.length = 0;
  h.toasts.length = 0;
  h.writes.length = 0;
  h.reads.length = 0;
  h.formats.length = 0;
  h.activations.length = 0;
  h.merges.length = 0;
  h.mountAnswer = { recheckWhileRunning: false };
  h.rust = "grant";
  h.reports.length = 0;
  h.reportFails = false;
  h.undo.length = 0;
  h.savepoint = "open";
  h.rollBack = "ok";
  h.takenBack = [];
  h.savepointRefused = null;
  h.writeGate = null;
  h.standing = "allow";
  h.refuseRunCheck = false;
  FakeWorker.all = [];
  FakeWorker.onMount = (w) => w.send({ t: "mounted", ok: true });
  g.Worker = FakeWorker as unknown as typeof Worker;
});
afterEach(async () => {
  (await host()).setGrantedRunTurnWaitForTest(null);
  (await host()).hostResetAll();
  g.Worker = originalWorker;
});

// ---------------------------------------------------------------------------

describe("admitMount grants cell access only to a person's run of an approved application macro", () => {
  it("(a) Macros-dialog pass + an application's one-off run -> cell access, tier still restricted", async () => {
    const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
    const { spec, handleAtMount } = await mount(appRun({ explicitRun: pass }));
    expect(spec.explicitRunCells).toBe(true);
    expect(spec.tier).toBe("restricted");
    expect(handleAtMount).toEqual({ tier: "restricted", explicitRun: { cells: true } });
    // Every gate ran, in order: the Rust gate before Script Security and again after it.
    expect(h.gate.map((x) => x.phase)).toEqual(["runCheck", "runAdmitted"]);
  });

  // SABOTAGE (1): replace `explicitRunCellsFor(definition, claimed)` with
  // `definition.consentRun === true && scriptOriginForMount(definition).kind === "package"`
  // -> (b) and (c) are granted without a (valid) pass.
  it("(b) the same run WITHOUT a pass -> no cell access (a script's runMacro)", async () => {
    const { spec, handleAtMount } = await mount(appRun());
    expect(spec.explicitRunCells).toBeUndefined();
    expect(handleAtMount?.explicitRun).toBeUndefined();
    expect(handleAtMount?.tier).toBe("restricted");
  });

  it("(c) a pass for ANOTHER macro, a SPENT pass, a COPIED pass -> no cell access", async () => {
    const other = mintExplicitMacroRun("macrosDialog", "macro-other");
    expect((await mount(appRun({ explicitRun: other }))).spec.explicitRunCells).toBeUndefined();

    const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
    expect((await mount(appRun({ explicitRun: pass }))).spec.explicitRunCells).toBe(true);
    // The same pass on a second run: spent by the first.
    expect((await mount(appRun({ explicitRun: pass }))).spec.explicitRunCells).toBeUndefined();

    const fresh = mintExplicitMacroRun("macrosDialog", "macro-b");
    const copy = structuredClone(fresh) as unknown as ExplicitMacroRun;
    expect((await mount(appRun({ explicitRun: copy }))).spec.explicitRunCells).toBeUndefined();
  });

  it("(d) a run the gate REFUSES spends the pass: it cannot be retried with it", async () => {
    const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
    h.refuseRunCheck = true;
    await expect((await host()).hostMountScript(appRun({ explicitRun: pass }))).rejects.toThrow(
      /DISTRIBUTED_SCRIPT_NOT_CONSENTED/,
    );
    h.refuseRunCheck = false;
    const { spec } = await mount(appRun({ explicitRun: pass }));
    expect(spec.explicitRunCells).toBeUndefined();
  });

  it("(e) the user's OWN macro with a pass -> unlocked as today, no grant flag", async () => {
    const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
    const { spec, handleAtMount } = await mount(
      appRun({
        explicitRun: pass,
        accessLevel: "unlocked",
        provenance: "local",
        packageName: undefined,
        consentArtifacts: undefined,
      }),
    );
    expect(spec.tier).toBe("unlocked");
    expect(spec.explicitRunCells).toBeUndefined();
    expect(handleAtMount?.explicitRun).toBeUndefined();
  });

  it("(f) the door must agree with the trigger", async () => {
    const trigger = { kind: "buttonControl" as const, sheetIndex: 0, row: 1, col: 2 };
    // The button door with no button: a contradiction.
    const noButton = mintExplicitMacroRun("button", "macro-b");
    expect((await mount(appRun({ explicitRun: noButton }))).spec.explicitRunCells).toBeUndefined();
    // The Macros dialog with a button trigger: a contradiction.
    const dialogWithButton = mintExplicitMacroRun("macrosDialog", "macro-b");
    expect(
      (await mount(appRun({ explicitRun: dialogWithButton, consentTrigger: trigger }))).spec.explicitRunCells,
    ).toBeUndefined();
    // The button door with the button the Rust gate verified: granted.
    const button = mintExplicitMacroRun("button", "macro-b");
    h.gate.length = 0;
    const granted = await mount(appRun({ explicitRun: button, consentTrigger: trigger }));
    expect(granted.spec.explicitRunCells).toBe(true);
    expect(h.gate.map((x) => x.trigger)).toEqual([trigger, trigger]);
  });

  // Owner decision B, follow-up F6: a button CELL runs its object-script macro
  // through the same seam, naming itself as a `buttonCell` trigger, which Rust
  // verifies against the cell's action on both questions (`verify_trigger`).
  // SABOTAGE: accept only `buttonControl` for the button door again in
  // explicitRunCellsFor (host.ts) -> the cell's run is not granted, red.
  it("(f2) the button door also agrees with a button CELL's trigger -- and only the button door does", async () => {
    const cell = { kind: "buttonCell" as const, sheetIndex: 1, row: 4, col: 2 };
    const button = mintExplicitMacroRun("button", "macro-b");
    h.gate.length = 0;
    const granted = await mount(appRun({ explicitRun: button, consentTrigger: cell }));
    expect(granted.spec.explicitRunCells).toBe(true);
    // The cell travelled to the Rust gate on BOTH questions.
    expect(h.gate.map((x) => x.trigger)).toEqual([cell, cell]);
    // The Macros dialog with a button cell's trigger: a contradiction.
    const dialog = mintExplicitMacroRun("macrosDialog", "macro-b");
    expect((await mount(appRun({ explicitRun: dialog, consentTrigger: cell }))).spec.explicitRunCells).toBeUndefined();
    // A trigger of a kind no button has is no button: no grant.
    const odd = mintExplicitMacroRun("button", "macro-b");
    expect(
      (
        await mount(
          appRun({ explicitRun: odd, consentTrigger: { ...cell, kind: "shape" } as unknown as typeof cell }),
        )
      ).spec.explicitRunCells,
    ).toBeUndefined();
  });

  it("the grant needs the one-off run's shape: a standing object's realm never gets it", async () => {
    const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
    expect(
      (await mount(appRun({ explicitRun: pass, objectType: "button", instanceId: "btn-1" }))).spec.explicitRunCells,
    ).toBeUndefined();
    const pass2 = mintExplicitMacroRun("macrosDialog", "macro-b");
    expect(
      (
        await mount(
          appRun({
            explicitRun: pass2,
            consentArtifacts: [
              { id: "macro-b", source: SRC },
              { id: "macro-c", source: "x" },
            ],
          }),
        )
      ).spec.explicitRunCells,
    ).toBeUndefined();
    // A realm whose source is NOT the verified artifact's bytes (a composed prelude).
    const pass3 = mintExplicitMacroRun("macrosDialog", "macro-b");
    expect(
      (await mount(appRun({ explicitRun: pass3, source: `/* prelude */\n${SRC}` }))).spec.explicitRunCells,
    ).toBeUndefined();
  });

  // SABOTAGE (6): delete `if (definition.consentRun !== true) return false;` in
  // explicitRunCellsFor -> a STANDING mount (asked once, "mount", no run row)
  // carrying a pass is granted, and this goes red.
  it("(m) the grant needs an explicit RUN: the same definition mounted as a standing mount gets none", async () => {
    const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
    const { spec, handleAtMount } = await mount(appRun({ explicitRun: pass, consentRun: false }));
    // Precondition: it WAS admitted, as a standing mount -- one "mount" question, no run row.
    expect(h.gate.map((x) => x.phase)).toEqual(["mount"]);
    expect(spec.explicitRunCells).toBeUndefined();
    expect(handleAtMount?.explicitRun).toBeUndefined();
    expect(handleAtMount?.tier).toBe("restricted");
  });

  // SABOTAGE (7): delete `if (definition.consentSurface !== "object-script") return false;`
  // in explicitRunCellsFor -> a realm judged on another consent surface (a
  // library, a validator, a chart mark) carrying a pass is granted.
  it("(n) the grant needs the object-script surface: a pass on any other surface is worth nothing", async () => {
    for (const surface of [
      "lib",
      "custom-functions",
      "chart-marks",
      "chart-transforms",
      "writeback-validators",
    ] as const) {
      const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
      h.gate.length = 0;
      const { spec, handleAtMount } = await mount(appRun({ explicitRun: pass, consentSurface: surface }));
      // Precondition: every gate admitted it (the double answers yes to any surface).
      expect(h.gate.map((x) => x.phase), surface).toEqual(["runCheck", "runAdmitted"]);
      expect(spec.explicitRunCells, surface).toBeUndefined();
      expect(handleAtMount?.explicitRun, surface).toBeUndefined();
    }
  });
});

describe("the grant belongs to the first realm and ends with the run", () => {
  // A REMOUNT re-presents the admission it holds -- a debug session opening on
  // the realm, or Stop returning it to its production mount. (A crash no longer
  // does for a run: see (g2).) None of them is a person running the macro again.
  // SABOTAGE (2): delete the `!spentCellGrants.has(admission)` conjunct in
  // mountWorker -> the remounted realm is granted again.
  it("(g) a debug remount re-presents the admission WITHOUT cell access", async () => {
    const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
    const definition = appRun({ explicitRun: pass });
    const { spec } = await mount(definition);
    expect(spec.explicitRunCells, "precondition: the first realm was granted").toBe(true);
    await (await host()).hostStartDebugSession(definition.id);
    await settle();
    expect(FakeWorker.all.length, "the debug session did not remount the realm").toBe(2);
    expect(FakeWorker.all[1].mountSpec().debug, "precondition: the remount is the debug mount").toBeDefined();
    expect(FakeWorker.all[1].mountSpec().explicitRunCells).toBeUndefined();
  });

  // OWNER B FOLLOW-UP F11: a RUN's realm is never respawned. Its `setup` IS the
  // run; a respawn re-ran it with no one starting it and no run row, and could
  // outlive the runner's `finally`. The run is told the crash instead.
  // SABOTAGE: delete the `if (mw.definition.consentRun === true) { ... }` block
  // at the top of crashWorker (host.ts) -> the run realm is respawned (a second
  // worker) and the run is rejected as "superseded", not with the crash.
  it("(g2) a crash DURING a run: not respawned, and the run is rejected with the crash", async () => {
    const h_ = await host();
    FakeWorker.onMount = (w) => {
      // setup never finishes: the realm dies in the middle of it.
      setTimeout(() => w.onerror?.({ message: "boom" }), 2);
    };
    const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
    const definition = appRun({ explicitRun: pass });
    // A run with cell access is taken back whole (F9), so the crash sentence
    // does not send the user to check its cells -- the runner says the outcome.
    await expect(h_.hostMountScript(definition)).rejects.toThrow(h_.describeRunRealmCrash("Macro B", "boom", true));
    expect(h_.describeRunRealmCrash("Macro B", "boom", true)).not.toContain("check the cells");
    expect(h_.describeRunRealmCrash("Macro B", "boom")).toContain("check the cells");
    await settle();
    expect(FakeWorker.all.length, "the run was respawned -- its setup ran again with no one starting it").toBe(1);
    expect(FakeWorker.all[0].terminated, "the crashed realm was not torn down").toBe(true);
    expect(h_.hostIsMounted(definition.id), "a crashed run is still mounted").toBe(false);
    // Reported to whoever started the run, not raised as a standing script's fault.
    expect(h_.listFaultedScripts()).toEqual([]);
  });

  it("(g2b) a crash AFTER the run's setup finished: not respawned either -- nothing outlives the run", async () => {
    const h_ = await host();
    const definition = appRun({ explicitRun: mintExplicitMacroRun("macrosDialog", "macro-b") });
    const { worker } = await mount(definition);
    worker.onerror?.({ message: "late" });
    await settle();
    expect(FakeWorker.all.length, "the finished run was respawned").toBe(1);
    expect(h_.hostIsMounted(definition.id)).toBe(false);
  });

  it("(g3) CONTROL: a STANDING realm still gets its one free respawn after a crash", async () => {
    const { worker } = await mount(appRun({ consentRun: false }));
    worker.onerror?.({ message: "boom" });
    await settle();
    expect(FakeWorker.all.length, "a standing realm lost its respawn").toBe(2);
  });

  // SABOTAGE (3): delete the expiry line in wireWorker's "mounted" -> the call
  // after "mounted" is admitted and writes.
  it("(h) a cell write BEFORE \"mounted\" is admitted; the same write AFTER it is refused", async () => {
    FakeWorker.onMount = (w) => {
      w.send({ t: "call", callId: 1, method: "api.setCellValue", args: [0, 0, "during"] });
      w.send({ t: "mounted", ok: true });
    };
    const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
    const { worker } = await mount(appRun({ explicitRun: pass }));
    await settle();
    expect(worker.callResult(1)?.ok, JSON.stringify(worker.callResult(1))).toBe(true);
    expect(h.writes).toEqual([[0, 0, "during"]]);

    worker.send({ t: "call", callId: 2, method: "api.setCellValue", args: [0, 0, "after"] });
    await settle();
    const late = worker.callResult(2) as { ok: boolean; error?: { code: string; message: string } } | undefined;
    expect(late?.ok).toBe(false);
    expect(late?.error?.code).toBe("PermissionDenied");
    expect(late?.error?.message).toBe(explicitRunRefusalMessage("api.setCellValue"));
    expect(h.writes, "a write after the run reached the grid").toEqual([[0, 0, "during"]]);
  });

  it("(h2) in a WORKING COPY, a call held at the standing gate before \"mounted\" is still admitted", async () => {
    h.mountAnswer = { recheckWhileRunning: true };
    FakeWorker.onMount = (w) => {
      w.send({ t: "call", callId: 1, method: "api.getCellValue", args: [3, 4] });
      w.send({ t: "mounted", ok: true });
    };
    const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
    const { worker } = await mount(appRun({ explicitRun: pass }));
    await settle();
    expect(h.gate.map((x) => x.phase)).toContain("standing");
    expect(worker.callResult(1)?.ok, JSON.stringify(worker.callResult(1))).toBe(true);
    expect(h.reads).toEqual([[3, 4]]);
  });

  it("CONTROL: an ungranted application run is refused the same write with the OLD sentence", async () => {
    FakeWorker.onMount = (w) => {
      w.send({ t: "call", callId: 1, method: "api.setCellValue", args: [0, 0, "x"] });
      w.send({ t: "mounted", ok: true });
    };
    const { worker } = await mount(appRun());
    await settle();
    const result = worker.callResult(1) as { ok: boolean; error?: { message: string } } | undefined;
    expect(result?.ok).toBe(false);
    expect(result?.error?.message).toBe("api.setCellValue requires unlocked access; this script is restricted");
    expect(h.writes).toEqual([]);
  });

  it("a method OUTSIDE cell access is refused even while the grant is live", async () => {
    FakeWorker.onMount = (w) => {
      w.send({ t: "call", callId: 1, method: "api.runMacro", args: ["macro-other"] });
      w.send({ t: "mounted", ok: true });
    };
    const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
    const { worker } = await mount(appRun({ explicitRun: pass }));
    await settle();
    const result = worker.callResult(1) as { ok: boolean; error?: { code: string; message: string } } | undefined;
    expect(result?.ok).toBe(false);
    expect(result?.error?.message).toBe(explicitRunRefusalMessage("api.runMacro"));
  });
});

describe("a run-only realm leaves nothing behind", () => {
  // SABOTAGE (4): delete the hookRegistered guard in wireWorker -> the hook is wired.
  it("(i) a hook a granted realm registers is not wired; an ungranted realm's is (control)", async () => {
    const hostModule = await host();
    FakeWorker.onMount = (w) => {
      w.send({ t: "hookRegistered", hook: "onOpen" });
      w.send({ t: "mounted", ok: true });
    };
    const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
    const granted = appRun({ explicitRun: pass });
    await mount(granted);
    await settle();
    expect(hostModule.mountedScriptHasHook(granted.id, "onOpen")).toBe(false);

    const plain = appRun();
    await mount(plain);
    await settle();
    expect(hostModule.mountedScriptHasHook(plain.id, "onOpen")).toBe(true);
  });
});

describe("a granted run cannot point the restricted formatting rows at every sheet", () => {
  // Every restricted sheet.* row is clamped to the LIVE active sheet, and the
  // grant includes api.setActiveSheet. A realm can post broker calls directly
  // (postMessage is not neutered), so the shim having no `context.sheet` for a
  // workbook realm is not the barrier -- the broker is.
  // SABOTAGE (8): empty EXPLICIT_RUN_REFUSED_FORMAT_METHODS (explicitRunGrant.ts)
  // -> the granted realm formats and clears Sheet2 and this goes red.
  it("(l) api.setActiveSheet(1), then sheet.setRangeFormat / clearRangeFormat: refused, nothing formatted", async () => {
    FakeWorker.onMount = (w) => {
      w.send({ t: "call", callId: 1, method: "api.setActiveSheet", args: [1] });
      w.send({ t: "call", callId: 2, method: "sheet.setRangeFormat", args: [0, 0, 0, 0, { bold: true }] });
      w.send({ t: "call", callId: 3, method: "sheet.clearRangeFormat", args: [0, 0, 0, 0] });
      w.send({ t: "mounted", ok: true });
    };
    const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
    const { worker, spec } = await mount(appRun({ explicitRun: pass }));
    await settle();
    expect(spec.explicitRunCells, "precondition: the realm was granted").toBe(true);
    // Precondition: the granted switch itself went through.
    expect(worker.callResult(1)?.ok, JSON.stringify(worker.callResult(1))).toBe(true);
    expect(h.activations).toEqual([1]);
    for (const [callId, method] of [
      [2, "sheet.setRangeFormat"],
      [3, "sheet.clearRangeFormat"],
    ] as Array<[number, string]>) {
      const result = worker.callResult(callId) as
        | { ok: boolean; error?: { code: string; message: string } }
        | undefined;
      expect(result?.ok, method).toBe(false);
      expect(result?.error?.code, method).toBe("PermissionDenied");
      expect(result?.error?.message, method).toBe(explicitRunFormatRefusalMessage(method));
    }
    expect(h.formats, "a granted run formatted a sheet").toEqual([]);
  });

  it("CONTROL: an ungranted application run formats the sheet on screen, as every restricted realm may", async () => {
    FakeWorker.onMount = (w) => {
      w.send({ t: "call", callId: 1, method: "sheet.setRangeFormat", args: [0, 0, 0, 0, { bold: true }] });
      w.send({ t: "call", callId: 2, method: "sheet.clearRangeFormat", args: [0, 0, 0, 0] });
      w.send({ t: "mounted", ok: true });
    };
    const { worker } = await mount(appRun());
    await settle();
    expect(worker.callResult(1)?.ok, JSON.stringify(worker.callResult(1))).toBe(true);
    expect(worker.callResult(2)?.ok, JSON.stringify(worker.callResult(2))).toBe(true);
    expect(h.formats).toEqual(["apply 0x0", "clear formats 0,0:0,0"]);
  });
});

describe("a granted run fills like a module macro: no merges repeated, no FILL_COMPLETED", () => {
  function captureFillCompleted(): { events: unknown[]; stop: () => void } {
    const events: unknown[] = [];
    const listener = (e: Event): void => {
      events.push((e as CustomEvent).detail);
    };
    window.addEventListener("app:fill-completed", listener);
    return { events, stop: () => window.removeEventListener("app:fill-completed", listener) };
  }

  // SABOTAGE (10): pass `{ moduleParity: false }` at the api.fillRange case in
  // executeImpl -> the granted fill repeats the merge step and announces itself
  // (the sparkline listener would create sparkline groups), and this goes red.
  it("(p) a granted realm's api.fillRange writes the cells, and stops there", async () => {
    FakeWorker.onMount = (w) => {
      w.send({ t: "call", callId: 1, method: "api.fillRange", args: [0, 0, 2, 0, { direction: "down" }] });
      w.send({ t: "mounted", ok: true });
    };
    const fills = captureFillCompleted();
    try {
      const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
      const { worker } = await mount(appRun({ explicitRun: pass }));
      await settle();
      expect(worker.callResult(1)?.ok, JSON.stringify(worker.callResult(1))).toBe(true);
      // The module twin's part: the filled cells.
      expect(h.writes).toEqual([
        [1, 0, "seed"],
        [2, 0, "seed"],
      ]);
      expect(h.merges, "a granted fill repeated the band's merges").toEqual([]);
      expect(fills.events, "a granted fill told the sparkline listener").toEqual([]);
    } finally {
      fills.stop();
    }
  });

  it("CONTROL: the user's OWN unlocked script's fill does both, as the drag does", async () => {
    FakeWorker.onMount = (w) => {
      w.send({ t: "call", callId: 1, method: "api.fillRange", args: [0, 0, 2, 0, { direction: "down" }] });
      w.send({ t: "mounted", ok: true });
    };
    const fills = captureFillCompleted();
    try {
      const { worker } = await mount(
        appRun({
          accessLevel: "unlocked",
          provenance: "local",
          packageName: undefined,
          consentArtifacts: undefined,
        }),
      );
      await settle();
      expect(worker.callResult(1)?.ok, JSON.stringify(worker.callResult(1))).toBe(true);
      expect(h.writes).toEqual([
        [1, 0, "seed"],
        [2, 0, "seed"],
      ]);
      expect(h.merges).toEqual(["down 0-0 -> 0-2"]);
      expect(fills.events).toHaveLength(1);
    } finally {
      fills.stop();
    }
  });
});

describe("a granted run cannot hand what it read to another script", () => {
  // SABOTAGE (9): remove "base.callMethod" from RUN_ONLY_REFUSED_METHODS
  // (explicitRunGrant.ts) -> the call reaches callExposed and this goes red.
  it("(o) base.callMethod is refused to a granted realm before it reaches any target", async () => {
    FakeWorker.onMount = (w) => {
      w.send({ t: "call", callId: 1, method: "base.callMethod", args: ["workbook", null, "send", [["secret"]]] });
      w.send({ t: "mounted", ok: true });
    };
    const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
    const { worker } = await mount(appRun({ explicitRun: pass }));
    await settle();
    const result = worker.callResult(1) as { ok: boolean; error?: { code: string; message: string } } | undefined;
    expect(result?.ok).toBe(false);
    expect(result?.error?.code).toBe("PermissionDenied");
    expect(result?.error?.message).toBe(runOnlyRefusalMessage("base.callMethod"));
  });

  it("CONTROL: an ungranted realm's base.callMethod passes the policy and reaches the (empty) target lookup", async () => {
    FakeWorker.onMount = (w) => {
      w.send({ t: "call", callId: 1, method: "base.callMethod", args: ["workbook", null, "send", [["x"]]] });
      w.send({ t: "mounted", ok: true });
    };
    const { worker } = await mount(appRun());
    await settle();
    const result = worker.callResult(1) as { ok: boolean; error?: { code: string; message: string } } | undefined;
    // Nothing exposes "send", so it fails -- but at the TARGET, not at the policy.
    expect(result).toBeDefined();
    expect(result?.error?.message ?? "").not.toBe(runOnlyRefusalMessage("base.callMethod"));
    expect(result?.error?.code).not.toBe("PermissionDenied");
  });
});

describe("the grant is never a way past the working-copy standing recheck", () => {
  // SABOTAGE (5): in handleCall, skip `await standingGate(mw)` when
  // `mw.handle.explicitRun` is set -> the write reaches the grid.
  it("(j) a standing REFUSAL stops a granted realm before its write, and says so", async () => {
    h.mountAnswer = { recheckWhileRunning: true };
    h.standing = "refuse";
    FakeWorker.onMount = (w) => {
      w.send({ t: "call", callId: 1, method: "api.setCellValue", args: [0, 0, "leak"] });
      w.send({ t: "mounted", ok: true });
    };
    const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
    await expect((await host()).hostMountScript(appRun({ explicitRun: pass }))).rejects.toThrow();
    await settle();
    expect(h.writes, "the grant let a write past the private-sheet rule").toEqual([]);
    expect(
      h.toasts.some((t) => t.variant === "error" && /was stopped/.test(t.message)),
      `the refusal was silent: ${JSON.stringify(h.toasts)}`,
    ).toBe(true);
  });
});

describe("(k) the doors that are not a person's never carry a pass", () => {
  const HOST = readFileSync(join(__dirname, "..", "host.ts"), "utf8");
  const code = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const body = (marker: string): string => {
    const start = HOST.indexOf(marker);
    expect(start, `${marker} not found`).toBeGreaterThan(-1);
    return code(HOST.slice(start, HOST.indexOf("\n}\n", start)));
  };

  it("the Object Script Editor's Run/Debug mounts without one", () => {
    expect(body("export async function hostStartModuleScriptDebugSession")).not.toContain("explicitRun");
  });

  it("a script's api.runMacro reaches the provider with the macro id and nothing else", () => {
    const run = body("export async function executeRunMacro(");
    expect(run).toContain("runMacroByRef(resolved.id)");
    expect(run).not.toContain("explicitRun");
  });
});

// ===========================================================================
// OWNER DECISION B, follow-up F3: the Rust gate is SHOWN the person's claim and
// co-decides the grant; the realm gets cell access only when BOTH said yes.
// ===========================================================================

describe("(q) Rust is shown the claim and co-decides the grant (F3)", () => {
  const trigger = { kind: "buttonControl" as const, sheetIndex: 0, row: 1, col: 2 };

  // SABOTAGE: in admitMount, pass `null` instead of `claim` to both
  // requireDistributedMountConsent calls -> Rust is never shown the claim and
  // (q1) goes red (and, against the real gate, nothing is ever granted).
  it("(q1) the claim -- door and macro -- travels on BOTH run questions, and only when the page would grant", async () => {
    const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
    await mount(appRun({ explicitRun: pass }));
    const shown = { door: "macrosDialog", macroId: "macro-b" };
    expect(h.gate.map((x) => [x.phase, x.explicitRun])).toEqual([
      ["runCheck", shown],
      ["runAdmitted", shown],
    ]);

    const button = mintExplicitMacroRun("button", "macro-b");
    h.gate.length = 0;
    await mount(appRun({ explicitRun: button, consentTrigger: trigger }));
    expect(h.gate.map((x) => x.explicitRun)).toEqual([
      { door: "button", macroId: "macro-b" },
      { door: "button", macroId: "macro-b" },
    ]);

    // No claim for a run the page would not grant: no pass (a script's
    // runMacro), another surface, a composed source, a contradiction.
    for (const definition of [
      appRun(),
      appRun({ explicitRun: mintExplicitMacroRun("macrosDialog", "macro-b"), consentSurface: "lib" }),
      appRun({ explicitRun: mintExplicitMacroRun("macrosDialog", "macro-b"), source: `/* prelude */\n${SRC}` }),
      appRun({ explicitRun: mintExplicitMacroRun("macrosDialog", "macro-b"), consentTrigger: trigger }),
    ]) {
      h.gate.length = 0;
      await mount(definition);
      expect(h.gate.map((x) => x.explicitRun), JSON.stringify(definition.consentSurface)).toEqual([null, null]);
    }
  });

  // SABOTAGE: `explicitRunCells: explicitRunCellsFor(definition, claimed)` in
  // admitMount again (Rust's answer ignored) -> every case here is granted.
  it("(q2) Rust's NO is no grant -- and so is a yes with no usable grant id, or an old backend that says nothing", async () => {
    for (const rust of ["refuse", "noId", "absent"] as const) {
      h.rust = rust;
      h.gate.length = 0;
      const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
      const { spec, handleAtMount } = await mount(appRun({ explicitRun: pass }));
      // Precondition: the page's own half held -- the claim was shown.
      expect(h.gate[1]?.explicitRun, rust).toEqual({ door: "macrosDialog", macroId: "macro-b" });
      expect(spec.explicitRunCells, rust).toBeUndefined();
      expect(handleAtMount?.explicitRun, rust).toBeUndefined();
      expect(handleAtMount?.tier, rust).toBe("restricted");
    }
  });
});

// ===========================================================================
// OWNER DECISION B, follow-up F15: what a granted run wrote, per sheet, on the
// persistent trail -- one report, against the grant Rust opened.
// ===========================================================================

describe("(s) what a granted run wrote goes on the persistent trail (F15)", () => {
  // The sheet on screen is the host's own mirror (SHEET_CHANGED); an earlier
  // test switched it. These runs start on Sheet1, as a person's run would.
  beforeEach(async () => {
    const { emitAppEvent, AppEvents } = await import("../../events");
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 0 });
  });

  // SABOTAGE: delete the `endGrantedRun(mw.definition.id, msg.ok);` line in the
  // "mounted" deliver (host.ts) -> the realm (not unmounted here) never
  // reports, and this goes red.
  it("(s1) Sheet1!A1 and Sheet2!B2:B3: ONE report, per sheet, with the bounds, against Rust's grant", async () => {
    FakeWorker.onMount = (w) => {
      w.send({ t: "call", callId: 1, method: "api.setCellValue", args: [0, 0, "a"] });
      w.send({ t: "call", callId: 2, method: "api.setCellValue", args: [1, 1, "b", "Sheet2"] });
      w.send({ t: "call", callId: 3, method: "api.setCellValue", args: [2, 1, "c", 1] });
      w.send({ t: "call", callId: 4, method: "api.setCellValue", args: [1, 1, "b again", "Sheet2"] });
      w.send({ t: "mounted", ok: true });
    };
    const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
    const { worker, spec } = await mount(appRun({ explicitRun: pass }));
    const grantId = h.grantSeq;
    await settle();
    expect(spec.explicitRunCells, "precondition: the realm was granted").toBe(true);
    for (const id of [1, 2, 3, 4]) expect(worker.callResult(id)?.ok, JSON.stringify(worker.callResult(id))).toBe(true);
    expect(h.reports).toEqual([
      {
        grantId,
        completed: true,
        rolledBack: false,
        failedCalls: 0,
        countsCapped: false,
        sheets: [
          { sheet: 0, cellsModified: 1, firstRow: 0, lastRow: 0, firstCol: 0, lastCol: 0 },
          { sheet: 1, cellsModified: 2, firstRow: 1, lastRow: 2, firstCol: 1, lastCol: 1 },
        ],
      },
    ]);
    // Once: the realm's teardown does not report it again.
    (await host()).hostUnmountScript(worker.mountSpec().scriptId as string);
    await settle();
    expect(h.reports).toHaveLength(1);
  });

  it("(s2) CONTROL: an ungranted run -- no pass, or Rust said no -- reports nothing from this door", async () => {
    FakeWorker.onMount = (w) => {
      // A restricted realm may write the sheet on screen.
      w.send({ t: "call", callId: 1, method: "sheet.setCellValue", args: [0, 0, "restricted"] });
      w.send({ t: "mounted", ok: true });
    };
    const { worker } = await mount(appRun());
    await settle();
    expect(worker.callResult(1)?.ok, JSON.stringify(worker.callResult(1))).toBe(true);
    h.rust = "refuse";
    await mount(appRun({ explicitRun: mintExplicitMacroRun("macrosDialog", "macro-b") }));
    await settle();
    expect(h.writes.length, "precondition: the restricted writes happened").toBe(2);
    expect(h.reports).toEqual([]);
  });

  // BUG-0267's order: the grant expires once the calls held at the standing
  // gate were handed on, and the report waits for them.
  it("(s3) in a WORKING COPY, a write held at the standing gate before \"mounted\" is in the report", async () => {
    h.mountAnswer = { recheckWhileRunning: true };
    FakeWorker.onMount = (w) => {
      w.send({ t: "call", callId: 1, method: "api.setCellValue", args: [4, 3, "held"] });
      w.send({ t: "mounted", ok: true });
    };
    const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
    await mount(appRun({ explicitRun: pass }));
    await settle();
    expect(h.gate.map((x) => x.phase), "precondition: the call waited at the standing gate").toContain("standing");
    expect(h.writes).toEqual([[4, 3, "held"]]);
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0].sheets).toEqual([{ sheet: 0, cellsModified: 1, firstRow: 4, lastRow: 4, firstCol: 3, lastCol: 3 }]);
  });

  // SABOTAGE: delete the `noteGrantedRunCallFailed(mw.definition.id);` line in
  // handleCall -> failedCalls reads 0.
  it("(s4) a run that throws is reported as not completed, with its failed calls", async () => {
    FakeWorker.onMount = (w) => {
      w.send({ t: "call", callId: 1, method: "api.setCellValue", args: [0, 0, "half"] });
      // Outside cell access: refused by the broker.
      w.send({ t: "call", callId: 2, method: "api.setRangeFormat", args: [0, 0, 0, 0, { bold: true }] });
      w.send({ t: "mounted", ok: false, error: "boom" });
    };
    const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
    await expect((await host()).hostMountScript(appRun({ explicitRun: pass }))).rejects.toThrow(/boom/);
    await settle();
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({
      completed: false,
      // ...and every change it made was taken back (F9).
      rolledBack: true,
      failedCalls: 1,
      sheets: [{ sheet: 0, cellsModified: 1, firstRow: 0, lastRow: 0, firstCol: 0, lastCol: 0 }],
    });
  });

  // SABOTAGE: make reportGrantedRunWrites swallow the failure silently (drop
  // the console.error and the toast) -> red.
  it("(s5) a report the trail cannot take never fails the run -- and is said, loudly", async () => {
    h.reportFails = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      FakeWorker.onMount = (w) => {
        w.send({ t: "call", callId: 1, method: "api.setCellValue", args: [0, 0, "a"] });
        w.send({ t: "mounted", ok: true });
      };
      const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
      await mount(appRun({ explicitRun: pass })); // resolves: the run happened
      await settle();
      expect(h.writes).toEqual([[0, 0, "a"]]);
      expect(h.reports).toEqual([]);
      expect(
        h.toasts.some((t) => t.type === "warning" && /could not record which cells "Macro B" changed/.test(t.message)),
        JSON.stringify(h.toasts),
      ).toBe(true);
      expect(errors.mock.calls.some((c) => String(c[0]).includes("did not record which cells"))).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });

  // SABOTAGE: delete the `dropGrantedRunWrites();` line in hostResetAll -> the
  // old workbook's writes are reported onto the next one's trail.
  it("(s6) a workbook replaced while the report waits: nothing reaches the next workbook's trail", async () => {
    let release: () => void = () => undefined;
    h.writeGate = new Promise<void>((r) => {
      release = r;
    });
    const warns = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      FakeWorker.onMount = (w) => {
        w.send({ t: "call", callId: 1, method: "api.setCellValue", args: [0, 0, "slow"] });
        w.send({ t: "mounted", ok: true });
      };
      const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
      await mount(appRun({ explicitRun: pass }));
      // The write is still in flight, so the report is still waiting for it.
      expect(h.writes, "precondition: the write had not landed yet").toEqual([]);
      (await host()).hostResetAll();
      release();
      await settle();
      expect(h.writes, "precondition: the write did land").toEqual([[0, 0, "slow"]]);
      expect(h.reports, "a replaced workbook's run was reported onto the next one").toEqual([]);
      expect(warns.mock.calls.some((c) => String(c[0]).includes("was still running when its workbook was replaced"))).toBe(
        true,
      );
    } finally {
      warns.mockRestore();
    }
  });
});

// ===========================================================================
// OWNER DECISION B, follow-up F9 (owner's answer: the recommendation): a
// granted run that fails part-way is UNDONE, all or nothing, like the module
// runtime. Its undo savepoint is marked before the realm runs; when it ends --
// after every call it made has finished -- it is committed as ONE step, or
// taken back to the savepoint, and the runner hears which.
// ===========================================================================

describe("(t) a granted run is ALL OR NOTHING (F9)", () => {
  beforeEach(async () => {
    const { emitAppEvent, AppEvents } = await import("../../events");
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 0 });
  });

  /** The ticket the run's savepoint opened, from the backend's log. */
  function stepTicket(): string {
    const first = h.undo.find((x) => x.startsWith("savepoint "));
    expect(first, `no savepoint was marked: ${JSON.stringify(h.undo)}`).toBeDefined();
    return first!.slice("savepoint ".length);
  }

  // SABOTAGE: in closeGrantedRunStep, commit the step on a failed run too
  // (drop the `roll_back_to_undo_savepoint` call) -> no rollback, the run's two
  // cells stay written, and the ending says it was not taken back.
  it("(t1) a run that throws after TWO writes is taken back to the savepoint marked before it ran -- after both writes landed", async () => {
    let release: () => void = () => undefined;
    h.writeGate = new Promise<void>((r) => {
      release = r;
    });
    FakeWorker.onMount = (w) => {
      h.undo.push("realm runs");
      w.send({ t: "call", callId: 1, method: "api.setCellValue", args: [0, 0, "one"] });
      w.send({ t: "call", callId: 2, method: "api.setCellValue", args: [1, 0, "two"] });
      w.send({ t: "mounted", ok: false, error: "boom after two writes" });
    };
    const h_ = await host();
    const definition = appRun({ explicitRun: mintExplicitMacroRun("macrosDialog", "macro-b") });
    await expect(h_.hostMountScript(definition)).rejects.toThrow(/boom after two writes/);
    await settle();
    // Both writes are still in flight: nothing may be taken back before they
    // land, or they would land AFTER the rollback and stay.
    expect(h.undo.some((x) => x.startsWith("rollback")), JSON.stringify(h.undo)).toBe(false);
    release();
    const end = await h_.hostSettleExplicitRun(definition.id);
    expect(end).toEqual({ completed: false, undoable: true, rolledBack: true, notUndoneBecause: null, othersUndone: 0 });
    const ticket = stepTicket();
    expect(h.undo).toEqual([
      `savepoint ${ticket}`, // BEFORE the realm was told to run
      "realm runs",
      "write 0,0",
      "write 1,0",
      `rollback ${ticket}/0`, // every change since the savepoint
      `commit ${ticket}`, // the run's own step closes, holding nothing of the run's
    ]);
    // The trail says the run was taken back (F15 + F9).
    await settle();
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({ completed: false, rolledBack: true });
    expect(h.reports[0].sheets).toEqual([{ sheet: 0, cellsModified: 2, firstRow: 0, lastRow: 1, firstCol: 0, lastCol: 0 }]);
  });

  it("(t2) CONTROL: a run that completes is committed as ONE step, and nothing is taken back", async () => {
    FakeWorker.onMount = (w) => {
      w.send({ t: "call", callId: 1, method: "api.setCellValue", args: [0, 0, "one"] });
      w.send({ t: "call", callId: 2, method: "api.setCellValue", args: [1, 0, "two"] });
      w.send({ t: "mounted", ok: true });
    };
    const h_ = await host();
    const definition = appRun({ explicitRun: mintExplicitMacroRun("macrosDialog", "macro-b") });
    await h_.hostMountScript(definition);
    const end = await h_.hostSettleExplicitRun(definition.id);
    expect(end).toEqual({ completed: true, undoable: true, rolledBack: false, notUndoneBecause: null, othersUndone: 0 });
    const ticket = stepTicket();
    expect(h.undo).toEqual([`savepoint ${ticket}`, "write 0,0", "write 1,0", `commit ${ticket}`]);
    await settle();
    expect(h.reports[0]).toMatchObject({ completed: true, rolledBack: false });
  });

  // SABOTAGE: in openGrantedRunStep, record a step whose savepoint is null
  // instead of refusing -> the realm is told to run with nothing to return to.
  it("(t3) no point to return to: the run does not start -- nothing ran, nothing changed, and the step it opened is closed", async () => {
    const h_ = await host();
    for (const mode of ["unnamed", "throw"] as const) {
      h.savepoint = mode;
      h.undo.length = 0;
      h.reports.length = 0;
      const before = FakeWorker.all.length;
      const definition = appRun({ explicitRun: mintExplicitMacroRun("macrosDialog", "macro-b") });
      await expect(h_.hostMountScript(definition), mode).rejects.toThrow(/"Macro B" did not start: .*Nothing was changed\./);
      const worker = FakeWorker.all[FakeWorker.all.length - 1];
      expect(FakeWorker.all.length, mode).toBe(before + 1);
      expect(worker.received.some((m) => m.t === "mount"), `${mode}: the realm was told to run`).toBe(false);
      // The one-off runner tears the realm down; the ending says it never had its step.
      h_.hostUnmountScript(definition.id);
      expect(await h_.hostSettleExplicitRun(definition.id)).toEqual({
        completed: false,
        undoable: false,
        rolledBack: false,
        notUndoneBecause: expect.any(String),
        othersUndone: 0,
      });
      if (mode === "unnamed") {
        const ticket = stepTicket();
        expect(h.undo, mode).toEqual([`savepoint ${ticket}`, `cancel ${ticket}`]);
      } else {
        expect(h.undo, mode).toEqual([]);
      }
      await settle();
      // Rust closes the grant; nothing ran, so nothing was written.
      expect(h.reports, mode).toEqual([
        expect.objectContaining({ completed: false, rolledBack: false, sheets: [] }),
      ]);
    }
    expect(h.writes).toEqual([]);
  });

  it("(t4) a run inside a caller's step (a command-line run of several lines) takes back only its own changes and never closes that step", async () => {
    const h_ = await host();
    h.savepoint = "join";
    FakeWorker.onMount = (w) => {
      w.send({ t: "call", callId: 1, method: "api.setCellValue", args: [0, 0, "one"] });
      w.send({ t: "mounted", ok: false, error: "boom" });
    };
    const failed = appRun({ explicitRun: mintExplicitMacroRun("commandLine", "macro-b") });
    await expect(h_.hostMountScript(failed)).rejects.toThrow(/boom/);
    expect(await h_.hostSettleExplicitRun(failed.id)).toMatchObject({ rolledBack: true });
    // The savepoint the caller's step was at, and no commit: the caller closes its step.
    expect(h.undo).toEqual(["savepoint join", "write 0,0", "rollback 7/3"]);

    // The first run's report may still be on its way (the ending does not
    // wait for it); let it land before the next mount asks the gate.
    await settle();
    h.undo.length = 0;
    FakeWorker.onMount = (w) => w.send({ t: "mounted", ok: true });
    const done = appRun({ explicitRun: mintExplicitMacroRun("commandLine", "macro-b") });
    await h_.hostMountScript(done);
    expect(await h_.hostSettleExplicitRun(done.id)).toMatchObject({ completed: true });
    expect(h.undo).toEqual(["savepoint join"]);
  });

  it("(t5) a rollback the backend refuses is SAID: the ending names why, and the run's writes stay ONE step", async () => {
    const h_ = await host();
    for (const mode of ["refuse", "throw"] as const) {
      // The previous run's report may still be on its way (the ending does not
      // wait for it); let it land before the next mount asks the gate.
      await settle();
      h.rollBack = mode;
      h.undo.length = 0;
      FakeWorker.onMount = (w) => {
        w.send({ t: "call", callId: 1, method: "api.setCellValue", args: [0, 0, "one"] });
        w.send({ t: "mounted", ok: false, error: "boom" });
      };
      const definition = appRun({ explicitRun: mintExplicitMacroRun("macrosDialog", "macro-b") });
      await expect(h_.hostMountScript(definition)).rejects.toThrow(/boom/);
      const end = await h_.hostSettleExplicitRun(definition.id);
      expect(end?.rolledBack, mode).toBe(false);
      expect(end?.notUndoneBecause, mode).toMatch(mode === "refuse" ? /no longer open/ : /went away/);
      const ticket = stepTicket();
      expect(h.undo.slice(-2), mode).toEqual([`rollback ${ticket}/0`, `commit ${ticket}`]);
    }
  });

  it("(t6) CONTROL: a run with no cell grant marks no savepoint -- its undo is exactly what it was", async () => {
    FakeWorker.onMount = (w) => {
      w.send({ t: "call", callId: 1, method: "sheet.setCellValue", args: [0, 0, "restricted"] });
      w.send({ t: "mounted", ok: false, error: "boom" });
    };
    const h_ = await host();
    const ungranted = appRun();
    await expect(h_.hostMountScript(ungranted)).rejects.toThrow(/boom/);
    h.rust = "refuse";
    const refused = appRun({ explicitRun: mintExplicitMacroRun("macrosDialog", "macro-b") });
    await expect(h_.hostMountScript(refused)).rejects.toThrow(/boom/);
    await settle();
    expect(h.undo.filter((x) => !x.startsWith("write")), JSON.stringify(h.undo)).toEqual([]);
    expect(await h_.hostSettleExplicitRun(ungranted.id)).toBeNull();
    expect(await h_.hostSettleExplicitRun(refused.id)).toBeNull();
  });

  it("(t7) a granted realm that CRASHES mid-run is taken back too", async () => {
    const h_ = await host();
    FakeWorker.onMount = (w) => {
      w.send({ t: "call", callId: 1, method: "api.setCellValue", args: [0, 0, "one"] });
      setTimeout(() => w.onerror?.({ message: "kaput" }), 5);
    };
    const definition = appRun({ explicitRun: mintExplicitMacroRun("macrosDialog", "macro-b") });
    await expect(h_.hostMountScript(definition)).rejects.toThrow(h_.describeRunRealmCrash("Macro B", "kaput", true));
    expect(await h_.hostSettleExplicitRun(definition.id)).toMatchObject({ completed: false, rolledBack: true });
    const ticket = stepTicket();
    expect(h.undo).toEqual([`savepoint ${ticket}`, "write 0,0", `rollback ${ticket}/0`, `commit ${ticket}`]);
  });

  // =========================================================================
  // REVIEW OF M6b: GRANTED RUNS TAKE TURNS. The backend has ONE open undo
  // slot: a second granted run that marked its savepoint while the first held
  // its step would JOIN that step -- the first run's rollback would take the
  // second's writes back too, and its commit would close the step halfway
  // through the second, which would then report success. (Every release of a
  // button runs, so two quick clicks are two runs.)
  // =========================================================================

  /** Two granted runs of the same macro, mounted together; A's realm first. */
  function twoRuns(): { a: HostMountDefinition; b: HostMountDefinition } {
    return {
      a: appRun({ explicitRun: mintExplicitMacroRun("macrosDialog", "macro-b") }),
      b: appRun({ explicitRun: mintExplicitMacroRun("macrosDialog", "macro-b") }),
    };
  }

  /** The savepoint tickets in the order the backend handed them out. */
  function stepTickets(): string[] {
    return h.undo.filter((x) => x.startsWith("savepoint ")).map((x) => x.slice("savepoint ".length));
  }

  // SABOTAGE: make waitForGrantedRunTurn resolve true at once (or drop the
  // `turn` from openGrantedRunWrites) -> B marks its savepoint inside A's
  // step, before A's write lands, and A's rollback is no longer only A's.
  it("(t8) two granted runs started together: the second marks its savepoint only after the first's step CLOSED, and is never in its rollback", async () => {
    const h_ = await host();
    let release: () => void = () => undefined;
    h.writeGate = new Promise<void>((r) => {
      release = r;
    });
    const { a, b } = twoRuns();
    FakeWorker.onMount = (w, spec) => {
      if (spec.scriptId === a.id) {
        h.undo.push("realm A runs");
        w.send({ t: "call", callId: 1, method: "api.setCellValue", args: [0, 0, "a"] });
        w.send({ t: "mounted", ok: false, error: "boom in A" });
      } else {
        h.undo.push("realm B runs");
        w.send({ t: "call", callId: 1, method: "api.setCellValue", args: [5, 5, "b"] });
        w.send({ t: "mounted", ok: true });
      }
    };
    const mountA = h_.hostMountScript(a);
    const mountB = h_.hostMountScript(b);
    await expect(mountA).rejects.toThrow(/boom in A/);
    await settle();
    // A's write is still in flight, so A has not ended: B waits for its turn.
    expect(stepTickets(), JSON.stringify(h.undo)).toHaveLength(1);
    expect(h.undo).not.toContain("realm B runs");
    release();
    await mountB;
    const endA = await h_.hostSettleExplicitRun(a.id);
    const endB = await h_.hostSettleExplicitRun(b.id);
    expect(endA).toMatchObject({ completed: false, rolledBack: true });
    expect(endB).toMatchObject({ completed: true, rolledBack: false });
    const [ticketA, ticketB] = stepTickets();
    expect(ticketB, "B joined A's step").not.toBe(ticketA);
    expect(h.undo).toEqual([
      `savepoint ${ticketA}`,
      "realm A runs",
      "write 0,0",
      `rollback ${ticketA}/0`, // A's own write -- B had not started
      `commit ${ticketA}`, // A's step CLOSED...
      `savepoint ${ticketB}`, // ...before B marked its own
      "realm B runs",
      "write 5,5",
      `commit ${ticketB}`, // B is its own ONE step
    ]);
  });

  it("(t8b) both complete: two separate steps, each committed by its own run, in the order they started", async () => {
    const h_ = await host();
    let release: () => void = () => undefined;
    h.writeGate = new Promise<void>((r) => {
      release = r;
    });
    const { a, b } = twoRuns();
    FakeWorker.onMount = (w, spec) => {
      const name = spec.scriptId === a.id ? "A" : "B";
      h.undo.push(`realm ${name} runs`);
      w.send({ t: "call", callId: 1, method: "api.setCellValue", args: name === "A" ? [0, 0, "a"] : [5, 5, "b"] });
      w.send({ t: "mounted", ok: true });
    };
    const mountA = h_.hostMountScript(a);
    const mountB = h_.hostMountScript(b);
    await mountA;
    await settle();
    expect(stepTickets(), "B started before A ended").toHaveLength(1);
    release();
    await mountB;
    await h_.hostSettleExplicitRun(a.id);
    await h_.hostSettleExplicitRun(b.id);
    const [ticketA, ticketB] = stepTickets();
    expect(h.undo).toEqual([
      `savepoint ${ticketA}`,
      "realm A runs",
      "write 0,0",
      `commit ${ticketA}`,
      `savepoint ${ticketB}`,
      "realm B runs",
      "write 5,5",
      `commit ${ticketB}`,
    ]);
  });

  // SABOTAGE: drop the `!(await waitForGrantedRunTurn(...))` refusal (wait
  // without a bound) -> B hangs until A ends instead of being refused.
  it("(t9) a turn that never comes: the second run does not start -- nothing ran, nothing changed, no step marked", async () => {
    const h_ = await host();
    h_.setGrantedRunTurnWaitForTest(40);
    let release: () => void = () => undefined;
    h.writeGate = new Promise<void>((r) => {
      release = r;
    });
    const { a, b } = twoRuns();
    FakeWorker.onMount = (w, spec) => {
      h.undo.push(`realm ${spec.scriptId === a.id ? "A" : "B"} runs`);
      w.send({ t: "call", callId: 1, method: "api.setCellValue", args: [0, 0, "a"] });
      w.send({ t: "mounted", ok: true });
    };
    const mountA = h_.hostMountScript(a);
    await mountA; // A's write hangs: A never ends while it does
    await expect(h_.hostMountScript(b)).rejects.toThrow(
      /^"Macro B" did not start: .*another macro you started with cell access had not finished.*Nothing was changed\.$/,
    );
    expect(h.undo).not.toContain("realm B runs");
    expect(stepTickets(), "B marked a savepoint").toHaveLength(1);
    h_.hostUnmountScript(b.id);
    expect(await h_.hostSettleExplicitRun(b.id)).toMatchObject({ completed: false, undoable: false });
    release();
    await h_.hostSettleExplicitRun(a.id);
    // Both runs' reports are sent after their endings: let them land here.
    await settle();
  });

  // =========================================================================
  // REVIEW OF M6b: WHAT ELSE A ROLLBACK TOOK BACK. It takes back everything
  // recorded after the savepoint -- a cell the person typed meanwhile too.
  // The backend names every cell it took back; those that are not the run's
  // own writes are counted, for the person and for the trail.
  // =========================================================================

  // SABOTAGE: make countOthersUndone return 0 -> the ending and the report
  // say nothing of the cell somebody else wrote.
  it("(t10) a rollback that took back a cell the run never wrote: counted in the ending and on the trail", async () => {
    const h_ = await host();
    h.takenBack = [
      { sheet: 0, row: 0, col: 0 }, // the run's own
      { sheet: 0, row: 1, col: 0 }, // the run's own
      { sheet: 0, row: 7, col: 7 }, // typed by the person while it ran
      { sheet: 1, row: 0, col: 0 }, // another sheet: nothing of the run's there
    ];
    FakeWorker.onMount = (w) => {
      w.send({ t: "call", callId: 1, method: "api.setCellValue", args: [0, 0, "one"] });
      w.send({ t: "call", callId: 2, method: "api.setCellValue", args: [1, 0, "two"] });
      w.send({ t: "mounted", ok: false, error: "boom" });
    };
    const definition = appRun({ explicitRun: mintExplicitMacroRun("macrosDialog", "macro-b") });
    await expect(h_.hostMountScript(definition)).rejects.toThrow(/boom/);
    expect(await h_.hostSettleExplicitRun(definition.id)).toMatchObject({ rolledBack: true, othersUndone: 2 });
    await settle();
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({ completed: false, rolledBack: true, othersUndone: 2 });
  });

  it("(t10b) CONTROL: a rollback of only the run's own writes counts none, and the report carries no count", async () => {
    const h_ = await host();
    h.takenBack = [
      { sheet: 0, row: 0, col: 0 },
      { sheet: 0, row: 1, col: 0 },
    ];
    FakeWorker.onMount = (w) => {
      w.send({ t: "call", callId: 1, method: "api.setCellValue", args: [0, 0, "one"] });
      w.send({ t: "call", callId: 2, method: "api.setCellValue", args: [1, 0, "two"] });
      w.send({ t: "mounted", ok: false, error: "boom" });
    };
    const definition = appRun({ explicitRun: mintExplicitMacroRun("macrosDialog", "macro-b") });
    await expect(h_.hostMountScript(definition)).rejects.toThrow(/boom/);
    expect(await h_.hostSettleExplicitRun(definition.id)).toMatchObject({ rolledBack: true, othersUndone: 0 });
    await settle();
    expect(h.reports[0]).not.toHaveProperty("othersUndone");
  });

  // SABOTAGE: drop the `answer.refused` branch in openGrantedRunStep -> the
  // person reads the generic "could not be named" reason instead.
  it("(t11) Rust's reason for no savepoint (another run holds the step) is the reason the person reads", async () => {
    const h_ = await host();
    h.savepoint = "unnamed";
    h.savepointRefused = "another macro you started holds the open undo step until it ends";
    const definition = appRun({ explicitRun: mintExplicitMacroRun("macrosDialog", "macro-b") });
    await expect(h_.hostMountScript(definition)).rejects.toThrow(
      /did not start: .*\(another macro you started holds the open undo step until it ends\)\. Nothing was changed\./,
    );
  });
});
