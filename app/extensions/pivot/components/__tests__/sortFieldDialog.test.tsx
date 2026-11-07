//! FILENAME: app/extensions/Pivot/components/__tests__/sortFieldDialog.test.tsx
// PURPOSE: BUG-0733 -- Sort > More Sort Options... opens Excel's "Sort
//          (<field>)" dialog: Ascending / Descending by the field's own labels
//          or by a value field (along the other axis's Grand Total, Excel's
//          default). OK sends ONE sort_pivot_field: a label sort carries no
//          value field; a value sort names it with the Grand Total line.
//          Manual keeps the current order (sortBy "manual"; the item menu's
//          Move then moves items), and the dialog opens on the field's
//          CURRENT sort, as Excel's opens on AutoSortOrder / AutoSortField.
// CONTEXT: @testing-library/react is not installed; react-dom + `act`, as the
//          sibling component tests do.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({ sortPivotField: vi.fn() }));

vi.mock("@api/dialogWindow", () => ({
  useDialogWindow: () => ({ ref: { current: null }, style: {}, onHeaderMouseDown: () => {}, resizeHandles: null }),
}));
vi.mock("../../lib/pivot-api", () => ({
  sortPivotField: (...a: unknown[]) => h.sortPivotField(...a),
}));

import { SortFieldDialog, sortRequestOf, sortSummary } from "../SortFieldDialog";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const DATA = { pivotId: "pv-1", fieldIndex: 4, fieldName: "Region", valueFieldNames: ["Sum of Amount", "Count of Amount"] };

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

beforeEach(() => {
  h.sortPivotField.mockReset();
  h.sortPivotField.mockResolvedValue({ pivotId: "pv-1" });
  onClose.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(data: Record<string, unknown> = DATA): void {
  act(() => root.render(<SortFieldDialog isOpen onClose={onClose} data={data} />));
}

function radios(): HTMLInputElement[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
}

function select(label: string): HTMLSelectElement {
  const el = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  if (!el) throw new Error(`no select ${label}`);
  return el;
}

function choose(el: HTMLSelectElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function clickOk(): Promise<void> {
  const ok = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "OK");
  if (!ok) throw new Error("no OK");
  await act(async () => {
    ok.click();
  });
}

describe("the Sort (<field>) dialog (BUG-0733)", () => {
  it("lists the field and every value field, Manual enabled", () => {
    render();
    expect(container.textContent).toContain("Sort (Region)");
    expect(radios()).toHaveLength(3);
    expect(radios()[0].disabled).toBe(false);
    expect(Array.from(select("Ascending by").options).map((o) => o.value)).toEqual([
      "Region",
      "Sum of Amount",
      "Count of Amount",
    ]);
  });

  it("Descending by a value field sends ONE value sort along the Grand Total", async () => {
    render();
    act(() => radios()[2].click());
    choose(select("Descending by"), "Sum of Amount");
    expect(container.textContent).toContain("Sort Region by Sum of Amount in descending order");
    await clickOk();
    expect(h.sortPivotField).toHaveBeenCalledTimes(1);
    expect(h.sortPivotField).toHaveBeenCalledWith({
      pivotId: "pv-1",
      fieldIndex: 4,
      sortBy: "descending",
      valuesHierarchy: "Sum of Amount",
      pivotItemScope: [],
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("Ascending by the field itself is a label sort (no value field)", async () => {
    render();
    await clickOk();
    expect(h.sortPivotField).toHaveBeenCalledWith({ pivotId: "pv-1", fieldIndex: 4, sortBy: "ascending" });
  });

  it("Manual keeps the current order: ONE manual sort, no value field", async () => {
    render();
    act(() => radios()[0].click());
    expect(container.textContent).toContain("Drag items of the Region field to show them in any order");
    await clickOk();
    expect(h.sortPivotField).toHaveBeenCalledWith({ pivotId: "pv-1", fieldIndex: 4, sortBy: "manual" });
  });

  it("opens on the field's current sort (descending by a value field)", async () => {
    render({ ...DATA, currentOrder: "descending", currentBy: "Count of Amount" });
    expect(radios()[2].checked).toBe(true);
    expect(select("Descending by").value).toBe("Count of Amount");
    // OK without touching anything keeps that sort -- it used to turn it
    // into an ascending label sort.
    await clickOk();
    expect(h.sortPivotField).toHaveBeenCalledWith({
      pivotId: "pv-1",
      fieldIndex: 4,
      sortBy: "descending",
      valuesHierarchy: "Count of Amount",
      pivotItemScope: [],
    });
  });

  it("a refusal stays in the dialog and is shown", async () => {
    h.sortPivotField.mockRejectedValue(new Error("The PivotTable changed; that field is no longer in it."));
    render();
    await clickOk();
    expect(container.textContent).toContain("no longer in it");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("the request and the summary, pure", () => {
    expect(sortRequestOf(DATA, "ascending", "Count of Amount")).toEqual({
      pivotId: "pv-1",
      fieldIndex: 4,
      sortBy: "ascending",
      valuesHierarchy: "Count of Amount",
      pivotItemScope: [],
    });
    expect(sortRequestOf(DATA, "descending", "Region")).toEqual({ pivotId: "pv-1", fieldIndex: 4, sortBy: "descending" });
    expect(sortSummary("Region", "ascending", "Region")).toBe("Sort Region by Region in ascending order");
  });
});
