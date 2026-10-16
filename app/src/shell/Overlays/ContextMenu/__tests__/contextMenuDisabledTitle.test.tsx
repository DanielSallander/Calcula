//! FILENAME: app/src/shell/Overlays/ContextMenu/__tests__/contextMenuDisabledTitle.test.tsx
// PURPOSE: A context-menu row's `title` (a disabled item's reason, mapped by
//          GridContextMenuHost from `disabledReason`) is rendered as the row's
//          tooltip AND its accessible description -- on a plain row and on a
//          sub-menu trigger -- and a row without one carries neither.
// CONTEXT: WP-A S9 (`GridContextMenuItem.disabledReason`, spec section 2.4).

import { describe, it, expect, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ContextMenu, type ContextMenuItem } from "../ContextMenu";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(items: ContextMenuItem[]): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<ContextMenu position={{ x: 10, y: 10 }} items={items} onClose={() => {}} />);
  });
  return host;
}

function rowNamed(container: HTMLElement, label: string): HTMLButtonElement {
  const row = Array.from(container.querySelectorAll<HTMLButtonElement>("[role=menuitem]")).find(
    (b) => b.textContent?.includes(label),
  );
  if (!row) throw new Error(`no row "${label}"`);
  return row;
}

describe("ContextMenu disabled reason", () => {
  it("renders a row's title as its tooltip and accessible description", () => {
    const container = render([
      { id: "a", label: "Expand", disabled: true, title: "Already expanded.", onClick: () => {} },
      { id: "b", label: "Refresh", onClick: () => {} },
      {
        id: "c",
        label: "Sort",
        disabled: true,
        title: "Sorting by values is not available yet.",
        onClick: () => {},
        children: [{ id: "c1", label: "Sort Smallest to Largest", onClick: () => {} }],
      },
    ]);

    const expand = rowNamed(container, "Expand");
    expect(expand.disabled).toBe(true);
    expect(expand.getAttribute("title")).toBe("Already expanded.");
    expect(expand.getAttribute("aria-description")).toBe("Already expanded.");

    // A row with no reason carries neither attribute.
    const refresh = rowNamed(container, "Refresh");
    expect(refresh.hasAttribute("title")).toBe(false);
    expect(refresh.hasAttribute("aria-description")).toBe(false);

    // The sub-menu trigger renders the reason too.
    const sort = rowNamed(container, "Sort");
    expect(sort.getAttribute("title")).toBe("Sorting by values is not available yet.");
    expect(sort.getAttribute("aria-description")).toBe("Sorting by values is not available yet.");
  });
});
