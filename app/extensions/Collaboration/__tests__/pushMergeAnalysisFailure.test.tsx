//! FILENAME: app/extensions/Collaboration/__tests__/pushMergeAnalysisFailure.test.tsx
// PURPOSE: A failed merge analysis is asked ONCE, says why, and is asked again
//          only by the author (the banner's Try again) or for another base or
//          head -- never by itself in a loop (review round 8, REFUSAL-UX F2).
// CONTEXT: When the working copy's base is stale, the push dialog asks
//          `pushMergeAnalyze` whether the intervening work overlaps the
//          author's. Its catch swallowed every failure and set `merge` back to
//          null and `mergeBusy` back to false -- exactly the effect's trigger --
//          so a refusal re-ran the analysis at once, without end: measured on
//          the mounted dialog, 0, 55, 128, 204, 286, 369 calls at 50 ms
//          samples. In the app each pass is a full in-memory publish plus two
//          audited reads of the workspace, and a signer refusal writes an audit
//          row on every one -- under a banner that said "Working out whether
//          their changes overlap yours..." for as long as the dialog stayed
//          open.
//
//          MOUNTED, with only the Tauri boundary (@api) doubled; the doubles
//          reject with the bare string, the shape Tauri gives a
//          `Result<_, String>` command.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PublishReport, VersionDiff, WorkingCopyStatus } from "@api";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** The retryable refusal exactly as Rust formats it for the merge door. */
const MERGE_REFUSAL =
  "WORKBOOK_CHANGED_WHILE_SAVING: the workbook changed while it was being merged -- a sheet was " +
  "added, deleted or moved during each of 3 attempts to read it. Nothing was written; try again.";
const MERGE_PLAIN =
  "The workbook changed while it was being merged -- a sheet was added, deleted or moved during " +
  "each of 3 attempts to read it. Nothing was written; try again.";
/** A refusal that can never succeed by asking again: the head's signer is not authorised. */
const SIGNER_REFUSAL =
  "Refused sales v1.1.0 (merge): signed by Mallory (key ab12), who is not an authorised publisher";

const h = vi.hoisted(() => ({
  /** Calls to pushMergeAnalyze so far. */
  analyses: 0,
  /** One entry per coming analysis; a string REJECTS with it. Empty = the last answer repeats. */
  analysisAnswers: [] as (string | undefined)[],
  lastAnswer: undefined as string | undefined,
  /** What the workspace head is (the preview's gates read it). */
  registryLatest: "1.1.0",
}));

const REPORT: PublishReport = {
  included: [{ category: "sheets", count: 1, detail: "cell data" }],
  excluded: [],
  withheld: [],
  addedToApplication: [],
  buttonCode: { restored: [], refused: [], unreviewed: [], withheld: [] },
  unshippedMacroLinks: [],
};

const EMPTY_DIFF: VersionDiff = {
  packageName: "sales",
  fromVersion: "1.0.0",
  toVersion: "working copy",
  artifacts: { added: [], removed: [], changed: [], spuriousHashChanges: 0, unchangedCount: 0 },
  sheets: [],
  objects: [],
  manifestChanges: [],
  totals: {
    objectsAdded: 0,
    objectsRemoved: 0,
    objectsModified: 0,
    sheetsChanged: 0,
    cellsChanged: 0,
    cellsChangedExact: true,
  },
};

function status(): WorkingCopyStatus {
  return {
    registryUrl: "\\\\server\\apps",
    packageName: "sales",
    kind: "report",
    baseVersion: "1.0.0",
    checkedOutAt: "2026-09-30T00:00:00Z",
    lastPushedVersion: "",
    lastPushedAt: "",
    baseSheets: [],
    registryReachable: true,
    headVersion: h.registryLatest,
    isStale: true,
    versions: [],
    suggestedNext: { major: "2.0.0", minor: "1.1.0", patch: "1.0.1" },
    holdsPublisherKey: true,
    registryError: "",
    environments: [],
    youMayPromote: true,
    baseIsPromoted: null,
  };
}

