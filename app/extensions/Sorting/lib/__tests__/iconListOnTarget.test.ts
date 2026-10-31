//! FILENAME: app/extensions/Sorting/lib/__tests__/iconListOnTarget.test.ts
// PURPOSE: Custom Sort's "Cell Icon" order list on a floating grid's cells
//          (BUG-0514). The list asks the ONE evaluator the sort keys on
//          (`get_range_icons`), through the dialog's TARGET, so it shows the
//          icons the floating grid's column shows. It used to answer an empty
//          list for any target ("no icons found"), because the command read the
//          active sheet only.
// CONTEXT: Drives the real `getUniqueIconsInColumn` -> the real `getRangeIcons`
//          wrapper; only Tauri's `invoke` is doubled, so the test sees the wire.

import { describe, it, expect, vi, beforeEach } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: (cmd: string, args?: Record<string, unknown>) => tauri.invoke(cmd, args),
}));

import { getUniqueIconsInColumn } from "../sortHelpers";

const REF = { kind: "floatingRange" as const, id: "fr-7" };
const SHOWN = [
  { iconSet: "threeArrows", iconIndex: 0 },
  { iconSet: "threeArrows", iconIndex: 2 },
];

beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.invoke.mockImplementation(async (cmd: string) => (cmd === "get_range_icons" ? SHOWN : null));
});

describe("the Cell Icon list on a floating grid's cells (BUG-0514)", () => {
  it("asks get_range_icons WITH the grid's target and lists what it answers", async () => {
    const icons = await getUniqueIconsInColumn(1, 6, 2, REF);
    expect(icons).toEqual(SHOWN);
    const calls = tauri.invoke.mock.calls.filter((c) => c[0] === "get_range_icons");
    expect(calls).toEqual([["get_range_icons", { startRow: 1, startCol: 2, endRow: 6, endCol: 2, target: REF }]]);
  });

  it("positive control: on the sheet, no target travels", async () => {
    await getUniqueIconsInColumn(1, 6, 2, null);
    const calls = tauri.invoke.mock.calls.filter((c) => c[0] === "get_range_icons");
    expect(calls).toEqual([["get_range_icons", { startRow: 1, startCol: 2, endRow: 6, endCol: 2 }]]);
  });
});
