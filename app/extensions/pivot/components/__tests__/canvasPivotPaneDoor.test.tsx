//! FILENAME: app/extensions/Pivot/components/__tests__/canvasPivotPaneDoor.test.tsx
// PURPOSE: WP-C S10 / ruling R4, through the REAL editor:
//          - THE PivotEditor, tab-controlled (the object pane owns the strip):
//            with `tab` given the editor draws no Fields/Design strip, shows
//            the body the host names, and a switch keeps its zone state;
//          - WP-A's value-field dialog contract keeps working on a canvas box
//            after the field list moved into the ONE object pane: the
//            value-cell menu's `requestValueFieldDialog` -> the ONE host hook
//            `openPivotPaneForPivot` -> the object pane opens on the box's
//            FIELDS tab as a DOOR even though the user closed it by hand -> the
//            lifted editor (CanvasPivotBuildBody) mounts after its async load,
//            takes the pending request and opens Value Field Settings on the
//            right field. No `pivot-editor` task pane opens at any point.
//
// The object pane host here is a recording double of BuiltIn/ObjectPane's
// contract (an extension's test may import only the seams): it refuses a
// "press" / "follow" while closed by hand and honours a "command" -- the door.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  listeners: new Map<string, Set<(detail: unknown) => void>>(),
  settings: [] as Array<{ field: { name: string } }>,
  numberFormat: [] as Array<{ currentFormat: string }>,
  zones: [] as Array<{ values: Array<{ name: string }>; onRemove: (zone: string, index: number) => void }>,
  toasts: [] as string[],
  openTaskPane: vi.fn(),
  getAtCell: vi.fn(),
}));

const onAppEvent = (event: string, cb: (detail: unknown) => void) => {
  let set = h.listeners.get(event);
  if (!set) h.listeners.set(event, (set = new Set()));
  set.add(cb);
  return () => set!.delete(cb);
};
const emitAppEvent = (event: string, detail: unknown) => {
  for (const cb of [...(h.listeners.get(event) ?? [])]) cb(detail);
};

vi.mock("@api/pivot", () => ({
  pivot: {
    getAtCell: h.getAtCell,
    updateBiFields: vi.fn(() => Promise.resolve({})),
    updateFields: vi.fn(() => Promise.resolve({})),
    setBiLookupColumns: vi.fn(() => Promise.resolve()),
  },
  savePivotLayout: vi.fn(() => Promise.resolve()),
}));
vi.mock("@api", () => ({
  openTaskPane: h.openTaskPane,
  closeTaskPane: vi.fn(),
  getTaskPaneManuallyClosed: () => ["pivot-editor"],
  clearTaskPaneManuallyClosed: vi.fn(),
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
  getBiConnectionService: () => null,
  showToast: (message: string) => h.toasts.push(message),
  emitAppEvent,
  onAppEvent,
}));
vi.mock("@api/events", () => ({ onAppEvent, emitAppEvent }));
// The editor follows the APP locale for caption translation (P2); this suite
// mocks @api/events, so the locale seam is stubbed here too.
vi.mock("@api/locale", () => ({ getAppLocale: () => ({ localeId: "en-US" }), onLocaleChanged: () => () => undefined }));
vi.mock("@api/grid", () => ({ getGridStateSnapshot: () => ({ surface: "canvas", sheetContext: { activeSheetIndex: 1 } }) }));
vi.mock("@api/dialogs", () => ({ confirmAsync: vi.fn(() => Promise.resolve(false)) }));
vi.mock("../../manifest", () => ({
  PIVOT_PANE_ID: "pivot-editor",
  PIVOT_ANALYZE_TAB_ID: "pivot-analyze",
  PIVOT_DESIGN_TAB_ID: "pivot-design",
  PivotAnalyzePanelDefinition: { id: "pivot-analyze", title: "Analyze" },
  PivotDesignPanelDefinition: { id: "pivot-design", title: "Design" },
}));
vi.mock("../../lib/pivot-api", () => ({
  getConnectionBiModel: vi.fn(() => Promise.resolve(null)),
  setPivotPerspective: vi.fn(() => Promise.resolve()),
  getPivotFieldConfiguration: vi.fn(() => Promise.resolve(null)),
  getPivotFieldUniqueValues: vi.fn(() => Promise.resolve({ uniqueValues: [] })),
  updatePivotProperties: vi.fn(() => Promise.resolve({})),
}));
vi.mock("../../lib/namedConfigs", () => ({ buildSourceSignature: () => null }));
vi.mock("../../../_shared/components/TableFieldList", () => ({ TableFieldList: () => null }));
vi.mock("../DesignEditor", () => ({ DesignEditor: () => <div data-testid="design-editor-double" /> }));
vi.mock("../DropZones", () => ({
  DropZones: (props: { values: Array<{ name: string }>; onRemove: (zone: string, index: number) => void }) => {
    h.zones.push(props);
    return null;
  },
}));
vi.mock("../FieldList", () => ({ FieldList: () => null }));
vi.mock("../SaveLoadToolbar", () => ({ SaveLoadToolbar: () => null }));
vi.mock("../ValueFieldSettingsModal", () => ({
  ValueFieldSettingsModal: (props: { field: { name: string } }) => {
    h.settings.push(props);
    return null;
  },
}));
vi.mock("../NumberFormatModal", () => ({
  NumberFormatModal: (props: { currentFormat: string }) => {
    h.numberFormat.push(props);
    return null;
  },
}));
vi.mock("../../../_shared/components/ConnectSourceDialog", () => ({ ConnectSourceDialog: () => null }));
vi.mock("../../../_shared/components/useDragDrop", () => ({ registerDragOutRemoval: () => () => undefined }));
vi.mock("../../../_shared/components/jsonToggle", () => ({
  useJsonToggle: () => ({
    isJsonMode: false,
    toggle: () => undefined,
    json: "",
    setJson: () => undefined,
    apply: () => undefined,
    revert: () => undefined,
    dirty: false,
    error: null,
    loading: false,
  }),
  JsonToggleButton: () => null,
  JsonToggleEditor: () => null,
}));

