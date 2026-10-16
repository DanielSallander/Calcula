//! FILENAME: app/extensions/Pivot/components/__tests__/valueFieldDialogListener.test.tsx
// PURPOSE: The listener half of the value-field dialog contract lives INSIDE
//          the real PivotEditor: a request made before the editor mounted (the
//          pane opens asynchronously) is taken on mount; a request made while
//          it is mounted arrives by PIVOT_OPEN_VALUE_FIELD_DIALOG; another
//          pivot's request is left pending for that pivot's editor; the value
//          field index skips the calculated fields interleaved in the Values
//          zone; an index that names no field is told, never silent.
//
// Everything around the editor is a double; the editor, its hook and the
// request store are the real ones.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ZoneField } from "../types";

const h = vi.hoisted(() => ({
  listeners: new Map<string, Set<(detail: unknown) => void>>(),
  settings: [] as Array<{ field: { name: string } }>,
  numberFormat: [] as Array<{ currentFormat: string }>,
  toasts: [] as string[],
}));

vi.mock("@api/pivot", () => ({
  pivot: {
    updateBiFields: vi.fn(() => Promise.resolve({})),
    updateFields: vi.fn(() => Promise.resolve({})),
    setBiLookupColumns: vi.fn(() => Promise.resolve()),
  },
  savePivotLayout: vi.fn(() => Promise.resolve()),
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
vi.mock("@api", () => ({
  openTaskPane: vi.fn(),
  getBiConnectionService: () => null,
  showToast: (message: string) => h.toasts.push(message),
  emitAppEvent,
  onAppEvent,
}));
vi.mock("@api/events", () => ({ onAppEvent, emitAppEvent }));
vi.mock("@api/dialogs", () => ({ confirmAsync: vi.fn(() => Promise.resolve(false)) }));
vi.mock("../../handlers/selectionHandler", () => ({ openPivotPaneForPivot: vi.fn(() => Promise.resolve()) }));
vi.mock("../../lib/pivot-api", () => ({
  getConnectionBiModel: vi.fn(() => Promise.resolve(null)),
  setPivotPerspective: vi.fn(() => Promise.resolve()),
  getPivotFieldConfiguration: vi.fn(() => Promise.resolve(null)),
  getPivotFieldUniqueValues: vi.fn(() => Promise.resolve({ uniqueValues: [] })),
}));
vi.mock("../../lib/namedConfigs", () => ({ buildSourceSignature: () => null }));
vi.mock("../../../_shared/components/TableFieldList", () => ({ TableFieldList: () => null }));
vi.mock("../DesignEditor", () => ({ DesignEditor: () => null }));
vi.mock("../DropZones", () => ({ DropZones: () => null }));
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
const { requestValueFieldDialog, takePendingValueFieldDialog, __resetValueFieldDialogRequestsForTests } = await import(
  "../../lib/valueFieldDialogRequest"
);

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const VALUES: ZoneField[] = [
  { sourceIndex: 2, name: "Sum of Sales", isNumeric: true, aggregation: "sum", numberFormat: "#,##0" },
  { sourceIndex: 3, name: "Sum of Units", isNumeric: true, aggregation: "sum", numberFormat: "0.00" },
];

let container: HTMLDivElement;
let root: Root;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(pivotId = "pv"): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(PivotEditor, {
        pivotId,
        sourceFields: [],
        initialRows: [],
        initialColumns: [],
        initialValues: VALUES,
        initialFilters: [],
        initialLayout: {},
        // The calculated field sits BETWEEN the two value fields.
        initialCalculatedFields: [{ name: "Margin", formula: "=1" }],
        initialValueColumnOrder: [
          { type: "value", index: 0 },
          { type: "calculated", index: 0 },
          { type: "value", index: 1 },
        ],
      }),
    );
  });
  await settle();
}

const lastSettings = () => h.settings[h.settings.length - 1];
const lastNumberFormat = () => h.numberFormat[h.numberFormat.length - 1];

beforeEach(() => {
  __resetValueFieldDialogRequestsForTests();
  h.listeners.clear();
  h.settings = [];
  h.numberFormat = [];
  h.toasts = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the PivotEditor takes value-field dialog requests", () => {
  it("a request made BEFORE the editor mounted opens its modal on mount (index 1 skips the calculated field)", async () => {
    await requestValueFieldDialog({ pivotId: "pv", valueFieldIndex: 1, dialog: "settings" });
    expect(h.settings).toEqual([]);
    await mount();
    expect(lastSettings()?.field.name, "Value Field Settings on the 2nd VALUE field, not on Margin").toBe("Sum of Units");
    expect(takePendingValueFieldDialog("pv"), "taken").toBeNull();
  });

  it("a request made while mounted arrives by the event and opens the Number Format modal", async () => {
    await mount();
    expect(h.numberFormat).toEqual([]);
    await act(async () => {
      await requestValueFieldDialog({ pivotId: "pv", valueFieldIndex: 0, dialog: "numberFormat" });
    });
    await settle();
    expect(lastNumberFormat()?.currentFormat).toBe("#,##0");
    expect(h.settings).toEqual([]);
  });

  it("another pivot's request is left pending for that pivot's editor", async () => {
    await mount();
    await act(async () => {
      await requestValueFieldDialog({ pivotId: "other", valueFieldIndex: 0, dialog: "settings" });
    });
    await settle();
    expect(h.settings).toEqual([]);
    expect(takePendingValueFieldDialog("other")).toEqual({ pivotId: "other", valueFieldIndex: 0, dialog: "settings" });
  });

  it("an index that names no value field is told, and opens nothing", async () => {
    await mount();
    await act(async () => {
      await requestValueFieldDialog({ pivotId: "pv", valueFieldIndex: 2, dialog: "settings" });
    });
    await settle();
    expect(h.settings).toEqual([]);
    expect(h.numberFormat).toEqual([]);
    expect(h.toasts).toEqual(["That value field is no longer in the PivotTable."]);
  });
});
