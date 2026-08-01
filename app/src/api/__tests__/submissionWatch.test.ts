//! FILENAME: app/src/api/__tests__/submissionWatch.test.ts
// PURPOSE: Cover for the §5.5 gap — publishers discovering .calp writeback
//          submissions only by POLLING — and for the honesty of the event that
//          replaces it.
// CONTEXT: There is no push. A subscriber submits by appending to a registry
//          from THEIR machine; nothing reaches the publisher's process. So
//          WRITEBACK_SUBMISSION_RECEIVED is raised by a poll, and the whole
//          question is whether that poll is honest:
//
//            - it must not run when nobody is listening (a workbook that never
//              subscribes must pay nothing);
//            - its FIRST pass must not announce history as news;
//            - it must not announce the publisher's OWN approve/reject as an
//              incoming answer;
//            - it must stop reading a region it is not entitled to read, once,
//              rather than failing forever;
//            - and the payload must not carry other respondents' answers —
//              nor, for a sandboxed script, their identities or cell positions,
//              because in a per-subscriber region the cell IS the identity.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

const invokeBackend = vi.fn();
vi.mock("../backend", () => ({
  invokeBackend: (...args: unknown[]) => invokeBackend(...args),
}));

import { AppEvents, onAppEvent } from "../events";
import type { WritebackSubmissionReceivedPayload } from "../events";
import { thinAppEventForScripts, SCRIPT_SUBSCRIBABLE_APP_EVENTS } from "../scriptHost/allowlist";
import {
  acquireSubmissionWatch,
  pollSubmissionsNow,
  whenSubmissionWatchSettled,
  getSubmissionWatchStatus,
  resetSubmissionWatch,
  SUBMISSION_POLL_INTERVAL_MS,
  MAX_REPORTED_SUBMISSIONS,
  type RegionSubmission,
} from "../distribution";

// ---------------------------------------------------------------------------
// A stand-in registry: regions this workbook knows about, and per region either
// an inbox (we are the publisher) or a refusal (we are not).
// ---------------------------------------------------------------------------

let regions: Array<{ regionId: string }> = [];
let inboxes: Record<string, RegionSubmission[]> = {};
let refusals: Record<string, string> = {};
let inboxReads = 0;

function sub(over: Partial<RegionSubmission> = {}): RegionSubmission {
  return {
    submissionId: "s1",
    regionId: "r1",
    cellRow: 3,
    cellCol: 1,
    submitterId: "u-alice",
    submitterName: "Alice",
    valueDisplay: "42",
    valueKind: "number",
    state: "submitted",
    submittedAt: "2026-08-01T09:00:00Z",
    updatedAt: "2026-08-01T09:00:00Z",
    ...over,
  };
}

function captureEvents(): { payloads: WritebackSubmissionReceivedPayload[]; stop: () => void } {
  const payloads: WritebackSubmissionReceivedPayload[] = [];
  const stop = onAppEvent<WritebackSubmissionReceivedPayload>(
    AppEvents.WRITEBACK_SUBMISSION_RECEIVED,
    (p) => payloads.push(p),
  );
  return { payloads, stop };
}

beforeEach(() => {
  resetSubmissionWatch();
  regions = [{ regionId: "r1" }];
  inboxes = { r1: [] };
  refusals = {};
  inboxReads = 0;
  invokeBackend.mockReset();
  invokeBackend.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "calp_get_writeback_regions") return regions;
    if (command === "calp_load_region_submissions") {
      const id = String(args?.regionId);
      inboxReads += 1;
      if (refusals[id]) throw new Error(refusals[id]);
      return inboxes[id] ?? [];
    }
    throw new Error(`unexpected command ${command}`);
  });
});

afterEach(() => {
  resetSubmissionWatch();
  vi.useRealTimers();
});

// ============================================================================
// Demand
// ============================================================================

