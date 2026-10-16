//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotObjectPane.test.tsx
// PURPOSE: The canvas pivot box's @api/objectPane provider (WP-C S10):
//          - Fields | Design build tabs (the host adds Format), the header;
//          - ONE instance across Fields and Design: both tabs render the same
//            component under the same key, so the host's one build slot keeps
//            ONE lifted editor (spec 2.5) -- mounted once, its pivot read once,
//            only the controlled `tab` changes;
//          - the body shows a sentence while it loads and when the pivot
//            cannot be read, never a blank pane.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  mounts: 0,
  tabs: [] as string[],
  getAtCell: vi.fn(),
}));

vi.mock("@api/pivot", () => ({ pivot: { getAtCell: h.getAtCell } }));
vi.mock("../../handlers/selectionHandler", () => ({
  buildPivotPaneData: (info: { pivotId: string }) => ({
    pivotId: info.pivotId,
    sourceFields: [],
    initialRows: [],
    initialColumns: [],
    initialValues: [],
    initialFilters: [],
    initialLayout: {},
  }),
}));
vi.mock("../../components/PivotEditor", () => ({
  PivotEditor: (props: { tab?: string; showTabStrip?: boolean; pivotId: string }) => {
    React.useEffect(() => {
      h.mounts++;
    }, []);
    h.tabs.push(`${props.pivotId}:${props.tab}:${props.showTabStrip}`);
    return <div data-testid="editor-double" data-tab={props.tab} />;
  },
}));

import type { GridRegion } from "@api/gridOverlays";
import type { ObjectPaneTabContext } from "@api/objectPane";
import { createPivotObjectPaneProvider, PIVOT_PANE_TAB_DESIGN, PIVOT_PANE_TAB_FIELDS } from "../pivotObjectPane";
import { CANVAS_PIVOT_LOADING, CANVAS_PIVOT_UNREADABLE } from "../../components/CanvasPivotBuildBody";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const REGION: GridRegion = {
  id: "pivot-visual-7",
  type: "pivot-visual",
  startRow: 0,
  startCol: 1024,
  endRow: 9,
  endCol: 1026,
  floating: { x: 10, y: 20, width: 300, height: 200 },
  data: { pivotId: "7", name: "Sales" },
};

const ctx = (activeTabId: string): ObjectPaneTabContext => ({
  region: REGION,
  readOnly: false,
  readOnlyReason: null,
  activeTabId,
});

let container: HTMLDivElement;
let root: Root;
const settle = () =>
  act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  h.mounts = 0;
  h.tabs = [];
  h.getAtCell.mockReset();
  h.getAtCell.mockResolvedValue({ pivotId: "7" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the pivot box's object-pane provider", () => {
  const provider = createPivotObjectPaneProvider("pivot-visual");

  it("offers Fields | Design (the host adds Format) and names the box in the header", () => {
    expect(provider.types).toEqual(["pivot-visual"]);
    expect(provider.tabs(REGION).map((t) => [t.id, t.label])).toEqual([
      [PIVOT_PANE_TAB_FIELDS, "Fields"],
      [PIVOT_PANE_TAB_DESIGN, "Design"],
    ]);
    expect(provider.headerOf!(REGION)).toBe("PivotTable - Sales");
    expect(provider.tabs({ ...REGION, data: {} })).toEqual([]);
  });

  it("ONE instance across Fields and Design: the editor mounts ONCE and the pivot is read ONCE; only the controlled tab changes", async () => {
    const [fields, design] = provider.tabs(REGION);
    // The host's slot: whichever tab is active renders into the same place.
    const slot = (el: React.ReactNode) => <div data-testid="slot">{el}</div>;
    await act(async () => root.render(slot(fields.render(ctx("fields")))));
    await settle();
    expect(h.mounts).toBe(1);
    expect(container.querySelector('[data-testid="editor-double"]')?.getAttribute("data-tab")).toBe("fields");

    await act(async () => root.render(slot(design.render(ctx("design")))));
    await settle();
    await act(async () => root.render(slot(fields.render(ctx("fields")))));
    await settle();
    await act(async () => root.render(slot(design.render(ctx("format")))));
    await settle();

    expect(h.mounts, "a second instance was mounted across the tab switches").toBe(1);
    expect(h.getAtCell).toHaveBeenCalledTimes(1);
    expect(h.getAtCell).toHaveBeenCalledWith(0, 1024);
    // The editor is controlled and draws no strip of its own.
    expect(h.tabs.at(-1)).toBe("7:design:false");
    expect(new Set(h.tabs.map((t) => t.split(":")[1]))).toEqual(new Set(["fields", "design"]));
  });

  it("says so while the pivot loads, and when it cannot be read -- never a blank tab", async () => {
    let resolve!: (v: unknown) => void;
    h.getAtCell.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const [fields] = provider.tabs(REGION);
    await act(async () => root.render(<div>{fields.render(ctx("fields"))}</div>));
    expect(container.textContent).toContain(CANVAS_PIVOT_LOADING);
    await act(async () => resolve(null));
    await settle();
    expect(container.textContent).toContain(CANVAS_PIVOT_UNREADABLE);
    expect(h.mounts).toBe(0);
  });
});
