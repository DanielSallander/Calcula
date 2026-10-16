//! FILENAME: app/src/api/__tests__/aspectLock.test.ts
// PURPOSE: LOCK ASPECT RATIO (D-FORMAT `container.lockAspect`) -- the one
//          ratio-keeping resize rule (@api/aspectLock), pinned for all eight
//          handles at two ratios (2:1 and 1:3): the ratio holds, the right side
//          drives (corner: the dominant change; edge: its own axis), the FIXED
//          edges never move, the minimum size holds on both sides, and the
//          "shrink" re-fit after a page clamp cut one dimension shrinks the
//          other instead of growing it back.

import { describe, it, expect } from "vitest";
import {
  applyAspectLock,
  aspectLockedEdges,
  type AspectLockEdges,
  type AspectLockRect,
} from "../aspectLock";

type Handle = "tl" | "t" | "tr" | "r" | "br" | "b" | "bl" | "l";

const EDGES: Record<Handle, AspectLockEdges> = {
  tl: { left: true, top: true, right: false, bottom: false },
  t: { left: false, top: true, right: false, bottom: false },
  tr: { left: false, top: true, right: true, bottom: false },
  r: { left: false, top: false, right: true, bottom: false },
  br: { left: false, top: false, right: true, bottom: true },
  b: { left: false, top: false, right: false, bottom: true },
  bl: { left: true, top: false, right: false, bottom: true },
  l: { left: true, top: false, right: false, bottom: false },
};