const { PivotEditor } = await import("../PivotEditor");
const { requestValueFieldDialog, __resetValueFieldDialogRequestsForTests } = await import("../../lib/valueFieldDialogRequest");
const { updateCachedRegions, resetSelectionHandlerState, getSelectedVisualPivotId } = await import(
  "../../handlers/selectionHandler"
);
const { createPivotObjectPaneProvider } = await import("../../lib/pivotObjectPane");
const { setGridRegions } = await import("@api/gridOverlays");
const objectPane = await import("@api/objectPane");

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const VALUES = [
  { sourceIndex: 2, name: "Sum of Sales", isNumeric: true, aggregation: "sum", numberFormat: "#,##0" },
  { sourceIndex: 3, name: "Sum of Units", isNumeric: true, aggregation: "sum", numberFormat: "0.00" },
];

beforeEach(() => {
  __resetValueFieldDialogRequestsForTests();
  resetSelectionHandlerState();
  objectPane.resetObjectPane();
  h.listeners.clear();
  h.settings = [];
  h.numberFormat = [];
  h.zones = [];
  h.toasts = [];
  h.openTaskPane.mockClear();
  h.getAtCell.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setGridRegions([]);
  objectPane.resetObjectPane();
});

describe("PivotEditor, tab-controlled by the object pane", () => {
  function editor(tab?: "fields" | "design", showTabStrip?: boolean) {
    return React.createElement(PivotEditor, {
      pivotId: "pv",
      sourceFields: [],
      initialRows: [],
      initialColumns: [],
      initialValues: VALUES,
      initialFilters: [],
      initialLayout: {},
      ...(tab ? { tab } : {}),
      ...(showTabStrip === undefined ? {} : { showTabStrip }),
    });
  }
  const body = (name: string) => container.querySelector(`[data-pivot-editor-body="${name}"]`) as HTMLElement;

  it("with `tab` given: no strip of its own, and the body the host names is the one shown", async () => {
    await act(async () => root.render(editor("fields")));
    await settle();
    expect(container.querySelector('[data-testid="pivot-editor-tabs"]')).toBeNull();
    expect(body("fields").style.display).toBe("flex");
    expect(body("design").style.display).toBe("none");
    await act(async () => root.render(editor("design")));
    expect(body("fields").style.display).toBe("none");
    expect(body("design").style.display).toBe("flex");
  });

  it("without it the editor keeps its own strip (the worksheet pane); showTabStrip=false hides it", async () => {
    await act(async () => root.render(editor()));
    expect(container.querySelector('[data-testid="pivot-editor-tabs"]')).not.toBeNull();
    await act(async () => root.render(editor(undefined, false)));
    expect(container.querySelector('[data-testid="pivot-editor-tabs"]')).toBeNull();
  });

  it("a Fields -> Design -> Fields switch KEEPS the zone state (one editor, its edits intact)", async () => {
    await act(async () => root.render(editor("fields")));
    await settle();
    expect(h.zones.at(-1)!.values.map((v) => v.name)).toEqual(["Sum of Sales", "Sum of Units"]);
    await act(async () => h.zones.at(-1)!.onRemove("values", 0));
    await settle();
    expect(h.zones.at(-1)!.values.map((v) => v.name)).toEqual(["Sum of Units"]);
    await act(async () => root.render(editor("design")));
    await act(async () => root.render(editor("fields")));
    await settle();
    expect(h.zones.at(-1)!.values.map((v) => v.name), "the switch re-seeded the zones").toEqual(["Sum of Units"]);
  });
});

