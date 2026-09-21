//! FILENAME: app/extensions/Charts/__tests__/createChartDialogLayout.test.tsx
// PURPOSE: Pin the Insert Chart dialog's two-pane shape.
// CONTEXT: The dialog used to be a 620px column: Header / TabBar / one
//          scrolling TabContent that held the settings AND the 220px live
//          preview AND the errors / Footer. Configuring a chart therefore meant
//          scrolling the preview off the bottom of the window — you could not
//          see the chart while you were changing it, which is the entire
//          purpose of the dialog. The fix is structural, not cosmetic, so the
//          test is structural too: the preview must be a SIBLING of the
//          scrolling pane, never a child of it, and the error strip must sit
//          beside the button that refused rather than at the bottom of a
//          scrolled column.
//
//          The tabs themselves are stubbed — this is a test of the dialog
//          SHELL's layout, and stubbing keeps it from breaking every time a
//          chart option is added.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// ---------------------------------------------------------------------------
// Mocks — everything except @api/dialogLayout + @api/dialogWindow, which are
// the units under test.
// ---------------------------------------------------------------------------

const mockGridState = { selection: null as unknown };

vi.mock("@api", () => ({
  detectDataRegion: vi.fn(async () => null),
  useGridState: () => mockGridState,
  indexToCol: (i: number) => String.fromCharCode(65 + i),
  getSheets: vi.fn(async () => ({
    sheets: [{ index: 0, name: "Sheet1" }],
    activeIndex: 0,
  })),
}));

vi.mock("@api/events", () => ({
  emitAppEvent: vi.fn(),
  AppEvents: { GRID_REFRESH: "grid:refresh" },
}));

vi.mock("../lib/chartsBackend", () => ({
  chartsBackend: { invoke: vi.fn(async () => []) },
}));

const createChart = vi.fn(() => ({ chartId: "c1", name: "Chart 1" }));
vi.mock("../lib/chartStore", () => ({
  createChart: (...args: unknown[]) => createChart(...(args as [])),
  getChartById: vi.fn(() => null),
  replaceChartSpec: vi.fn(),
  syncChartRegions: vi.fn(),
}));

vi.mock("../rendering/chartRenderer", () => ({ invalidateChartCache: vi.fn() }));

vi.mock("../lib/chartDataReader", () => ({
  autoDetectSeries: vi.fn(async () => ({ categoryIndex: 0, series: [] })),
  readChartDataResolved: vi.fn(async (spec: unknown) => ({
    spec,
    data: { categories: [], series: [] },
    diagnostics: [],
  })),
}));

vi.mock("../lib/pivotChartDataReader", () => ({
  autoDetectPivotSeries: vi.fn(async () => ({ series: [], title: null })),
}));

vi.mock("../lib/chartSpecDefaults", () => ({ buildDefaultSpec: vi.fn() }));
vi.mock("../lib/chartEvents", () => ({
  ChartEvents: { CHART_CREATED: "chart:created", CHART_UPDATED: "chart:updated" },
}));
vi.mock("../lib/crossWindowEvents", () => ({
  onSpecChanged: vi.fn(async () => () => {}),
  emitSpecUpdated: vi.fn(),
  emitPreviewDataUpdated: vi.fn(),
  onChartSpecEditorClosed: vi.fn(async () => () => {}),
}));
vi.mock("../lib/openSpecEditorWindow", () => ({
  isSpecEditorWindowOpen: vi.fn(() => false),
  closeSpecEditorWindow: vi.fn(),
}));

// Tab stubs — tall on purpose, so the settings pane is the thing that scrolls.
vi.mock("../components/tabs/DataTab", () => ({
  DataTab: () => <div data-testid="stub-data-tab" style={{ height: 2000 }} />,
}));
vi.mock("../components/tabs/DesignTab", () => ({
  DesignTab: () => <div data-testid="stub-design-tab" style={{ height: 2000 }} />,
}));
vi.mock("../components/tabs/SpecTab", () => ({
  SpecTab: () => <div data-testid="stub-spec-tab" />,
}));

/** Counts mounts so we can prove the preview survives a tab switch. */
const previewMounts = { count: 0 };
vi.mock("../components/ChartPreview", () => ({
  ChartPreview: () => {
    React.useEffect(() => {
      previewMounts.count += 1;
    }, []);
    return <canvas data-testid="stub-preview-canvas" />;
  },
}));
vi.mock("../components/DataInspectorWindow", () => ({
  DataInspectorWindow: () => null,
}));

import { CreateChartDialog } from "../components/CreateChartDialog";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// ---------------------------------------------------------------------------
// A ResizeObserver we can drive, so the narrow-dialog fallback is reachable.
// ---------------------------------------------------------------------------

type RoCallback = (entries: Array<{ contentRect: { width: number } }>) => void;
const observers: Array<{ cb: RoCallback; target: Element }> = [];

class FakeResizeObserver {
  constructor(private cb: RoCallback) {}
  observe(target: Element) {
    observers.push({ cb: this.cb, target });
  }
  disconnect() {
    for (let i = observers.length - 1; i >= 0; i--) {
      if (observers[i].cb === this.cb) observers.splice(i, 1);
    }
  }
  unobserve() {}
}

