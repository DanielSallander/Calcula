//! FILENAME: app/extensions/Collaboration/__tests__/pushHoldBackSurvivesReRead.test.tsx
// PURPOSE: A change the author held back in the push dialog's diff stays held
//          back when the dialog works the comparison out again -- above all
//          when it does so ON ITS OWN, after reading the sheet list again --
//          an untick the dialog has to drop is SAID, never silent, and WHICH
//          sheets the push carries is Rust's answer, never the ticked rows.
// CONTEXT: Review round 9, DIALOG-TS F1 (a data leak). The diff effect cleared
//          every untick on each refetch. After a gone-sheet refusal the dialog
//          reads the sheet list again; the selection moves, the diff runs
//          again, and every held-back cell was ticked again with no message:
//          untick a private Summary!A1, delete the ticked Dashboard, press Push
//          (refused), press Push again -- and A1's new value went to every
//          subscriber under the author's key.
//
//          Review round 10, DIALOG-TS-R10-1 (the same leak, one gesture on):
//          the fix dropped the unticks of a sheet that left the push, so
//          unticking Summary by mistake and ticking it again shipped Summary!A1
//          under a notice that said its sheet was not in the push. Now such an
//          untick is PARKED and comes back with its sheet.
//
//          Review round 11, RV11-TS-1 (the same leak, by another route): the
//          unticks were sorted by the TICKED rows, and a push carries more --
//          a floating grid's backing sheet travels with the page that hosts
//          it, and a sheet a chart on a ticked sheet reads joins the push. An
//          untick on such a sheet was parked, the line under the panel said
//          its sheet was not in this push, and Push -- which sent only the
//          unticks it had sorted as acting -- shipped the cell. Now the diff's
//          answer says which sheets the push carries (`carriedSheetIds`), the
//          unticks follow it, and a push sends EVERY untick with its own
//          selection for Rust to judge.
//
//          MOUNTED, with only the Tauri boundary doubled, and the double is a
//          small model of the workbook AND of Rust's resolver
//          (`resolve_publish_selection`): a sheet list the test deletes from
//          (no event reaches the dialog, as none does for an agent's delete);
//          floating grids' BACKING sheets, in no list and carried with their
//          host; charts that read another sheet, which then joins the push;
//          doors that resolve a request the way Rust does (an id that is gone
//          refuses with CALP_PUSH_SHEET_GONE); a diff that lists each CARRIED
//          sheet's changed cells as sample rows, says which sheets it carries,
//          and -- when a test asks, as Rust's push diff always does -- lists an
//          unticked base sheet as "removed", every change a row; and a
//          hold-back that resolves the push's own selection the same way,
//          holds back exactly the cells on the sheets it carries, and records
//          both what it was asked and what it held.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PublishReport, VersionDiff, WorkingCopyStatus } from "@api";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

interface ModelSheet {
  id: string;
  name: string;
}
/** A floating grid's BACKING sheet: no row in any list, carried with `hostId`. */
interface ModelBackingSheet extends ModelSheet {
  hostId: string;
}
interface ModelCell {
  a1: string;
  row: number;
  col: number;
}
interface CellRef {
  sheetId: string;
  row: number;
  col: number;
}
/** What the dialog asked a hold-back for: the cells, and the push it is part of. */
interface HoldBackRequest {
  cells: CellRef[];
  kind?: unknown;
  sheetIds?: unknown;
  sheetIndices?: unknown;
}

const h = vi.hoisted(() => ({
  /** THE WORKBOOK'S USER SHEETS NOW, in tab order: what every sheet list shows. */
  sheets: [] as { id: string; name: string }[],
  /** Floating grids' BACKING sheets: in no list; each one travels with its host. */
  backing: [] as { id: string; name: string; hostId: string }[],
  /** The sheets a chart on each sheet reads, by id: Rust adds them to the push. */
  chartSources: {} as Record<string, string[]>,
  /** List every sheet the push drops as "removed", each change a row (Rust's push diff does). */
  listRemoved: false,
  /** The cells that differ from the base, per sheet id: the diff lists them as sample rows. */
  changes: {} as Record<string, { a1: string; row: number; col: number }[]>,
  previews: [] as unknown[][],
  published: [] as Record<string, unknown>[],
  diffs: [] as Record<string, unknown>[],
  /** What each push SHIPPED, by name. */
  shipped: [] as string[][],
  /** Every hold-back REQUEST: the cells, the kind and the selection it was told. */
  holdBackRequests: [] as {
    cells: { sheetId: string; row: number; col: number }[];
    kind?: unknown;
    sheetIds?: unknown;
    sheetIndices?: unknown;
  }[],
  /** What each hold-back HELD BACK, Rust's rule applied: the cells on sheets the push carries. */
  holdBacks: [] as { sheetId: string; row: number; col: number }[][],
  undoSeq: 0,
  /** One per coming diff: wait for `wait`, then reject with `reject` when set. */
  diffAnswers: [] as { wait?: Promise<void>; reject?: string }[],
  /** Refusals the coming hold-backs' selection meets (bare strings, as Tauri gives them). */
  holdBackAnswers: [] as string[],
}));

/** The TICKED user sheets a request names, resolved the way the Rust doors do -- or the refusal Rust gives. */
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
  return positions.map((i) => h.sheets[i]);
}

