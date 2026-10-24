//! FILENAME: app/e2e/__tests__/subscriberDiffSendsIds.test.ts
// PURPOSE: The e2e helper `subscriberDiff` asks for the subscriber's "View
//          changes" comparison the way SubscriptionDiffDialog asks for it: the
//          application's provenance rows BY STABLE ID (`sheetIds`, the shape
//          the dialog's own `selectionWire` gives) beside their positions.
// CONTEXT: Review round 10 (WIRE-RUST-R10-1). Rust now refuses a request that
//          names, BY POSITION, an object sheet -- a floating range's hidden
//          backing sheet, which no sheet list shows -- with
//          CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE. The provenance lists a
//          subscribed application's pulled backing sheets, so a helper that
//          sent positions alone would have its comparison refused for every
//          application that carries a floating range, and the journey reading
//          it would report as a product failure what was the harness's own.
//
// This is a NODE unit test of the harness (vitest picks up e2e/**/*.test.ts);
// it launches nothing. The page is a stand-in whose `evaluate` runs the
// callback here, and whose `window.__appImport` hands back doubled modules:
// @api/collaboration (one subscription, its provenance rows, and a diff door
// that refuses a position naming an object sheet the way Rust now does) and
// listedSheets (a `selectionWire` that records what it was asked).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Page } from "@playwright/test";
import { LISTED_SHEETS, subscriberDiff } from "../helpers/calp-collab";
import { COLLAB, type AppWindow } from "../helpers/calp-harness";

const WS = "C:/workspaces/team";

/**
 * The subscriber's workbook: its own Notes, the application's Report and its
 * canvas Page -- the three sheets any list shows -- and, at the tail, the
 * hidden backing sheet of the floating grid on that Page.
 */
const LISTED_SHEET_COUNT = 3;
const PROVENANCE = [
  { role: "subscribed", packageName: "sales", registryUrl: WS, sheetIndex: 1, sheetId: "local-report", packageSheetId: "pub-report" },
  { role: "subscribed", packageName: "sales", registryUrl: WS, sheetIndex: 2, sheetId: "local-page", packageSheetId: "pub-page" },
  { role: "subscribed", packageName: "sales", registryUrl: WS, sheetIndex: 3, sheetId: "local-float", packageSheetId: "pub-float" },
  // Another application's sheet, and one the publisher dropped: neither is compared.
  { role: "subscribed", packageName: "other", registryUrl: WS, sheetIndex: 0, sheetId: "local-notes", packageSheetId: "pub-notes" },
  { role: "subscribed", packageName: "sales", registryUrl: WS, sheetIndex: 2, sheetId: "local-gone", packageSheetId: "pub-gone", upstreamRemoved: true },
];

const EMPTY_DIFF = {
  totals: { objectsAdded: 0, objectsRemoved: 0, objectsModified: 0, cellsChanged: 0 },
  sheets: [],
  objects: [],
  manifestChanges: [],
};

let diffRequests: Record<string, unknown>[];
let selectionAsked: unknown[];

/** The modules the stand-in page imports, by the path the harness asks for. */
const MODULES: Record<string, Record<string, (...args: never[]) => unknown>> = {
  [COLLAB]: {
    getSubscriptions: async () => ({
      subscriptions: [{ packageName: "sales", registryUrl: WS, resolvedVersion: "1.2.0" }],
    }),
    getSheetProvenance: async () => PROVENANCE,
    diffWorkingCopy: async (params: Record<string, unknown>) => {
      diffRequests.push(params);
      // RUST'S RULE: ids take precedence and may name a backing sheet; a
      // POSITION must name a sheet the list shows.
      if (!Array.isArray(params.sheetIds)) {
        const past = (params.sheetIndices as number[]).find((i) => i >= LISTED_SHEET_COUNT);
        if (past !== undefined) {
          throw (
            `CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE: There is no sheet at index ${past}: the workbook has 3 sheets ` +
            "(indexes 0 to 2). Nothing was compared; read the sheet list again and choose the sheets again."
          );
        }
      }
      return { packageName: "sales", baseVersion: "1.2.0", diff: EMPTY_DIFF };
    },
  },
  [LISTED_SHEETS]: {
    selectionWire: (rows: { index: number; sheetId: string }[]) => {
      selectionAsked.push(rows);
      return { sheetIndices: rows.map((r) => r.index), sheetIds: rows.map((r) => r.sheetId) };
    },
  },
};

/** A page whose `evaluate` runs the callback in this process, as the app's window would. */
const page = {
  evaluate: async (fn: (arg: unknown) => unknown, arg?: unknown) => fn(arg),
} as unknown as Page;

beforeEach(() => {
  diffRequests = [];
  selectionAsked = [];
  (window as unknown as AppWindow).__appImport = async (modulePath: string) => {
    const m = MODULES[modulePath];
    if (!m) throw new Error(`the stand-in page has no module ${modulePath}`);
    return m;
  };
});

afterEach(() => {
  delete (window as unknown as AppWindow).__appImport;
});

describe("subscriberDiff asks the way SubscriptionDiffDialog asks", () => {
  // SABOTAGE: send `sheetIndices: mine.map((x) => x.sheetIndex)` alone again --
  // the floating grid's backing sheet is then named by a position past the
  // list, and the comparison is refused.
  it("sends the application's sheets by LOCAL id beside their positions, so a pulled backing sheet is compared, not refused", async () => {
    const diff = await subscriberDiff(page, "sales");
    expect(diff).toEqual(EMPTY_DIFF);
    expect(selectionAsked, "the dialog's selectionWire was not asked").toEqual([
      [
        { index: 1, sheetId: "local-report" },
        { index: 2, sheetId: "local-page" },
        { index: 3, sheetId: "local-float" },
      ],
    ]);
    expect(diffRequests).toHaveLength(1);
    const asked = diffRequests[0];
    expect(asked.sheetIds, "the comparison went out without the sheets' ids").toEqual([
      "local-report",
      "local-page",
      "local-float",
    ]);
    expect(asked.sheetIndices).toEqual([1, 2, 3]);
    // The PUBLISHER's ids scope the rows, as before.
    expect(asked.scopeSheetIds).toEqual(["pub-report", "pub-page", "pub-float"]);
    expect(asked).toMatchObject({ registryPath: WS, packageName: "sales", baseVersion: "1.2.0", includeComments: true });
  });
});