/** Report a body width to every live observer. */
function reportWidth(width: number): void {
  act(() => {
    for (const o of [...observers]) o.cb([{ contentRect: { width } }]);
  });
}

// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  observers.length = 0;
  previewMounts.count = 0;
  mockGridState.selection = null;
  Reflect.set(globalThis, "ResizeObserver", FakeResizeObserver);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function open(props: Record<string, unknown> = {}): void {
  act(() => {
    root.render(
      <CreateChartDialog isOpen onClose={() => {}} data={undefined} {...props} />,
    );
  });
}

const settings = () =>
  container.querySelector('[data-testid="chart-dialog-settings"]') as HTMLElement;
const preview = () =>
  container.querySelector('[data-testid="chart-dialog-preview"]') as HTMLElement;

function clickTab(name: string): void {
  const tab = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === name,
  );
  if (!tab) throw new Error(`no tab button "${name}"`);
  act(() => tab.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

// ---------------------------------------------------------------------------

describe("Insert Chart dialog layout", () => {
  it("puts the live preview OUTSIDE the scrolling settings pane", () => {
    open();
    expect(settings()).toBeTruthy();
    expect(preview()).toBeTruthy();

    // The regression this exists for: the preview rendered inside the scroller,
    // so it slid off the bottom as soon as the settings grew.
    expect(settings().contains(preview())).toBe(false);
    expect(preview().parentElement).toBe(settings().parentElement);
  });

  it("scrolls the settings pane only — the preview pane is pinned", () => {
    open();
    expect(settings().style.overflowY).toBe("auto");
    expect(preview().style.overflowY).toBe("");
  });

  it("lays the two panes out side by side with a draggable divider between", () => {
    open();
    const body = settings().parentElement as HTMLElement;
    expect(body.style.flexDirection).toBe("row");

    const splitter = container.querySelector('[data-testid="dialog-splitter"]');
    expect(splitter).toBeTruthy();
    // Order: settings, splitter, preview.
    const kids = [...body.children];
    expect(kids.indexOf(settings())).toBeLessThan(kids.indexOf(splitter as Element));
    expect(kids.indexOf(splitter as Element)).toBeLessThan(kids.indexOf(preview()));
  });

  it("keeps the same preview mounted across a tab switch", () => {
    // A selection gives the dialog a range, hence a spec, hence a real canvas.
    mockGridState.selection = { startRow: 0, startCol: 0, endRow: 3, endCol: 2 };
    open();
    expect(container.querySelector('[data-testid="stub-preview-canvas"]')).toBeTruthy();
    expect(previewMounts.count).toBe(1);

    clickTab("Design");
    expect(container.querySelector('[data-testid="stub-design-tab"]')).toBeTruthy();
    // The preview lives beside the tabs, not inside them, so switching tabs
    // must not tear down and re-create the canvas.
    expect(previewMounts.count).toBe(1);
    expect(preview()).toBeTruthy();

    clickTab("Data");
    expect(previewMounts.count).toBe(1);
  });

  it("falls back to a stacked body when the dialog is dragged narrow", () => {
    open();
    expect((settings().parentElement as HTMLElement).style.flexDirection).toBe("row");

    reportWidth(700); // below the 820px side-by-side threshold
    const body = settings().parentElement as HTMLElement;
    expect(body.style.flexDirection).toBe("column");
    // Still a sibling, and still pinned — it just moves under the settings and
    // keeps a fixed slice instead of scrolling away.
    expect(settings().contains(preview())).toBe(false);
    expect(preview().style.flex).toBe("0 0 220px");
    expect(container.querySelector('[data-testid="dialog-splitter"]')).toBeNull();

    reportWidth(1000);
    expect((settings().parentElement as HTMLElement).style.flexDirection).toBe("row");
  });

  it("shows a hint in the preview pane instead of a blank rectangle", () => {
    open();
    // No selection and no range -> no spec -> nothing to draw.
    expect(container.querySelector('[data-testid="stub-preview-canvas"]')).toBeNull();
    expect(preview().textContent).toContain("Choose a data range");
  });

  it("renders a commit error full width, beside the footer — not in the scroller", async () => {
    open();

    const insert = [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Insert Chart",
    )!;
    await act(async () => {
      insert.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const alert = container.querySelector('[role="alert"]') as HTMLElement;
    expect(alert).toBeTruthy();
    expect(alert.textContent!.trim().length).toBeGreaterThan(0);

    // It must be reachable without scrolling the settings pane...
    expect(settings().contains(alert)).toBe(false);
    // ...and sit in the dialog box itself, directly before the footer that
    // holds the button that refused.
    const footer = [...container.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === "Cancel")!
      .parentElement!;
    expect(alert.parentElement).toBe(footer.parentElement);
    expect(alert.nextElementSibling).toBe(footer);
  });

  it("opens on the Design tab with no Data tab in pivot mode, preview still pinned", () => {
    open({ data: { pivotId: "p1" } });
    expect(
      [...container.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Data"),
    ).toBe(false);
    expect(preview()).toBeTruthy();
    expect(settings().contains(preview())).toBe(false);
  });
});
