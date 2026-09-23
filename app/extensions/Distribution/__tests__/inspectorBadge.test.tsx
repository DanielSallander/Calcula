//! FILENAME: app/extensions/Distribution/__tests__/inspectorBadge.test.tsx
// PURPOSE: The Application Inspector's Badge is a thin wrapper over the ONE
//          @api Badge: it keeps its props ({ color, children }) and its look
//          (a white-on-status-colour word pill), and takes the pill itself —
//          shape, font, white text, no-wrap — from the shared primitive.
// CONTEXT: The status colours stay the inspector's own constants (the window
//          does not load the app skin); the wrapper adds no colour of its own.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { findHardcodedColours } from "@api/layout";
import { Badge, OK_GREEN } from "../components/inspector/shared";

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
  document.body.innerHTML = "";
});

function render(node: React.ReactNode): HTMLElement {
  act(() => root.render(node));
  const pill = container.firstElementChild as HTMLElement | null;
  if (!pill) throw new Error("nothing rendered");
  return pill;
}

describe("inspector Badge over @api Badge", () => {
  it("renders the shared pill (data-tone) with the caller's status colour as the fill", () => {
    const pill = render(<Badge color={OK_GREEN}>checksum verified</Badge>);
    expect(pill.tagName).toBe("SPAN");
    expect(pill.getAttribute("data-tone")).toBe("accent");
    expect(pill.textContent).toBe("checksum verified");
    expect(pill.style.background).toMatch(/rgb\(30, 126, 52\)|#1e7e34/i);
    // A word label, not a count: padded, 16px tall.
    expect(pill.style.padding).toBe("0px 8px");
    expect(pill.style.height).toBe("16px");
  });

  it("adds no colour of its own: with a token fill, nothing hardcoded renders", () => {
    render(<Badge color="var(--tone-ok-fg, #067647)">publisher view</Badge>);
    expect(findHardcodedColours(container)).toEqual([]);
  });
});
