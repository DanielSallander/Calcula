//! FILENAME: app/extensions/ScriptableObjects/__tests__/codeStatus.test.ts
// PURPOSE: The status bar's code-and-scripts indicator says the right thing
//          (deriveCodeStatus) and keeps saying it as the file changes
//          (CodeStatusSource).
// CONTEXT: The indicator replaced two activity-bar icons that never changed.
//          Its whole value is being TRUE without being opened, so the cases
//          below pin the transparency rules it keeps:
//          - the count is the panel's own number, and "worth a look" is the
//            panel's own warning list (codeInventoryWarnings) plus refusals;
//          - a read that fails -- wholly or in part -- is said, never shown as
//            "no code";
//          - a replaced document starts over, and a read of the old one that
//            lands late is dropped.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AuditEntry, CodeUnit } from "@api";
import { codeInventoryWarnings, type ScheduledJobSummary, type ScriptHeldStateSummary } from "@api/codeInventory";
import {
  CodeStatusSource,
  LOADING_SNAPSHOT,
  deriveCodeStatus,
  type CodeStatusFileRead,
  type CodeStatusInventory,
  type CodeStatusReaders,
  type CodeStatusSignals,
  type CodeStatusSnapshot,
  type CodeStatusTiming,
} from "../lib/codeStatus";

// ============================================================================
// Fixtures
// ============================================================================

const NO_JOBS: ScheduledJobSummary = { total: 0, enabled: 0, disabled: 0, running: 0, orphaned: 0, nextRunMs: null };
const NOTHING_HELD: ScriptHeldStateSummary = {
  shortcuts: 0,
  clipboards: 0,
  clipboardCells: 0,
  runningWatches: 0,
  panes: 0,
  embeddedForms: 0,
  forms: 0,
  any: false,
};
const NO_CODE: CodeStatusInventory = { total: 0, local: 0, distributed: 0, libraries: 0, beyondGrid: 0, mounted: 0 };

function ready(over: Partial<CodeStatusSnapshot> = {}): CodeStatusSnapshot {
  return {
    phase: "ready",
    inventory: NO_CODE,
    inventoryError: null,
    inventoryGaps: [],
    jobs: NO_JOBS,
    held: NOTHING_HELD,
    heldButtons: 0,
    commandButtons: 0,
    refusals: 0,
    ...over,
  };
}

const factIds = (snap: CodeStatusSnapshot): string[] => deriveCodeStatus(snap).facts.map((f) => f.id);

// ============================================================================
// deriveCodeStatus
// ============================================================================

describe("deriveCodeStatus: the states", () => {
  it("before the first read it is CHECKING, never 'no code'", () => {
    const view = deriveCodeStatus(LOADING_SNAPSHOT);
    expect(view.level).toBe("loading");
    expect(view.count).toBeNull();
    expect(view.ariaLabel).toBe("Code and scripts: checking the code in this file. Show details.");
    expect(view.ariaLabel).not.toMatch(/no code/i);
  });

  it("an empty file with nothing going on is NONE", () => {
    const view = deriveCodeStatus(ready());
    expect(view.level).toBe("none");
    expect(view.count).toBe(0);
    expect(view.noticeCount).toBe(0);
    expect(view.facts.map((f) => f.text)).toEqual(["No code in this file"]);
    expect(view.ariaLabel).toBe("Code and scripts: No code in this file. Show details.");
  });

  it("code that is all local and grid-only is PRESENT with the panel's count", () => {
    const view = deriveCodeStatus(ready({ inventory: { ...NO_CODE, total: 3, local: 3 } }));
    expect(view.level).toBe("present");
    expect(view.count).toBe(3);
    expect(view.facts[0]).toMatchObject({ id: "code", text: "3 pieces of code in this file", detail: "all written here" });
    expect(view.title).toBe("3 pieces of code in this file");
  });

  it("one piece is singular", () => {
    expect(deriveCodeStatus(ready({ inventory: { ...NO_CODE, total: 1, local: 1 } })).facts[0].text).toBe(
      "1 piece of code in this file",
    );
  });

  it("says where code came from: written here, with an application, from a script library -- and what runs", () => {
    const view = deriveCodeStatus(
      ready({ inventory: { total: 5, local: 1, distributed: 4, libraries: 1, beyondGrid: 0, mounted: 2 } }),
    );
    expect(view.facts[0].detail).toBe(
      "1 written here · 3 came with an application · 1 from a script library · 2 running now",
    );
    // Code from elsewhere alone is information, not an alarm: the consent
    // screen is where it was (or will be) decided.
    expect(view.level).toBe("present");
  });

  it("a script library is never called 'an application'", () => {
    const view = deriveCodeStatus(ready({ inventory: { ...NO_CODE, total: 2, distributed: 2, libraries: 2 } }));
    expect(view.facts[0].detail).toBe("2 from a script library");
  });

  it("buttons holding an application's code make the file PRESENT even with no code units", () => {
    const view = deriveCodeStatus(ready({ heldButtons: 2 }));
    expect(view.level).toBe("present");
    expect(view.facts.map((f) => f.id)).toEqual(["code", "held-buttons"]);
    expect(view.facts[1].text).toBe("2 buttons hold an application's code");
    expect(deriveCodeStatus(ready({ commandButtons: 1 })).facts[1].text).toBe(
      "1 application button runs a Calcula command",
    );
  });
});

