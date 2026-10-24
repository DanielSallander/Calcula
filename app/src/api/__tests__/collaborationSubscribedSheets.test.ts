//! FILENAME: app/src/api/__tests__/collaborationSubscribedSheets.test.ts
// PURPOSE: @api/collaboration's subscribed-sheets registry: the one SYNC
//          "is this sheet subscribed?" answer Charts, Pivot and CanvasSheet
//          gate authoring on. No provider = false; a provider answers; the
//          unregister clears only the provider it registered (floatingRangeService's
//          register/get discipline); the barrel re-exports it.
// CONTEXT: docs/design/model-drillthrough.md 2.9 (read-only on a subscribed sheet).

import { describe, it, expect, beforeEach } from "vitest";
import {
  isSheetSubscribed,
  registerSubscribedSheetsProvider,
  resetSubscribedSheetsProvider,
  type SubscribedSheetsProvider,
} from "../collaboration";

const only = (...ids: string[]): SubscribedSheetsProvider => ({ isSubscribed: (id) => ids.includes(id) });

beforeEach(() => {
  resetSubscribedSheetsProvider();
});

describe("isSheetSubscribed", () => {
  it("is false with no provider, and false for an empty id whatever the provider says", () => {
    // SABOTAGE: default to true -- every worksheet object goes read-only in a
    // workbook that has no Collaboration extension loaded.
    expect(isSheetSubscribed("S1")).toBe(false);
    registerSubscribedSheetsProvider({ isSubscribed: () => true });
    expect(isSheetSubscribed("")).toBe(false);
  });

  it("answers through the registered provider", () => {
    registerSubscribedSheetsProvider(only("S1", "S2"));
    expect(isSheetSubscribed("S1")).toBe(true);
    expect(isSheetSubscribed("S3")).toBe(false);
  });

  it("the unregister clears the provider only while it is still the live one; the last registration wins", () => {
    const first = only("A");
    const second = only("B");
    const offFirst = registerSubscribedSheetsProvider(first);
    registerSubscribedSheetsProvider(second);
    expect(isSheetSubscribed("B")).toBe(true);
    offFirst(); // the OLD cleanup running late must not blank the live provider
    expect(isSheetSubscribed("B")).toBe(true);
    registerSubscribedSheetsProvider(second)();
    expect(isSheetSubscribed("B")).toBe(false);
  });

  it("a provider that answers something other than true is false", () => {
    registerSubscribedSheetsProvider({ isSubscribed: () => undefined as unknown as boolean });
    expect(isSheetSubscribed("S1")).toBe(false);
  });
});

describe("the @api barrel", () => {
  it("re-exports the seam as the same live registry", async () => {
    const barrel = await import("../index");
    expect(barrel.registerSubscribedSheetsProvider).toBe(registerSubscribedSheetsProvider);
    expect(barrel.isSheetSubscribed).toBe(isSheetSubscribed);
    barrel.registerSubscribedSheetsProvider(only("Z"));
    expect(isSheetSubscribed("Z")).toBe(true);
  });
});