/** The free resize Core computes for a handle dragged by (dx, dy): only its own sides follow. */
function freeResize(o: AspectLockRect, e: AspectLockEdges, dx: number, dy: number): AspectLockRect {
  let left = o.x;
  let top = o.y;
  let right = o.x + o.width;
  let bottom = o.y + o.height;
  if (e.left) left += dx;
  if (e.right) right += dx;
  if (e.top) top += dy;
  if (e.bottom) bottom += dy;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The pointer motion that GROWS the object at each handle by (gx, gy). */
function growDelta(h: Handle, gx: number, gy: number): [number, number] {
  const e = EDGES[h];
  return [e.left ? -gx : e.right ? gx : 0, e.top ? -gy : e.bottom ? gy : 0];
}

const RATIOS: Array<[string, AspectLockRect]> = [
  ["2:1", { x: 100, y: 100, width: 200, height: 100 }],
  ["1:3", { x: 100, y: 100, width: 60, height: 180 }],
];

describe("applyAspectLock: every handle keeps the ratio and its fixed edges", () => {
  for (const [label, orig] of RATIOS) {
    const ratio = orig.width / orig.height;
    for (const h of Object.keys(EDGES) as Handle[]) {
      it(`${label}, handle ${h}`, () => {
        const e = EDGES[h];
        const [dx, dy] = growDelta(h, 30, 12);
        const next = freeResize(orig, e, dx, dy);
        const got = applyAspectLock(orig, next, e, 16);

        // The ratio holds (whole pixels: within one pixel of the exact size).
        expect(Math.abs(got.width - got.height * ratio), `${JSON.stringify(got)}`).toBeLessThanOrEqual(Math.max(1, ratio));

        // The FIXED edges: a dragged left edge keeps the right one, a dragged top edge the bottom one,
        // everything else keeps left / top.
        if (e.left && !e.right) expect(got.x + got.width).toBe(orig.x + orig.width);
        else expect(got.x).toBe(orig.x);
        if (e.top && !e.bottom) expect(got.y + got.height).toBe(orig.y + orig.height);
        else expect(got.y).toBe(orig.y);

        // Which side drove: an edge handle its own axis, a corner the dominant relative change.
        const horizontal = e.left || e.right;
        const vertical = e.top || e.bottom;
        if (horizontal && !vertical) expect(got.width).toBe(orig.width + 30);
        else if (vertical && !horizontal) expect(got.height).toBe(orig.height + 12);
        else {
          const sw = (orig.width + 30) / orig.width;
          const sh = (orig.height + 12) / orig.height;
          if (Math.abs(sw - 1) >= Math.abs(sh - 1)) expect(got.width).toBe(orig.width + 30);
          else expect(got.height).toBe(orig.height + 12);
        }
      });
    }
  }

  it("the dominant change wins at a corner, both ways (2:1)", () => {
    const orig = { x: 100, y: 100, width: 200, height: 100 };
    const br = EDGES.br;
    // Width +50% vs height +20%: the width drives.
    expect(applyAspectLock(orig, { x: 100, y: 100, width: 300, height: 120 }, br, 16)).toEqual({ x: 100, y: 100, width: 300, height: 150 });
    // Width +10% vs height +50%: the height drives.
    expect(applyAspectLock(orig, { x: 100, y: 100, width: 220, height: 150 }, br, 16)).toEqual({ x: 100, y: 100, width: 300, height: 150 });
    // A top-left corner: anchored at the bottom-right corner (300, 200).
    expect(applyAspectLock(orig, { x: 0, y: 60, width: 300, height: 140 }, EDGES.tl, 16)).toEqual({ x: 0, y: 50, width: 300, height: 150 });
  });

  it("a shrinking drag keeps the ratio too (1:3, left edge)", () => {
    const orig = { x: 100, y: 100, width: 60, height: 180 };
    expect(applyAspectLock(orig, { x: 120, y: 100, width: 40, height: 180 }, EDGES.l, 16)).toEqual({ x: 120, y: 100, width: 40, height: 120 });
  });
});

describe("applyAspectLock: the minimum size holds on BOTH sides", () => {
  it("2:1 dragged to almost nothing: the height stops at the minimum and the width keeps the ratio", () => {
    const orig = { x: 100, y: 100, width: 200, height: 100 };
    expect(applyAspectLock(orig, { x: 100, y: 100, width: 10, height: 5 }, EDGES.br, 16)).toEqual({ x: 100, y: 100, width: 32, height: 16 });
  });

  it("1:3 dragged to almost nothing: the width stops at the minimum, anchored at the fixed corner", () => {
    const orig = { x: 100, y: 100, width: 60, height: 180 };
    // A top-left drag: the bottom-right corner (160, 280) stays.
    expect(applyAspectLock(orig, { x: 155, y: 270, width: 5, height: 10 }, EDGES.tl, 16)).toEqual({ x: 144, y: 232, width: 16, height: 48 });
  });
});

describe("applyAspectLock fit 'shrink': a page clamp that cut one dimension shrinks the other", () => {
  it("2:1 grown to 400 x 200, then the page (width 400) cut the right edge to 400: the height follows down", () => {
    const orig = { x: 100, y: 100, width: 200, height: 100 };
    const locked = applyAspectLock(orig, { x: 100, y: 100, width: 400, height: 150 }, EDGES.br, 16);
    expect(locked).toEqual({ x: 100, y: 100, width: 400, height: 200 });
    const clamped = { ...locked, width: 300 }; // right edge stopped at the page border (400)
    // The default (dominant) re-fit would grow the width back past the page; 'shrink' does not.
    expect(applyAspectLock(orig, clamped, EDGES.br, 16).width).toBe(400);
    expect(applyAspectLock(orig, clamped, EDGES.br, 16, { fit: "shrink" })).toEqual({ x: 100, y: 100, width: 300, height: 150 });
  });

  it("1:3 right-edge drag whose following bottom was cut by the page: the width shrinks to match", () => {
    const orig = { x: 100, y: 100, width: 60, height: 180 };
    const locked = applyAspectLock(orig, { x: 100, y: 100, width: 100, height: 180 }, EDGES.r, 16);
    expect(locked).toEqual({ x: 100, y: 100, width: 100, height: 300 });
    const clamped = { ...locked, height: 240 }; // page height 340
    expect(applyAspectLock(orig, clamped, EDGES.r, 16, { fit: "shrink" })).toEqual({ x: 100, y: 100, width: 80, height: 240 });
  });

  it("an already-locked rect is (to the pixel) a fixed point of the shrink re-fit", () => {
    const orig = { x: 100, y: 100, width: 200, height: 100 };
    const locked = applyAspectLock(orig, { x: 100, y: 100, width: 326, height: 120 }, EDGES.br, 16);
    expect(applyAspectLock(orig, locked, EDGES.br, 16, { fit: "shrink" })).toEqual(locked);
  });
});

describe("aspectLockedEdges: the sides that MOVE under the lock", () => {
  it("an edge handle moves its following side; a corner exactly its own", () => {
    expect(aspectLockedEdges(EDGES.r)).toEqual({ left: false, top: false, right: true, bottom: true });
    expect(aspectLockedEdges(EDGES.l)).toEqual({ left: true, top: false, right: false, bottom: true });
    expect(aspectLockedEdges(EDGES.t)).toEqual({ left: false, top: true, right: true, bottom: false });
    expect(aspectLockedEdges(EDGES.b)).toEqual({ left: false, top: false, right: true, bottom: true });
    expect(aspectLockedEdges(EDGES.tl)).toEqual(EDGES.tl);
    expect(aspectLockedEdges(EDGES.br)).toEqual(EDGES.br);
  });
});

describe("applyAspectLock: degenerate input changes nothing", () => {
  it("a zero-size original or no dragged edge returns the free rect", () => {
    const next = { x: 1, y: 2, width: 30, height: 40 };
    expect(applyAspectLock({ x: 0, y: 0, width: 0, height: 10 }, next, EDGES.br, 16)).toEqual(next);
    expect(applyAspectLock({ x: 0, y: 0, width: 10, height: 10 }, next, { left: false, top: false, right: false, bottom: false }, 16)).toEqual(next);
  });
});
