//! FILENAME: app/extensions/Collaboration/__tests__/pushReshowAndOneAct.test.tsx
// PURPOSE: Three push-dialog rules from review round 9 (DIALOG-TS F2, F3) and
//          round 10 (WIRE-RUST F1's dialog half), MOUNTED:
//            * a re-show of the still-open dialog reads the sheet list again,
//              so "open the dialog again to see the current sheets" works;
//            * one act at a time: a second press while a push (or a merge)
//              runs sends nothing, and the strip never shows a refusal for a
//              push that landed -- and a Preview waits too (round 10), so it
//              never clears "Pushing…" or "Pushed…", while the merge's own
//              refresh still runs; and a Preview IS an act (round 11,
//              RV11-TS-2), so a Push or a Merge waits for IT -- a push that
//              landed beside a slower Preview lost its receipt to it;
//            * a position past the end of the sheet list
//              (CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE, which only the
//              positions-only fallback sends) is treated like a gone sheet:
//              plain words, no Try again, the list read again -- never a loop.
// CONTEXT: Only the Tauri boundary (@api) is doubled, and the double is a small
//          model of the workbook: a sheet list the test deletes from (nothing
//          tells the dialog), doors that resolve a request the way Rust does
//          (an id that is gone refuses with CALP_PUSH_SHEET_GONE; a position
//          past the end with CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE, in the
//          sentence `sheet_index_out_of_range_refusal` formats), and pushes and
//          merges a test can hold open.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PublishReport, VersionDiff, WorkingCopyStatus } from "@api";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

interface ModelSheet {
  id: string;
  name: string;
}

const h = vi.hoisted(() => ({
  /** THE WORKBOOK'S SHEET LIST NOW, in tab order. */
  sheets: [] as { id: string; name: string }[],
  /** List the rows WITHOUT their ids: the dialog then sends positions only. */
  listWithoutIds: false,
  /** The base is stale (the banner offers "Merge with v1.1.0"). */
  stale: false,
  previews: [] as unknown[][],
  published: [] as Record<string, unknown>[],
  diffs: [] as Record<string, unknown>[],
  shipped: [] as string[][],
  merges: 0,
  /** One per coming push: wait for `wait`, then reject with `reject` when set. */
  pushAnswers: [] as { wait?: Promise<void>; reject?: string }[],
  /** Rejections for the coming previews (bare strings, as Tauri gives them). */
  previewAnswers: [] as (string | undefined)[],
  /** What the coming previews wait for before their answer -- taken at call time -- is delivered. */
  previewWaits: [] as Promise<void>[],
  /** What the coming merges wait for. */
  mergeWaits: [] as Promise<void>[],
}));

/** Rust's `sheet_index_out_of_range_refusal`, for the first position past the end. */
function pastTheEnd(past: number, count: number, what: string): string {
  const has = count === 0 ? "no sheets" : count === 1 ? "1 sheet (index 0)" : `${count} sheets (indexes 0 to ${count - 1})`;
  return (
    `CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE: There is no sheet at index ${past}: the workbook has ${has}. ` +
    `Nothing was ${what}; read the sheet list again and choose the sheets again.`
  );
}

