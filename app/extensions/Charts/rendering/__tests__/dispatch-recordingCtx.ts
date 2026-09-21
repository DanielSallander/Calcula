//! FILENAME: app/extensions/Charts/rendering/__tests__/dispatch-recordingCtx.ts
// PURPOSE: A canvas 2D double that records the ORDERED stream of drawing calls
//          AND style property assignments, so a test can assert that painting
//          with a per-point override differs from painting without it at
//          exactly one place.
// CONTEXT: The vi.fn() doubles elsewhere in this folder record calls but not
//          property SETS, and `ctx.fillStyle = "#ff0000"` is precisely how a
//          per-point colour override shows up. A test built on a call-only
//          double cannot see the defect it was written to catch.

/** Methods the chart painters actually use. Anything else throws loudly. */
const RECORDED_METHODS = [
  "fillText",
  "strokeText",
  "fillRect",
  "strokeRect",
  "clearRect",
  "save",
  "restore",
  "beginPath",
  "closePath",
  "moveTo",
  "lineTo",
  "arc",
  "arcTo",
  "ellipse",
  "rect",
  "roundRect",
  "quadraticCurveTo",
  "bezierCurveTo",
  "fill",
  "stroke",
  "clip",
  "setLineDash",
  "translate",
  "rotate",
  "scale",
  "setTransform",
  "resetTransform",
  "drawImage",
  "createLinearGradient",
  "createRadialGradient",
  "createPattern",
] as const;

const STYLE_PROPERTIES: Record<string, unknown> = {
  fillStyle: "",
  strokeStyle: "",
  lineWidth: 1,
  lineCap: "butt",
  lineJoin: "miter",
  miterLimit: 10,
  font: "",
  textAlign: "start",
  textBaseline: "alphabetic",
  globalAlpha: 1,
  globalCompositeOperation: "source-over",
  shadowColor: "rgba(0, 0, 0, 0)",
  shadowBlur: 0,
  shadowOffsetX: 0,
  shadowOffsetY: 0,
  filter: "none",
  direction: "inherit",
  imageSmoothingEnabled: true,
};

function fmt(v: unknown): string {
  if (typeof v === "number") {
    // Round so float noise from scale arithmetic cannot make two otherwise
    // identical streams compare unequal. 4 decimals is far finer than a pixel.
    return Number.isFinite(v) ? String(Math.round(v * 10000) / 10000) : String(v);
  }
  if (Array.isArray(v)) return `[${v.map(fmt).join(" ")}]`;
  if (v === null) return "null";
  if (typeof v === "object") return "{obj}";
  return String(v);
}

export interface RecordingCtx {
  ctx: CanvasRenderingContext2D;
  /** The ordered stream: `name(args)` for calls, `name=value` for style sets. */
  calls: string[];
}

/**
 * Build a recording 2D context double.
 *
 * `measureText` returns a deterministic width (7px per character) and is NOT
 * recorded — it is a read, identical in every run, and recording it would bury
 * the one entry a per-point override actually changes.
 */
export function makeRecordingCtx(width = 600, height = 400): RecordingCtx {
  const calls: string[] = [];
  const style: Record<string, unknown> = { ...STYLE_PROPERTIES };
  const target: Record<string, unknown> = {
    canvas: { width, height },
    measureText: (text: string) => ({
      width: String(text).length * 7,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
    }),
    getContextAttributes: () => ({}),
  };

  for (const name of RECORDED_METHODS) {
    target[name] = (...args: unknown[]) => {
      calls.push(`${name}(${args.map(fmt).join(",")})`);
      // Gradient/pattern factories must return something assignable to
      // fillStyle; a plain tagged object is enough for a stream comparison.
      if (name === "createLinearGradient" || name === "createRadialGradient") {
        return { addColorStop: (...s: unknown[]) => { calls.push(`addColorStop(${s.map(fmt).join(",")})`); } };
      }
      if (name === "createPattern") return { setTransform: () => {} };
      return undefined;
    };
  }

  const ctx = new Proxy(target, {
    get(t, prop) {
      if (typeof prop === "string" && prop in t) return t[prop];
      if (typeof prop === "string" && prop in style) return style[prop];
      return undefined;
    },
    set(_t, prop, value) {
      const key = String(prop);
      style[key] = value;
      calls.push(`${key}=${fmt(value)}`);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;

  return { ctx, calls };
}

/** Indices at which two streams differ. Length mismatch is reported as -1. */
export function streamDiff(a: string[], b: string[]): number[] {
  if (a.length !== b.length) return [-1];
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}
