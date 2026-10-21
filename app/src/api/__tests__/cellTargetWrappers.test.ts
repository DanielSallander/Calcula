//! FILENAME: app/src/api/__tests__/cellTargetWrappers.test.ts
// PURPOSE: Every cell wrapper that takes `opts.target` (P3, owner finding G3)
//          sends it EXPLICITLY, drops the ambient sheet group, records nothing
//          for the macro recorder -- and FAILS CLOSED on a command the backend
//          has not taught yet.
// CONTEXT: A Rust params struct has no `deny_unknown_fields` and Tauri drops an
//          argument a command does not declare, so a `target` sent too early
//          would be IGNORED: the command would act on the ACTIVE sheet at the
//          floating grid's local coordinates and report success (BUG-0185
//          again). The wrappers therefore throw before invoke for a target on
//          any command missing from TARGET_COMMANDS (api/cellTargetCommands.ts).
//          The list starts empty and grows with each Rust step; this test reads
//          the REAL list for the fail-closed half, so it stays true at the end
//          of every wave.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const listHolder = vi.hoisted(() => ({ list: [] as string[] }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    const arrays = new Set([
      "update_cells_batch",
      "fill_range",
      "insert_rows",
      "insert_columns",
      "delete_rows",
      "delete_columns",
      "set_rows_hidden",
      "set_cols_hidden",
      "get_all_conditional_formats",
    ]);
    if (arrays.has(cmd)) return [];
    if (cmd === "clear_conditional_formats_in_range") return 0;
    return {
      cells: [],
      styles: [],
      success: true,
      replacementCount: 0,
      updatedCells: [],
      mergedRegions: [],
      createdRegions: [],
      removedRegions: [],
      lossyRegions: 0,
      movedCells: [],
      matches: [],
    };
  }),
}));

vi.mock("../cellTargetCommands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cellTargetCommands")>();
  return { ...actual, TARGET_COMMANDS: listHolder.list };
});

import { invoke } from "@tauri-apps/api/core";
import * as tauriApi from "../../core/lib/tauri-api";
import * as backend from "../backend";
import { goToSpecial as apiGoToSpecial } from "../grid";
import { setSelectedSheetIndices, clearSheetGrouping } from "../../core/state/sheetGrouping";
import type { CellTargetRef } from "../../core/types/types";

const TARGET: CellTargetRef = { kind: "floatingRange", id: "fr-uuid-1" };
const opts = { target: TARGET };

type Case = {
  /** The wrapper, as the spec names it. */
  wrapper: string;
  /** The snake_case Rust command it invokes. */
  command: string;
  /** Where `target` rides: a top-level argument, or inside `params`. */
  where: "top" | "params";
  /** Whether the command takes the ambient sheet group (`sheetIndices`) without a target. */
  grouped?: boolean;
  call: (o?: { target?: CellTargetRef }) => Promise<unknown>;
};

