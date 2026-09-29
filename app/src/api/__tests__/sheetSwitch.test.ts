/**
 * FILENAME: app/src/api/__tests__/sheetSwitch.test.ts
 * PURPOSE: `activateSheet` is the ONE sheet-switch door for extensions, and it
 *          is a tab click step for step: beforeSwitch, the backend switch
 *          AWAITED, the prime, Core's sheet context (with the sheet's own
 *          surface), normalSwitch, SHEET_CHANGED -- in that order.
 *
 * CONTEXT: Cell Bookmarks fired the switch without awaiting the backend.
 * SheetTabs re-reads the sheet list on SHEET_CHANGED; answered before the switch
 * landed, that read reported the OLD sheet active and dispatched it back, so a
 * jump from a canvas left the backend on the bookmark's sheet and the grid on
 * the canvas (found live 2026-09-29, e2e fixall-edit X16). The Application
 * Explorer, Go To (Tracing), the CSV import and a notebook's Send to grid
 * switched the BACKEND only. And none fired normalSwitch, which is what refetches
 * the new sheet's cells and restores its selection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as string[],
  releaseBackend: (() => {}) as () => void,
  backendResult: {
    activeIndex: 2,
    sheets: [
      { index: 0, name: "Sheet1", kind: "worksheet" },
      { index: 1, name: "Sheet2", kind: "worksheet" },
      { index: 2, name: "Canvas1", kind: "canvas" },
    ],
  },
}));

vi.mock("../../core/lib/tauri-api", () => ({
  setActiveSheet: (index: number) => {
    h.calls.push(`backend:${index}`);
    return new Promise((resolve) => {
      h.releaseBackend = () => {
        h.calls.push("backend:landed");
        resolve(h.backendResult);
      };
    });
  },
}));
vi.mock("../../core/lib/sheetSwitchPrefetch", () => ({
  primeSheetSwitch: async (index: number) => {
    h.calls.push(`prime:${index}`);
  },
}));
vi.mock("../../core/state/GridContext", () => ({
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" } }),
}));
vi.mock("../gridDispatch", () => ({
  dispatchGridAction: (action: { type: string; payload: unknown }) => {
    h.calls.push(`dispatch:${JSON.stringify(action.payload)}`);
  },
}));
vi.mock("../events", () => ({
  AppEvents: { SHEET_CHANGED: "app:sheet-changed" },
  emitAppEvent: (name: string, detail: unknown) => {
    h.calls.push(`emit:${name}:${JSON.stringify(detail)}`);
  },
}));

import { activateSheet } from "../sheetSwitch";

const onBefore = (e: Event) => h.calls.push(`before:${JSON.stringify((e as CustomEvent).detail)}`);
const onNormal = (e: Event) => h.calls.push(`normal:${JSON.stringify((e as CustomEvent).detail)}`);

beforeEach(() => {
  h.calls.length = 0;
  h.backendResult.activeIndex = 2;
  window.addEventListener("sheet:beforeSwitch", onBefore);
  window.addEventListener("sheet:normalSwitch", onNormal);
});
afterEach(() => {
  window.removeEventListener("sheet:beforeSwitch", onBefore);
  window.removeEventListener("sheet:normalSwitch", onNormal);
});

async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("activateSheet", () => {
  it("is a tab click step for step, and nothing visible moves until the backend has switched", async () => {
    const pending = activateSheet(2);
    await drain();
    expect(h.calls.map((c) => c.split(":")[0])).toEqual(["before", "backend"]);

    h.releaseBackend();
    await pending;
    expect(h.calls.map((c) => c.split(":")[0])).toEqual([
      "before",
      "backend",
      "backend",
      "prime",
      "dispatch",
      "normal",
      "emit",
    ]);
    expect(h.calls[0]).toBe('before:{"oldSheetIndex":0,"newSheetIndex":2}');
    expect(h.calls[2]).toBe("backend:landed");
  });

  it("gives Core the surface of the sheet the backend reports, so a canvas opens as a canvas", async () => {
    const pending = activateSheet(2);
    h.releaseBackend();
    await pending;
    const dispatch = h.calls.find((c) => c.startsWith("dispatch:"))!;
    expect(dispatch).toContain('"index":2');
    expect(dispatch).toContain('"name":"Canvas1"');
    expect(dispatch).toContain('"surface":"canvas"');
    expect(h.calls.find((c) => c.startsWith("normal:"))).toBe('normal:{"newSheetIndex":2,"newSheetName":"Canvas1"}');
    expect(h.calls.find((c) => c.startsWith("emit:"))).toContain('"sheetIndex":2');
  });

  it("follows the backend's answer, not the request, when they differ", async () => {
    h.backendResult.activeIndex = 1;
    const pending = activateSheet(2);
    h.releaseBackend();
    await pending;
    const dispatch = h.calls.find((c) => c.startsWith("dispatch:"))!;
    expect(dispatch).toContain('"index":1');
    expect(dispatch).toContain('"name":"Sheet2"');
    expect(dispatch).toContain('"surface":"grid"');
    expect(h.calls).toContain("prime:1");
  });
});
