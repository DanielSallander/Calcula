//! FILENAME: app/src/api/__tests__/selectionOwnershipChanges.test.ts
// PURPOSE: onSelectionOwnershipChanged announces a selection owner's claim
//          STARTING and ENDING -- once per real change, never for a prompt
//          that changed nothing -- from the feature-neutral prompts that can
//          change it: an object selection changing, the active sheet changing,
//          an owner arriving or leaving, or an owner saying so itself.
// CONTEXT: W22 (wave C). The claim is a predicate asked at the moment of use
//          (core/lib/selectionOwner.ts), so nothing announced it, and a
//          surface that follows Core's selection (the Table Design and
//          Sparkline Design tabs) could not stand aside while a floating
//          grid's cell held the selection: Core's selection never moved.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  notifySelectionOwnershipChanged,
  onSelectionOwnershipChanged,
  registerSelectionOwner,
  isSelectionOwned,
} from "../selectionOwner";
import { notifyObjectSelectionChanged } from "../objectSelection";
import { emitAppEvent, AppEvents } from "../events";

let owns = false;
let release: () => void = () => {};
let off: () => void = () => {};
const heard = vi.fn();

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await Promise.resolve();
}

beforeEach(() => {
  owns = false;
  heard.mockReset();
  release = registerSelectionOwner({ id: "ownership-test", label: "the test object's cells", ownsSelection: () => owns });
  off = onSelectionOwnershipChanged(heard);
});

afterEach(() => {
  off();
  release();
});

describe("onSelectionOwnershipChanged", () => {
  it("an object-selection change that starts the claim, then one that ends it: true, then false", async () => {
    owns = true;
    notifyObjectSelectionChanged();
    await settle();
    expect(heard.mock.calls).toEqual([[true]]);
    owns = false;
    notifyObjectSelectionChanged();
    await settle();
    expect(heard.mock.calls).toEqual([[true], [false]]);
  });

  it("a prompt that changed nothing is silent", async () => {
    notifyObjectSelectionChanged();
    notifySelectionOwnershipChanged();
    emitAppEvent(AppEvents.SHEET_CHANGED, {});
    await settle();
    expect(heard).not.toHaveBeenCalled();
  });

  it("many prompts in one turn are asked ONCE", async () => {
    let asked = 0;
    owns = true;
    const counted = registerSelectionOwner({
      id: "ownership-counter",
      label: "a counter",
      ownsSelection: () => {
        asked++;
        return false;
      },
    });
    await settle();
    heard.mockReset();
    asked = 0;
    try {
      owns = false;
      for (let i = 0; i < 5; i++) notifyObjectSelectionChanged();
      notifySelectionOwnershipChanged();
      await settle();
      expect(heard.mock.calls).toEqual([[false]]);
      expect(asked, "the claim was asked once per prompt, not once per turn").toBeLessThanOrEqual(1);
    } finally {
      counted();
    }
  });

  it("the active sheet changing is a prompt (an owner claims on ITS sheet only)", async () => {
    owns = true;
    emitAppEvent(AppEvents.SHEET_CHANGED, {});
    await settle();
    expect(heard.mock.calls).toEqual([[true]]);
  });

  it("an owner arriving already owning, and leaving, are prompts", async () => {
    const leave = registerSelectionOwner({ id: "ownership-arrival", label: "x", ownsSelection: () => true });
    await settle();
    expect(heard.mock.calls).toEqual([[true]]);
    leave();
    await settle();
    expect(heard.mock.calls).toEqual([[true], [false]]);
    expect(isSelectionOwned()).toBe(false);
  });

  it("an owner that announces nothing else can say so itself", async () => {
    owns = true;
    notifySelectionOwnershipChanged();
    await settle();
    expect(heard.mock.calls).toEqual([[true]]);
  });

  it("after unsubscribe nothing is heard", async () => {
    off();
    owns = true;
    notifyObjectSelectionChanged();
    await settle();
    expect(heard).not.toHaveBeenCalled();
  });
});
