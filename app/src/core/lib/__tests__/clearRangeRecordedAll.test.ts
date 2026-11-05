//! FILENAME: app/src/core/lib/__tests__/clearRangeRecordedAll.test.ts
// PURPOSE: The macro recorder hears `clearRange` as what `clear_range` does.
// CONTEXT: The Rust command removes every stored cell of the rectangle -- its
//          value AND its own format (`Grid::clear_cell`) -- but the bridge
//          recorded it as `applyTo: "contents"`, so a replayed recording of a
//          row move / copy (useClipboard's callers) kept the destination
//          formats the gesture had wiped. Only Tauri's `invoke` is doubled;
//          the module under test is real.

import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => Promise.resolve(cmd === "clear_range" ? 3 : []),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));

import { clearRange, setGridRecorderHook, type RecordedGridEvent } from "../tauri-api";

afterEach(() => setGridRecorderHook(null));

describe("clearRange at the bridge", () => {
  it("is recorded as a Clear ALL (contents and formats), the command's own effect", async () => {
    const heard: RecordedGridEvent[] = [];
    setGridRecorderHook((e) => heard.push(e));
    await expect(clearRange(1, 2, 3, 4)).resolves.toBe(3);
    expect(heard).toEqual([
      { kind: "clearRange", startRow: 1, startCol: 2, endRow: 3, endCol: 4, applyTo: "all" },
    ]);
  });
});
