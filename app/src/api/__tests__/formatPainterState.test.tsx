//! FILENAME: app/src/api/__tests__/formatPainterState.test.tsx
// PURPOSE: @api/formatPainterState -- the one place any surface asks "is the
//          Format Painter on, and is it locked?" -- publishes the painter's
//          state to every reader, announces only real transitions, and binds
//          to React.
// CONTEXT: Home tab = Excel's Home tab (contract 6.6, 2026-10-04). Excel draws
//          the Format Painter button PRESSED while the painter is armed (and
//          keeps it pressed while it is locked by a double-click). The state
//          lived inside the FormatPainter extension (`isFormatPainterActive`)
//          with no event and no @api route, so the ribbon could not show it.
//          Modelled on @api/undoState: one cached answer, many readers.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  getFormatPainterState,
  subscribeToFormatPainterState,
  publishFormatPainterState,
  useFormatPainterState,
  resetFormatPainterStateForTests,
  type FormatPainterState,
} from "../formatPainterState";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

beforeEach(() => {
  resetFormatPainterStateForTests();
});

describe("the store", () => {
  it("starts OFF: not active, not locked", () => {
    expect(getFormatPainterState()).toEqual({ active: false, locked: false });
  });

  it("a publish is read back and announced to every subscriber", () => {
    const a: FormatPainterState[] = [];
    const b: FormatPainterState[] = [];
    subscribeToFormatPainterState((s) => a.push(s));
    subscribeToFormatPainterState((s) => b.push(s));
    publishFormatPainterState({ active: true, locked: false });
    publishFormatPainterState({ active: true, locked: true });
    publishFormatPainterState({ active: false, locked: false });
    const expected = [
      { active: true, locked: false },
      { active: true, locked: true },
      { active: false, locked: false },
    ];
    expect(a).toEqual(expected);
    expect(b).toEqual(expected);
    expect(getFormatPainterState()).toEqual({ active: false, locked: false });
  });

  it("only a real transition is announced (a repeat of the same state is silent)", () => {
    const seen = vi.fn();
    subscribeToFormatPainterState(seen);
    publishFormatPainterState({ active: true, locked: false });
    publishFormatPainterState({ active: true, locked: false });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("locked without active is not a state: a lock is only ever on an armed painter", () => {
    publishFormatPainterState({ active: false, locked: true });
    expect(getFormatPainterState()).toEqual({ active: false, locked: false });
  });

  it("unsubscribe stops the announcements", () => {
    const seen = vi.fn();
    const off = subscribeToFormatPainterState(seen);
    off();
    publishFormatPainterState({ active: true, locked: false });
    expect(seen).not.toHaveBeenCalled();
  });

  it("a subscriber that throws does not stop the others", () => {
    const seen = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    subscribeToFormatPainterState(() => {
      throw new Error("boom");
    });
    subscribeToFormatPainterState(seen);
    publishFormatPainterState({ active: true, locked: true });
    expect(seen).toHaveBeenCalledWith({ active: true, locked: true });
  });
});

describe("useFormatPainterState", () => {
  let root: Root;
  let host: HTMLDivElement;
  let rendered: FormatPainterState[] = [];

  function Probe(): React.ReactElement {
    const state = useFormatPainterState();
    rendered.push(state);
    return <div data-active={String(state.active)} data-locked={String(state.locked)} />;
  }

  beforeEach(async () => {
    rendered = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("renders the current state and re-renders on every transition", async () => {
    publishFormatPainterState({ active: true, locked: false });
    await act(async () => root.render(<Probe />));
    const el = () => host.firstElementChild as HTMLElement;
    expect(el().dataset.active).toBe("true");
    expect(el().dataset.locked).toBe("false");
    await act(async () => publishFormatPainterState({ active: true, locked: true }));
    expect(el().dataset.locked).toBe("true");
    await act(async () => publishFormatPainterState({ active: false, locked: false }));
    expect(el().dataset.active).toBe("false");
  });
});
