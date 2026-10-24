//! FILENAME: app/extensions/Collaboration/__tests__/pushSnapshotRefusal.test.tsx
// PURPOSE: The push dialog says the backend's RETRYABLE snapshot refusal in
//          plain words -- never its internal code -- and offers to run the
//          refused act again at once where that act has a button of its own.
// CONTEXT: Rust refuses a publish, its preview, the working-copy diff and the
//          merge with "WORKBOOK_CHANGED_WHILE_SAVING: the workbook changed while
//          it was being published -- ..." when a sheet renumbering (an agent
//          deleting or moving sheets) kept landing inside its snapshot
//          (persistence.rs `take_consistent_snapshot`). `explainPushError`
//          stripped only CALP_(PUSH|MERGE)_ codes, so push, preview and diff
//          showed the raw code -- which the dialog's own doc comment says users
//          must never see. The ONE recogniser is @api/backendRefusal (pinned
//          against Rust by src/api/__tests__/backendRefusal.test.ts); this file
//          pins the dialog's half, MOUNTED, with only the Tauri boundary (@api)
//          doubled. The doubles reject with the BARE string, the shape Tauri
//          gives a `Result<_, String>` command.
//
//            * push / preview / merge: the plain sentence in the answer strip,
//              and "Try again" runs the same act through its own handler;
//            * the diff: the plain sentence (and the code summary's), no retry
//              -- it has no button of its own;
//            * every other error reads exactly as before, and is never offered
//              a retry; a retry's DIFFERENT failure does not inherit the button.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PublishReport, VersionDiff, WorkingCopyStatus } from "@api";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** The refusal exactly as Rust formats it today for the publish door. */
const REFUSAL =
  "WORKBOOK_CHANGED_WHILE_SAVING: the workbook changed while it was being published -- a sheet was " +
  "added, deleted or moved during each of 3 attempts to read it. Nothing was written; try again.";
/** What the person reads instead. */
const PLAIN =
  "The workbook changed while it was being published -- a sheet was added, deleted or moved during " +
  "each of 3 attempts to read it. Nothing was written; try again.";
const CODE = "WORKBOOK_CHANGED_WHILE_SAVING";

