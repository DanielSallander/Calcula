//! FILENAME: app/extensions/ConditionalFormatting/lib/__tests__/cfMenuSelectionOwner.test.tsx
// PURPOSE: Format > Conditional Formatting refuses -- one toast, nothing
//          written, no dialog -- for every item that acts on Core's selection
//          while a selection owner holds it; the sheet-wide items still work.
// CONTEXT: BUG-0185. The menu builds its rules over Core's selection (a
//          module-level copy of it), which is a cell HIDDEN under a floating
//          grid while that grid's cell is selected. TEST owner.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  addConditionalFormat: vi.fn(),
  clearConditionalFormatsInRange: vi.fn(),
  showDialog: vi.fn(),
  galleryOnSelect: [] as ((...a: unknown[]) => void)[],
  capture: (props: { onSelect: (...a: unknown[]) => void }): null => {
    h.galleryOnSelect.push(props.onSelect);
    return null;
  },
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  showDialog: (...a: unknown[]) => h.showDialog(...a),
  addConditionalFormat: (...a: unknown[]) => h.addConditionalFormat(...a),
  clearConditionalFormatsInRange: (...a: unknown[]) => h.clearConditionalFormatsInRange(...a),
}));
vi.mock("../cfStore", () => ({ invalidateAndRefresh: vi.fn(async () => undefined) }));
vi.mock("../../components/ColorScaleGallery", () => ({ ColorScaleGallery: h.capture }));
vi.mock("../../components/DataBarGallery", () => ({ DataBarGallery: h.capture }));
vi.mock("../../components/IconSetGallery", () => ({ IconSetGallery: h.capture }));

import { registerCFMenuItems, setMenuSelection } from "../../handlers/homeMenuBuilder";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";

interface Item {
  id: string;
  action?: () => unknown;
  customContent?: (close: () => void) => React.ReactElement;
  children?: Item[];
}

const items = new Map<string, Item>();
const toasts: ToastPayload[] = [];
let owns = false;
let release: () => void = () => {};
let container: HTMLDivElement;
let root: Root;

function collect(item: Item): void {
  items.set(item.id, item);
  for (const child of item.children ?? []) collect(child);
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  h.addConditionalFormat.mockReset();
  h.addConditionalFormat.mockResolvedValue({ success: true });
  h.clearConditionalFormatsInRange.mockReset();
  h.showDialog.mockReset();
  h.galleryOnSelect.length = 0;
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  owns = false;
  release = registerSelectionOwner({ id: "test-owner", label: "the test object's cells", ownsSelection: () => owns });
  items.clear();
  registerCFMenuItems({
    ui: { menus: { registerItem: (_menu: string, item: Item) => collect(item) } },
  } as never);
  setMenuSelection({ startRow: 1, startCol: 1, endRow: 3, endCol: 2 });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  release();
  act(() => root.unmount());
  document.body.innerHTML = "";
});

async function pickFromGallery(id: string): Promise<void> {
  await act(async () => {
    root.render(items.get(id)!.customContent!(() => {}));
  });
  await act(async () => {
    const onSelect = h.galleryOnSelect[h.galleryOnSelect.length - 1];
    if (id === "cf:colorScales") onSelect({ minColor: "#f00", maxColor: "#0f0" });
    else if (id === "cf:dataBars") onSelect("#00f", true);
    else onSelect("threeArrows", 3);
    await Promise.resolve();
  });
}

const SELECTION_ITEMS: [string, () => Promise<unknown>][] = [
  ["Highlight > Greater Than...", async () => items.get("cf:greaterThan")!.action!()],
  ["Top/Bottom > Top 10 Items...", async () => items.get("cf:top10Items")!.action!()],
  ["New Rule...", async () => items.get("cf:newRule")!.action!()],
  ["Clear Rules from Selected Cells", async () => items.get("cf:clearFromSelection")!.action!()],
  ["Color Scales gallery", () => pickFromGallery("cf:colorScales")],
  ["Data Bars gallery", () => pickFromGallery("cf:dataBars")],
  ["Icon Sets gallery", () => pickFromGallery("cf:iconSets")],
];

function acted(): number {
  return (
    h.addConditionalFormat.mock.calls.length +
    h.clearConditionalFormatsInRange.mock.calls.length +
    h.showDialog.mock.calls.length
  );
}

describe("Conditional Formatting menu while a selection owner holds the selection", () => {
  for (const [label, run] of SELECTION_ITEMS) {
    it(`${label}: acts on nothing; one toast`, async () => {
      owns = true;
      await run();
      expect(acted(), `${label} acted on Core's hidden selection`).toBe(0);
      expect(toasts.length).toBe(1);
    });
  }

  it("Manage Rules... and Clear Rules from Entire Sheet are not about the selection: they still work", async () => {
    owns = true;
    await items.get("cf:manageRules")!.action!();
    await items.get("cf:clearFromSheet")!.action!();
    expect(h.showDialog).toHaveBeenCalledTimes(1);
    expect(h.clearConditionalFormatsInRange).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([]);
  });
});

describe("positive controls: nothing owns the selection", () => {
  for (const [label, run] of SELECTION_ITEMS) {
    it(`${label}: acts on Core's selection`, async () => {
      await run();
      expect(acted()).toBe(1);
      expect(toasts).toEqual([]);
    });
  }
});
