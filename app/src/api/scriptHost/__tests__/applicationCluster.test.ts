//! FILENAME: app/src/api/scriptHost/__tests__/applicationCluster.test.ts
// PURPOSE: Wave 4 — the APPLICATION cluster: api.setStatusBar (with the
//          clear-on-fault discipline), beginBatch({ deferRepaint }) (one
//          refresh at commit, restore on fault), api.runMacro (seam routing +
//          re-entrancy chain refusal), api.userName, and the view/window
//          state family (getViewOption/setViewOption/getZoom/setZoom/
//          getPanes).
// CONTEXT: The executor bodies are exported from host.ts for exactly this
//          test (jsdom cannot spawn a worker realm); the wiring into
//          hostUnmountScript / hostResetAll / scheduleGridDataRefresh is
//          pinned by source scan, the same way calculationControl.test.ts
//          pins the manual-calculation restore.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

vi.mock("../../grid", () => ({
  refreshGridData: vi.fn(),
  refreshGridDimensions: vi.fn(),
  convertFormulaStyle: vi.fn(async (f: string) => f),
  setStatusBarText: vi.fn(),
  clearStatusBarText: vi.fn(),
  getGridStateSnapshot: vi.fn(() => null),
  getViewMode: vi.fn(() => "normal"),
  changeViewMode: vi.fn(),
  getZoom: vi.fn(() => 100),
  setZoomLevel: vi.fn(),
}));
vi.mock("../../../core/lib/cellEvents", () => ({
  cellEvents: { emitBatch: vi.fn() },
  cellToChange: vi.fn((c: unknown) => c),
}));
vi.mock("../../workbookScripts", () => ({
  listWorkbookScripts: vi.fn(async () => []),
}));

import * as grid from "../../grid";
import { listWorkbookScripts } from "../../workbookScripts";
import {
  executeSetStatusBar,
  releaseScriptStatusBar,
  resetStatusBarTracking,
  scriptHoldingStatusBar,
  acquireDeferredRepaint,
  releaseDeferredRepaint,
  resetDeferredRepaint,
  scriptHoldingDeferredRepaint,
  executeRecalculate,
  executeRunMacro,
  resolveMacroRef,
  resetMacroRunTracking,
  executeGetViewOption,
  executeSetViewOption,
  executeGetPanes,
} from "../host";
import {
  registerMacroRunProvider,
  resetMacroRunProvider,
  type MacroRunOutcome,
} from "../../macroRunService";
import { ALLOWLIST } from "../allowlist";
import { AppEvents } from "../../events";
import {
  vStatusBar,
  vBeginBatch,
  vRunMacro,
  vViewOptionGet,
  vViewOptionSet,
  vZoom,
  vNone,
  MAX_STATUS_BAR_CHARS,
  MAX_BATCH_DESCRIPTION_CHARS,
  MAX_MACRO_REF_CHARS,
  SCRIPT_VIEW_OPTIONS,
  SCRIPT_VIEW_MODES,
  ZOOM_PERCENT_MIN,
  ZOOM_PERCENT_MAX,
} from "../validators";

const REPO = path.resolve(__dirname, "../../../../..");
const readRepo = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const hostSrc = readRepo("app/src/api/scriptHost/host.ts");
const contextShims = readRepo("app/src/api/scriptHost/worker/contextShims.ts");
const typings = readRepo("app/extensions/ScriptableObjects/objectContexts.d.ts");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asLib = (l: unknown) => l as any;

/** Let the fire-and-forget release paths land: their dynamic `import("../grid")`
 *  resolves through the module runner on a MACROTASK, so a microtask flush is
 *  not enough — wait out a real timer turn (twice, for chained .then()s). */
