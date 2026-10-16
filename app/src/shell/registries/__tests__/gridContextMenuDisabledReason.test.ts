//! FILENAME: app/src/shell/registries/__tests__/gridContextMenuDisabledReason.test.ts
// PURPOSE: A grid context-menu item's `disabledReason` (@api/extensions) is
//          resolved by the registry -- for items AND their children -- and
//          reaches the rendered row as its `title` (GridContextMenuHost's
//          mapItem -> ContextMenu), so a greyed row says why it cannot act.
// CONTEXT: WP-A S9. Before it, a disabled row could not say why, so pivot menu
//          items that could not act either did nothing on click or were greyed
//          with no explanation.

import { describe, it, expect, beforeEach } from "vitest";
import { gridExtensions, type GridContextMenuItem, type GridMenuContext } from "../gridExtensions";
import { mapItem } from "../../Overlays/GridContextMenuHost";
import { createEmptyDimensionOverrides } from "../../../core/types";

function context(row: number): GridMenuContext {
  return {
    selection: { startRow: row, endRow: row, startCol: 0, endCol: 0, type: "cells" },
    clickedCell: { row, col: 0 },
    isWithinSelection: true,
    sheetIndex: 0,
    sheetName: "Sheet1",
    dimensions: createEmptyDimensionOverrides(),
  };
}

const IDS = ["test:static", "test:dynamic", "test:enabled", "test:parent"];

beforeEach(() => {
  for (const id of IDS) gridExtensions.unregisterContextMenuItem(id);
});

function resolved(id: string, ctx: GridMenuContext): GridContextMenuItem {
  const found = gridExtensions.getContextMenuItemsForContext(ctx).find((i) => i.id === id);
  if (!found) throw new Error(`menu item ${id} not resolved`);
  return found;
}

describe("disabledReason resolution", () => {
  it("a static reason on a disabled item is kept as the string", () => {
    gridExtensions.registerContextMenuItem({
      id: "test:static",
      label: "Static",
      disabled: true,
      disabledReason: "Not available yet.",
      onClick: () => {},
    });
    const item = resolved("test:static", context(0));
    expect(item.disabled).toBe(true);
    expect(item.disabledReason).toBe("Not available yet.");
  });

  it("a function reason is resolved per context; null resolves to no reason", () => {
    gridExtensions.registerContextMenuItem({
      id: "test:dynamic",
      label: "Dynamic",
      disabled: () => true,
      disabledReason: (ctx) => (ctx.clickedCell?.row === 3 ? "Already expanded." : null),
      onClick: () => {},
    });
    expect(resolved("test:dynamic", context(3)).disabledReason).toBe("Already expanded.");
    expect(resolved("test:dynamic", context(4)).disabledReason).toBeUndefined();
  });

  it("an ENABLED item carries no reason (its reason function is not even asked)", () => {
    let asked = 0;
    gridExtensions.registerContextMenuItem({
      id: "test:enabled",
      label: "Enabled",
      disabled: (ctx) => ctx.clickedCell?.row === 9,
      disabledReason: () => {
        asked++;
        return "Nope.";
      },
      onClick: () => {},
    });
    const item = resolved("test:enabled", context(1));
    expect(item.disabled).toBe(false);
    expect(item.disabledReason).toBeUndefined();
    expect(asked).toBe(0);
    // Positive control: the same item, disabled, does carry it.
    expect(resolved("test:enabled", context(9)).disabledReason).toBe("Nope.");
    expect(asked).toBe(1);
  });

  it("children resolve their reasons too, and the host maps a reason to the row's title", () => {
    gridExtensions.registerContextMenuItem({
      id: "test:parent",
      label: "Parent",
      onClick: () => {},
      children: [
        {
          id: "test:child:off",
          label: "Off",
          disabled: () => true,
          disabledReason: () => "Nothing to expand here.",
          onClick: () => {},
        },
        { id: "test:child:on", label: "On", onClick: () => {} },
      ],
    });
    const ctx = context(0);
    const parent = resolved("test:parent", ctx);
    const [off, on] = parent.children!;
    expect(off.disabledReason).toBe("Nothing to expand here.");
    expect(on.disabledReason).toBeUndefined();

    const mapped = mapItem(parent, ctx, () => {});
    expect(mapped.title).toBeUndefined();
    expect(mapped.children![0]).toMatchObject({ id: "test:child:off", disabled: true, title: "Nothing to expand here." });
    expect(mapped.children![1]).toMatchObject({ id: "test:child:on", disabled: false });
    expect(mapped.children![1].title).toBeUndefined();
  });
});
