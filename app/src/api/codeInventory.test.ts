//! FILENAME: app/src/api/codeInventory.test.ts
// PURPOSE: Unit tests for the unified workbook code inventory (T1). Verifies the
//          aggregator normalizes all three code-residence populations, classifies
//          each into the right ScriptSurface, enforces grid-only ([] capability)
//          for the Rust-QuickJS surfaces, joins live broker grants/tier for
//          mounted object scripts, and rolls up correctly per surface.

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock the four data sources the aggregator joins -------------------------
vi.mock("./objectScriptBackend", () => ({
  loadAllObjectScripts: vi.fn(),
}));
vi.mock("./moduleScriptBackend", () => ({
  listModuleScripts: vi.fn(),
  getModuleScript: vi.fn(),
  describeModuleScriptScope: (scope: { type: string; name?: string }) =>
    scope.type === "sheet" ? `Sheet "${scope.name}"` : "Workbook-global",
}));
vi.mock("./notebookBackend", () => ({
  listNotebooks: vi.fn(),
  loadNotebook: vi.fn(),
}));
vi.mock("./scriptHost/broker", () => ({
  listMountedHandles: vi.fn(),
}));

import { loadAllObjectScripts } from "./objectScriptBackend";
import { listModuleScripts, getModuleScript } from "./moduleScriptBackend";
import { listNotebooks, loadNotebook } from "./notebookBackend";
import { listMountedHandles } from "./scriptHost/broker";
import {
  getWorkbookCodeUnits,
  summarizeCodeInventory,
  codeUnitReachesBeyondGrid,
} from "./codeInventory";

beforeEach(() => {
  vi.clearAllMocks();
  (loadAllObjectScripts as any).mockResolvedValue([]);
  (listModuleScripts as any).mockResolvedValue([]);
  (getModuleScript as any).mockResolvedValue(null);
  (listNotebooks as any).mockResolvedValue([]);
  (loadNotebook as any).mockResolvedValue(null);
  (listMountedHandles as any).mockReturnValue([]);
});

describe("getWorkbookCodeUnits — object scripts", () => {
  it("normalizes an object script with its declared ceiling and provenance", async () => {
    (loadAllObjectScripts as any).mockResolvedValue([
      {
        id: "os1",
        name: "Fetcher",
        objectType: "cell",
        instanceId: null,
        source: "line1\nline2",
        accessLevel: "restricted",
        provenance: "distributed",
        packageName: "acme-report",
        declaredCapabilities: ["net.fetch", "storage"],
      },
    ]);

    const units = await getWorkbookCodeUnits();
    expect(units).toHaveLength(1);
    const u = units[0];
    expect(u.surfaceId).toBe("object-script");
    expect(u.declaredCapabilities).toEqual(["net.fetch", "storage"]);
    expect(u.provenance).toBe("distributed");
    expect(u.sourcePackage).toBe("acme-report");
    expect(u.lineCount).toBe(2);
    expect(u.residence).toContain("Cell");
    expect(codeUnitReachesBeyondGrid(u)).toBe(true);
  });

  it("joins live broker grants + tier when the script is mounted", async () => {
    (loadAllObjectScripts as any).mockResolvedValue([
      {
        id: "os1",
        name: "Live",
        objectType: "chart",
        instanceId: "c-7",
        source: "x",
        accessLevel: "restricted",
        provenance: "local",
        packageName: null,
        declaredCapabilities: ["net.fetch", "bi.query"],
      },
    ]);
    (listMountedHandles as any).mockReturnValue([
      { scriptId: "os1", tier: "unlocked", grants: new Set(["net.fetch"]) },
    ]);

    const [u] = await getWorkbookCodeUnits();
    expect(u.mounted).toBe(true);
    expect(u.tier).toBe("unlocked");
    expect(u.liveGrants).toEqual(["net.fetch"]); // granted subset of the ceiling
    expect(u.declaredCapabilities).toContain("bi.query"); // ceiling > grant
    expect(u.residence).toContain("c-7");
  });

  it("treats a packaged object script as distributed even if provenance is unset", async () => {
    (loadAllObjectScripts as any).mockResolvedValue([
      {
        id: "os2",
        name: "P",
        objectType: "sheet",
        instanceId: null,
        source: "",
        accessLevel: "restricted",
        provenance: undefined,
        packageName: "from-pkg",
        declaredCapabilities: [],
      },
    ]);
    const [u] = await getWorkbookCodeUnits();
    expect(u.provenance).toBe("distributed");
    expect(u.mounted).toBe(false);
    expect(u.liveGrants).toBeNull();
  });
});

