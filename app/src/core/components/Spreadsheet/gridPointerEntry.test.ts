//! FILENAME: app/src/core/components/Spreadsheet/gridPointerEntry.test.ts
// PURPOSE: The grid's outermost pointer door honours the claim — and does not
//          preventDefault on the way out, which is the only reason an <input>
//          inside a claimed rectangle ever gets browser focus.
// CONTEXT: Testing the rule in isolation (pointerClaims.test.ts) cannot see
//          this class of bug: delete the guard from this door and every
//          assertion there stays green while the grid goes back to taking every
//          press on every on-grid surface. This file drives the door the DOM is
//          actually bound to (Spreadsheet.tsx `onMouseDown={wrappedMouseDown}`,
//          whose body is `gridPointerMouseDown`).

import { describe, it, expect, beforeEach, vi } from "vitest";
import type React from "react";
import {
  gridPointerMouseDown,
  gridPointerDoubleClick,
  gridShouldTakeKeyboardFocus,
  type GridPointerEntryDeps,
} from "./gridPointerEntry";
import { claimPointer } from "../../lib/pointerClaims";

interface GridDom {
  /** `[data-focus-container="spreadsheet"]`, `tabIndex={0}` — as Spreadsheet.tsx renders it. */
  focusContainer: HTMLElement;
  gridArea: HTMLElement;
  canvas: HTMLElement;
  claimant: HTMLElement;
  input: HTMLElement;
  /** An on-canvas text field with NO claim — the Floating Range's own editor. */
  onGridTextarea: HTMLTextAreaElement;
  /** A focusable control OUTSIDE the grid — a task pane tab, a ribbon button. */
  paneButton: HTMLButtonElement;
}

/** The DOM the grid actually has: a claimant appended beside the canvas. */
function buildDom(): GridDom {
  document.body.innerHTML = "";
  const focusContainer = document.createElement("div");
  focusContainer.setAttribute("data-focus-container", "spreadsheet");
  focusContainer.tabIndex = 0;
  const gridArea = document.createElement("div");
  const canvas = document.createElement("canvas");
  const claimant = document.createElement("div");
  const input = document.createElement("input");
  const onGridTextarea = document.createElement("textarea");
  const paneButton = document.createElement("button");
  claimant.appendChild(input);
  gridArea.appendChild(canvas);
  gridArea.appendChild(claimant);
  gridArea.appendChild(onGridTextarea);
  focusContainer.appendChild(gridArea);
  document.body.appendChild(focusContainer);
  document.body.appendChild(paneButton);
  return { focusContainer, gridArea, canvas, claimant, input, onGridTextarea, paneButton };
}

interface Press {
  event: React.MouseEvent<HTMLElement>;
  preventDefault: ReturnType<typeof vi.fn>;
  stopPropagation: ReturnType<typeof vi.fn>;
}

function press(target: EventTarget, button = 0, clientX = 200, clientY = 200): Press {
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  const event = { target, button, clientX, clientY, preventDefault, stopPropagation } as unknown as
    React.MouseEvent<HTMLElement>;
  return { event, preventDefault, stopPropagation };
}

