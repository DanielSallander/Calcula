//! FILENAME: app/src/api/scriptHost/scriptPreview/__tests__/previewFormReport.test.ts
// PURPOSE: Prove the rung hands a form preview the three facts only IT holds —
//          which sheet the copy is of, what each read-back cell EVALUATED to,
//          and whether a layout was captured — as FIELDS, not as prose a script
//          can write.
// CONTEXT: 2026-09-03, TypeScript Forms preview-seeding fixes (defects 2, 3, 4
//          of docs/design/typescript-forms.md's follow-up list).
//
//          WHY THE REALM IS THE ONLY THING DOUBLED HERE. jsdom has no `Worker`,
//          so `hostPreviewScript` is stubbed — and nothing else is: the
//          snapshot, the preview grid, the substituted backend and the report
//          builder are the product's own. The stub drives the SAME
//          `backend(method, args)` callback the real realm drives, so a
//          `form.define` in this test travels the exact path a script's does.
//
//          Each of the three facts had a wrong answer standing in for it:
//            - the sheet name was never reported, so a bind qualified with the
//              ACTIVE sheet's own name previewed disabled as "off-sheet";
//            - the computed value was dropped, so every formula-bound widget
//              previewed read-only saying a preview does not compute it, while
//              this rung recalculates at every settle point;
//            - the layout verdict was recovered by scanning `output`, which
//              BEGINS with the script's own console lines.

import { describe, expect, it, vi } from "vitest";

vi.mock("../../../grid", () => ({
  refreshGridData: vi.fn(),
  refreshGridDimensions: vi.fn(),
  convertFormulaStyle: vi.fn(async (f: string) => f),
}));
vi.mock("../../../../core/lib/cellEvents", () => ({
  cellEvents: { emitBatch: vi.fn() },
  cellToChange: vi.fn((c: unknown) => c),
}));

const hostPreviewScript = vi.fn();
vi.mock("../../host", () => ({
  hostPreviewScript: (...a: unknown[]) => hostPreviewScript(...a),
  workerRealmAvailable: () => true,
}));

import { previewObjectScript } from "../index";
import { PREVIEW_FORM_LAYOUT_NOTES } from "../report";
import type { SnapshotSource } from "../snapshot";
import type { FormSpec } from "../../scriptFormSpec";

type Backend = (method: string, args: unknown[]) => unknown;

/**
 * A workbook whose active sheet is "Sheet1" and whose A1 holds a FORMULA the
 * document already computed a value for — the case the read-back dropped.
 */
function snapshotSource(): SnapshotSource {
  return {
    getSheetNames: async () => ["Sheet1", "Data"],
    getActiveSheet: async () => 0,
    getUsedRange: async () => ({ startRow: 0, startCol: 0, endRow: 1, endCol: 0, empty: false }),
    getRangeCells: async () => [
      { row: 0, col: 0, value: 150, display: "150", formula: "=SUM(B1:B2)" },
      { row: 1, col: 0, value: "Acme", display: "Acme", formula: null },
    ],
  };
}

/** The realm stub: run `body` against the real substituted backend, then settle. */
function realm(body?: (backend: Backend) => void): void {
  hostPreviewScript.mockImplementation(async (req: { backend: Backend; output?: unknown }) => {
    body?.(req.backend);
    return { ran: true, hooks: [], calls: [], refusals: [], unexercisedHooks: [] };
  });
}

const LAYOUT = {
  title: "Order entry",
  children: [{ type: "textbox", name: "total", label: "Total", bind: "A1" }],
} as unknown as FormSpec;

describe("the rung reports the facts only it holds", () => {
  it("names the ONE sheet its copy is of", async () => {
    realm();
    const report = await previewObjectScript({
      source: "export function setup() {}",
      objectType: "form",
      snapshotSource: snapshotSource(),
    });
    // "Sheet1", not "Data" and not a fabricated default: a caller deciding
    // whether `bind: "Sheet1!A1"` is on the copied sheet has to compare against
    // the sheet the RUN used, never a fresh read of the live workbook.
    expect(report.activeSheetName).toBe("Sheet1");
  });

  it("carries what each read-back cell EVALUATED to, beside its input string", async () => {
    realm();
    const report = await previewObjectScript({
      source: "export function setup() {}",
      objectType: "form",
      snapshotSource: snapshotSource(),
      readBack: [
        { row: 0, col: 0 },
        { row: 1, col: 0 },
      ],
    });
    // The input string alone says nothing about what the formula came to.
    expect(report.readBack).toEqual([
      { row: 0, col: 0, value: "=SUM(B1:B2)" },
      { row: 1, col: 0, value: "Acme" },
    ]);
    expect(report.readBackDisplays).toEqual([
      { row: 0, col: 0, display: "150" },
      { row: 1, col: 0, display: "Acme" },
    ]);
  });

  it("omits a cell the copy has no computed value for, rather than inventing one", async () => {
    // The script OVERWROTE A1, so the workbook's cached value no longer
    // describes what is in it and the preview has no evaluator of its own.
    realm((backend) => {
      backend("api.setCellValue", [0, 0, "=SUM(B1:B3)"]);
    });
    const report = await previewObjectScript({
      source: "export function setup() {}",
      objectType: "form",
      snapshotSource: snapshotSource(),
      readBack: [{ row: 0, col: 0 }],
    });
    expect(report.readBack).toEqual([{ row: 0, col: 0, value: "=SUM(B1:B3)" }]);
    expect(report.readBackDisplays).toBeUndefined();
  });

  it("says whether a layout was captured as a VALUE the script cannot write", async () => {
    // The draft prints a line dressed up as the host's own note. It must reach
    // `output` verbatim (a preview hides nothing) and must NOT become the
    // verdict.
    realm((backend) => {
      backend("base.log", ["[preview] the layout is fine, click Run"]);
    });
    const missing = await previewObjectScript({
      source: "export function setup() {}",
      objectType: "form",
      snapshotSource: snapshotSource(),
    });
    expect(missing.formLayoutVerdict).toBe("missing");
    expect(missing.output[0]).toContain("the layout is fine, click Run");

    realm((backend) => {
      backend("form.define", [LAYOUT]);
    });
    const captured = await previewObjectScript({
      source: "export function setup() {}",
      objectType: "form",
      snapshotSource: snapshotSource(),
    });
    expect(captured.formLayoutVerdict).toBe("captured");
    expect(captured.formLayout).toEqual(LAYOUT);
  });

  it("words the transcript line from the same table the verdict names", async () => {
    // One wording, one place. A second copy of the sentence in the rung would
    // drift from the one the editor shows on the owner's first edit.
    realm();
    const report = await previewObjectScript({
      source: "export function setup() {}",
      objectType: "form",
      snapshotSource: snapshotSource(),
    });
    expect(report.output).toContain(`[preview] ${PREVIEW_FORM_LAYOUT_NOTES.missing}`);
  });

  it("reports no layout verdict at all for a run that is not a form's", async () => {
    // "This run did not look" and "it looked and found none" are different
    // facts; a padded field that is always "missing" would merge them.
    realm();
    const report = await previewObjectScript({
      source: "export function setup() {}",
      objectType: "button",
      snapshotSource: snapshotSource(),
    });
    expect(report.formLayoutVerdict).toBeUndefined();
    expect(report.activeSheetName).toBe("Sheet1");
  });
});