/**
 * The sheets a request CARRIES, the way Rust's `resolve_publish_selection`
 * works them out: the ticked user sheets, then -- to a fixpoint -- every sheet
 * a chart on a carried sheet reads (every model sheet is a base sheet, so each
 * may join), and every backing sheet whose host is carried. In tab order, the
 * backing sheets last, where Rust keeps them.
 */
function carriedBy(sel: { sheetIds?: unknown; sheetIndices?: unknown } | undefined, what: string): ModelSheet[] {
  const ids = new Set(resolveSheets(sel, what).map((s) => s.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const id of [...ids]) {
      for (const source of h.chartSources[id] ?? []) {
        if (!ids.has(source) && h.sheets.some((s) => s.id === source)) {
          ids.add(source);
          grew = true;
        }
      }
    }
    for (const b of h.backing) {
      if (ids.has(b.hostId) && !ids.has(b.id)) {
        ids.add(b.id);
        grew = true;
      }
    }
  }
  return [...h.sheets, ...h.backing].filter((s) => ids.has(s.id));
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

/** One sheet of the diff: its changed cells as sample rows -- "removed" ones for a sheet the push drops. */
function sheetRow(s: ModelSheet, change: "modified" | "removed") {
  const cells = h.changes[s.id] ?? [];
  return {
    sheetId: s.id,
    name: s.name,
    change,
    cellsAdded: 0,
    cellsRemoved: change === "removed" ? cells.length : 0,
    cellsModified: change === "modified" ? cells.length : 0,
    formulaChanges: 0,
    countsExact: true,
    styleChangedCells: 0,
    stylesTableChanged: false,
    layoutChanged: false,
    metadataChanged: false,
    sample: cells.map((c) => ({
      a1: c.a1,
      row: c.row,
      col: c.col,
      change,
      before: { display: "1", cellType: "number" },
      after: change === "removed" ? undefined : { display: "2", cellType: "number" },
    })),
    sampleTruncated: false,
  };
}

/**
 * The working-copy diff of a push that carries `carried`: each carried sheet's
 * changed cells as its sample rows -- and, when `h.listRemoved`, every other
 * sheet as "removed", cell by cell, as Rust's push diff lists a base sheet the
 * push drops (the older tests here describe the panel without those).
 */
function diffOf(carried: ModelSheet[]): VersionDiff {
  const carriedIds = new Set(carried.map((s) => s.id));
  const modified = carried.filter((s) => (h.changes[s.id] ?? []).length > 0).map((s) => sheetRow(s, "modified"));
  const removed = h.listRemoved
    ? [...h.sheets, ...h.backing]
        .filter((s) => !carriedIds.has(s.id) && (h.changes[s.id] ?? []).length > 0)
        .map((s) => sheetRow(s, "removed"))
    : [];
  const rows = [...modified, ...removed];
  const cells = rows.reduce((n, r) => n + r.cellsModified + r.cellsRemoved, 0);
  return { ...EMPTY_DIFF, sheets: rows, totals: { ...EMPTY_DIFF.totals, sheetsChanged: rows.length, cellsChanged: cells } };
}

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
    const sel = Array.isArray(args[0]) ? { sheetIndices: args[0] } : (args[0] as { sheetIds?: unknown } | undefined);
    const covered = carriedBy(sel, "previewed");
    return {
      sheetNames: covered.map((s) => s.name),
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
      // The list AS IT IS NOW -- what Rust lists: the user sheets, never a backing sheet.
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
    const shipped = carriedBy(params as { sheetIds?: unknown; sheetIndices?: unknown }, "published");
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
    const answer = h.diffAnswers.shift();
    if (answer?.wait) await answer.wait;
    if (answer?.reject !== undefined) throw answer.reject;
    const carried = carriedBy(params as { sheetIds?: unknown; sheetIndices?: unknown }, "compared");
    return {
      packageName: "sales",
      baseVersion: "1.0.0",
      diff: diffOf(carried),
      code: { codeChanges: [], asksApprovalAgain: false, codeError: null },
      // EVERY sheet the in-memory publish wrote: ticked, backing, chart sources.
      carriedSheetIds: carried.map((s) => s.id),
    };
  }),
  workingCopyStatus: vi.fn(async () => status()),
  pushMergeAnalyze: vi.fn(),
  pushMergeApply: vi.fn(),
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
vi.mock("@api/collaboration", () => ({
  holdBackCells: vi.fn(async (params: HoldBackRequest) => {
    h.holdBackRequests.push(params);
    // RUST'S RULE (`calp_hold_back_cells`): the push's own selection, resolved
    // the way the publish resolves it -- a ticked sheet that is gone refuses,
    // as the publish would, before anything is written, and so does a
    // renumbering that kept overlapping the resolution -- and exactly the named
    // cells on sheets that push carries are held back; the rest are skipped.
    const refusal = h.holdBackAnswers.shift();
    if (refusal !== undefined) throw refusal;
    const carried = new Set(carriedBy(params, "published").map((s) => s.id));
    const held = params.cells.filter((c) => carried.has(c.sheetId));
    h.holdBacks.push(held);
    const cellsSkipped = params.cells.length - held.length;
    if (held.length === 0) return { cellsHeldBack: 0, cellsSkipped, undoRecorded: false, undoSeq: null };
    h.undoSeq += 1;
    return { cellsHeldBack: held.length, cellsSkipped, undoRecorded: true, undoSeq: h.undoSeq };
  }),
}));
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
/** The names the sheet list shows, in order. */
const listedNames = (): string[] =>
  [...container.querySelectorAll("label")]
    .filter((l) => l.querySelector('input[type="checkbox"]') !== null && l.querySelector("span") !== null)
    .map((l) => l.querySelector("span")!.textContent ?? "");
