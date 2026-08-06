//! FILENAME: app/src/core/lib/__tests__/defaultGeometry.test.ts
// The frontend's pre-hydration grid geometry must MIRROR the Rust authority.
//
// The authority is `persistence::DEFAULT_ROW_HEIGHT_PX` /
// `DEFAULT_COLUMN_WIDTH_PX` (core/persistence/src/lib.rs), which `AppState`,
// `new_file` and the .cala manifest all read. The TS copy in
// DEFAULT_GRID_CONFIG is what the canvas draws with for the few frames before
// `getDefaultDimensions()` answers.
//
// The defect this guards: the same two numbers were written out as literals in
// five places and drifted — the app launched at 20 x 64.29 while File > New
// handed out 24 x 100. The Rust side is now one constant; this test is what
// stops the TS mirror from drifting away from it in turn.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_GRID_CONFIG } from "../../types";

const RUST_SOURCE = resolve(__dirname, "../../../../../core/persistence/src/lib.rs");

/** Pull `pub const NAME: f64 = <number>;` out of the Rust authority. */
function rustConst(name: string): number {
  const src = readFileSync(RUST_SOURCE, "utf8");
  const match = src.match(
    new RegExp(`pub const ${name}: f64 = ([0-9]+(?:\\.[0-9]+)?);`)
  );
  if (!match) {
    throw new Error(
      `${name} not found in ${RUST_SOURCE} — the Rust authority moved or was ` +
        `renamed; update this test rather than deleting it.`
    );
  }
  return Number(match[1]);
}

describe("default grid geometry mirrors the Rust authority", () => {
  it("defaultCellHeight equals persistence::DEFAULT_ROW_HEIGHT_PX", () => {
    expect(DEFAULT_GRID_CONFIG.defaultCellHeight).toBe(
      rustConst("DEFAULT_ROW_HEIGHT_PX")
    );
  });

  it("defaultCellWidth equals persistence::DEFAULT_COLUMN_WIDTH_PX", () => {
    expect(DEFAULT_GRID_CONFIG.defaultCellWidth).toBe(
      rustConst("DEFAULT_COLUMN_WIDTH_PX")
    );
  });

  it("is Excel's documented default and not the old 24 x 100", () => {
    // Named explicitly so a future edit that reintroduces the drifted pair
    // fails with the reason attached rather than as an opaque number mismatch.
    expect(DEFAULT_GRID_CONFIG.defaultCellHeight).toBe(20);
    expect(DEFAULT_GRID_CONFIG.defaultCellWidth).toBeCloseTo(64.29, 2);
  });
});
