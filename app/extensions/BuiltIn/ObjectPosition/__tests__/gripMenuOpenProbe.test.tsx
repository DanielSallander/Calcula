//! FILENAME: app/extensions/BuiltIn/ObjectPosition/__tests__/gripMenuOpenProbe.test.tsx
// PURPOSE: The grip's menu SAYS it is open (@api/objectPosition
//          `isObjectGripMenuOpen`, M8 S7). Its keys -- arrows, Home, End,
//          Enter, Space, Escape -- are its own, but it listens on DOCUMENT
//          capture, and an inner keyboard focus (a slicer's, a timeline's)
//          listens on WINDOW capture, which runs first: without this answer a
//          slicer the keyboard is inside would take the menu's arrows.
//            - the probe is true exactly while a menu is mounted, and false
//              again when it closes;
//            - the seam: each open counts once, its cleanup un-counts once
//              (twice is harmless), and the test reset forgets every open.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { setGridRegions, type GridRegion } from "@api/gridOverlays";
import { isObjectGripMenuOpen, noteObjectGripMenuOpen, resetObjectPosition } from "@api/objectPosition";
import { GripMenu } from "../components/GripMenu";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const SLICER: GridRegion = {
  id: "slicer-s1",
  type: "slicer",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  data: { slicerId: "s1" },
  floating: { x: 64, y: 32, width: 200, height: 100 },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetObjectPosition();
  setGridRegions([SLICER]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setGridRegions([]);
  resetObjectPosition();
});

describe("the grip menu's open probe", () => {
  it("is true while the menu is mounted and false once it closes", () => {
    expect(isObjectGripMenuOpen(), "control: no menu").toBe(false);
    act(() => {
      root.render(<GripMenu onClose={() => {}} data={{ regionId: SLICER.id }} anchorRect={{ x: 10, y: 10, width: 24, height: 24 }} />);
    });
    expect(document.querySelector("[data-object-grip-menu]"), "fixture: the menu rendered").not.toBeNull();
    expect(isObjectGripMenuOpen(), "an open grip menu does not say so: a slicer's inner focus would take its arrows").toBe(true);
    act(() => root.render(<></>));
    expect(isObjectGripMenuOpen(), "a closed grip menu still says it is open: the slicer's keys would never come back").toBe(false);
  });

  it("the seam counts each open once; a cleanup called twice un-counts once; reset forgets", () => {
    const a = noteObjectGripMenuOpen();
    const b = noteObjectGripMenuOpen();
    a();
    a();
    expect(isObjectGripMenuOpen(), "a double cleanup closed ANOTHER open menu").toBe(true);
    b();
    expect(isObjectGripMenuOpen()).toBe(false);
    noteObjectGripMenuOpen();
    resetObjectPosition();
    expect(isObjectGripMenuOpen()).toBe(false);
  });
});
