//! FILENAME: app/src/api/__tests__/cellTypes.test.ts
// PURPOSE: Unit tests for the cell-type registry, assignment index, render
//          dispatch (incl. unknown-id fallback), and the commit-guard fan-out
//          (coerce/validate with value rewriting).

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => []),
}));

import {
  registerCellType,
  unregisterCellType,
  getCellTypeDefinition,
  hasCellTypes,
  getCellTypeAt,
  renderCellTypeCell,
  handleCellTypeKeyDown,
  __resetCellTypesForTests,
  __seedAssignmentForTests,
  type CellTypeDefinition,
} from "../cellTypes";
import { checkCommitGuards } from "../../core/lib/commitGuards";
import { checkEditGuards } from "../../core/lib/editGuards";
import { getCellCursorOverride } from "../../core/lib/cellClickInterceptors";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function mockCanvasCtx(): CanvasRenderingContext2D {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    roundRect: vi.fn(),
    measureText: vi.fn(() => ({ width: 10 })),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    lineCap: "butt",
    lineJoin: "miter",
  } as unknown as CanvasRenderingContext2D;
}

function renderContext(ctx: CanvasRenderingContext2D, row: number, col: number, display = "") {
  return {
    ctx,
    row,
    col,
    cellLeft: 0,
    cellTop: 0,
    cellRight: 100,
    cellBottom: 24,
    config: {} as never,
    viewport: {} as never,
    dimensions: {} as never,
    display,
    styleIndex: 0,
    styleCache: new Map() as never,
  };
}

function makeDef(overrides: Partial<CellTypeDefinition> = {}): CellTypeDefinition {
  return {
    id: "test.type",
    render: () => true,
    ...overrides,
  };
}

beforeEach(() => {
  __resetCellTypesForTests();
});

// ----------------------------------------------------------------------------
// Registry + index
// ----------------------------------------------------------------------------

