//! FILENAME: app/extensions/Pivot/components/__tests__/fieldSettingsDialogZone.test.tsx
// PURPOSE: Saving Field Settings for ONE row field keeps every other row field
//          of the pivot, with its filter (review3 finding 2).
//
//          `update_pivot_fields` REPLACES each zone it is given
//          (`apply_zone_field_configs`, pivot/utils.rs). The dialog sent
//          `{ rowFields: [thisField] }`, so OK on Product's subtotals removed
//          Region -- and Region's filter -- from the pivot. It now sends the
//          whole zone as the definition holds it, with only the edited field
//          changed -- and, since BUG-0184 (the command keeps every setting it
//          is not sent), no field's item filter: an echoed list could only
//          race a filter changed elsewhere.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({ sent: [] as unknown[] }));

vi.mock("@api/dialogWindow", () => ({
  useDialogWindow: () => ({ ref: { current: null }, style: {}, onHeaderMouseDown: () => undefined, resizeHandles: null }),
}));
vi.mock("../../lib/pivot-api", () => ({
  getPivotFieldInfo: vi.fn(() =>
    Promise.resolve({ id: 1, name: "Product", showAllItems: false, filters: {}, isFiltered: false, subtotals: { automatic: true }, items: [] }),
  ),
  getPivotFieldConfiguration: vi.fn(() =>
    Promise.resolve({
      rowFields: [
        { sourceIndex: 0, name: "Region", isNumeric: false, hiddenItems: ["West"] },
        { sourceIndex: 1, name: "Product", isNumeric: false },
        { sourceIndex: 2, name: "Channel", isNumeric: false, hiddenItems: ["Web"] },
      ],
      columnFields: [],
      valueFields: [],
      filterFields: [],
      layout: {},
    }),
  ),
  updatePivotFields: vi.fn((req: unknown) => {
    h.sent.push(req);
    return Promise.resolve({});
  }),
}));

const { FieldSettingsDialog } = await import("../FieldSettingsDialog");

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

beforeEach(() => {
  h.sent = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("Field Settings saves one field without dropping its neighbours", () => {
  it("OK on Product's subtotals sends the WHOLE row zone, each field with its current filter", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(FieldSettingsDialog, {
          isOpen: true,
          onClose,
          data: { pivotId: "p1", fieldIndex: 1, axis: "row" },
        }),
      );
    });
    await settle();

    const none = [...container.querySelectorAll("label")].find((l) => l.textContent === "None")!;
    await act(async () => (none.querySelector("input") as HTMLInputElement).click());
    const ok = [...container.querySelectorAll("button")].find((b) => b.textContent === "OK")!;
    await act(async () => ok.click());
    await settle();

    expect(h.sent).toEqual([
      {
        pivotId: "p1",
        rowFields: [
          { sourceIndex: 0, name: "Region" },
          { sourceIndex: 1, name: "Product", showSubtotals: false },
          { sourceIndex: 2, name: "Channel" },
        ],
      },
    ]);
    expect(onClose).toHaveBeenCalled();
  });
});