describe("deriveCodeStatus: worth a look is codeInventoryWarnings (the panel's own chips) plus refusals", () => {
  // Each row is a change that raises one warning. The ids are
  // codeInventoryWarnings' -- the SAME list CodeInThisFilePanel paints its
  // warning chips from -- so this table cannot drift from the panel.
  const CASES: Array<[string, Partial<CodeStatusSnapshot>, string]> = [
    ["reach beyond the grid", { inventory: { ...NO_CODE, total: 1, local: 1, beyondGrid: 1 } }, "beyond-grid"],
    ["a scheduled job", { jobs: { ...NO_JOBS, total: 1, enabled: 1 } }, "jobs"],
    ["a PAUSED scheduled job still counts (it revives on resume)", { jobs: { ...NO_JOBS, total: 1, disabled: 1 } }, "jobs"],
    ["a held keyboard shortcut", { held: { ...NOTHING_HELD, shortcuts: 1, any: true } }, "shortcuts"],
    ["cells in a script clipboard", { held: { ...NOTHING_HELD, clipboards: 1, clipboardCells: 6, any: true } }, "clipboards"],
    ["a running background check", { held: { ...NOTHING_HELD, runningWatches: 1, any: true } }, "watches"],
    ["a script pane", { held: { ...NOTHING_HELD, panes: 1, any: true } }, "panes"],
    ["a script's dialog", { held: { ...NOTHING_HELD, forms: 1, any: true } }, "form"],
    ["a refused call", { refusals: 1 }, "refusals"],
  ];

  for (const [what, change, id] of CASES) {
    it(`${what} -> notice (${id})`, () => {
      const view = deriveCodeStatus(ready(change));
      expect(view.level).toBe("notice");
      expect(view.facts.find((f) => f.id === id)?.notice).toBe(true);
      expect(view.noticeCount).toBe(1);
    });
  }

  it("every warning the panel paints is a notice here, word for word (one list, two surfaces)", () => {
    const snap = ready({
      inventory: { ...NO_CODE, total: 2, local: 2, beyondGrid: 1 },
      jobs: { ...NO_JOBS, total: 2, enabled: 1, disabled: 1 },
      held: { shortcuts: 1, clipboards: 1, clipboardCells: 4, runningWatches: 1, panes: 2, embeddedForms: 1, forms: 1, any: true },
    });
    const panel = codeInventoryWarnings(snap.inventory, snap.jobs, snap.held);
    const notices = deriveCodeStatus(snap).facts.filter((f) => f.notice);
    expect(notices.map((f) => f.id)).toEqual(panel.map((w) => w.id));
    expect(notices.map((f) => f.text)).toEqual(panel.map((w) => w.text));
    expect(panel).toHaveLength(7);
  });

  it("a held background watch that is NOT running is present, not a notice (the panel's own rule)", () => {
    const view = deriveCodeStatus(ready({ held: { ...NOTHING_HELD, any: true } }));
    expect(view.level).toBe("present");
  });

  it("every notice is listed in the accessible name, so a screen reader hears what the dot means", () => {
    const view = deriveCodeStatus(
      ready({
        inventory: { ...NO_CODE, total: 2, local: 2, beyondGrid: 1 },
        jobs: { ...NO_JOBS, total: 2, enabled: 1, disabled: 1 },
        refusals: 3,
      }),
    );
    expect(view.noticeCount).toBe(3);
    expect(view.ariaLabel).toBe(
      "Code and scripts: 2 pieces of code in this file. 3 things worth a look: " +
        "1 can reach beyond the grid; 2 scheduled jobs; 3 script calls refused. Show details.",
    );
    expect(view.title).toBe("2 pieces of code in this file · 3 worth a look");
    expect(view.facts.find((f) => f.id === "jobs")?.detail).toBe("Runs without you starting it · 1 paused");
  });

  it("the facts keep the panel's order: the file, what runs or holds unasked, what was refused", () => {
    expect(
      factIds(
        ready({
          inventory: { ...NO_CODE, total: 1, local: 1, beyondGrid: 1 },
          heldButtons: 1,
          commandButtons: 1,
          jobs: { ...NO_JOBS, total: 1, enabled: 1 },
          held: { shortcuts: 1, clipboards: 1, clipboardCells: 1, runningWatches: 1, panes: 1, embeddedForms: 1, forms: 1, any: true },
          refusals: 1,
        }),
      ),
    ).toEqual([
      "code",
      "held-buttons",
      "command-buttons",
      "beyond-grid",
      "jobs",
      "shortcuts",
      "clipboards",
      "watches",
      "panes",
      "form",
      "refusals",
    ]);
  });

  it("the refusal fact says whose refusals it counts and where to see them", () => {
    expect(deriveCodeStatus(ready({ refusals: 2 })).facts.find((f) => f.id === "refusals")).toMatchObject({
      text: "2 script calls refused",
      detail: "Since this file was opened, by any script or add-in · see Script Permissions",
    });
  });
});

