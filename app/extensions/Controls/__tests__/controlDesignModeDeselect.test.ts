//! FILENAME: app/extensions/Controls/__tests__/controlDesignModeDeselect.test.ts
// PURPOSE: Design Mode ENDING deselects the selected BUTTONS (each with its
//          group); shapes and pictures stay selected (BUG-0270 review,
//          finding 4).
// CONTEXT: A selected object CLAIMS the selection on a worksheet since
//          BUG-0270, so the keyboard is refused until it is deselected. A
//          button selected in Design Mode stayed selected when Design Mode
//          ended -- its chrome painted, every key refused with "an object is
//          selected" -- where Excel deselects it. Its own file: every
//          registration here is cleaned up, so a stale Design Mode listener
//          from another test cannot answer for the one under test.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@api/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitAppEvent: vi.fn(),
}));

vi.mock("@api/gridOverlays", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  replaceGridRegionsByType: vi.fn(),
  removeGridRegionsByType: vi.fn(),
}));

import { resetObjectSelectionProviders } from "@api/objectSelection";
import { registerControlObjectSelection } from "../lib/controlObjectSelection";
import {
  addFloatingControl,
  getAllFloatingControls,
  groupControls,
  removeFloatingControl,
  resetFloatingStore,
} from "../lib/floatingStore";
import {
  addFloatingControlsToSelection,
  deselectFloatingControl,
  getSelectedFloatingControls,
  isFloatingControlSelected,
} from "../Button/floatingSelection";
import { setDesignMode } from "../lib/designMode";

const BUTTON = "control-0-1-1";
const SHAPE = "control-0-3-3";
const PIC = "control-0-5-5";
const GROUPED_SHAPE = "control-0-7-7";
const GROUPED_BUTTON = "control-0-8-8";

function add(id: string, controlType: string): void {
  const [, s, r, c] = id.split("-").map(Number);
  addFloatingControl({ id, sheetIndex: s, row: r, col: c, x: 10, y: 10, width: 80, height: 28, controlType });
}

const cleanups: Array<() => void> = [];

beforeEach(() => {
  setDesignMode(false);
  resetObjectSelectionProviders();
  for (const ctrl of getAllFloatingControls()) removeFloatingControl(ctrl.id);
  resetFloatingStore();
  deselectFloatingControl();
  add(BUTTON, "button");
  add(SHAPE, "shape");
  add(PIC, "image");
  add(GROUPED_SHAPE, "shape");
  add(GROUPED_BUTTON, "button");
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  setDesignMode(false);
});

describe("Design Mode ending deselects the selected BUTTONS", () => {
  it("turning Design Mode OFF drops the buttons and keeps the shape and the picture", () => {
    cleanups.push(registerControlObjectSelection());
    setDesignMode(true);
    addFloatingControlsToSelection([BUTTON, SHAPE, PIC]);
    expect(getSelectedFloatingControls().size, "fixture").toBe(3);
    setDesignMode(false);
    expect(isFloatingControlSelected(BUTTON), "the button stayed selected after Design Mode ended").toBe(false);
    expect(isFloatingControlSelected(SHAPE), "a shape is selectable in run mode: it stays").toBe(true);
    expect(isFloatingControlSelected(PIC), "a picture is selectable in run mode: it stays").toBe(true);
  });

  it("a grouped button leaves WITH its group (every operation on the selection acts on the group)", () => {
    groupControls([GROUPED_SHAPE, GROUPED_BUTTON]);
    cleanups.push(registerControlObjectSelection());
    setDesignMode(true);
    addFloatingControlsToSelection([GROUPED_SHAPE, GROUPED_BUTTON, SHAPE]);
    setDesignMode(false);
    expect(isFloatingControlSelected(GROUPED_BUTTON)).toBe(false);
    expect(isFloatingControlSelected(GROUPED_SHAPE), "half a group was left selected").toBe(false);
    expect(isFloatingControlSelected(SHAPE)).toBe(true);
  });

  it("turning Design Mode ON deselects nothing", () => {
    cleanups.push(registerControlObjectSelection());
    addFloatingControlsToSelection([BUTTON]);
    setDesignMode(true);
    expect(isFloatingControlSelected(BUTTON)).toBe(true);
  });

  it("the registration's cleanup stops listening (a deactivated Controls deselects nothing)", () => {
    const off = registerControlObjectSelection();
    setDesignMode(true);
    addFloatingControlsToSelection([BUTTON]);
    off();
    setDesignMode(false);
    expect(isFloatingControlSelected(BUTTON), "a removed registration still deselected").toBe(true);
  });
});
