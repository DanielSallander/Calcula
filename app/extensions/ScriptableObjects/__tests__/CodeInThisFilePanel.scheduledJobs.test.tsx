//! FILENAME: app/extensions/ScriptableObjects/__tests__/CodeInThisFilePanel.scheduledJobs.test.tsx
// PURPOSE: Cover the scheduled-job surface of the "Code in This File"
//          transparency panel (E2): every job in the workbook is listed with
//          who owns it, what it calls, its cadence and its next run — and the
//          user can pause or cancel it from there.
// CONTEXT: A self-starting job the user can neither see nor stop is exactly the
//          VBA failure mode Calcula exists to fix, so these are product
//          guarantees, not cosmetics. The empty state is asserted verbatim: a
//          silent, blank section would read as "nothing runs here" whether or
//          not that is true.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// --- The @api barrel the panel reads the code inventory from -----------------
const getWorkbookCodeUnits = vi.fn();
vi.mock("@api", () => ({
  getWorkbookCodeUnits: (...args: unknown[]) => getWorkbookCodeUnits(...args),
  summarizeCodeInventory: (units: unknown[]) => ({
    total: units.length,
    local: units.length,
    distributed: 0,
    beyondGrid: 0,
    mounted: 0,
    bySurface:
      units.length === 0 ? [] : [{ surfaceId: "object-script", units }],
  }),
  getScriptSurface: () => ({
    label: "Object scripts",
    containment: "Worker realm",
  }),
}));

// --- The scheduled-job door (data + the two controls) ------------------------
// Mocked wholesale rather than partially: the real module reaches the backend
// through the scheduler, which a component test must not do. The wording of a
// timestamp is covered by src/api/codeInventory.scheduledJobs.test.ts; here the
// stub returns a marker so the assertions prove the panel hands describeJobTime
// the RIGHT timestamps (last run vs next run), not that it can format them.
const getWorkbookScheduledJobs = vi.fn();
const cancelScheduledJob = vi.fn();
const setScheduledJobEnabled = vi.fn();
vi.mock("@api/codeInventory", () => ({
  getWorkbookScheduledJobs: (...args: unknown[]) => getWorkbookScheduledJobs(...args),
  cancelScheduledJob: (...args: unknown[]) => cancelScheduledJob(...args),
  setScheduledJobEnabled: (...args: unknown[]) => setScheduledJobEnabled(...args),
  describeJobTime: (ms: number) => (ms <= 0 ? "never" : `ts:${ms}`),
  summarizeScheduledJobs: (jobs: { enabled: boolean; running: boolean; ownerMissing: boolean }[]) => ({
    total: jobs.length,
    enabled: jobs.filter((j) => j.enabled).length,
    disabled: jobs.filter((j) => !j.enabled).length,
    running: jobs.filter((j) => j.running).length,
    orphaned: jobs.filter((j) => j.ownerMissing).length,
    nextRunMs: null,
  }),
}));

vi.mock("@api/events", () => ({
  emitAppEvent: vi.fn(),
  onAppEvent: () => () => undefined,
}));

// The panel imports the extension's event-name constants from its index; the
// real module activates the whole extension, which a unit test must not do.
vi.mock("../index", () => ({
  ScriptableObjectEvents: {
    SCRIPTS_LOADED: "objectscript:scripts-loaded",
    EDIT_SCRIPT: "objectscript:edit-script",
  },
}));

import { CodeInThisFileSection } from "../components/CodeInThisFilePanel";

const NOW = Date.now();

function jobEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "job-1",
    scriptId: "os1",
    ownerName: "Sales Refresher",
    ownerMissing: false,
    ownerProvenance: "local",
    ownerPackage: null,
    surface: "object",
    objectType: "cell",
    instanceId: null,
    handler: "refreshSales",
    target: "Calls refreshSales()",
    cadence: "Every 5 minutes",
    label: null,
    enabled: true,
    running: false,
    nextRunMs: NOW + 300_000,
    lastRunMs: NOW - 120_000,
    lastOk: true,
    lastError: null,
    runCount: 4,
    ...overrides,
  };
}

const CODE_UNIT = {
  surfaceId: "object-script",
  id: "os1",
  name: "Sales Refresher",
  residence: "Cell-level script",
  provenance: "local",
  sourcePackage: null,
  declaredCapabilities: [],
  liveGrants: null,
  tier: "restricted",
  mounted: true,
  source: "function refreshSales() {}",
  lineCount: 1,
};

let container: HTMLDivElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(<CodeInThisFileSection placement="sidebar" />);
  });
}