describe("the grid's pointer door", () => {
  let dom: ReturnType<typeof buildDom>;
  let onGridMouseDown: ReturnType<typeof vi.fn>;
  let beginSplitDrag: ReturnType<typeof vi.fn>;
  let hitTestSplitBar: ReturnType<typeof vi.fn>;
  let deps: GridPointerEntryDeps;

  beforeEach(() => {
    dom = buildDom();
    onGridMouseDown = vi.fn();
    beginSplitDrag = vi.fn();
    hitTestSplitBar = vi.fn().mockReturnValue(null);
    deps = {
      containerRef: { current: dom.gridArea },
      zoom: 1,
      hitTestSplitBar,
      splitRow: null,
      splitCol: null,
      beginSplitDrag,
      onGridMouseDown,
      focusContainerRef: { current: dom.focusContainer },
      isEditing: () => false,
    };
  });

  it("a press inside a claiming element never reaches the grid", () => {
    claimPointer(dom.claimant, "shape-1");
    const p = press(dom.claimant);
    gridPointerMouseDown(p.event, deps);
    expect(onGridMouseDown).not.toHaveBeenCalled();
  });

  it("a press on a widget INSIDE the claimant is not the grid's either", () => {
    claimPointer(dom.claimant, "placement-1");
    const p = press(dom.input);
    gridPointerMouseDown(p.event, deps);
    expect(onGridMouseDown).not.toHaveBeenCalled();
  });

  it("and it does NOT preventDefault — the browser's focus is what the click is for", () => {
    claimPointer(dom.claimant, "placement-1");
    const p = press(dom.input);
    gridPointerMouseDown(p.event, deps);
    // `handleCellMouseDown` calls preventDefault() before its first await, so
    // any path that reaches it cancels focus. The door must refuse the press
    // without cancelling anything itself.
    expect(p.preventDefault).not.toHaveBeenCalled();
  });

  it("a press on an UNCLAIMED pixel still reaches the grid", () => {
    claimPointer(dom.claimant, "shape-1");
    const p = press(dom.canvas);
    gridPointerMouseDown(p.event, deps);
    expect(onGridMouseDown).toHaveBeenCalledTimes(1);
  });

  it("with no claim anywhere, a press on the same element reaches the grid", () => {
    const p = press(dom.claimant);
    gridPointerMouseDown(p.event, deps);
    expect(onGridMouseDown).toHaveBeenCalledTimes(1);
  });

  it("a RIGHT press inside a claim still reaches the grid", () => {
    claimPointer(dom.claimant, "shape-1");
    const p = press(dom.claimant, 2);
    gridPointerMouseDown(p.event, deps);
    expect(onGridMouseDown).toHaveBeenCalledTimes(1);
  });

  it("the claim is decided BEFORE the split bar, so a claimant over one is not a drag", () => {
    // The split-bar branch preventDefaults, which is exactly the thing that
    // must not happen over a claimed rectangle.
    hitTestSplitBar.mockReturnValue("row");
    claimPointer(dom.claimant, "placement-1");
    const p = press(dom.input);
    gridPointerMouseDown(p.event, deps);
    expect(beginSplitDrag).not.toHaveBeenCalled();
    expect(p.preventDefault).not.toHaveBeenCalled();
  });

  it("an unclaimed press on a split bar still starts the split drag", () => {
    hitTestSplitBar.mockReturnValue("col");
    deps.splitCol = 4;
    const p = press(dom.canvas, 0, 130, 90);
    gridPointerMouseDown(p.event, deps);
    expect(beginSplitDrag).toHaveBeenCalledWith({ axis: "col", startPixel: 130, startValue: 4 });
    expect(onGridMouseDown).not.toHaveBeenCalled();
  });

  it("with no container the press goes to the grid unmeasured", () => {
    deps.containerRef = { current: null };
    const p = press(dom.canvas);
    gridPointerMouseDown(p.event, deps);
    expect(onGridMouseDown).toHaveBeenCalledTimes(1);
    expect(hitTestSplitBar).not.toHaveBeenCalled();
  });

  // =========================================================================
  // THE GRID TOOK THE PRESS, SO THE GRID TAKES THE KEYBOARD
  // =========================================================================
  // The measured defect: a chart's own Format pane puts DOM focus on a
  // `<button role="tab">`; clicking a bar then selected the bar while the
  // keyboard stayed on the button, so `isGridFocused()` was false and every
  // chart keystroke — Escape's level-up, the element walk, Delete — was refused
  // by `chartOwnsKeystroke`. The reader sees a selected bar and a dead keyboard
  // with nothing on screen to explain it.

  it("a press the grid takes moves the keyboard back to the grid's focus container", () => {
    dom.paneButton.focus();
    expect(document.activeElement).toBe(dom.paneButton);
    const p = press(dom.canvas);
    gridPointerMouseDown(p.event, deps);
    expect(document.activeElement).toBe(dom.focusContainer);
  });

  it("a CLAIMED press does not — the claimant and the browser own that press", () => {
    claimPointer(dom.claimant, "placement-1");
    dom.paneButton.focus();
    const p = press(dom.input);
    gridPointerMouseDown(p.event, deps);
    expect(document.activeElement).toBe(dom.paneButton);
  });

  it("an open edit keeps its focus — clicking a cell mid-formula is how a reference is PICKED", () => {
    deps.isEditing = () => true;
    dom.paneButton.focus();
    const p = press(dom.canvas);
    gridPointerMouseDown(p.event, deps);
    expect(document.activeElement).toBe(dom.paneButton);
    // …and the press still reaches the grid: only the focus move is exempted.
    expect(onGridMouseDown).toHaveBeenCalledTimes(1);
  });

  it("an on-canvas <textarea> with no claim keeps the press the browser is about to focus it with", () => {
    dom.paneButton.focus();
    const p = press(dom.onGridTextarea);
    gridPointerMouseDown(p.event, deps);
    expect(document.activeElement).toBe(dom.paneButton);
  });

  it("focus already inside the container is left exactly where it is", () => {
    dom.onGridTextarea.focus();
    expect(document.activeElement).toBe(dom.onGridTextarea);
    const p = press(dom.canvas);
    gridPointerMouseDown(p.event, deps);
    expect(document.activeElement).toBe(dom.onGridTextarea);
  });

  it("the focus move happens even when the press starts a SPLIT drag", () => {
    hitTestSplitBar.mockReturnValue("row");
    deps.splitRow = 3;
    dom.paneButton.focus();
    const p = press(dom.canvas, 0, 90, 130);
    gridPointerMouseDown(p.event, deps);
    expect(beginSplitDrag).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(dom.focusContainer);
  });
});

