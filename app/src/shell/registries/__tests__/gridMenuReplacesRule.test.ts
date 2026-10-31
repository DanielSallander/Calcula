//! FILENAME: app/src/shell/registries/__tests__/gridMenuReplacesRule.test.ts
// PURPOSE: `GridContextMenuItem.replaces` has ONE deterministic rule: only a
//          SHOWING item leaves out the items it stands in for, and a cycle is
//          broken by registration order (the earliest undecided item shows).
// CONTEXT: Bug-ledger fix programme, round 18 (rev16B nit): two visible items
//          that each replaced the other were BOTH left out, so the menu showed
//          neither; and an item that was itself left out still left others out.

import { describe, it, expect, vi } from "vitest";

vi.mock("../../../core/hooks/useClipboard", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pendingCopyOfSheetCells: () => null,
}));

import { gridExtensions, itemsLeftOutByReplacement } from "../gridExtensions";
import type { GridContextMenuItem } from "@api/extensions";

function item(id: string, replaces?: string[]): GridContextMenuItem {
  return { id, label: id, onClick: () => {}, ...(replaces ? { replaces } : {}) } as GridContextMenuItem;
}

function shownIds(items: GridContextMenuItem[]): string[] {
  const out = itemsLeftOutByReplacement(items);
  return items.map((i) => i.id).filter((id) => !out.has(id));
}

describe("the replaces rule (round 18)", () => {
  it("two items that replace each other: exactly ONE shows, the earlier registered", () => {
    expect(shownIds([item("a", ["b"]), item("b", ["a"])]), "mutually replacing items hid each other").toEqual(["a"]);
    expect(shownIds([item("b", ["a"]), item("a", ["b"])])).toEqual(["b"]);
  });

  it("a chain A replaces B replaces C: A and C show (a left-out B leaves out nothing)", () => {
    expect(shownIds([item("c"), item("b", ["c"]), item("a", ["b"])])).toEqual(["c", "a"]);
    expect(shownIds([item("a", ["b"]), item("b", ["c"]), item("c")])).toEqual(["a", "c"]);
  });

  it("the plain case is unchanged: a showing replacement leaves its target out; absent, the target shows", () => {
    expect(shownIds([item("core.insertRow"), item("insertCopied", ["core.insertRow"])])).toEqual(["insertCopied"]);
    expect(shownIds([item("core.insertRow")])).toEqual(["core.insertRow"]);
  });

  it("a three-cycle (no consistent answer exists) is decided deterministically: the earliest shows and stays shown", () => {
    // a shows (cycle broken); b is left out by a; c, its only replacer left out, shows.
    expect(shownIds([item("a", ["b"]), item("b", ["c"]), item("c", ["a"])])).toEqual(["a", "c"]);
  });

  it("the MENU applies the rule: two registered items that replace each other show one, not neither", () => {
    gridExtensions.clear();
    gridExtensions.registerContextMenuItems([item("x.first", ["x.second"]), item("x.second", ["x.first"])]);
    const ids = gridExtensions.getContextMenuItemsForContext({} as never).map((i) => i.id);
    gridExtensions.clear();
    expect(ids, "the menu hid both mutually replacing items").toEqual(["x.first"]);
  });
});
