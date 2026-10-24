//! FILENAME: app/extensions/Collaboration/__tests__/pushSheetsById.test.tsx
// PURPOSE: The push dialog names the ticked sheets by STABLE ID at every door
//          -- the push, its "Try again", the preview and the diff -- so a sheet
//          dragged, copied or deleted while the non-modal dialog is open can
//          never hand a tick to its neighbour (review round 8, F1 of
//          PUBLISH-BY-ID and REFUSAL-UX; fixed in round 9).
// CONTEXT: The dialog read its sheet list in an earlier command and sent
//          POSITIONS, and the backend resolved them against the list as it was
//          at the push. Untick Private, drag it in front of Report, press Push:
//          Private shipped to every subscriber under the author's key and
//          Report stayed behind. A refused push's "Try again" resent the same
//          positions, and a Preview re-read the list but kept the positions,
//          moving every tick onto a neighbour on screen too.
//
//          MOUNTED, with only the Tauri boundary (@api) doubled -- and the
//          double is a small model of the workbook: a sheet list the test moves
//          and deletes from (no event reaches the dialog, as none does for an
//          agent's move), and doors that resolve a request the way Rust does:
//          `sheetIds` when present (an id that is gone refuses with
//          CALP_PUSH_SHEET_GONE), otherwise the positions against the list AS
//          IT IS NOW. So a dialog that sent positions would ship the neighbour
//          here exactly as it did in the app.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PublishReport, VersionDiff, WorkingCopyStatus } from "@api";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** The retryable refusal exactly as Rust formats it for the publish door. */
const REFUSAL =
  "WORKBOOK_CHANGED_WHILE_SAVING: the workbook changed while it was being published -- a sheet was " +
  "added, deleted or moved during each of 3 attempts to read it. Nothing was written; try again.";

interface ModelSheet {
  id: string;
  name: string;
}

const h = vi.hoisted(() => ({
  /** THE WORKBOOK'S SHEET LIST NOW, in tab order. */
  sheets: [] as { id: string; name: string }[],
  previews: [] as unknown[][],
  published: [] as Record<string, unknown>[],
  diffs: [] as Record<string, unknown>[],
  /** What each push SHIPPED, by name, as the double resolved it. */
  shipped: [] as string[][],
  /** One per coming push: what happens while it runs (an agent's move), and whether it is refused. */
  pushAnswers: [] as { during?: () => void; reject?: string }[],
  /** Rejections for the coming previews (bare strings, as Tauri gives them). */
  previewAnswers: [] as (string | undefined)[],
}));

/** The sheet ids a request names, resolved the way the Rust doors do -- or the refusal Rust gives. */
function resolveNames(sel: { sheetIds?: unknown; sheetIndices?: unknown } | undefined, what: string): string[] {
  if (sel && Array.isArray(sel.sheetIds)) {
    const ids = sel.sheetIds as string[];
    const gone = ids.filter((id) => !h.sheets.some((s) => s.id === id));
    if (gone.length > 0) {
      throw (
        `CALP_PUSH_SHEET_GONE: The sheet you ticked is no longer in the workbook, so nothing was ${what}. ` +
        "Open the dialog again to see the current sheets."
      );
    }
    if (ids.length === 0) return h.sheets.map((s) => s.name);
    return ids.map((id) => h.sheets.find((s) => s.id === id)!.name);
  }
  const positions = Array.isArray(sel?.sheetIndices) ? (sel!.sheetIndices as number[]) : [];
  if (positions.length === 0) return h.sheets.map((s) => s.name);
  return positions.map((i) => h.sheets[i]?.name ?? `(no sheet at ${i})`);
}

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
    baseSheets: h.sheets.map((s) => ({ sheetId: s.id, name: s.name })) as WorkingCopyStatus["baseSheets"],
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
}