/** Click the button whose visible text matches, within an optional scope. */
async function clickButton(text: string, scope: ParentNode = container): Promise<void> {
  const btn = Array.from(scope.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  );
  if (!btn) throw new Error(`no button labelled "${text}"`);
  await act(async () => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function jobRow(id: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-scheduled-job-id="${id}"]`);
  if (!el) throw new Error(`no job row for ${id}`);
  return el;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  getWorkbookCodeUnits.mockResolvedValue([CODE_UNIT]);
  getWorkbookScheduledJobs.mockResolvedValue([]);
  cancelScheduledJob.mockResolvedValue(true);
  setScheduledJobEnabled.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("CodeInThisFilePanel — scheduled jobs", () => {
  it("says so plainly when nothing is scheduled", async () => {
    await render();
    expect(container.textContent).toContain(
      "No scripts are scheduled to run in this workbook.",
    );
    expect(container.textContent).toContain("Runs automatically (0)");
  });

  it("lists a job with its owner, target, cadence and next run", async () => {
    getWorkbookScheduledJobs.mockResolvedValue([jobEntry()]);
    await render();

    const row = jobRow("job-1");
    expect(row.textContent).toContain("Calls refreshSales()");
    expect(row.textContent).toContain("Sales Refresher");
    expect(row.textContent).toContain("Every 5 minutes");
    expect(row.textContent).toContain(`next run ts:${NOW + 300_000}`);
    expect(row.textContent).toContain(`Last run ts:${NOW - 120_000}`);
    expect(row.textContent).toContain("4 runs");
    // And the header chip counts it, so the panel says "something runs here"
    // before the user scrolls anywhere.
    expect(container.textContent).toContain("1 scheduled");
  });

  it("marks the owning code unit as scheduled", async () => {
    getWorkbookScheduledJobs.mockResolvedValue([jobEntry(), jobEntry({ id: "job-2" })]);
    await render();
    expect(container.textContent).toContain("Scheduled ×2");
  });

  it("surfaces a failed run and an orphaned owner instead of hiding them", async () => {
    getWorkbookScheduledJobs.mockResolvedValue([
      jobEntry({
        ownerMissing: true,
        ownerName: "os-gone",
        ownerProvenance: "unknown",
        lastOk: false,
        lastError: "fetch refused",
      }),
    ]);
    await render();

    const row = jobRow("job-1");
    expect(row.textContent).toContain("Owner missing");
    expect(row.textContent).toContain("Last run failed: fetch refused");
  });

  it("attributes a job whose owner arrived in a package", async () => {
    getWorkbookScheduledJobs.mockResolvedValue([
      jobEntry({ ownerProvenance: "distributed", ownerPackage: "acme-report" }),
    ]);
    await render();
    expect(jobRow("job-1").textContent).toContain("Package: acme-report");
  });

  it("pauses a job and reflects the round-trip", async () => {
    getWorkbookScheduledJobs.mockResolvedValue([jobEntry()]);
    await render();

    // The next read (after the mutation) returns the paused job.
    getWorkbookScheduledJobs.mockResolvedValue([jobEntry({ enabled: false })]);
    await clickButton("Pause", jobRow("job-1"));

    expect(setScheduledJobEnabled).toHaveBeenCalledWith("job-1", false);
    const row = jobRow("job-1");
    expect(row.textContent).toContain("Paused");
    expect(row.textContent).toContain("not scheduled to run again while paused");
    // ... and the control now offers the way back.
    expect(Array.from(row.querySelectorAll("button")).map((b) => b.textContent)).toContain(
      "Resume",
    );
  });

  it("resumes a paused job", async () => {
    getWorkbookScheduledJobs.mockResolvedValue([jobEntry({ enabled: false })]);
    await render();

    getWorkbookScheduledJobs.mockResolvedValue([jobEntry({ enabled: true })]);
    await clickButton("Resume", jobRow("job-1"));

    expect(setScheduledJobEnabled).toHaveBeenCalledWith("job-1", true);
    expect(jobRow("job-1").textContent).not.toContain("Paused");
  });

  it("cancels a job through the scheduler and drops it from the list", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    getWorkbookScheduledJobs.mockResolvedValue([jobEntry()]);
    await render();

    getWorkbookScheduledJobs.mockResolvedValue([]);
    await clickButton("Cancel job", jobRow("job-1"));

    expect(cancelScheduledJob).toHaveBeenCalledWith("job-1");
    expect(container.querySelector('[data-scheduled-job-id="job-1"]')).toBeNull();
    expect(container.textContent).toContain(
      "No scripts are scheduled to run in this workbook.",
    );
    confirm.mockRestore();
  });

  it("does not cancel when the confirmation is declined", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    getWorkbookScheduledJobs.mockResolvedValue([jobEntry()]);
    await render();

    await clickButton("Cancel job", jobRow("job-1"));

    expect(cancelScheduledJob).not.toHaveBeenCalled();
    expect(container.querySelector('[data-scheduled-job-id="job-1"]')).not.toBeNull();
    confirm.mockRestore();
  });

  it("reports a control failure on the row instead of silently doing nothing", async () => {
    getWorkbookScheduledJobs.mockResolvedValue([jobEntry()]);
    await render();

    setScheduledJobEnabled.mockRejectedValue(new Error("scheduler is gone"));
    await clickButton("Pause", jobRow("job-1"));

    expect(jobRow("job-1").textContent).toContain("scheduler is gone");
  });

  it("reports an unreadable schedule rather than implying nothing is scheduled", async () => {
    getWorkbookScheduledJobs.mockRejectedValue(new Error("backend down"));
    await render();

    expect(container.textContent).toContain("Could not read the schedule: backend down");
    expect(container.textContent).not.toContain(
      "No scripts are scheduled to run in this workbook.",
    );
  });
});
