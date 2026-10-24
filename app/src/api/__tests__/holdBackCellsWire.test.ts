//! FILENAME: app/src/api/__tests__/holdBackCellsWire.test.ts
// PURPOSE: `holdBackCells` sends the push's own selection beside the cells, and
//          its request and answer are Rust's, field for field.
// CONTEXT: Review round 11, RV11-TS-1. The push dialog sorted its unticks by
//          the rows it ticked and sent the hold-back only the ones it had
//          sorted as acting -- but a push carries more sheets than are ticked
//          (a floating grid's backing sheet with its host, a chart's source),
//          so an untick on such a sheet never reached the hold-back and the
//          push published the cell. Now the hold-back is told the push's
//          `kind` and selection and holds back exactly the cells on sheets that
//          push carries (`HoldBackCellsParams`, `HoldBackCellsResponse` in
//          app/src-tauri/src/calp_commands.rs). The real @api wrapper with only
//          the backend door doubled, plus drift checks that read the Rust
//          structs at test time (the direction is Rust -> TypeScript): a field
//          renamed on one side would leave the selection unread, and the push
//          would hold back by Rust's DEFAULT selection instead of its own.

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const h = vi.hoisted(() => ({ calls: [] as { cmd: string; args: unknown }[] }));

vi.mock("../backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backend")>()),
  invokeBackend: async (cmd: string, args?: unknown) => {
    h.calls.push({ cmd, args });
    return { cellsHeldBack: 1, cellsSkipped: 1, undoRecorded: true, undoSeq: 7 };
  },
}));

import { holdBackCells, type HoldBackCellsResponse, type HoldBackCellRef } from "../collaboration";

const COMMANDS_RS = "../../../src-tauri/src/calp_commands.rs";
const COLLABORATION_TS = "../collaboration.ts";

beforeEach(() => {
  h.calls.length = 0;
});

const read = (rel: string): string => fs.readFileSync(path.resolve(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

function rustBody(struct: string): string {
  const src = read(COMMANDS_RS);
  const start = src.indexOf(`pub struct ${struct} {`);
  expect(start, `Rust ${struct} not found in calp_commands.rs`).toBeGreaterThanOrEqual(0);
  return src.slice(start, src.indexOf("\n}\n", start));
}

/** The struct's fields, camelCased the way `rename_all = "camelCase"` sends them. */
function rustFields(struct: string): string[] {
  return [...rustBody(struct).matchAll(/^\s*pub (\w+):/gm)].map((m) =>
    m[1].replace(/_(\w)/g, (_, c: string) => c.toUpperCase()),
  );
}

/** A TS type body's fields (two-space indent), each with whether it is optional. */
function fieldsOf(body: string): Map<string, boolean> {
  return new Map([...body.matchAll(/^ {2}(\w+)(\??):/gm)].map((m) => [m[1], m[2] === "?"]));
}

/**
 * The fields of `holdBackCells`' inline params type, read from the SOURCE:
 * vitest does not type-check, so a typed sample alone could never see a
 * TypeScript-side rename.
 */
function tsParams(): Map<string, boolean> {
  const ts = read(COLLABORATION_TS);
  const start = ts.indexOf("export function holdBackCells(params: {");
  expect(start, "holdBackCells moved or was renamed").toBeGreaterThanOrEqual(0);
  return fieldsOf(ts.slice(start, ts.indexOf("}): Promise<HoldBackCellsResponse>", start)));
}

/** The fields of a TS interface in collaboration.ts, read from the source. */
function tsInterface(name: string): Map<string, boolean> {
  const ts = read(COLLABORATION_TS);
  const start = ts.indexOf(`export interface ${name} {`);
  expect(start, `TS ${name} not found in collaboration.ts`).toBeGreaterThanOrEqual(0);
  return fieldsOf(ts.slice(start, ts.indexOf("\n}\n", start)));
}

describe("holdBackCells", () => {
  // SABOTAGE: stop passing the params through (build `{ cells }` alone).
  it("sends the cells WITH the push's kind and selection to calp_hold_back_cells, and returns what was skipped", async () => {
    const cells: HoldBackCellRef[] = [
      { sheetId: "id-float", row: 1, col: 1 },
      { sheetId: "id-private", row: 0, col: 0 },
    ];
    const answer = await holdBackCells({
      registryPath: "\\\\server\\apps",
      packageName: "sales",
      baseVersion: "1.0.0",
      cells,
      kind: "report",
      sheetIndices: [0, 1],
      sheetIds: ["id-summary", "id-page"],
    });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].cmd).toBe("calp_hold_back_cells");
    const params = (h.calls[0].args as { params: Record<string, unknown> }).params;
    expect(params.cells).toEqual(cells);
    expect(params.kind).toBe("report");
    expect(params.sheetIndices).toEqual([0, 1]);
    expect(params.sheetIds).toEqual(["id-summary", "id-page"]);
    expect(answer.cellsSkipped).toBe(1);
  });
});

describe("the wire shape is Rust's", () => {
  // SABOTAGE: rename a TS parameter (e.g. `sheetIds` -> `sheets`), or drop `kind`.
  it("HoldBackCellsParams: every Rust field is a holdBackCells parameter, camelCased", () => {
    expect([...tsParams().keys()].sort()).toEqual(rustFields("HoldBackCellsParams").sort());
  });

  // A field Rust defaults may be left out; one it does not must be sent.
  // SABOTAGE: make `kind` optional in TypeScript, or drop a `#[serde(default)]`.
  it("the selection is optional on both sides (Rust defaults it), and the kind is required on both", () => {
    const params = tsParams();
    const rust = rustBody("HoldBackCellsParams");
    expect(rust).toMatch(/#\[serde\(default\)\]\s*pub sheet_indices: Vec<usize>,/);
    expect(rust).toMatch(/#\[serde\(default\)\]\s*pub sheet_ids: Option<Vec<String>>,/);
    expect(rust).toMatch(/\n\s*pub kind: String,/);
    expect(rust, "the kind became defaulted on the Rust side").not.toMatch(/#\[serde\(default\)\]\s*pub kind:/);
    expect(params.get("sheetIndices")).toBe(true);
    expect(params.get("sheetIds")).toBe(true);
    expect(params.get("kind"), "the push's kind is optional in TypeScript").toBe(false);
    expect(params.get("cells")).toBe(false);
  });

  // SABOTAGE: rename a field of the TS answer (e.g. `cellsSkipped` -> `skipped`).
  it("HoldBackCellsResponse: every Rust field is a TypeScript field, camelCased", () => {
    expect([...tsInterface("HoldBackCellsResponse").keys()].sort()).toEqual(
      rustFields("HoldBackCellsResponse").sort(),
    );
    // What Rust ALWAYS sends is not optional in TypeScript.
    expect(tsInterface("HoldBackCellsResponse").get("cellsSkipped"), "cellsSkipped is optional in TypeScript").toBe(
      false,
    );
    const sample: Required<HoldBackCellsResponse> = {
      cellsHeldBack: 0,
      cellsSkipped: 0,
      undoRecorded: false,
      undoSeq: null,
    };
    expect(sample.cellsSkipped).toBe(0);
  });

  it("HoldBackCellRef: every Rust field is a TypeScript field, camelCased", () => {
    expect([...tsInterface("HoldBackCellRef").keys()].sort()).toEqual(rustFields("HoldBackCellRef").sort());
    const sample: Required<HoldBackCellRef> = { sheetId: "", row: 0, col: 0 };
    expect(Object.keys(sample).sort()).toEqual(rustFields("HoldBackCellRef").sort());
  });
});
