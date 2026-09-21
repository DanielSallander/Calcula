//! FILENAME: app/extensions/Charts/handlers/__tests__/chartKeyboardOwnership.test.ts
// PURPOSE: The gate that stops Delete destroying a chart from inside the chart's
//          OWN Format pane, and the one rule that decides which of the two
//          arrow-key features owns a Left/Right keystroke.
// CONTEXT: DATA LOSS, three clicks deep. Charts installs a capture-phase Delete
//          listener. It guarded `isKeyClaimed` and bailed on
//          INPUT/TEXTAREA/contentEditable. A `<button>` is none of those, and a
//          pointer claim is a GRID-OVERLAY concept — nothing on the ribbon or in
//          a task pane carries one. So: select a chart, click the Format pane's
//          Options tab (a real <button>, now focused), press Delete, and THE
//          CHART WAS DELETED. The contextual Design panel has the same shape,
//          and the Format pane widened the hazard from a ribbon strip to a whole
//          pane of focusable controls.
//
//          The fix is not a fourth tag in the tag list — it is the question Core
//          already asks, `isGridFocused` (`@api/keybindings`), which tests
//          `[data-focus-container="spreadsheet"]`. `chartOwnsKeystroke` is the
//          one predicate all three of the extension's key listeners read, so
//          none of them can be fixed while the others stay broken.
//
//          These tests use REAL focused elements and REAL KeyboardEvents against
//          a REAL grid container, because the whole defect was that a synthetic
//          "is it an input?" check answered a question nobody had asked.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ChartSubSelection } from "../../types";

vi.mock("@api", () => ({
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));

// `@api/pointerClaims` and `@api/keybindings` are deliberately NOT mocked: the
// predicate under test is exactly their composition, and a doubled
// `isGridFocused` would prove nothing about the selector that actually ships.
const { chartOwnsKeystroke, arrowsBelongToOverlayStep } = await import("../selectionHandler");
const { POINTER_CLAIM_ATTR } = await import("@api/pointerClaims");

// ============================================================================
// DOM scaffolding
// ============================================================================

let gridContainer: HTMLElement;
let outsidePane: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";

  gridContainer = document.createElement("div");
  gridContainer.setAttribute("data-focus-container", "spreadsheet");
  document.body.appendChild(gridContainer);

  // The task pane / ribbon: a sibling of the grid, NOT a descendant. This is
  // what makes it invisible to both the tag list and the pointer claim.
  outsidePane = document.createElement("div");
  outsidePane.setAttribute("data-task-pane", "chart-format");
  document.body.appendChild(outsidePane);
});

afterEach(() => {
  document.body.innerHTML = "";
});

/** A focusable element that really takes focus in jsdom. */
function focusable(parent: HTMLElement, tag: "button" | "select" | "input" | "div"): HTMLElement {
  const el = document.createElement(tag);
  if (tag === "div") el.setAttribute("tabindex", "0");
  parent.appendChild(el);
  (el as HTMLElement).focus();
  return el;
}

/** A real KeyboardEvent dispatched at a real target, as the listener sees it. */
function keyEventAt(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  // `e.target` is read-only on a constructed event until it is dispatched, so
  // dispatch it and capture what the listener would actually receive.
  let seen: KeyboardEvent | null = null;
  const capture = (e: Event) => { seen = e as KeyboardEvent; };
  document.addEventListener("keydown", capture, true);
  target.dispatchEvent(event);
  document.removeEventListener("keydown", capture, true);
  if (seen === null) throw new Error("event never reached the capture listener");
  return seen;
}

// ============================================================================
// PART 1 — the data-loss gate
// ============================================================================

