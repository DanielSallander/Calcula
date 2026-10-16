//! FILENAME: app/extensions/Controls/lib/__tests__/controlKinds.test.ts
// PURPOSE: THE one table of control-kind words and the Design-Mode-only list
//          (WP-B S5), and the three callers that used to keep their own copy.

import { describe, it, expect } from "vitest";
import { CONTROL_KIND_LABELS, controlKindLabel, isDesignModeOnlyControl } from "../controlKinds";
import { controlLabelOf } from "../controlObjectSelection";
import type { GridRegion } from "@api/gridOverlays";

describe("controlKindLabel", () => {
  it("names the four kinds", () => {
    expect(controlKindLabel("button")).toBe("Button");
    expect(controlKindLabel("shape")).toBe("Shape");
    expect(controlKindLabel("image")).toBe("Picture");
    expect(controlKindLabel("pageNavigator")).toBe("Page navigator");
    expect(CONTROL_KIND_LABELS.size).toBe(4);
  });

  it("an untyped control is 'Control'; an unknown kind is Capitalised", () => {
    expect(controlKindLabel("")).toBe("Control");
    expect(controlKindLabel("slider")).toBe("Slider");
  });
});

describe("isDesignModeOnlyControl", () => {
  it("is true only for button and pageNavigator", () => {
    expect(isDesignModeOnlyControl("button")).toBe(true);
    expect(isDesignModeOnlyControl("pageNavigator")).toBe(true);
    for (const t of ["shape", "image", "", "slider"]) expect(isDesignModeOnlyControl(t), t).toBe(false);
  });
});

describe("the Name Box reads the table but keeps its untyped guard", () => {
  const region = (controlType: unknown): GridRegion =>
    ({ id: "control-0-1-1", type: "floating-control", data: { controlType } }) as unknown as GridRegion;

  it("uses the shared words", () => {
    expect(controlLabelOf(region("pageNavigator"))).toBe("Page navigator");
    expect(controlLabelOf(region("image"))).toBe("Picture");
  });

  it("shows nothing for an untyped region (not 'Control')", () => {
    expect(controlLabelOf(region(""))).toBeNull();
    expect(controlLabelOf(region(undefined))).toBeNull();
  });
});
