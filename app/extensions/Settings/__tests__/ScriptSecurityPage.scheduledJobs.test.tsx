//! FILENAME: app/extensions/Settings/__tests__/ScriptSecurityPage.scheduledJobs.test.tsx
// PURPOSE: Cover the Scheduled Jobs section of the Script Security settings page
//          (E2). Settings is where a user goes to ask "what is allowed to run?",
//          so it must answer honestly for timer-driven code too — and hand them
//          straight to the surface that can stop it.
// CONTEXT: The schedule lives INSIDE the workbook while everything else on this
//          page is machine-scoped trust, so this section is read-only by design
//          and links to the per-workbook "Code in This File" panel. These tests
//          pin that split: a count and a route, never a second set of controls
//          that could disagree with the panel.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const invokeMock = vi.fn();
vi.mock("@api/backend", () => ({
  invokeBackend: (...args: unknown[]) => invokeMock(...args),
  createVirtualFile: vi.fn(),
  readVirtualFile: vi.fn(async () => {
    throw new Error("none");
  }),
}));

vi.mock("@core/lib/file-api", () => ({ getCurrentFilePath: async () => null }));

// The schedule door. Mocked wholesale: the real module reaches the scheduler
// backend, and the wording of a timestamp is covered by
// src/api/codeInventory.scheduledJobs.test.ts.
const getWorkbookScheduledJobs = vi.fn();
vi.mock("@api/codeInventory", () => ({
  getWorkbookScheduledJobs: (...args: unknown[]) => getWorkbookScheduledJobs(...args),
  describeJobTime: (ms: number) => (ms <= 0 ? "never" : `ts:${ms}`),
}));

const openPanel = vi.fn();
vi.mock("@api/ui", () => ({
  openPanel: (...args: unknown[]) => openPanel(...args),
}));

import { ScriptSecurityPage } from "../components/ScriptSecurityPage";

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

let container: HTMLDivElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(<ScriptSecurityPage />);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  invokeMock.mockResolvedValue(undefined);
  getWorkbookScheduledJobs.mockResolvedValue([]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ScriptSecurityPage — scheduled jobs", () => {
  it("says plainly that nothing is scheduled", async () => {
    await render();
    expect(container.textContent).toContain("Scheduled Jobs");
    expect(container.textContent).toContain(
      "No scripts are scheduled to run in this workbook.",
    );
  });

  it("lists each job with its owner, target, cadence and next run", async () => {
    getWorkbookScheduledJobs.mockResolvedValue([jobEntry()]);
    await render();

    expect(container.textContent).toContain("Sales Refresher");
    expect(container.textContent).toContain("Calls refreshSales()");
    expect(container.textContent).toContain("Every 5 minutes");
    expect(container.textContent).toContain(`next run ts:${NOW + 300_000}`);
    expect(container.textContent).not.toContain(
      "No scripts are scheduled to run in this workbook.",
    );
  });

  it("marks a paused job as paused instead of promising a next run", async () => {
    getWorkbookScheduledJobs.mockResolvedValue([jobEntry({ enabled: false })]);
    await render();

    expect(container.textContent).toContain("paused");
    expect(container.textContent).not.toContain(`next run ts:${NOW + 300_000}`);
  });

  it("flags a job whose owning script is gone", async () => {
    getWorkbookScheduledJobs.mockResolvedValue([jobEntry({ ownerMissing: true })]);
    await render();
    expect(container.textContent).toContain("owner missing");
  });

  it("routes to the panel that owns pause/cancel instead of duplicating them", async () => {
    getWorkbookScheduledJobs.mockResolvedValue([jobEntry()]);
    await render();

    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Review scheduled jobs",
    );
    expect(btn).toBeTruthy();
    await act(async () => {
      btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(openPanel).toHaveBeenCalledWith("scriptable-objects.codeInThisFile");
  });

  it("keeps the rest of the page working when the schedule cannot be read", async () => {
    getWorkbookScheduledJobs.mockRejectedValue(new Error("backend down"));
    await render();
    // The security level picker is the reason this page exists; a schedule read
    // failure must not take it down.
    expect(container.querySelectorAll('input[name="scriptSecurityLevel"]').length).toBeGreaterThan(0);
  });
});
