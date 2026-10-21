//! FILENAME: app/extensions/_shared/components/__tests__/useNativeColorPick.test.tsx
// PURPOSE: Pins the shared OS colour-picker hook, rule by rule (P1 spec 2.1 (a)-(g)).
// CONTEXT: Round 2, owner finding G1 "chart background colour does nothing". The
//          probe that proved it (r2/probe/colorbox.probe.test.tsx) drove the
//          Object pane's ColorBox the way Chromium drives a colour input: set the
//          value, fire `input`, then `change`. The controlled picker's React
//          restore wrote the OLD colour back, so the `change` saw "same colour"
//          and committed nothing. [A] is that case.
//
//          [H]-[J] are the REAL callers' shape: every one previews INTO the prop
//          it passes back as `value`, so a hook that compares the commit against
//          `value` at `change` time turns every pick into "same colour".

import React, { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { useNativeColorPick, pickerHex } from "../colorPick";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

interface Spies {
  onStep: ReturnType<typeof vi.fn>;
  onCommit: ReturnType<typeof vi.fn>;
  onEnd: ReturnType<typeof vi.fn>;
}

function spies(): Spies {
  return { onStep: vi.fn(), onCommit: vi.fn(), onEnd: vi.fn() };
}

/** A host whose `value` is a prop it does not change itself. */
function StaticHost(props: { value: string; fallback?: string; s: Spies }): React.ReactElement {
  const pick = useNativeColorPick({
    value: props.value,
    fallback: props.fallback,
    onStep: props.s.onStep,
    onCommit: props.s.onCommit,
    onEnd: props.s.onEnd,
  });
  return <input {...pick} aria-label="Color" />;
}

/** The real callers' shape: `onStep` previews into the very `value` the hook
 *  receives (the chart card's preview spec, the series draft), and `onEnd`
 *  restores the stored colour. */
function PreviewingHost(props: { stored: string; s: Spies }): React.ReactElement {
  const [shownValue, setShownValue] = useState(props.stored);
  const pick = useNativeColorPick({
    value: shownValue,
    onStep: (hex) => {
      props.s.onStep(hex);
      setShownValue(hex);
    },
    onCommit: props.s.onCommit,
    onEnd: () => {
      props.s.onEnd();
      setShownValue(props.stored);
    },
  });
  return <input {...pick} aria-label="Color" />;
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

function render(el: React.ReactElement): HTMLInputElement {
  if (!host) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  act(() => root!.render(el));
  return host.querySelector('input[type="color"]') as HTMLInputElement;
}

function input(el: HTMLInputElement, hex: string): void {
  act(() => {
    setValue.call(el, hex);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function change(el: HTMLInputElement, hex?: string): void {
  act(() => {
    if (hex !== undefined) setValue.call(el, hex);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function blur(el: HTMLInputElement): void {
  act(() => {
    // React's onBlur listens to the bubbling `focusout`.
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

describe("pickerHex", () => {
  it("normalises #rgb, #rrggbb and #rrggbbaa to the 6-digit lower-case form", () => {
    expect(pickerHex("#ABC")).toBe("#aabbcc");
    expect(pickerHex(" #FF0000 ")).toBe("#ff0000");
    expect(pickerHex("#11223380")).toBe("#112233");
    expect(pickerHex("")).toBe("#000000");
    expect(pickerHex("red")).toBe("#000000");
  });
});

describe("useNativeColorPick", () => {
  it("[A] input then change commits the picked colour once (the case that fails on the old ColorBox)", () => {
    const s = spies();
    const el = render(<StaticHost value="#ffffff" s={s} />);
    input(el, "#ff0000");
    expect(el.value).toBe("#ff0000");
    change(el);
    expect(s.onCommit.mock.calls).toEqual([["#ff0000"]]);
    expect(s.onStep.mock.calls).toEqual([["#ff0000"]]);
    expect(s.onEnd).not.toHaveBeenCalled();
  });

  it("[B] a change with no input before it commits (positive control)", () => {
    const s = spies();
    const el = render(<StaticHost value="#ffffff" s={s} />);
    change(el, "#ff0000");
    expect(s.onCommit.mock.calls).toEqual([["#ff0000"]]);
    expect(s.onStep).not.toHaveBeenCalled();
    expect(s.onEnd).not.toHaveBeenCalled();
  });

  it("[C] picking the stored colour commits nothing and ends the pick", () => {
    const s = spies();
    const el = render(<StaticHost value="#FFFFFF" s={s} />);
    input(el, "#ffffff");
    change(el);
    expect(s.onCommit).not.toHaveBeenCalled();
    expect(s.onEnd).toHaveBeenCalledTimes(1);
  });

  it("[D] three input steps then one change = three previews and ONE commit (one undo step)", () => {
    const s = spies();
    const el = render(<StaticHost value="#ffffff" s={s} />);
    input(el, "#ff0000");
    input(el, "#00ff00");
    input(el, "#0000ff");
    change(el);
    expect(s.onStep.mock.calls).toEqual([["#ff0000"], ["#00ff00"], ["#0000ff"]]);
    expect(s.onCommit.mock.calls).toEqual([["#0000ff"]]);
    expect(s.onEnd).not.toHaveBeenCalled();
  });

  it("[E] a blur with no change ends the preview and never commits", () => {
    const s = spies();
    const el = render(<StaticHost value="#ffffff" s={s} />);
    input(el, "#ff0000");
    blur(el);
    expect(s.onEnd).toHaveBeenCalledTimes(1);
    expect(s.onCommit).not.toHaveBeenCalled();
    // The picker re-syncs to the stored colour once the pick has ended.
    expect(el.value).toBe("#ffffff");
  });

  it("[F] an external value change (undo, binding, another pane) re-syncs the picker", () => {
    const s = spies();
    let el = render(<StaticHost value="#ffffff" s={s} />);
    expect(el.value).toBe("#ffffff");
    el = render(<StaticHost value="#336699" s={s} />);
    expect(el.value).toBe("#336699");
    // ...and after a committed pick too.
    input(el, "#ff0000");
    change(el);
    el = render(<StaticHost value="#ff0000" s={s} />);
    el = render(<StaticHost value="#00aa00" s={s} />);
    expect(el.value).toBe("#00aa00");
  });

  it("[G] an empty stored value shows the fallback, and picking the fallback COMMITS", () => {
    const s = spies();
    const el = render(<StaticHost value="" fallback="#123456" s={s} />);
    expect(el.value).toBe("#123456");
    input(el, "#123456");
    change(el);
    expect(s.onCommit.mock.calls).toEqual([["#123456"]]);
    expect(s.onEnd).not.toHaveBeenCalled();
  });

  it("[H] a host that previews INTO value still gets exactly one commit", () => {
    const s = spies();
    const el = render(<PreviewingHost stored="#ffffff" s={s} />);
    input(el, "#ff0000");
    expect(el.value).toBe("#ff0000");
    change(el);
    expect(s.onCommit.mock.calls).toEqual([["#ff0000"]]);
    expect(s.onEnd).not.toHaveBeenCalled();
  });

  it("[I] a blur between input and change ends the preview, then the change still commits", () => {
    const s = spies();
    const el = render(<PreviewingHost stored="#ffffff" s={s} />);
    input(el, "#ff0000");
    blur(el);
    expect(s.onEnd).toHaveBeenCalledTimes(1);
    expect(s.onCommit).not.toHaveBeenCalled();
    change(el);
    expect(s.onEnd).toHaveBeenCalledTimes(1);
    expect(s.onCommit.mock.calls).toEqual([["#ff0000"]]);
  });

  it("[J] picking back the colour the pick started with ends it without a commit", () => {
    const s = spies();
    const el = render(<PreviewingHost stored="#ffffff" s={s} />);
    input(el, "#ff0000");
    input(el, "#ffffff");
    change(el);
    expect(s.onCommit).not.toHaveBeenCalled();
    expect(s.onEnd).toHaveBeenCalledTimes(1);
  });

  it("[L] a blur-ended pick's step never leaks into a LATER change-only pick", () => {
    const s = spies();
    const el = render(<StaticHost value="#ffffff" s={s} />);
    input(el, "#ff0000");
    blur(el);
    expect(s.onEnd).toHaveBeenCalledTimes(1);
    // No `change` for that pick ever came; the next pick reports only `change`.
    change(el, "#0000ff");
    expect(s.onCommit.mock.calls).toEqual([["#0000ff"]]);
  });

  it("[K] the listener reads the LATEST callbacks (attached once)", () => {
    const first = spies();
    const second = spies();
    let el = render(<StaticHost value="#ffffff" s={first} />);
    el = render(<StaticHost value="#ffffff" s={second} />);
    input(el, "#ff0000");
    change(el);
    expect(first.onCommit).not.toHaveBeenCalled();
    expect(second.onCommit.mock.calls).toEqual([["#ff0000"]]);
  });
});
