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
vi.mock("./scriptLibraries", () => ({
  listInstalledLibraries: vi.fn(),
  listLibraryRealms: vi.fn(),
  readLockedSource: vi.fn(),
}));

import { loadAllObjectScripts } from "./objectScriptBackend";
import { listModuleScripts, getModuleScript } from "./moduleScriptBackend";
import { listNotebooks, loadNotebook } from "./notebookBackend";
import { listMountedHandles } from "./scriptHost/broker";
import { loadPersistedTransformLibraryWithProvenance } from "./chartTransformScripts";
import { loadPersistedMarkLibraryWithProvenance } from "./chartMarkScripts";
import { mountedWritebackValidators } from "./writebackValidators";
import {
  listInstalledLibraries,
  listLibraryRealms,
  readLockedSource,
} from "./scriptLibraries";
import {
  getWorkbookCodeUnits,
  summarizeCodeInventory,
  codeUnitReachesBeyondGrid,
  codeUnitMayReachBeyondGrid,
  describeInterpreterReach,
  QUICKJS_SURFACE_REACH,
  QUICKJS_SURFACE_CAPABILITIES,
} from "./codeInventory";

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
  (listInstalledLibraries as any).mockResolvedValue([]);
  (listLibraryRealms as any).mockReturnValue([]);
  (readLockedSource as any).mockResolvedValue("");
});

// ===========================================================================
// Script libraries — third-party code nobody typed into this file
// ===========================================================================

