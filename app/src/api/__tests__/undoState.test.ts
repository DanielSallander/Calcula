//! FILENAME: app/src/api/__tests__/undoState.test.ts
// PURPOSE: The shared "can the user undo right now?" store.
// CONTEXT: Two surfaces read it (the Home tab's buttons and the Edit menu's
//          items), so the property that matters most is that they cannot
//          disagree — one subscription, one cached answer.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getUndoState = vi.fn();

vi.mock("../lib", () => ({
  getUndoState: (...args: unknown[]) => getUndoState(...args),
}));

import {
  getUndoAvailability,
  subscribeToUndoAvailability,
  resetUndoAvailabilityForTests,
} from "../undoState";
import { AppEvents, emitAppEvent } from "../events";

beforeEach(() => {
  getUndoState.mockReset();
  getUndoState.mockResolvedValue({ canUndo: false, canRedo: false });
  resetUndoAvailabilityForTests();
});

afterEach(() => {
  resetUndoAvailabilityForTests();
});

describe("undo availability store", () => {
  it("starts OPTIMISTIC, so nothing is greyed out before the first answer", () => {
    // The pre-existing behaviour is "always enabled". Starting from `false`
    // would mean a window that never reaches the backend renders an app whose
    // Undo can never be pressed — strictly worse than the defect being fixed.
    expect(getUndoAvailability()).toEqual({ canUndo: true, canRedo: true });
  });

  it("seeds from get_undo_state on the FIRST subscriber", async () => {
    const seen: unknown[] = [];
    subscribeToUndoAvailability((a) => seen.push(a));
    await vi.waitFor(() => expect(seen.length).toBe(1));

    // A subscriber that mounts BETWEEN transitions has no event to learn from,
    // so without the seed it would render the optimistic guess forever.
    expect(seen).toEqual([{ canUndo: false, canRedo: false }]);
    expect(getUndoState).toHaveBeenCalledTimes(1);
  });

  it("seeds ONCE however many subscribers arrive", async () => {
    subscribeToUndoAvailability(() => undefined);
    subscribeToUndoAvailability(() => undefined);
    subscribeToUndoAvailability(() => undefined);
    await vi.waitFor(() => expect(getUndoState).toHaveBeenCalledTimes(1));
  });

  it("follows the backend announcement", async () => {
    const seen: Array<{ canUndo: boolean; canRedo: boolean }> = [];
    subscribeToUndoAvailability((a) => seen.push(a));
    await vi.waitFor(() => expect(seen.length).toBe(1));

    emitAppEvent(AppEvents.UNDO_STATE_CHANGED, { canUndo: true, canRedo: false });
    expect(getUndoAvailability()).toEqual({ canUndo: true, canRedo: false });

    emitAppEvent(AppEvents.UNDO_STATE_CHANGED, { canUndo: false, canRedo: true });
    expect(getUndoAvailability()).toEqual({ canUndo: false, canRedo: true });
  });

  it("does not re-notify when the announcement changes nothing", async () => {
    const seen: unknown[] = [];
    subscribeToUndoAvailability((a) => seen.push(a));
    await vi.waitFor(() => expect(seen.length).toBe(1));

    emitAppEvent(AppEvents.UNDO_STATE_CHANGED, { canUndo: false, canRedo: false });
    emitAppEvent(AppEvents.UNDO_STATE_CHANGED, { canUndo: false, canRedo: false });
    expect(seen.length).toBe(1);
  });

  it("gives every subscriber the SAME answer — the ribbon cannot disagree with the menu", async () => {
    const ribbon: Array<{ canUndo: boolean }> = [];
    const menu: Array<{ canUndo: boolean }> = [];
    subscribeToUndoAvailability((a) => ribbon.push(a));
    subscribeToUndoAvailability((a) => menu.push(a));
    await vi.waitFor(() => expect(ribbon.length).toBe(1));

    emitAppEvent(AppEvents.UNDO_STATE_CHANGED, { canUndo: true, canRedo: false });
    expect(ribbon).toEqual(menu);
  });

  it("drops the bus listener with the last subscriber", async () => {
    const seen: unknown[] = [];
    const off = subscribeToUndoAvailability((a) => seen.push(a));
    await vi.waitFor(() => expect(seen.length).toBe(1));
    off();

    emitAppEvent(AppEvents.UNDO_STATE_CHANGED, { canUndo: true, canRedo: true });
    expect(seen.length).toBe(1);
  });

  it("stays OPTIMISTIC when the backend read fails", async () => {
    getUndoState.mockRejectedValue(new Error("no backend"));
    const seen: unknown[] = [];
    subscribeToUndoAvailability((a) => seen.push(a));
    await vi.waitFor(() => expect(getUndoState).toHaveBeenCalledTimes(1));

    expect(seen).toEqual([]);
    expect(getUndoAvailability()).toEqual({ canUndo: true, canRedo: true });
  });

  it("fails OPEN on a malformed announcement", async () => {
    subscribeToUndoAvailability(() => undefined);
    await vi.waitFor(() => expect(getUndoState).toHaveBeenCalledTimes(1));

    emitAppEvent(AppEvents.UNDO_STATE_CHANGED, undefined);
    expect(getUndoAvailability()).toEqual({ canUndo: true, canRedo: true });
  });
});
