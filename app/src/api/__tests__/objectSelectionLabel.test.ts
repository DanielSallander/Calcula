//! FILENAME: app/src/api/__tests__/objectSelectionLabel.test.ts
// PURPOSE: The object label registry (@api/objectSelectionLabel): publish / get
//          / on, keyed by publisher so one clearing cannot erase another, and
//          listeners told only when the visible label changes.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  EMPTY_OBJECT_LABEL,
  getObjectLabel,
  onObjectLabelChanged,
  publishObjectLabel,
  resetObjectLabelRegistry,
} from "../objectSelectionLabel";

beforeEach(() => resetObjectLabelRegistry());

describe("object label registry", () => {
  it("starts empty", () => {
    expect(getObjectLabel()).toEqual(EMPTY_OBJECT_LABEL);
  });

  it("publishes a label with its count; a plain string is ONE object", () => {
    publishObjectLabel("canvas", { text: "3 objects", count: 3 });
    expect(getObjectLabel()).toEqual({ source: "canvas", text: "3 objects", count: 3 });
    publishObjectLabel("canvas", "Slicer_Region");
    expect(getObjectLabel()).toEqual({ source: "canvas", text: "Slicer_Region", count: 1 });
  });

  it("null or an empty text withdraws the source's label", () => {
    publishObjectLabel("canvas", "Sales");
    publishObjectLabel("canvas", null);
    expect(getObjectLabel().text).toBe("");
    publishObjectLabel("canvas", "Sales");
    publishObjectLabel("canvas", "  ");
    expect(getObjectLabel().text).toBe("");
  });

  it("the newest source wins, and withdrawing it falls back to the next newest", () => {
    publishObjectLabel("a", "From A");
    publishObjectLabel("b", "From B");
    expect(getObjectLabel().text).toBe("From B");
    publishObjectLabel("b", null);
    expect(getObjectLabel()).toMatchObject({ source: "a", text: "From A" });
  });

  it("tells listeners only on a CHANGE, and the unsubscribe stops them", () => {
    const seen = vi.fn();
    const off = onObjectLabelChanged(seen);
    publishObjectLabel("canvas", "Sales");
    publishObjectLabel("canvas", "Sales");
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenLastCalledWith({ source: "canvas", text: "Sales", count: 1 });
    off();
    publishObjectLabel("canvas", "Costs");
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("a throwing listener does not stop the others", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const good = vi.fn();
    onObjectLabelChanged(() => {
      throw new Error("boom");
    });
    onObjectLabelChanged(good);
    publishObjectLabel("canvas", "Sales");
    expect(good).toHaveBeenCalled();
    err.mockRestore();
  });
});
