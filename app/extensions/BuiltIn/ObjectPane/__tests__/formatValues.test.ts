//! FILENAME: app/extensions/BuiltIn/ObjectPane/__tests__/formatValues.test.ts
// PURPOSE: The pure half of the Format tab and the Properties card:
//          resolved-vs-stored values (transparency % <-> alpha), the one patch
//          a row commits (unchanged = none, clamp, null clears), which fields a
//          family's capabilities show, and the geometry change a typed box asks
//          for with Lock aspect ratio -- including a page clamp that cuts one
//          side (the other shrinks to keep the ratio).

import { describe, it, expect } from "vitest";
import { BASE_CONTAINER_DEFAULTS, resolveVisualContainer } from "@api/visualContainer";
import type { ContainerCapabilities, ObjectFormatSnapshot } from "@api/objectFormat";
import type { SizeAndPositionAvailability } from "@api/objectPosition";
import {
  fieldOffered,
  literalFieldValue,
  resolvedFieldValue,
  rowPatch,
} from "../lib/formatValues";
import { geometryChangeFor } from "../lib/geometryRows";
import { floatingRegion } from "./harness";

const CAPS: ContainerCapabilities = {
  padding: true,
  lockAspect: true,
  title: true,
  titleText: "free",
  subtitle: false,
  divider: false,
  background: true,
  backgroundTransparency: false,
  gradient: false,
  border: true,
  borderRadius: false,
  shadow: false,
  dataFormat: false,
};

function snap(stored: ObjectFormatSnapshot["stored"]): ObjectFormatSnapshot {
  return {
    stored,
    resolved: resolveVisualContainer(stored, BASE_CONTAINER_DEFAULTS),
    capabilities: CAPS,
    bound: new Map(),
  };
}

const MOVABLE: SizeAndPositionAvailability = {
  provided: true,
  move: true,
  resize: true,
  reason: null,
  sizeReason: null,
  page: null,
};

describe("values a row starts at", () => {
  it("transparency is shown in % from the resolved alpha", () => {
    const s = snap({ background: { transparency: 40 } });
    expect(resolvedFieldValue(s.resolved, "background.transparency")).toBe(40);
    expect(resolvedFieldValue(snap({}).resolved, "shadow.transparency")).toBe(70); // alpha 0.3
  });

  it("the stored literal wins; an untouched field shows what resolves", () => {
    expect(literalFieldValue(snap({ border: { width: 3 } }), "border.width")).toBe(3);
    expect(literalFieldValue(snap({}), "border.width")).toBe(BASE_CONTAINER_DEFAULTS.border.width);
    expect(literalFieldValue(snap({}), "spacing.custom")).toBe(false);
  });
});

describe("the patch a row commits", () => {
  it("an unchanged commit is no write; a changed one is the leaf", () => {
    const s = snap({ border: { width: 3 } });
    expect(rowPatch(s, "border.width", 3)).toBeNull();
    expect(rowPatch(s, "border.width", 4)).toEqual({ border: { width: 4 } });
    expect(rowPatch(snap({}), "title.show", false)).toBeNull(); // the default already shows
  });

  it("a number is clamped into its field's range and an integer field rounded", () => {
    expect(rowPatch(snap({}), "padding.top", 999)).toEqual({ padding: { top: 200 } });
    expect(rowPatch(snap({}), "title.headingLevel", 2.6)).toEqual({ title: { headingLevel: 3 } });
    expect(rowPatch(snap({}), "padding.top", Number.NaN)).toBeNull();
  });

  it("null clears a stored leaf and is no write on an untouched one", () => {
    expect(rowPatch(snap({ title: { text: "x" } }), "title.text", null)).toEqual({ title: { text: null } });
    expect(rowPatch(snap({}), "title.text", null)).toBeNull();
  });
});

describe("a background colour is a solid background commit (round 2, G1)", () => {
  const GRADIENT = {
    type: "linear" as const,
    stops: [
      { offset: 0, color: "#ff0000" },
      { offset: 1, color: "#0000ff" },
    ],
  };
  /** A family whose background is OFF by default (the floating grid, frObjectFormat.ts). */
  function hiddenByDefault(stored: ObjectFormatSnapshot["stored"]): ObjectFormatSnapshot {
    const defaults = { ...BASE_CONTAINER_DEFAULTS, background: { ...BASE_CONTAINER_DEFAULTS.background, show: false } };
    return { stored, resolved: resolveVisualContainer(stored, defaults), capabilities: CAPS, bound: new Map() };
  }

  it("a pick over a stored gradient clears the gradient", () => {
    const s = snap({ background: { color: "#ffffff", gradient: GRADIENT } });
    expect(rowPatch(s, "background.color", "#123456")).toEqual({ background: { color: "#123456", gradient: null } });
  });

  it("a pick on a background stored show:false switches it on", () => {
    const s = snap({ background: { show: false } });
    expect(rowPatch(s, "background.color", "#123456")).toEqual({ background: { color: "#123456", show: true } });
  });

  it("a pick on a family whose RESOLVED show is false (nothing stored) switches it on", () => {
    const s = hiddenByDefault({});
    expect(s.resolved.background.show).toBe(false);
    expect(rowPatch(s, "background.color", "#123456")).toEqual({ background: { color: "#123456", show: true } });
    // Even the colour that already resolves: committing it must make it SHOW.
    expect(rowPatch(s, "background.color", "#ffffff")).toEqual({ background: { color: "#ffffff", show: true } });
  });

  it("the same colour, no gradient, show not false: no write", () => {
    expect(rowPatch(snap({ background: { color: "#123456" } }), "background.color", "#123456")).toBeNull();
    expect(rowPatch(snap({ background: { color: "#123456" } }), "background.color", "#123456".toUpperCase())).toBeNull();
    expect(rowPatch(snap({}), "background.color", BASE_CONTAINER_DEFAULTS.background.color)).toBeNull();
  });

  it("re-picking the RESOLVED colour on a gradient-only container clears the gradient", () => {
    // The chart Fill card's shape: only `background.gradient` stored, no colour.
    const s = snap({ background: { gradient: GRADIENT } });
    const shown = BASE_CONTAINER_DEFAULTS.background.color;
    expect(rowPatch(s, "background.color", shown)).toEqual({ background: { color: shown, gradient: null } });
  });

  it("Default (null) still clears only the colour", () => {
    const s = snap({ background: { color: "#123456", show: false, gradient: GRADIENT } });
    expect(rowPatch(s, "background.color", null)).toEqual({ background: { color: null } });
  });
});