describe("the watch costs nothing until something wants it", () => {
  it("does not poll at refcount zero", async () => {
    expect(getSubmissionWatchStatus().running).toBe(false);
    expect(getSubmissionWatchStatus().refCount).toBe(0);
    await Promise.resolve();
    expect(invokeBackend).not.toHaveBeenCalled();
  });

  it("starts on the first holder and stops on the last release", async () => {
    const releaseA = acquireSubmissionWatch();
    await whenSubmissionWatchSettled();
    const releaseB = acquireSubmissionWatch();
    expect(getSubmissionWatchStatus().refCount).toBe(2);
    expect(getSubmissionWatchStatus().running).toBe(true);
    releaseA();
    expect(getSubmissionWatchStatus().running).toBe(true);
    releaseB();
    expect(getSubmissionWatchStatus().refCount).toBe(0);
    expect(getSubmissionWatchStatus().running).toBe(false);
  });

  it("a release that runs twice cannot drive the count negative", () => {
    // A cleanup array that fires twice must not strand the timer by making the
    // count go to -1 and never come back to 0.
    const release = acquireSubmissionWatch();
    const other = acquireSubmissionWatch();
    release();
    release();
    release();
    expect(getSubmissionWatchStatus().refCount).toBe(1);
    other();
    expect(getSubmissionWatchStatus().running).toBe(false);
  });

  it("schedules on the disclosed interval, and one pass at a time", async () => {
    vi.useFakeTimers();
    const release = acquireSubmissionWatch();
    await vi.advanceTimersByTimeAsync(0);
    const afterPriming = invokeBackend.mock.calls.length;
    await vi.advanceTimersByTimeAsync(SUBMISSION_POLL_INTERVAL_MS - 1);
    expect(invokeBackend.mock.calls.length).toBe(afterPriming);
    await vi.advanceTimersByTimeAsync(1);
    expect(invokeBackend.mock.calls.length).toBeGreaterThan(afterPriming);
    release();
  });
});

// ============================================================================
// Honesty of the announcement
// ============================================================================

describe("what the watch announces", () => {
  it("the FIRST pass primes silently — history is not news", async () => {
    inboxes.r1 = [sub({ submissionId: "old-1" }), sub({ submissionId: "old-2", cellRow: 4 })];
    const { payloads, stop } = captureEvents();
    const release = acquireSubmissionWatch();
    await whenSubmissionWatchSettled();
    expect(payloads).toEqual([]);
    // And a second pass over the SAME inbox stays silent.
    await pollSubmissionsNow();
    expect(payloads).toEqual([]);
    stop();
    release();
  });

  it("announces a submission that arrived after the watch started", async () => {
    inboxes.r1 = [sub({ submissionId: "old-1" })];
    const { payloads, stop } = captureEvents();
    const release = acquireSubmissionWatch();
    await whenSubmissionWatchSettled();

    inboxes.r1 = [
      sub({ submissionId: "old-1" }),
      sub({ submissionId: "new-1", cellRow: 7, submitterId: "u-bob", submitterName: "Bob" }),
    ];
    await pollSubmissionsNow();

    expect(payloads).toHaveLength(1);
    expect(payloads[0].regionId).toBe("r1");
    expect(payloads[0].count).toBe(1);
    expect(payloads[0].truncated).toBe(false);
    expect(payloads[0].submissions).toEqual([
      {
        submissionId: "new-1",
        submitterId: "u-bob",
        submitterName: "Bob",
        cellRow: 7,
        cellCol: 1,
        submittedAt: "2026-08-01T09:00:00Z",
      },
    ]);
    stop();
    release();
  });

  it("NEVER carries the submitted value, even to trusted subscribers", async () => {
    // The event bus has no gate of its own. The answers stay behind the
    // publisher-gated inbox, which re-proves key possession in Rust per call.
    const { payloads, stop } = captureEvents();
    const release = acquireSubmissionWatch();
    await whenSubmissionWatchSettled();
    inboxes.r1 = [sub({ submissionId: "n", valueDisplay: "SECRET-SALARY", valueKind: "text" })];
    await pollSubmissionsNow();
    const serialized = JSON.stringify(payloads);
    expect(serialized).not.toContain("SECRET-SALARY");
    expect(serialized).not.toContain("valueDisplay");
    expect(serialized).not.toContain("valueKind");
    stop();
    release();
  });

  it("does NOT announce the publisher's own approve / reject", async () => {
    // Approving re-folds the record; announcing that would tell a publisher
    // their own click was an incoming answer.
    const { payloads, stop } = captureEvents();
    const release = acquireSubmissionWatch();
    await whenSubmissionWatchSettled();
    inboxes.r1 = [sub({ submissionId: "approved-1", state: "approved" })];
    await pollSubmissionsNow();
    inboxes.r1 = [sub({ submissionId: "rejected-1", state: "rejected" })];
    await pollSubmissionsNow();
    inboxes.r1 = [sub({ submissionId: "draft-1", state: "draft" })];
    await pollSubmissionsNow();
    expect(payloads).toEqual([]);
    stop();
    release();
  });

  it("re-announces a RESUBMISSION after a rejection", async () => {
    const { payloads, stop } = captureEvents();
    const release = acquireSubmissionWatch();
    await whenSubmissionWatchSettled();
    inboxes.r1 = [sub({ submissionId: "v1" })];
    await pollSubmissionsNow();
    expect(payloads).toHaveLength(1);
    inboxes.r1 = [sub({ submissionId: "v1", state: "rejected" })];
    await pollSubmissionsNow();
    expect(payloads).toHaveLength(1);
    inboxes.r1 = [sub({ submissionId: "v2" })];
    await pollSubmissionsNow();
    expect(payloads).toHaveLength(2);
    expect(payloads[1].submissions[0].submissionId).toBe("v2");
    stop();
    release();
  });

  it("caps the reported list but reports the exact count", async () => {
    const { payloads, stop } = captureEvents();
    const release = acquireSubmissionWatch();
    await whenSubmissionWatchSettled();
    const many = MAX_REPORTED_SUBMISSIONS + 7;
    inboxes.r1 = Array.from({ length: many }, (_, i) =>
      sub({ submissionId: `n${i}`, cellRow: i }),
    );
    await pollSubmissionsNow();
    expect(payloads[0].count).toBe(many);
    expect(payloads[0].submissions).toHaveLength(MAX_REPORTED_SUBMISSIONS);
    expect(payloads[0].truncated).toBe(true);
    stop();
    release();
  });

  it("a region first seen mid-session primes rather than announcing", async () => {
    const { payloads, stop } = captureEvents();
    const release = acquireSubmissionWatch();
    await whenSubmissionWatchSettled();
    regions = [{ regionId: "r1" }, { regionId: "r2" }];
    inboxes.r2 = [sub({ regionId: "r2", submissionId: "pre-existing" })];
    await pollSubmissionsNow();
    expect(payloads).toEqual([]);
    inboxes.r2 = [
      sub({ regionId: "r2", submissionId: "pre-existing" }),
      sub({ regionId: "r2", submissionId: "genuinely-new", cellRow: 9 }),
    ];
    await pollSubmissionsNow();
    expect(payloads.map((p) => p.regionId)).toEqual(["r2"]);
    stop();
    release();
  });
});

