//! FILENAME: app/extensions/TestRunner/lib/__tests__/suiteDoorsNotVacuous.test.ts
// PURPOSE: Three live TestRunner tests take a door that EXISTS, and fail when
//          that door does nothing.
// CONTEXT: Wave E fix-up of Y9. The runner's `ctx.executeCommand` now fails a
//          command id that no registry holds (runner.ts). Three suite tests
//          were built on such ids, or on a setup that proves nothing:
//            - "Excel Gap Features" > DisplayZeros ran `view.toggleDisplayZeros`,
//              a case of Core's keyboard switch only (useSpreadsheetSelection.ts
//              handleCommand): no registry holds it, so the test went from a
//              vacuous pass to an ERROR. Its only asserts were that a cell
//              holding "0" still held "0", which a RENDER flag can never
//              change. The View menu's door is the DISPLAY_ZEROS_TOGGLED app
//              event, which the shell applies to the grid state (Layout.tsx).
//            - "Formatting Operations" > "Cell retains value after style
//              change" ran `format.bold` (registered nowhere) inside a
//              try/catch: no style ever changed.
//            - "Checkbox" > "Insert checkbox initializes cell to FALSE"
//              asserted only the FALSE its own setup wrote.
//          Each test below runs the REAL suite test through the REAL runner,
//          once against a faithful double of the door (it must pass) and once
//          against a door that does nothing (it must FAIL). The shell's
//          DISPLAY_ZEROS_TOGGLED listener and the backend's cells / styles are
//          doubled; the app events are real.

/* eslint-disable @typescript-eslint/naming-convention --
 * The @api double below exports CommandRegistry, CoreCommands and AppEvents by
 * their real (PascalCase) names. */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fake = vi.hoisted(() => {
  interface Style {
    bold: boolean;
    checkbox: boolean;
  }
  const state = {
    cells: new Map<string, { value: string; styleIndex: number }>(),
    styles: [{ bold: false, checkbox: false }] as Style[],
    /** false = the formatting door does nothing (the vacuity control). */
    formattingWorks: true,
    grid: { selection: null as unknown, displayZeros: true },
  };
  const key = (row: number, col: number) => `${row},${col}`;
  return {
    state,
    reset(): void {
      state.cells.clear();
      state.styles.length = 1;
      state.formattingWorks = true;
      state.grid = { selection: null, displayZeros: true };
    },
    cell(row: number, col: number) {
      const c = state.cells.get(key(row, col));
      return { row, col, display: c?.value ?? "", formula: null, styleIndex: c?.styleIndex ?? 0 };
    },
    write(updates: Array<{ row: number; col: number; value: string }>): unknown[] {
      for (const u of updates) {
        const c = state.cells.get(key(u.row, u.col));
        state.cells.set(key(u.row, u.col), { value: u.value, styleIndex: c?.styleIndex ?? 0 });
      }
      return [];
    },
    /** applyFormatting: each touched cell gets a NEW style = its old one + the patch. */
    format(rows: number[], cols: number[], patch: Partial<Style>) {
      if (state.formattingWorks) {
        for (const r of rows) {
          for (const c of cols) {
            const cur = state.cells.get(key(r, c)) ?? { value: "", styleIndex: 0 };
            state.styles.push({ ...state.styles[cur.styleIndex], ...patch });
            state.cells.set(key(r, c), { ...cur, styleIndex: state.styles.length - 1 });
          }
        }
      }
      return { cells: [], styles: [] };
    },
    style(index: number): Style {
      return { ...state.styles[index] };
    },
  };
});

vi.mock("@api", async () => {
  const events = await vi.importActual<typeof import("@api/events")>("@api/events");
  return {
    getCell: vi.fn(async (row: number, col: number) => fake.cell(row, col)),
    getViewportCells: vi.fn(async () => []),
    updateCellsBatch: vi.fn(async (updates: Array<{ row: number; col: number; value: string }>) => fake.write(updates)),
    CommandRegistry: { execute: vi.fn(), has: vi.fn().mockReturnValue(false) },
    CoreCommands: { UNDO: "core.edit.undo", REDO: "core.edit.redo" },
    dispatchGridAction: vi.fn(),
    columnToLetter: (c: number) => {
      let s = "";
      let n = c;
      do {
        s = String.fromCharCode(65 + (n % 26)) + s;
        n = Math.floor(n / 26) - 1;
      } while (n >= 0);
      return s;
    },
    AppEvents: events.AppEvents,
    emitAppEvent: events.emitAppEvent,
    onAppEvent: events.onAppEvent,
  };
});
vi.mock("@api/lib", () => ({
  applyFormatting: vi.fn(async (rows: number[], cols: number[], patch: Record<string, boolean>) =>
    fake.format(rows, cols, patch),
  ),
  getStyle: vi.fn(async (index: number) => fake.style(index)),
  clearRangeWithOptions: vi.fn(async () => ({})),
}));
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: vi.fn(() => fake.state.grid),
  setSelection: vi.fn((selection: unknown) => ({ type: "SET_SELECTION", payload: selection })),
}));

