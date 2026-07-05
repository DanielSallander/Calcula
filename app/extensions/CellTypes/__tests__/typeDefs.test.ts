//! FILENAME: app/extensions/CellTypes/__tests__/typeDefs.test.ts
// PURPOSE: Unit tests for the starter cell-type definitions: checkbox
//          coerce/validate semantics, progress-bar value parsing/clamping,
//          and button label fallback.

import { describe, it, expect, vi } from "vitest";
import { checkboxCellType } from "../types/checkbox";
import { progressCellType } from "../types/progress";
import { buttonCellType } from "../types/button";
import type { CellTypeRenderContext } from "@api/cellTypes";

function mockCtx(): CanvasRenderingContext2D {
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

function renderContext(
  value: string,
  params: Record<string, unknown> = {},
  typeId = "test"
): CellTypeRenderContext {
  return {
    ctx: mockCtx(),
    row: 0,
    col: 0,
    cellLeft: 0,
    cellTop: 0,
    cellRight: 100,
    cellBottom: 24,
    config: {} as never,
    viewport: {} as never,
    dimensions: {} as never,
    display: value,
    styleIndex: 0,
    styleCache: new Map() as never,
    typeId,
    params,
    value,
    hasFormula: false,
  };
}

// ----------------------------------------------------------------------------
// Checkbox
// ----------------------------------------------------------------------------

describe("checkbox cell type", () => {
  it("coerces common truthy/falsy input to TRUE/FALSE", () => {
    expect(checkboxCellType.coerce?.("yes", {})).toBe("TRUE");
    expect(checkboxCellType.coerce?.("True", {})).toBe("TRUE");
    expect(checkboxCellType.coerce?.("1", {})).toBe("TRUE");
    expect(checkboxCellType.coerce?.("no", {})).toBe("FALSE");
    expect(checkboxCellType.coerce?.("0", {})).toBe("FALSE");
    // Formulas and unknowns pass through untouched.
    expect(checkboxCellType.coerce?.("=A1", {})).toBeNull();
    expect(checkboxCellType.coerce?.("banana", {})).toBeNull();
  });

  it("validates only booleans, empty, and formulas", () => {
    expect(checkboxCellType.validate?.("TRUE", {})).toBeNull();
    expect(checkboxCellType.validate?.("FALSE", {})).toBeNull();
    expect(checkboxCellType.validate?.("", {})).toBeNull();
    expect(checkboxCellType.validate?.("=IF(A1;1;0)", {})).toBeNull();
    expect(checkboxCellType.validate?.("banana", {})).toBe("retry");
  });

  it("renders (handles) boolean and empty values, falls through for text", () => {
    expect(checkboxCellType.render(renderContext("TRUE"))).toBe(true);
    expect(checkboxCellType.render(renderContext("FALSE"))).toBe(true);
    expect(checkboxCellType.render(renderContext(""))).toBe(true);
    expect(checkboxCellType.render(renderContext("hello"))).toBe(false);
  });

  it("uses the pointer cursor", () => {
    expect(checkboxCellType.getCursor?.({})).toBe("pointer");
  });
});

// ----------------------------------------------------------------------------
// Progress bar
// ----------------------------------------------------------------------------

describe("progress cell type", () => {
  it("handles numeric values and empty cells", () => {
    expect(progressCellType.render(renderContext("0.5"))).toBe(true);
    expect(progressCellType.render(renderContext(""))).toBe(true);
    expect(progressCellType.render(renderContext("42", { max: 100 }))).toBe(true);
  });

  it("tolerates locale decimal commas and percent suffixes", () => {
    expect(progressCellType.render(renderContext("0,42"))).toBe(true);
    expect(progressCellType.render(renderContext("42%"))).toBe(true);
  });

  it("falls through to plain text for non-numeric values", () => {
    expect(progressCellType.render(renderContext("n/a"))).toBe(false);
  });

  it("is normally editable (no editor lock, no click claim)", () => {
    expect(progressCellType.editor).toBe("default");
    expect(progressCellType.onClick).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// Button
// ----------------------------------------------------------------------------

describe("button cell type", () => {
  it("always handles rendering (label from value or params)", () => {
    expect(buttonCellType.render(renderContext("Run"))).toBe(true);
    expect(buttonCellType.render(renderContext("", { label: "Go" }))).toBe(true);
    expect(buttonCellType.render(renderContext(""))).toBe(true);
  });

  it("is not editable and shows a pointer cursor", () => {
    expect(buttonCellType.editor).toBe("none");
    expect(buttonCellType.getCursor?.({})).toBe("pointer");
  });

  it("displayText falls back to the label param", () => {
    expect(buttonCellType.displayText?.("Run", {})).toBe("Run");
    expect(buttonCellType.displayText?.("", { label: "Go" })).toBe("Go");
  });
});
