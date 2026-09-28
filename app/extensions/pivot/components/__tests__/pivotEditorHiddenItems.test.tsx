//! FILENAME: app/extensions/Pivot/components/__tests__/pivotEditorHiddenItems.test.tsx
// PURPOSE: What the REAL field-list editor (PivotEditor + usePivotEditorState)
//          sends as a BI pivot's hidden items, through every door that builds
//          an `update_bi_pivot_fields` request (review2 slicerbe findings 4 and
//          10, frontend half):
//
//          - a field-list edit (a column toggled on) sends NO hidden items for
//            the row/column/filter chips it did not touch -- their lists were
//            seeded when the pane mounted, and a slicer, the header dropdown or
//            a ribbon filter may have changed the pivot since. Echoing them
//            silently re-applied a filter the user had cleared elsewhere;
//          - the Pivot Layout DSL deleting a `NOT IN` clause sends `[]` (a
//            clear) -- "nothing" means KEEP on the wire, so the clause came
//            back; changing one sends the new list;
//          - an edit stays pending until the backend ACCEPTS a request that
//            carried it: a superseded request does not lose it;
//          - the LOOKUP toggle and the deferred-layout Update button go
//            through the same mapping;
//          - a calculation-group chip still sends its own item subset;
//          - the filter dropdown's own apply (PIVOT_FILTER_APPLIED) stores a
//            cleared filter as `[]` and retires an older unsent edit.
//
//          Review round 3 added:
//          - the chips follow the pivot: after a view change the editor
//            re-reads the definition, so a RANGE pivot (whose request must
//            echo every chip's list -- absent means CLEAR there) no longer
//            sends a filter cleared elsewhere, and the DSL shows the pivot's
//            filters, not the mount-time ones (findings 1 and 6); a read that
//            a request crossed is re-read, not trusted;
//          - an inclusion `= (...)` the DSL could not resolve is no edit
//            (finding 3);
//          - under Defer Layout Update, removing a field forgets its pending
//            edit (finding 4);
//          - dragging a chip to another zone keeps its item filter (finding 5).
//
// Everything around the editor is a double; the hook and the request mapping
// are the real ones.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { UpdateBiPivotFieldsRequest, BiFieldRef, BiPivotModelInfo, ZoneField } from "../types";
import { CALC_GROUP_TABLE } from "../types";

interface Captured {
  sent: UpdateBiPivotFieldsRequest[];
  /** Resolves (or rejects) each updateBiFields call; default resolves. */
  updateImpl: ((req: UpdateBiPivotFieldsRequest) => Promise<unknown>) | null;
  fieldList: Record<string, (...a: never[]) => unknown> | null;
  design: { onZoneStateChange: (...a: unknown[]) => void; rows: ZoneField[]; filters: ZoneField[] } | null;
  dropZones: {
    rows: ZoneField[];
    columns: ZoneField[];
    filters: ZoneField[];
    onDrop: (...a: unknown[]) => void;
    onMoveField: (...a: unknown[]) => void;
  } | null;
  /** The range pivot's field list (FieldList) props. */
  rangeFieldList: { onFieldToggle: (f: unknown, on: boolean) => void } | null;
  listeners: Map<string, Set<(detail: unknown) => void>>;
  /** What the pivot's definition holds now, for the editor's re-read. */
  readImpl: () => Promise<unknown>;
  reads: number;
  /** Requests of a RANGE pivot (update_pivot_fields). */
  rangeSent: Array<{ rowFields?: Array<{ name: string; hiddenItems?: string[] }>; columnFields?: Array<{ name: string; hiddenItems?: string[] }> }>;
}
const h = vi.hoisted(
  (): Captured => ({
    sent: [],
    updateImpl: null,
    fieldList: null,
    design: null,
    dropZones: null,
    rangeFieldList: null,
    listeners: new Map(),
    readImpl: () => Promise.resolve(null),
    reads: 0,
    rangeSent: [],
  }),
);

vi.mock("@api/pivot", () => ({
  pivot: {
    updateBiFields: vi.fn((req: UpdateBiPivotFieldsRequest) => {
      h.sent.push(req);
      return h.updateImpl ? h.updateImpl(req) : Promise.resolve({});
    }),
    updateFields: vi.fn((req: Captured["rangeSent"][number]) => {
      h.rangeSent.push(req);
      return Promise.resolve({});
    }),
    setBiLookupColumns: vi.fn(() => Promise.resolve()),
  },
  savePivotLayout: vi.fn(() => Promise.resolve()),
}));

