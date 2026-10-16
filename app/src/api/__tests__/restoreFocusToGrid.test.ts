//! FILENAME: app/src/api/__tests__/restoreFocusToGrid.test.ts
// PURPOSE: `restoreFocusToGrid` really gives the keyboard back to the grid:
//          afterwards `isGridFocused()` is true. It used to focus the first
//          <canvas>, which has no tabIndex, so focus() did nothing and the
//          keyboard stayed in the pane or dialog that asked to give it back
//          (found live, object-pane-format J15, 2026-10-16).

import { describe, it, expect, afterEach } from "vitest";
import { restoreFocusToGrid } from "../events";
import { isGridFocused } from "../keybindings";

afterEach(() => {
  document.body.innerHTML = "";
});

/** The DOM as Spreadsheet.tsx renders it: a tabIndex-0 container holding a canvas with none. */
function mountGrid(): { container: HTMLElement; paneButton: HTMLButtonElement } {
  const container = document.createElement("div");
  container.setAttribute("data-focus-container", "spreadsheet");
  container.tabIndex = 0;
  container.appendChild(document.createElement("canvas"));
  document.body.appendChild(container);
  const pane = document.createElement("div");
  const paneButton = document.createElement("button");
  paneButton.textContent = "Effects";
  pane.appendChild(paneButton);
  document.body.appendChild(pane);
  return { container, paneButton };
}

describe("restoreFocusToGrid", () => {
  it("moves the keyboard from a pane button to the grid's focus container", () => {
    const { container, paneButton } = mountGrid();
    paneButton.focus();
    expect(isGridFocused()).toBe(false);

    restoreFocusToGrid();

    expect(document.activeElement).toBe(container);
    expect(isGridFocused()).toBe(true);
  });

  it("is harmless with no grid in the document", () => {
    expect(() => restoreFocusToGrid()).not.toThrow();
  });
});
