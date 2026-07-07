//! FILENAME: app/extensions/ControlsPane/lib/__tests__/controlsPaneStore.test.ts
// PURPOSE: Tests for ControlsPane store cache management, value commit/preview
//          transience, merged-strip ordering, and the @api/controlValues
//          provider mapping. Mirrors filterPaneStore.test.ts mocking style.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Mocks
// ============================================================================

const mockCreatePaneControl = vi.fn();
const mockDeletePaneControl = vi.fn();
const mockUpdatePaneControl = vi.fn();
const mockSetPaneControlValue = vi.fn();
const mockGetAllPaneControls = vi.fn();
const mockGetPaneControl = vi.fn();

vi.mock("../controlsPaneApi", () => ({
  createPaneControl: (...args: unknown[]) => mockCreatePaneControl(...args),
  deletePaneControl: (...args: unknown[]) => mockDeletePaneControl(...args),
  updatePaneControl: (...args: unknown[]) => mockUpdatePaneControl(...args),
  setPaneControlValue: (...args: unknown[]) => mockSetPaneControlValue(...args),
  getAllPaneControls: (...args: unknown[]) => mockGetAllPaneControls(...args),
  getPaneControl: (...args: unknown[]) => mockGetPaneControl(...args),
}));

// Fire-and-forget GET.CONTROLVALUE recalc: must return a promise (the store
// chains .then/.catch on it). Implementation survives vi.clearAllMocks().
const mockRecalcControlDependents = vi.fn(() => Promise.resolve([]));

vi.mock("../filterPaneApi", () => ({
  recalcControlDependents: (...args: unknown[]) =>
    mockRecalcControlDependents(...args),
}));

// The store merges ribbon filters via filterPaneStore.getAllFilters and derives
// each filter's control value via filterPaneStore.filterControlValue.
const mockGetAllFilters = vi.fn((): RibbonFilter[] => []);

vi.mock("../filterPaneStore", () => ({
  getAllFilters: (...args: unknown[]) => mockGetAllFilters(...args),
  // Real mapping (mirrors the Rust snapshot builder) so buildNamedControlList
  // produces the expected (All)/text/textList values.
  filterControlValue: (selectedItems: string[] | null) =>
    selectedItems === null
      ? { kind: "text", value: "(All)" }
      : selectedItems.length === 1
        ? { kind: "text", value: selectedItems[0] }
        : { kind: "textList", value: selectedItems },
}));

vi.mock("../controlsPaneEvents", () => ({
  ControlsPaneEvents: {
    CONTROL_CREATED: "controlspane:control-created",
    CONTROL_DELETED: "controlspane:control-deleted",
    CONTROL_UPDATED: "controlspane:control-updated",
    CONTROL_VALUE_CHANGED_LOCAL: "controlspane:value-changed-local",
    CONTROLS_REFRESHED: "controlspane:controls-refreshed",
  },
}));

import type { RibbonFilter } from "../filterPaneTypes";
import type { PaneControl, ControlValue } from "../controlsPaneTypes";
import {
  CONTROL_VALUE_CHANGED,
  type ControlValueChangedDetail,
} from "@api/controlValues";
import {
  getAllControls,
  getControlById,
  getControlByName,
  createControlAsync,
  deleteControlAsync,
  updateControlAsync,
  commitValue,
  previewValue,
  getPaneItems,
  buildNamedControlList,
  refreshControlsCache,
  clearControlsCache,
} from "../controlsPaneStore";

// ============================================================================
// Test Helpers
// ============================================================================

function makeControl(overrides: Partial<PaneControl> = {}): PaneControl {
  return {
    id: "0197c001-0000-7000-8000-000000000001",
    name: "Test Control",
    controlType: "slider",
    config: { type: "slider", min: 0, max: 100, step: 1, showValue: true },
    value: { kind: "number", value: 50 },
    order: 0,
    ...overrides,
  };
}

function makeFilter(overrides: Partial<RibbonFilter> = {}): RibbonFilter {
  return {
    id: "0197f001-0000-7000-8000-000000000001",
    name: "Test Filter",
    connectionId: "0197a001-0000-7000-8000-00000000000a",
    fieldName: "Products.Category",
    fieldDataType: "text",
    connectionMode: "workbook",
    connectedPivots: [],
    connectedSheets: [],
    displayMode: "checklist",
    selectedItems: null,
    crossFilterTargets: [],
    crossFilterSlicerTargets: [],
    advancedFilter: null,
    hideNoData: false,
    indicateNoData: true,
    sortNoDataLast: false,
    showSelectAll: true,
    singleSelect: false,
    order: 0,
    buttonColumns: 1,
    buttonRows: 1,
    ...overrides,
  };
}