vi.mock("@api", () => ({
  openTaskPane: vi.fn(),
  getBiConnectionService: () => null,
  emitAppEvent: vi.fn(),
  onAppEvent: (event: string, cb: (detail: unknown) => void) => {
    let set = h.listeners.get(event);
    if (!set) h.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  },
}));
vi.mock("@api/events", () => ({ onAppEvent: () => () => undefined }));
vi.mock("@api/dialogs", () => ({ confirmAsync: vi.fn(() => Promise.resolve(false)) }));
vi.mock("../../lib/pivot-api", () => ({
  getConnectionBiModel: vi.fn(() => Promise.resolve(null)),
  setPivotPerspective: vi.fn(() => Promise.resolve()),
  getPivotFieldConfiguration: vi.fn(() => {
    h.reads++;
    return h.readImpl();
  }),
}));
vi.mock("../../lib/namedConfigs", () => ({ buildSourceSignature: () => null }));
vi.mock("../../../_shared/components/TableFieldList", () => ({
  TableFieldList: (props: Captured["fieldList"]) => {
    h.fieldList = props;
    return null;
  },
}));
vi.mock("../DesignEditor", () => ({
  DesignEditor: (props: Captured["design"]) => {
    h.design = props;
    return null;
  },
}));
vi.mock("../DropZones", () => ({
  DropZones: (props: Captured["dropZones"]) => {
    h.dropZones = props;
    return null;
  },
}));
vi.mock("../FieldList", () => ({
  FieldList: (props: Captured["rangeFieldList"]) => {
    h.rangeFieldList = props;
    return null;
  },
}));
vi.mock("../SaveLoadToolbar", () => ({ SaveLoadToolbar: () => null }));
vi.mock("../ValueFieldSettingsModal", () => ({ ValueFieldSettingsModal: () => null }));
vi.mock("../NumberFormatModal", () => ({ NumberFormatModal: () => null }));
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
const { compileForEditor } = await import("../dslCompile");

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// ---------------------------------------------------------------------------
// Fixture: a BI pivot whose chips were seeded with item filters at mount.
// ---------------------------------------------------------------------------

const col = (name: string) => ({ name, dataType: "string", isNumeric: false });
const biModel: BiPivotModelInfo = {
  tables: [
    { name: "Geo", columns: [col("Region"), col("City")] },
    { name: "Sales", columns: [col("Year"), col("Channel"), col("Product")] },
  ],
  measures: [{ name: "Revenue" } as BiPivotModelInfo["measures"][number]],
  connectionId: "c1",
  calculationGroups: [{ name: "Time Intelligence", items: [{ name: "Current" }, { name: "YoY" }] }],
};

const chip = (name: string, hiddenItems?: string[]): ZoneField => ({
  sourceIndex: -1,
  name,
  isNumeric: false,
  customName: name,
  isLookup: false,
  ...(hiddenItems ? { hiddenItems } : {}),
});

/** The zones as seeded from the pivot when the pane mounted. */
const seededRows = () => [chip("Geo.Region", ["West"]), chip("Geo.City"), chip("Time Intelligence", ["YoY"])];
const seededColumns = () => [chip("Sales.Year", ["2023"])];
const seededValues = (): ZoneField[] => [
  { sourceIndex: -1, name: "[Revenue]", isNumeric: true, customName: "[Revenue]", aggregation: "sum" },
];
const seededFilters = () => [chip("Sales.Channel", ["Web"])];

let container: HTMLDivElement;
let root: Root;

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(PivotEditor, {
        pivotId: "pv",
        sourceFields: [],
        initialRows: seededRows(),
        initialColumns: seededColumns(),
        initialValues: seededValues(),
        initialFilters: seededFilters(),
        initialLayout: {},
        biModel,
      }),
    );
  });
  await settle();
}

/** An unrelated field-list edit: tick Sales.Product on. */
async function toggleColumnOn(table: string, column: string): Promise<void> {
  await act(async () => {
    (h.fieldList!.onColumnToggle as (t: string, c: string, n: boolean, on: boolean) => void)(table, column, false, true);
  });
  await settle();
}