describe("deriveCodeStatus: never wrong in the reassuring direction", () => {
  it("an inventory that could not be read is UNKNOWN with the reason, never 'no code'", () => {
    const view = deriveCodeStatus(ready({ inventory: null, inventoryError: "backend gone" }));
    expect(view.level).toBe("unknown");
    expect(view.count).toBeNull();
    expect(view.facts[0]).toMatchObject({ id: "inventory-error", detail: "backend gone", notice: true });
    expect(view.ariaLabel).not.toMatch(/no code/i);
    // ...and the headline is not repeated as a second "thing worth a look".
    expect(view.ariaLabel).toBe("Code and scripts: Could not read the code in this file. Show details.");
  });

  it("a PARTLY read inventory is UNKNOWN: the count is a floor ('at least'), and the gap is named", () => {
    const view = deriveCodeStatus(
      ready({ inventory: { ...NO_CODE, total: 2, local: 2 }, inventoryGaps: ["notebooks", 'object script "Refresh"'] }),
    );
    expect(view.level).toBe("unknown");
    expect(view.count).toBeNull();
    expect(view.facts.map((f) => [f.id, f.text])).toEqual([
      ["code", "At least 2 pieces of code in this file"],
      ["inventory-gaps", "Could not read some of the code in this file"],
    ]);
    expect(view.facts[1].detail).toBe('notebooks, object script "Refresh"');
    expect(view.ariaLabel).toBe(
      "Code and scripts: At least 2 pieces of code in this file; some could not be read. Show details.",
    );
  });

  it("a gap with NOTHING read is still not 'No code in this file'", () => {
    const view = deriveCodeStatus(ready({ inventoryGaps: ["object scripts"] }));
    expect(view.level).toBe("unknown");
    expect(view.facts.map((f) => f.text)).not.toContain("No code in this file");
    expect(view.ariaLabel).not.toMatch(/no code/i);
  });

  it("an unreadable inventory still lists everything else that IS known", () => {
    const view = deriveCodeStatus(ready({ inventory: null, inventoryError: "x", refusals: 2 }));
    expect(view.level).toBe("unknown");
    expect(view.ariaLabel).toContain("1 thing worth a look: 2 script calls refused.");
  });

  it.each([
    ["jobs", { jobs: null }, "jobs-error"],
    ["held state", { held: null }, "held-error"],
    ["held buttons", { heldButtons: null }, "buttons-error"],
    ["application buttons", { commandButtons: null }, "command-buttons-error"],
  ] as const)("an unreadable %s read is SAID and worth a look", (_what, change, id) => {
    const view = deriveCodeStatus(ready(change as Partial<CodeStatusSnapshot>));
    expect(view.level).toBe("notice");
    expect(view.facts.find((f) => f.id === id)?.notice).toBe(true);
  });

  it("a refusal before the first read lights the dot AND is said in the name and tooltip", () => {
    const view = deriveCodeStatus({ ...LOADING_SNAPSHOT, refusals: 1 });
    expect(view.level).toBe("notice");
    expect(view.count).toBeNull();
    expect(view.facts.map((f) => f.id)).toEqual(["refusals"]);
    expect(view.ariaLabel).toBe(
      "Code and scripts: checking the code in this file. 1 thing worth a look: 1 script call refused. Show details.",
    );
    expect(view.title).toBe("Checking the code in this file… · 1 worth a look");
  });
});

