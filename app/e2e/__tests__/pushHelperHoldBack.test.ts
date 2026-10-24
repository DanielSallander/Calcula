//! FILENAME: app/e2e/__tests__/pushHelperHoldBack.test.ts
// PURPOSE: The e2e helper `push` holds cells back the way PublishDialog does:
//          the hold-back is told the push's own `kind` and sheet selection --
//          exactly what the publish after it sends -- and the cells are always
//          put back with a scoped undo.
// CONTEXT: Review round 11, RV11-TS-1. Rust's `calp_hold_back_cells` now takes
//          the push's `kind` (required) and its selection, resolves them the
//          way the publish does, and holds back only the cells on sheets that
//          push carries. A helper that sent the cells alone would have every
//          hold-back refused at the door (`kind` is a required field), and the
//          journey reading it would report as a product failure what was the
//          harness's own; one that sent another selection would hold back by a
//          push it does not make.
//
// This is a NODE unit test of the harness (vitest picks up e2e/**/*.test.ts);
// it launches nothing. The page is a stand-in whose `evaluate` runs the
// callback here, and whose `window.__appImport` hands back doubled modules:
// @api/collaboration (a working copy, its default sheets, a publish, and a
// hold-back that refuses a request without the push's kind the way serde does)
// and the tauri-api `undo`.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Page } from "@playwright/test";
import { push } from "../helpers/calp-collab";
import { COLLAB, type AppWindow } from "../helpers/calp-harness";

const WS = "C:/workspaces/team";
const TAURI_API = "/src/core/lib/tauri-api.ts";

let holdBackRequests: Record<string, unknown>[];
let publishRequests: Record<string, unknown>[];
let undone: unknown[];

/** The modules the stand-in page imports, by the path the harness asks for. */
const MODULES: Record<string, Record<string, (...args: never[]) => unknown>> = {
  [COLLAB]: {
    workingCopyStatus: async () => ({ packageName: "sales", baseVersion: "1.0.0", baseSheets: [] }),
    // The push dialog's default selection: Report and its canvas Page.
    publishPreview: async () => ({ defaultSheetIndices: [1, 2] }),
    holdBackCells: async (params: Record<string, unknown>) => {
      holdBackRequests.push(params);
      // RUST'S RULE: `kind` is a required field of HoldBackCellsParams, so a
      // request without it never reaches the command.
      if (typeof params.kind !== "string") {
        throw "invalid args `params` for command `calp_hold_back_cells`: missing field `kind`";
      }
      const cells = params.cells as unknown[];
      return { cellsHeldBack: cells.length, cellsSkipped: 0, undoRecorded: true, undoSeq: 41 };
    },
    publishApplication: async (params: Record<string, unknown>) => {
      publishRequests.push(params);
      return { packageName: "sales", version: "1.1.0", sheetsPublished: 3 };
    },
  },
  [TAURI_API]: {
    undo: async (seq: unknown) => {
      undone.push(seq);
      return { success: true, refusal: null };
    },
  },
};

/** A page whose `evaluate` runs the callback in this process, as the app's window would. */
const page = {
  evaluate: async (fn: (arg: unknown) => unknown, arg?: unknown) => fn(arg),
} as unknown as Page;

beforeEach(() => {
  holdBackRequests = [];
  publishRequests = [];
  undone = [];
  (window as unknown as AppWindow).__appImport = async (modulePath: string) => {
    const m = MODULES[modulePath];
    if (!m) throw new Error(`the stand-in page has no module ${modulePath}`);
    return m;
  };
});

afterEach(() => {
  delete (window as unknown as AppWindow).__appImport;
});

describe("push holds cells back the way PublishDialog does", () => {
  // SABOTAGE: send the hold-back `{ registryPath, packageName, baseVersion,
  // cells }` alone again -- Rust refuses the request for its missing `kind`.
  it("tells the hold-back the push's own kind and sheets, publishes them, and puts the cells back by the hold-back's id", async () => {
    const cells = [{ sheetId: "id-report", row: 0, col: 0 }];
    const result = await push(page, WS, "sales", "1.1.0", cells);
    expect(result).toMatchObject({ version: "1.1.0" });
    expect(holdBackRequests).toHaveLength(1);
    const held = holdBackRequests[0];
    expect(held.cells).toEqual(cells);
    expect(held).toMatchObject({ registryPath: WS, packageName: "sales", baseVersion: "1.0.0" });
    expect(publishRequests).toHaveLength(1);
    expect(held.kind, "the hold-back was not told the push's kind").toBe(publishRequests[0].kind);
    expect(held.sheetIndices, "the hold-back was not told the push's own sheets").toEqual(
      publishRequests[0].sheetIndices,
    );
    expect(held.sheetIndices).toEqual([1, 2]);
    expect(undone, "the held-back cells were not put back by the hold-back's id").toEqual([41]);
  });
});