/** The sheets a request names, resolved the way the Rust doors do -- or the refusal Rust gives. */
function resolveSheets(sel: { sheetIds?: unknown; sheetIndices?: unknown } | undefined, what: string): ModelSheet[] {
  if (sel && Array.isArray(sel.sheetIds)) {
    const ids = sel.sheetIds as string[];
    if (ids.some((id) => !h.sheets.some((s) => s.id === id))) {
      throw (
        `CALP_PUSH_SHEET_GONE: The sheet you ticked is no longer in the workbook, so nothing was ${what}. ` +
        "Open the dialog again to see the current sheets."
      );
    }
    if (ids.length === 0) return [...h.sheets];
    return ids.map((id) => h.sheets.find((s) => s.id === id)!);
  }
  const positions = Array.isArray(sel?.sheetIndices) ? (sel!.sheetIndices as number[]) : [];
  if (positions.length === 0) return [...h.sheets];
  const past = positions.find((i) => i >= h.sheets.length);
  if (past !== undefined) throw pastTheEnd(past, h.sheets.length, what);
  return positions.map((i) => h.sheets[i]);
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
    registryUrl: "\\server\apps",
    packageName: "sales",
    kind: "report",
    baseVersion: "1.0.0",
    checkedOutAt: "2026-09-30T00:00:00Z",
    lastPushedVersion: "",
    lastPushedAt: "",
    baseSheets: h.sheets.map((s) => ({ sheetId: s.id, name: s.name })) as WorkingCopyStatus["baseSheets"],
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
    const wait = h.previewWaits.shift();
    // THE ANSWER IS TAKEN AT CALL TIME, as Rust reads the workbook when it is
    // asked, and only DELIVERED once `wait` resolves.
    const answerNow = (): unknown => {
      if (typeof answer === "string") throw answer;
      const sel = Array.isArray(args[0]) ? { sheetIndices: args[0] } : (args[0] as { sheetIds?: unknown } | undefined);
      const covered = resolveSheets(sel, "previewed");
      return {
        sheetNames: covered.map((s) => s.name),
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
        // The list AS IT IS NOW -- what Rust lists; without ids when asked to.
        sheets: h.sheets.map((s, index) => ({
          index,
          sheetId: h.listWithoutIds ? "" : s.id,
          name: s.name,
          subscribedTo: "",
          defaultSelected: true,
          kind: "worksheet",
        })),
        defaultSheetIndices: h.sheets.map((_, index) => index),
      };
    };
    let result: unknown;
    let refusal: unknown;
    try {
      result = answerNow();
    } catch (e: unknown) {
      refusal = e;
    }
    if (wait) await wait;
    if (refusal !== undefined) throw refusal;
    return result;
  }),
  publishApplication: vi.fn(async (params: Record<string, unknown>) => {
    h.published.push(params);
    const answer = h.pushAnswers.shift();
    if (answer?.wait) await answer.wait;
    if (answer?.reject !== undefined) throw answer.reject;
    const shipped = resolveSheets(params as { sheetIds?: unknown; sheetIndices?: unknown }, "published");
    h.shipped.push(shipped.map((s) => s.name));
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
    resolveSheets(params as { sheetIds?: unknown; sheetIndices?: unknown }, "compared");
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
    headSigner: null,
    headChangeSummary: "",
    analysis: {
      verdict: "canMerge",
      collisions: [],
      theirSummary: ["Sheet Summary: 1 cell"],
      yourSummary: ["Sheet Summary: 2 cells"],
      unmergeable: [],
    },
  })),
  pushMergeApply: vi.fn(async () => {
    h.merges += 1;
    const wait = h.mergeWaits.shift();
    if (wait) await wait;
    return { mergedFromVersion: "1.1.0", cellsApplied: 1, sheetsTouched: ["Summary"] };
  }),
  undo: vi.fn(async () => ({ success: true, refusal: null })),
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

