//! FILENAME: app/src/api/scriptHost/scriptPreview/__tests__/previewEntry.test.ts
// PURPOSE: Pin what the public rung does when it CANNOT reach a verdict — the
//          half that decides whether a missing answer reads as "no objection"
//          or as "this script is broken".
// CONTEXT: docs/design/local-model-script-authoring.md §5c.
//
//          This tier cannot exercise the realm at all: jsdom has no `Worker`,
//          and that is precisely why these cases matter here. A rung whose
//          failure mode is "reports the environment as the script's defect" is
//          the exact thing L3 already did once, rejecting every valid draft
//          with "it FAILS when run against a copy of the workbook". The
//          positive path — a script that really runs — is proved by the E2E
//          spec (`e2e/journeys/script-preview.spec.ts`), which is the only tier
//          with a realm to run it in.

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

import { previewObjectScript } from "../index";
import { hostPreviewScript, workerRealmAvailable } from "../../host";

const SOURCE = `export function setup(context) {
  context.onClick(() => context.api.setCellValue(0, 0, "hi"));
}
`;

describe("with no Worker realm (jsdom)", () => {
  it("precondition: this environment really has no realm", () => {
    // Without this the two assertions below would be true for the wrong reason,
    // and would go on being true after the realm started working.
    expect(workerRealmAvailable()).toBe(false);
  });

  it("hostPreviewScript says the REALM is missing, and does not call it a failed run", async () => {
    const result = await hostPreviewScript({
      source: SOURCE,
      objectType: "button",
      backend: () => undefined,
    });
    expect(result.realmUnavailable).toBe(true);
    expect(result.ran).toBe(false);
    expect(result.error, "an absent realm is not an error IN the script").toBeUndefined();
  });

  it("previewObjectScript DECLINES rather than reporting a defect", async () => {
    const report = await previewObjectScript({
      source: SOURCE,
      objectType: "button",
      fixture: [{ row: 0, col: 0, value: "seed" }],
    });
    expect(report.applicable).toBe(false);
    expect(report.declinedReason).toMatch(/Worker realm/i);
    // The safe direction: a caller reading only `ok` sees no objection.
    expect(report.ok).toBe(true);
    expect(report.error).toBeNull();
    expect(report.totalChanges).toBe(0);
  });

  it("declines a snapshot it could not take, naming the reason", async () => {
    const report = await previewObjectScript({
      source: SOURCE,
      objectType: "button",
      snapshotSource: {
        getSheetNames: async () => {
          throw new Error("backend unavailable");
        },
        getActiveSheet: async () => 0,
        getUsedRange: async () => ({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true }),
        getRangeCells: async () => [],
      },
    });
    expect(report.applicable).toBe(false);
    expect(report.declinedReason).toContain("could not be copied");
    // A workbook that could not be read says NOTHING about the script — so this
    // must not arrive as "it changed no cells", which reads as a finding.
    expect(report.ok).toBe(true);
  });
});

describe("the report shape stays the one every consumer already reads", () => {
  it("is structurally the DryRunReport `ai_dry_run_script` returns", async () => {
    // Both rungs answer the same question about different realms. A second
    // shape would mean teaching the draft gate, the repair prompt and the
    // transcript note a second vocabulary — and `applicable` is the field they
    // all branch on before drawing any conclusion.
    const report = await previewObjectScript({ source: SOURCE, objectType: "button", fixture: [] });
    expect(Object.keys(report).sort()).toEqual(
      [
        "applicable",
        "changes",
        "declinedReason",
        "durationMs",
        "error",
        "ok",
        "output",
        "readBack",
        "totalChanges",
        "truncated",
        "unexercisedHooks",
      ].sort(),
    );
  });
});