/** A Pivot Layout DSL apply: the zones the compiler produced. */
async function applyDsl(rows: ZoneField[], columns: ZoneField[], filters: ZoneField[]): Promise<void> {
  await act(async () => {
    h.design!.onZoneStateChange(rows, columns, seededValues(), filters, {});
  });
  await settle();
}

const last = () => h.sent[h.sent.length - 1];
const ref = (list: BiFieldRef[], key: string): BiFieldRef => {
  const found = list.find((f) => `${f.table}.${f.column}` === key || (f.table === CALC_GROUP_TABLE && f.column === key));
  if (!found) throw new Error(`no ref ${key} in ${JSON.stringify(list)}`);
  return found;
};

beforeEach(() => {
  h.sent = [];
  h.updateImpl = null;
  h.fieldList = null;
  h.design = null;
  h.dropZones = null;
  h.rangeFieldList = null;
  h.listeners = new Map();
  h.readImpl = () => Promise.resolve(null);
  h.reads = 0;
  h.rangeSent = [];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("a field-list edit never echoes a chip's seeded item filter", () => {
  it("untouched real row, column and filter chips carry no hiddenItems in the request", async () => {
    await mount();
    await toggleColumnOn("Sales", "Product");

    expect(h.sent).toHaveLength(1);
    const req = last();
    expect(req.rowFields.map((f) => `${f.table}.${f.column}`)).toContain("Sales.Product");
    expect(ref(req.rowFields, "Geo.Region")).not.toHaveProperty("hiddenItems");
    expect(ref(req.columnFields, "Sales.Year")).not.toHaveProperty("hiddenItems");
    expect(ref(req.filterFields, "Sales.Channel")).not.toHaveProperty("hiddenItems");
  });

  it("a calculation-group chip still sends its own item subset", async () => {
    await mount();
    await toggleColumnOn("Sales", "Product");
    expect(ref(last().rowFields, "Time Intelligence")).toEqual({
      table: CALC_GROUP_TABLE,
      column: "Time Intelligence",
      hiddenItems: ["YoY"],
    });
  });

  it("the LOOKUP toggle's request goes through the same mapping", async () => {
    await mount();
    await act(async () => {
      (h.fieldList!.onLookupToggle as (t: string, c: string) => void)("Geo", "City");
    });
    await settle();

    expect(h.sent).toHaveLength(1);
    const req = last();
    expect(ref(req.rowFields, "Geo.City").isLookup).toBe(true);
    expect(ref(req.rowFields, "Geo.Region")).not.toHaveProperty("hiddenItems");
    expect(ref(req.columnFields, "Sales.Year")).not.toHaveProperty("hiddenItems");
    expect(ref(req.rowFields, "Time Intelligence").hiddenItems).toEqual(["YoY"]);
  });
});

describe("the Pivot Layout DSL is the editor's item-filter control", () => {
  it("deleting a row's NOT IN clause sends [] for that row -- and nothing for the rest", async () => {
    await mount();
    await applyDsl(
      [chip("Geo.Region"), chip("Geo.City"), chip("Time Intelligence", ["YoY"])],
      seededColumns(),
      seededFilters(),
    );

    expect(h.sent).toHaveLength(1);
    expect(ref(last().rowFields, "Geo.Region").hiddenItems).toEqual([]);
    expect(ref(last().columnFields, "Sales.Year")).not.toHaveProperty("hiddenItems");
    expect(ref(last().filterFields, "Sales.Channel")).not.toHaveProperty("hiddenItems");
    // The chip stores the clear as [] (the DSL renders nothing for it).
    expect(h.dropZones!.rows.find((f) => f.name === "Geo.Region")!.hiddenItems).toEqual([]);
  });

  it("changing a NOT IN sends the new list", async () => {
    await mount();
    await applyDsl(seededRows(), [chip("Sales.Year", ["2021", "2022"])], seededFilters());
    expect(ref(last().columnFields, "Sales.Year").hiddenItems).toEqual(["2021", "2022"]);
    expect(ref(last().rowFields, "Geo.Region")).not.toHaveProperty("hiddenItems");
  });

  it("clearing a FILTER-zone field sends []", async () => {
    await mount();
    await applyDsl(seededRows(), seededColumns(), [chip("Sales.Channel")]);
    expect(ref(last().filterFields, "Sales.Channel").hiddenItems).toEqual([]);
  });

  it("once the backend accepted it, the next edit does not resend it", async () => {
    await mount();
    await applyDsl([chip("Geo.Region"), chip("Geo.City"), chip("Time Intelligence", ["YoY"])], seededColumns(), seededFilters());
    await toggleColumnOn("Sales", "Product");

    expect(h.sent).toHaveLength(2);
    expect(ref(h.sent[1].rowFields, "Geo.Region")).not.toHaveProperty("hiddenItems");
  });

  it("a SUPERSEDED request does not lose the edit: the next request carries it", async () => {
    await mount();
    h.updateImpl = () => Promise.reject(new Error("Pivot operation superseded"));
    await applyDsl([chip("Geo.Region"), chip("Geo.City"), chip("Time Intelligence", ["YoY"])], seededColumns(), seededFilters());
    h.updateImpl = null;
    await toggleColumnOn("Sales", "Product");

    expect(h.sent).toHaveLength(2);
    expect(ref(h.sent[1].rowFields, "Geo.Region").hiddenItems).toEqual([]);
  });

  it("with Defer Layout Update on, the Update button sends the edit", async () => {
    await mount();
    const defer = container.querySelector("input[type='checkbox']") as HTMLInputElement;
    await act(async () => defer.click());
    await applyDsl([chip("Geo.Region"), chip("Geo.City"), chip("Time Intelligence", ["YoY"])], seededColumns(), seededFilters());
    expect(h.sent).toHaveLength(0);

    const update = [...container.querySelectorAll("button")].find((b) => b.textContent === "Update")!;
    await act(async () => update.click());
    await settle();

    expect(h.sent).toHaveLength(1);
    expect(ref(last().rowFields, "Geo.Region").hiddenItems).toEqual([]);
  });
});

describe("the filter dropdown's own apply (PIVOT_FILTER_APPLIED)", () => {
  it("stores a cleared filter as [] and retires an older unsent edit of that field", async () => {
    await mount();
    // A DSL edit of the filter field whose request never landed (superseded),
    // so the edit is still pending...
    h.updateImpl = () => Promise.reject(new Error("Pivot operation superseded"));
    await applyDsl(seededRows(), seededColumns(), [chip("Sales.Channel", ["Web", "Store"])]);
    expect(ref(last().filterFields, "Sales.Channel").hiddenItems).toEqual(["Web", "Store"]);
    h.updateImpl = null;

    // ...then the dropdown clears the filter on the pivot itself.
    await act(async () => {
      for (const cb of h.listeners.get("app:pivot-filter-applied") ?? []) {
        cb({ pivotId: "pv", fieldIndex: 0, fieldName: "Sales.Channel", hiddenItems: undefined });
      }
    });
    await settle();
    expect(h.dropZones!.filters[0].hiddenItems).toEqual([]);

    // An unrelated edit follows: it must not resend the older DSL list over
    // the dropdown's clear.
    await toggleColumnOn("Sales", "Product");
    expect(ref(last().filterFields, "Sales.Channel")).not.toHaveProperty("hiddenItems");
  });
});

// ---------------------------------------------------------------------------
// Review round 3
// ---------------------------------------------------------------------------

/** The pivot announces a new view (what `cachePivotView` emits). */
async function viewUpdated(version: number): Promise<void> {
  await act(async () => {
    for (const cb of h.listeners.get("app:pivot-view-updated") ?? []) cb({ pivotId: "pv", version });
  });
  await settle();
}

const def = (sourceIndex: number, name: string, hiddenItems?: string[]) => ({
  sourceIndex,
  name,
  isNumeric: false,
  ...(hiddenItems ? { hiddenItems } : {}),
});

/** The BI pivot's definition after a slicer cleared Region and widened Channel. */
const biDefinitionNow = () => ({
  rowFields: [def(4, "Geo.Region"), def(5, "Geo.City"), def(9, "Time Intelligence", ["YoY"])],
  columnFields: [def(6, "Sales.Year", ["2023"])],
  valueFields: [],
  filterFields: [def(7, "Sales.Channel", ["Web", "Store"])],
  layout: {},
});

const rchip = (sourceIndex: number, name: string, hiddenItems?: string[]): ZoneField => ({
  sourceIndex,
  name,
  isNumeric: false,
  ...(hiddenItems ? { hiddenItems } : {}),
});

/** A RANGE pivot: Rows = Region hiding West, as seeded at mount. */
async function mountRange(): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(PivotEditor, {
        pivotId: "pv",
        sourceFields: [
          { index: 0, name: "Region", isNumeric: false },
          { index: 1, name: "Product", isNumeric: false },
          { index: 2, name: "Amount", isNumeric: true },
        ],
        initialRows: [rchip(0, "Region", ["West"])],
        initialColumns: [],
        initialValues: [{ sourceIndex: 2, name: "Amount", isNumeric: true, aggregation: "sum" }],
        initialFilters: [],
        initialLayout: {},
      }),
    );
  });
  await settle();
}

