//! FILENAME: app/src/api/codeInventory.scheduledJobs.test.ts
// PURPOSE: Unit tests for the scheduled-job half of the workbook code inventory
//          (E2). A recurring job that starts itself is the VBA failure mode this
//          product exists to fix, so these tests pin the two properties that
//          make it shippable: EVERY job is listed (even one whose owning script
//          is gone), and every job is described in terms a user can judge —
//          whose code, what it calls, how often, when next.
// CONTEXT: The inventory is the aggregation point; the panel only renders what
//          this module returns. Kept in its own file so the code-unit tests in
//          codeInventory.test.ts stay focused on residence/reach.

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock every population the aggregator joins ------------------------------
vi.mock("./objectScriptBackend", () => ({
  loadAllObjectScripts: vi.fn(),
}));
vi.mock("./moduleScriptBackend", () => ({
  listModuleScripts: vi.fn(),
  getModuleScript: vi.fn(),
  describeModuleScriptScope: () => "Workbook-global",
}));
vi.mock("./notebookBackend", () => ({
  listNotebooks: vi.fn(),
  loadNotebook: vi.fn(),
}));
vi.mock("./scriptHost/broker", () => ({
  listMountedHandles: vi.fn(),
}));
vi.mock("./chartTransformScripts", () => ({
  loadPersistedTransformLibraryWithProvenance: vi.fn(),
  CHART_TRANSFORMS_SCRIPT_ID: "__calcula_chart_transforms__",
}));
vi.mock("./chartMarkScripts", () => ({
  loadPersistedMarkLibraryWithProvenance: vi.fn(),
  markScriptId: (id: string) => `__chartmark__:${id}`,
}));
vi.mock("./writebackValidators", () => ({
  mountedWritebackValidators: vi.fn(),
}));
vi.mock("./scriptHost/scheduler", () => ({
  listAllScheduledJobs: vi.fn(),
  cancelScheduledJob: vi.fn(),
  setScheduledJobEnabled: vi.fn(),
}));

import { loadAllObjectScripts } from "./objectScriptBackend";
import { listModuleScripts, getModuleScript } from "./moduleScriptBackend";
import { listNotebooks, loadNotebook } from "./notebookBackend";
import { listMountedHandles } from "./scriptHost/broker";
import { loadPersistedTransformLibraryWithProvenance } from "./chartTransformScripts";
import { loadPersistedMarkLibraryWithProvenance } from "./chartMarkScripts";
import { mountedWritebackValidators } from "./writebackValidators";
import { listAllScheduledJobs } from "./scriptHost/scheduler";
import {
  getWorkbookScheduledJobs,
  summarizeScheduledJobs,
  describeJobCadence,
  describeJobTarget,
  describeJobTime,
} from "./codeInventory";

const NOW = 1_800_000_000_000;

/** A Rust `ScheduledJob` row with sane defaults. */
function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "job-1",
    scriptId: "os1",
    surface: "object",
    objectType: "cell",
    instanceId: null,
    handler: "refreshSales",
    cadence: "every",
    intervalSecs: 300,
    minuteOfDay: 0,
    nextRunMs: NOW + 120_000,
    enabled: true,
    label: null,
    running: false,
    runningSinceMs: 0,
    lastRunMs: NOW - 180_000,
    lastOk: true,
    lastError: null,
    runCount: 7,
    ...overrides,
  };
}

function objectScript(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "os1",
    name: "Sales Refresher",
    objectType: "cell",
    instanceId: null,
    source: "function refreshSales() {}",
    accessLevel: "restricted",
    provenance: "local",
    packageName: null,
    declaredCapabilities: ["schedule", "net.fetch"],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (loadAllObjectScripts as any).mockResolvedValue([]);
  (listModuleScripts as any).mockResolvedValue([]);
  (getModuleScript as any).mockResolvedValue(null);
  (listNotebooks as any).mockResolvedValue([]);
  (loadNotebook as any).mockResolvedValue(null);
  (listMountedHandles as any).mockReturnValue([]);
  (loadPersistedTransformLibraryWithProvenance as any).mockResolvedValue(null);
  (loadPersistedMarkLibraryWithProvenance as any).mockResolvedValue(null);
  (mountedWritebackValidators as any).mockReturnValue([]);
  (listAllScheduledJobs as any).mockResolvedValue([]);
});

