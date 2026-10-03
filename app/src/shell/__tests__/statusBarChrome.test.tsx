//! FILENAME: app/src/shell/__tests__/statusBarChrome.test.tsx
// PURPOSE: The status bar paints with the --status-bar-bg / --status-bar-fg
//          tokens, whose LIGHT fallbacks are exactly the Excel green and white
//          it always drew — so the Light goldens hold (e2e/goldenCorpus.ts pins
//          CHROME_GREEN_SRGB = 33,115,70) while Dark gets its deeper green.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StatusBar } from "../StatusBar";
import { findHardcodedColours } from "../../api/layout";
import { emitAppEvent, AppEvents } from "../../api/events";
import { registerStatusBarItem, unregisterStatusBarItem } from "../../api/ui";
import { GRID_MODE_CHANGED } from "../../core/components/Spreadsheet/useSpreadsheetLayout";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<StatusBar />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function bar(): HTMLElement {
  const el = container.querySelector<HTMLElement>("[data-testid='status-bar']");
  if (!el) throw new Error("the status bar is not in the DOM");
  return el;
}

describe("status bar chrome", () => {
  it("paints from the status-bar tokens with the light baseline as fallback", () => {
    const style = bar().getAttribute("style") ?? "";
    expect(style).toContain("var(--status-bar-bg, #217346)");
    expect(style).toContain("var(--status-bar-fg, #ffffff)");
  });

  it("keeps its geometry (24px strip)", () => {
    expect(bar().style.height).toBe("24px");
  });

  it("paints no hardcoded colour", () => {
    expect(findHardcodedColours(container)).toEqual([]);
  });
});

describe("status bar text never displaces a registered item", () => {
  // jsdom computes no layout, so this pins the CSS contract that makes the
  // guarantee (the live proof measures the real boxes): the left zone may
  // shrink, the TEXT slots give way on one line, and an item keeps its width.
  // The scenario it exists for is a script's 512-character Application.
  // StatusBar message beside the host-drawn code-and-scripts indicator.
  const LONG = "x".repeat(512);

  afterEach(() => {
    act(() => emitAppEvent(AppEvents.STATUS_BAR_TEXT_CHANGED, { text: null }));
    unregisterStatusBarItem("test.left-item");
  });

  it("the left zone can shrink below its content", () => {
    expect(container.querySelector<HTMLElement>("[data-testid='status-bar-left']")!.style.minWidth).toBe("0px");
  });

  it("a script's long message truncates on one line instead of wrapping, and keeps its text on hover", () => {
    act(() => emitAppEvent(AppEvents.STATUS_BAR_TEXT_CHANGED, { text: LONG }));
    const mode = container.querySelector<HTMLElement>("[data-testid='status-bar-mode']")!;
    expect(mode.textContent).toBe(LONG);
    expect(mode.style.whiteSpace).toBe("nowrap");
    expect(mode.style.overflow).toBe("hidden");
    expect(mode.style.textOverflow).toBe("ellipsis");
    expect(mode.style.minWidth).toBe("0px");
    expect(mode.title).toBe(LONG);
  });

  it("the idle mode carries no tooltip of its own", () => {
    expect(container.querySelector<HTMLElement>("[data-testid='status-bar-mode']")!.title).toBe("");
  });

  it("the ORDER text gives way: a script's message first, then the selection; the host's mode word never", () => {
    act(() => emitAppEvent(GRID_MODE_CHANGED, { mode: "[Ready]", selectionText: "A1:C200 [200R x 3C] | Row: 200, Col: 3" }));
    const mode = (): HTMLElement => container.querySelector<HTMLElement>("[data-testid='status-bar-mode']")!;
    const selection = container.querySelector<HTMLElement>("[data-testid='status-bar-selection']")!;
    // The host's "Ready" is never cut to "Rea…" (Excel never truncates its mode).
    expect(mode().style.flexShrink).toBe("0");
    // The selection readout gives way, keeps its full text on hover, and its
    // digits are one width so moving the cursor does not nudge what follows.
    expect(selection.style.flexShrink).toBe("1");
    expect(selection.title).toBe("A1:C200 [200R x 3C] | Row: 200, Col: 3");
    expect(selection.style.fontVariantNumeric).toBe("tabular-nums");
    // While a script's message shows, the message ALONE gives way: flexbox
    // shares a shortfall in proportion, and any share at all draws the
    // readout's ellipsis ("Col:…", measured live), so the readout is fixed.
    act(() => emitAppEvent(AppEvents.STATUS_BAR_TEXT_CHANGED, { text: LONG }));
    const beside = container.querySelector<HTMLElement>("[data-testid='status-bar-selection']")!;
    expect(mode().style.flexShrink).toBe("1");
    expect(beside.style.flexShrink).toBe("0");
  });

  it("a registered left item renders after the text slots, outside them", () => {
    act(() =>
      registerStatusBarItem({
        id: "test.left-item",
        alignment: "left",
        component: () => <button data-testid="left-item">item</button>,
      }),
    );
    const left = container.querySelector<HTMLElement>("[data-testid='status-bar-left']")!;
    const item = container.querySelector<HTMLElement>("[data-testid='left-item']")!;
    expect(item.parentElement).toBe(left);
    expect(left.firstElementChild?.getAttribute("data-testid")).toBe("status-bar-mode");
  });
});