// ============================================================================
// Bounded cost
// ============================================================================

describe("the poll is bounded", () => {
  it("stops reading a region this machine does not publish — after ONE refusal", async () => {
    refusals.r1 = "Only the publisher of 'Q3 Report' can view or manage its writeback submissions.";
    const release = acquireSubmissionWatch();
    await whenSubmissionWatchSettled();
    expect(inboxReads).toBe(1);
    await pollSubmissionsNow();
    await pollSubmissionsNow();
    // Still one: the region is skipped, so a subscriber-only workbook settles at
    // one region-list call per interval and no inbox reads at all.
    expect(inboxReads).toBe(1);
    const status = getSubmissionWatchStatus();
    expect(status.skippedRegionIds).toEqual(["r1"]);
    expect(status.watchedRegionIds).toEqual([]);
    release();
  });

  it("a TRANSIENT failure is retried, not permanently skipped", async () => {
    // A missing network share must be retried; a missing signing key never
    // succeeds. Only the publisher refusal disables a region.
    refusals.r1 = "The system cannot find the path specified. (os error 3)";
    const release = acquireSubmissionWatch();
    await whenSubmissionWatchSettled();
    expect(getSubmissionWatchStatus().skippedRegionIds).toEqual([]);
    expect(getSubmissionWatchStatus().lastError).toMatch(/os error 3/);
    delete refusals.r1;
    inboxes.r1 = [sub({ submissionId: "after-recovery" })];
    await pollSubmissionsNow();
    expect(getSubmissionWatchStatus().watchedRegionIds).toEqual(["r1"]);
    expect(getSubmissionWatchStatus().lastError).toBeNull();
    release();
  });

  it("a pass costs one region list plus one read per WATCHED region", async () => {
    regions = [{ regionId: "r1" }, { regionId: "r2" }];
    inboxes.r2 = [];
    const release = acquireSubmissionWatch();
    await whenSubmissionWatchSettled();
    expect(getSubmissionWatchStatus().lastPollCalls).toBe(3);
    release();
  });

  it("a failing region-list does not throw at the caller and is disclosed", async () => {
    invokeBackend.mockImplementation(async () => {
      throw new Error("registry unreachable");
    });
    const release = acquireSubmissionWatch();
    await expect(whenSubmissionWatchSettled()).resolves.toBeUndefined();
    expect(getSubmissionWatchStatus().lastError).toMatch(/registry unreachable/);
    release();
  });

  it("forgets state for a region that has gone away", async () => {
    regions = [{ regionId: "r1" }, { regionId: "r2" }];
    refusals.r2 = "Only the publisher of 'X' can view or manage its writeback submissions.";
    const release = acquireSubmissionWatch();
    await whenSubmissionWatchSettled();
    expect(getSubmissionWatchStatus().skippedRegionIds).toEqual(["r2"]);
    regions = [{ regionId: "r1" }];
    await pollSubmissionsNow();
    expect(getSubmissionWatchStatus().skippedRegionIds).toEqual([]);
    release();
  });
});

