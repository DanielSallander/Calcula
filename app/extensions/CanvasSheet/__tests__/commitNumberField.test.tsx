//! FILENAME: app/extensions/CanvasSheet/__tests__/commitNumberField.test.tsx
// PURPOSE: The canvas tab's number boxes commit ONE value at the end (blur,
//          Enter, an arrow step) instead of one per keystroke: typing 25 into
//          Grid size must not send 2 (below the minimum) on the way.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CommitNumberField, commitValue } from "../components/CommitNumberField";

describe("commitValue (pure)", () => {
  it("rounds, clamps, and has nothing to commit for a blank draft", () => {
    expect(commitValue(24.6, 4, 200)).toBe(25);
    expect(commitValue(2, 4, 200)).toBe(4);
    expect(commitValue(9999, 4, 200)).toBe(200);
    expect(commitValue(null, 4, 200)).toBeNull();
  });
});

describe("the rendered field", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function input(): HTMLInputElement {
    const el = container.querySelector("input");
    if (!el) throw new Error("no input");
    return el;
  }

  /** Type `text` the way React sees it: set the native value, fire input. */
  function type(text: string): void {
    const el = input();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("typing reports nothing; leaving the box commits once, clamped", () => {
    const onCommit = vi.fn();
    act(() => root.render(<CommitNumberField value={16} min={4} max={200} onCommit={onCommit} ariaLabel="Grid size" />));
    act(() => input().focus());
    type("2");
    type("25");
    expect(onCommit).not.toHaveBeenCalled();
    act(() => input().blur());
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(25);
  });

  it("a value below the minimum commits as the minimum, never as the typed value", () => {
    const onCommit = vi.fn();
    act(() => root.render(<CommitNumberField value={16} min={4} max={200} onCommit={onCommit} ariaLabel="Grid size" />));
    act(() => input().focus());
    type("2");
    act(() => input().blur());
    expect(onCommit).toHaveBeenCalledWith(4);
  });

  it("Enter commits without leaving the box; an unchanged value commits nothing", () => {
    const onCommit = vi.fn();
    act(() => root.render(<CommitNumberField value={16} min={4} max={200} onCommit={onCommit} ariaLabel="Grid size" />));
    act(() => input().focus());
    type("32");
    act(() => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onCommit).toHaveBeenCalledWith(32);
    onCommit.mockClear();
    type("16");
    act(() => input().blur());
    expect(onCommit).not.toHaveBeenCalled();
  });
});