describe("R4: the value-field dialog contract on a canvas box goes through the ONE object pane", () => {
  it("closed by hand: the request opens the object pane on FIELDS (a door), the lifted editor takes it on mount, no pivot-editor pane opens", async () => {
    // The canvas pivot: cached (the host hook's sheet check) and its box published.
    updateCachedRegions([
      { pivotId: "7", name: "Sales", startRow: 0, startCol: 1024, endRow: 9, endCol: 1026, isEmpty: false, isModel: false, canvasFrame: { x: 10, y: 20, width: 300, height: 200 } },
    ]);
    const box = {
      id: "pivot-visual-7",
      type: "pivot-visual",
      startRow: 0,
      startCol: 1024,
      endRow: 9,
      endCol: 1026,
      floating: { x: 10, y: 20, width: 300, height: 200 },
      data: { pivotId: "7", name: "Sales" },
    };
    setGridRegions([box]);
    h.getAtCell.mockResolvedValue({
      pivotId: "7",
      isEmpty: false,
      sourceFields: [],
      filterZones: [],
      fieldConfiguration: {
        rowFields: [],
        columnFields: [],
        valueFields: VALUES,
        filterFields: [],
        layout: {},
      },
    });

    // The object pane: provider registered, the user CLOSED it by hand.
    const provider = createPivotObjectPaneProvider("pivot-visual");
    const cleanupProvider = objectPane.registerObjectPaneProvider(provider);
    const opened: Array<{ tab?: string; reason: string; regionId?: string }> = [];
    let shown: { tab: string } | null = null;
    const closedByHand = true;
    const cleanupHost = objectPane.registerObjectPaneHost({
      open: (req) => {
        if (closedByHand && req.reason !== "command") return false;
        opened.push({ tab: req.tab, reason: req.reason, regionId: req.region?.id });
        shown = { tab: req.tab ?? "fields" };
        return true;
      },
      close: () => undefined,
      state: () => ({ open: shown !== null, regionId: shown ? box.id : null, regionType: shown ? box.type : null, tabId: shown?.tab ?? null }),
    });

    // The value-cell menu asks for Value Field Settings on the 2nd value field.
    await act(async () => {
      await requestValueFieldDialog({ pivotId: "7", valueFieldIndex: 1, dialog: "settings" });
    });
    expect(getSelectedVisualPivotId()).toBe("7");
    expect(opened).toEqual([{ tab: "fields", reason: "command", regionId: "pivot-visual-7" }]);
    expect(h.openTaskPane, "no pivot-editor pane for a canvas box").not.toHaveBeenCalled();

    // The host shows the requested tab: the provider's Fields render.
    const tab = provider.tabs(box).find((t) => t.id === shown!.tab)!;
    await act(async () =>
      root.render(tab.render({ region: box, readOnly: false, readOnlyReason: null, activeTabId: shown!.tab })),
    );
    await settle();
    // The lifted editor mounted AFTER its async load and took the pending request.
    expect(h.settings.at(-1)?.field.name, "Value Field Settings on the 2nd value field").toBe("Sum of Units");
    expect(container.querySelector('[data-testid="pivot-editor-tabs"]'), "the host owns the strip").toBeNull();
    expect(h.openTaskPane).not.toHaveBeenCalled();
    cleanupHost();
    cleanupProvider();
  });
});
