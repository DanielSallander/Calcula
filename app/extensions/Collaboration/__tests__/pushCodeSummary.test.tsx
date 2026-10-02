//! FILENAME: app/extensions/Collaboration/__tests__/pushCodeSummary.test.tsx
// PURPOSE: The push preview shows the CODE this push changes FIRST, the way the
//          Promote dialog shows a promotion's (owner question 14): base version
//          -> what this push would publish, and what each change means for
//          everyone on the development line.
// CONTEXT: A push is where a developer decides what code goes out under their
//          key, and the push dialog showed code only inside the cell diff -- a
//          changed macro among the edits. The backend now answers the
//          working-copy diff with the code summary when asked
//          (`codeSummary: true`, app/src-tauri/src/calp_diff.rs
//          `push_code_summary`, behaviour-tested in
//          calp_push_code_summary_tests.rs). Pinned here, with the dialog
//          MOUNTED and only the Tauri boundary (@api) doubled:
//            * the dialog asks for the code with the diff it already fetches;
//            * the summary is the FIRST thing the review side shows;
//            * every word is the Promote dialog's (one component, one table),
//              said about the development line, which is who receives a push;
//            * a failed comparison -- a named `codeError`, a rejected read, an
//              answer with no code at all -- is SAID, never shown as "no code
//              changes", and never with the promotion's "Promoting still works".

import fs from "fs";
import path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PublishReport, VersionDiff, WorkingCopyStatus } from "@api";
import type { PromotionCodeChange, WorkingCopyCode, WorkingCopyDiff } from "@api/collaboration";

const h = vi.hoisted(() => ({
  diffs: [] as Record<string, unknown>[],
  /** What the doubled working-copy diff answers with; a string REJECTS with it. */
  diffAnswer: null as unknown,
}));

const REPORT: PublishReport = {
  included: [{ category: "sheets", count: 1, detail: "cell data" }],
  excluded: [],
  withheld: [],
  addedToApplication: [],
  buttonCode: { restored: [], refused: [], unreviewed: [], withheld: [] },
  unshippedMacroLinks: [],
};