vi.mock("@api", () => ({
  publishPreview: vi.fn(async () => ({
    sheetNames: ["Dashboard"],
    report: REPORT,
    warnings: [],
    gates: {
      linkStatus: "linked",
      expectedBase: "1.0.0",
      registryLatest: h.registryLatest,
      latestPublishedBy: "",
      baseStale: true,
      keyContinuityOk: true,
      registryWritable: true,
      registryError: "",
    },
    sheets: [
      { index: 0, sheetId: "sheet-dash", name: "Dashboard", subscribedTo: "", defaultSelected: true, kind: "worksheet" },
    ],
    defaultSheetIndices: [0],
  })),
  publishApplication: vi.fn(),
  diffWorkingCopy: vi.fn(async () => ({
    packageName: "sales",
    baseVersion: "1.0.0",
    diff: EMPTY_DIFF,
    code: { codeChanges: [], asksApprovalAgain: false, codeError: null },
  })),
  workingCopyStatus: vi.fn(async () => status()),
  pushMergeAnalyze: vi.fn(async () => {
    h.analyses += 1;
    const answer = h.analysisAnswers.length > 0 ? h.analysisAnswers.shift() : h.lastAnswer;
    h.lastAnswer = answer;
    // A real round trip takes time. Answering after a short REAL delay is also
    // what lets a loop show as a count: a double that settles in a microtask
    // keeps React's act() flushing a loop forever, and the test dies by timeout
    // instead of on the count it is about.
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (typeof answer === "string") throw answer;
    return {
      packageName: "sales",
      baseVersion: "1.0.0",
      headVersion: h.registryLatest,
      headSigner: {
        name: "Ada",
        key: "ab",
        fingerprint: "ab",
        role: "root",
        listedAs: "",
        rootName: "Ada",
        rootFingerprint: "ab",
        isYou: false,
      },
      headChangeSummary: "",
      analysis: {
        verdict: "canMerge",
        collisions: [],
        theirSummary: ["Sheet Dashboard: 1 cell"],
        yourSummary: ["Sheet Dashboard: 2 cells"],
        unmergeable: [],
      },
    };
  }),
  pushMergeApply: vi.fn(),
  undo: vi.fn(),
  showDialog: vi.fn(),
  listApplicationsInWorkspace: vi.fn(async () => []),
  emitAppEvent: vi.fn(),
  ENVIRONMENTS_CHANGED_EVENT: "environments-changed",
  openPanel: vi.fn(),
  // PublishReportView's module (ApplicationExplorerPanel)
  getSubscriptions: vi.fn(async () => ({ subscriptions: [] })),
  getApplicationObjects: vi.fn(),
  activateSheet: vi.fn(),
  onAppEvent: vi.fn(() => () => undefined),
  AppEvents: {},
}));
vi.mock("@api/collaboration", () => ({ holdBackCells: vi.fn() }));
vi.mock("@api/collaborationWorkspaces", () => ({ listWorkspaces: vi.fn(async () => []) }));
vi.mock("../manifest", () => ({ CHECKOUT_DIALOG_ID: "checkout", APPLICATION_EXPLORER_PANEL_ID: "explorer" }));
vi.mock("../lib/pickWorkspace", () => ({ pickWorkspaceFile: vi.fn(), pickWorkspaceFolder: vi.fn() }));
vi.mock("../lib/openApplicationInspectorWindow", () => ({ openApplicationInspectorWindow: vi.fn() }));

import { PublishDialog } from "../components/PublishDialog";

let container: HTMLDivElement;
let root: Root;

/**
 * Let `ms` of REAL time pass, inside act(), in short steps, settling the
 * microtasks after each. The doubled analysis answers after 5 ms, so a loop
 * re-asks it dozens of times over the default -- a count that stays put over
 * this long is a count that is not looping.
 */
async function settle(ms = 300): Promise<void> {
  for (let waited = 0; waited < ms; waited += 25) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }
}

async function click(el: HTMLElement | null | undefined): Promise<void> {
  expect(el, "the control is not on screen").toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

const buttonNamed = (name: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
const analysisRetry = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-testid="merge-analysis-retry"]');
const screenText = (): string => container.textContent ?? "";

async function open(openCount = 1): Promise<void> {
  await act(async () => {
    root.render(<PublishDialog isOpen onClose={vi.fn()} data={{ __openCount: openCount }} />);
  });
  await settle();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  h.analyses = 0;
  h.analysisAnswers.length = 0;
  h.lastAnswer = undefined;
  h.registryLatest = "1.1.0";
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("a merge analysis that fails", () => {
  // SABOTAGE: drop `mergeFailure?.key !== mergeKey` from the analysis effect's
  // condition -- every refusal re-asks at once, and the count runs away.
  it("is asked ONCE, and says why in plain words instead of 'Working out...'", async () => {
    h.analysisAnswers.push(MERGE_REFUSAL);
    await open();
    await settle(400);
    expect(h.analyses, "the failed analysis re-ran itself").toBe(1);
    expect(screenText()).toContain(`Could not work out whether their changes overlap yours: ${MERGE_PLAIN}`);
    expect(screenText(), "the banner kept saying it was working").not.toContain("Working out whether");
    expect(screenText(), "the raw code reached the screen").not.toContain("WORKBOOK_CHANGED_WHILE_SAVING");
  });

  // SABOTAGE: make the banner's Try again do nothing (or render no button).
  it("Try again asks exactly once more -- and a success then offers the merge", async () => {
    h.analysisAnswers.push(MERGE_REFUSAL, undefined);
    await open();
    expect(h.analyses).toBe(1);
    await click(analysisRetry());
    expect(h.analyses, "Try again did not ask exactly once more").toBe(2);
    expect(buttonNamed("Merge with v1.1.0"), "the successful analysis was not shown").toBeTruthy();
    expect(screenText()).not.toContain("Could not work out");
  });

  it("a refusal that can never succeed by asking again (an unauthorised signer) is said in full, still once", async () => {
    h.analysisAnswers.push(SIGNER_REFUSAL);
    await open();
    await settle(400);
    expect(h.analyses).toBe(1);
    expect(screenText()).toContain(SIGNER_REFUSAL);
    // And a Try again that fails the same way stays at one more.
    await click(analysisRetry());
    await settle(400);
    expect(h.analyses).toBe(2);
  });

  it("a NEW head gets one fresh analysis of its own", async () => {
    h.lastAnswer = SIGNER_REFUSAL;
    await open();
    expect(h.analyses).toBe(1);
    // The workspace moves on; Preview re-reads the gates.
    h.registryLatest = "1.2.0";
    await click(buttonNamed("Preview"));
    await settle(400);
    expect(h.analyses, "the new head was not analysed, or was analysed in a loop").toBe(2);
  });

  it("a successful analysis is asked once too (the positive control)", async () => {
    await open();
    await settle(400);
    expect(h.analyses).toBe(1);
    expect(buttonNamed("Merge with v1.1.0")).toBeTruthy();
  });
});