describe("getWorkbookCodeUnits — script libraries", () => {
  const LOCKED = [
    {
      package: "acme.http",
      pin: "^1.0.0",
      resolved: "1.2.0",
      registry: "C:/registry",
      publisherKey: "aa",
      publisherName: "Acme",
      modules: [
        {
          id: "http",
          name: "http",
          sourceHash: "abcdef0123456789",
          artifactSha256: "abcdef0123456789",
          exports: ["post"],
          capabilities: ["net.fetch", "storage"],
          netOrigins: ["https://api.acme.test"],
        },
      ],
      uses: [],
      requiredBy: [],
      installedAt: "2026-08-01T00:00:00Z",
    },
  ];

  it("lists an installed library module with its declared ceiling and its cached location", async () => {
    (listInstalledLibraries as any).mockResolvedValue(LOCKED);
    (readLockedSource as any).mockResolvedValue("// @export post\nfunction library() {}");

    const units = await getWorkbookCodeUnits();
    expect(units).toHaveLength(1);
    const u = units[0];
    expect(u.surfaceId).toBe("script-library");
    expect(u.provenance).toBe("distributed");
    expect(u.sourcePackage).toBe("acme.http");
    // The LOCKED module's own declaration — the un-intersected ceiling.
    expect(u.declaredCapabilities).toEqual(["net.fetch", "storage"]);
    // Nothing mounted: no realm, so no grants and no tier to report.
    expect(u.mounted).toBe(false);
    expect(u.liveGrants).toBeNull();
    // The user can find the bytes outside Calcula.
    expect(u.residence).toContain(".calcula/script-libs/");
    expect(codeUnitReachesBeyondGrid(u)).toBe(true);
  });

  it("shows the INTERSECTED grants of the live realm next to the declared ceiling", async () => {
    (listInstalledLibraries as any).mockResolvedValue(LOCKED);
    (readLockedSource as any).mockResolvedValue("x");
    (listLibraryRealms as any).mockReturnValue([
      {
        scriptId: "__calcula_lib__:acme.http@1.2.0:0011",
        package: "acme.http",
        version: "1.2.0",
        exports: ["post"],
        capabilities: ["storage"], // the consumer never declared net.fetch
        netOrigins: [],
        tier: "restricted",
        consumers: ["os1"],
        dependencies: [],
      },
    ]);

    const u = (await getWorkbookCodeUnits())[0];
    expect(u.mounted).toBe(true);
    expect(u.tier).toBe("restricted");
    // The gap between these two IS the narrowing; both must be visible.
    expect(u.declaredCapabilities).toEqual(["net.fetch", "storage"]);
    expect(u.liveGrants).toEqual(["storage"]);
  });

  it("SHOWS a module whose cached source fails its hash rather than dropping it", async () => {
    (listInstalledLibraries as any).mockResolvedValue(LOCKED);
    (readLockedSource as any).mockRejectedValue(new Error("does not match its recorded hash"));

    const units = await getWorkbookCodeUnits();
    expect(units).toHaveLength(1);
    expect(units[0].source).toContain("could not be verified");
    expect(units[0].source).toContain("does not match its recorded hash");
  });

  it("groups libraries into their own surface, directly after object scripts", async () => {
    (loadAllObjectScripts as any).mockResolvedValue([
      {
        id: "os1",
        name: "Consumer",
        objectType: "cell",
        instanceId: null,
        source: "// @uses http acme.http@^1.0.0",
        accessLevel: "restricted",
        provenance: "local",
        packageName: null,
        declaredCapabilities: ["storage"],
      },
    ]);
    (listInstalledLibraries as any).mockResolvedValue(LOCKED);
    (readLockedSource as any).mockResolvedValue("x");

    const summary = summarizeCodeInventory(await getWorkbookCodeUnits());
    expect(summary.bySurface.map((g) => g.surfaceId)).toEqual([
      "object-script",
      "script-library",
    ]);
    expect(summary.distributed).toBe(1);
  });
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

// ---------------------------------------------------------------------------
// Interpreter-derived reach (closes the "reach is asserted" residual)
// ---------------------------------------------------------------------------
// These assert the CONSUMER behaviour. That the constants themselves match the
// interpreter is proven separately, against the Rust manifest, by
// __tests__/interpreterReachDrift.test.ts — the two together are the chain.

describe("interpreter-derived reach on the Rust-QuickJS surfaces", () => {
  it("a module script carries the one-off surface's derived reach (no capability)", async () => {
    (listModuleScripts as any).mockResolvedValue([
      { id: "m1", name: "Helpers", scope: { type: "workbook" } },
    ]);
    (getModuleScript as any).mockResolvedValue({
      id: "m1",
      name: "Helpers",
      source: "x",
      scope: { type: "workbook" },
      sourcePackage: null,
    });

    const [u] = await getWorkbookCodeUnits();
    expect(u.interpreterReach).toEqual(QUICKJS_SURFACE_REACH["one-off-script"]);
    expect(u.interpreterCapabilities).toEqual([]);
    // "Grid-only" now means BOTH questions answer no — nothing granted, and
    // nothing that could be granted.
    expect(codeUnitReachesBeyondGrid(u)).toBe(false);
    expect(codeUnitMayReachBeyondGrid(u)).toBe(false);
    expect(u.interpreterReach).not.toContain("model");
  });

  it("a notebook with NO grant still reports that it CAN be granted BI reach", async () => {
    // The distinction the panel must not collapse: a notebook holds nothing
    // until the user approves a prompt, but the surface can raise one — so
    // "does it reach beyond the grid" and "could it" have different answers.
    (listNotebooks as any).mockResolvedValue([{ id: "n1", name: "Analysis", cellCount: 1 }]);
    (loadNotebook as any).mockResolvedValue({
      id: "n1",
      name: "Analysis",
      sourcePackage: null,
      cells: [{ id: "c1", source: "model.query" }],
    });

    const [u] = await getWorkbookCodeUnits();
    expect(u.interpreterReach).toContain("model");
    expect(u.interpreterCapabilities).toEqual(QUICKJS_SURFACE_CAPABILITIES["notebook-cell"]);
    expect(u.liveGrants).toEqual([]); // nothing granted yet
    expect(codeUnitReachesBeyondGrid(u)).toBe(false);
    expect(codeUnitMayReachBeyondGrid(u)).toBe(true);
  });

  it("worker-realm units report null interpreter reach (the broker is their story)", async () => {
    (loadAllObjectScripts as any).mockResolvedValue([
      {
        id: "os1",
        name: "Fetcher",
        objectType: "button",
        instanceId: null,
        source: "x",
        declaredCapabilities: ["net.fetch"],
        accessLevel: "restricted",
        provenance: "local",
        packageName: null,
      },
    ]);
    const [u] = await getWorkbookCodeUnits();
    expect(u.interpreterReach).toBeNull();
    expect(u.interpreterCapabilities).toBeNull();
    // A null interpreter ceiling must not swallow the declared one.
    expect(codeUnitMayReachBeyondGrid(u)).toBe(true);
  });

  it("summarizeCodeInventory reports beyondGridCapable >= beyondGrid", async () => {
    (listNotebooks as any).mockResolvedValue([{ id: "n1", name: "A", cellCount: 1 }]);
    (loadNotebook as any).mockResolvedValue({
      id: "n1",
      name: "A",
      sourcePackage: null,
      cells: [{ id: "c1", source: "x" }],
    });
    (listModuleScripts as any).mockResolvedValue([
      { id: "m1", name: "M", scope: { type: "workbook" } },
    ]);
    (getModuleScript as any).mockResolvedValue({
      id: "m1",
      name: "M",
      source: "x",
      scope: { type: "workbook" },
      sourcePackage: null,
    });

    const summary = summarizeCodeInventory(await getWorkbookCodeUnits());
    expect(summary.total).toBe(2);
    expect(summary.beyondGrid).toBe(0);
    expect(summary.beyondGridCapable).toBe(1); // the notebook only
  });

  it("describeInterpreterReach phrases every class, and empty reach honestly", () => {
    expect(describeInterpreterReach([])).toMatch(/bare JavaScript realm/);
    const notebook = describeInterpreterReach(QUICKJS_SURFACE_REACH["notebook-cell"]);
    expect(notebook).toMatch(/^Can touch /);
    expect(notebook).not.toMatch(/undefined/);
    expect(notebook).toMatch(/BI model data/);
    // A one-off script must not be described as reaching the model.
    expect(describeInterpreterReach(QUICKJS_SURFACE_REACH["one-off-script"])).not.toMatch(
      /BI model/,
    );
    // Single-class phrasing must not emit a dangling separator: exactly one
    // clause, no comma list. (The label itself contains "and", so match shape.)
    expect(describeInterpreterReach(["grid"])).toBe(
      "Can touch cell values and formulas (a private copy of the grid).",
    );
    expect(describeInterpreterReach(["grid", "output"])).toMatch(/\) and console and table/);
  });
});

describe("getWorkbookCodeUnits — sandboxed chart libraries", () => {
  it("enumerates each sandboxed transform under its library's declared ceiling + provenance", async () => {
    (loadPersistedTransformLibraryWithProvenance as any).mockResolvedValue({
      lib: {
        transforms: [
          { type: "sandbox:topN", label: "Top N", body: "return data;" },
          { type: "sandbox:smooth", label: "", body: "return data;" },
        ],
        capabilities: ["bi.query"],
      },
      sourcePackage: "acme-report",
    });
    (listMountedHandles as any).mockReturnValue([
      { scriptId: "__calcula_chart_transforms__", tier: "restricted", grants: new Set(["bi.query"]) },
    ]);

    const units = (await getWorkbookCodeUnits()).filter((u) => u.surfaceId === "chart-transform-sandbox");
    expect(units).toHaveLength(2);
    const topN = units.find((u) => u.id === "__calcula_chart_transforms__::sandbox:topN")!;
    expect(topN.name).toBe("Top N");
    expect(topN.declaredCapabilities).toEqual(["bi.query"]);
    expect(topN.provenance).toBe("distributed");
    expect(topN.sourcePackage).toBe("acme-report");
    expect(topN.mounted).toBe(true);
    expect(topN.liveGrants).toEqual(["bi.query"]);
    expect(codeUnitReachesBeyondGrid(topN)).toBe(true);
    // Falls back to the type when label is blank.
    expect(units.find((u) => u.id.endsWith("sandbox:smooth"))!.name).toBe("sandbox:smooth");
  });

  it("enumerates each sandboxed mark as paint-only (no ceiling) with a per-mark mount join", async () => {
    (loadPersistedMarkLibraryWithProvenance as any).mockResolvedValue({
      lib: { marks: [{ markId: "sandbox:radial", label: "Radial", layoutFamily: "radial", body: "ctx.fillRect(0,0,1,1);" }] },
      sourcePackage: null, // locally authored
    });
    (listMountedHandles as any).mockReturnValue([
      { scriptId: "__chartmark__:sandbox:radial", tier: "restricted", grants: new Set() },
    ]);

    const units = (await getWorkbookCodeUnits()).filter((u) => u.surfaceId === "chart-mark");
    expect(units).toHaveLength(1);
    const u = units[0];
    expect(u.id).toBe("__chartmark__:sandbox:radial");
    expect(u.name).toBe("Radial");
    expect(u.declaredCapabilities).toEqual([]); // paint-only
    expect(u.provenance).toBe("local");
    expect(u.mounted).toBe(true);
    expect(codeUnitReachesBeyondGrid(u)).toBe(false);
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

describe("getWorkbookCodeUnits — writeback validators", () => {
  // A publisher-authored predicate the user APPROVED runs on their machine (in
  // the embedded Rust QuickJS realm at submit). Leaving it out of the inventory
  // would be exactly the "hidden code" the transparency vision forbids.
  it("lists an approved validator once per (package, validator), with no reach", async () => {
    (mountedWritebackValidators as any).mockReturnValue([
      {
        regionId: "r1",
        packageName: "acme.budget",
        packageVersion: "1.2.0",
        name: "positive",
        source: "(v) => (v > 0 ? null : 'must be positive')",
        sourceHash: "abc123",
        consented: true,
      },
      // A SECOND region sharing the same predicate must not double-list it.
      {
        regionId: "r2",
        packageName: "acme.budget",
        packageVersion: "1.2.0",
        name: "positive",
        source: "(v) => (v > 0 ? null : 'must be positive')",
        sourceHash: "abc123",
        consented: true,
      },
    ]);

    const units = (await getWorkbookCodeUnits()).filter(
      (u) => u.surfaceId === "writeback-validator",
    );
    expect(units).toHaveLength(1);
    const u = units[0];
    expect(u.id).toBe("acme.budget::positive");
    expect(u.provenance).toBe("distributed");
    expect(u.sourcePackage).toBe("acme.budget");
    // A pure predicate: no ceiling, no grants — so it never counts as reaching
    // beyond grid state.
    expect(u.declaredCapabilities).toEqual([]);
    expect(u.liveGrants).toEqual([]);
    expect(codeUnitReachesBeyondGrid(u)).toBe(false);
    // The source shown is the body that actually runs.
    expect(u.source).toContain("must be positive");
  });

  it("contributes nothing when no validator is approved", async () => {
    const units = await getWorkbookCodeUnits();
    expect(units.filter((u) => u.surfaceId === "writeback-validator")).toHaveLength(0);
  });
});
