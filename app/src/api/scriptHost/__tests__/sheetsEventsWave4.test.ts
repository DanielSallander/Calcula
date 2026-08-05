//! FILENAME: app/src/api/scriptHost/__tests__/sheetsEventsWave4.test.ts
// PURPOSE: Wave 4 SHEETS/EVENTS cluster — the pure layers: allowlist policy
//          rows (page setup / grouping / scheduleOnce), their validators,
//          addSheet/copySheet positioning math, the "print" lifecycle action,
//          the grouping seam's refuse-loudly contract, and the scheduler's
//          one-shot wire shape.
// CONTEXT: The worker-realm halves (hook forwarders, click verdicts) live in
//          sheetsEventsWave4Hooks.test.ts, which mounts a fake realm.

import { describe, it, expect, afterEach, vi } from "vitest";
import { ALLOWLIST } from "../allowlist";
import {
  vPageSetupPatch,
  vPrintArea,
  vPageBreak,
  vGroupSpan,
  vOutlineLevel,
  vAddSheet,
  vCopySheet,
  vScheduleOnce,
  MIN_ONCE_DELAY_SECS,
  MAX_GROUP_SPAN,
} from "../validators";
import { resolveSheetPosition } from "../host";
import {
  registerGroupingController,
  requireGroupingController,
  hasGroupingController,
  resetGroupingController,
  type GroupingController,
} from "../../groupingService";
import {
  checkLifecycleGuards,
  registerLifecycleGuard,
  lifecycleCancelMessage,
  resetLifecycleGuards,
} from "../../lifecycleGuards";

afterEach(() => {
  resetGroupingController();
  resetLifecycleGuards();
  vi.restoreAllMocks();
});

// ============================================================================
// Allowlist policy rows
// ============================================================================

describe("Wave 4 SHEETS allowlist rows", () => {
  const PRINT_ROWS = [
    "api.getPageSetup", "api.setPageSetup", "api.setPrintArea", "api.clearPrintArea",
    "api.addPageBreak", "api.removePageBreak", "api.resetPageBreaks",
  ];
  const GROUP_ROWS = [
    "api.groupRows", "api.ungroupRows", "api.groupColumns", "api.ungroupColumns",
    "api.showOutlineLevel",
  ];

  it("page-setup rows are unlocked-tier, no capability, honest classes", () => {
    for (const row of PRINT_ROWS) {
      const policy = ALLOWLIST[row];
      expect(policy, row).toBeDefined();
      expect(policy.tier, row).toBe("unlocked");
      expect(policy.capability, row).toBeUndefined();
      expect(policy.class, row).toBe(row === "api.getPageSetup" ? "read" : "mutate");
    }
  });

  it("grouping rows are unlocked-tier mutates with no capability", () => {
    for (const row of GROUP_ROWS) {
      const policy = ALLOWLIST[row];
      expect(policy, row).toBeDefined();
      expect(policy.tier, row).toBe("unlocked");
      expect(policy.capability, row).toBeUndefined();
      expect(policy.class, row).toBe("mutate");
    }
  });

  it("cap.scheduleOnce rides the EXISTING `schedule` capability — no new id", () => {
    const policy = ALLOWLIST["cap.scheduleOnce"];
    expect(policy).toBeDefined();
    expect(policy.capability).toBe("schedule"); // the CAPABILITY RULE: never a new id
    expect(policy.tier).toBe("restricted");
    expect(policy.class).toBe("mutate");
    // Same registration budget as its siblings.
    expect(policy.limits?.perMinute).toBe(ALLOWLIST["cap.scheduleEvery"].limits?.perMinute);
  });
});

// ============================================================================
// Validators
// ============================================================================

describe("vPageSetupPatch", () => {
  it("accepts a partial patch of known keys", () => {
    expect(vPageSetupPatch([{ orientation: "landscape", fitToWidth: 1 }])).toBe(true);
    expect(vPageSetupPatch([{ marginTop: 0.5, header: "&C&F" }, 0])).toBe(true);
  });

  it("rejects an empty patch, unknown keys, and non-objects", () => {
    expect(vPageSetupPatch([{}])).toMatch(/at least one/);
    expect(vPageSetupPatch([{ printArea: "A1:B2" }])).toMatch(/printArea/);
    expect(vPageSetupPatch([{ manualRowBreaks: [3] }])).toMatch(/manualRowBreaks/);
    expect(vPageSetupPatch(["landscape"])).toMatch(/object/);
    expect(vPageSetupPatch([null])).toMatch(/object/);
  });

  it("rejects out-of-vocabulary values with the accepted list", () => {
    expect(vPageSetupPatch([{ paperSize: "b5" }])).toMatch(/letter/);
    expect(vPageSetupPatch([{ orientation: "sideways" }])).toMatch(/portrait/);
    expect(vPageSetupPatch([{ scale: 5 }])).toMatch(/10 to 400/);
    expect(vPageSetupPatch([{ marginTop: -1 }])).toMatch(/inches/);
    expect(vPageSetupPatch([{ printGridlines: "yes" }])).toMatch(/boolean/);
    expect(vPageSetupPatch([{ fitToWidth: 1.5 }])).toMatch(/integer/);
  });
});