vi.mock("@api", () => ({
  publishPreview: vi.fn(async (...args: unknown[]) => {
    h.previews.push(args);
    const answer = h.previewAnswers.shift();
    if (typeof answer === "string") throw answer;
    const sel = Array.isArray(args[0]) ? { sheetIndices: args[0] } : (args[0] as { sheetIds?: unknown } | undefined);
    const covered = resolveNames(sel, "previewed");
    return {
      sheetNames: covered,
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
      // The list AS IT IS NOW, positions and all -- what Rust lists.
      sheets: h.sheets.map((s, index) => ({
        index,
        sheetId: s.id,
        name: s.name,
        subscribedTo: "",
        defaultSelected: true,
        kind: "worksheet",
      })),
      defaultSheetIndices: h.sheets.map((_, index) => index),
    };
  }),
  publishApplication: vi.fn(async (params: Record<string, unknown>) => {
    h.published.push(params);
    const answer = h.pushAnswers.shift();
    answer?.during?.();
    if (answer?.reject !== undefined) throw answer.reject;
    const shipped = resolveNames(params as { sheetIds?: unknown; sheetIndices?: unknown }, "published");
    h.shipped.push(shipped);
    return {
      packageName: "sales",
      version: "1.0.1",
      sheetsPublished: shipped.length,
      tablesPublished: 0,
      namedRangesPublished: 0,
      scriptsPublished: 0,
      modulesPublished: 0,
      notebooksPublished: 0,
      report: REPORT,
      warnings: [],
    };
  }),
  diffWorkingCopy: vi.fn(async (params: Record<string, unknown>) => {
    h.diffs.push(params);
    resolveNames(params as { sheetIds?: unknown; sheetIndices?: unknown }, "compared");
    return {
      packageName: "sales",
      baseVersion: "1.0.0",
      diff: EMPTY_DIFF,
      code: { codeChanges: [], asksApprovalAgain: false, codeError: null },
    };
  }),
  workingCopyStatus: vi.fn(async () => status()),
  pushMergeAnalyze: vi.fn(),
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

async function flush(): Promise<void> {
  for (let i = 0; i < 16; i++) {
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
const screenText = (): string => container.textContent ?? "";

/** The sheet list's row for `name`: a label wrapping its checkbox and its name. */
const sheetBox = (name: string): HTMLInputElement | null => {
  const row = [...container.querySelectorAll("label")].find(
    (l) => l.querySelector('input[type="checkbox"]') !== null && l.querySelector("span")?.textContent === name,
  );
  return (row?.querySelector('input[type="checkbox"]') as HTMLInputElement | null) ?? null;
};
/** The names the list shows, in order. */
const listedNames = (): string[] =>
  [...container.querySelectorAll("label")]
    .filter((l) => l.querySelector('input[type="checkbox"]') !== null && l.querySelector("span") !== null)
    .map((l) => l.querySelector("span")!.textContent ?? "");

async function typeSummary(text: string): Promise<void> {
  const summary = container.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(summary, text);
    summary.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

async function open(sheets: ModelSheet[]): Promise<void> {
  h.sheets.splice(0, h.sheets.length, ...sheets);
  await act(async () => {
    root.render(<PublishDialog isOpen onClose={vi.fn()} data={{}} />);
  });
  await flush();
  await typeSummary("Adds the regional split.");
}

/** The author (or an agent) drags a tab: nothing tells the dialog. */
function moveSheet(id: string, to: number): void {
  const at = h.sheets.findIndex((s) => s.id === id);
  const [sheet] = h.sheets.splice(at, 1);
  h.sheets.splice(to, 0, sheet);
}

/** The author (or an agent) deletes a tab: nothing tells the dialog. */
function deleteSheet(id: string): void {
  h.sheets.splice(
    h.sheets.findIndex((s) => s.id === id),
    1,
  );
}

const REPORT_SHEET: ModelSheet = { id: "id-report", name: "Report" };
const PRIVATE: ModelSheet = { id: "id-private", name: "Private" };
const SUMMARY: ModelSheet = { id: "id-summary", name: "Summary" };
const DASHBOARD: ModelSheet = { id: "id-dashboard", name: "Dashboard" };

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  h.sheets.length = 0;
  h.previews.length = 0;
  h.published.length = 0;
  h.diffs.length = 0;
  h.shipped.length = 0;
  h.pushAnswers.length = 0;
  h.previewAnswers.length = 0;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("a tab moved while the dialog is open", () => {
  // SABOTAGE: send positions only (`tickedWire` returning `{ sheetIndices }`)
  // -- the push then resolves position 0 against the moved list and ships
  // Private.
  it("Push ships the sheets that are ticked, not the ones that now sit where they were", async () => {
    await open([REPORT_SHEET, PRIVATE]);
    await click(sheetBox("Private"));
    expect(sheetBox("Private")!.checked).toBe(false);
    expect(sheetBox("Report")!.checked).toBe(true);

    // Drag Private in front of Report. The dialog is told nothing.
    moveSheet("id-private", 0);
    await click(buttonNamed("Push"));

    expect(h.published).toHaveLength(1);
    expect(h.published[0].sheetIds, "the push did not name the ticked sheet by id").toEqual(["id-report"]);
    expect(h.shipped[0], "the unticked sheet shipped in place of the ticked one").toEqual(["Report"]);
    expect(screenText()).toContain("Pushed sales v1.0.1");
  });

  // SABOTAGE: key the selection by position again (`sheetKey` returning
  // `#${index}`) -- the re-read list then shows Private ticked and Summary not.
  it("a Preview after the move re-reads the list and keeps every tick on its own sheet", async () => {
    await open([SUMMARY, PRIVATE, DASHBOARD]);
    await click(sheetBox("Private"));
    moveSheet("id-private", 0);

    await click(buttonNamed("Preview"));
    expect(listedNames(), "the Preview did not re-read the list").toEqual(["Private", "Summary", "Dashboard"]);
    expect(sheetBox("Private")!.checked, "the tick moved onto the unticked sheet").toBe(false);
    expect(sheetBox("Summary")!.checked).toBe(true);
    expect(sheetBox("Dashboard")!.checked).toBe(true);
    // ...and the preview itself asked by id.
    const asked = h.previews[h.previews.length - 1][0] as { sheetIds?: string[] };
    expect(asked.sheetIds).toEqual(["id-summary", "id-dashboard"]);
    expect(screenText()).toContain("Preview — would publish Summary, Dashboard");
  });

  it("the diff and the button-code review ask by id too, so every panel describes the push", async () => {
    await open([SUMMARY, PRIVATE, DASHBOARD]);
    await click(sheetBox("Private"));
    const diff = h.diffs[h.diffs.length - 1];
    expect(diff.sheetIds, "the diff did not ask by id").toEqual(["id-summary", "id-dashboard"]);
    // The review that follows the tick list (the last preview after the untick).
    const review = h.previews[h.previews.length - 1][0] as { sheetIds?: string[] };
    expect(review.sheetIds).toEqual(["id-summary", "id-dashboard"]);
  });
});

describe("Try again after a refusal", () => {
  // SABOTAGE: send positions only -- the retry then ships Private and Dashboard.
  it("resends the same SHEETS by id, so the renumbering that caused the refusal cannot move a tick", async () => {
    await open([SUMMARY, PRIVATE, DASHBOARD]);
    await click(sheetBox("Private"));
    // The push is refused because an agent moved Private to the front while it ran.
    h.pushAnswers.push({ during: () => moveSheet("id-private", 0), reject: REFUSAL });
    await click(buttonNamed("Push"));
    expect(retryButton(), "the retryable refusal offered no Try again").toBeTruthy();

    await click(retryButton());
    expect(h.published).toHaveLength(2);
    expect(h.published[1].sheetIds).toEqual(["id-summary", "id-dashboard"]);
    expect(h.published[1].sheetIds, "the retry named other sheets than the push").toEqual(h.published[0].sheetIds);
    expect(h.shipped[0], "the retry shipped the sheet the author unticked").toEqual(["Summary", "Dashboard"]);
    expect(screenText()).toContain("Pushed sales v1.0.1");
  });
});

describe("a ticked sheet deleted while the dialog is open", () => {
  // SABOTAGE: drop the `readSheetListAgain` call from handlePublish's catch --
  // the list still offers the deleted sheet and nothing says it was re-read.
  it("the push refusal in plain words, no Try again, and the list read again; the next Push ships what is left", async () => {
    await open([SUMMARY, DASHBOARD]);
    deleteSheet("id-dashboard");
    const previewsBefore = h.previews.length;
    await click(buttonNamed("Push"));

    expect(h.shipped, "a push with a gone sheet shipped something").toHaveLength(0);
    expect(screenText()).toContain(
      "The sheet you ticked is no longer in the workbook, so nothing was published. " +
        "Open the dialog again to see the current sheets.",
    );
    expect(screenText(), "the raw code reached the screen").not.toContain("CALP_PUSH_SHEET_GONE");
    expect(retryButton(), "a refusal that can never succeed again offered Try again").toBeNull();
    // The list was read again: an unfiltered preview after the push.
    const reads = h.previews.slice(previewsBefore).filter((args) => Array.isArray(args[0]) && (args[0] as unknown[]).length === 0);
    expect(reads.length, "the list was not read again").toBeGreaterThan(0);
    expect(listedNames()).toEqual(["Summary"]);
    expect(screenText()).toContain("The list of sheets has been read again");

    await click(buttonNamed("Push"));
    expect(h.shipped).toEqual([["Summary"]]);
  });

  // SABOTAGE: let isWorkbookChangedWhileSaving accept CALP_PUSH_SHEET_GONE --
  // the strip then offers a Try again that can never succeed. (With the list
  // read again, the appended sentence would hide the button by coincidence, so
  // here the re-read fails and the refusal's own text stays on screen.)
  it("offers no Try again even when the list cannot be read again, and says nothing about a re-read", async () => {
    await open([SUMMARY, DASHBOARD]);
    deleteSheet("id-dashboard");
    h.previewAnswers.push("the share is gone");
    await click(buttonNamed("Push"));
    expect(screenText()).toContain("The sheet you ticked is no longer in the workbook, so nothing was published.");
    expect(retryButton(), "a refusal that can never succeed again offered Try again").toBeNull();
    expect(screenText(), "it claimed a re-read that failed").not.toContain("has been read again");
  });

  // SABOTAGE: drop `plainSheetGoneSentence` from describeBackendRefusal -- the
  // preview's strip shows the code.
  it("a Preview refused the same way says it plainly too, and reads the list again", async () => {
    await open([SUMMARY, DASHBOARD]);
    deleteSheet("id-dashboard");
    await click(buttonNamed("Preview"));
    expect(screenText()).toContain(
      "The sheet you ticked is no longer in the workbook, so nothing was previewed.",
    );
    expect(screenText(), "the raw code reached the screen").not.toContain("CALP_PUSH_SHEET_GONE");
    expect(retryButton()).toBeNull();
    expect(listedNames()).toEqual(["Summary"]);
  });
});
