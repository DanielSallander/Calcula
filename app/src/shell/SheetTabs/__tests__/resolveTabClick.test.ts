//! FILENAME: app/src/shell/SheetTabs/__tests__/resolveTabClick.test.ts
// PURPOSE: What a sheet-tab click means, rule by rule.
// CONTEXT: The strip used to ask only the grid's OWN editor whether a click was
//          point-mode navigation. A floating grid's cell edit (an external
//          session) was invisible to it, so a tab click during "=" took the
//          ORDINARY switch and ended the edit; and the one tab that could bring a
//          parked edit back -- its host, usually a canvas -- was refused.
//          A tab DRAG's click is not decided here: the strip refuses it in
//          its own early returns, before its group-clearing step (review
//          RESOLVETABCLICK-DRAGGING-DEAD) -- sheetTabsTemporarySheets.test.tsx
//          drives those through the mounted strip.

import { describe, it, expect } from "vitest";
import { resolveTabClick, plainClickKeepsGroup, shiftClickGroup, type GroupTab, type TabClickInput } from "../resolveTabClick";

/** Sheet 0 is a worksheet, sheet 2 a canvas; the grid shows sheet 0. */
function click(over: Partial<TabClickInput> = {}): TabClickInput {
  return {
    index: 1,
    activeIndex: 0,
    targetIsCanvas: false,
    activeIsCanvas: false,
    ctrlKey: false,
    shiftKey: false,
    coreFormulaMode: false,
    session: null,
    ...over,
  };
}

// The session as the strip hands it over: `targetIsSessionHost` is the
// strip's identity verdict on the CLICKED tab (isExternalSessionHostSheet).
const expecting = { targetIsSessionHost: false, parked: false, expecting: true };
const parked = { targetIsSessionHost: false, parked: true, expecting: false };
const plain = { targetIsSessionHost: false, parked: false, expecting: false };
/** The same parked session, the click landing on its host's tab. */
const parkedOnHostTab = { ...parked, targetIsSessionHost: true };

describe("resolveTabClick", () => {
  it("an EXPECTING external session makes a tab click point-mode navigation", () => {
    expect(resolveTabClick(click({ index: 0, activeIndex: 2, activeIsCanvas: true, session: expecting }))).toBe("pointMode");
  });

  it("a PARKED session's host canvas tab brings the edit back", () => {
    expect(
      resolveTabClick(click({ index: 2, activeIndex: 0, targetIsCanvas: true, session: parkedOnHostTab })),
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

  // Review F3-strip-uses-owner-host-index: the host is the strip's IDENTITY
  // verdict on the clicked tab, never an index compared with the owner's
  // opening one -- after a renumbering under a parked edit, the host's own tab
  // (now at another index) was ignored, and a canvas that slid into the old
  // index was accepted.
  it("a parked session's host is decided by the identity verdict, never by an index", () => {
    // The host renumbered from 2 to 1: its tab is the host, at whatever index.
    expect(resolveTabClick(click({ index: 1, activeIndex: 0, targetIsCanvas: true, session: parkedOnHostTab }))).toBe("pointMode");
    // The canvas that slid into the host's OLD index (2) is not the host.
    expect(resolveTabClick(click({ index: 2, activeIndex: 0, targetIsCanvas: true, session: parked }))).toBe("ignore");
    // No session: a canvas is never a reference target in formula mode.
    expect(resolveTabClick(click({ index: 2, targetIsCanvas: true, coreFormulaMode: true }))).toBe("ignore");
  });
});

// BUG-0616 item 6, Excel 16 [LIVE] -- resolveTabClick.ts SHEET GROUP CLICKS.
describe("Shift outside formula mode, and the group rules", () => {
  const tabs = (n: number, over: Record<number, Partial<GroupTab>> = {}): GroupTab[] =>
    Array.from({ length: n }, (_, index) => ({ index, visible: true, isCanvas: false, ...over[index] }));

  it("Shift outside formula mode selects a range of sheets -- on the active tab too; never from or to a canvas", () => {
    expect(resolveTabClick(click({ shiftKey: true }))).toBe("groupRange");
    expect(resolveTabClick(click({ shiftKey: true, index: 0 }))).toBe("groupRange");
    expect(resolveTabClick(click({ shiftKey: true, index: 2, targetIsCanvas: true }))).toBe("ignore");
    expect(resolveTabClick(click({ shiftKey: true, activeIsCanvas: true }))).toBe("ignore");
  });

  it("a member click keeps a group that leaves a visible tab out, and ends one that covers every visible tab", () => {
    expect(plainClickKeepsGroup([0, 2], 2, tabs(4))).toBe(true);
    expect(plainClickKeepsGroup([0, 1, 2, 3], 2, tabs(4))).toBe(false);
    // The left-out tab is hidden: every VISIBLE tab is grouped.
    expect(plainClickKeepsGroup([0, 1, 2], 2, tabs(4, { 3: { visible: false } }))).toBe(false);
    // A canvas tab is a tab outside the group (it can be clicked).
    expect(plainClickKeepsGroup([0, 1, 2], 2, tabs(4, { 3: { isCanvas: true } }))).toBe(true);
    // Not a member, or no group: the click ends it.
    expect(plainClickKeepsGroup([0, 2], 1, tabs(4))).toBe(false);
    expect(plainClickKeepsGroup([], 1, tabs(4))).toBe(false);
  });

  it("Shift+click's range runs from the active sheet to the clicked one over visible worksheets", () => {
    expect(shiftClickGroup(0, 2, tabs(4))).toEqual([0, 1, 2]);
    expect(shiftClickGroup(3, 1, tabs(4))).toEqual([1, 2, 3]);
    expect(shiftClickGroup(0, 2, tabs(4, { 1: { visible: false } }))).toEqual([0, 2]);
    expect(shiftClickGroup(0, 3, tabs(4, { 2: { isCanvas: true } }))).toEqual([0, 1, 3]);
    expect(shiftClickGroup(1, 1, tabs(4))).toEqual([1]);
  });
});
