//! FILENAME: app/extensions/Controls/__tests__/embedToggleMove.test.ts
// PURPOSE: The floating -> in-cell toggle MOVES the button (one backend step
//          that keeps its held code and re-keys its object scripts) and never
//          re-creates it through the paste door (BUG-0257; review finding: no
//          test pinned this, and the old set-then-remove route passed every test).
// CONTEXT: `setControlMetadata` is the paste door and strips a button's HELD
//          code, so re-creating a working copy's button at its new cell lost the
//          application's code and the next push published it empty. The move is
//          a function of its own (`lib/embedToggleMove.ts`) so its behaviour can
//          be run; the toggle's USE of it is pinned from the source, the style of
//          `shapeCreation.test.ts` (importing index.ts would drag in the whole
//          extension to prove a property of one function).

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

const h = vi.hoisted(() => ({
  moveControl: vi.fn(),
  setControlMetadata: vi.fn(),
  removeControlMetadata: vi.fn(),
  scripts: [] as { id: string; objectType: string; instanceId: string | null }[],
  registered: [] as { id: string; instanceId: string | null }[],
}));

vi.mock("../lib/controlApi", () => ({
  moveControl: (...a: unknown[]) => h.moveControl(...a),
  setControlMetadata: (...a: unknown[]) => h.setControlMetadata(...a),
  removeControlMetadata: (...a: unknown[]) => h.removeControlMetadata(...a),
}));
vi.mock("@api", () => ({
  // eslint-disable-next-line @typescript-eslint/naming-convention -- the @api export's own name
  ObjectScriptManager: {
    getAllScripts: () => h.scripts,
    registerScript: (s: { id: string; instanceId: string | null }) => h.registered.push(s),
  },
}));

import { moveFloatingButtonIntoCell } from "../lib/embedToggleMove";

beforeEach(() => {
  h.moveControl.mockReset();
  h.moveControl.mockResolvedValue({ controlType: "button", properties: {} });
  h.setControlMetadata.mockReset();
  h.removeControlMetadata.mockReset();
  h.scripts = [
    { id: "os-moved", objectType: "button", instanceId: "control-0-2-1" },
    { id: "os-other", objectType: "button", instanceId: "control-0-9-9" },
  ];
  h.registered = [];
});

describe("the toggle's move", () => {
  // SABOTAGE: implement the move as setControlMetadata(target) +
  // removeControlMetadata(source) in lib/embedToggleMove.ts.
  it("is ONE move_control call marking the button embedded, never a re-create", async () => {
    await moveFloatingButtonIntoCell(0, { row: 2, col: 1 }, { row: 6, col: 3 });
    expect(h.moveControl).toHaveBeenCalledTimes(1);
    expect(h.moveControl).toHaveBeenCalledWith(0, 2, 1, 6, 3, {
      embedded: { valueType: "static", value: "true" },
    });
    expect(h.setControlMetadata, "the paste door strips held code").not.toHaveBeenCalled();
    expect(h.removeControlMetadata).not.toHaveBeenCalled();
  });

  it("follows the backend's re-keyed binding in this session's script registry", async () => {
    await moveFloatingButtonIntoCell(0, { row: 2, col: 1 }, { row: 6, col: 3 });
    expect(h.registered).toEqual([{ id: "os-moved", objectType: "button", instanceId: "control-0-6-3" }]);
  });

  it("does nothing when the cell does not change", async () => {
    await moveFloatingButtonIntoCell(0, { row: 2, col: 1 }, { row: 2, col: 1 });
    expect(h.moveControl).not.toHaveBeenCalled();
    expect(h.registered).toEqual([]);
  });

  it("a refused move (another control at the target) throws and re-keys nothing", async () => {
    h.moveControl.mockRejectedValue(new Error("Another control already sits at sheet 0 r6c3"));
    await expect(moveFloatingButtonIntoCell(0, { row: 2, col: 1 }, { row: 6, col: 3 })).rejects.toThrow(
      "Another control",
    );
    expect(h.registered).toEqual([]);
  });
});

/** The body of `async function handleEmbeddedToggle(` in Controls/index.ts, comments stripped. */
function toggleBody(): string {
  const src = fs
    .readFileSync(path.resolve(__dirname, "../index.ts"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  const start = src.indexOf("async function handleEmbeddedToggle(");
  expect(start, "handleEmbeddedToggle moved or was renamed").toBeGreaterThan(-1);
  const open = src.indexOf("{", src.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error("unterminated handleEmbeddedToggle");
}

describe("the floating -> in-cell toggle uses the move", () => {
  // SABOTAGE: replace the toggle's move with
  // `setControlMetadata(sheetIndex, targetRow, targetCol, ...)` +
  // `removeControlMetadata(sheetIndex, row, col)` in Controls/index.ts.
  it("moves the button with moveFloatingButtonIntoCell and never re-creates it", () => {
    const body = toggleBody();
    expect(body).toContain("moveFloatingButtonIntoCell(");
    expect(body, "the toggle re-creates the button through the paste door").not.toContain("setControlMetadata(");
    expect(body).not.toContain("removeControlMetadata(");
  });

  it("moves FIRST, so a refusal leaves nothing half-toggled", () => {
    const body = toggleBody();
    const move = body.indexOf("moveFloatingButtonIntoCell(");
    const format = body.indexOf("applyFormatting(");
    expect(move).toBeGreaterThan(-1);
    expect(format).toBeGreaterThan(-1);
    expect(move, "the cell is formatted before the move can refuse").toBeLessThan(format);
    // ...and a refusal returns before anything else happens.
    const afterMove = body.slice(move, format);
    expect(afterMove).toMatch(/catch \(err\) \{[\s\S]*return;/);
  });
});