/** Seed the controls cache through the public refresh path. */
async function seedControls(controls: PaneControl[]): Promise<void> {
  mockGetAllPaneControls.mockResolvedValue(controls);
  await refreshControlsCache();
}

/** Capture ControlValueChangedDetail payloads for a window event name. */
function captureValueEvents(eventName: string): {
  events: ControlValueChangedDetail[];
  stop: () => void;
} {
  const events: ControlValueChangedDetail[] = [];
  const handler = (e: Event) => {
    events.push((e as CustomEvent<ControlValueChangedDetail>).detail);
  };
  window.addEventListener(eventName, handler);
  return {
    events,
    stop: () => window.removeEventListener(eventName, handler),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearControlsCache();
  mockGetAllFilters.mockReturnValue([]);
  mockRecalcControlDependents.mockResolvedValue([]);
});

// ============================================================================
// Accessors
// ============================================================================

describe("controlsPaneStore accessors", () => {
  it("getAllControls returns empty array initially", () => {
    expect(getAllControls()).toEqual([]);
  });

  it("getControlById returns undefined when cache is empty", () => {
    expect(getControlById("nope")).toBeUndefined();
  });

  it("getAllControls returns controls sorted by order", async () => {
    await seedControls([
      makeControl({ id: "c-1", name: "C", order: 2 }),
      makeControl({ id: "c-2", name: "A", order: 0 }),
      makeControl({ id: "c-3", name: "B", order: 1 }),
    ]);

    expect(getAllControls().map((c) => c.name)).toEqual(["A", "B", "C"]);
  });

  it("getControlByName matches case-insensitively", async () => {
    await seedControls([makeControl({ id: "c-1", name: "Rate" })]);

    expect(getControlByName("rAtE")?.id).toBe("c-1");
    expect(getControlByName("RATE")?.id).toBe("c-1");
    expect(getControlByName("nope")).toBeUndefined();
  });
});

// ============================================================================
// CRUD operations
// ============================================================================

describe("createControlAsync", () => {
  it("creates control, refreshes cache, and dispatches CONTROL_CREATED", async () => {
    const newControl = makeControl({ id: "c-5", name: "Rate" });
    mockCreatePaneControl.mockResolvedValue(newControl);
    mockGetAllPaneControls.mockResolvedValue([newControl]);

    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    const result = await createControlAsync({
      name: "Rate",
      controlType: "slider",
      config: { type: "slider", min: 0, max: 100, step: 1, showValue: true },
    });

    expect(result).toEqual(newControl);
    expect(mockCreatePaneControl).toHaveBeenCalled();
    expect(mockGetAllPaneControls).toHaveBeenCalled();
    expect(getAllControls()).toEqual([newControl]);
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "controlspane:control-created" }),
    );

    dispatchSpy.mockRestore();
  });

  it("triggers GET.CONTROLVALUE recalc for the new control's name", async () => {
    const newControl = makeControl({ id: "c-5", name: "Rate" });
    mockCreatePaneControl.mockResolvedValue(newControl);
    mockGetAllPaneControls.mockResolvedValue([newControl]);

    await createControlAsync({
      name: "Rate",
      controlType: "slider",
      config: { type: "slider", min: 0, max: 100, step: 1, showValue: true },
    });

    expect(mockRecalcControlDependents).toHaveBeenCalledWith(["Rate"]);
  });

  it("returns null on error", async () => {
    mockCreatePaneControl.mockRejectedValue(new Error("fail"));

    const result = await createControlAsync({
      name: "Rate",
      controlType: "checkbox",
      config: { type: "checkbox", label: "On?" },
    });

    expect(result).toBeNull();
    expect(mockRecalcControlDependents).not.toHaveBeenCalled();
  });
});

