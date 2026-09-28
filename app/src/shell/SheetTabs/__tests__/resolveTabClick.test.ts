//! FILENAME: app/src/shell/SheetTabs/__tests__/resolveTabClick.test.ts
// PURPOSE: What a sheet-tab click means, rule by rule.
// CONTEXT: The strip used to ask only the grid's OWN editor whether a click was
//          point-mode navigation. A floating grid's cell edit (an external
//          session) was invisible to it, so a tab click during "=" took the
//          ORDINARY switch and ended the edit; and the one tab that could bring a
//          parked edit back -- its host, usually a canvas -- was refused.

import { describe, it, expect } from "vitest";
import { resolveTabClick, type TabClickInput } from "../resolveTabClick";

/** Sheet 0 is a worksheet, sheet 2 a canvas; the grid shows sheet 0. */
function click(over: Partial<TabClickInput> = {}): TabClickInput {
  return {
    index: 1,
    activeIndex: 0,
    targetIsCanvas: false,
    activeIsCanvas: false,
    ctrlKey: false,
    shiftKey: false,
    dragging: false,
    coreFormulaMode: false,
    session: null,
    ...over,
  };
}

const expecting = { hostSheetIndex: 2, parked: false, expecting: true };
const parked = { hostSheetIndex: 2, parked: true, expecting: false };
const plain = { hostSheetIndex: 2, parked: false, expecting: false };

describe("resolveTabClick", () => {
  it("an EXPECTING external session makes a tab click point-mode navigation", () => {
    expect(resolveTabClick(click({ index: 0, activeIndex: 2, activeIsCanvas: true, session: expecting }))).toBe("pointMode");
  });

  it("a PARKED session's host canvas tab brings the edit back", () => {
    expect(
      resolveTabClick(click({ index: 2, activeIndex: 0, targetIsCanvas: true, session: parked })),
    ).toBe("pointMode");
  });

  it("any OTHER canvas tab while parked is refused (a canvas is no reference target)", () => {
    expect(
      resolveTabClick(click({ index: 3, activeIndex: 0, targetIsCanvas: true, session: parked })),
    ).toBe("ignore");
  });

  it("a parked session that no longer expects a reference still navigates (never an ordinary switch)", () => {
    expect(resolveTabClick(click({ index: 1, activeIndex: 0, session: parked }))).toBe("pointMode");
  });

  it("a plain value (a session neither expecting nor parked) takes the ORDINARY switch, which commits it", () => {
    expect(resolveTabClick(click({ index: 0, activeIndex: 2, activeIsCanvas: true, session: plain }))).toBe("normal");
  });

  it("the grid's own editor in formula mode keeps its point mode, and its canvas refusal", () => {
    expect(resolveTabClick(click({ coreFormulaMode: true }))).toBe("pointMode");
    expect(resolveTabClick(click({ coreFormulaMode: true, index: 2, targetIsCanvas: true }))).toBe("ignore");
  });

  it("no edit at all: an ordinary switch; the active tab does nothing", () => {
    expect(resolveTabClick(click())).toBe("normal");
    expect(resolveTabClick(click({ index: 0 }))).toBe("ignore");
  });

  it("Shift in formula mode inserts a 3D prefix between WORKSHEETS only", () => {
    expect(resolveTabClick(click({ coreFormulaMode: true, shiftKey: true }))).toBe("prefix3d");
    // On the active tab too (a prefix that starts and ends here).
    expect(resolveTabClick(click({ coreFormulaMode: true, shiftKey: true, index: 0 }))).toBe("prefix3d");
    // A canvas at either end is refused. On a canvas HOST with an expecting
    // session the "start" would have been the canvas itself ("Report:Sheet3!").
    expect(
      resolveTabClick(click({ session: expecting, shiftKey: true, activeIndex: 2, activeIsCanvas: true, index: 1 })),
    ).toBe("ignore");
    expect(
      resolveTabClick(click({ coreFormulaMode: true, shiftKey: true, index: 2, targetIsCanvas: true })),
    ).toBe("ignore");
  });

  it("Ctrl outside formula mode groups worksheets; a canvas at either end is refused", () => {
    expect(resolveTabClick(click({ ctrlKey: true }))).toBe("group");
    expect(resolveTabClick(click({ ctrlKey: true, targetIsCanvas: true }))).toBe("ignore");
    expect(resolveTabClick(click({ ctrlKey: true, activeIsCanvas: true }))).toBe("ignore");
    // In formula mode Ctrl is not grouping.
    expect(resolveTabClick(click({ ctrlKey: true, session: expecting }))).toBe("pointMode");
  });

  it("the click that ends a tab drag is not a click", () => {
    expect(resolveTabClick(click({ dragging: true }))).toBe("ignore");
    expect(resolveTabClick(click({ dragging: true, session: expecting }))).toBe("ignore");
  });
});
