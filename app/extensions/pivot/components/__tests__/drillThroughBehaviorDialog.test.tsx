//! FILENAME: app/extensions/Pivot/components/__tests__/drillThroughBehaviorDialog.test.tsx
// PURPOSE: The Drill-through behavior dialog's 4th radio, "Design query"
//          (docs/design/model-drillthrough.md 2.9):
//          - a behaviour carrying a `designQuery` opens on that radio (it WINS
//            over `kind`), shows the stored query in the SHARED editor, and
//            the modal is wide (at least 640 px);
//          - the editor's model is the LIVE connection's
//            (`get_connection_bi_model`), falling back to the pivot's cached
//            tables / measures when the connection is ZERO or cannot be read;
//            the editor's assist gets the pivot's connection ONLY when its live
//            model was read ("" otherwise, so the assist never mounts and no
//            dry run is sent a ZERO, unknown or unreadable id -- spec 2.2), and
//            one muted line says why;
//          - Save writes `{ kind: <previous kind or "builtin">, designQuery }`
//            (the previous query override kept beside it) and tells the
//            selection handler (the cached region learns it); another
//            radio's Save drops the definition; Save is disabled while the
//            query is blank; a failed save is a toast and the dialog stays
//            open;
//          - `readOnly` (a subscriber's view): no Save, radios disabled, the
//            query shown as text.
// CONTEXT: @testing-library/react is not installed; react-dom + `act`, as
//          the sibling component tests do. The shared Monaco editor is
//          stubbed with a textarea (real Monaco crashes jsdom; the shared
//          editor's own test stubs it the same way). pivot-api, the Pivot
//          channel and the selection handler are doubled; @api is the real
//          barrel with `showToast` recorded.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  getPivotBiMetadata: vi.fn(),
  getPivotDrillBehavior: vi.fn(),
  setPivotDrillBehavior: vi.fn(),
  getConnectionBiModel: vi.fn(),
  getPivotTableInfo: vi.fn(),
  noteDrillBehaviorSaved: vi.fn(),
  invoke: vi.fn(),
  toasts: [] as Array<{ message: string; variant?: string }>,
  /** The `assist` prop the (stubbed) shared Monaco editor last received. */
  assist: undefined as { connectionId: string } | null | undefined,
}));

vi.mock("@api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@api")>();
  return {
    ...actual,
    showToast: (message: string, options?: { variant?: string }) => {
      h.toasts.push({ message, variant: options?.variant });
    },
  };
});
vi.mock("@api/dialogWindow", () => ({
  useDialogWindow: () => ({ ref: { current: null }, style: {}, onHeaderMouseDown: () => {}, resizeHandles: null }),
}));
vi.mock("../../lib/pivot-api", () => ({
  getPivotBiMetadata: (...a: unknown[]) => h.getPivotBiMetadata(...a),
  getPivotDrillBehavior: (...a: unknown[]) => h.getPivotDrillBehavior(...a),
  setPivotDrillBehavior: (...a: unknown[]) => h.setPivotDrillBehavior(...a),
  getConnectionBiModel: (...a: unknown[]) => h.getConnectionBiModel(...a),
  getPivotTableInfo: (...a: unknown[]) => h.getPivotTableInfo(...a),
}));
vi.mock("../../lib/pivotBackend", () => ({
  pivotBackend: { invoke: (...a: unknown[]) => h.invoke(...a) },
}));
vi.mock("../../handlers/selectionHandler", () => ({
  noteDrillBehaviorSaved: (...a: unknown[]) => h.noteDrillBehaviorSaved(...a),
}));
vi.mock("../../../_shared/dsl/pivotLayout/DesignQueryEditor", () => ({
  DesignQueryEditor: (p: { value: string; onChange: (v: string) => void; assist?: { connectionId: string } }) => {
    // The real editor mounts its describe-a-query assist (whose dry run runs
    // the query on `assist.connectionId`) only when that id is non-empty.
    h.assist = p.assist ?? null;
    return React.createElement("textarea", {
      "data-testid": "dsl-stub",
      value: p.value,
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => p.onChange(e.target.value),
    });
  },
}));