describe("deleteControlAsync", () => {
  beforeEach(async () => {
    await seedControls([makeControl({ id: "c-10", name: "Rate" })]);
    vi.clearAllMocks();
  });

  it("deletes control, refreshes cache, and dispatches CONTROL_DELETED", async () => {
    mockDeletePaneControl.mockResolvedValue(undefined);
    mockGetAllPaneControls.mockResolvedValue([]);

    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    const result = await deleteControlAsync("c-10");

    expect(result).toBe(true);
    expect(mockDeletePaneControl).toHaveBeenCalledWith("c-10");
    expect(getAllControls()).toEqual([]);
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "controlspane:control-deleted" }),
    );

    dispatchSpy.mockRestore();
  });

  it("triggers GET.CONTROLVALUE recalc for the deleted control's name", async () => {
    mockDeletePaneControl.mockResolvedValue(undefined);
    mockGetAllPaneControls.mockResolvedValue([]);

    await deleteControlAsync("c-10");

    // Name captured before the cache refresh dropped the control
    expect(mockRecalcControlDependents).toHaveBeenCalledWith(["Rate"]);
  });

  it("returns false on error", async () => {
    mockDeletePaneControl.mockRejectedValue(new Error("fail"));

    const result = await deleteControlAsync("c-10");

    expect(result).toBe(false);
    expect(mockRecalcControlDependents).not.toHaveBeenCalled();
  });
});

describe("updateControlAsync", () => {
  it("updates control, refreshes cache, and dispatches CONTROL_UPDATED", async () => {
    const updated = makeControl({ id: "c-1", name: "Updated" });
    mockUpdatePaneControl.mockResolvedValue(updated);
    mockGetAllPaneControls.mockResolvedValue([updated]);

    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    const result = await updateControlAsync("c-1", { name: "Updated" });

    expect(result).toEqual(updated);
    expect(mockUpdatePaneControl).toHaveBeenCalledWith("c-1", {
      name: "Updated",
    });
    expect(getAllControls()).toEqual([updated]);
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "controlspane:control-updated" }),
    );

    dispatchSpy.mockRestore();
  });

  it("rename triggers a FULL GET.CONTROLVALUE recalc (no name hint)", async () => {
    const updated = makeControl({ id: "c-1", name: "NewName" });
    mockUpdatePaneControl.mockResolvedValue(updated);
    mockGetAllPaneControls.mockResolvedValue([updated]);

    await updateControlAsync("c-1", { name: "NewName" });

    expect(mockRecalcControlDependents).toHaveBeenCalledWith(undefined);
  });

  it("non-rename update does not trigger a recalc", async () => {
    const updated = makeControl({ id: "c-1" });
    mockUpdatePaneControl.mockResolvedValue(updated);
    mockGetAllPaneControls.mockResolvedValue([updated]);

    await updateControlAsync("c-1", { order: 7 });

    expect(mockRecalcControlDependents).not.toHaveBeenCalled();
  });

  it("returns the backend error message on failure (never rejects)", async () => {
    mockUpdatePaneControl.mockRejectedValue(new Error("fail"));

    const result = await updateControlAsync("c-1", { name: "X" });

    expect(result).toEqual({ error: "fail" });
    expect(mockRecalcControlDependents).not.toHaveBeenCalled();
  });
});

// ============================================================================
// commitValue / previewValue (drag transience)
// ============================================================================

describe("commitValue", () => {
  beforeEach(async () => {
    await seedControls([makeControl({ id: "c-1", name: "Rate" })]);
    vi.clearAllMocks();
  });

  it("persists backend-side, updates cache, and fires a non-transient event", async () => {
    mockSetPaneControlValue.mockResolvedValue(undefined);
    const value: ControlValue = { kind: "number", value: 7 };
    const facade = captureValueEvents(CONTROL_VALUE_CHANGED);
    const local = captureValueEvents("controlspane:value-changed-local");

    await commitValue("c-1", value);

    expect(mockSetPaneControlValue).toHaveBeenCalledWith("c-1", value);
    expect(getControlById("c-1")?.value).toEqual(value);
    expect(facade.events).toEqual([
      { id: "c-1", name: "Rate", value, transient: false },
    ]);
    expect(local.events).toEqual([
      { id: "c-1", name: "Rate", value, transient: false },
    ]);

    facade.stop();
    local.stop();
  });

  it("triggers GET.CONTROLVALUE recalc with the control's name", async () => {
    mockSetPaneControlValue.mockResolvedValue(undefined);

    await commitValue("c-1", { kind: "number", value: 7 });

    expect(mockRecalcControlDependents).toHaveBeenCalledWith(["Rate"]);
  });

  it("does not update cache or fire events on backend error", async () => {
    mockSetPaneControlValue.mockRejectedValue(new Error("fail"));
    const facade = captureValueEvents(CONTROL_VALUE_CHANGED);

    await commitValue("c-1", { kind: "number", value: 7 });

    expect(getControlById("c-1")?.value).toEqual({ kind: "number", value: 50 });
    expect(facade.events).toEqual([]);
    expect(mockRecalcControlDependents).not.toHaveBeenCalled();

    facade.stop();
  });
});