describe("vPrintArea / vPageBreak", () => {
  it("vPrintArea checks the rectangle", () => {
    expect(vPrintArea([0, 0, 19, 5])).toBe(true);
    expect(vPrintArea([5, 0, 4, 5])).toMatch(/endRow/);
    expect(vPrintArea([0, 3, 4, 2])).toMatch(/endCol/);
    expect(vPrintArea([-1, 0, 4, 5])).toMatch(/startRow/);
  });

  it("vPageBreak enforces the kind vocabulary", () => {
    expect(vPageBreak(["row", 5])).toBe(true);
    expect(vPageBreak(["col", 2, 0])).toBe(true);
    expect(vPageBreak(["column", 2])).toMatch(/"row" or "col"/);
    expect(vPageBreak(["row", -1])).toMatch(/index/);
  });
});

describe("vGroupSpan / vOutlineLevel", () => {
  it("vGroupSpan checks the inclusive span", () => {
    expect(vGroupSpan([2, 10])).toBe(true);
    expect(vGroupSpan([2, 2, "Data"])).toBe(true);
    expect(vGroupSpan([10, 2])).toMatch(/end must be >= start/);
    expect(vGroupSpan([0, MAX_GROUP_SPAN])).toMatch(/span too large/);
  });

  it("vOutlineLevel needs at least one axis, bounded 0-8", () => {
    expect(vOutlineLevel([1, null])).toBe(true);
    expect(vOutlineLevel([null, 2])).toBe(true);
    expect(vOutlineLevel([0, 0])).toBe(true);
    expect(vOutlineLevel([null, null])).toMatch(/rowLevel, colLevel/);
    expect(vOutlineLevel([9, null])).toMatch(/between 0 and 8/);
    expect(vOutlineLevel([1.5, null])).toMatch(/integer/);
  });
});

describe("vAddSheet / vCopySheet position bag", () => {
  it("accepts before OR after, refuses both", () => {
    expect(vAddSheet(["Summary", { before: 0 }])).toBe(true);
    expect(vAddSheet([undefined, { after: "Data" }])).toBe(true);
    expect(vAddSheet(["S", { before: 0, after: 1 }])).toMatch(/not both/);
    expect(vCopySheet([0, "Copy", { after: "Jan" }])).toBe(true);
    expect(vCopySheet([0, undefined, { before: 1, after: 2 }])).toMatch(/not both/);
  });

  it("refuses unknown position keys and bad anchors", () => {
    expect(vAddSheet(["S", { at: 3 }])).not.toBe(true);
    expect(vAddSheet(["S", { before: true }])).not.toBe(true);
    expect(vAddSheet(["S", []])).toMatch(/object/);
  });

  it("still validates the sheet name itself", () => {
    expect(vAddSheet(["bad[name]"])).toMatch(/may not contain/);
    expect(vCopySheet([0, "bad:name"])).toMatch(/may not contain/);
  });
});

describe("vScheduleOnce", () => {
  it("takes [atMs, handler, options?]", () => {
    expect(vScheduleOnce([Date.now() + 60_000, "tick"])).toBe(true);
    expect(vScheduleOnce([1, "tick", { label: "reminder" }])).toBe(true);
    expect(vScheduleOnce(["tomorrow", "tick"])).toMatch(/epoch-millisecond/);
    expect(vScheduleOnce([-5, "tick"])).toMatch(/epoch-millisecond/);
    expect(vScheduleOnce([Date.now(), ""])).toMatch(/handler/);
    expect(vScheduleOnce([Date.now(), "tick", "label"])).toMatch(/options/);
  });

  it("pins the delay floor to the Rust MIN_ONCE_DELAY_SECS", () => {
    // scripting/scheduler.rs MIN_ONCE_DELAY_SECS — mirrored, never imported.
    expect(MIN_ONCE_DELAY_SECS).toBe(5);
  });
});

// ============================================================================
// addSheet/copySheet positioning math (host resolveSheetPosition)
// ============================================================================

