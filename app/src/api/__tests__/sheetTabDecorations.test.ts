//! FILENAME: app/src/api/__tests__/sheetTabDecorations.test.ts
// PURPOSE: The tab-mark seam's two deliberate departures from the header-override
//          registries it is otherwise modelled on.
// CONTEXT: Marks COMPOSE (a sheet can be subscribed AND protected, so
//          first-non-null would let one extension silently suppress another's),
//          and the registry NOTIFIES (the strip is React and renders once, while
//          extensions activate after it mounts). Both are easy to "simplify"
//          into the header-override shape by someone who has not read why, so
//          each has a test that reds on exactly that edit.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  registerSheetTabDecorationProvider,
  getSheetTabDecorations,
  hasSheetTabDecorations,
  invalidateSheetTabDecorations,
  onSheetTabDecorationsChanged,
  __resetSheetTabDecorationsForTests,
  type SheetTabTarget,
} from "../sheetTabDecorations";

const SHEET: SheetTabTarget = { index: 2, name: "Sales", sheetId: "S-2" };

beforeEach(() => __resetSheetTabDecorationsForTests());
afterEach(() => __resetSheetTabDecorationsForTests());

describe("sheet tab decorations", () => {
  it("COMPOSES: two providers answering for one sheet both render", () => {
    // SABOTAGE: `return [{ ...d, id: r.id }]` on the first hit — i.e. adopt the
    // first-non-null semantics of columnHeaderOverrides.
    registerSheetTabDecorationProvider({ id: "a", provider: () => ({ glyph: "↓" }) });
    registerSheetTabDecorationProvider({ id: "b", provider: () => ({ glyph: "🔒" }) });
    expect(getSheetTabDecorations(SHEET).map((d) => d.id)).toEqual(["a", "b"]);
  });

  it("orders by priority, lowest first", () => {
    // SABOTAGE: delete the `registrations.sort(...)` line.
    registerSheetTabDecorationProvider({ id: "late", priority: 10, provider: () => ({ glyph: "b" }) });
    registerSheetTabDecorationProvider({ id: "early", priority: 1, provider: () => ({ glyph: "a" }) });
    expect(getSheetTabDecorations(SHEET).map((d) => d.id)).toEqual(["early", "late"]);
  });

  it("cleanup unregisters", () => {
    // SABOTAGE: make the returned cleanup `() => {}`.
    const off = registerSheetTabDecorationProvider({ id: "a", provider: () => ({ glyph: "↓" }) });
    expect(hasSheetTabDecorations()).toBe(true);
    off();
    expect(hasSheetTabDecorations()).toBe(false);
    expect(getSheetTabDecorations(SHEET)).toEqual([]);
  });

  it("NOTIFIES on registration, so a mark appears without waiting for a repaint", () => {
    // The whole reason this registry has a change channel and the header ones do
    // not: extensions activate AFTER the strip has mounted.
    // SABOTAGE: delete the `notify()` at the end of the register function.
    const seen = vi.fn();
    onSheetTabDecorationsChanged(seen);
    registerSheetTabDecorationProvider({ id: "a", provider: () => ({ glyph: "↓" }) });
    expect(seen).toHaveBeenCalled();
  });

  it("notifies on invalidate, and stops after the listener's cleanup", () => {
    // SABOTAGE: make `invalidateSheetTabDecorations` a no-op.
    const seen = vi.fn();
    const off = onSheetTabDecorationsChanged(seen);
    invalidateSheetTabDecorations();
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    invalidateSheetTabDecorations();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("contains a throwing provider instead of losing the other one's mark", () => {
    // SABOTAGE: remove the try/catch in the walk.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    registerSheetTabDecorationProvider({
      id: "bad",
      priority: 1,
      provider: () => {
        throw new Error("boom");
      },
    });
    registerSheetTabDecorationProvider({ id: "good", priority: 2, provider: () => ({ glyph: "↓" }) });
    expect(getSheetTabDecorations(SHEET).map((d) => d.id)).toEqual(["good"]);
  });

  it("hands the provider the sheet's IDENTITY, not just its position", () => {
    // Pins the whole identity channel at the seam: without `sheetId` a provider
    // cannot answer safely, because index and name both move.
    // SABOTAGE: drop `sheetId` from the target literal in SheetTabs' call, or
    // from the walk here.
    const spy = vi.fn().mockReturnValue(null);
    registerSheetTabDecorationProvider({ id: "a", provider: spy });
    getSheetTabDecorations(SHEET);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ index: 2, name: "Sales", sheetId: "S-2" }),
    );
  });

  it("re-registering one id replaces rather than duplicates", () => {
    // SABOTAGE: delete the findIndex/splice dedupe.
    registerSheetTabDecorationProvider({ id: "a", provider: () => ({ glyph: "1" }) });
    registerSheetTabDecorationProvider({ id: "a", provider: () => ({ glyph: "2" }) });
    const out = getSheetTabDecorations(SHEET);
    expect(out).toHaveLength(1);
    expect(out[0].glyph).toBe("2");
  });

  it("returns nothing at all when no provider answers — the default state", () => {
    registerSheetTabDecorationProvider({ id: "a", provider: () => null });
    expect(getSheetTabDecorations(SHEET)).toEqual([]);
  });
});
