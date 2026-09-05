//! FILENAME: app/extensions/ScriptableObjects/__tests__/CodeInThisFilePanel.heldPanes.test.tsx
// PURPOSE: The "Held by scripts right now" section renders the SURFACES a
//          script is holding (M2 S7): one row per docked task pane naming the
//          owner, whether it is on screen, how many cells it is bound to and
//          how many updates the script pushed in the last minute; one row for
//          the modal form; and the header chips that count them.
// CONTEXT: The rows are built from values a SCRIPT chooses (its name, its
//          badge), so the one property beyond "the numbers are there" is that
//          every value lands as plain text: a name that looks like markup must
//          render as the characters, never as an element. The inventory that
//          produces the rows is pinned in src/api/codeInventory.scriptPanes.test.ts;
//          this file stubs it and covers the painting only.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const getWorkbookCodeUnits = vi.fn();
vi.mock("@api", () => ({
  getWorkbookCodeUnits: (...args: unknown[]) => getWorkbookCodeUnits(...args),
  summarizeCodeInventory: (units: unknown[]) => ({
    total: units.length,
    local: units.length,
    distributed: 0,
    beyondGrid: 0,
    mounted: 0,
    bySurface: [],
  }),
  getScriptSurface: () => ({ label: "Object scripts", containment: "Worker realm" }),
}));

const getScriptHeldState = vi.fn();
vi.mock("@api/codeInventory", () => ({
  codeUnitMayReachBeyondGrid: () => false,
  describeInterpreterReach: () => "Nothing.",
  getWorkbookScheduledJobs: vi.fn(async () => []),
  cancelScheduledJob: vi.fn(),
  setScheduledJobEnabled: vi.fn(),
  describeJobTime: () => "never",
  summarizeScheduledJobs: () => ({
    total: 0,
    enabled: 0,
    disabled: 0,
    running: 0,
    orphaned: 0,
    nextRunMs: null,
  }),
  getScriptHeldState: (...args: unknown[]) => getScriptHeldState(...(args as [])),
  // Real behaviour, not a stub: the header count and the empty state depend on
  // the roll-up counting panes and forms.
  summarizeScriptHeldState: (s: {
    shortcuts: unknown[];
    clipboards: { cells: number }[];
    watches: { running: boolean }[];
    panes: unknown[];
    forms: unknown[];
  }) => ({
    shortcuts: s.shortcuts.length,
    clipboards: s.clipboards.length,
    clipboardCells: s.clipboards.reduce((n, c) => n + c.cells, 0),
    runningWatches: s.watches.filter((w) => w.running).length,
    panes: s.panes.length,
    forms: s.forms.length,
    any:
      s.shortcuts.length > 0 ||
      s.clipboards.length > 0 ||
      s.watches.length > 0 ||
      s.panes.length > 0 ||
      s.forms.length > 0,
  }),
  revokeScriptKeybinding: vi.fn(),
  clearScriptClipboard: vi.fn(async () => undefined),
  getExtensionAuditTrail: vi.fn(async () => ({
    entries: [],
    total: 0,
    unreadableLines: 0,
    path: "",
    missing: true,
    lastWriteError: "",
  })),
  EXTENSION_AUDIT_ACTION_LABELS: {},
}));

vi.mock("@api/events", () => ({
  emitAppEvent: vi.fn(),
  onAppEvent: () => () => undefined,
}));

vi.mock("../index", () => ({
  ScriptableObjectEvents: {
    SCRIPTS_LOADED: "objectscript:scripts-loaded",
    EDIT_SCRIPT: "objectscript:edit-script",
  },
}));

import { CodeInThisFileSection } from "../components/CodeInThisFilePanel";

const EMPTY = { shortcuts: [], clipboards: [], watches: [], panes: [], forms: [] };

function paneEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paneId: "pane-1",
    scriptId: "form-1",
    ownerName: "Status board",
    ownerMissing: false,
    ownerProvenance: "local",
    ownerPackage: null,
    visible: true,
    placement: "sidebar",
    boundCells: 2,
    updatesLastMinute: 5,
    updateWindowMs: 60_000,
    badge: null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(<CodeInThisFileSection placement="sidebar" />);
  });
}