/** A diff row's "Push" checkbox, e.g. `cellBox("Summary!A1")`. */
const cellBox = (where: string): HTMLInputElement | null =>
  container.querySelector<HTMLInputElement>(`input[aria-label="Push ${where}"]`);
/** The "Include comments" checkbox. */
const includeCommentsBox = (): HTMLInputElement | null =>
  container.querySelector<HTMLInputElement>("#publish-include-comments");
/** The pinned "N change(s) stay local" strip ("" when it is not on screen). */
const stripText = (): string =>
  container.querySelector('[data-testid="push-holdback-strip"]')?.textContent ?? "";
/** What the dialog says about unticks it dropped ("" when it says nothing). */
const droppedText = (): string =>
  container.querySelector('[data-testid="push-holdback-dropped"]')?.textContent ?? "";
/** What the dialog says about unticks on a sheet the push does not carry ("" when it says nothing). */
const parkedText = (): string =>
  container.querySelector('[data-testid="push-holdback-parked"]')?.textContent ?? "";
const PARKED_ONE =
  "1 change(s) you held back are on a sheet this push does not carry; they stay held back if the push carries it again.";
const PARKED_TWO =
  "2 change(s) you held back are on a sheet this push does not carry; they stay held back if the push carries it again.";

/** A list of cells in one order, so a comparison does not depend on the order they were unticked in. */
const inOrder = (cells: readonly CellRef[]): CellRef[] =>
  [...cells].sort((a, b) => a.sheetId.localeCompare(b.sheetId) || a.row - b.row || a.col - b.col);
/** The cells of every hold-back request, each in one order. */
const askedCells = (): CellRef[][] => h.holdBackRequests.map((r) => inOrder(r.cells));

