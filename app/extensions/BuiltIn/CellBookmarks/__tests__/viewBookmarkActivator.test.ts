//! FILENAME: app/extensions/BuiltIn/CellBookmarks/__tests__/viewBookmarkActivator.test.ts
// PURPOSE: Owner decision B, follow-up F10 -- a view bookmark's on-activate
//          script is told WHO activated the bookmark, so an application's macro
//          a SCRIPT set off (a queued `Calcula.bookmarks.activateViewBookmark`)
//          is refused by the module-runtime gate, while the user's own click on
//          the bookmark runs it as before.
// CONTEXT: The REAL store and the REAL mutation handler, with the runner the
//          extension installs replaced by a recorder (the runner's own
//          forwarding to `runWorkbookScript` is pinned in
//          ScriptableObjects/__tests__/macroConsentTriggerHonesty.test.ts, and
//          what `runWorkbookScript` then sends in src/api/__tests__/
//          runScriptStartedByWire.test.ts). A census pins who says "person".

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

// The store's restore doors: a bookmark that captured no dimension restores
// nothing, so none is reached -- but the module imports them.
vi.mock("@api", () => ({
  dispatchGridAction: vi.fn(),
  setSelection: vi.fn(),
  setViewport: vi.fn(),
  setZoom: vi.fn(),
  setViewMode: vi.fn(),
  setShowFormulas: vi.fn(),
  setFreezeConfig: vi.fn(),
  setSplitConfig: vi.fn(),
  hideRows: vi.fn(),
  hideColumns: vi.fn(),
  setColumnWidth: vi.fn(),
  setRowHeight: vi.fn(),
  activateSheet: vi.fn(async () => undefined),
  scrollToPosition: vi.fn(),
  getAutoFilter: vi.fn(async () => null),
  applyAutoFilter: vi.fn(),
  setColumnFilterValues: vi.fn(),
  removeAutoFilter: vi.fn(),
  clearAutoFilterCriteria: vi.fn(),
}));
vi.mock("@api/grid", () => ({ getGridStateSnapshot: () => null }));
vi.mock("@api/lib", () => ({ getSheets: async () => ({ sheets: [], activeIndex: 0 }) }));

import {
  activateViewBookmark,
  loadViewBookmarks,
  setScriptRunner,
  type ViewBookmarkActivator,
} from "../lib/viewBookmarkStore";
import { processBookmarkMutations } from "../lib/scriptMutationHandler";
import type { ViewBookmark } from "../lib/viewBookmarkTypes";

const NOTHING_CAPTURED = Object.fromEntries(
  [
    "activeSheet",
    "selection",
    "viewport",
    "zoom",
    "viewMode",
    "showFormulas",
    "freezeConfig",
    "splitConfig",
    "hiddenRows",
    "hiddenCols",
    "columnWidths",
    "rowHeights",
    "autoFilter",
  ].map((k) => [k, false]),
);

let ran: Array<[string, ViewBookmarkActivator]> = [];

beforeEach(() => {
  ran = [];
  loadViewBookmarks([
    {
      id: "vb-1",
      label: "Report view",
      color: "blue",
      dimensions: NOTHING_CAPTURED,
      snapshot: {},
      onActivateScriptId: "macro-report",
      createdAt: 0,
      updatedAt: 0,
    } as unknown as ViewBookmark,
  ]);
  setScriptRunner(async (scriptId, activatedBy) => {
    ran.push([scriptId, activatedBy]);
  });
});

describe("the bookmark's script is told who activated the bookmark", () => {
  // SABOTAGE: pass "person" in scriptMutationHandler's activateViewBookmark
  // call -> a script's activation reaches the runner as the user's.
  it("a SCRIPT's queued activation runs it as a script's", async () => {
    await processBookmarkMutations([{ action: "activateViewBookmark", id: "vb-1" }]);
    expect(ran).toEqual([["macro-report", "script"]]);
  });

  it("the user's activation runs it as the user's", async () => {
    expect(await activateViewBookmark("vb-1", "person")).toBe(true);
    expect(ran).toEqual([["macro-report", "person"]]);
  });
});

describe("the census: who may say a PERSON activated a bookmark", () => {
  const ROOT = path.resolve(__dirname, "..");
  const read = (rel: string): string =>
    fs
      .readFileSync(path.join(ROOT, rel), "utf8")
      .replace(/\r\n/g, "\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

  /** Every production file under CellBookmarks, relative to it. */
  function files(dir = ROOT): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__tests__") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...files(full));
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path.relative(ROOT, full).split(path.sep).join("/"));
    }
    return out;
  }

  // SABOTAGE: add a caller of activateViewBookmark that says "person" from a
  // script path (e.g. a new mutation case) -> the call list changes, red.
  it("each caller states its activator: the list and the command say person, the mutations say script", () => {
    const calls: string[] = [];
    for (const rel of files()) {
      for (const m of read(rel).matchAll(/activateViewBookmark\(([^)]*)\)/g)) {
        if (rel === "lib/viewBookmarkStore.ts") continue; // the definition
        calls.push(`${rel}: ${m[1].trim()}`);
      }
    }
    expect(calls.sort()).toEqual([
      'components/ViewBookmarkList.tsx: vb.id, "person"',
      'index.ts: a.id, "person"',
      'lib/scriptMutationHandler.ts: mutation.id, "script"',
    ]);
  });

  it("the command that activates as a person is NOT scriptSafe: no script can run it", () => {
    const index = read("index.ts");
    const at = index.indexOf('commands.register("bookmarks.activateView", async (args?: unknown) => {');
    expect(at, "the command moved").toBeGreaterThan(-1);
    const block = index.slice(at, index.indexOf("\n  });", at) + "\n  });".length);
    expect(block).toContain('activateViewBookmark(a.id, "person")');
    expect(block).not.toContain("scriptSafe");
    // Positive control: the scan would see the flag where other bookmark commands set it.
    expect(index).toContain("}, { scriptSafe: true });");
  });
});