describe("the chips follow the pivot's definition (review3 findings 1 and 6)", () => {
  it("a RANGE pivot's next field-list edit sends the list the pivot has NOW, not the mount-time one", async () => {
    await mountRange();
    expect(h.dropZones!.rows[0].hiddenItems, "seeded at mount").toEqual(["West"]);

    // The Row Labels dropdown selected every item: the pivot hides nothing
    // on Region any more, and the pivot's view is replaced.
    h.readImpl = () =>
      Promise.resolve({ rowFields: [def(0, "Region")], columnFields: [], valueFields: [], filterFields: [], layout: {} });
    await viewUpdated(2);

    // An unrelated field-list edit. update_pivot_fields reads an absent list
    // as CLEAR, so the range request must carry each chip's list -- and it
    // must be the pivot's current one, or West comes silently back.
    await act(async () => h.rangeFieldList!.onFieldToggle({ index: 1, name: "Product", isNumeric: false }, true));
    await settle();
    const region = h.rangeSent[h.rangeSent.length - 1].rowFields!.find((f) => f.name === "Region")!;
    expect(region.hiddenItems ?? []).toEqual([]);
  });

  it("a model pivot's chips -- and so the DSL -- show what the pivot hides now, and the re-sync is no edit", async () => {
    await mount();
    h.readImpl = () => Promise.resolve(biDefinitionNow());
    await viewUpdated(2);

    expect(h.sent, "a re-sync sends nothing").toHaveLength(0);
    expect(h.design!.rows.find((f) => f.name === "Geo.Region")!.hiddenItems).toEqual([]);
    expect(h.design!.filters.find((f) => f.name === "Sales.Channel")!.hiddenItems).toEqual(["Web", "Store"]);

    // An unrelated edit carries no item filter for the re-synced fields.
    await toggleColumnOn("Sales", "Product");
    expect(ref(last().rowFields, "Geo.Region")).not.toHaveProperty("hiddenItems");
    expect(ref(last().filterFields, "Sales.Channel")).not.toHaveProperty("hiddenItems");

    // Finding 6: the DSL line the user cuts and pastes is the one it now
    // shows -- Region with no NOT IN -- so the move sends no stale list.
    const rowsWithoutRegion = h.design!.rows.filter((f) => f.name !== "Geo.Region");
    await applyDsl(rowsWithoutRegion, seededColumns(), seededFilters());
    await applyDsl(rowsWithoutRegion, [...seededColumns(), chip("Geo.Region")], seededFilters());
    expect(ref(last().columnFields, "Geo.Region")).not.toHaveProperty("hiddenItems");
  });

  it("a read that a request was built or acknowledged across is read AGAIN, not trusted", async () => {
    await mount();
    // The first read stalls; it will answer with the pivot as it was BEFORE
    // the request below (Region still hiding West).
    let answerFirst!: (v: unknown) => void;
    h.readImpl = () =>
      new Promise((resolve) => {
        answerFirst = resolve;
      });
    await viewUpdated(2);
    expect(h.reads).toBe(1);

    // Meanwhile the user deletes Region's NOT IN; the backend takes it.
    await applyDsl([chip("Geo.Region"), chip("Geo.City"), chip("Time Intelligence", ["YoY"])], seededColumns(), seededFilters());
    expect(ref(last().rowFields, "Geo.Region").hiddenItems).toEqual([]);

    // The stale answer lands after the acknowledgement. Trusting it would put
    // West back on the chip (the edit is no longer pending to protect it).
    h.readImpl = () => Promise.resolve(biDefinitionNow());
    await act(async () => {
      answerFirst({
        ...biDefinitionNow(),
        rowFields: [def(4, "Geo.Region", ["West"]), def(5, "Geo.City"), def(9, "Time Intelligence", ["YoY"])],
      });
    });
    await settle();

    expect(h.reads, "the stale read is repeated").toBe(2);
    expect(h.design!.rows.find((f) => f.name === "Geo.Region")!.hiddenItems).toEqual([]);
  });

  it("a view re-fetched at the SAME version does not read the definition again", async () => {
    await mount();
    h.readImpl = () => Promise.resolve(biDefinitionNow());
    await viewUpdated(3);
    await viewUpdated(3);
    expect(h.reads).toBe(1);
    await viewUpdated(4);
    expect(h.reads).toBe(2);
  });
});