describe("cellTypes registry", () => {
  it("registers, resolves, and unregisters definitions", () => {
    const cleanup = registerCellType(makeDef());
    expect(getCellTypeDefinition("test.type")?.id).toBe("test.type");
    cleanup();
    expect(getCellTypeDefinition("test.type")).toBeNull();
  });

  it("hasCellTypes reflects assignments, not definitions", () => {
    registerCellType(makeDef());
    expect(hasCellTypes()).toBe(false);
    __seedAssignmentForTests(2, 3, "test.type");
    expect(hasCellTypes()).toBe(true);
  });

  it("getCellTypeAt keys cells without row/col collisions", () => {
    __seedAssignmentForTests(1, 2, "test.type", { a: 1 });
    expect(getCellTypeAt(1, 2)?.params).toEqual({ a: 1 });
    // A naive additive key (row + col) would collide these:
    expect(getCellTypeAt(2, 1)).toBeNull();
    expect(getCellTypeAt(0, 3)).toBeNull();
    expect(getCellTypeAt(3, 0)).toBeNull();
    // Large row indices stay distinct (1M-row grids).
    __seedAssignmentForTests(1_000_000, 5, "test.type");
    expect(getCellTypeAt(1_000_000, 5)).not.toBeNull();
    expect(getCellTypeAt(999_999, 5)).toBeNull();
  });

  it("re-resolves existing assignments when a definition arrives later", () => {
    const ctx = mockCanvasCtx();
    __seedAssignmentForTests(0, 0, "late.type");
    // Unregistered: fallback badge path, not handled.
    expect(renderCellTypeCell(renderContext(ctx, 0, 0))).toBe(false);
    registerCellType(makeDef({ id: "late.type" }));
    expect(renderCellTypeCell(renderContext(ctx, 0, 0))).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// Render dispatch
// ----------------------------------------------------------------------------

describe("renderCellTypeCell", () => {
  it("returns false for untyped cells without touching the canvas", () => {
    const ctx = mockCanvasCtx();
    expect(renderCellTypeCell(renderContext(ctx, 5, 5))).toBe(false);
    expect(ctx.save).not.toHaveBeenCalled();
  });

  it("passes typeId/params/value through and propagates handled=true", () => {
    const render = vi.fn(() => true);
    registerCellType(makeDef({ render }));
    __seedAssignmentForTests(1, 1, "test.type", { max: 100 });
    const ctx = mockCanvasCtx();

    expect(renderCellTypeCell(renderContext(ctx, 1, 1, "42"))).toBe(true);
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        typeId: "test.type",
        params: { max: 100 },
        value: "42",
        hasFormula: false,
      })
    );
    // Balanced save/restore around the type's draw.
    expect(ctx.save).toHaveBeenCalledTimes(1);
    expect(ctx.restore).toHaveBeenCalledTimes(1);
  });

  it("treats void/false render results as not-handled (text still draws)", () => {
    registerCellType(makeDef({ render: () => undefined }));
    __seedAssignmentForTests(0, 0, "test.type");
    expect(renderCellTypeCell(renderContext(mockCanvasCtx(), 0, 0))).toBe(false);
  });

  it("contains render errors and keeps save/restore balanced", () => {
    registerCellType(
      makeDef({
        render: () => {
          throw new Error("boom");
        },
      })
    );
    __seedAssignmentForTests(0, 0, "test.type");
    const ctx = mockCanvasCtx();
    expect(renderCellTypeCell(renderContext(ctx, 0, 0))).toBe(false);
    expect(ctx.restore).toHaveBeenCalledTimes(1);
  });

  it("draws the fallback badge for unknown type ids and returns false", () => {
    __seedAssignmentForTests(0, 0, "not.registered");
    const ctx = mockCanvasCtx();
    expect(renderCellTypeCell(renderContext(ctx, 0, 0, "hello"))).toBe(false);
    expect(ctx.fill).toHaveBeenCalled(); // corner triangle
    expect(ctx.restore).toHaveBeenCalledTimes(1);
  });
});

// ----------------------------------------------------------------------------
// Fan-out: keyboard / cursor / edit guard / commit guard
// ----------------------------------------------------------------------------

describe("cellTypes fan-out hooks", () => {
  it("handleCellTypeKeyDown dispatches to the type and reports handled", async () => {
    const onKeyDown = vi.fn(async () => true);
    registerCellType(makeDef({ onKeyDown }));
    __seedAssignmentForTests(3, 4, "test.type");

    expect(await handleCellTypeKeyDown(3, 4, " ")).toBe(true);
    expect(onKeyDown).toHaveBeenCalledWith(
      expect.objectContaining({ row: 3, col: 4, key: " ", typeId: "test.type" })
    );
    expect(await handleCellTypeKeyDown(9, 9, " ")).toBe(false);
  });

  it("cursor interceptor returns the type's cursor for typed cells only", () => {
    registerCellType(makeDef({ getCursor: () => "pointer" }));
    __seedAssignmentForTests(2, 2, "test.type");
    expect(getCellCursorOverride(2, 2)).toBe("pointer");
    expect(getCellCursorOverride(0, 0)).toBeNull();
  });

  it("edit guard blocks gestures for editor:'none' types only", async () => {
    registerCellType(makeDef({ id: "locked.type", editor: "none" }));
    registerCellType(makeDef({ id: "open.type", editor: "default" }));
    __seedAssignmentForTests(0, 0, "locked.type");
    __seedAssignmentForTests(0, 1, "open.type");

    expect((await checkEditGuards(0, 0))?.blocked).toBe(true);
    expect(await checkEditGuards(0, 1)).toBeNull();
    expect(await checkEditGuards(5, 5)).toBeNull();
  });

  it("commit guard coerces and validates typed cells", async () => {
    registerCellType(
      makeDef({
        id: "bool.type",
        coerce: (value) => {
          const lower = value.toLowerCase();
          if (lower === "yes") return "TRUE";
          if (lower === "no") return "FALSE";
          return null;
        },
        validate: (value) =>
          value === "" || value === "TRUE" || value === "FALSE" ? null : "retry",
      })
    );
    __seedAssignmentForTests(1, 0, "bool.type");

    // Coercion rewrites through an allow-with-newValue.
    const coerced = await checkCommitGuards(1, 0, "yes");
    expect(coerced).toEqual({ action: "allow", newValue: "TRUE" });

    // Valid values pass untouched.
    expect(await checkCommitGuards(1, 0, "TRUE")).toBeNull();

    // Invalid values keep the editor open.
    expect((await checkCommitGuards(1, 0, "banana"))?.action).toBe("retry");

    // Untyped cells are untouched.
    expect(await checkCommitGuards(8, 8, "banana")).toBeNull();
  });
});
