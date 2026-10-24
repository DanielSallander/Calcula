//! FILENAME: app/src/shell/Toast/__tests__/toastDismissHandle.test.ts
// PURPOSE: Through the REAL Shell store: showToast's handle takes its own card
//          off the screen, leaves every other card alone, and does nothing once
//          the card is gone.
// CONTEXT: Review round 9, F4. The Shell's sink returns the id addToast gave
//          the card and registers removeToast as the dismisser, so a notice
//          that is true only while a condition lasts (AutoRecover skipping
//          recovery copies) can be taken back when it ends.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { showToast } from "@api/notifications";
import { useToastStore } from "../useToastStore";

const messages = (): string[] => useToastStore.getState().toasts.map((t) => t.message);

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  vi.useRealTimers();
  useToastStore.setState({ toasts: [] });
});

describe("a toast's handle, through the Shell's store", () => {
  // SABOTAGE: register the Shell's sink without its dismisser, or make
  // addToast return nothing -- dismiss() then leaves the card up.
  it("dismiss() takes that card down and no other", () => {
    const keep = showToast("stays", { duration: 0 });
    const card = showToast("AutoRecover is skipping recovery copies", { type: "warning", duration: 0 });
    expect(messages()).toEqual(["stays", "AutoRecover is skipping recovery copies"]);
    card.dismiss();
    expect(messages(), "the card outlived its dismiss").toEqual(["stays"]);
    card.dismiss();
    expect(messages(), "a second dismiss took another card").toEqual(["stays"]);
    keep.dismiss();
    expect(messages()).toEqual([]);
  });

  it("a card that already timed out: dismiss() does nothing, and a later card is untouched", () => {
    vi.useFakeTimers();
    const brief = showToast("brief", { duration: 1_000 });
    vi.advanceTimersByTime(1_000);
    expect(messages()).toEqual([]);
    showToast("later", { duration: 0 });
    brief.dismiss();
    expect(messages()).toEqual(["later"]);
  });

  it("a card the user pressed OK on: dismiss() does nothing", () => {
    const card = showToast("pressed", { duration: 0 });
    const id = useToastStore.getState().toasts[0].id;
    useToastStore.getState().removeToast(id);
    showToast("next", { duration: 0 });
    card.dismiss();
    expect(messages()).toEqual(["next"]);
  });
});