/** Several presses in ONE frame: nothing re-renders between them, as with a fast double-click. */
async function pressTogether(...els: (HTMLElement | null | undefined)[]): Promise<void> {
  for (const el of els) expect(el, "the control is not on screen").toBeTruthy();
  await act(async () => {
    for (const el of els) el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
/** The names the sheet list shows, in order. */
const listedNames = (): string[] =>
  [...container.querySelectorAll("label")]
    .filter((l) => l.querySelector('input[type="checkbox"]') !== null && l.querySelector("span") !== null)
    .map((l) => l.querySelector("span")!.textContent ?? "");
/** How often the dialog read the sheet LIST: an unfiltered preview (an empty positions array). */
const listReads = (): number =>
  h.previews.filter((args) => Array.isArray(args[0]) && (args[0] as unknown[]).length === 0).length;

async function typeSummary(text: string): Promise<void> {
  const summary = container.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(summary, text);
    summary.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

/** Show the dialog -- the first time, or AGAIN while it is open (a higher __openCount). */
async function show(openCount: number): Promise<void> {
  await act(async () => {
    root.render(<PublishDialog isOpen onClose={vi.fn()} data={{ __openCount: openCount }} />);
  });
  await flush();
}

async function open(sheets: ModelSheet[]): Promise<void> {
  h.sheets.splice(0, h.sheets.length, ...sheets);
  await show(1);
  await typeSummary("Adds the regional split.");
}

/** The author (or an agent) deletes a tab: nothing tells the dialog. */
function deleteSheet(id: string): void {
  h.sheets.splice(
    h.sheets.findIndex((s) => s.id === id),
    1,
  );
}

const SUMMARY: ModelSheet = { id: "id-summary", name: "Summary" };
const DASHBOARD: ModelSheet = { id: "id-dashboard", name: "Dashboard" };
const PRIVATE: ModelSheet = { id: "id-private", name: "Private" };
const STALE_BASE = "CALP_PUSH_STALE_BASE: v1.0.1 landed while you were working. Merge first.";

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  h.sheets.length = 0;
  h.listWithoutIds = false;
  h.stale = false;
  h.previews.length = 0;
  h.published.length = 0;
  h.diffs.length = 0;
  h.shipped.length = 0;
  h.merges = 0;
  h.pushAnswers.length = 0;
  h.previewAnswers.length = 0;
  h.previewWaits.length = 0;
  h.mergeWaits.length = 0;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("showing the still-open dialog again reads the sheet list again (F2)", () => {
  // SABOTAGE: drop openCount from the list loader's dependencies -- the
  // re-show then re-runs only the reset, and the list, the diff's "no longer
  // in the workbook" and the "press Preview" line all stay as they were.
  it("delete a ticked sheet, untick another, show again: the list is read again and the gone text and the press-Preview line clear", async () => {
    await open([SUMMARY, DASHBOARD, PRIVATE]);
    expect(listReads(), "the mount read the list more than once").toBe(1);

    deleteSheet("id-dashboard");
    await click(sheetBox("Private"));
    // The diff and the button-code review ran again for Summary + Dashboard,
    // and the backend said Dashboard is gone.
    expect(screenText()).toContain(
      "Could not compare against v1.0.0: The sheet you ticked is no longer in the workbook, so nothing was compared.",
    );
    expect(screenText()).toContain("press Preview");
    expect(listedNames(), "the list was read again before the re-show: the test proves nothing").toEqual([
      "Summary",
      "Dashboard",
      "Private",
    ]);

    const before = listReads();
    await show(2);
    expect(listReads(), "the re-show did not read the list again").toBe(before + 1);
    expect(listedNames()).toEqual(["Summary", "Private"]);
    expect(screenText(), "the gone-sheet text outlived the re-show").not.toContain("no longer in the workbook");
    expect(screenText(), "the press-Preview line outlived the re-show").not.toContain("press Preview");
    // ...and the push now describes, and ships, the sheets that exist.
    await typeSummary("Adds the regional split.");
    await click(buttonNamed("Push"));
    expect(h.shipped).toEqual([["Summary", "Private"]]);
  });
});

describe("one act at a time (F3)", () => {
  // SABOTAGE: drop the `actInFlightRef` check from handlePublish -- the second
  // press pushes the same version again, is refused because the base moved,
  // and that refusal is what the strip shows for the push that landed.
  it("two presses while a push runs send ONE push, and the strip never shows a refusal for the push that landed", async () => {
    await open([SUMMARY]);
    let release!: () => void;
    h.pushAnswers.push({ wait: new Promise<void>((r) => (release = r)) }, { reject: STALE_BASE });
    await pressTogether(buttonNamed("Push"), buttonNamed("Push"));
    expect(h.published, "a second press sent a second push").toHaveLength(1);
    expect(screenText()).toContain("Pushing");

    await act(async () => release());
    await flush();
    expect(h.published).toHaveLength(1);
    expect(screenText()).toContain("Pushed sales v1.0.1");
    expect(screenText(), "the strip shows a refusal for a push that landed").not.toContain("landed while you were working");
  });

  // SABOTAGE: drop `acting !== null` from the Push button's `disabled`.
  it("while a push runs, Push renders disabled, and becomes a receipt once it lands", async () => {
    await open([SUMMARY]);
    let release!: () => void;
    h.pushAnswers.push({ wait: new Promise<void>((r) => (release = r)) });
    await click(buttonNamed("Push"));
    expect(buttonNamed("Push")!.disabled, "Push stayed live while a push ran").toBe(true);
    await act(async () => release());
    await flush();
    expect(h.published).toHaveLength(1);
    expect(buttonNamed("Push")!.disabled, "a landed push can be pushed again").toBe(true);
    expect(buttonNamed("Close"), "the dialog is not a receipt").toBeTruthy();
  });

  // SABOTAGE: give the merge its own ref (or none) -- a push pressed during a
  // merge then goes out against the base the merge is moving.
  it("a merge in flight: Merge and Push are disabled, and a second Merge or a Push in the same frame does nothing", async () => {
    h.stale = true;
    await open([SUMMARY]);
    const merge = buttonNamed("Merge with v1.1.0");
    expect(merge, "the stale banner offers no merge").toBeTruthy();
    let release!: () => void;
    h.mergeWaits.push(new Promise<void>((r) => (release = r)));
    await pressTogether(merge, merge, buttonNamed("Push"));
    expect(h.merges, "a second press merged again").toBe(1);
    expect(h.published, "a push went out during the merge").toHaveLength(0);
    expect(buttonNamed("Merge with v1.1.0")!.disabled, "Merge stayed live while a merge ran").toBe(true);
    expect(buttonNamed("Push")!.disabled, "Push stayed live while a merge ran").toBe(true);

    await act(async () => release());
    await flush();
    expect(h.merges).toBe(1);
    expect(buttonNamed("Push")!.disabled, "Push stayed disabled after the merge").toBe(false);
  });
});

describe("a Preview waits for a running act too (round 10)", () => {
  // TWO SABOTAGES: drop runPreview's `actInFlightRef` check -- the Preview
  // pressed with Push runs beside it, and its success path clears the status
  // line; or drop `disabled={acting !== null}` from the Preview button.
  it("while a push runs, Preview is disabled and a press does nothing: 'Pushing…', then 'Pushed…', stay on screen", async () => {
    await open([SUMMARY]);
    let release!: () => void;
    h.pushAnswers.push({ wait: new Promise<void>((r) => (release = r)) });
    const previewsBefore = h.previews.length;
    await pressTogether(buttonNamed("Push"), buttonNamed("Preview"));
    expect(h.published).toHaveLength(1);
    expect(screenText(), "a Preview cleared the running push's status line").toContain("Pushing");
    expect(h.previews.length, "a Preview ran beside the push").toBe(previewsBefore);
    expect(buttonNamed("Preview")!.disabled, "Preview stayed live while a push ran").toBe(true);

    await act(async () => release());
    await flush();
    expect(screenText(), "the landed push's line is gone").toContain("Pushed sales v1.0.1");
    expect(h.previews.length, "a Preview pressed during the push ran after it").toBe(previewsBefore);
    expect(buttonNamed("Preview")!.disabled, "Preview stayed disabled after the push").toBe(false);
  });

  // SABOTAGE: let the merge's own refresh meet the guard (call runPreview
  // without "merge") -- the merge then lands with the report and the gates of
  // the base it merged away from.
  it("while a merge runs, Preview is disabled and a press does nothing -- but the merge's own refresh still runs", async () => {
    h.stale = true;
    await open([SUMMARY]);
    const merge = buttonNamed("Merge with v1.1.0");
    expect(merge, "the stale banner offers no merge").toBeTruthy();
    let release!: () => void;
    h.mergeWaits.push(new Promise<void>((r) => (release = r)));
    const previewsBefore = h.previews.length;
    await pressTogether(merge, buttonNamed("Preview"));
    expect(h.merges).toBe(1);
    // "Merging…" WITH its ellipsis: the status line's own text. The stale
    // banner says "Merging brings their work..." whatever the status is.
    expect(screenText(), "a Preview cleared the running merge's status line").toContain("Merging…");
    expect(h.previews.length, "a Preview ran beside the merge").toBe(previewsBefore);
    expect(buttonNamed("Preview")!.disabled, "Preview stayed live while a merge ran").toBe(true);

    await act(async () => release());
    await flush();
    expect(h.previews.length, "the merge's own refresh did not run").toBe(previewsBefore + 1);
    expect(buttonNamed("Preview")!.disabled, "Preview stayed disabled after the merge").toBe(false);
  });
});

describe("a Preview IS an act: a Push or a Merge waits for it (round 11, RV11-TS-2)", () => {
  // TWO SABOTAGES, each on its own: drop runPreview's ref assignment
  // (`actInFlightRef.current = "preview"`) -- a Push pressed in the Preview's
  // frame goes out beside it, lands, and the slower Preview then takes its
  // "Pushed …" line down and puts a "would publish" preview where the published
  // report was; or drop `setActing("preview")` -- Push and Merge stay live on
  // screen while the Preview runs.
  it("Preview held open: a Push in its frame or after sends nothing, Push renders disabled -- and once the Preview lands, a Push lands with its receipt", async () => {
    await open([SUMMARY]);
    let release!: () => void;
    h.previewWaits.push(new Promise<void>((r) => (release = r)));
    const previewsBefore = h.previews.length;
    await pressTogether(buttonNamed("Preview"), buttonNamed("Push"));
    expect(h.previews.length, "the Preview did not run: the test proves nothing").toBe(previewsBefore + 1);
    expect(h.published, "a Push went out beside the running Preview").toHaveLength(0);
    expect(screenText()).toContain("Analyzing");
    expect(buttonNamed("Push")!.disabled, "Push stayed live while a Preview ran").toBe(true);
    expect(buttonNamed("Preview")!.disabled, "Preview stayed live while a Preview ran").toBe(true);
    await click(buttonNamed("Push"));
    expect(h.published, "a Push pressed after the re-render went out beside the Preview").toHaveLength(0);

    // The Preview's late answer lands...
    await act(async () => release());
    await flush();
    expect(screenText(), "the Preview's own answer did not land").toContain("Preview — would publish Summary");
    expect(buttonNamed("Push")!.disabled, "Push stayed disabled after the Preview").toBe(false);
    // ...and only then does a push go out, and its receipt stays.
    await click(buttonNamed("Push"));
    expect(h.published).toHaveLength(1);
    expect(screenText(), "the landed push's line is gone").toContain("Pushed sales v1.0.1");
    expect(screenText(), "the published report was replaced").toContain("Published sales v1.0.1");
    await flush();
    expect(screenText(), "something that answered late took the receipt down").toContain("Pushed sales v1.0.1");
    expect(screenText()).toContain("Published sales v1.0.1");
    expect(screenText()).not.toContain("Preview — would publish");
  });

  it("Preview held open: a Merge in its frame sends nothing, and Merge renders disabled until the Preview lands", async () => {
    h.stale = true;
    await open([SUMMARY]);
    const merge = buttonNamed("Merge with v1.1.0");
    expect(merge, "the stale banner offers no merge").toBeTruthy();
    let release!: () => void;
    h.previewWaits.push(new Promise<void>((r) => (release = r)));
    await pressTogether(buttonNamed("Preview"), merge);
    expect(h.merges, "a merge went out beside the running Preview").toBe(0);
    expect(buttonNamed("Merge with v1.1.0")!.disabled, "Merge stayed live while a Preview ran").toBe(true);
    expect(buttonNamed("Push")!.disabled, "Push stayed live while a Preview ran").toBe(true);

    await act(async () => release());
    await flush();
    expect(buttonNamed("Merge with v1.1.0")!.disabled, "Merge stayed disabled after the Preview").toBe(false);
    await click(buttonNamed("Merge with v1.1.0"));
    expect(h.merges).toBe(1);
  });

  // SABOTAGE: free the lock on the Preview's success path only (not in its
  // `finally`) -- a failed Preview then leaves Push and Merge dead.
  it("a Preview that fails frees Push again", async () => {
    await open([SUMMARY]);
    h.previewAnswers.push("the share is gone");
    await click(buttonNamed("Preview"));
    expect(screenText()).toContain("the share is gone");
    expect(buttonNamed("Push")!.disabled, "a failed Preview left Push disabled").toBe(false);
    expect(buttonNamed("Preview")!.disabled, "a failed Preview left Preview disabled").toBe(false);
    await click(buttonNamed("Push"));
    expect(h.published, "a failed Preview left the act lock taken").toHaveLength(1);
  });
});

describe("a position past the end of the sheet list is treated like a gone sheet (round 10)", () => {
  const PUSH_SENTENCE =
    "There is no sheet at index 1: the workbook has 1 sheet (index 0). Nothing was published; read the sheet " +
    "list again and choose the sheets again.";

  // SABOTAGE: drop isSheetIndexOutOfRangeRefusal from needsTheSheetListAgain
  // -- the list is never read again, and the next Push resends position 1.
  it("Push, with the positions-only fallback: plain words, the list read again ONCE, and the next Push ships what is there", async () => {
    h.listWithoutIds = true;
    await open([SUMMARY, DASHBOARD]);
    deleteSheet("id-dashboard");
    const before = listReads();
    await click(buttonNamed("Push"));
    expect(h.published[0].sheetIds, "rows listed without ids went out by id: the test proves nothing").toBeUndefined();
    expect(h.published[0].sheetIndices).toEqual([0, 1]);
    expect(h.shipped).toHaveLength(0);
    expect(screenText()).toContain(PUSH_SENTENCE);
    expect(screenText(), "the raw code reached the screen").not.toContain("CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE");
    expect(listReads(), "the list was not read again").toBe(before + 1);
    expect(listedNames()).toEqual(["Summary"]);
    expect(screenText()).toContain("The list of sheets has been read again");
    await flush();
    expect(listReads(), "the re-read ran again by itself: a loop").toBe(before + 1);

    await click(buttonNamed("Push"));
    expect(h.published[1].sheetIndices).toEqual([0]);
    expect(h.shipped).toEqual([["Summary"]]);
  });

  // SABOTAGE: let isWorkbookChangedWhileSaving accept the new code -- the
  // strip then offers a Try again that resends the same positions. (Here the
  // re-read fails, so the refusal's own text stays and the button would show.)
  it("offers no Try again, even when the list cannot be read again", async () => {
    h.listWithoutIds = true;
    await open([SUMMARY, DASHBOARD]);
    deleteSheet("id-dashboard");
    h.previewAnswers.push("the share is gone");
    await click(buttonNamed("Push"));
    expect(screenText()).toContain(PUSH_SENTENCE);
    expect(retryButton(), "a refusal the same positions can never pass offered Try again").toBeNull();
    expect(screenText(), "it claimed a re-read that failed").not.toContain("has been read again");
  });

  // SABOTAGE: drop the past-the-end sentence from describeBackendRefusal --
  // the preview's strip shows the code.
  it("Preview: the same plain words, no Try again, and the list read again", async () => {
    h.listWithoutIds = true;
    await open([SUMMARY, DASHBOARD]);
    deleteSheet("id-dashboard");
    await click(buttonNamed("Preview"));
    expect(screenText()).toContain(
      "There is no sheet at index 1: the workbook has 1 sheet (index 0). Nothing was previewed;",
    );
    expect(screenText()).not.toContain("CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE");
    expect(retryButton()).toBeNull();
    expect(listedNames()).toEqual(["Summary"]);
  });

  // SABOTAGE: read the list again from the diff's catch -- the diff then
  // re-reads the list by itself, which is the loop the comment forbids.
  it("the diff says it plainly and reads nothing again by itself; Preview then recovers", async () => {
    h.listWithoutIds = true;
    await open([SUMMARY, DASHBOARD, PRIVATE]);
    deleteSheet("id-private");
    const before = listReads();
    await click(sheetBox("Dashboard"));
    // FIRST: nothing that runs by itself read the list again (the loop the
    // dialog's comment forbids) -- then what the diff asked and said.
    expect(listReads(), "a review that runs by itself read the list again").toBe(before);
    expect(h.diffs[h.diffs.length - 1].sheetIndices).toEqual([0, 2]);
    expect(screenText()).toContain(
      "Could not compare against v1.0.0: There is no sheet at index 2: the workbook has 2 sheets (indexes 0 to 1). " +
        "Nothing was compared;",
    );
    expect(screenText()).not.toContain("CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE");
    expect(screenText(), "the button-code review did not wait for an answer").toContain("press Preview");

    // Preview -- the author's act -- meets the same refusal, says it, and
    // reads the list again; the panels then follow the list that is there.
    await click(buttonNamed("Preview"));
    expect(screenText()).toContain("Nothing was previewed; read the sheet list again and choose the sheets again.");
    expect(retryButton()).toBeNull();
    expect(listReads(), "Preview did not read the list again").toBe(before + 1);
    expect(listedNames()).toEqual(["Summary", "Dashboard"]);
    expect(h.diffs[h.diffs.length - 1].sheetIndices, "the diff did not follow the list read again").toEqual([0]);
    expect(screenText(), "the diff's refusal outlived the list read again").not.toContain("Could not compare");
    expect(screenText()).not.toContain("press Preview");
  });
});
