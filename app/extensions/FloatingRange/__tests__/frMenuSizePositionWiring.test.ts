//! FILENAME: app/extensions/FloatingRange/__tests__/frMenuSizePositionWiring.test.ts
// PURPOSE: The floating range's menu handlers hand `buildFrContextMenu` the
//          range's PUBLISHED region, so its "Size and Position..." row (BUG-0258
//          design phase 5b) opens the dialog for THAT range. The row's own
//          behaviour is lib/__tests__/frContextMenu.test.ts; this pins the
//          wiring in activate(), whose import is a harness.
// CONTEXT: Read as SOURCE, the frContextMenuStacking.test.ts precedent: the
//          handler object lives inside activate(). A `regionOf` that answered
//          null (or another family's region) would silently drop the row from
//          every range's menu while the item model's tests stayed green.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

function menuHandlersBody(): string {
  const source = readFileSync(path.resolve(__dirname, "../index.ts"), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("const menuHandlers: FrContextMenuHandlers = {");
  expect(start, "the menu handlers were not found -- this guard reads nothing").toBeGreaterThan(-1);
  const end = source.indexOf("\n  };\n", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("the floating range menu's Size and Position wiring", () => {
  it("regionOf looks the range up among the PUBLISHED regions, by its type and its id", () => {
    const body = menuHandlersBody();
    const at = body.indexOf("regionOf: (frId) =>");
    expect(at, "the handlers give the menu no regionOf").toBeGreaterThan(-1);
    const lookup = body.slice(at, at + 200).replace(/\s+/g, " ");
    expect(lookup).toContain("getGridRegions().find((r) => r.type === FLOATING_RANGE_REGION_TYPE && frIdOf(r) === frId) ?? null");
  });
});
