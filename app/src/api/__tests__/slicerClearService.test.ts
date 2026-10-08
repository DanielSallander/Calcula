//! FILENAME: app/src/api/__tests__/slicerClearService.test.ts
// PURPOSE: @api/slicerClearService -- the seam a "Clear all slicers" button
//          reaches the slicer families through (Canvas contract §4.4). Pins:
//          every registered family is asked for the SAME sheet and the counts
//          add up; one family failing does not stop the others, and the failure
//          is still said; with no family registered the call refuses loudly
//          instead of reporting "0 cleared" as if it had worked.

import { describe, it, expect, beforeEach } from "vitest";
import {
  clearSlicersOnSheet,
  hasSlicerClearProvider,
  registerSlicerClearProvider,
  resetSlicerClearProviders,
} from "../slicerClearService";

beforeEach(() => resetSlicerClearProviders());

describe("clearSlicersOnSheet", () => {
  it("refuses when no slicer family is registered", async () => {
    expect(hasSlicerClearProvider()).toBe(false);
    await expect(clearSlicersOnSheet(2)).rejects.toThrow(/no slicer/i);
  });

  it("asks every registered family about the same sheet and adds the counts", async () => {
    const asked: Array<[string, number]> = [];
    registerSlicerClearProvider({
      clearSlicersOnSheet: async (s) => {
        asked.push(["slicer", s]);
        return 2;
      },
    });
    registerSlicerClearProvider({
      clearSlicersOnSheet: async (s) => {
        asked.push(["timeline", s]);
        return 1;
      },
    });
    expect(await clearSlicersOnSheet(4)).toBe(3);
    expect(asked).toEqual([
      ["slicer", 4],
      ["timeline", 4],
    ]);
  });

  // SABOTAGE: rethrow the first failure inside the loop -> the timeline is
  // never cleared.
  it("runs every family even when one fails, then says the failure", async () => {
    const ran: string[] = [];
    registerSlicerClearProvider({
      clearSlicersOnSheet: async () => {
        ran.push("a");
        throw new Error("the model is offline");
      },
    });
    registerSlicerClearProvider({
      clearSlicersOnSheet: async () => {
        ran.push("b");
        return 1;
      },
    });
    await expect(clearSlicersOnSheet(0)).rejects.toThrow("the model is offline");
    expect(ran).toEqual(["a", "b"]);
  });

  it("unregisters only what it registered", async () => {
    const off = registerSlicerClearProvider({ clearSlicersOnSheet: async () => 1 });
    expect(hasSlicerClearProvider()).toBe(true);
    off();
    off();
    expect(hasSlicerClearProvider()).toBe(false);
  });
});