function paneRow(id: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-script-pane-id="${id}"]`);
  if (!el) throw new Error(`no pane row for ${id}`);
  return el;
}

beforeEach(() => {
  vi.clearAllMocks();
  getWorkbookCodeUnits.mockResolvedValue([]);
  getScriptHeldState.mockResolvedValue(EMPTY);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("CodeInThisFilePanel — held surfaces", () => {
  it("says so when no surface is held, and counts none", async () => {
    await render();
    expect(container.textContent).toContain("Held by scripts right now (0)");
    expect(container.textContent).toContain("a task pane, or a dialog");
    expect(container.querySelector("[data-script-pane-id]")).toBeNull();
    expect(container.querySelector("[data-script-form-id]")).toBeNull();
  });

  it("renders a visible pane with its owner, placement, bound cells and recent updates", async () => {
    getScriptHeldState.mockResolvedValue({ ...EMPTY, panes: [paneEntry()] });
    await render();

    const row = paneRow("pane-1");
    expect(row.textContent).toContain("Task pane");
    expect(row.textContent).toContain("On screen");
    expect(row.textContent).toContain("Docked by Status board in the sidebar.");
    expect(row.textContent).toContain("Bound to 2 cells, watched while it is on screen.");
    expect(row.textContent).toContain("5 updates from the script in the last minute.");
    // The header counts it, and the summary chip says so before the user scrolls.
    expect(container.textContent).toContain("Held by scripts right now (1)");
    expect(container.textContent).toContain("1 task pane docked");
  });

  it("says a hidden pane is not watching its cells, and shows the badge and package", async () => {
    getScriptHeldState.mockResolvedValue({
      ...EMPTY,
      panes: [
        paneEntry({
          visible: false,
          placement: "ribbon",
          boundCells: 1,
          updatesLastMinute: 0,
          badge: "NEW",
          ownerProvenance: "distributed",
          ownerPackage: "acme-status",
        }),
      ],
    });
    await render();

    const row = paneRow("pane-1");
    expect(row.textContent).toContain("Hidden");
    expect(row.textContent).toContain("Task pane (badge: NEW)");
    expect(row.textContent).toContain("Docked by Status board on the ribbon.");
    expect(row.textContent).toContain("Bound to 1 cell; not watched while hidden.");
    expect(row.textContent).toContain("No updates from the script in the last minute.");
    expect(row.textContent).toContain("Package: acme-status");
  });

  it("flags a pane nothing owns rather than dropping it", async () => {
    getScriptHeldState.mockResolvedValue({
      ...EMPTY,
      panes: [paneEntry({ ownerMissing: true, ownerProvenance: "unknown", ownerName: "form-1" })],
    });
    await render();
    expect(paneRow("pane-1").textContent).toContain("Owner missing");
  });

  it("renders the modal form as blocking, with its owner", async () => {
    getScriptHeldState.mockResolvedValue({
      ...EMPTY,
      forms: [
        {
          showId: "show-7",
          scriptId: "form-1",
          ownerName: "Status board",
          ownerMissing: false,
          ownerProvenance: "local",
          ownerPackage: null,
        },
      ],
    });
    await render();
    const row = container.querySelector<HTMLElement>('[data-script-form-id="show-7"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("Dialog form");
    expect(row!.textContent).toContain("Blocking");
    expect(row!.textContent).toContain("Shown by Status board.");
    expect(container.textContent).toContain("a dialog is up");
    expect(container.textContent).toContain("Held by scripts right now (1)");
  });

  it("paints a script-chosen name and badge as TEXT, never as markup", async () => {
    getScriptHeldState.mockResolvedValue({
      ...EMPTY,
      panes: [paneEntry({ ownerName: "<b>bold</b>", badge: "<i>x</i>" })],
    });
    await render();
    const row = paneRow("pane-1");
    expect(row.textContent).toContain("Docked by <b>bold</b>");
    expect(row.textContent).toContain("(badge: <i>x</i>)");
    expect(row.querySelector("b")).toBeNull();
    expect(row.querySelector("i")).toBeNull();
  });
});