// ============================================================================
// The sandbox boundary
// ============================================================================

describe("the sandboxed-script view of the event", () => {
  it("is subscribable by scripts", () => {
    expect(SCRIPT_SUBSCRIBABLE_APP_EVENTS.has(AppEvents.WRITEBACK_SUBMISSION_RECEIVED)).toBe(true);
  });

  it("is THINNED to { regionId, count } — no identity, no position, no value", () => {
    // In a per-subscriber writeback region the cell coordinates ARE the
    // identity, so "row 7" and "Alice" are the same disclosure. Neither may
    // cross into a sandbox that has no sanctioned way to enumerate respondents.
    const full: WritebackSubmissionReceivedPayload = {
      regionId: "r1",
      count: 2,
      submissions: [
        {
          submissionId: "s1",
          submitterId: "u-alice",
          submitterName: "Alice",
          cellRow: 7,
          cellCol: 1,
          submittedAt: "2026-08-01T09:00:00Z",
        },
      ],
      truncated: false,
      observedAt: "2026-08-01T09:01:00Z",
    };
    const thinned = thinAppEventForScripts(AppEvents.WRITEBACK_SUBMISSION_RECEIVED, full);
    expect(thinned).toEqual({ regionId: "r1", count: 2 });
    const serialized = JSON.stringify(thinned);
    for (const leak of ["Alice", "u-alice", "cellRow", "submissionId", "observedAt"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("survives a malformed payload without throwing", () => {
    expect(thinAppEventForScripts(AppEvents.WRITEBACK_SUBMISSION_RECEIVED, null)).toEqual({
      regionId: undefined,
      count: 0,
    });
  });

  it("uses the app: prefix like every other event id", () => {
    expect(AppEvents.WRITEBACK_SUBMISSION_RECEIVED).toBe("app:writeback-submission-received");
  });
});

// ============================================================================
// The demand wiring, read out of source
// ============================================================================

describe("subscribing is what starts the poll, and unsubscribing stops it", () => {
  const read = (rel: string): string =>
    fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");

  it("the object-script host acquires a watch and releases it with the forwarder", () => {
    const src = read("scriptHost/host.ts");
    expect(src).toMatch(
      /if \(eventName === AppEvents\.WRITEBACK_SUBMISSION_RECEIVED\)[\s\S]{0,400}acquireSubmissionWatch\(\)/,
    );
    // The release must be part of the forwarder teardown, so unmount, fault and
    // an explicit unsubscribe all give it back — a script that is gone must not
    // leave a timer polling a registry on its behalf.
    expect(src).toMatch(/addForwarder\(mw, hook, \(\) => \{[\s\S]{0,200}releasing\.then\(\(release\) => release\?\.\(\)\)/);
  });

  it("the sandboxed-extension host does the same", () => {
    const src = read("scriptHost/extensionWorkerHost.ts");
    expect(src).toMatch(
      /if \(eventName === AppEvents\.WRITEBACK_SUBMISSION_RECEIVED\)[\s\S]{0,400}acquireSubmissionWatch\(\)/,
    );
    expect(src).toMatch(/regCleanups\.set\(reg\.regId, \(\) => \{[\s\S]{0,200}releasing\.then/);
  });

  it("the Responses pane holds a watch only while it is open", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../../extensions/Distribution/components/PublisherDashboardPane.tsx"),
      "utf8",
    );
    expect(src).toContain("const release = acquireSubmissionWatch();");
    expect(src).toMatch(/return \(\) => \{[\s\S]{0,120}release\(\);/);
  });

  it("the event id is documented as poll-backed on the authoring surface", () => {
    // A script author must not be told to expect an instant push.
    const typings = fs.readFileSync(
      path.resolve(__dirname, "../../../extensions/ScriptableObjects/objectContexts.d.ts"),
      "utf8",
    );
    expect(typings).toContain("app:writeback-submission-received");
    expect(typings).toMatch(/poll of the publisher inbox/i);
    expect(typings).toMatch(/up to a minute/i);
  });
});