describe("chartOwnsKeystroke — the grid must be the subject", () => {
  it("REFUSES a Delete aimed at a focused <button> in a task pane (the data-loss case)", () => {
    const tab = focusable(outsidePane, "button");
    expect(document.activeElement).toBe(tab);

    const event = keyEventAt(tab, "Delete");

    // Every gate the OLD code had says "mine": no claim, and a <button> is not
    // INPUT / TEXTAREA / contentEditable. Spelled out so the sabotage below
    // cannot pass by accident.
    expect(tab.tagName).toBe("BUTTON");
    // jsdom leaves `isContentEditable` undefined rather than false, which is
    // exactly why `isTextEntryTarget` compares against `=== true`.
    expect(tab.isContentEditable).toBeFalsy();
    expect(tab.closest(`[${POINTER_CLAIM_ATTR}]`)).toBeNull();

    expect(chartOwnsKeystroke(event)).toBe(false);
  });

  it("REFUSES a Delete aimed at a focused <select> in a task pane", () => {
    const dropdown = focusable(outsidePane, "select");
    expect(chartOwnsKeystroke(keyEventAt(dropdown, "Delete"))).toBe(false);
  });

  it("REFUSES a Delete aimed at a focused ribbon button (the Design panel case)", () => {
    // Same shape as the pane, different host: the contextual Design panel is a
    // ribbon-placed strip of real <button>s and carries the identical hazard.
    const ribbon = document.createElement("div");
    ribbon.setAttribute("data-ribbon", "chart-design");
    document.body.appendChild(ribbon);
    const bold = focusable(ribbon, "button");
    expect(chartOwnsKeystroke(keyEventAt(bold, "Delete"))).toBe(false);
  });

  it("ACCEPTS a Delete while the grid container itself holds focus", () => {
    const surface = focusable(gridContainer, "div");
    expect(document.activeElement).toBe(surface);
    expect(chartOwnsKeystroke(keyEventAt(surface, "Delete"))).toBe(true);
  });

  it("REFUSES a keystroke inside a CLAIMED widget stacked on the grid", () => {
    // The gate that was already there, kept: an on-grid form field owns its own
    // Delete even though focus is inside the grid container.
    const card = document.createElement("div");
    card.setAttribute(POINTER_CLAIM_ATTR, "form-1");
    gridContainer.appendChild(card);
    const field = focusable(card, "select");
    expect(chartOwnsKeystroke(keyEventAt(field, "Delete"))).toBe(false);
  });

  it("REFUSES a keystroke typed into a plain <input> inside the grid", () => {
    const field = focusable(gridContainer, "input");
    expect(chartOwnsKeystroke(keyEventAt(field, "Delete"))).toBe(false);
  });

  it("REFUSES a keystroke typed into a contentEditable element inside the grid", () => {
    const editor = document.createElement("div");
    editor.setAttribute("tabindex", "0");
    // jsdom does not implement `isContentEditable` from the attribute alone.
    Object.defineProperty(editor, "isContentEditable", { value: true });
    gridContainer.appendChild(editor);
    editor.focus();
    expect(chartOwnsKeystroke(keyEventAt(editor, "Delete"))).toBe(false);
  });

  it("REFUSES when nothing at all is focused", () => {
    const surface = focusable(gridContainer, "div");
    const event = keyEventAt(surface, "Delete");
    (document.activeElement as HTMLElement | null)?.blur();
    // document.body is the active element after a blur, and it is outside the
    // grid container — so the answer is still "not ours".
    expect(chartOwnsKeystroke(event)).toBe(false);
  });

  it("answers the same way for every key the extension binds", () => {
    const tab = focusable(outsidePane, "button");
    for (const key of ["Delete", "Backspace", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Escape"]) {
      expect(chartOwnsKeystroke(keyEventAt(tab, key))).toBe(false);
    }
    const surface = focusable(gridContainer, "div");
    for (const key of ["Delete", "Backspace", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Escape"]) {
      expect(chartOwnsKeystroke(keyEventAt(surface, key))).toBe(true);
    }
  });
});

// ============================================================================
// PART 2 — arrow precedence, BOTH branches
// ============================================================================

const CHART: ChartSubSelection = { level: "chart" };
const SERIES: ChartSubSelection = { level: "series", seriesIndex: 0 };
const LEGEND: ChartSubSelection = { level: "element", elementId: "legend" };
const PLAIN = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
const CTRL = { altKey: false, ctrlKey: true, metaKey: false, shiftKey: false };

describe("arrowsBelongToOverlayStep — one rule, read by both listeners", () => {
  it("gives PLAIN arrows to the overlay at chart level on a chart WITH cues", () => {
    expect(arrowsBelongToOverlayStep(CHART, 3, PLAIN)).toBe(true);
  });

  it("gives PLAIN arrows to the element walk on a chart with NO cues", () => {
    expect(arrowsBelongToOverlayStep(CHART, 0, PLAIN)).toBe(false);
  });

  it("gives PLAIN arrows to the element walk at every rung DEEPER than chart", () => {
    // The whole point of the split: once the reader has drilled in, Left/Right
    // must walk the points of that series even though the chart carries cues.
    expect(arrowsBelongToOverlayStep(SERIES, 3, PLAIN)).toBe(false);
    expect(arrowsBelongToOverlayStep(LEGEND, 3, PLAIN)).toBe(false);
    expect(arrowsBelongToOverlayStep({ level: "dataPoint", seriesIndex: 0, categoryIndex: 1 }, 3, PLAIN)).toBe(false);
    expect(arrowsBelongToOverlayStep({ level: "axis", axisType: "x" }, 3, PLAIN)).toBe(false);
  });

  it("never gives a MODIFIED arrow to the overlay, even at chart level with cues", () => {
    // This is what lets CI-10 bind Ctrl+arrows as well as plain arrows without
    // either feature taking a key away from the other.
    expect(arrowsBelongToOverlayStep(CHART, 3, CTRL)).toBe(false);
    expect(arrowsBelongToOverlayStep(CHART, 3, { ...PLAIN, shiftKey: true })).toBe(false);
    expect(arrowsBelongToOverlayStep(CHART, 3, { ...PLAIN, altKey: true })).toBe(false);
    expect(arrowsBelongToOverlayStep(CHART, 3, { ...PLAIN, metaKey: true })).toBe(false);
  });

  it("matches overlayStepDelta's own modifier rule, so neither can dead-key the other", async () => {
    const { overlayStepDelta } = await import("../../lib/overlayKeys");
    // Where the predicate hands the keystroke to the overlay, the overlay's own
    // rule must actually produce a step; otherwise the key is dead.
    expect(arrowsBelongToOverlayStep(CHART, 3, PLAIN)).toBe(true);
    expect(overlayStepDelta({ key: "ArrowRight", ...PLAIN }, 3)).toBe(1);
    expect(overlayStepDelta({ key: "ArrowLeft", ...PLAIN }, 3)).toBe(-1);
    // And where it does not, the overlay declines too.
    expect(arrowsBelongToOverlayStep(CHART, 0, PLAIN)).toBe(false);
    expect(overlayStepDelta({ key: "ArrowRight", ...PLAIN }, 0)).toBeNull();
  });
});