import { registerSuite, clearSuites, runSuiteByName } from "../runner";
import type { TestSuite } from "../types";
import { excelGapFeaturesSuite } from "../suites/excelGapFeatures";
import { formattingSuite } from "../suites/formatting";
import { checkboxSuite } from "../suites/checkbox";
import { AppEvents, onAppEvent } from "@api/events";
import { applyFormatting } from "@api/lib";
import { TEST_AREA, AREA_CHECKBOX } from "../testArea";

/** Run ONE test of `suite` (found by `name`) through the real runner, without the suite's hooks. */
async function runOne(suite: TestSuite, name: RegExp) {
  const test = suite.tests.find((t) => name.test(t.name));
  expect(test, `${suite.name}: no test matches ${name}`).toBeDefined();
  clearSuites();
  registerSuite({ name: `${suite.name} (one test)`, tests: [test!] });
  const result = await runSuiteByName(`${suite.name} (one test)`);
  return result!.results[0];
}

/** What the shell does with the View menu's event (Layout.tsx): the grid state takes the flag. */
function mountShellDisplayZerosListener() {
  const seen: boolean[] = [];
  const off = onAppEvent<{ displayZeros: boolean }>(AppEvents.DISPLAY_ZEROS_TOGGLED, (detail) => {
    seen.push(detail.displayZeros);
    fake.state.grid = { ...fake.state.grid, displayZeros: detail.displayZeros };
  });
  return { seen, off };
}

let unmount: (() => void) | null = null;

beforeEach(() => {
  fake.reset();
  vi.mocked(applyFormatting).mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  unmount?.();
  unmount = null;
  clearSuites();
  vi.restoreAllMocks();
});

describe("Excel Gap Features > DisplayZeros", () => {
  const NAME = /^DisplayZeros:/;

  it("passes by turning the flag OFF through the View menu's door and back ON", async () => {
    const shell = mountShellDisplayZerosListener();
    unmount = shell.off;
    const r = await runOne(excelGapFeaturesSuite, NAME);
    expect(r.status, `the DisplayZeros test did not pass: ${r.error}`).toBe("pass");
    expect(shell.seen, "the test never turned displayZeros off and on through DISPLAY_ZEROS_TOGGLED").toEqual([
      false,
      true,
    ]);
    expect(fake.state.grid.displayZeros, "the test left zeros hidden").toBe(true);
  });

  it("flips whatever the flag is: from zeros HIDDEN it shows them, then hides them again", async () => {
    fake.state.grid = { ...fake.state.grid, displayZeros: false };
    const shell = mountShellDisplayZerosListener();
    unmount = shell.off;
    const r = await runOne(excelGapFeaturesSuite, NAME);
    expect(r.status, `the DisplayZeros test did not pass: ${r.error}`).toBe("pass");
    expect(shell.seen).toEqual([true, false]);
    expect(fake.state.grid.displayZeros, "the test did not put the user's setting back").toBe(false);
  });

  it("is not vacuous: when nothing applies the event, the test FAILS naming displayZeros", async () => {
    const r = await runOne(excelGapFeaturesSuite, NAME);
    expect(r.status, "the DisplayZeros test did not FAIL although the flag never flipped").toBe("fail");
    expect(r.error).toMatch(/displayZeros/);
  });
});

describe("Formatting Operations > Cell retains value after style change", () => {
  const NAME = /^Cell retains value after style change$/;

  it("changes the style for real (bold through applyFormatting) and checks it", async () => {
    const r = await runOne(formattingSuite, NAME);
    expect(r.status, `the formatting test did not pass: ${r.error}`).toBe("pass");
    expect(applyFormatting, "the test never changed a style").toHaveBeenCalledWith(
      [TEST_AREA.row],
      [TEST_AREA.col],
      { bold: true },
    );
    const cell = fake.cell(TEST_AREA.row, TEST_AREA.col);
    expect(fake.style(cell.styleIndex).bold).toBe(true);
  });

  it("is not vacuous: when the formatting door does nothing, the test FAILS", async () => {
    fake.state.formattingWorks = false;
    const r = await runOne(formattingSuite, NAME);
    expect(r.status, "the formatting test did not FAIL although no style changed").toBe("fail");
    expect(r.error).toMatch(/bold/i);
  });
});

describe("Checkbox > Insert checkbox initializes cell to FALSE", () => {
  const NAME = /^Insert checkbox initializes cell to FALSE$/;

  it("passes when the cell is a legacy checkbox: the style flag AND FALSE", async () => {
    const r = await runOne(checkboxSuite, NAME);
    expect(r.status, `the checkbox insert test did not pass: ${r.error}`).toBe("pass");
    const cell = fake.cell(AREA_CHECKBOX.row, AREA_CHECKBOX.col);
    expect(cell.display).toBe("FALSE");
    expect(fake.style(cell.styleIndex).checkbox).toBe(true);
  });

  it("is not vacuous: without the checkbox style flag, the test FAILS (a bare FALSE is no checkbox)", async () => {
    fake.state.formattingWorks = false;
    const r = await runOne(checkboxSuite, NAME);
    expect(r.status, "the checkbox insert test did not FAIL on a cell that is no checkbox").toBe("fail");
    expect(r.error).toMatch(/checkbox/i);
  });
});