describe("resolveSheetPosition", () => {
  const base = [
    { index: 0, name: "Jan" },
    { index: 1, name: "Feb" },
    { index: 2, name: "Mar" },
  ];

  it("answers null when no position was requested", () => {
    expect(resolveSheetPosition(base, undefined, "addSheet")).toBeNull();
    expect(resolveSheetPosition(base, null, "addSheet")).toBeNull();
    expect(resolveSheetPosition(base, {}, "addSheet")).toBeNull();
  });

  it("before = the anchor's own index; after = one past it", () => {
    expect(resolveSheetPosition(base, { before: "Jan" }, "addSheet")).toBe(0);
    expect(resolveSheetPosition(base, { before: 2 }, "addSheet")).toBe(2);
    expect(resolveSheetPosition(base, { after: "Jan" }, "addSheet")).toBe(1);
    expect(resolveSheetPosition(base, { after: 2 }, "addSheet")).toBe(3);
  });

  it("refuses both-set and unknown anchors by name", () => {
    expect(() => resolveSheetPosition(base, { before: 0, after: 1 }, "addSheet"))
      .toThrow(/not both/);
    expect(() => resolveSheetPosition(base, { before: "Apr" }, "addSheet"))
      .toThrow(/no sheet named "Apr"/);
    expect(() => resolveSheetPosition(base, { after: 9 }, "copySheet"))
      .toThrow(/no sheet with index 9/);
  });
});

// ============================================================================
// The "print" lifecycle action
// ============================================================================

describe("lifecycle action print", () => {
  it("a guard can cancel a print, attributably", async () => {
    registerLifecycleGuard(async (action) =>
      action === "print" ? { by: "Report Gate", reason: "Totals are stale" } : null,
    );
    const objection = await checkLifecycleGuards("print", {});
    expect(objection).toEqual({ by: "Report Gate", reason: "Totals are stale" });
    expect(lifecycleCancelMessage("print", objection!)).toBe(
      'Script "Report Gate" cancelled the print: Totals are stale',
    );
  });

  it("a print-only guard does not veto saves (and vice versa)", async () => {
    registerLifecycleGuard(async (action) =>
      action === "print" ? { by: "Report Gate" } : null,
    );
    expect(await checkLifecycleGuards("save", {})).toBeNull();
    expect(await checkLifecycleGuards("close", {})).toBeNull();
    expect(await checkLifecycleGuards("print", {})).not.toBeNull();
  });
});

// ============================================================================
// Grouping seam: refuse loudly when the extension is not there
// ============================================================================

describe("groupingService", () => {
  const stub = (): GroupingController => ({
    groupRows: vi.fn(async () => ({
      maxRowLevel: 1, maxColLevel: 0, hiddenRowsChanged: [], hiddenColsChanged: [],
    })),
    ungroupRows: vi.fn(),
    groupColumns: vi.fn(),
    ungroupColumns: vi.fn(),
    showOutlineLevel: vi.fn(),
  }) as unknown as GroupingController;

  it("requireGroupingController THROWS when the extension is disabled", () => {
    expect(hasGroupingController()).toBe(false);
    expect(() => requireGroupingController()).toThrow(/Grouping extension is not loaded/);
  });

  it("registers, answers, and unregisters", () => {
    const controller = stub();
    const cleanup = registerGroupingController(controller);
    expect(requireGroupingController()).toBe(controller);
    cleanup();
    expect(hasGroupingController()).toBe(false);
  });

  it("a stale cleanup cannot blank out a NEWER registration", () => {
    const old = stub();
    const oldCleanup = registerGroupingController(old);
    const next = stub();
    registerGroupingController(next);
    oldCleanup(); // re-activation race: the OLD cleanup runs late
    expect(requireGroupingController()).toBe(next);
  });
});

// ============================================================================
// Scheduler one-shot wire shape
// ============================================================================

describe("scheduleOnce wire shape", () => {
  it("sends op 'once' with a floored integer delay", async () => {
    vi.resetModules();
    const invokeBackend = vi.fn(async (_cmd: string, _args: unknown) => ({
      id: "job-1", cadence: "once",
    }));
    vi.doMock("../../backend", () => ({ invokeBackend }));
    // syncPump also calls the backend (op list); the mock serves both.
    const { scheduleOnce } = await import("../scheduler");
    const owner = { scriptId: "s1", surface: "object", objectType: "sheet", instanceId: null };

    await scheduleOnce(owner, 12.9, "tick", "reminder");
    expect(invokeBackend).toHaveBeenCalledWith("script_scheduler", {
      request: expect.objectContaining({
        op: "once",
        scriptId: "s1",
        handler: "tick",
        intervalSecs: 12,
        label: "reminder",
      }),
    });

    // The floor: a delay below MIN_ONCE_DELAY_SECS is raised to it, never sent raw.
    await scheduleOnce(owner, 0, "tick");
    const last = invokeBackend.mock.calls
      .map((c) => c[1] as { request: { op: string; intervalSecs?: number } })
      .filter((a) => a.request.op === "once")
      .pop();
    expect(last?.request.intervalSecs).toBe(5);
    vi.doUnmock("../../backend");
    vi.resetModules();
  });
});