describe("which fields a family's capabilities show", () => {
  it("follows the flags, including the per-leaf ones", () => {
    expect(fieldOffered(CAPS, "padding.left")).toBe(true);
    expect(fieldOffered(CAPS, "subtitle.text")).toBe(false);
    expect(fieldOffered(CAPS, "background.color")).toBe(true);
    expect(fieldOffered(CAPS, "background.transparency")).toBe(false);
    expect(fieldOffered(CAPS, "border.radius")).toBe(false);
    expect(fieldOffered(CAPS, "spacing.custom")).toBe(true); // a title is offered
    expect(fieldOffered({ ...CAPS, titleText: "none" }, "title.text")).toBe(false);
  });

  it("never offers a row the family does not honour (a one-line header: no wrap; spacing only beside its band)", () => {
    // Title only, wrap honoured (titleWrap absent): wrap + belowTitle, no belowSubtitle/belowDivider.
    expect(fieldOffered(CAPS, "title.wrap")).toBe(true);
    expect(fieldOffered(CAPS, "spacing.belowTitle")).toBe(true);
    expect(fieldOffered(CAPS, "spacing.belowSubtitle")).toBe(false);
    expect(fieldOffered(CAPS, "spacing.belowDivider")).toBe(false);
    // Everything on: every distance shows.
    const all = { ...CAPS, subtitle: true, divider: true };
    expect(fieldOffered(all, "spacing.belowSubtitle")).toBe(true);
    expect(fieldOffered(all, "spacing.belowDivider")).toBe(true);
    expect(fieldOffered(all, "subtitle.wrap")).toBe(true);
    // A one-line header (slicer, timeline): no wrap on title or subtitle.
    expect(fieldOffered({ ...all, titleWrap: false }, "title.wrap")).toBe(false);
    expect(fieldOffered({ ...all, titleWrap: false }, "subtitle.wrap")).toBe(false);
    expect(fieldOffered({ ...all, titleWrap: false }, "title.fontSize")).toBe(true);
    // No spacing at all (floating grid).
    for (const id of ["spacing.custom", "spacing.belowTitle", "spacing.belowSubtitle", "spacing.belowDivider"] as const) {
      expect(fieldOffered({ ...all, spacing: false }, id)).toBe(false);
    }
  });
});

describe("the geometry change a typed box asks for", () => {
  const region = floatingRegion("g", "t", 100, 50, 200, 100);

  it("lock off: only the typed side changes", () => {
    const c = geometryChangeFor(region, "width", 300, false, MOVABLE)!;
    expect([c.x, c.y, c.width, c.height]).toEqual([100, 50, 300, 100]);
  });

  it("lock on: a Width sets the Height by the ratio; a Height sets the Width", () => {
    const w = geometryChangeFor(region, "width", 300, true, MOVABLE)!;
    expect([w.width, w.height]).toEqual([300, 150]);
    const h = geometryChangeFor(region, "height", 50, true, MOVABLE)!;
    expect([h.width, h.height]).toEqual([100, 50]);
  });

  it("lock on, page clamp cuts one side: the other shrinks to keep the ratio", () => {
    const onPage: SizeAndPositionAvailability = { ...MOVABLE, page: { width: 1000, height: 200 } };
    const c = geometryChangeFor(region, "width", 600, true, onPage)!;
    // 600 x 300 does not fit a 200 px-high page: the height is cut to 200 and
    // the width shrinks with it, keeping 2:1.
    expect([c.width, c.height]).toEqual([400, 200]);
    expect(c.y + c.height).toBeLessThanOrEqual(200);
  });

  it("nothing when the object may not move, the box is blank, or nothing changes", () => {
    expect(geometryChangeFor(region, "x", 10, false, { ...MOVABLE, move: false })).toBeNull();
    expect(geometryChangeFor(region, "x", null, false, MOVABLE)).toBeNull();
    expect(geometryChangeFor(region, "x", 100, false, MOVABLE)).toBeNull();
  });

  it("a size that may not change is kept, the lock notwithstanding", () => {
    const fixed: SizeAndPositionAvailability = { ...MOVABLE, resize: false };
    expect(geometryChangeFor(region, "width", 300, true, fixed)).toBeNull();
  });
});