describe("previewValue", () => {
  beforeEach(async () => {
    await seedControls([makeControl({ id: "c-1", name: "Rate" })]);
    vi.clearAllMocks();
  });

  it("fires transient events WITHOUT touching the cache (event-only, D5)", () => {
    const value: ControlValue = { kind: "number", value: 33 };
    const facade = captureValueEvents(CONTROL_VALUE_CHANGED);
    const local = captureValueEvents("controlspane:value-changed-local");

    previewValue("c-1", value);

    // The cache keeps the COMMITTED value: prop-driven consumers (cards,
    // provider snapshots) must never observe uncommitted preview frames —
    // a cache mutation here would resync SliderControl's commit baseline
    // mid-drag and swallow the pointer-up commit entirely.
    expect(getControlById("c-1")?.value).toEqual({ kind: "number", value: 50 });
    expect(facade.events).toEqual([
      { id: "c-1", name: "Rate", value, transient: true },
    ]);
    expect(local.events).toEqual([
      { id: "c-1", name: "Rate", value, transient: true },
    ]);
    // NO backend write, NO recalc — those happen once, in commitValue().
    expect(mockSetPaneControlValue).not.toHaveBeenCalled();
    expect(mockRecalcControlDependents).not.toHaveBeenCalled();

    facade.stop();
    local.stop();
  });

  it("keeps getAllControls/buildNamedControlList on the committed value mid-preview", () => {
    previewValue("c-1", { kind: "number", value: 99 });

    expect(getAllControls()[0].value).toEqual({ kind: "number", value: 50 });
    expect(buildNamedControlList()[0].value).toEqual({
      kind: "number",
      value: 50,
    });
  });

  it("is a no-op for an unknown control id", () => {
    const facade = captureValueEvents(CONTROL_VALUE_CHANGED);

    previewValue("nope", { kind: "number", value: 1 });

    expect(facade.events).toEqual([]);
    expect(mockSetPaneControlValue).not.toHaveBeenCalled();

    facade.stop();
  });

  it("drag lifecycle: preview frames then ONE commit that persists + recalcs", async () => {
    mockSetPaneControlValue.mockResolvedValue(undefined);
    const value: ControlValue = { kind: "number", value: 80 };

    // Mid-drag frames: cache stays committed, nothing persisted.
    previewValue("c-1", { kind: "number", value: 60 });
    previewValue("c-1", { kind: "number", value: 70 });
    previewValue("c-1", value);
    expect(getControlById("c-1")?.value).toEqual({ kind: "number", value: 50 });
    expect(mockSetPaneControlValue).not.toHaveBeenCalled();
    expect(mockRecalcControlDependents).not.toHaveBeenCalled();

    // Pointer-up: one backend write, cache update, one targeted recalc.
    await commitValue("c-1", value);
    expect(mockSetPaneControlValue).toHaveBeenCalledTimes(1);
    expect(mockSetPaneControlValue).toHaveBeenCalledWith("c-1", value);
    expect(getControlById("c-1")?.value).toEqual(value);
    expect(mockRecalcControlDependents).toHaveBeenCalledTimes(1);
    expect(mockRecalcControlDependents).toHaveBeenCalledWith(["Rate"]);
  });
});

// ============================================================================
// getPaneItems (merged strip)
// ============================================================================

