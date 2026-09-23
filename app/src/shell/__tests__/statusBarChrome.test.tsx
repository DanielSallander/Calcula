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