const tick = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(async () => {
  resetDeferredRepaint();
  resetStatusBarTracking();
  resetMacroRunTracking();
  resetMacroRunProvider();
  // The two resets above may have scheduled a fire-and-forget clear; let it
  // land BEFORE clearing the mocks, so it is not counted against the test.
  await tick();
  vi.clearAllMocks();
  // Make the coalesced refresh fire SYNCHRONOUSLY so the tests are
  // deterministic: scheduleGridDataRefresh prefers requestAnimationFrame.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const APP_METHODS = [
  "api.setStatusBar",
  "api.runMacro",
  "api.userName",
  "api.getViewOption",
  "api.setViewOption",
  "api.getZoom",
  "api.setZoom",
  "api.getPanes",
];

// ============================================================================
// 0. The 5-file pattern, for every row Wave 4's application cluster added
// ============================================================================

describe("every APPLICATION-cluster method exists in all five places", () => {
  it("has a policy row with real consent text and a validator", () => {
    for (const m of APP_METHODS) {
      const policy = ALLOWLIST[m];
      expect(policy, `${m} has no ALLOWLIST row`).toBeDefined();
      expect(typeof policy.validate, `${m} validator`).toBe("function");
      expect(policy.desc.length, `${m} desc`).toBeGreaterThan(10);
      expect(policy.desc, `${m} desc leaks its id`).not.toContain(m);
      expect(policy.capability, `${m} must need no capability`).toBeUndefined();
      expect(policy.tier, m).toBe("unlocked");
    }
  });

  it("classes reads as reads and view-state changes as mutates", () => {
    expect(ALLOWLIST["api.userName"].class).toBe("read");
    expect(ALLOWLIST["api.userName"].validate).toBe(vNone);
    expect(ALLOWLIST["api.getViewOption"].class).toBe("read");
    expect(ALLOWLIST["api.getZoom"].class).toBe("read");
    expect(ALLOWLIST["api.getPanes"].class).toBe("read");
    expect(ALLOWLIST["api.setStatusBar"].class).toBe("mutate");
    expect(ALLOWLIST["api.runMacro"].class).toBe("mutate");
    expect(ALLOWLIST["api.setViewOption"].class).toBe("mutate");
    expect(ALLOWLIST["api.setZoom"].class).toBe("mutate");
  });

  it("is dispatched by a host executor", () => {
    const hostCases = new Set([...hostSrc.matchAll(/case\s+"([^"]+)"\s*:/g)].map((x) => x[1]));
    for (const m of APP_METHODS) {
      expect(hostCases.has(m), `${m} has no case in executeImpl`).toBe(true);
    }
  });

  it("is reachable from a worker shim", () => {
    const called = new Set(
      [...contextShims.matchAll(/\b(?:call|callFire)\(\s*rt\s*,\s*"([^"]+)"/g)].map((x) => x[1]),
    );
    for (const m of APP_METHODS) {
      expect(called.has(m), `${m} is not called by any shim`).toBe(true);
    }
  });

  it("appears in the GENERATED authoring typings", () => {
    for (const member of [
      "setStatusBar(",
      "runMacro(",
      "userName(",
      "getViewOption(",
      "setViewOption(",
      "getZoom(",
      "setZoom(",
      "getPanes(",
      "deferRepaint",
    ]) {
      expect(typings.includes(member), `${member} missing from objectContexts.d.ts`).toBe(true);
    }
  });

  it("api.beginBatch upgraded to the closed-option validator (not vAny)", () => {
    expect(ALLOWLIST["api.beginBatch"].validate).toBe(vBeginBatch);
  });

  it("declares only limits that vStatusBar actually enforces", () => {
    expect(ALLOWLIST["api.setStatusBar"].limits?.maxChars).toBe(MAX_STATUS_BAR_CHARS);
  });
});

// ============================================================================
// 1. Validators
// ============================================================================

describe("application-cluster validators", () => {
  it("vStatusBar takes null or a bounded string", () => {
    expect(vStatusBar([null])).toBe(true);
    expect(vStatusBar([""])).toBe(true);
    expect(vStatusBar(["Working… 3/10"])).toBe(true);
    expect(vStatusBar(["x".repeat(MAX_STATUS_BAR_CHARS)])).toBe(true);
    expect(vStatusBar(["x".repeat(MAX_STATUS_BAR_CHARS + 1)])).not.toBe(true);
    expect(vStatusBar([42])).not.toBe(true);
    expect(vStatusBar([undefined])).not.toBe(true);
    expect(vStatusBar([false])).not.toBe(true);
  });

  it("vBeginBatch bounds the description and CLOSES the options bag", () => {
    expect(vBeginBatch(["Import rows"])).toBe(true);
    expect(vBeginBatch(["Import rows", undefined])).toBe(true);
    expect(vBeginBatch(["Import rows", {}])).toBe(true);
    expect(vBeginBatch(["Import rows", { deferRepaint: true }])).toBe(true);
    expect(vBeginBatch(["Import rows", { deferRepaint: false }])).toBe(true);
    expect(vBeginBatch(["x".repeat(MAX_BATCH_DESCRIPTION_CHARS + 1)])).not.toBe(true);
    expect(vBeginBatch([42])).not.toBe(true);
    // A silently dropped deferRepaint is a script that believes the screen is
    // paused while every write repaints — unknown keys refuse.
    expect(vBeginBatch(["ok", { screenUpdating: false }])).not.toBe(true);
    expect(vBeginBatch(["ok", { deferRepaint: "yes" }])).not.toBe(true);
    expect(vBeginBatch(["ok", ["deferRepaint"]])).not.toBe(true);
  });

  it("vRunMacro requires a non-empty bounded name", () => {
    expect(vRunMacro(["Monthly report"])).toBe(true);
    expect(vRunMacro(["macro-monthly-report"])).toBe(true);
    expect(vRunMacro([""])).not.toBe(true);
    expect(vRunMacro(["   "])).not.toBe(true);
    expect(vRunMacro(["x".repeat(MAX_MACRO_REF_CHARS + 1)])).not.toBe(true);
    expect(vRunMacro([42])).not.toBe(true);
  });

  it("vViewOptionGet accepts exactly the five names", () => {
    expect([...SCRIPT_VIEW_OPTIONS].sort()).toEqual([
      "formulas", "gridlines", "headings", "viewMode", "zeros",
    ]);
    for (const name of SCRIPT_VIEW_OPTIONS) expect(vViewOptionGet([name])).toBe(true);
    expect(vViewOptionGet(["zoom"])).not.toBe(true);
    expect(vViewOptionGet(["Gridlines"])).not.toBe(true);
    expect(vViewOptionGet([undefined])).not.toBe(true);
  });

  it("vViewOptionSet matches the value TYPE to the name", () => {
    for (const name of ["gridlines", "headings", "zeros", "formulas"]) {
      expect(vViewOptionSet([name, true])).toBe(true);
      expect(vViewOptionSet([name, false])).toBe(true);
      expect(vViewOptionSet([name, "true"]), name).not.toBe(true);
      expect(vViewOptionSet([name, 1]), name).not.toBe(true);
    }
    expect([...SCRIPT_VIEW_MODES].sort()).toEqual(["normal", "pageBreakPreview", "pageLayout"]);
    for (const mode of SCRIPT_VIEW_MODES) expect(vViewOptionSet(["viewMode", mode])).toBe(true);
    expect(vViewOptionSet(["viewMode", true])).not.toBe(true);
    expect(vViewOptionSet(["viewMode", "PageLayout"])).not.toBe(true);
    expect(vViewOptionSet(["viewMode", "design"])).not.toBe(true);
  });

  it("vZoom enforces the percent bounds it promises", () => {
    expect(ZOOM_PERCENT_MIN).toBe(10);
    expect(ZOOM_PERCENT_MAX).toBe(400);
    expect(vZoom([100])).toBe(true);
    expect(vZoom([10])).toBe(true);
    expect(vZoom([400])).toBe(true);
    expect(vZoom([9])).not.toBe(true);
    expect(vZoom([401])).not.toBe(true);
    expect(vZoom([NaN])).not.toBe(true);
    expect(vZoom(["100"])).not.toBe(true);
    expect(vZoom([Infinity])).not.toBe(true);
  });
});

// ============================================================================
// 2. Status bar: live updates + the clear-on-death discipline
// ============================================================================

describe("executeSetStatusBar", () => {
  it("writes the SAME @api/grid service the QuickJS deferred action lands in", async () => {
    await executeSetStatusBar("script-a", "Working… 1/10");
    expect(grid.setStatusBarText).toHaveBeenCalledWith("Working… 1/10");
    expect(scriptHoldingStatusBar()).toBe("script-a");
  });

  it("null restores the default and settles the debt", async () => {
    await executeSetStatusBar("script-a", "Working…");
    await executeSetStatusBar("script-a", null);
    expect(grid.clearStatusBarText).toHaveBeenCalledTimes(1);
    expect(scriptHoldingStatusBar()).toBeNull();
  });

  it("last write wins: the holder is whoever's message is standing", async () => {
    await executeSetStatusBar("script-a", "A's message");
    await executeSetStatusBar("script-b", "B's message");
    expect(scriptHoldingStatusBar()).toBe("script-b");
  });
});

describe("releaseScriptStatusBar (the unmount/fault clear)", () => {
  it("clears the bar for the departing holder", async () => {
    await executeSetStatusBar("script-a", "Working…");
    releaseScriptStatusBar("script-a");
    await tick();
    expect(grid.clearStatusBarText).toHaveBeenCalledTimes(1);
    expect(scriptHoldingStatusBar()).toBeNull();
  });

  it("does NOT clear a message that was already replaced by another script", async () => {
    await executeSetStatusBar("script-a", "A's message");
    await executeSetStatusBar("script-b", "B's message");
    releaseScriptStatusBar("script-a");
    await tick();
    // B's message must survive A's death.
    expect(grid.clearStatusBarText).not.toHaveBeenCalled();
    expect(scriptHoldingStatusBar()).toBe("script-b");
  });

  it("is a no-op for a script that never touched the bar", async () => {
    releaseScriptStatusBar("innocent-bystander");
    await tick();
    expect(grid.clearStatusBarText).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 3. deferRepaint: swallow while open, ONE refresh at release
// ============================================================================

function makeRecalcLib(cells: Array<{ row: number; col: number }>) {
  return asLib({
    calculateSheet: vi.fn(async () => cells),
    calculateNow: vi.fn(async () => cells),
  });
}

describe("beginBatch({ deferRepaint }) suppression", () => {
  it("swallows every refresh broadcast while the batch is open", async () => {
    acquireDeferredRepaint("script-a");
    expect(scriptHoldingDeferredRepaint()).toBe("script-a");
    const lib = makeRecalcLib([{ row: 0, col: 0 }]);
    await executeRecalculate(lib); // -> afterCellDataChange -> scheduleGridDataRefresh
    await executeRecalculate(lib);
    await tick();
    expect(grid.refreshGridData).not.toHaveBeenCalled();
  });

  it("fires exactly ONE refresh at release, not one per swallowed broadcast", async () => {
    acquireDeferredRepaint("script-a");
    const lib = makeRecalcLib([{ row: 0, col: 0 }]);
    await executeRecalculate(lib);
    await executeRecalculate(lib);
    await executeRecalculate(lib);
    releaseDeferredRepaint("script-a");
    await tick();
    expect(grid.refreshGridData).toHaveBeenCalledTimes(1);
    expect(scriptHoldingDeferredRepaint()).toBeNull();
  });

  it("owes NO refresh when nothing was swallowed", async () => {
    acquireDeferredRepaint("script-a");
    releaseDeferredRepaint("script-a");
    await tick();
    expect(grid.refreshGridData).not.toHaveBeenCalled();
  });

  it("a non-holder's release cannot unfreeze somebody else's bracket", async () => {
    acquireDeferredRepaint("script-a");
    releaseDeferredRepaint("script-b");
    expect(scriptHoldingDeferredRepaint()).toBe("script-a");
  });

  it("the first holder keeps the bracket; a second acquire does not steal it", () => {
    acquireDeferredRepaint("script-a");
    acquireDeferredRepaint("script-b");
    expect(scriptHoldingDeferredRepaint()).toBe("script-a");
    releaseDeferredRepaint("script-b");
    expect(scriptHoldingDeferredRepaint()).toBe("script-a");
  });

  it("refreshes flow normally again after the release", async () => {
    acquireDeferredRepaint("script-a");
    releaseDeferredRepaint("script-a");
    vi.clearAllMocks();
    await executeRecalculate(makeRecalcLib([{ row: 0, col: 0 }]));
    await tick();
    expect(grid.refreshGridData).toHaveBeenCalledTimes(1);
  });
});

describe("the releases are WIRED into every way a script ends (source pins)", () => {
  it("hostUnmountScript releases the repaint pause AND the status bar", () => {
    const unmount = hostSrc.slice(hostSrc.indexOf("export function hostUnmountScript"));
    const body = unmount.slice(0, unmount.indexOf("\n}\n"));
    expect(body).toContain("releaseDeferredRepaint(scriptId)");
    expect(body).toContain("releaseScriptStatusBar(scriptId)");
  });

  it("hostResetAll (workbook swap) resets all three application debts", () => {
    const reset = hostSrc.slice(hostSrc.indexOf("export function hostResetAll"));
    const body = reset.slice(0, reset.indexOf("\n}\n"));
    expect(body).toContain("resetDeferredRepaint()");
    expect(body).toContain("resetStatusBarTracking()");
    expect(body).toContain("resetMacroRunTracking()");
  });

  it("the suppression sits at the ONE choke point every cell write funnels into", () => {
    const at = hostSrc.indexOf("function scheduleGridDataRefresh(): void {");
    const body = hostSrc.slice(at, hostSrc.indexOf("\n}", at));
    expect(body).toContain("deferredRepaintHolder !== null");
  });

  it("commit AND cancel release inside a finally, so a throwing commit cannot freeze", () => {
    for (const label of ['case "api.commitBatch"', 'case "api.cancelBatch"'] as const) {
      const at = hostSrc.indexOf(label);
      expect(at).toBeGreaterThan(-1);
      const body = hostSrc.slice(at, hostSrc.indexOf("return undefined;", at));
      expect(body, label).toContain("finally");
      expect(body, label).toContain("releaseDeferredRepaint(definition.id)");
    }
  });
});

// ============================================================================
// 4. runMacro: resolution, outcome mapping, re-entrancy chain
// ============================================================================

const MACROS = [
  { id: "macro-monthly-report", name: "Monthly report" },
  { id: "macro-cleanup", name: "Cleanup" },
  { id: "hand-authored", name: "Cleanup" }, // duplicate display name, other id
  { id: "macro-a", name: "A" },
  { id: "macro-b", name: "B" },
];

describe("resolveMacroRef", () => {
  it("resolves an exact module id first", () => {
    expect(resolveMacroRef(MACROS, "macro-monthly-report")).toEqual({
      id: "macro-monthly-report",
      name: "Monthly report",
    });
  });

  it("resolves a unique display name case-insensitively", () => {
    expect(resolveMacroRef(MACROS, "monthly REPORT")).toEqual({
      id: "macro-monthly-report",
      name: "Monthly report",
    });
  });

  it("refuses an ambiguous display name WITH the ids to use instead", () => {
    expect(() => resolveMacroRef(MACROS, "Cleanup")).toThrowError(/macro-cleanup.*hand-authored/s);
  });

  it("falls back to the recorder's slug spelling", () => {
    // "Monthly report" was stored under macro-monthly-report; the bare slug
    // (or any spelling that slugs to it) must find it.
    expect(resolveMacroRef(MACROS, "Monthly-Report!").id).toBe("macro-monthly-report");
  });

  it("an unknown name rejects LISTING what does exist", () => {
    expect(() => resolveMacroRef(MACROS, "does not exist")).toThrowError(/Monthly report/);
    expect(() => resolveMacroRef([], "anything")).toThrowError(/no scripts at all/);
  });
});

describe("executeRunMacro", () => {
  const listMock = vi.mocked(listWorkbookScripts);

  beforeEach(() => {
    listMock.mockResolvedValue(MACROS as never);
  });

  it("refuses loudly when the Macro Recorder is not loaded", async () => {
    await expect(executeRunMacro("Monthly report")).rejects.toThrowError(/Macro Recorder/);
  });

  it("resolves the ref to a module id and hands it to the seam", async () => {
    const runMacroByRef = vi.fn(
      async (): Promise<MacroRunOutcome> => ({ status: "ran", name: "Monthly report" }),
    );
    registerMacroRunProvider({ runMacroByRef });
    await expect(executeRunMacro("monthly report")).resolves.toEqual({ name: "Monthly report" });
    expect(runMacroByRef).toHaveBeenCalledWith("macro-monthly-report");
  });

  it("maps notFound to a named ValidationError (never a silent no-op)", async () => {
    registerMacroRunProvider({
      runMacroByRef: async () => ({ status: "notFound", macroId: "macro-monthly-report" }),
    });
    await expect(executeRunMacro("Monthly report")).rejects.toThrowError(
      /no macro with id "macro-monthly-report"/,
    );
  });

  it("maps failed to a throw carrying the macro's own error", async () => {
    registerMacroRunProvider({
      runMacroByRef: async () => ({
        status: "failed",
        name: "Monthly report",
        message: "boom at line 3",
      }),
    });
    await expect(executeRunMacro("Monthly report")).rejects.toThrowError(/boom at line 3/);
  });

  it("refuses a DIRECT self-call, naming the chain", async () => {
    let inner: unknown = null;
    registerMacroRunProvider({
      runMacroByRef: async (): Promise<MacroRunOutcome> => {
        try {
          await executeRunMacro("A");
        } catch (e) {
          inner = e;
        }
        return { status: "ran", name: "A" };
      },
    });
    await expect(executeRunMacro("A")).resolves.toEqual({ name: "A" });
    expect(String(inner)).toMatch(/already running/);
    expect(String(inner)).toContain("A -> A");
  });

  it("refuses an INDIRECT cycle (A -> B -> A), naming the whole chain", async () => {
    let inner: unknown = null;
    registerMacroRunProvider({
      runMacroByRef: async (macroId: string): Promise<MacroRunOutcome> => {
        if (macroId === "macro-a") {
          await executeRunMacro("B");
          return { status: "ran", name: "A" };
        }
        try {
          await executeRunMacro("A");
        } catch (e) {
          inner = e;
        }
        return { status: "ran", name: "B" };
      },
    });
    await expect(executeRunMacro("A")).resolves.toEqual({ name: "A" });
    expect(String(inner)).toMatch(/already running/);
    expect(String(inner)).toContain("A -> B -> A");
  });

  it("clears the running entry even when the macro fails, so it can run again", async () => {
    registerMacroRunProvider({
      runMacroByRef: async () => ({ status: "failed", name: "A", message: "boom" }),
    });
    await expect(executeRunMacro("A")).rejects.toThrowError(/boom/);
    registerMacroRunProvider({
      runMacroByRef: async (): Promise<MacroRunOutcome> => ({ status: "ran", name: "A" }),
    });
    await expect(executeRunMacro("A")).resolves.toEqual({ name: "A" });
  });
});

// ============================================================================
// 5. userName rides the EXISTING identity surface (source pin)
// ============================================================================

describe("api.userName", () => {
  it("reads the subscriber identity's display name — no new Rust, no path, no id", () => {
    const at = hostSrc.indexOf('case "api.userName"');
    expect(at).toBeGreaterThan(-1);
    const body = hostSrc.slice(at, hostSrc.indexOf("case ", at + 10));
    expect(body).toContain("getSubscriberIdentity()");
    expect(body).toContain(".displayName");
    // The identity's machine-generated id must NOT leak alongside the name.
    expect(body).not.toContain(".id");
  });
});

// ============================================================================
// 6. View / window state
// ============================================================================

describe("executeGetViewOption", () => {
  it("reads Core's live grid state", async () => {
    vi.mocked(grid.getGridStateSnapshot).mockReturnValue({
      displayGridlines: false,
      displayHeadings: true,
      displayZeros: false,
      showFormulas: true,
    } as never);
    vi.mocked(grid.getViewMode).mockReturnValue("pageLayout");
    expect(await executeGetViewOption("gridlines")).toBe(false);
    expect(await executeGetViewOption("headings")).toBe(true);
    expect(await executeGetViewOption("zeros")).toBe(false);
    expect(await executeGetViewOption("formulas")).toBe(true);
    expect(await executeGetViewOption("viewMode")).toBe("pageLayout");
  });

  it("answers the render defaults before the grid has mounted", async () => {
    vi.mocked(grid.getGridStateSnapshot).mockReturnValue(null as never);
    expect(await executeGetViewOption("gridlines")).toBe(true);
    expect(await executeGetViewOption("headings")).toBe(true);
    expect(await executeGetViewOption("zeros")).toBe(true);
    expect(await executeGetViewOption("formulas")).toBe(false);
  });
});

describe("executeSetViewOption", () => {
  /** Capture one app event's detail while `fn` runs. */
  async function capturing(eventName: string, fn: () => Promise<void>): Promise<unknown[]> {
    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(eventName, listener);
    try {
      await fn();
    } finally {
      window.removeEventListener(eventName, listener);
    }
    return seen;
  }

  it("drives the four toggles through the SAME events the View menu emits", async () => {
    const cases: Array<[Parameters<typeof executeSetViewOption>[0], string, string]> = [
      ["gridlines", AppEvents.DISPLAY_GRIDLINES_TOGGLED, "displayGridlines"],
      ["headings", AppEvents.DISPLAY_HEADINGS_TOGGLED, "displayHeadings"],
      ["zeros", AppEvents.DISPLAY_ZEROS_TOGGLED, "displayZeros"],
      ["formulas", AppEvents.SHOW_FORMULAS_TOGGLED, "showFormulas"],
    ];
    for (const [name, eventName, payloadKey] of cases) {
      const seen = await capturing(eventName, () => executeSetViewOption(name, false));
      expect(seen, name).toEqual([{ [payloadKey]: false }]);
    }
  });

  it("repaints after a toggle (GRID_REFRESH — the toggles change pixels only)", async () => {
    const seen = await capturing(AppEvents.GRID_REFRESH, () =>
      executeSetViewOption("gridlines", true),
    );
    expect(seen.length).toBe(1);
  });

  it("routes viewMode through changeViewMode (which announces + repaints itself)", async () => {
    await executeSetViewOption("viewMode", "pageBreakPreview");
    expect(grid.changeViewMode).toHaveBeenCalledWith("pageBreakPreview");
  });
});

describe("executeGetPanes", () => {
  it("combines the backend freeze + split reads into one answer", async () => {
    vi.doMock("../../../core/lib/tauri-api", () => ({
      getFreezePanes: vi.fn(async () => ({ freezeRow: 2, freezeCol: null })),
      getSplitWindow: vi.fn(async () => ({ splitRow: null, splitCol: 4 })),
    }));
    try {
      const panes = await executeGetPanes();
      expect(panes).toEqual({ freezeRow: 2, freezeCol: null, splitRow: null, splitCol: 4 });
    } finally {
      vi.doUnmock("../../../core/lib/tauri-api");
    }
  });
});