describe("an inclusion filter the DSL could not resolve is NOT a removed filter (review3 finding 3)", () => {
  it("Sales.Channel = (\"Store\") with no item list loaded keeps the pivot's filter and warns", async () => {
    await mount();
    const res = compileForEditor(
      "ROWS: Geo.Region NOT IN (\"West\"), Geo.City, \"Time Intelligence\" NOT IN (\"YoY\")\n" +
        "COLUMNS: Sales.Year NOT IN (\"2023\")\nVALUES: [Revenue]\nFILTERS: Sales.Channel = (\"Store\")",
      { sourceFields: [], biModel, filterUniqueValues: new Map() },
    );
    expect([...res.unresolvedInclusions]).toEqual(["Sales.Channel"]);
    expect(res.errors.some((e) => e.severity === "warning" && e.message.includes("Sales.Channel"))).toBe(true);

    await act(async () => {
      h.design!.onZoneStateChange(
        res.rows, res.columns, res.values, res.filters, res.layout, undefined, undefined, res.unresolvedInclusions,
      );
    });
    await settle();

    // Before the fix this was [] -- "remove the filter" -- and every channel came back.
    expect(ref(last().filterFields, "Sales.Channel")).not.toHaveProperty("hiddenItems");
    expect(h.design!.filters.find((f) => f.name === "Sales.Channel")!.hiddenItems).toEqual(["Web"]);
  });
});

