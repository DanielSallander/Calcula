//! FILENAME: app/src/core/lib/__tests__/multiAreaWire.test.ts
// PURPOSE: BUG-0394 at the bridge: the clear and formatting wrappers send a
//          multi-area selection's OTHER blocks as ONE call's `moreAreas`, keep
//          the one-block wire shape they always had, and tell the macro recorder
//          one event per block -- so a recorded multi-area clear or format
//          replays exactly as the per-block calls it replaced.
//          Only Tauri's `invoke` is doubled; the module under test is real.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const calls: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "apply_formatting") return Promise.resolve({ cells: [], styles: [] });
    if (cmd === "clear_range_with_options") return Promise.resolve({ count: 0, updatedCells: [] });
    if (cmd === "get_active_sheet") return Promise.resolve(0);
    return Promise.resolve(0);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));

import {
  applyFormatting,
  clearCommentsInRange,
  clearHyperlinksInRange,
  clearNotesInRange,
  clearRangeWithOptions,
  setGridRecorderHook,
} from "../tauri-api";

const recorded: unknown[] = [];

beforeEach(() => {
  calls.length = 0;
  recorded.length = 0;
  setGridRecorderHook((event) => recorded.push(event));
});
afterEach(() => setGridRecorderHook(null));

const C3 = { startRow: 2, startCol: 2, endRow: 2, endCol: 2 };
const E5F6 = { startRow: 4, startCol: 4, endRow: 5, endCol: 5 };

describe("clearRangeWithOptions over several areas", () => {
  it("BUG-0394 sends every other block as moreAreas in ONE call, and records one clear per block", async () => {
    await clearRangeWithOptions(0, 0, 0, 0, "contents", undefined, { moreAreas: [C3, E5F6] });
    const sent = calls.filter((c) => c.cmd === "clear_range_with_options");
    expect(sent).toHaveLength(1);
    expect(sent[0].args?.moreAreas).toEqual([C3, E5F6]);
    expect((sent[0].args?.params as Record<string, unknown>).applyTo).toBe("contents");
    expect(recorded).toEqual([
      { kind: "clearRange", startRow: 0, startCol: 0, endRow: 0, endCol: 0, applyTo: "contents" },
      { kind: "clearRange", ...C3, applyTo: "contents" },
      { kind: "clearRange", ...E5F6, applyTo: "contents" },
    ]);
  });

  it("one block keeps the wire shape it always had (no moreAreas key)", async () => {
    await clearRangeWithOptions(0, 0, 1, 1, "formats");
    const sent = calls.find((c) => c.cmd === "clear_range_with_options");
    expect(sent?.args && "moreAreas" in sent.args).toBe(false);
    expect(recorded).toHaveLength(1);
  });

  it("the comment, note and hyperlink clears take the other blocks the same way", async () => {
    await clearCommentsInRange(0, 0, 0, 0, [C3]);
    await clearNotesInRange(0, 0, 0, 0, [C3]);
    await clearHyperlinksInRange(0, 0, 0, 0, [C3]);
    await clearNotesInRange(0, 0, 0, 0);
    expect(calls.map((c) => [c.cmd, c.args?.moreAreas])).toEqual([
      ["clear_comments_in_range", [C3]],
      ["clear_notes_in_range", [C3]],
      ["clear_hyperlinks_in_range", [C3]],
      ["clear_notes_in_range", undefined],
    ]);
  });
});

describe("applyFormatting over several areas", () => {
  it("BUG-0394 sends every other block as moreAreas (long runs encoded) in ONE call, and records one format per block", async () => {
    const column = Array.from({ length: 100 }, (_, i) => i);
    await applyFormatting([0], [0], { bold: true }, { moreAreas: [{ rows: [2], cols: [2] }, { rows: column, cols: [3] }] });
    const sent = calls.filter((c) => c.cmd === "apply_formatting");
    expect(sent).toHaveLength(1);
    expect(sent[0].args?.moreAreas).toEqual([
      { rows: [2], cols: [2] },
      { rows: { first: 0, last: 99 }, cols: [3] },
    ]);
    expect(recorded.map((e) => [(e as { rows: number[] }).rows.length, (e as { cols: number[] }).cols])).toEqual([
      [1, [0]],
      [1, [2]],
      [100, [3]],
    ]);
  });

  it("one block keeps the wire shape it always had", async () => {
    await applyFormatting([0], [0], { bold: true });
    const sent = calls.find((c) => c.cmd === "apply_formatting");
    expect(sent?.args && "moreAreas" in sent.args).toBe(false);
  });

  it("several areas in an object's cells are refused before any call", async () => {
    const target = { kind: "floatingRange", id: "fr-1" } as never;
    await expect(applyFormatting([0], [0], { bold: true }, { target, moreAreas: [{ rows: [1], cols: [1] }] })).rejects.toThrow(
      /Several areas/,
    );
    expect(calls.filter((c) => c.cmd === "apply_formatting")).toEqual([]);
  });
});
