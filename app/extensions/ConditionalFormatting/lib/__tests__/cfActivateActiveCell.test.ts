//! FILENAME: app/extensions/ConditionalFormatting/lib/__tests__/cfActivateActiveCell.test.ts
// PURPOSE: BUG-0748 (dialog part) -- the extension's selection listener keeps
//          the grid's ACTIVE cell (activeRow / activeCol) when it caches the
//          selection, so New Rule is told the cell a formula is typed for.
// CONTEXT: index.ts copied startRow..endCol only, so a selection whose active
//          cell is not its far corner (Tab / Enter moving inside a range, Go To
//          Special) reached New Rule with the wrong active cell.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  onSelection: null as null | ((sel: unknown) => void),
  showDialog: vi.fn(),
  items: new Map<string, { action?: () => unknown; children?: unknown[] }>(),
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  showDialog: (...a: unknown[]) => h.showDialog(...a),
  ExtensionRegistry: {
    onSelectionChange: (cb: (sel: unknown) => void) => {
      h.onSelection = cb;
      return () => undefined;
    },
  },
}));
vi.mock("../cfStore", () => ({
  refreshRules: vi.fn(async () => undefined),
  evaluateViewport: vi.fn(async () => undefined),
  invalidateCache: vi.fn(),
  resetState: vi.fn(),
  invalidateAndRefresh: vi.fn(async () => undefined),
  getEvaluationForCell: vi.fn(() => null),
  getIconAlignForCell: vi.fn(() => undefined),
  getRules: vi.fn(() => []),
}));

import extension from "../../index";

function collect(item: { id: string; action?: () => unknown; children?: unknown[] }): void {
  h.items.set(item.id, item);
  for (const child of (item.children ?? []) as Array<{ id: string }>) collect(child);
}

beforeEach(() => {
  h.showDialog.mockReset();
  h.items.clear();
  const off = () => undefined;
  extension.activate({
    grid: { styleInterceptors: { register: () => off }, overlays: { register: () => off } },
    ui: {
      dialogs: { register: vi.fn(), unregister: vi.fn() },
      menus: { registerItem: (_m: string, item: { id: string }) => collect(item), unregisterItem: vi.fn() },
    },
    events: { on: () => off },
  } as never);
});

afterEach(() => {
  extension.deactivate();
});

describe("the selection the extension caches keeps the grid's active cell", () => {
  it("activeRow / activeCol reach New Rule as its active cell", async () => {
    expect(h.onSelection).not.toBeNull();
    // A2:E10 with B5 active (the far corner is E10).
    h.onSelection!({ startRow: 1, startCol: 0, endRow: 9, endCol: 4, activeRow: 4, activeCol: 1, type: "cells" });
    await h.items.get("cf:newRule")!.action!();
    expect(h.showDialog).toHaveBeenCalledTimes(1);
    expect(h.showDialog.mock.calls[0][1]).toMatchObject({
      selection: { startRow: 1, startCol: 0, endRow: 9, endCol: 4 },
      activeCell: { row: 4, col: 1 },
    });
  });
});