const CASES: Case[] = [
  { wrapper: "applyFormatting", command: "apply_formatting", where: "top", grouped: true, call: (o) => tauriApi.applyFormatting([1], [1], { bold: true }, o) },
  { wrapper: "adjustNumberFormatDecimals", command: "adjust_number_format_decimals", where: "top", grouped: true, call: (o) => tauriApi.adjustNumberFormatDecimals([1], [1], -1, o) },
  { wrapper: "applyBorderPreset", command: "apply_border_preset", where: "top", grouped: true, call: (o) => tauriApi.applyBorderPreset(0, 0, 1, 1, "allBorders", "solid", "#000000", 1, o) },
  { wrapper: "setCellRichText", command: "set_cell_rich_text", where: "top", call: (o) => tauriApi.setCellRichText(0, 0, null, o) },
  { wrapper: "applyNamedStyleRange", command: "apply_named_style_range", where: "top", call: (o) => backend.applyNamedStyleRange("Good", 0, 0, 1, 1, o) },
  { wrapper: "clearRangeWithOptions (core)", command: "clear_range_with_options", where: "params", call: (o) => tauriApi.clearRangeWithOptions(0, 0, 1, 1, "all", undefined, o) },
  { wrapper: "clearRangeWithOptions (@api/backend)", command: "clear_range_with_options", where: "params", call: (o) => backend.clearRangeWithOptions(0, 0, 1, 1, "formats", o) },
  { wrapper: "sortRange", command: "sort_range", where: "params", call: (o) => backend.sortRange(0, 0, 3, 1, [{ key: 0, ascending: true }], undefined, o) },
  { wrapper: "fillRange", command: "fill_range", where: "top", call: (o) => tauriApi.fillRange(0, 0, 0, 0, 0, 0, 3, 0, o) },
  { wrapper: "updateCellsBatch", command: "update_cells_batch", where: "top", call: (o) => tauriApi.updateCellsBatch([{ row: 0, col: 0, value: "1" }], o) },
  { wrapper: "mergeCells", command: "merge_cells", where: "top", call: (o) => tauriApi.mergeCells(0, 0, 0, 1, undefined, undefined, o) },
  { wrapper: "unmergeCells", command: "unmerge_cells", where: "top", call: (o) => tauriApi.unmergeCells(0, 0, undefined, { endRow: 1, endCol: 1 }, o) },
  { wrapper: "insertRows", command: "insert_rows", where: "top", call: (o) => tauriApi.insertRows(1, 1, undefined, o) },
  { wrapper: "insertColumns", command: "insert_columns", where: "top", call: (o) => tauriApi.insertColumns(1, 1, undefined, o) },
  { wrapper: "deleteRows", command: "delete_rows", where: "top", call: (o) => tauriApi.deleteRows(1, 1, undefined, o) },
  { wrapper: "deleteColumns", command: "delete_columns", where: "top", call: (o) => tauriApi.deleteColumns(1, 1, undefined, o) },
  { wrapper: "setRowHeights", command: "set_row_heights", where: "top", call: (o) => tauriApi.setRowHeights([[1, 1]], 40, o) },
  { wrapper: "setColumnWidths", command: "set_column_widths", where: "top", call: (o) => tauriApi.setColumnWidths([[1, 1]], 120, o) },
  { wrapper: "setRowsHidden", command: "set_rows_hidden", where: "top", call: (o) => tauriApi.setRowsHidden([2], true, o) },
  { wrapper: "setColsHidden", command: "set_cols_hidden", where: "top", call: (o) => tauriApi.setColsHidden([2], true, o) },
  { wrapper: "goToSpecial (core)", command: "go_to_special", where: "top", call: (o) => tauriApi.goToSpecial("blanks", null, o) },
  { wrapper: "goToSpecial (@api/grid)", command: "go_to_special", where: "top", call: (o) => apiGoToSpecial("constants", undefined, o) },
  { wrapper: "findAll", command: "find_all", where: "top", call: (o) => tauriApi.findAll("d", {}, o) },
  { wrapper: "countMatches", command: "count_matches", where: "top", call: (o) => tauriApi.countMatches("d", {}, o) },
  { wrapper: "replaceAll", command: "replace_all", where: "top", call: (o) => tauriApi.replaceAll("a", "b", {}, o) },
  { wrapper: "replaceSingle", command: "replace_single", where: "top", call: (o) => tauriApi.replaceSingle(0, 0, "a", "b", false, undefined, o) },
  {
    wrapper: "addConditionalFormat",
    command: "add_conditional_format",
    where: "params",
    call: (o) =>
      backend.addConditionalFormat(
        { rule: { type: "cellValue", operator: "greaterThan", value1: "15" }, format: {}, ranges: [{ startRow: 1, startCol: 1, endRow: 3, endCol: 1 }] } as unknown as backend.AddCFParams,
        o,
      ),
  },
  { wrapper: "updateConditionalFormat", command: "update_conditional_format", where: "params", call: (o) => backend.updateConditionalFormat({ ruleId: 7, enabled: false }, o) },
  { wrapper: "deleteConditionalFormat", command: "delete_conditional_format", where: "top", call: (o) => backend.deleteConditionalFormat(7, o) },
  { wrapper: "reorderConditionalFormats", command: "reorder_conditional_formats", where: "top", call: (o) => backend.reorderConditionalFormats([7, 8], o) },
  { wrapper: "getAllConditionalFormats", command: "get_all_conditional_formats", where: "top", call: (o) => backend.getAllConditionalFormats(undefined, o) },
  { wrapper: "clearConditionalFormatsInRange", command: "clear_conditional_formats_in_range", where: "top", call: (o) => backend.clearConditionalFormatsInRange(0, 0, 3, 3, undefined, o) },
];

const invokeMock = vi.mocked(invoke);
const recorded: unknown[] = [];
let realTargetCommands: readonly string[] = [];

/** The argument bag of every invoke of `command`. */
function argsOf(command: string): Record<string, unknown>[] {
  return invokeMock.mock.calls.filter((c) => c[0] === command).map((c) => (c[1] ?? {}) as Record<string, unknown>);
}

/** Whether `target` appears anywhere in an argument bag (top level or one level in). */
function carriesTarget(args: Record<string, unknown>): boolean {
  if ("target" in args) return true;
  return Object.values(args).some((v) => v !== null && typeof v === "object" && !Array.isArray(v) && "target" in (v as object));
}

beforeEach(async () => {
  const actual = await vi.importActual<typeof import("../cellTargetCommands")>("../cellTargetCommands");
  realTargetCommands = actual.TARGET_COMMANDS;
  invokeMock.mockClear();
  recorded.length = 0;
  tauriApi.setGridRecorderHook((e) => recorded.push(e));
  // An ambient sheet group: a target must DROP it.
  setSelectedSheetIndices([0, 1, 2]);
});

afterEach(() => {
  tauriApi.setGridRecorderHook(null);
  tauriApi.setUdfResolveHook(null);
  clearSheetGrouping();
  listHolder.list.length = 0;
});