describe("getWorkbookScheduledJobs", () => {
  it("lists every job joined with the code unit that owns it", async () => {
    (loadAllObjectScripts as any).mockResolvedValue([objectScript()]);
    (listAllScheduledJobs as any).mockResolvedValue([job()]);

    const jobs = await getWorkbookScheduledJobs();

    expect(jobs).toHaveLength(1);
    const j = jobs[0];
    expect(j.id).toBe("job-1");
    expect(j.scriptId).toBe("os1");
    expect(j.ownerName).toBe("Sales Refresher");
    expect(j.ownerMissing).toBe(false);
    expect(j.ownerProvenance).toBe("local");
    expect(j.target).toBe("Calls refreshSales()");
    expect(j.cadence).toBe("Every 5 minutes");
    expect(j.enabled).toBe(true);
    expect(j.runCount).toBe(7);
  });

  it("carries the owning package through, so a distributed schedule is attributable", async () => {
    (loadAllObjectScripts as any).mockResolvedValue([
      objectScript({ provenance: "distributed", packageName: "acme-report" }),
    ]);
    (listAllScheduledJobs as any).mockResolvedValue([job()]);

    const [j] = await getWorkbookScheduledJobs();
    expect(j.ownerProvenance).toBe("distributed");
    expect(j.ownerPackage).toBe("acme-report");
  });

  it("still lists a job whose owning script is gone, flagged as an orphan", async () => {
    (listAllScheduledJobs as any).mockResolvedValue([job({ scriptId: "ghost" })]);

    const [j] = await getWorkbookScheduledJobs();
    expect(j.ownerMissing).toBe(true);
    expect(j.ownerName).toBe("ghost");
    expect(j.ownerProvenance).toBe("unknown");
  });

  it("does NOT call a mounted extension worker's job an orphan", async () => {
    // A sandboxed distributed extension is a script surface, but its code lives
    // in %APPDATA%/extensions, so the code-unit inventory deliberately omits it
    // (see SURFACE_ORDER). It is nonetheless MOUNTED, so its job really does
    // fire — reporting "the owner is gone" would understate what runs, which is
    // the one direction a transparency surface must never be wrong in.
    (listMountedHandles as any).mockReturnValue([
      { scriptId: "ext-1", scriptName: "Acme Sync", origin: "acme-tools" },
    ]);
    (listAllScheduledJobs as any).mockResolvedValue([
      job({ scriptId: "ext-1", surface: "extension-worker" }),
    ]);

    const [j] = await getWorkbookScheduledJobs();
    expect(j.ownerMissing).toBe(false);
    expect(j.ownerName).toBe("Acme Sync");
    expect(j.ownerProvenance).toBe("distributed");
    expect(j.ownerPackage).toBe("acme-tools");
  });

  it("a mounted LOCAL owner that is not a code unit reports no package", async () => {
    (listMountedHandles as any).mockReturnValue([
      { scriptId: "x1", scriptName: "Helper", origin: "local" },
    ]);
    (listAllScheduledJobs as any).mockResolvedValue([job({ scriptId: "x1" })]);

    const [j] = await getWorkbookScheduledJobs();
    expect(j.ownerMissing).toBe(false);
    expect(j.ownerProvenance).toBe("local");
    expect(j.ownerPackage).toBeNull();
  });

  it("a code unit still WINS over a live handle of the same id", async () => {
    // The workbook's own record is the authoritative description of code that
    // resides in the file; the broker handle is only the fallback.
    (loadAllObjectScripts as any).mockResolvedValue([objectScript()]);
    (listMountedHandles as any).mockReturnValue([
      {
        scriptId: "os1",
        scriptName: "WRONG",
        origin: "somepkg",
        tier: "restricted",
        grants: new Set<string>(),
        declaredCapabilities: new Set<string>(),
      },
    ]);
    (listAllScheduledJobs as any).mockResolvedValue([job()]);

    const [j] = await getWorkbookScheduledJobs();
    expect(j.ownerName).toBe("Sales Refresher");
    expect(j.ownerPackage).toBeNull();
  });

  it("describes a connector feed by what it refreshes, not by a method name", async () => {
    (listAllScheduledJobs as any).mockResolvedValue([
      job({ surface: "connector", handler: "crm-source", cadence: "every", intervalSecs: 3600 }),
    ]);

    const [j] = await getWorkbookScheduledJobs();
    expect(j.target).toBe('Refreshes the "crm-source" data connector');
    expect(j.cadence).toBe("Every hour");
  });

  it("sorts soonest first and sinks paused jobs to the bottom", async () => {
    (listAllScheduledJobs as any).mockResolvedValue([
      job({ id: "later", nextRunMs: NOW + 600_000 }),
      job({ id: "paused", enabled: false, nextRunMs: NOW + 1_000 }),
      job({ id: "soon", nextRunMs: NOW + 5_000 }),
    ]);

    const ids = (await getWorkbookScheduledJobs()).map((j) => j.id);
    expect(ids).toEqual(["soon", "later", "paused"]);
  });

  it("uses the caller's inventory when given one (no second scan)", async () => {
    (listAllScheduledJobs as any).mockResolvedValue([job()]);

    const jobs = await getWorkbookScheduledJobs([
      {
        surfaceId: "object-script",
        id: "os1",
        name: "Passed-In Owner",
        residence: "Cell-level script",
        provenance: "local",
        sourcePackage: null,
        declaredCapabilities: [],
        liveGrants: null,
        tier: "restricted",
        mounted: true,
        source: "",
        lineCount: 0,
      },
    ]);

    expect(jobs[0].ownerName).toBe("Passed-In Owner");
    expect(loadAllObjectScripts).not.toHaveBeenCalled();
  });

  it("costs exactly one call when nothing is scheduled", async () => {
    const jobs = await getWorkbookScheduledJobs();
    expect(jobs).toEqual([]);
    expect(listAllScheduledJobs).toHaveBeenCalledTimes(1);
    expect(loadAllObjectScripts).not.toHaveBeenCalled();
  });

  it("reports an empty schedule rather than failing when the backend is unavailable", async () => {
    (listAllScheduledJobs as any).mockRejectedValue(new Error("no backend"));
    await expect(getWorkbookScheduledJobs()).resolves.toEqual([]);
  });
});