describe("getWorkbookCodeUnits — grid-only Rust-QuickJS surfaces", () => {
  it("module scripts are grid-only ([] capabilities) and never mounted", async () => {
    (listModuleScripts as any).mockResolvedValue([
      { id: "m1", name: "Helpers", scope: { type: "sheet", name: "Data" } },
    ]);
    (getModuleScript as any).mockResolvedValue({
      id: "m1",
      name: "Helpers",
      source: "a\nb\nc",
      scope: { type: "sheet", name: "Data" },
      sourcePackage: null,
    });

    const [u] = await getWorkbookCodeUnits();
    expect(u.surfaceId).toBe("one-off-script");
    expect(u.declaredCapabilities).toEqual([]);
    expect(u.liveGrants).toBeNull();
    expect(u.tier).toBeNull();
    expect(u.provenance).toBe("local");
    expect(u.residence).toContain('Sheet "Data"');
    expect(codeUnitReachesBeyondGrid(u)).toBe(false);
  });

  it("notebooks concatenate cell sources and report cell count", async () => {
    (listNotebooks as any).mockResolvedValue([
      { id: "n1", name: "Analysis", cellCount: 2 },
    ]);
    (loadNotebook as any).mockResolvedValue({
      id: "n1",
      name: "Analysis",
      sourcePackage: "stats-pack",
      cells: [
        { id: "c1", source: "first" },
        { id: "c2", source: "second" },
      ],
    });

    const [u] = await getWorkbookCodeUnits();
    expect(u.surfaceId).toBe("notebook-cell");
    expect(u.declaredCapabilities).toEqual([]);
    expect(u.provenance).toBe("distributed");
    expect(u.sourcePackage).toBe("stats-pack");
    expect(u.source).toContain("first");
    expect(u.source).toContain("second");
    expect(u.residence).toContain("2 cells");
  });
});

describe("getWorkbookCodeUnits — resilience", () => {
  it("a failing population does not sink the whole inventory", async () => {
    (loadAllObjectScripts as any).mockRejectedValue(new Error("backend down"));
    (listModuleScripts as any).mockResolvedValue([]);
    (listNotebooks as any).mockResolvedValue([
      { id: "n1", name: "Keep", cellCount: 0 },
    ]);
    (loadNotebook as any).mockResolvedValue({ id: "n1", name: "Keep", cells: [] });

    const units = await getWorkbookCodeUnits();
    expect(units.map((u) => u.id)).toEqual(["n1"]);
  });
});

describe("summarizeCodeInventory", () => {
  it("counts provenance / beyond-grid / mounted and groups by surface order", async () => {
    (loadAllObjectScripts as any).mockResolvedValue([
      {
        id: "os1",
        name: "Net",
        objectType: "cell",
        instanceId: null,
        source: "x",
        accessLevel: "restricted",
        provenance: "local",
        packageName: null,
        declaredCapabilities: ["net.fetch"],
      },
    ]);
    (listModuleScripts as any).mockResolvedValue([
      { id: "m1", name: "Mod", scope: { type: "workbook" } },
    ]);
    (getModuleScript as any).mockResolvedValue({
      id: "m1",
      name: "Mod",
      source: "y",
      scope: { type: "workbook" },
      sourcePackage: "pkg",
    });

    const units = await getWorkbookCodeUnits();
    const summary = summarizeCodeInventory(units);
    expect(summary.total).toBe(2);
    expect(summary.local).toBe(1);
    expect(summary.distributed).toBe(1);
    expect(summary.beyondGrid).toBe(1); // only the net.fetch object script
    expect(summary.mounted).toBe(0);
    // object-script group precedes one-off-script in the canonical order
    expect(summary.bySurface.map((g) => g.surfaceId)).toEqual([
      "object-script",
      "one-off-script",
    ]);
  });
});