async function typeSummary(text: string): Promise<void> {
  const summary = container.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(summary, text);
    summary.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

async function open(sheets: ModelSheet[], openCount = 1): Promise<void> {
  h.sheets.splice(0, h.sheets.length, ...sheets);
  await act(async () => {
    root.render(<PublishDialog isOpen onClose={vi.fn()} data={{ __openCount: openCount }} />);
  });
  await flush();
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
/** A canvas page that hosts a floating grid. */
const PAGE: ModelSheet = { id: "id-page", name: "Page" };
/** The floating grid's backing sheet: carried with PAGE, in no list. */
const FLOAT1: ModelBackingSheet = { id: "id-float", name: "Float1", hostId: "id-page" };
/** A sheet a chart on Summary reads (when a test says so). */
const DATA: ModelSheet = { id: "id-data", name: "Data" };
const A1: ModelCell = { a1: "A1", row: 0, col: 0 };
const B1: ModelCell = { a1: "B1", row: 0, col: 1 };
const B2: ModelCell = { a1: "B2", row: 1, col: 1 };
const C3: ModelCell = { a1: "C3", row: 2, col: 2 };
const D1: ModelCell = { a1: "D1", row: 0, col: 3 };
/** The cells the way the hold-back is asked for them. */
const HELD_A1: CellRef = { sheetId: "id-summary", row: 0, col: 0 };
const HELD_B1: CellRef = { sheetId: "id-summary", row: 0, col: 1 };
const HELD_D1: CellRef = { sheetId: "id-dashboard", row: 0, col: 3 };
const HELD_FLOAT_B2: CellRef = { sheetId: "id-float", row: 1, col: 1 };
const HELD_DATA_C3: CellRef = { sheetId: "id-data", row: 2, col: 2 };

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  h.sheets.length = 0;
  h.backing.length = 0;
  h.chartSources = {};
  h.listRemoved = false;
  h.changes = { "id-summary": [A1, B1], "id-dashboard": [D1] };
  h.previews.length = 0;
  h.published.length = 0;
  h.diffs.length = 0;
  h.shipped.length = 0;
  h.holdBackRequests.length = 0;
  h.holdBacks.length = 0;
  h.undoSeq = 0;
  h.diffAnswers.length = 0;
  h.holdBackAnswers.length = 0;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("a held-back change survives the dialog reading the sheet list again", () => {
  // SABOTAGES, each on its own: clear the unticks in the diff effect again
  // (`dispatchHoldBack({ type: "reset" })` beside the keepSheets sort) -- the
  // re-read after the refusal ticks A1 again, and the second Push ships it; or
  // drop the hold-back's selection-refusal branch -- the raw code reaches the
  // screen beside a Ctrl+Z hint for a write that never happened, and the list
  // is never read again.
  it("untick Summary!A1, delete the ticked Dashboard, Push (refused before anything is written), Push again: A1 is held back", async () => {
    await open([SUMMARY, DASHBOARD]);
    await click(cellBox("Summary!A1"));
    expect(cellBox("Summary!A1")!.checked).toBe(false);
    expect(stripText()).toContain("1 change(s) stay local");

    deleteSheet("id-dashboard");
    const diffsBefore = h.diffs.length;
    await click(buttonNamed("Push"));
    expect(h.shipped, "a push with a gone sheet shipped something").toHaveLength(0);
    expect(screenText()).toContain("no longer in the workbook, so nothing was published");
    // THE HOLD-BACK IS TOLD THE PUSH'S OWN SELECTION, so it meets the gone
    // sheet the way the publish would -- and refuses before it writes anything.
    expect(askedCells()).toEqual([[HELD_A1]]);
    expect(h.holdBackRequests[0].sheetIds, "the hold-back was not told the push's own selection").toEqual([
      "id-summary",
      "id-dashboard",
    ]);
    expect(h.holdBacks, "the hold-back wrote something before the refusal").toEqual([]);
    expect(h.published, "the publish ran after the hold-back refused").toHaveLength(0);
    expect(screenText(), "the raw code reached the screen").not.toContain("CALP_PUSH_SHEET_GONE");
    expect(screenText(), "a Ctrl+Z hint for a write that never happened").not.toContain("Ctrl+Z");
    // The list was read again, and the comparison worked out again for it --
    // the refetch that used to tick every held-back change again.
    expect(listedNames()).toEqual(["Summary"]);
    expect(screenText()).toContain("The list of sheets has been read again");
    expect(h.diffs.length, "the diff was not worked out again: the test proves nothing").toBeGreaterThan(diffsBefore);
    expect(cellBox("Summary!A1")!.checked, "the re-read ticked the held-back change again").toBe(false);
    expect(stripText()).toContain("1 change(s) stay local");
    expect(droppedText(), "an untick on a sheet still in the push was announced as dropped").toBe("");

    await click(buttonNamed("Push"));
    expect(h.holdBacks, "the second push did not hold A1 back").toEqual([[HELD_A1]]);
    expect(h.shipped).toEqual([["Summary"]]);
    expect(screenText()).toContain("Pushed sales v1.0.1");
  });

  it("the same through Preview: refused, the list read again, A1 still held back, and the next Push holds it back", async () => {
    await open([SUMMARY, DASHBOARD]);
    await click(cellBox("Summary!A1"));
    deleteSheet("id-dashboard");
    const diffsBefore = h.diffs.length;
    await click(buttonNamed("Preview"));
    expect(screenText()).toContain("no longer in the workbook, so nothing was previewed");
    expect(listedNames()).toEqual(["Summary"]);
    expect(h.diffs.length, "the diff was not worked out again: the test proves nothing").toBeGreaterThan(diffsBefore);
    expect(cellBox("Summary!A1")!.checked, "the re-read ticked the held-back change again").toBe(false);
    expect(stripText()).toContain("1 change(s) stay local");

    await click(buttonNamed("Push"));
    expect(h.holdBacks).toEqual([[HELD_A1]]);
    expect(h.shipped).toEqual([["Summary"]]);
  });

  it("unticking a DIFFERENT sheet by hand keeps the A1 untick", async () => {
    await open([SUMMARY, DASHBOARD]);
    await click(cellBox("Summary!A1"));
    const diffsBefore = h.diffs.length;
    await click(sheetBox("Dashboard"));
    expect(h.diffs.length, "the diff was not worked out again: the test proves nothing").toBeGreaterThan(diffsBefore);
    expect(cellBox("Summary!A1")!.checked, "unticking another sheet ticked A1 again").toBe(false);
    expect(stripText()).toContain("1 change(s) stay local");
    expect(droppedText()).toBe("");

    await click(buttonNamed("Push"));
    expect(h.holdBacks).toEqual([[HELD_A1]]);
    expect(h.shipped).toEqual([["Summary"]]);
  });
});

describe("the hold-back meets the push's own refusals before it writes anything (round 11)", () => {
  // SABOTAGE: drop the retryable refusal from the hold-back's selection-refusal
  // branch (`isWorkbookChangedWhileSaving(e) ||`) -- the raw code reaches the
  // screen beside a Ctrl+Z hint for a write that never happened, and nothing
  // offers Try again.
  it("the retryable refusal: its plain sentence, no Ctrl+Z hint, and Try again holds back and pushes", async () => {
    await open([SUMMARY]);
    await click(cellBox("Summary!A1"));
    h.holdBackAnswers.push(
      "WORKBOOK_CHANGED_WHILE_SAVING: the workbook changed while it was being published -- a sheet was added, " +
        "deleted or moved while the sheets to include were being worked out. Nothing was written; try again.",
    );
    await click(buttonNamed("Push"));
    expect(screenText(), "the raw code reached the screen").not.toContain("WORKBOOK_CHANGED_WHILE_SAVING");
    expect(screenText(), "a Ctrl+Z hint for a write that never happened").not.toContain("Ctrl+Z");
    expect(screenText()).toContain("The workbook changed while it was being published");
    expect(h.holdBacks, "the refused hold-back wrote something").toEqual([]);
    expect(h.published, "the publish ran after the hold-back refused").toHaveLength(0);

    await click(retryButton());
    expect(h.holdBacks, "Try again did not hold A1 back").toEqual([[HELD_A1]]);
    expect(h.shipped).toEqual([["Summary"]]);
    expect(screenText()).toContain("Pushed sales v1.0.1");
  });
});

describe("a held-back change survives its own sheet being unticked and ticked again (round 10, R10-1)", () => {
  // TWO SABOTAGES, each on its own:
  //   * never move a PARKED untick back into `excluded` when the answer
  //     carries its sheet again (lib/holdBack.ts keepSheets) -- A1 is then not
  //     counted as staying local, and the parked line stays;
  //   * judge the answer's rows without the sheets it carries (drop the
  //     `sheetIds` limit from keepRows) -- the Dashboard-only comparison then
  //     "no longer lists" the parked A1 and takes it away.
  it("untick Summary!A1, untick Summary, tick it again: A1 is still held back, and the Push holds it back and ships both", async () => {
    await open([SUMMARY, DASHBOARD]);
    await click(cellBox("Summary!A1"));
    expect(stripText()).toContain("1 change(s) stay local");

    // By mistake: the whole sheet.
    const diffsBefore = h.diffs.length;
    await click(sheetBox("Summary"));
    expect(h.diffs.length, "the diff was not worked out again: the test proves nothing").toBeGreaterThan(diffsBefore);
    expect(cellBox("Summary!A1"), "Summary's rows are still listed: the test proves nothing").toBeNull();
    expect(droppedText(), "the other sheet's comparison took the parked hold-back away").toBe("");
    expect(parkedText(), "the parked hold-back is not said").toBe(PARKED_ONE);
    expect(stripText(), "a parked untick was counted as staying local in THIS push").toBe("");

    // ...and back.
    await click(sheetBox("Summary"));
    expect(cellBox("Summary!A1"), "Summary's rows are not listed again").toBeTruthy();
    expect(cellBox("Summary!A1")!.checked, "ticking the sheet again ticked the held-back change again").toBe(false);
    expect(stripText(), "the answer that carries Summary again did not bring its hold-back back").toContain(
      "1 change(s) stay local",
    );
    expect(droppedText(), "a notice says the hold-back was let go").toBe("");
    expect(parkedText(), "the parked line outlived the sheet being ticked again").toBe("");

    await click(buttonNamed("Push"));
    expect(h.holdBacks, "the push did not hold A1 back").toEqual([[HELD_A1]]);
    expect(h.shipped).toEqual([["Summary", "Dashboard"]]);
  });
});

describe("an untick on a sheet the push does not carry is PARKED: said, and sent for Rust to skip", () => {
  // SABOTAGE: drop the `push-holdback-parked` line from the dialog.
  it("its sheet left the push: the untick on it is parked -- said truly, held back by nothing -- and the others stay", async () => {
    await open([SUMMARY, DASHBOARD]);
    await click(cellBox("Summary!A1"));
    await click(cellBox("Dashboard!D1"));
    expect(stripText()).toContain("2 change(s) stay local");
    await click(sheetBox("Dashboard"));
    expect(parkedText()).toBe(PARKED_ONE);
    expect(droppedText(), "a parked untick was announced as let go").toBe("");
    expect(stripText()).toContain("1 change(s) stay local");
    await click(buttonNamed("Push"));
    // EVERY untick goes with the push's own selection; Rust holds back the ones
    // on sheets that push carries -- not D1, whose sheet it does not.
    expect(askedCells(), "the push did not send every untick").toEqual([inOrder([HELD_A1, HELD_D1])]);
    expect(h.holdBackRequests[0].sheetIds, "the hold-back was not told the push's own selection").toEqual([
      "id-summary",
    ]);
    expect(h.holdBacks, "a parked untick acted on a push that does not carry its sheet").toEqual([[HELD_A1]]);
    expect(h.shipped).toEqual([["Summary"]]);
  });

  // SABOTAGE: send only `excluded` with the push (round 11's push) -- A1 is
  // still parked when Push is pressed, so nothing holds it back and the push
  // publishes it.
  it("pushed before the answer lands: a parked untick on a sheet the push carries again is sent, and held back", async () => {
    await open([SUMMARY, DASHBOARD]);
    await click(cellBox("Summary!A1"));
    await click(sheetBox("Summary"));
    expect(parkedText(), "the precondition: A1 is parked").toBe(PARKED_ONE);
    // Summary ticked again -- and its comparison is still out when Push is
    // pressed: nothing moves before the answer, so A1 is still parked.
    let release!: () => void;
    h.diffAnswers.push({ wait: new Promise<void>((r) => (release = r)) });
    await click(sheetBox("Summary"));
    expect(screenText()).toContain("Working out what you changed");
    expect(parkedText(), "the precondition: A1 is still parked while the answer is out").toBe(PARKED_ONE);
    await click(buttonNamed("Push"));
    expect(askedCells(), "a parked untick was not sent: the push published it").toEqual([[HELD_A1]]);
    expect(h.holdBackRequests[0].sheetIds, "the hold-back was not told the push's own selection").toEqual([
      "id-summary",
      "id-dashboard",
    ]);
    expect(h.holdBacks, "the push did not hold A1 back").toEqual([[HELD_A1]]);
    expect(h.shipped).toEqual([["Summary", "Dashboard"]]);
    await act(async () => release());
    await flush();
  });
});

describe("an untick on a floating grid's BACKING sheet -- carried with its host page, never ticked itself (round 11)", () => {
  // THE ROUND-11 LEAK. The unticks were sorted by the TICKED rows, and a
  // backing sheet never is one: every refetch parked the untick, the strip let
  // it go, the line under the panel said its sheet was not in this push -- and
  // Push, which sent only the unticks it had sorted as acting, shipped Float1
  // with B2's private value under the author's key.
  // SABOTAGE: sort the answer by the ticked rows instead of its
  // `carriedSheetIds`.
  it("survives Include comments, another sheet's untick and re-tick, and the host's untick and re-tick -- and the push holds it back", async () => {
    h.backing.push(FLOAT1);
    h.changes = { "id-summary": [A1], "id-float": [B2], "id-dashboard": [D1] };
    await open([SUMMARY, PAGE, DASHBOARD]);
    expect(listedNames(), "the backing sheet has a row in the sheet list: the model is wrong").toEqual([
      "Summary",
      "Page",
      "Dashboard",
    ]);
    expect(cellBox("Float1!B2"), "the diff does not list the backing sheet's change: the test proves nothing").toBeTruthy();
    await click(cellBox("Float1!B2"));
    const stillHeld = (when: string): void => {
      expect(cellBox("Float1!B2"), `${when}: the backing sheet's row is gone`).toBeTruthy();
      expect(cellBox("Float1!B2")!.checked, `${when}: the held-back change shows ticked again`).toBe(false);
      expect(stripText(), `${when}: the strip does not count the held-back change`).toContain("1 change(s) stay local");
      expect(parkedText(), `${when}: a carried sheet's untick was said to be on a sheet the push does not carry`).toBe("");
      expect(droppedText(), `${when}: the held-back change was announced as let go`).toBe("");
    };
    stillHeld("after the untick");

    let diffsBefore = h.diffs.length;
    await click(includeCommentsBox());
    expect(h.diffs.length, "Include comments did not work the comparison out again: the test proves nothing").toBeGreaterThan(
      diffsBefore,
    );
    stillHeld("after Include comments");

    diffsBefore = h.diffs.length;
    await click(sheetBox("Dashboard"));
    await click(sheetBox("Dashboard"));
    expect(h.diffs.length, "another sheet's boxes did not work the comparison out again").toBeGreaterThan(diffsBefore + 1);
    stillHeld("after another sheet's untick and re-tick");

    // The host page unticked: the push does not carry its backing sheet now --
    // parked, and said so truly.
    await click(sheetBox("Page"));
    expect(cellBox("Float1!B2"), "the backing sheet's rows are still listed: the test proves nothing").toBeNull();
    expect(parkedText()).toBe(PARKED_ONE);
    expect(stripText()).toBe("");
    // ...and ticked again: the answer carries the backing sheet again.
    await click(sheetBox("Page"));
    stillHeld("after the host's untick and re-tick");

    await click(buttonNamed("Push"));
    expect(askedCells()).toEqual([[HELD_FLOAT_B2]]);
    const asked = h.holdBackRequests[0];
    expect(asked.kind, "the hold-back was not told the push's kind").toBe("report");
    expect(asked.sheetIds, "the hold-back was not told the push's own selection").toEqual([
      "id-summary",
      "id-page",
      "id-dashboard",
    ]);
    expect(asked.sheetIds).toEqual(h.published[0].sheetIds);
    expect(asked.sheetIndices).toEqual(h.published[0].sheetIndices);
    expect(h.holdBacks, "the push did not hold the backing sheet's change back").toEqual([[HELD_FLOAT_B2]]);
    expect(h.shipped).toEqual([["Summary", "Page", "Dashboard", "Float1"]]);
  });

  // NOTHING MOVES BEFORE THE ANSWER. SABOTAGE: sort the unticks by the ticked
  // rows when the comparison is ASKED (round 11's keepSheets at the start of
  // the effect) -- until the answer lands, the backing sheet's untick is then
  // parked and said to be on a sheet the push does not carry, while it ships.
  it("while a comparison is out, nothing moves: the strip still counts the backing sheet's untick, and nothing is said parked", async () => {
    h.backing.push(FLOAT1);
    h.changes = { "id-summary": [A1], "id-float": [B2] };
    await open([SUMMARY, PAGE]);
    await click(cellBox("Float1!B2"));
    let release!: () => void;
    h.diffAnswers.push({ wait: new Promise<void>((r) => (release = r)) });
    await click(includeCommentsBox());
    expect(screenText(), "the comparison is not out: the test proves nothing").toContain("Working out what you changed");
    expect(stripText(), "an untick was moved before the answer said where").toContain("1 change(s) stay local");
    expect(parkedText(), "an untick was parked before the answer said its sheet is not carried").toBe("");
    await act(async () => release());
    await flush();
    expect(stripText()).toContain("1 change(s) stay local");
    expect(parkedText()).toBe("");
  });
});

describe("an untick on a sheet a CHART reads -- carried although its box is unticked (round 11)", () => {
  // SABOTAGE: sort the answer by the ticked rows instead of its
  // `carriedSheetIds` -- Data's box is unticked, so C3 is parked and said to be
  // on a sheet the push does not carry, while the push ships Data.
  it("untick Data!C3, then untick Data while a chart on Summary reads it: C3 still acts, and the push holds it back", async () => {
    h.chartSources = { "id-summary": ["id-data"] };
    h.changes = { "id-summary": [A1], "id-data": [C3] };
    await open([SUMMARY, DATA]);
    await click(cellBox("Data!C3"));
    await click(sheetBox("Data"));
    expect(sheetBox("Data")!.checked, "the precondition: Data's box is unticked").toBe(false);
    expect(cellBox("Data!C3"), "the push carries Data, so the diff lists its change").toBeTruthy();
    expect(cellBox("Data!C3")!.checked, "the held-back change shows ticked again").toBe(false);
    expect(stripText(), "an untick on a sheet the push carries is not counted").toContain("1 change(s) stay local");
    expect(parkedText(), "a sheet the push carries was said not to be carried").toBe("");

    await click(buttonNamed("Push"));
    expect(askedCells()).toEqual([[HELD_DATA_C3]]);
    expect(h.holdBackRequests[0].sheetIds, "the hold-back was not told the push's own selection").toEqual(["id-summary"]);
    expect(h.holdBacks, "the chart source's change was not held back").toEqual([[HELD_DATA_C3]]);
    expect(h.shipped).toEqual([["Summary", "Data"]]);
  });

  // SABOTAGE: count every untick in the parked line (`excluded` and `parked`).
  it("the parked line counts only the sheets the answer says the push does NOT carry", async () => {
    h.chartSources = { "id-summary": ["id-data"] };
    h.changes = { "id-summary": [A1], "id-data": [C3], "id-dashboard": [D1] };
    await open([SUMMARY, DATA, DASHBOARD]);
    await click(cellBox("Data!C3"));
    await click(cellBox("Dashboard!D1"));
    await click(sheetBox("Data"));
    await click(sheetBox("Dashboard"));
    // Data is carried (the chart reads it); Dashboard is not.
    expect(parkedText(), "the parked line counted an untick on a sheet the push carries").toBe(PARKED_ONE);
    expect(stripText()).toContain("1 change(s) stay local");

    await click(buttonNamed("Push"));
    expect(askedCells(), "the push did not send every untick").toEqual([inOrder([HELD_DATA_C3, HELD_D1])]);
    expect(h.holdBacks).toEqual([[HELD_DATA_C3]]);
    expect(h.shipped).toEqual([["Summary", "Data"]]);
  });
});

describe("a base sheet the push drops is listed as 'removed' -- and is not carried (round 11)", () => {
  // SABOTAGES, each on its own: take the carried sheets from the answer's own
  // rows (`diff.sheets`), the dialog-only fix the review warned off -- Summary
  // is listed, as removed, so A1 comes back as "staying local" on a sheet the
  // push does not publish and the parked line goes; or put an untick of a row
  // in `excluded` whatever its sheet (`toggle` without the answer's `carried`).
  it("untick Summary!A1, untick Summary: A1 stays parked on its removed row, an untick of another removed row parks at once, and nothing is held back", async () => {
    h.listRemoved = true;
    await open([SUMMARY, DASHBOARD]);
    await click(cellBox("Summary!A1"));
    await click(sheetBox("Summary"));
    expect(cellBox("Summary!A1"), "the diff does not list the removed sheet's rows: the test proves nothing").toBeTruthy();
    expect(cellBox("Summary!A1")!.checked, "the author's untick shows ticked on its row").toBe(false);
    expect(parkedText(), "a removed sheet's untick is not said to be on a sheet the push does not carry").toBe(PARKED_ONE);
    expect(stripText(), "an untick on a sheet the push drops was counted as staying local").toBe("");

    await click(cellBox("Summary!B1"));
    expect(cellBox("Summary!B1")!.checked).toBe(false);
    expect(parkedText(), "an untick of a removed row was not parked at once").toBe(PARKED_TWO);
    expect(stripText(), "an untick of a removed row was counted as staying local").toBe("");

    await click(buttonNamed("Push"));
    expect(askedCells(), "the push did not send every untick").toEqual([inOrder([HELD_A1, HELD_B1])]);
    expect(h.holdBacks, "a cell on a sheet the push drops was held back").toEqual([[]]);
    expect(h.shipped).toEqual([["Dashboard"]]);
  });
});

describe("an untick the dialog has to drop is said, never silent", () => {
  it("the new comparison no longer lists its row: dropped and announced, naming the panel", async () => {
    await open([SUMMARY, DASHBOARD]);
    await click(cellBox("Summary!A1"));
    await click(cellBox("Summary!B1"));
    // The author put B1 back the way the base has it: the next comparison no
    // longer lists it, so its untick has no row to be seen on.
    h.changes["id-summary"] = [A1];
    await click(sheetBox("Dashboard"));
    expect(droppedText()).toBe(
      '1 change(s) you held back are no longer held back, because "Changes since v1.0.0" no longer lists them.',
    );
    expect(cellBox("Summary!B1"), "B1 still has a row").toBeNull();
    await click(buttonNamed("Push"));
    expect(askedCells(), "an untick without a row was still sent").toEqual([[HELD_A1]]);
    expect(h.holdBacks, "an untick without a row still acted on the push").toEqual([[HELD_A1]]);
  });

  // SABOTAGE: judge the answer by the sheets IT lists (`result.diff.sheets`)
  // instead of the ones it says the push carries -- a sheet whose every
  // change was put back is not in the answer's rows at all, so its untick
  // would stay, with no row, and act on the push.
  it("a sheet whose every change was put back: its untick has no row left, so it is dropped and announced", async () => {
    await open([SUMMARY, DASHBOARD]);
    await click(cellBox("Dashboard!D1"));
    // D1 put back the way the base has it: Dashboard has no change left.
    h.changes["id-dashboard"] = [];
    await click(sheetBox("Summary"));
    expect(cellBox("Dashboard!D1"), "D1 still has a row").toBeNull();
    expect(droppedText()).toBe(
      '1 change(s) you held back are no longer held back, because "Changes since v1.0.0" no longer lists them.',
    );
    await click(buttonNamed("Push"));
    expect(h.holdBackRequests, "an untick without a row was still sent").toEqual([]);
    expect(h.holdBacks, "an untick without a row still acted on the push").toEqual([]);
    expect(h.shipped).toEqual([["Dashboard"]]);
  });

  it("the author's next gesture on the list replaces the notice", async () => {
    await open([SUMMARY, DASHBOARD]);
    await click(cellBox("Summary!B1"));
    // B1 put back the way the base has it: the next comparison no longer lists it.
    h.changes["id-summary"] = [A1];
    await click(sheetBox("Dashboard"));
    expect(droppedText(), "the precondition: a drop is announced").not.toBe("");
    await click(cellBox("Summary!A1"));
    expect(droppedText(), "a notice outlived the author's next untick").toBe("");
  });
});

describe("a comparison that failed lists none of the earlier answer's rows (round 10)", () => {
  // SABOTAGE: drop `setDiff(null)` from the diff effect's catch -- the rows of
  // the answer before, which describe the selection before, come back under
  // "Could not compare".
  it("untick Dashboard and the comparison fails: no row describes the earlier selection, and the strip stays", async () => {
    await open([SUMMARY, DASHBOARD]);
    await click(cellBox("Summary!A1"));
    expect(cellBox("Dashboard!D1"), "the precondition: the first answer lists Dashboard").toBeTruthy();
    h.diffAnswers.push({ reject: "the share is gone" });
    await click(sheetBox("Dashboard"));
    expect(screenText()).toContain("Could not compare against v1.0.0: the share is gone");
    expect(cellBox("Dashboard!D1"), "a row of the earlier answer -- an unticked sheet -- is still listed").toBeNull();
    expect(cellBox("Summary!B1"), "a row of the earlier answer is still listed under the error").toBeNull();
    expect(stripText(), "the strip vanished with the rows").toContain("1 change(s) stay local");
    await click(buttonNamed("Push"));
    expect(h.holdBacks).toEqual([[HELD_A1]]);
    expect(h.shipped).toEqual([["Summary"]]);
  });
});

describe("an exclusion never acts unseen: the strip stays while the rows are not listed", () => {
  // The dialog's answer to "while the diff refetches or after it failed": the
  // pinned strip keeps counting what stays local, beside its Push all (see
  // the strip's comment in PublishDialog.tsx for why that, not a block).
  // SABOTAGE: render the strip only when the rows are on screen
  // (`excludedCells.size > 0 && diff && !diffBusy && !diffError`).
  it("while the comparison is worked out again, and after it failed, the strip still says what stays local", async () => {
    await open([SUMMARY, DASHBOARD]);
    await click(cellBox("Summary!A1"));
    let release!: () => void;
    h.diffAnswers.push({ wait: new Promise<void>((r) => (release = r)), reject: "the share is gone" });
    await click(sheetBox("Dashboard"));
    expect(screenText()).toContain("Working out what you changed");
    expect(cellBox("Summary!A1"), "the rows are on screen: the test proves nothing").toBeNull();
    expect(stripText(), "the strip vanished while the rows were not listed").toContain("1 change(s) stay local");

    await act(async () => release());
    await flush();
    expect(screenText()).toContain("Could not compare against v1.0.0: the share is gone");
    expect(stripText(), "the strip vanished after the comparison failed").toContain("1 change(s) stay local");
    expect(buttonNamed("Push all"), "the way to undo the hold-back is gone").toBeTruthy();

    // What the strip counts is what the push holds back: no more.
    await click(buttonNamed("Push"));
    expect(h.holdBacks).toEqual([[HELD_A1]]);
  });
});

describe("where the hold-back starts afresh", () => {
  // SABOTAGE: drop the reset from handlePublish's success path -- the landed
  // push's unticks would then hold back the next push's cells, unseen.
  it("a push that landed: every change is ticked again for the next push", async () => {
    await open([SUMMARY]);
    await click(cellBox("Summary!A1"));
    await click(buttonNamed("Push"));
    expect(h.holdBacks).toEqual([[HELD_A1]]);
    expect(screenText()).toContain("Pushed sales v1.0.1");
    expect(stripText(), "the landed push's hold-back outlived it").toBe("");
    expect(cellBox("Summary!A1")!.checked).toBe(true);
  });

  // SABOTAGE: drop the reset from the openCount effect.
  it("a new show: every change is ticked again", async () => {
    await open([SUMMARY], 1);
    await click(cellBox("Summary!A1"));
    expect(stripText()).toContain("1 change(s) stay local");
    await act(async () => {
      root.render(<PublishDialog isOpen onClose={vi.fn()} data={{ __openCount: 2 }} />);
    });
    await flush();
    expect(stripText(), "an untick outlived the show it was made in").toBe("");
    expect(cellBox("Summary!A1")!.checked).toBe(true);
  });
});
