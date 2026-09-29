//! FILENAME: app/extensions/CanvasSheet/__tests__/familyCoMoveWiring.test.ts
// PURPOSE: When Controls, Slicer or Timeline LEAD a drag, the members each
//          family co-moves itself go through the ONE co-move rule on the
//          object-geometry seam (`coMovedMemberRect`, @api/objectGeometry):
//          kept on the canvas page and never moving a locked member -- like a
//          Core-led group drag (lib/groupDrag.ts) -- instead of the clamp at 0
//          each family had (open-items 2.af, "their own co-moved members are
//          clamped at 0 only").
// CONTEXT: SOURCE-TEXT: the three families' drag handlers are closures inside
//          their `activate()`, which a unit test cannot run without the whole
//          backend. The RULE is proved behaviourally in
//          src/api/__tests__/objectGeometryCoMove.test.ts, and Controls'
//          press-time snapshot (the drift fix) in
//          Controls/__tests__/controlCoMove.test.ts; this pins that each
//          family's handler actually uses them.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(rel: string): string {
  const src = readFileSync(resolve(__dirname, rel), "utf8");
  // Comments stripped: a sentence about the old clamp must not count.
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The body of the listener assigned to `name` (up to the next addEventListener of it). */
function handler(src: string, name: string, event: string): string {
  const at = src.indexOf(`const ${name} = (e: Event) => {`);
  expect(at, `${name} is gone`).toBeGreaterThan(-1);
  const end = src.indexOf(`window.addEventListener("${event}", ${name})`, at);
  expect(end, `${name} is no longer the ${event} listener`).toBeGreaterThan(at);
  return src.slice(at, end);
}

describe.each([
  ["Slicer", "../../Slicer/index.ts", "coMovedSlicerAt"],
  ["TimelineSlicer", "../../TimelineSlicer/index.ts", "coMovedTimelineAt"],
])("%s: a slicer-led drag co-moves its selection by the Core-led rule", (_family, rel, helper) => {
  const src = source(rel);

  it("the family's co-move helper IS the seam rule", () => {
    const at = src.indexOf(`const ${helper} = (`);
    expect(at, `${helper} is gone`).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("};", at));
    expect(body).toContain("coMovedMemberRect(");
  });

  it("the move COMPLETE places every co-moved member through that helper", () => {
    const body = handler(src, "handleMoveComplete", "floatingObject:moveComplete");
    expect(body).toContain(`${helper}(`);
    expect(body, "a member is still clamped at 0 only").not.toMatch(/Math\.max\(0, startPos\.[xy] \+ d[xy]\)/);
  });

  it("the move PREVIEW does the same (what the user sees is what is saved)", () => {
    const body = handler(src, "handleMovePreview", "floatingObject:movePreview");
    expect(body).toContain(`${helper}(`);
    expect(body, "a member is still clamped at 0 only").not.toMatch(/Math\.max\(0, startPos\.[xy] \+ d[xy]\)/);
  });
});

describe("Controls: a control-led drag co-moves its selection by the Core-led rule", () => {
  const src = source("../../Controls/index.ts");

  it("the placing helper IS the seam rule, over the press-time snapshot", () => {
    const at = src.indexOf("const placeCoMovedControls = (");
    expect(at, "placeCoMovedControls is gone").toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("return moved;", at));
    expect(body).toContain("coMovedControlPositions(");
  });

  it("the move PREVIEW and COMPLETE place the co-moved controls from the press-time snapshot", () => {
    for (const [name, event] of [
      ["handleMovePreview", "floatingObject:movePreview"],
      ["handleMoveComplete", "floatingObject:moveComplete"],
    ] as const) {
      const body = handler(src, name, event);
      expect(body, `${name} does not place the co-moved controls through the seam rule`).toContain(
        "placeCoMovedControls(",
      );
      // The picture is taken BEFORE the lead moves (its start is the lead's too).
      const snap = body.indexOf("controlDragFor(controlId)");
      expect(snap, `${name} takes no press-time snapshot`).toBeGreaterThan(-1);
      expect(body.indexOf("moveFloatingControl(controlId, newX, newY)")).toBeGreaterThan(snap);
      expect(body, `${name} still clamps a co-moved control at 0 only`).not.toMatch(
        /Math\.max\(0, otherCtrl\.[xy] \+ delta[XY]\)/,
      );
    }
  });

  it("a press drops the picture, so a click that never became a drag leaves none behind", () => {
    expect(src).toMatch(/window\.addEventListener\("floatingObject:selected", dropControlDrag\)/);
  });
});