// ============================================================================
// CodeStatusSource
// ============================================================================

interface Harness {
  source: CodeStatusSource;
  readers: {
    readFile: ReturnType<typeof vi.fn>;
    readJobs: ReturnType<typeof vi.fn>;
    readHeld: ReturnType<typeof vi.fn>;
    refusalsSoFar: ReturnType<typeof vi.fn>;
  };
  fire: { replaced: () => void; changed: () => void; returned: () => void; audit: (e: Partial<AuditEntry>) => void };
  hidden: { value: boolean };
  clock: { now: number };
  unsubscribed: () => number;
}

const unit = (id: string, over: Partial<CodeUnit> = {}): CodeUnit =>
  ({
    surfaceId: "object-script",
    id,
    name: id,
    residence: "",
    provenance: "local",
    sourcePackage: null,
    declaredCapabilities: [],
    liveGrants: null,
    tier: "restricted",
    mounted: false,
    interpreterReach: null,
    interpreterCapabilities: null,
    source: "",
    lineCount: 0,
    ...over,
  }) as CodeUnit;

/** What a harness file read returns for `units`. */
function fileRead(units: CodeUnit[], gaps: string[] = []): CodeStatusFileRead {
  return {
    units,
    inventory: {
      total: units.length,
      local: units.filter((u) => u.provenance === "local").length,
      distributed: units.filter((u) => u.provenance === "distributed").length,
      libraries: 0,
      beyondGrid: units.filter((u) => u.declaredCapabilities.length > 0).length,
      mounted: units.filter((u) => u.mounted).length,
    },
    gaps,
    heldButtons: 0,
    commandButtons: 0,
  };
}

function harness(units: () => CodeUnit[] | Promise<CodeUnit[]> = () => [], seededRefusals = 0): Harness {
  const listeners = {
    replaced: new Set<() => void>(),
    changed: new Set<() => void>(),
    returned: new Set<() => void>(),
    audit: new Set<(e: AuditEntry) => void>(),
  };
  let unsubscribed = 0;
  const sub = <T>(set: Set<T>, cb: T): (() => void) => {
    set.add(cb);
    return () => {
      set.delete(cb);
      unsubscribed += 1;
    };
  };
  const signals: CodeStatusSignals = {
    onDocumentReplaced: (cb) => sub(listeners.replaced, cb),
    onCodeMayHaveChanged: (cb) => sub(listeners.changed, cb),
    onUserReturned: (cb) => sub(listeners.returned, cb),
    onAudit: (cb) => sub(listeners.audit, cb),
  };
  const readers = {
    readFile: vi.fn(async () => fileRead(await units())),
    readJobs: vi.fn(async () => NO_JOBS),
    readHeld: vi.fn(async () => NOTHING_HELD),
    refusalsSoFar: vi.fn(() => seededRefusals),
  };
  const hidden = { value: false };
  const clock = { now: 1_000_000 };
  const timing: CodeStatusTiming = {
    lightPollMs: 15_000,
    fullEveryTicks: 4,
    debounceMs: 250,
    notifyThrottleMs: 250,
    returnRefreshAfterMs: 5_000,
    isHidden: () => hidden.value,
    now: () => clock.now,
  };
  const source = new CodeStatusSource(readers as unknown as CodeStatusReaders, signals, timing);
  return {
    source,
    readers,
    hidden,
    clock,
    unsubscribed: () => unsubscribed,
    fire: {
      replaced: () => listeners.replaced.forEach((cb) => cb()),
      changed: () => listeners.changed.forEach((cb) => cb()),
      returned: () => listeners.returned.forEach((cb) => cb()),
      audit: (e) =>
        listeners.audit.forEach((cb) =>
          cb({ ts: 0, scriptId: "s", scriptName: "s", method: "m", class: "read", ok: false, ...e } as AuditEntry),
        ),
    },
  };
}

