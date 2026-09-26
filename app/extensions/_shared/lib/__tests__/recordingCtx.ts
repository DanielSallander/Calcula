//! FILENAME: app/extensions/_shared/lib/__tests__/recordingCtx.ts
// PURPOSE: A recording CanvasRenderingContext2D double for the clipped, scrolled
//          floating-object painters (the canvas pivot box, the floating grid).
//          It tracks the TRANSLATION and the CLIP stack the way a real context
//          does (clip = intersection, save/restore restore both), so a test can
//          assert WHERE every draw landed in canvas coordinates and under which
//          clip -- "nothing is drawn outside the box" is then a statement about
//          recorded operations, not about a mock call count.
// CONTEXT: Moved here from Pivot/rendering/__tests__/ when the floating grid
//          (FloatingRange, M7) needed the same double: an extension may not
//          import another extension, test files included.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DrawOp {
  op: "fillRect" | "strokeRect" | "fillText" | "fill" | "stroke" | "clearRect";
  /** Canvas-space rect of the op (for text: a 1x1 rect at the anchor). */
  rect: Rect;
  text?: string;
  /** The active clip when the op was issued (canvas space), or null. */
  clip: Rect | null;
}

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const btm = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, r - x), height: Math.max(0, btm - y) };
}

export function rectInside(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x - 1e-9 &&
    inner.y >= outer.y - 1e-9 &&
    inner.x + inner.width <= outer.x + outer.width + 1e-9 &&
    inner.y + inner.height <= outer.y + outer.height + 1e-9
  );
}

export interface RecordingCtx {
  ctx: CanvasRenderingContext2D;
  ops: DrawOp[];
  clips: Rect[];
  translations: Array<{ x: number; y: number }>;
  texts(): DrawOp[];
}

export function createRecordingCtx(): RecordingCtx {
  let tx = 0;
  let ty = 0;
  let clip: Rect | null = null;
  const stack: Array<{ tx: number; ty: number; clip: Rect | null }> = [];
  let path: Rect[] = [];
  let pathPoints: Array<{ x: number; y: number }> = [];
  const ops: DrawOp[] = [];
  const clips: Rect[] = [];
  const translations: Array<{ x: number; y: number }> = [];

  const pathBounds = (): Rect => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const r of path) {
      xs.push(r.x, r.x + r.width);
      ys.push(r.y, r.y + r.height);
    }
    for (const p of pathPoints) {
      xs.push(p.x);
      ys.push(p.y);
    }
    if (xs.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  };

  const state: Record<string, unknown> = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    globalAlpha: 1,
  };

  const ctx = {
    ...state,
    canvas: { width: 2000, height: 2000 },
    save() {
      stack.push({ tx, ty, clip });
    },
    restore() {
      const s = stack.pop();
      if (s) {
        tx = s.tx;
        ty = s.ty;
        clip = s.clip;
      }
    },
    translate(x: number, y: number) {
      tx += x;
      ty += y;
      translations.push({ x, y });
    },
    beginPath() {
      path = [];
      pathPoints = [];
    },
    rect(x: number, y: number, w: number, h: number) {
      path.push({ x: x + tx, y: y + ty, width: w, height: h });
    },
    roundRect(x: number, y: number, w: number, h: number) {
      path.push({ x: x + tx, y: y + ty, width: w, height: h });
    },
    moveTo(x: number, y: number) {
      pathPoints.push({ x: x + tx, y: y + ty });
    },
    lineTo(x: number, y: number) {
      pathPoints.push({ x: x + tx, y: y + ty });
    },
    arc() {},
    closePath() {},
    clip() {
      const r = pathBounds();
      clips.push(r);
      clip = clip ? intersect(clip, r) : r;
    },
    fill() {
      ops.push({ op: "fill", rect: pathBounds(), clip });
    },
    stroke() {
      ops.push({ op: "stroke", rect: pathBounds(), clip });
    },
    fillRect(x: number, y: number, w: number, h: number) {
      ops.push({ op: "fillRect", rect: { x: x + tx, y: y + ty, width: w, height: h }, clip });
    },
    strokeRect(x: number, y: number, w: number, h: number) {
      ops.push({ op: "strokeRect", rect: { x: x + tx, y: y + ty, width: w, height: h }, clip });
    },
    clearRect(x: number, y: number, w: number, h: number) {
      ops.push({ op: "clearRect", rect: { x: x + tx, y: y + ty, width: w, height: h }, clip });
    },
    fillText(text: string, x: number, y: number) {
      ops.push({ op: "fillText", text, rect: { x: x + tx, y: y + ty, width: 1, height: 1 }, clip });
    },
    measureText(text: string) {
      return { width: text.length * 6 };
    },
    setLineDash() {},
  };

  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    ops,
    clips,
    translations,
    texts: () => ops.filter((o) => o.op === "fillText"),
  };
}

/** The part of an op's rect a real canvas would actually paint (its rect clipped). */
export function visiblePart(op: DrawOp): Rect | null {
  if (!op.clip) return op.rect;
  const r = intersect(op.rect, op.clip);
  return r.width > 0 && r.height > 0 ? r : null;
}