describe("describeJobCadence", () => {
  it.each([
    [{ cadence: "every", intervalSecs: 30, minuteOfDay: 0 }, "Every 30 seconds"],
    [{ cadence: "every", intervalSecs: 60, minuteOfDay: 0 }, "Every minute"],
    [{ cadence: "every", intervalSecs: 900, minuteOfDay: 0 }, "Every 15 minutes"],
    [{ cadence: "every", intervalSecs: 3600, minuteOfDay: 0 }, "Every hour"],
    [{ cadence: "every", intervalSecs: 7200, minuteOfDay: 0 }, "Every 2 hours"],
    [{ cadence: "every", intervalSecs: 86400, minuteOfDay: 0 }, "Every day"],
    [{ cadence: "dailyAt", intervalSecs: 0, minuteOfDay: 450 }, "Daily at 07:30"],
    [{ cadence: "dailyAt", intervalSecs: 0, minuteOfDay: 0 }, "Daily at 00:00"],
  ])("%o reads as %s", (input, expected) => {
    expect(describeJobCadence(input as never)).toBe(expected);
  });
});

describe("describeJobTarget", () => {
  it("names the exposed method for an object job", () => {
    expect(describeJobTarget({ surface: "object", handler: "syncNow" })).toBe("Calls syncNow()");
  });
});

describe("describeJobTime", () => {
  it("says 'never' for a job that has not run", () => {
    expect(describeJobTime(0, NOW)).toBe("never");
  });
  it("phrases the future as 'in ...'", () => {
    expect(describeJobTime(NOW + 300_000, NOW)).toBe("in 5 minutes");
    expect(describeJobTime(NOW + 7_200_000, NOW)).toBe("in 2 hours");
  });
  it("phrases the past as '... ago'", () => {
    expect(describeJobTime(NOW - 60_000, NOW)).toBe("1 minute ago");
    expect(describeJobTime(NOW - 172_800_000, NOW)).toBe("2 days ago");
  });
  it("does not pretend to sub-minute precision", () => {
    expect(describeJobTime(NOW + 5_000, NOW)).toBe("in less than a minute");
  });
});

describe("summarizeScheduledJobs", () => {
  it("counts enabled / paused / running / orphaned and the soonest armed run", async () => {
    (loadAllObjectScripts as any).mockResolvedValue([objectScript()]);
    (listAllScheduledJobs as any).mockResolvedValue([
      job({ id: "a", nextRunMs: NOW + 60_000 }),
      job({ id: "b", enabled: false, nextRunMs: NOW + 1_000 }),
      job({ id: "c", running: true, scriptId: "ghost", nextRunMs: NOW + 30_000 }),
    ]);

    const summary = summarizeScheduledJobs(await getWorkbookScheduledJobs());
    expect(summary).toEqual({
      total: 3,
      enabled: 2,
      disabled: 1,
      running: 1,
      orphaned: 1,
      // The PAUSED job is sooner but is not armed, so it must not be reported
      // as "next run" — that would promise something that will not happen.
      nextRunMs: NOW + 30_000,
    });
  });

  it("reports no next run when everything is paused", () => {
    expect(
      summarizeScheduledJobs([
        {
          id: "a",
          scriptId: "os1",
          ownerName: "S",
          ownerMissing: false,
          ownerProvenance: "local",
          ownerPackage: null,
          surface: "object",
          objectType: "cell",
          instanceId: null,
          handler: "h",
          target: "Calls h()",
          cadence: "Every minute",
          label: null,
          enabled: false,
          running: false,
          nextRunMs: NOW,
          lastRunMs: 0,
          lastOk: true,
          lastError: null,
          runCount: 0,
        },
      ]).nextRunMs,
    ).toBeNull();
  });
});