const h = vi.hoisted(() => ({
  published: [] as Record<string, unknown>[],
  previews: [] as unknown[][],
  merges: 0,
  /** One entry per coming call; a string REJECTS with it (bare, as Tauri does). Empty = success. */
  publishAnswers: [] as (string | undefined)[],
  /** Rejections for the coming previews; armed after open, so only the Preview button meets them. */
  previewAnswers: [] as (string | undefined)[],
  mergeAnswers: [] as (string | undefined)[],
  /** Every working-copy diff rejects with this when set. */
  diffRejection: null as string | null,
  /** The base is stale (the merge banner shows "Merge with ..."). */
  stale: false,
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
    headVersion: h.stale ? "1.1.0" : "1.0.0",
    isStale: h.stale,
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
  publishPreview: vi.fn(async (...args: unknown[]) => {
    h.previews.push(args);
    const answer = h.previewAnswers.shift();
    if (typeof answer === "string") throw answer;
    return {
      sheetNames: ["Dashboard"],
      report: REPORT,
      warnings: [],
      gates: {
        linkStatus: "linked",
        expectedBase: "1.0.0",
        registryLatest: h.stale ? "1.1.0" : "1.0.0",
        latestPublishedBy: "",
        baseStale: h.stale,
        keyContinuityOk: true,
        registryWritable: true,
        registryError: "",
      },
      sheets: [
        { index: 1, sheetId: "sheet-dash", name: "Dashboard", subscribedTo: "", defaultSelected: true, kind: "worksheet" },
      ],
      defaultSheetIndices: [1],
    };
  }),
  publishApplication: vi.fn(async (params: Record<string, unknown>) => {
    h.published.push(params);
    const answer = h.publishAnswers.shift();
    if (typeof answer === "string") throw answer;
    return {
      packageName: "sales",
      version: "1.0.1",
      sheetsPublished: 1,
      tablesPublished: 0,
      namedRangesPublished: 0,
      scriptsPublished: 0,
      modulesPublished: 0,
      notebooksPublished: 0,
      report: REPORT,
      warnings: [],
    };
  }),
  diffWorkingCopy: vi.fn(async () => {
    if (h.diffRejection !== null) throw h.diffRejection;
    return {
      packageName: "sales",
      baseVersion: "1.0.0",
      diff: EMPTY_DIFF,
      code: { codeChanges: [], asksApprovalAgain: false, codeError: null },
    };
  }),
  workingCopyStatus: vi.fn(async () => status()),
  pushMergeAnalyze: vi.fn(async () => ({
    packageName: "sales",
    baseVersion: "1.0.0",
    headVersion: "1.1.0",
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
  })),
  pushMergeApply: vi.fn(async () => {
    h.merges += 1;
    const answer = h.mergeAnswers.shift();
    if (typeof answer === "string") throw answer;
    return { mergedFromVersion: "1.1.0", cellsApplied: 1, sheetsTouched: ["Dashboard"] };
  }),
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

async function flush(): Promise<void> {
  for (let i = 0; i < 14; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function click(el: HTMLElement | null | undefined): Promise<void> {
  expect(el, "the control is not on screen").toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

const buttonNamed = (name: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
const retryButton = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-testid="publish-dialog-retry"]');
/** Everything a person can read in the dialog. */
const screenText = (): string => container.textContent ?? "";

async function typeSummary(text: string): Promise<void> {
  const summary = container.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(summary, text);
    summary.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

async function open(): Promise<void> {
  await act(async () => {
    root.render(<PublishDialog isOpen onClose={vi.fn()} data={{}} />);
  });
  await flush();
}

/** Open, fill the one field a push requires, and press Push. */
async function openAndPush(): Promise<void> {
  await open();
  await typeSummary("Adds the regional split.");
  await click(buttonNamed("Push"));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  h.published.length = 0;
  h.previews.length = 0;
  h.merges = 0;
  h.publishAnswers.length = 0;
  h.previewAnswers.length = 0;
  h.mergeAnswers.length = 0;
  h.diffRejection = null;
  h.stale = false;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("push: the plain sentence, and Try again", () => {
  // SABOTAGE: drop the recogniser from explainPushError -- the raw code shows.
  it("a refused push says the sentence, never the code", async () => {
    h.publishAnswers.push(REFUSAL);
    await openAndPush();
    expect(h.published).toHaveLength(1);
    expect(screenText()).toContain(PLAIN);
    expect(screenText(), "the raw code reached the screen").not.toContain(CODE);
  });

  // SABOTAGE: never set `retry` (or render the button unconditionally / never).
  it("offers Try again, which pushes again through the same handler, and the retried push lands", async () => {
    h.publishAnswers.push(REFUSAL);
    await openAndPush();
    expect(retryButton(), "no retry was offered for the retryable refusal").toBeTruthy();
    await click(retryButton());
    expect(h.published, "Try again did not push again").toHaveLength(2);
    // The SAME push: the retry is the Push button's own handler, not a copy --
    // and it names the SAME SHEETS, by stable id (review round 9). Equal
    // positions were the wrong thing to want: the refusal means the sheet list
    // was renumbered, so a position may now name another sheet
    // (pushSheetsById.test.tsx proves the retry against a moved list).
    expect(h.published[1].sheetIds, "the retry did not name the ticked sheet by id").toEqual(["sheet-dash"]);
    expect(h.published[1]).toEqual(h.published[0]);
    expect(screenText()).toContain("Pushed sales v1.0.1");
    expect(retryButton(), "the retry outlived the push it was for").toBeNull();
    expect(screenText()).not.toContain(CODE);
  });

  // SABOTAGE: drop the `retry.shown === error` condition from the strip. The
  // push's own validation sets its sentence WITHOUT touching `retry`, so only
  // that check keeps the button away from it.
  it("a later error of another kind never inherits the button", async () => {
    h.publishAnswers.push(REFUSAL);
    await openAndPush();
    expect(retryButton()).toBeTruthy();
    await typeSummary("");
    await click(buttonNamed("Push"));
    expect(h.published, "an empty summary still pushed").toHaveLength(1);
    expect(screenText()).toContain("Say what changed.");
    expect(screenText()).not.toContain(PLAIN);
    expect(retryButton(), "the validation error inherited the retry").toBeNull();
  });

  // SABOTAGE (both halves together -- either alone is covered by the other):
  // never clear `retry` on a non-retryable failure AND drop the strip's text
  // check.
  it("a retry that fails DIFFERENTLY shows that error as it is, and offers no retry", async () => {
    h.publishAnswers.push(REFUSAL, "disk full");
    await openAndPush();
    await click(retryButton());
    expect(h.published).toHaveLength(2);
    expect(screenText()).toContain("disk full");
    expect(screenText()).not.toContain(PLAIN);
    expect(retryButton(), "a different error inherited the retry").toBeNull();
  });
});

describe("preview and merge: the plain sentence, and Try again", () => {
  // SABOTAGE: put `setError(String(err))` back in runPreview's catch.
  it("a refused Preview says the sentence and retries the same preview", async () => {
    await open();
    const before = h.previews.length;
    h.previewAnswers.push(REFUSAL);
    await click(buttonNamed("Preview"));
    expect(h.previews.length).toBe(before + 1);
    expect(screenText()).toContain(PLAIN);
    expect(screenText()).not.toContain(CODE);
    expect(retryButton(), "no retry was offered for the refused preview").toBeTruthy();

    await click(retryButton());
    expect(h.previews.length, "Try again did not preview again").toBe(before + 2);
    expect(h.previews[before + 1]).toEqual(h.previews[before]);
    expect(screenText()).toContain("Preview — would publish Dashboard");
    expect(retryButton()).toBeNull();
  });

  // SABOTAGE: route handleMerge's catch around the recogniser (raw String(err)).
  it("a refused merge says the sentence and Try again merges again", async () => {
    h.stale = true;
    await open();
    const merge = buttonNamed("Merge with v1.1.0");
    expect(merge, "the stale banner offers no merge").toBeTruthy();
    h.mergeAnswers.push(REFUSAL);
    await click(merge);
    expect(h.merges).toBe(1);
    expect(screenText()).toContain(PLAIN);
    expect(screenText()).not.toContain(CODE);
    expect(retryButton(), "no retry was offered for the refused merge").toBeTruthy();

    const previewsBefore = h.previews.length;
    await click(retryButton());
    expect(h.merges, "Try again did not merge again").toBe(2);
    // The merge landed: its handler went on to re-read the link and preview
    // again (whose status replaces "Merged with ..."), and the refusal is gone.
    expect(h.previews.length, "the merge's own follow-up preview never ran").toBeGreaterThan(previewsBefore);
    expect(screenText()).not.toContain(PLAIN);
    expect(retryButton()).toBeNull();
  });
});

describe("the working-copy diff: the plain sentence, no retry of its own", () => {
  // SABOTAGE: setDiffError(String(e)) in the diff's catch, or a
  // promotionCodeFailed that keeps the raw reason.
  it("the diff panel and the code summary both say the sentence; nothing offers a retry", async () => {
    h.diffRejection = REFUSAL;
    await open();
    expect(screenText()).toContain(`Could not compare against v1.0.0: ${PLAIN}`);
    expect(container.querySelector("[data-promotion-code]")?.getAttribute("data-promotion-code")).toBe("failed");
    expect(container.querySelector("[data-promotion-code-headline]")?.textContent).toBe(
      `Code: the comparison failed: ${PLAIN}`,
    );
    expect(screenText(), "the raw code reached the screen").not.toContain(CODE);
    expect(retryButton(), "the diff has no button of its own to retry").toBeNull();
  });
});

describe("every other error reads exactly as before, and is never offered a retry", () => {
  it("a CALP gate refusal is still stripped to its own sentence", async () => {
    h.publishAnswers.push("CALP_PUSH_STALE_BASE: v1.2.0 landed while you were working. Merge first.");
    await openAndPush();
    expect(screenText()).toContain("v1.2.0 landed while you were working. Merge first.");
    expect(screenText()).not.toContain("CALP_PUSH_STALE_BASE");
    expect(retryButton()).toBeNull();
  });

  it("a plain push failure is shown as it came", async () => {
    h.publishAnswers.push("the share is read-only");
    await openAndPush();
    expect(screenText()).toContain("the share is read-only");
    expect(retryButton()).toBeNull();
  });

  it("a plain preview failure is shown as it came (String(err))", async () => {
    await open();
    h.previewAnswers.push("CALP_WORKSPACE_UNREADABLE: the share is gone");
    await click(buttonNamed("Preview"));
    expect(screenText()).toContain("CALP_WORKSPACE_UNREADABLE: the share is gone");
    expect(retryButton()).toBeNull();
  });

  it("a plain diff failure is shown as it came", async () => {
    h.diffRejection = "CALP_WORKSPACE_UNREADABLE: the share is gone";
    await open();
    expect(screenText()).toContain("Could not compare against v1.0.0: CALP_WORKSPACE_UNREADABLE: the share is gone");
  });
});
