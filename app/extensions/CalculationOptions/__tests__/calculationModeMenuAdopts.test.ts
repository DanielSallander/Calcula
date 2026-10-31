//! FILENAME: app/extensions/CalculationOptions/__tests__/calculationModeMenuAdopts.test.ts
// PURPOSE: The Formulas menu's Automatic / Manual checkmark shows the mode the
//          BACKEND answered as in effect, not merely the last one clicked.
// CONTEXT: Round-13 fix lane "whatif3" (2026-10-30). The menu set its checkmark
//          from the click and ignored `setCalculationMode`'s answer, so when the
//          two differed (another switch, a script's, applied last) the
//          checkmark said one mode while the workbook calculated in the other.

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

import { registerCalculationMenuItems, getMenuCalculationMode } from "../handlers/formulasMenuItemBuilder";

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

describe("Calculation Options checkmark", () => {
  it("shows the mode the backend says is in effect", async () => {
    registerCalculationMenuItems();
    const manual = find(h.items, "formulas:calcOptions:manual");
    const automatic = find(h.items, "formulas:calcOptions:automatic");
    expect(manual?.action).toBeTypeOf("function");
    expect(automatic?.action).toBeTypeOf("function");

    // Manual clicked, but the switch applied after it left Automatic in effect.
    h.setCalculationMode.mockResolvedValueOnce("automatic");
    manual!.action!();
    expect(getMenuCalculationMode()).toBe("manual");
    await flush();
    expect(getMenuCalculationMode(), "the checkmark kept the click, not the mode in effect").toBe("automatic");

    h.setCalculationMode.mockResolvedValueOnce("manual");
    automatic!.action!();
    await flush();
    expect(getMenuCalculationMode()).toBe("manual");
  });
});