const STATUS: WorkingCopyStatus = {
  registryUrl: "\\\\server\\apps",
  packageName: "sales",
  kind: "report",
  baseVersion: "1.0.0",
  checkedOutAt: "2026-09-30T00:00:00Z",
  lastPushedVersion: "",
  lastPushedAt: "",
  baseSheets: [],
  registryReachable: true,
  headVersion: "1.0.0",
  isStale: false,
  versions: [],
  suggestedNext: { major: "2.0.0", minor: "1.1.0", patch: "1.0.1" },
  holdsPublisherKey: true,
  registryError: "",
  environments: [],
  youMayPromote: true,
  baseIsPromoted: null,
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

vi.mock("@api", () => ({
  publishPreview: vi.fn(async () => ({
    sheetNames: ["Dashboard"],
    report: REPORT,
    warnings: [],
    gates: {
      linkStatus: "linked",
      expectedBase: "1.0.0",
      registryLatest: "1.0.0",
      latestPublishedBy: "",
      baseStale: false,
      keyContinuityOk: true,
      registryWritable: true,
      registryError: "",
    },
    sheets: [
      { index: 1, sheetId: "sheet-dash", name: "Dashboard", subscribedTo: "", defaultSelected: true, kind: "worksheet" },
    ],
    defaultSheetIndices: [1],
  })),
  publishApplication: vi.fn(),
  diffWorkingCopy: vi.fn(async (params: Record<string, unknown>) => {
    h.diffs.push(params);
    if (typeof h.diffAnswer === "string") throw new Error(h.diffAnswer);
    return h.diffAnswer;
  }),
  workingCopyStatus: vi.fn(async () => STATUS),
  pushMergeAnalyze: vi.fn(async () => null),
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
import { PromotionCodeSummary } from "../components/PromotionCodeSummary";
import {
  CODE_SUMMARY_FAILED_NOTE,
  PROMOTION_CODE_CONSEQUENCE,
  PUSH_CODE_AUDIENCE,
  promotionCodeFailed,
} from "../lib/promotionCode";

const APP_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP_ROOT, rel), "utf8");
/** Comments quote the defects they removed, so scanners must not read them. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function change(overrides: Partial<PromotionCodeChange> = {}): PromotionCodeChange {
  return {
    kind: "macro",
    id: "mod-report",
    name: "Report",
    sheetName: null,
    change: "modified",
    detail: "",
    consequence: "asksApprovalAgain",
    before: "return 1;",
    after: "return 2;",
    beforeTruncated: false,
    afterTruncated: false,
    addedCapabilities: [],
    ...overrides,
  };
}

function answer(codePart: WorkingCopyCode | null): WorkingCopyDiff {
  return { packageName: "sales", baseVersion: "1.0.0", diff: EMPTY_DIFF, code: codePart };
}

const TWO_CHANGES: WorkingCopyCode = {
  codeChanges: [
    change(),
    change({ id: "mod-extra", name: "Extra", change: "added", before: null, after: "return 3;" }),
  ],
  asksApprovalAgain: true,
  codeError: null,
};

let container: HTMLDivElement;
let root: Root;
const q = (sel: string) => container.querySelector<HTMLElement>(sel);

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function open(): Promise<void> {
  await act(async () => {
    root.render(<PublishDialog onClose={vi.fn()} data={{}} />);
  });
  await flush();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  h.diffs.length = 0;
  h.diffAnswer = answer(TWO_CHANGES);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the push preview shows the code this push changes, first", () => {
  // SABOTAGE: drop `codeSummary: true` from the dialog's diffWorkingCopy call.
  it("asks for the code with the diff it already fetches", async () => {
    await open();
    expect(h.diffs.length, "the push preview never asked for its diff").toBeGreaterThan(0);
    expect(h.diffs[h.diffs.length - 1].codeSummary).toBe(true);
  });

  // SABOTAGE: render the summary after the "Changes since" block, or not at all.
  it("is the first thing the review side shows", async () => {
    await open();
    const review = q('[data-testid="publish-dialog-review"]');
    expect(review, "the review side is not on screen").toBeTruthy();
    const summary = review!.querySelector<HTMLElement>("[data-promotion-code]");
    expect(summary, "the push preview shows no code summary").toBeTruthy();
    expect(summary!.dataset.promotionCode).toBe("ready");
    expect(summary!.dataset.codeSummaryAct).toBe("push");
    expect(review!.firstElementChild?.contains(summary!), "the code summary is not FIRST in the review").toBe(true);
    const changes = [...review!.querySelectorAll("label")].find((l) => l.textContent === "Changes since v1.0.0");
    expect(changes, "the cell diff's heading moved").toBeTruthy();
    expect(
      summary!.compareDocumentPosition(changes!) & Node.DOCUMENT_POSITION_FOLLOWING,
      "the cell diff comes before the code",
    ).toBeTruthy();
  });

  // SABOTAGE: pass the dialog's own wording (or an environment's name) instead
  // of PUSH_CODE_AUDIENCE.
  it("says it the Promote dialog's way, about the development line", async () => {
    await open();
    expect(PUSH_CODE_AUDIENCE).toBe("the development line");
    expect(q("[data-promotion-code-headline]")?.textContent).toBe(
      "Code: 2 changes. Everyone in the development line will be asked to approve this " +
        "application's code again before it runs.",
    );
    const row = q('[data-promotion-code-row="mod-report"]');
    expect(row, "the changed macro has no row").toBeTruthy();
    expect(row!.dataset.promotionCodeChange).toBe("modified");
    expect(row!.querySelector("[data-promotion-code-consequence-text]")?.textContent).toBe(
      PROMOTION_CODE_CONSEQUENCE.asksApprovalAgain.sentence(PUSH_CODE_AUDIENCE),
    );
    expect(q('[data-promotion-code-row="mod-extra"]')?.dataset.promotionCodeChange).toBe("added");
    // The code before and after, collapsed -- the base's, then the push's.
    const source = row!.querySelector("details[data-promotion-code-source]");
    expect(source?.textContent).toContain("return 1;");
    expect(source?.textContent).toContain("return 2;");
  });

  it("says plainly when the push changes no code", async () => {
    h.diffAnswer = answer({ codeChanges: [], asksApprovalAgain: false, codeError: null });
    await open();
    expect(q("[data-promotion-code]")?.dataset.promotionCode).toBe("ready");
    expect(q("[data-promotion-code-headline]")?.textContent).toBe("Code: no changes, nobody is asked again.");
  });
});

describe("a failed comparison is said, never shown as 'no code changes'", () => {
  // SABOTAGE: in the dialog, read a `codeError` answer as ready (drop
  // promotionCodeFromImpact for a hand-built state).
  it("a named codeError is a failure, with the push's own note", async () => {
    h.diffAnswer = answer({
      codeChanges: [],
      asksApprovalAgain: false,
      codeError: "the code of this push could not be compared with v1.0.0: checksum",
    });
    await open();
    expect(q("[data-promotion-code]")?.dataset.promotionCode).toBe("failed");
    expect(q("[data-promotion-code-headline]")?.textContent).toBe(
      "Code: the comparison failed: the code of this push could not be compared with v1.0.0: checksum.",
    );
    const text = q("[data-promotion-code]")!.textContent ?? "";
    expect(text).toContain(CODE_SUMMARY_FAILED_NOTE.push(PUSH_CODE_AUDIENCE));
    expect(text, "a push is told about promoting").not.toContain("Promoting");
    expect(text).not.toContain("no changes");
  });

  // SABOTAGE: leave the code state alone in the diff's `.catch`.
  it("a rejected read is a failure that names why", async () => {
    h.diffAnswer = "CALP_WORKSPACE_UNREADABLE: the share is gone";
    await open();
    expect(q("[data-promotion-code]")?.dataset.promotionCode, "the rejected read vanished").toBe("failed");
    expect(q("[data-promotion-code-headline]")?.textContent).toContain("CALP_WORKSPACE_UNREADABLE: the share is gone");
  });

  // SABOTAGE: read a missing `code` as an empty list.
  it("an answer with no code at all is not 'no code changes'", async () => {
    h.diffAnswer = answer(null);
    await open();
    expect(q("[data-promotion-code]")?.dataset.promotionCode).toBe("failed");
    expect(q("[data-promotion-code-headline]")?.textContent).toBe(
      "Code: the comparison failed: the answer carried no code list.",
    );
  });

  it("the Promote dialog keeps its own note", async () => {
    await act(async () => {
      root.render(
        <PromotionCodeSummary
          state={promotionCodeFailed("v1.1.0 cannot be shown")}
          environment="prod"
          firstPromotion={false}
          toVersion="1.1.0"
        />,
      );
    });
    const text = q("[data-promotion-code]")!.textContent ?? "";
    expect(q("[data-promotion-code]")?.dataset.codeSummaryAct).toBe("promotion");
    expect(text).toContain(
      "Promoting still works; it moves the pointer without this list, so nobody here can see " +
        "which code everyone in prod will run next.",
    );
    expect(CODE_SUMMARY_FAILED_NOTE.push("the development line")).not.toContain("Promot");
  });
});

describe("one summary, reused -- never copied", () => {
  const DIALOG = code(read("extensions/Collaboration/components/PublishDialog.tsx"));

  it("the push dialog renders the Promote dialog's component and reads the answer with its reader", () => {
    expect(DIALOG).toMatch(/import \{ PromotionCodeSummary \} from "\.\/PromotionCodeSummary";/);
    expect(DIALOG).toContain("promotionCodeFromImpact(");
    expect(DIALOG).toMatch(/<PromotionCodeSummary[\s\S]*?act="push"/);
  });

  // SABOTAGE: paste a consequence sentence into a second file.
  it("the consequence sentences live in ONE table", () => {
    const dir = path.join(APP_ROOT, "extensions/Collaboration");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== "__tests__") walk(p);
        } else if (/\.(ts|tsx)$/.test(e.name)) {
          files.push(p);
        }
      }
    };
    walk(dir);
    const holders = files
      .filter((f) => code(fs.readFileSync(f, "utf8")).includes("is asked to approve it before it runs"))
      .map((f) => path.relative(dir, f).replace(/\\/g, "/"));
    expect(holders).toEqual(["lib/promotionCode.ts"]);
  });
});