describe("getPaneItems", () => {
  it("merge-sorts filters and controls by order with interleaving", async () => {
    mockGetAllFilters.mockReturnValue([
      makeFilter({ id: "f-1", name: "Region", order: 1 }),
      makeFilter({ id: "f-9", name: "City", order: 5 }),
    ]);
    await seedControls([
      makeControl({ id: "c-1", name: "Alpha", order: 0 }),
      makeControl({ id: "c-2", name: "Beta", order: 3 }),
    ]);

    const items = getPaneItems();

    expect(
      items.map((i) => (i.kind === "filter" ? i.filter.id : i.control.id)),
    ).toEqual(["c-1", "f-1", "c-2", "f-9"]);
    expect(items.map((i) => i.order)).toEqual([0, 1, 3, 5]);
  });

  it("breaks order ties with filters before controls", async () => {
    mockGetAllFilters.mockReturnValue([
      makeFilter({ id: "f-1", name: "Region", order: 2 }),
    ]);
    await seedControls([makeControl({ id: "c-1", name: "Alpha", order: 2 })]);

    const items = getPaneItems();

    expect(items.map((i) => i.kind)).toEqual(["filter", "control"]);
  });

  it("breaks same-kind order ties by id", async () => {
    await seedControls([
      makeControl({ id: "c-b", name: "B", order: 2 }),
      makeControl({ id: "c-a", name: "A", order: 2 }),
    ]);

    const items = getPaneItems();

    expect(
      items.map((i) => (i.kind === "control" ? i.control.id : "")),
    ).toEqual(["c-a", "c-b"]);
  });

  it("returns empty array when both families are empty", () => {
    expect(getPaneItems()).toEqual([]);
  });
});

// ============================================================================
// buildNamedControlList (@api/controlValues provider mapping)
// ============================================================================

describe("buildNamedControlList", () => {
  it("maps pane controls with value ?? undefined, before filters", async () => {
    await seedControls([
      makeControl({
        id: "c-1",
        name: "Rate",
        order: 0,
        value: { kind: "number", value: 3 },
      }),
      makeControl({
        id: "c-2",
        name: "Go",
        controlType: "button",
        config: { type: "button", label: "Go" },
        order: 1,
        value: null,
      }),
    ]);
    mockGetAllFilters.mockReturnValue([
      makeFilter({ id: "f-1", name: "Region", selectedItems: null }),
    ]);

    const list = buildNamedControlList();

    expect(list).toEqual([
      {
        id: "c-1",
        name: "Rate",
        source: "paneControl",
        controlType: "slider",
        value: { kind: "number", value: 3 },
      },
      {
        id: "c-2",
        name: "Go",
        source: "paneControl",
        controlType: "button",
        value: undefined,
      },
      {
        id: "f-1",
        name: "Region",
        source: "ribbonFilter",
        controlType: "filter",
        value: { kind: "text", value: "(All)" },
      },
    ]);
  });

  it("maps filter selections: (All) / single text / multi textList", () => {
    mockGetAllFilters.mockReturnValue([
      makeFilter({ id: "f-1", name: "All", selectedItems: null }),
      makeFilter({ id: "f-2", name: "One", selectedItems: ["Oslo"] }),
      makeFilter({ id: "f-3", name: "Many", selectedItems: ["A", "B"] }),
      makeFilter({ id: "f-4", name: "None", selectedItems: [] }),
    ]);

    const list = buildNamedControlList();

    expect(list.map((c) => c.value)).toEqual([
      { kind: "text", value: "(All)" },
      { kind: "text", value: "Oslo" },
      { kind: "textList", value: ["A", "B"] },
      { kind: "textList", value: [] },
    ]);
    expect(list.every((c) => c.source === "ribbonFilter")).toBe(true);
    expect(list.every((c) => c.controlType === "filter")).toBe(true);
  });
});

// ============================================================================
// Cache management
// ============================================================================

describe("refreshControlsCache", () => {
  it("loads all controls from backend", async () => {
    mockGetAllPaneControls.mockResolvedValue([
      makeControl({ id: "c-1" }),
      makeControl({ id: "c-2" }),
    ]);

    await refreshControlsCache();

    expect(getAllControls()).toHaveLength(2);
  });

  it("dispatches CONTROLS_REFRESHED event", async () => {
    mockGetAllPaneControls.mockResolvedValue([]);
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    await refreshControlsCache();

    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "controlspane:controls-refreshed" }),
    );
    dispatchSpy.mockRestore();
  });

  it("keeps the previous cache on error", async () => {
    await seedControls([makeControl({ id: "c-1" })]);
    mockGetAllPaneControls.mockRejectedValue(new Error("fail"));

    await refreshControlsCache();

    expect(getAllControls()).toHaveLength(1);
  });
});

describe("clearControlsCache", () => {
  it("clears all cached data", async () => {
    await seedControls([makeControl({ id: "c-1" })]);

    clearControlsCache();

    expect(getAllControls()).toEqual([]);
    expect(getControlById("c-1")).toBeUndefined();
  });
});