describe("Defer Layout Update: removing a field forgets its pending edit (review3 finding 4)", () => {
  it("an item-filter edit made before the field was removed and re-added is not sent", async () => {
    await mount();
    const defer = container.querySelector("input[type='checkbox']") as HTMLInputElement;
    await act(async () => defer.click());
    // DSL: Region's NOT IN goes from [West] to [West, East] -- an edit.
    await applyDsl([chip("Geo.Region", ["West", "East"]), chip("Geo.City"), chip("Time Intelligence", ["YoY"])], seededColumns(), seededFilters());
    // Field list: untick Region, then tick it again -- a fresh chip, no filter.
    const toggle = h.fieldList!.onColumnToggle as (t: string, c: string, n: boolean, on: boolean) => void;
    await act(async () => toggle("Geo", "Region", false, false));
    await settle();
    await act(async () => toggle("Geo", "Region", false, true));
    await settle();
    expect(h.sent).toHaveLength(0);
    expect(h.dropZones!.rows.find((f) => f.name === "Geo.Region")!.hiddenItems ?? []).toEqual([]);

    const update = [...container.querySelectorAll("button")].find((b) => b.textContent === "Update")!;
    await act(async () => update.click());
    await settle();
    expect(h.sent).toHaveLength(1);
    expect(ref(last().rowFields, "Geo.Region")).not.toHaveProperty("hiddenItems");
  });
});

describe("dragging a chip to another zone keeps its item filter (review3 finding 5)", () => {
  it("a calculation group keeps its item subset -- as the context menu's Move already did", async () => {
    await mount();
    await act(async () => {
      h.dropZones!.onDrop("columns", { name: "Time Intelligence", sourceIndex: -1, isNumeric: false, fromZone: "rows", fromIndex: 2 });
    });
    await settle();
    expect(h.sent).toHaveLength(1);
    expect(ref(last().columnFields, "Time Intelligence").hiddenItems).toEqual(["YoY"]);
    expect(last().rowFields.some((f) => f.column === "Time Intelligence")).toBe(false);
  });

  it("a RANGE field keeps its filter (its request would otherwise CLEAR it)", async () => {
    await mountRange();
    await act(async () => {
      h.dropZones!.onDrop("columns", { name: "Region", sourceIndex: 0, isNumeric: false, fromZone: "rows", fromIndex: 0 });
    });
    await settle();
    const sent = h.rangeSent[h.rangeSent.length - 1];
    expect(sent.rowFields).toEqual([]);
    expect(sent.columnFields!.find((f) => f.name === "Region")!.hiddenItems).toEqual(["West"]);
  });
});
