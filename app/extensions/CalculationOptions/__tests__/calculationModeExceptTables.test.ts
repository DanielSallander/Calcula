//! FILENAME: app/extensions/CalculationOptions/__tests__/calculationModeExceptTables.test.ts
// PURPOSE: BUG-0754 -- Formulas > Calculation Options offers Excel's three modes,
//          Automatic, Automatic Except for Data Tables and Manual, in Excel's
//          order; the new item sends "automaticExceptTables" and its checkmark
//          follows the mode in effect, the one read at activation included.
// SABOTAGE: drop exceptTablesItem from the submenu children -- fails at
//          "NO ITEM".

import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({
  items: [] as unknown[],
  setCalculationMode: vi.fn(),
}));

vi.mock("@api", () => ({
  registerMenuItem: (_menu: string, item: unknown) => h.items.push(item),
  unregisterMenuItem: vi.fn(),
  cellEvents: { emit: vi.fn(), emitBatch: vi.fn() },
  emitAppEvent: vi.fn(),
  AppEvents: { GRID_REFRESH: "grid:refresh" },
  IconCalcOptions: null,
  IconCalculate: null,
  IconAutomatic: null,
  IconManual: null,
  IconCalcWorkbook: null,
  IconCalcWorksheet: null,
  IconIteration: null,
  IconOtherOptions: null,
  IconPrecision: null,
  IconCalcBeforeSave: null,
}));
vi.mock("@api/lib", () => ({
  setCalculationMode: (...a: unknown[]) => h.setCalculationMode(...a),
  getCalculationMode: vi.fn(async () => "automatic"),
  calculateNow: vi.fn(async () => []),
  calculateSheet: vi.fn(async () => []),
  getIterationSettings: vi.fn(async () => ({ enabled: false, maxIterations: 100, maxChange: 0.001 })),
  setIterationSettings: vi.fn(async () => undefined),
  getPrecisionAsDisplayed: vi.fn(async () => false),
  setPrecisionAsDisplayed: vi.fn(async () => undefined),
  getCalculateBeforeSave: vi.fn(async () => true),
  setCalculateBeforeSave: vi.fn(async () => undefined),
}));
vi.mock("@api/dialogs", () => ({
  promptAsync: vi.fn(async () => null),
  alertAsync: vi.fn(async () => undefined),
  confirmAsync: vi.fn(async () => false),
}));
vi.mock("@api/locale", () => ({
  formatNumber: (n: number) => String(n),
  parseNumber: (t: string) => Number(t),
}));

import { registerCalculationMenuItems, getMenuCalculationMode, adoptModeInEffect } from "../handlers/formulasMenuItemBuilder";

type Item = { id?: string; action?: () => void; children?: Item[] };

function find(items: unknown[], id: string): Item | undefined {
  for (const raw of items) {
    const item = raw as Item;
    if (item.id === id) return item;
    const inner = item.children ? find(item.children, id) : undefined;
    if (inner) return inner;
  }
  return undefined;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("Automatic Except for Data Tables", () => {
  it("is Excel's middle item and switches to its mode", async () => {
    registerCalculationMenuItems();
    const options = find(h.items, "formulas:calcOptions") as { children?: Item[] } | undefined;
    const ids = (options?.children ?? []).map((c) => c.id).slice(0, 3);
    expect(ids, "NO ITEM").toEqual([
      "formulas:calcOptions:automatic",
      "formulas:calcOptions:automaticExceptTables",
      "formulas:calcOptions:manual",
    ]);
    const item = find(h.items, "formulas:calcOptions:automaticExceptTables") as (Item & { label?: string; checked?: boolean }) | undefined;
    expect(item?.label).toBe("Automatic Except for Data Tables");
    h.setCalculationMode.mockResolvedValueOnce("automaticExceptTables");
    item!.action!();
    await flush();
    expect(h.setCalculationMode).toHaveBeenLastCalledWith("automaticExceptTables");
    expect(getMenuCalculationMode()).toBe("automaticExceptTables");
    expect(item!.checked).toBe(true);
    adoptModeInEffect("manual");
    expect(item!.checked).toBe(false);
  });
});