// ===========================================================================
// The rule itself, stated once
// ===========================================================================

describe("gridShouldTakeKeyboardFocus", () => {
  let dom: GridDom;

  beforeEach(() => {
    dom = buildDom();
  });

  it("says yes when focus is outside the grid and the target focuses nothing itself", () => {
    expect(gridShouldTakeKeyboardFocus(dom.canvas, dom.paneButton, dom.focusContainer, false)).toBe(true);
  });

  it("says no with no focus container to give the keyboard to", () => {
    expect(gridShouldTakeKeyboardFocus(dom.canvas, dom.paneButton, null, false)).toBe(false);
  });

  it("says no while an edit is open", () => {
    expect(gridShouldTakeKeyboardFocus(dom.canvas, dom.paneButton, dom.focusContainer, true)).toBe(false);
  });

  it("says no when the container ITSELF already holds the keyboard", () => {
    // `Node.contains` counts the node itself; without that this would answer
    // yes on every press and re-focus the element on every click.
    expect(gridShouldTakeKeyboardFocus(dom.canvas, dom.focusContainer, dom.focusContainer, false)).toBe(false);
  });

  it("says no for a self-focusing target inside the grid", () => {
    expect(gridShouldTakeKeyboardFocus(dom.onGridTextarea, dom.paneButton, dom.focusContainer, false)).toBe(false);
  });

  it("does NOT treat the tabIndex=0 container as a self-focusing target", () => {
    // The trap a `[tabindex]` selector would fall into: the focus container
    // carries tabIndex={0}, so `closest("[tabindex]")` matches it from EVERY
    // target inside the grid and the rule would never fire at all.
    expect(gridShouldTakeKeyboardFocus(dom.focusContainer, dom.paneButton, dom.focusContainer, false)).toBe(true);
  });

  it("survives a target that is not an Element at all", () => {
    expect(gridShouldTakeKeyboardFocus(null, dom.paneButton, dom.focusContainer, false)).toBe(true);
    expect(gridShouldTakeKeyboardFocus(window, dom.paneButton, dom.focusContainer, false)).toBe(true);
  });
});

// ===========================================================================
// The SECOND door bound to the same element
// ===========================================================================
// `onDoubleClick` is not reached through `onMouseDown`, so the guard above does
// nothing for it. Its only pre-existing protection was `checkOverlayBody` — pure
// geometry, which SKIPS every overlay region that publishes no `floating` box,
// and an embedded form publishes none deliberately. Double-clicking a word in an
// on-grid form's text field therefore moved the cell selection to the cell
// hidden under the card and opened the inline editor on it.

describe("the grid's double-click door", () => {
  let dom: ReturnType<typeof buildDom>;
  let onGridDoubleClick: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dom = buildDom();
    onGridDoubleClick = vi.fn();
  });

  it("a double-click inside a claiming element never reaches the grid", () => {
    claimPointer(dom.claimant, "placement-1");
    const p = press(dom.claimant);
    gridPointerDoubleClick(p.event, onGridDoubleClick);
    // The grid's handler is what moves the cell selection and calls startEdit.
    expect(onGridDoubleClick).not.toHaveBeenCalled();
  });

  it("a double-click on the TEXT FIELD inside the card is not the grid's either", () => {
    // The reported gesture: selecting a word in an on-grid form's input.
    claimPointer(dom.claimant, "placement-1");
    const p = press(dom.input);
    gridPointerDoubleClick(p.event, onGridDoubleClick);
    expect(onGridDoubleClick).not.toHaveBeenCalled();
  });

  it("and it does NOT preventDefault — selecting the word IS the gesture", () => {
    claimPointer(dom.claimant, "placement-1");
    const p = press(dom.input);
    gridPointerDoubleClick(p.event, onGridDoubleClick);
    expect(p.preventDefault).not.toHaveBeenCalled();
  });

  it("an UNCLAIMED double-click still reaches the grid and starts an edit", () => {
    claimPointer(dom.claimant, "placement-1");
    const p = press(dom.canvas);
    gridPointerDoubleClick(p.event, onGridDoubleClick);
    expect(onGridDoubleClick).toHaveBeenCalledTimes(1);
  });

  it("with no claim anywhere, a double-click on the same element reaches the grid", () => {
    const p = press(dom.input);
    gridPointerDoubleClick(p.event, onGridDoubleClick);
    expect(onGridDoubleClick).toHaveBeenCalledTimes(1);
  });

  it("a double-click inside a HIDDEN claimant is the grid's again", () => {
    claimPointer(dom.claimant, "placement-1");
    dom.claimant.style.display = "none";
    const p = press(dom.input);
    gridPointerDoubleClick(p.event, onGridDoubleClick);
    expect(onGridDoubleClick).toHaveBeenCalledTimes(1);
  });
});