function acceptEverything(): void {
  listHolder.list.length = 0;
  listHolder.list.push(...new Set(CASES.map((c) => c.command)));
}

describe("with the backend accepting every target (the list stubbed full)", () => {
  for (const c of CASES) {
    it(`${c.wrapper}: sends target ${c.where === "params" ? "inside params" : "as an argument"}, no sheetIndices, records nothing`, async () => {
      acceptEverything();
      await c.call(opts);
      const calls = argsOf(c.command);
      expect(calls.length, `${c.wrapper} did not invoke ${c.command}`).toBe(1);
      const args = calls[0];
      if (c.where === "params") {
        expect((args.params as Record<string, unknown>)?.target, `${c.wrapper} did not put target in params`).toEqual(TARGET);
        expect("target" in args, `${c.wrapper} also sent target at the top level`).toBe(false);
      } else {
        expect(args.target, `${c.wrapper} did not send target`).toEqual(TARGET);
      }
      expect("sheetIndices" in args, `${c.wrapper} sent the ambient sheet group with a target`).toBe(false);
      expect(recorded, `${c.wrapper} recorded a targeted gesture for the macro recorder`).toEqual([]);
    });
  }

  it("updateCellsBatch with a target skips the UDF pre-resolution (keyed on active-sheet cells)", async () => {
    acceptEverything();
    const hook = vi.fn(async () => ({ results: { x: 1 }, volatileCells: [] }));
    tauriApi.setUdfResolveHook(hook as unknown as Parameters<typeof tauriApi.setUdfResolveHook>[0]);
    await tauriApi.updateCellsBatch([{ row: 0, col: 0, value: "=MYUDF()" }], opts);
    expect(hook).not.toHaveBeenCalled();
    expect("udfResults" in argsOf("update_cells_batch")[0]).toBe(false);
  });

  it("a target AND an explicit sheet refuse before invoke (mirrors the backend's refusal)", async () => {
    acceptEverything();
    await expect(tauriApi.insertRows(1, 1, 2, opts)).rejects.toThrow("Pass a floating grid target or a sheet, not both.");
    await expect(tauriApi.clearRangeWithOptions(0, 0, 1, 1, "all", 2, opts)).rejects.toThrow(/not both/);
    await expect(tauriApi.findAll("x", { sheetIndex: 1 }, opts)).rejects.toThrow(/not both/);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("the positive control for the grouping check: WITHOUT a target the group is sent", async () => {
    acceptEverything();
    for (const c of CASES.filter((x) => x.grouped)) {
      invokeMock.mockClear();
      await c.call();
      expect(argsOf(c.command)[0].sheetIndices, `${c.wrapper} lost the sheet group`).toEqual([0, 1, 2]);
    }
  });

  it("the positive control for the recorder check: WITHOUT a target applyFormatting records", async () => {
    acceptEverything();
    await tauriApi.applyFormatting([1], [1], { bold: true });
    expect(recorded.length).toBe(1);
  });
});

describe("FAIL CLOSED: the REAL TARGET_COMMANDS list", () => {
  for (const c of CASES) {
    it(`${c.wrapper}: a target on a command the backend has not learned THROWS before invoke`, async () => {
      listHolder.list.length = 0;
      listHolder.list.push(...realTargetCommands);
      if (realTargetCommands.includes(c.command)) {
        // Taught by a landed Rust step: the target is sent.
        await c.call(opts);
        expect(argsOf(c.command).some(carriesTarget)).toBe(true);
        return;
      }
      await expect(c.call(opts)).rejects.toThrow(`${c.command} does not accept a floating grid target yet.`);
      expect(argsOf(c.command), `${c.wrapper} invoked ${c.command} with an unaccepted target`).toEqual([]);
    });
  }
});

// The mechanism itself, independent of how far the real list has grown: once
// every Rust step landed, the REAL list names every wrapper's command and the
// block above never reaches its throwing branch -- so a wrapper that stopped
// failing closed would pass it. With the list stubbed EMPTY every wrapper must
// throw before invoke.
describe("FAIL CLOSED: the mechanism, with the list stubbed EMPTY", () => {
  for (const c of CASES) {
    it(`${c.wrapper}: a target on a command missing from the list THROWS before invoke`, async () => {
      listHolder.list.length = 0;
      await expect(c.call(opts)).rejects.toThrow(`${c.command} does not accept a floating grid target yet.`);
      expect(argsOf(c.command), `${c.wrapper} invoked ${c.command} with an unaccepted target`).toEqual([]);
    });
  }
});

describe("without opts: no target key anywhere", () => {
  for (const c of CASES) {
    it(`${c.wrapper}: sends no target`, async () => {
      await c.call();
      for (const args of argsOf(c.command)) {
        expect(carriesTarget(args), `${c.wrapper} sent a target nobody asked for`).toBe(false);
      }
    });
  }
});