/** Let every pending promise in the read chain settle (fake timers stay put). */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** A promise the test resolves by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("CodeStatusSource", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts LOADING and lands on the first read's state", async () => {
    const h = harness(() => [unit("a"), unit("b")]);
    expect(h.source.getSnapshot().phase).toBe("loading");
    h.source.start();
    await flush();
    const snap = h.source.getSnapshot();
    expect(snap.phase).toBe("ready");
    expect(snap.inventory?.total).toBe(2);
    // The owner join reuses the inventory just read (never a second file scan).
    expect(h.readers.readJobs).toHaveBeenCalledWith([expect.objectContaining({ id: "a" }), expect.anything()]);
    h.source.stop();
  });

  it("SEEDS the refusals already recorded when it starts (the launch document's), once", async () => {
    const h = harness(() => [], 3);
    h.source.start();
    expect(h.source.getSnapshot().refusals).toBe(3);
    await flush();
    expect(h.source.getSnapshot().refusals).toBe(3);
    // A later File > Open starts from zero: the ring is never cleared per
    // document, so seeding again would charge the old file's refusals to it.
    h.fire.replaced();
    await flush();
    expect(h.source.getSnapshot().refusals).toBe(0);
    expect(h.readers.refusalsSoFar).toHaveBeenCalledTimes(1);
    h.source.stop();
  });

  it("the snapshot object is stable while nothing changes (useSyncExternalStore's contract)", async () => {
    const h = harness(() => [unit("a")]);
    h.source.start();
    await flush();
    const first = h.source.getSnapshot();
    const notified = vi.fn();
    h.source.subscribe(notified);
    await h.source.refreshNow();
    expect(h.source.getSnapshot()).toBe(first);
    expect(notified).not.toHaveBeenCalled();
    h.source.stop();
  });

  it("a burst of change events is ONE re-read, after the debounce", async () => {
    let units = [unit("a")];
    const h = harness(() => units);
    h.source.start();
    await flush();
    h.readers.readFile.mockClear();
    units = [unit("a"), unit("b")];
    for (let i = 0; i < 10; i++) h.fire.changed();
    expect(h.readers.readFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    await flush();
    expect(h.readers.readFile).toHaveBeenCalledTimes(1);
    expect(h.source.getSnapshot().inventory?.total).toBe(2);
    h.source.stop();
  });

  it("coming back to the window re-reads -- unless a full read finished moments ago", async () => {
    const h = harness(() => [unit("a")]);
    h.source.start();
    await flush();
    h.readers.readFile.mockClear();
    // Alt-tab back within 5 s of the last read: nothing new to learn.
    h.clock.now += 2_000;
    h.fire.returned();
    await vi.advanceTimersByTimeAsync(250);
    await flush();
    expect(h.readers.readFile).not.toHaveBeenCalled();
    // Later: the number could be stale, so read it.
    h.clock.now += 10_000;
    h.fire.returned();
    await vi.advanceTimersByTimeAsync(250);
    await flush();
    expect(h.readers.readFile).toHaveBeenCalledTimes(1);
    h.source.stop();
  });

  it("refreshNow while a read is in flight coalesces into ONE more read, never a concurrent one", async () => {
    let release: (us: CodeUnit[]) => void = () => undefined;
    let calls = 0;
    const h = harness(
      () =>
        new Promise<CodeUnit[]>((resolve) => {
          calls += 1;
          release = resolve;
        }),
    );
    h.source.start();
    await flush();
    expect(calls).toBe(1);
    void h.source.refreshNow();
    void h.source.refreshNow();
    void h.source.refreshNow();
    await flush();
    expect(calls).toBe(1);
    release([unit("a")]);
    await flush();
    expect(calls).toBe(2);
    release([unit("a"), unit("b")]);
    await flush();
    expect(calls).toBe(2);
    expect(h.source.getSnapshot().inventory?.total).toBe(2);
    h.source.stop();
  });

  it("ONE timer: three light ticks (jobs + held against the last inventory), then a full read -- never both at once", async () => {
    const units = [unit("a")];
    const h = harness(() => units);
    h.source.start();
    await flush();
    h.readers.readFile.mockClear();
    h.readers.readJobs.mockClear();
    h.readers.readJobs.mockResolvedValue({ ...NO_JOBS, total: 1, enabled: 1 });
    for (let tick = 1; tick <= 3; tick++) {
      await vi.advanceTimersByTimeAsync(15_000);
      await flush();
    }
    expect(h.readers.readFile).not.toHaveBeenCalled();
    expect(h.readers.readJobs).toHaveBeenCalledTimes(3);
    expect(h.readers.readJobs).toHaveBeenLastCalledWith(units);
    expect(h.source.getSnapshot().jobs?.total).toBe(1);
    // The fourth tick (60 s) reads the whole file -- which brings jobs too, so
    // jobs are read ONCE on that tick, not twice.
    await vi.advanceTimersByTimeAsync(15_000);
    await flush();
    expect(h.readers.readFile).toHaveBeenCalledTimes(1);
    expect(h.readers.readJobs).toHaveBeenCalledTimes(4);
    h.source.stop();
  });

  it("the full read catches code no event announces (a notebook, a custom function) within 60 s", async () => {
    let units = [unit("a")];
    const h = harness(() => units);
    h.source.start();
    await flush();
    units = [unit("a"), unit("notebook", { surfaceId: "notebook-cell" } as Partial<CodeUnit>)];
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(h.source.getSnapshot().inventory?.total).toBe(2);
    h.source.stop();
  });

  it("a hidden window does not poll", async () => {
    const h = harness(() => [unit("a")]);
    h.source.start();
    await flush();
    h.readers.readFile.mockClear();
    h.readers.readJobs.mockClear();
    h.hidden.value = true;
    await vi.advanceTimersByTimeAsync(120_000);
    await flush();
    expect(h.readers.readFile).not.toHaveBeenCalled();
    expect(h.readers.readJobs).not.toHaveBeenCalled();
    h.source.stop();
  });

  it("a file read that REJECTS becomes an error the view says, not an empty inventory", async () => {
    const h = harness(() => {
      throw new Error("backend gone");
    });
    h.source.start();
    await flush();
    const snap = h.source.getSnapshot();
    expect(snap.inventory).toBeNull();
    expect(snap.inventoryError).toBe("backend gone");
    expect(deriveCodeStatus(snap).level).toBe("unknown");
    h.source.stop();
  });

  it("a file read with GAPS carries them into the snapshot (the view then says 'at least')", async () => {
    const h = harness();
    h.readers.readFile.mockResolvedValue(fileRead([unit("a")], ["notebooks"]));
    h.source.start();
    await flush();
    expect(h.source.getSnapshot().inventoryGaps).toEqual(["notebooks"]);
    expect(deriveCodeStatus(h.source.getSnapshot()).level).toBe("unknown");
    h.source.stop();
  });

  it("a failed side read is null (said), and does not blank the reads that DID answer", async () => {
    const h = harness(() => [unit("a")]);
    h.readers.readJobs.mockRejectedValue(new Error("no scheduler"));
    h.source.start();
    await flush();
    const snap = h.source.getSnapshot();
    expect(snap.jobs).toBeNull();
    expect(snap.inventory?.total).toBe(1);
    expect(deriveCodeStatus(snap).facts.map((f) => f.id)).toContain("jobs-error");
    h.source.stop();
  });

  it("counts REFUSALS only, and repaints a burst of them at most once per throttle window", async () => {
    const h = harness();
    h.source.start();
    await flush();
    const notified = vi.fn();
    h.source.subscribe(notified);
    for (let i = 0; i < 50; i++) h.fire.audit({ ok: false, error: "PermissionDenied" });
    h.fire.audit({ ok: false, error: "ValidationError" });
    h.fire.audit({ ok: true });
    expect(h.source.getSnapshot().refusals).toBe(50);
    expect(notified).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(notified).toHaveBeenCalledTimes(1);
    h.source.stop();
  });

  it("File > New / Open starts over: refusals reset, state back to CHECKING, then the new file's read", async () => {
    let units = [unit("a"), unit("b"), unit("c")];
    const h = harness(() => units);
    h.source.start();
    await flush();
    h.fire.audit({ ok: false, error: "Revoked" });
    expect(h.source.getSnapshot().refusals).toBe(1);

    const next = deferred<CodeStatusFileRead>();
    h.readers.readFile.mockImplementationOnce(() => next.promise);
    units = [];
    h.fire.replaced();
    // Immediately: nothing from the old file survives -- not its count, not
    // its refusals -- and the new file is "checking", not "no code".
    expect(h.source.getSnapshot()).toEqual(LOADING_SNAPSHOT);
    next.resolve(fileRead([]));
    await flush();
    expect(h.source.getSnapshot().phase).toBe("ready");
    expect(h.source.getSnapshot().inventory?.total).toBe(0);
    expect(h.source.getSnapshot().refusals).toBe(0);
    h.source.stop();
  });

  it("a read of the OLD document that lands after File > Open is DROPPED -- never shown, not even briefly", async () => {
    const old = deferred<CodeStatusFileRead>();
    const fresh = deferred<CodeStatusFileRead>();
    const h = harness();
    h.readers.readFile.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise);
    h.source.start();
    await flush();
    const seen: Array<number | undefined> = [];
    h.source.subscribe(() => seen.push(h.source.getSnapshot().inventory?.total));
    // The new document is opened while the old read is still out...
    h.fire.replaced();
    // ...the old document's FIVE pieces of code land: they must not be shown.
    old.resolve(fileRead([unit("1"), unit("2"), unit("3"), unit("4"), unit("5")]));
    await flush();
    // The new document's own read has not landed: still CHECKING.
    expect(h.source.getSnapshot()).toEqual(LOADING_SNAPSHOT);
    fresh.resolve(fileRead([]));
    await flush();
    expect(h.source.getSnapshot().inventory?.total).toBe(0);
    expect(seen).not.toContain(5);
    h.source.stop();
  });

  it("an OLDER poll that lands after a newer full read is dropped (jobs never go back in time)", async () => {
    const h = harness(() => [unit("a")]);
    h.source.start();
    await flush();
    // The 15 s poll starts and hangs on its jobs read...
    const poll = deferred<ScheduledJobSummary>();
    h.readers.readJobs.mockImplementationOnce(() => poll.promise);
    await vi.advanceTimersByTimeAsync(15_000);
    // ...a full read starts AFTER it and lands first, with two jobs...
    h.readers.readJobs.mockResolvedValueOnce({ ...NO_JOBS, total: 2, enabled: 2 });
    await h.source.refreshNow();
    expect(h.source.getSnapshot().jobs?.total).toBe(2);
    // ...then the older poll lands with what it saw BEFORE: dropped.
    poll.resolve({ ...NO_JOBS, total: 1, enabled: 1 });
    await flush();
    expect(h.source.getSnapshot().jobs?.total).toBe(2);
    h.source.stop();
  });

  it("no poll runs while a full read is in flight (the full read brings the same answers)", async () => {
    const h = harness(() => [unit("a")]);
    h.source.start();
    await flush();
    const hang = deferred<CodeStatusFileRead>();
    h.readers.readFile.mockImplementationOnce(() => hang.promise);
    void h.source.refreshNow();
    await flush();
    h.readers.readJobs.mockClear();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.readers.readJobs).not.toHaveBeenCalled();
    hang.resolve(fileRead([unit("a")]));
    await flush();
    expect(h.readers.readJobs).toHaveBeenCalledTimes(1);
    h.source.stop();
  });

  it("stop() unsubscribes everything, clears the poll, and a read in flight lands nowhere", async () => {
    const hang = deferred<CodeStatusFileRead>();
    const h = harness();
    h.readers.readFile.mockImplementationOnce(() => hang.promise);
    h.source.start();
    await flush();
    h.source.stop();
    expect(h.unsubscribed()).toBe(4);
    hang.resolve(fileRead([unit("a")]));
    await flush();
    expect(h.source.getSnapshot().phase).toBe("loading");
    h.readers.readFile.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.readers.readFile).not.toHaveBeenCalled();
  });
});
