//! FILENAME: app/extensions/BuiltIn/ObjectPane/__tests__/colorBox.test.tsx
// PURPOSE: The Format tab's colour row (ColorBox) against the way Chromium /
//          WebView2 drives an OS colour picker: set the value, fire `input`,
//          then `change`.
// CONTEXT: Round 2, owner finding G1 "chart background colour does nothing".
//          ColorBox was a CONTROLLED picker whose React onChange only
//          previewed: React's restore wrote the OLD prop back into the DOM, so
//          the native `change` saw "same colour" and committed nothing (proved
//          by r2/probe/colorbox.probe.test.tsx). It now spreads the shared
//          `useNativeColorPick`; [A] is the probe case on the REAL component.

import React, { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { ColorBox } from "../components/fields/ColorField";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(node: React.ReactElement): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

function picker(h: HTMLDivElement): HTMLInputElement {
  return h.querySelector('input[type="color"]') as HTMLInputElement;
}

function hexBox(h: HTMLDivElement): HTMLInputElement {
  return h.querySelector('[data-testid="format-background.color-hex"]') as HTMLInputElement;
}

function pick(el: HTMLInputElement, hex: string): void {
  act(() => {
    setValue.call(el, hex);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function closeOn(el: HTMLInputElement): void {
  act(() => {
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("ColorBox: the OS picker commits ONCE, on its native change", () => {
  it("[A] input then change commits the picked colour (failed on the controlled picker)", () => {
    const onCommit = vi.fn();
    const onPreview = vi.fn();
    const onEndPreview = vi.fn();
    const h = mount(
      <ColorBox
        value="#ffffff"
        onCommit={onCommit}
        onPreview={onPreview}
        onEndPreview={onEndPreview}
        ariaLabel="Background colour"
        testId="format-background.color"
      />,
    );
    const el = picker(h);
    expect(el.value).toBe("#ffffff");
    pick(el, "#ff0000");
    expect(el.value).toBe("#ff0000");
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenCalledWith("#ff0000");
    expect(onCommit).not.toHaveBeenCalled();
    closeOn(el);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("#ff0000");
    expect(onEndPreview).not.toHaveBeenCalled();
  });

  it("a host that previews INTO value (the stored-truth snapshot follows the preview) still commits once", () => {
    const onCommit = vi.fn();
    function Host(): React.ReactElement {
      const [value, setValue_] = useState("#ffffff");
      return (
        <ColorBox
          value={value}
          onCommit={onCommit}
          onPreview={(hex) => setValue_(hex)}
          onEndPreview={() => setValue_("#ffffff")}
          ariaLabel="Background colour"
          testId="format-background.color"
        />
      );
    }
    const h = mount(<Host />);
    const el = picker(h);
    pick(el, "#00ff00");
    pick(el, "#0000ff");
    closeOn(el);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("#0000ff");
  });

  it("picking the stored colour back ends the preview and writes nothing", () => {
    const onCommit = vi.fn();
    const onEndPreview = vi.fn();
    const h = mount(
      <ColorBox
        value="#ffffff"
        onCommit={onCommit}
        onPreview={() => undefined}
        onEndPreview={onEndPreview}
        ariaLabel="Background colour"
      />,
    );
    const el = picker(h);
    pick(el, "#ff0000");
    pick(el, "#ffffff");
    closeOn(el);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onEndPreview).toHaveBeenCalledTimes(1);
  });

  it("a blur with no change ends the preview and never commits", () => {
    const onCommit = vi.fn();
    const onEndPreview = vi.fn();
    const h = mount(
      <ColorBox value="#ffffff" onCommit={onCommit} onPreview={() => undefined} onEndPreview={onEndPreview} ariaLabel="c" />,
    );
    const el = picker(h);
    act(() => {
      el.focus();
    });
    pick(el, "#ff0000");
    act(() => {
      el.blur();
    });
    expect(onEndPreview).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe("ColorBox: the hex box and Default are unchanged", () => {
  it("the hex box commits a typed colour on Enter", () => {
    const onCommit = vi.fn();
    const h = mount(
      <ColorBox value="#ffffff" onCommit={onCommit} ariaLabel="Background colour" testId="format-background.color" />,
    );
    const box = hexBox(h);
    act(() => {
      box.focus();
    });
    act(() => {
      setValue.call(box, "#123456");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onCommit).toHaveBeenCalledWith("#123456");
  });

  it("a typed non-colour is refused and writes nothing", () => {
    const onCommit = vi.fn();
    const h = mount(
      <ColorBox value="#ffffff" onCommit={onCommit} ariaLabel="Background colour" testId="format-background.color" />,
    );
    const box = hexBox(h);
    act(() => {
      setValue.call(box, "red");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onCommit).not.toHaveBeenCalled();
    expect(h.querySelector('[role="alert"]')?.textContent).toBe("Use #rgb, #rrggbb or #rrggbbaa.");
  });

  it("Default clears the literal", () => {
    const onCommit = vi.fn();
    const onDefault = vi.fn();
    const h = mount(
      <ColorBox
        value="#123456"
        onCommit={onCommit}
        onDefault={onDefault}
        ariaLabel="Background colour"
        testId="format-background.color"
      />,
    );
    const button = h.querySelector('[data-testid="format-background.color-default"]') as HTMLButtonElement;
    act(() => {
      button.click();
    });
    expect(onDefault).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("an external value change (undo) moves the picker between picks", () => {
    const h = mount(<ColorBox value="#ffffff" onCommit={() => undefined} ariaLabel="c" />);
    expect(picker(h).value).toBe("#ffffff");
    act(() => root!.render(<ColorBox value="#abcdef" onCommit={() => undefined} ariaLabel="c" />));
    expect(picker(h).value).toBe("#abcdef");
  });
});