import DrillThroughBehaviorDialog, {
  CACHED_MODEL_NOTE,
  EMPTY_DRILL_DEFINITION,
  WIDE_MODAL_WIDTH,
  designQueryBehavior,
  drillModeOf,
  isZeroConnection,
} from "../DrillThroughBehaviorDialog";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const NIL = "00000000-0000-0000-0000-000000000000";
const col = (name: string, isNumeric = false) => ({ name, dataType: isNumeric ? "number" : "string", isNumeric });
/** The pivot's CACHED model (get_pivot_bi_metadata): tables, measures, its connection. */
const CACHED_MODEL = {
  connectionId: "c1",
  tables: [
    { name: "Sales", columns: [col("Amount", true)] },
    { name: "Product", columns: [col("Category")] },
  ],
  measures: [{ name: "Revenue", table: "Sales" }],
};
/** The LIVE connection's model (get_connection_bi_model): one more table, so the two can be told apart. */
const LIVE_MODEL = { ...CACHED_MODEL, tables: [...CACHED_MODEL.tables, { name: "Geo", columns: [col("Region")] }] };
const DEF = { dslText: "ROWS: Geo.Region\nVALUES: [Revenue]", presentation: { kind: "table" as const }, name: "Region detail" };

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

beforeEach(() => {
  for (const f of [
    h.getPivotBiMetadata,
    h.getPivotDrillBehavior,
    h.setPivotDrillBehavior,
    h.getConnectionBiModel,
    h.getPivotTableInfo,
    h.noteDrillBehaviorSaved,
    h.invoke,
    onClose,
  ]) {
    f.mockReset();
  }
  h.toasts = [];
  h.assist = undefined;
  h.getPivotBiMetadata.mockResolvedValue(CACHED_MODEL);
  h.getPivotDrillBehavior.mockResolvedValue(null);
  h.setPivotDrillBehavior.mockResolvedValue(undefined);
  h.getConnectionBiModel.mockResolvedValue(LIVE_MODEL);
  h.getPivotTableInfo.mockResolvedValue({ id: "pv-1", name: "Sales by Region" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function open(data: Record<string, unknown> = { pivotId: "pv-1" }): Promise<void> {
  act(() => {
    root.render(<DrillThroughBehaviorDialog isOpen onClose={onClose} data={data} />);
  });
  await flush();
}

function $(selector: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`no element for ${selector}`);
  return el;
}

function radio(mode: string): HTMLInputElement {
  return $(`[data-testid=pivot-drill-mode-${mode}]`) as HTMLInputElement;
}

function saveButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>("[data-testid=pivot-drill-save]");
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
  await flush();
}

function typeInto(el: HTMLTextAreaElement | HTMLInputElement, text: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("pure helpers", () => {
  it("drillModeOf: a present designQuery WINS over kind; else the kind; else builtin", () => {
    expect(drillModeOf(null)).toBe("builtin");
    expect(drillModeOf(undefined)).toBe("builtin");
    expect(drillModeOf({ kind: "script" })).toBe("script");
    expect(drillModeOf({ kind: "query", query: { limit: 5 } })).toBe("query");
    expect(drillModeOf({ kind: "script", designQuery: DEF })).toBe("designQuery");
  });

  it("designQueryBehavior keeps the previous kind and its query override beside the definition; builtin when there was none", () => {
    expect(designQueryBehavior(null, DEF)).toEqual({ kind: "builtin", designQuery: DEF });
    expect(designQueryBehavior({ kind: "script" }, DEF)).toEqual({ kind: "script", designQuery: DEF });
    const query = { dimensionColumns: [{ table: "Product", column: "Category" }], limit: 10 };
    expect(designQueryBehavior({ kind: "query", query }, DEF)).toEqual({ kind: "query", query, designQuery: DEF });
  });

  it("isZeroConnection: absent, '0' and the ZERO EntityId (the nil UUID) name no live connection", () => {
    expect(isZeroConnection(undefined)).toBe(true);
    expect(isZeroConnection("")).toBe(true);
    expect(isZeroConnection("0")).toBe(true);
    expect(isZeroConnection(NIL)).toBe(true);
    expect(isZeroConnection("c1")).toBe(false);
    expect(isZeroConnection("3f2a6c1e-0000-4000-8000-000000000001")).toBe(false);
  });

  it("the Design query radio starts from an empty TABLE definition; the wide modal is at least 640 px", () => {
    expect(EMPTY_DRILL_DEFINITION).toEqual({ dslText: "", presentation: { kind: "table" } });
    expect(WIDE_MODAL_WIDTH).toBeGreaterThanOrEqual(640);
  });
});

describe("opening", () => {
  it("a behaviour with a designQuery opens on the Design query radio (it wins over kind), shows the stored query in the shared editor, and the modal is wide", async () => {
    h.getPivotDrillBehavior.mockResolvedValue({ kind: "script", designQuery: DEF });
    await open();
    expect(radio("designQuery").checked).toBe(true);
    expect(radio("script").checked).toBe(false);
    expect(($("[data-testid=dsl-stub]") as HTMLTextAreaElement).value).toBe(DEF.dslText);
    expect(($("[data-testid=drill-through-name]") as HTMLInputElement).value).toBe("Region detail");
    expect($("[data-testid=drill-through-source]").textContent).toContain('the PivotTable "Sales by Region"');
    const dialog = $("[data-testid=pivot-drill-behavior-dialog]");
    expect(dialog.dataset.wide).toBe("true");
    expect(dialog.style.width).toBe(`${WIDE_MODAL_WIDTH}px`);
  });

  it("without a designQuery the radio is the kind's, the modal is narrow, and the editor is not mounted", async () => {
    h.getPivotDrillBehavior.mockResolvedValue({ kind: "query", query: { limit: 3 } });
    await open();
    expect(radio("query").checked).toBe(true);
    expect(radio("designQuery").checked).toBe(false);
    expect(container.querySelector("[data-testid=pivot-drill-design-query]")).toBeNull();
    const dialog = $("[data-testid=pivot-drill-behavior-dialog]");
    expect(dialog.dataset.wide).toBe("false");
    expect(dialog.style.width).toBe("");
  });

  it("the editor's model is the LIVE connection's (get_connection_bi_model on the pivot's connection)", async () => {
    // SABOTAGE: hand the editor get_pivot_bi_metadata's partial JSON -- its
    // autocomplete never learns hierarchies, calculation groups or cultures.
    h.getPivotDrillBehavior.mockResolvedValue({ kind: "builtin", designQuery: DEF });
    await open();
    expect(h.getConnectionBiModel).toHaveBeenCalledWith("c1");
  });

  it("a ZERO connection (the nil UUID after a .cala load) falls back to the pivot's cached model without asking the live one", async () => {
    h.getPivotBiMetadata.mockResolvedValue({ ...CACHED_MODEL, connectionId: NIL });
    h.getPivotDrillBehavior.mockResolvedValue({ kind: "builtin", designQuery: DEF });
    await open();
    expect(h.getConnectionBiModel).not.toHaveBeenCalled();
    // The editor still mounts on the cached model.
    expect(container.querySelector("[data-testid=dsl-stub]")).not.toBeNull();
    expect(h.toasts).toEqual([]);
  });

  it("a live model that cannot be read falls back to the cached model too, quietly", async () => {
    h.getConnectionBiModel.mockRejectedValue(new Error("connection gone"));
    h.getPivotDrillBehavior.mockResolvedValue({ kind: "builtin", designQuery: DEF });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await open();
    expect(container.querySelector("[data-testid=dsl-stub]")).not.toBeNull();
    expect(h.toasts).toEqual([]);
    warn.mockRestore();
  });
});

describe("the assist's connection: only a connection whose LIVE model was read (spec 2.2)", () => {
  const note = (): HTMLElement | null => container.querySelector("[data-testid=pivot-drill-cached-model-note]");

  it("after a successful live read the assist gets the pivot's connection, and no note is shown", async () => {
    h.getPivotDrillBehavior.mockResolvedValue({ kind: "builtin", designQuery: DEF });
    await open();
    expect(h.getConnectionBiModel).toHaveBeenCalledWith("c1");
    expect(h.assist?.connectionId).toBe("c1");
    expect(note()).toBeNull();
  });

  it("a ZERO connection (the nil UUID) hands the assist '' -- it never mounts, so nothing can run a query on the nil id -- and the note says why", async () => {
    // SABOTAGE: hand the editor the pivot's connection unconditionally (the
    // pre-fix setConnectionId(pivotConnection)) -- the assist mounts and its
    // dry run sends run_design_query the nil UUID.
    h.getPivotBiMetadata.mockResolvedValue({ ...CACHED_MODEL, connectionId: NIL });
    h.getPivotDrillBehavior.mockResolvedValue({ kind: "builtin", designQuery: DEF });
    await open();
    expect(h.getConnectionBiModel).not.toHaveBeenCalled();
    expect(h.assist?.connectionId).toBe("");
    expect(note()?.textContent).toBe(CACHED_MODEL_NOTE);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("a live read that answers nothing (an unknown or deleted connection id) hands the assist '' too", async () => {
    h.getConnectionBiModel.mockResolvedValue(null);
    h.getPivotDrillBehavior.mockResolvedValue({ kind: "builtin", designQuery: DEF });
    await open();
    expect(h.getConnectionBiModel).toHaveBeenCalledWith("c1");
    expect(h.assist?.connectionId).toBe("");
    expect(note()?.textContent).toBe(CACHED_MODEL_NOTE);
  });

  it("a live read that FAILS hands the assist '' too, and says why rather than staying silent", async () => {
    h.getConnectionBiModel.mockRejectedValue(new Error("connection gone"));
    h.getPivotDrillBehavior.mockResolvedValue({ kind: "builtin", designQuery: DEF });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await open();
    expect(h.assist?.connectionId).toBe("");
    expect(note()?.textContent).toBe(CACHED_MODEL_NOTE);
    expect(h.toasts).toEqual([]);
    warn.mockRestore();
  });

  it("a reopened dialog asks again: a connection read live before does not survive a later failed read", async () => {
    h.getPivotDrillBehavior.mockResolvedValue({ kind: "builtin", designQuery: DEF });
    await open();
    expect(h.assist?.connectionId).toBe("c1");

    act(() => {
      root.render(<DrillThroughBehaviorDialog isOpen={false} onClose={onClose} data={{ pivotId: "pv-1" }} />);
    });
    h.getConnectionBiModel.mockRejectedValue(new Error("connection gone"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await open();
    expect(h.assist?.connectionId).toBe("");
    expect(note()).not.toBeNull();
    warn.mockRestore();
  });

  it("the read-only view (no editor, no assist) shows no note", async () => {
    h.getPivotBiMetadata.mockResolvedValue({ ...CACHED_MODEL, connectionId: NIL });
    h.getPivotDrillBehavior.mockResolvedValue({ kind: "builtin", designQuery: DEF });
    await open({ pivotId: "pv-1", readOnly: true });
    expect(container.querySelector("[data-testid=drill-through-dsl-readonly]")).not.toBeNull();
    expect(note()).toBeNull();
  });
});

describe("saving", () => {
  it("choosing Design query on a Built-in pivot and saving writes { kind: 'builtin', designQuery } and tells the selection handler", async () => {
    await open();
    expect(radio("builtin").checked).toBe(true);
    await click(radio("designQuery"));
    expect($("[data-testid=pivot-drill-behavior-dialog]").dataset.wide).toBe("true");
    // Blank query: Save is disabled.
    expect(saveButton()!.disabled).toBe(true);
    typeInto($("[data-testid=dsl-stub]") as HTMLTextAreaElement, "ROWS: Product.Category\nVALUES: [Revenue]");
    typeInto($("[data-testid=drill-through-name]") as HTMLInputElement, "Category detail");
    expect(saveButton()!.disabled).toBe(false);
    await click(saveButton()!);
    const expected = {
      kind: "builtin",
      designQuery: {
        dslText: "ROWS: Product.Category\nVALUES: [Revenue]",
        presentation: { kind: "table" },
        name: "Category detail",
      },
    };
    expect(h.setPivotDrillBehavior).toHaveBeenCalledWith("pv-1", expected);
    expect(h.noteDrillBehaviorSaved).toHaveBeenCalledWith("pv-1", expected);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a Custom pivot keeps its kind AND its query override when a design query is saved beside them", async () => {
    const query = { dimensionColumns: [{ table: "Product", column: "Category" }], limit: 10 };
    h.getPivotDrillBehavior.mockResolvedValue({ kind: "query", query });
    await open();
    await click(radio("designQuery"));
    typeInto($("[data-testid=dsl-stub]") as HTMLTextAreaElement, "ROWS: Product.Category\nVALUES: [Revenue]");
    await click(saveButton()!);
    expect(h.setPivotDrillBehavior).toHaveBeenCalledWith("pv-1", {
      kind: "query",
      query,
      designQuery: { dslText: "ROWS: Product.Category\nVALUES: [Revenue]", presentation: { kind: "table" } },
    });
  });

  it("choosing another radio clears the design query: Built-in saves null, Script saves { kind: 'script' }", async () => {
    // SABOTAGE: carry `designQuery` on every save -- a present definition WINS,
    // so the user could never turn the design-query drill off.
    h.getPivotDrillBehavior.mockResolvedValue({ kind: "builtin", designQuery: DEF });
    await open();
    await click(radio("builtin"));
    expect($("[data-testid=pivot-drill-behavior-dialog]").dataset.wide).toBe("false");
    await click(saveButton()!);
    expect(h.setPivotDrillBehavior).toHaveBeenLastCalledWith("pv-1", null);
    expect(h.noteDrillBehaviorSaved).toHaveBeenLastCalledWith("pv-1", null);

    await open();
    await click(radio("script"));
    await click(saveButton()!);
    expect(h.setPivotDrillBehavior).toHaveBeenLastCalledWith("pv-1", { kind: "script" });
  });

  it("the editor's edits (presentation, keep filters) land in the saved definition", async () => {
    h.getPivotDrillBehavior.mockResolvedValue({ kind: "builtin", designQuery: DEF });
    await open();
    await click($("[data-testid=drill-through-presentation-chart]"));
    await click($("[data-testid=drill-through-keep-filters]"));
    await click(saveButton()!);
    const saved = h.setPivotDrillBehavior.mock.calls[0][1] as { designQuery: Record<string, unknown> };
    expect(saved.designQuery.presentation).toEqual({ kind: "chart", mark: expect.any(String) });
    expect(saved.designQuery.keepFilters).toBe(false);
    expect(saved.designQuery.dslText).toBe(DEF.dslText);
  });

  it("a failed save is a TOAST and the dialog stays open (never a console-only catch)", async () => {
    h.getPivotDrillBehavior.mockResolvedValue({ kind: "builtin", designQuery: DEF });
    h.setPivotDrillBehavior.mockRejectedValue(new Error("Pivot pv-1 is not a data-model pivot"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await open();
    await click(saveButton()!);
    expect(h.toasts).toEqual([
      { message: "Could not save the drill-through behavior: Pivot pv-1 is not a data-model pivot", variant: "error" },
    ]);
    expect(onClose).not.toHaveBeenCalled();
    expect(h.noteDrillBehaviorSaved).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("read-only (a subscriber's view of a publisher's definition)", () => {
  it("shows the query as text, disables every radio, and has no Save", async () => {
    // SABOTAGE: ignore data.readOnly -- a subscriber edits and saves the
    // publisher's definition into a sheet that is not theirs.
    h.getPivotDrillBehavior.mockResolvedValue({ kind: "builtin", designQuery: DEF });
    await open({ pivotId: "pv-1", readOnly: true });
    expect(saveButton()).toBeNull();
    for (const mode of ["builtin", "query", "script", "designQuery"]) {
      expect(radio(mode).disabled, mode).toBe(true);
    }
    expect(radio("designQuery").checked).toBe(true);
    expect(container.querySelector("[data-testid=dsl-stub]")).toBeNull();
    expect($("[data-testid=drill-through-dsl-readonly]").textContent).toBe(DEF.dslText);
    expect($("[data-testid=drill-through-source]").textContent).toMatch(/view only/);
    const close = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Close");
    expect(close).toBeDefined();
    await click(close!);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(h.setPivotDrillBehavior).not.toHaveBeenCalled();
  });
});
