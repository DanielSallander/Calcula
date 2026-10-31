//! FILENAME: app/extensions/CalculationOptions/__tests__/calculationModeAfterOpen.test.ts
// PURPOSE: An opened .xlsx sets the calculation mode (the backend's
//          adopt_xlsx_calculation_mode, Excel's rule for the first workbook
//          opened), so the Formulas > Calculation Options check marks must be
//          re-read after every open -- not only once at activation, which left
//          "Automatic" checked over a workbook that had just made calculation
//          manual.

import { describe, it, expect, beforeEach, vi } from "vitest";

const appEventHandlers = new Map<string, Array<() => void>>();
const onAppEvent = vi.fn((event: string, handler: () => void) => {
  const list = appEventHandlers.get(event) ?? [];
  list.push(handler);
  appEventHandlers.set(event, list);
  return () => {
    appEventHandlers.set(
      event,
      (appEventHandlers.get(event) ?? []).filter((h) => h !== handler),
    );
  };
});

vi.mock("@api", () => ({
  registerStatusBarItem: vi.fn(),
  unregisterStatusBarItem: vi.fn(),
  onAppEvent: (...a: unknown[]) => onAppEvent(...(a as [string, () => void])),
  AppEvents: { AFTER_OPEN: "app:after-open" },
}));

const syncCalculationMode = vi.fn(async () => {});
vi.mock("../handlers/formulasMenuItemBuilder", () => ({
  registerCalculationMenuItems: vi.fn(() => () => {}),
  syncCalculationMode: () => syncCalculationMode(),
}));

vi.mock("../components/CalculationStatusItem", () => ({
  CalculationStatusItem: () => null,
}));

import extension from "../index";

function fire(event: string): void {
  for (const handler of appEventHandlers.get(event) ?? []) handler();
}

describe("calculation mode after an open", () => {
  beforeEach(() => {
    appEventHandlers.clear();
    syncCalculationMode.mockClear();
  });

  it("re-reads the backend's calculation mode after every open", () => {
    extension.activate({} as never);
    expect(syncCalculationMode).toHaveBeenCalledTimes(1);
    fire("app:after-open");
    expect(syncCalculationMode).toHaveBeenCalledTimes(2);
    fire("app:after-open");
    expect(syncCalculationMode).toHaveBeenCalledTimes(3);
    extension.deactivate?.();
  });

  it("stops listening when deactivated, and a re-activation listens once", () => {
    extension.activate({} as never);
    extension.activate({} as never);
    syncCalculationMode.mockClear();
    fire("app:after-open");
    expect(syncCalculationMode).toHaveBeenCalledTimes(1);
    extension.deactivate?.();
    fire("app:after-open");
    expect(syncCalculationMode).toHaveBeenCalledTimes(1);
  });
});
