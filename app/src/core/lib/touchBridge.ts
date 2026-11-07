//! FILENAME: app/src/core/lib/touchBridge.ts
// PURPOSE: TOUCH on the grid (BUG-0276): a tap selects, a drag on a cell PANS,
//          a drag on an object, a handle, a grip, a header or the fill handle
//          drags it, a long press opens the context menu, a double tap is a
//          double-click -- Excel's touch model -- by routing touch POINTER
//          events into the grid's existing MOUSE doors.
// CONTEXT: Every gesture in Core is written against mouse events (the one door,
//          gridPointerEntry.ts, and the window-level drag listeners behind it).
//          Measured live 2026-10-02 (touch-pen-measure.spec.ts): pen and mouse
//          worked everywhere, touch did not. With no `touch-action` on the grid
//          the browser claimed every touch drag for its own panning -- the page
//          saw pointerdown, three moves, pointercancel -- and a browser sends
//          compatibility mouse events for a TAP at most, never for a drag, so no
//          drag could ever reach a mouse handler.
//
//          The bridge therefore owns every touch on the grid area (the caller
//          sets `touch-action: none` on it), cancels the browser's own
//          compatibility mouse events (`preventDefault` on pointerdown, which is
//          what the Pointer Events spec says suppresses them) and the native
//          click / dblclick / contextmenu that still follow a gesture it took
//          (swallowed by a stamp; see installTouchBridge), and speaks the
//          grid's one language: it DISPATCHES mouse events at the touch point.
//          Nothing downstream learns that a finger was involved, so the claim
//          rule, the selection model, the object drags and the cell
//          interceptors all apply unchanged -- a second copy of any of them
//          would drift, which is the lesson of the frozen-pane painter.
//
// EXCEL'S TOUCH MODEL (the behaviour reproduced):
//   - tap a cell: select it (a mouse click there); tap an object: select it;
//     tap a button: run it once;
//   - drag starting on a cell: pan the sheet (Excel's grid scrolls under the
//     finger; it does NOT range-select);
//   - drag starting on an object's body, handle or grip, on a header (select
//     columns / rows, resize at a border) or on the fill handle: the mouse drag
//     of that thing;
//   - long press: the context menu of what is under the finger;
//   - double tap: a double-click (edit the cell);
//   - PINCH (BUG-0729): two fingers zoom the sheet, 10% to 400%, through the
//     same zoom state the zoom slider and Ctrl+wheel set (Excel for Windows
//     pinch-zooms its grid). A second finger landing while the first is
//     panning or pressing ends that gesture -- a held object press is
//     released where it was -- and the two fingers' distance scales the
//     zoom the pinch began at; once one lifts, the other does nothing
//     until it lifts too. A third finger is ignored. Without a zoom door
//     (`deps.zoom`) a second finger is ignored, as before.
//
// Interactive DOM (an input, a textarea, a select, contentEditable, and any
// element that CLAIMS the pointer -- core/lib/pointerClaims.ts) keeps the
// browser's own touch handling: the bridge does not touch the event at all.

/** What a touch that starts at a point should do once it moves. */
export type TouchPressKind = "drag" | "pan";

/** Excel's zoom range, the zoom slider's (render factor: 0.1 = 10%). */
export const PINCH_ZOOM_MIN = 0.1;
export const PINCH_ZOOM_MAX = 4;

/** The pixel distance a finger may wander before a press becomes a drag or a pan. */
export const TOUCH_SLOP_PX = 10;
/** How long a still finger must stay down to be a long press, in ms. */
export const LONG_PRESS_MS = 500;
/** Two taps this close in time (ms) and place (px) are a double tap. */
export const DOUBLE_TAP_MS = 350;
export const DOUBLE_TAP_PX = 16;

/** The touch facts the bridge reads (a PointerEvent satisfies it). */
export interface TouchPointerLike {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  clientX: number;
  clientY: number;
  timeStamp: number;
  target: EventTarget | null;
  preventDefault(): void;
}

/** What the bridge does to the world: every effect goes through here. */
export interface TouchBridgeEffects {
  /** Dispatch a mouse event of `type` at the point, on `target`. */
  mouse(
    type: "mousedown" | "mousemove" | "mouseup" | "click" | "dblclick" | "contextmenu",
    target: EventTarget,
    clientX: number,
    clientY: number,
    init: { button: number; buttons: number; detail: number },
  ): void;
  /** Scroll the sheet so the content follows the finger by (dx, dy) screen px. */
  pan(dx: number, dy: number, clientX: number, clientY: number): void;
  /** Start / stop a timer (injected so the state machine is testable). */
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface TouchBridgeDeps extends TouchBridgeEffects {
  /** Does a press at this point start an object gesture (drag) or a pan? */
  classify(clientX: number, clientY: number, target: EventTarget | null): TouchPressKind;
  /** True when the touch is not the bridge's to take (interactive DOM, a claimed element). */
  isNative(target: EventTarget | null): boolean;
  /** The sheet's zoom (render factor), for a pinch; absent: no pinch. */
  zoom?: { get(): number; set(zoom: number): void };
}

type Phase =
  | { kind: "idle" }
  | { kind: "pending"; id: number; x0: number; y0: number; x: number; y: number; target: EventTarget; timer: unknown }
  | { kind: "drag"; id: number; x: number; y: number; target: EventTarget; timer: unknown; moved: boolean; x0: number; y0: number }
  | { kind: "pan"; id: number; x: number; y: number }
  | { kind: "pinch"; ids: [number, number]; d0: number; z0: number; last: number }
  | { kind: "done"; id: number };

/**
 * The touch gesture state machine. Feed it the grid area's pointer events; it
 * acts only on `pointerType === "touch"` from the PRIMARY finger.
 */
export class TouchGestureBridge {
  private phase: Phase = { kind: "idle" };
  private lastTap: { t: number; x: number; y: number } | null = null;
  /** Where each finger on the grid is now (a pinch reads two of them). */
  private readonly fingers = new Map<number, { x: number; y: number }>();

  constructor(private readonly deps: TouchBridgeDeps) {}

  /** True while a touch gesture is in flight. */
  get active(): boolean {
    return this.phase.kind !== "idle";
  }

  down(e: TouchPointerLike): void {
    if (e.pointerType !== "touch") return;
    if (this.phase.kind !== "idle" || this.fingers.size > 0) this.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // A SECOND finger while one is down: a pinch, when there is a zoom door.
    if (!e.isPrimary || this.phase.kind !== "idle") {
      this.startPinch(e);
      return;
    }
    if (!e.target || this.deps.isNative(e.target)) return;
    // Owning the touch: no compatibility mouse events from the browser (they
    // would arrive AFTER ours and press the grid a second time).
    e.preventDefault();
    this.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const target = e.target;
    const drag = this.deps.classify(e.clientX, e.clientY, target) === "drag";
    const timer = this.deps.setTimer(() => this.longPress(), LONG_PRESS_MS);
    if (drag) {
      // An object gesture starts at once, exactly as the mouse's does, so the
      // object is grabbed where the finger landed.
      this.deps.mouse("mousedown", target, e.clientX, e.clientY, { button: 0, buttons: 1, detail: 1 });
      this.phase = { kind: "drag", id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, target, timer, moved: false };
      return;
    }
    this.phase = {
      kind: "pending",
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
      target,
      timer,
    };
  }

  move(e: TouchPointerLike): void {
    const p = this.phase;
    if (e.pointerType === "touch" && this.fingers.has(e.pointerId)) this.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (p.kind === "pinch") {
      if (!p.ids.includes(e.pointerId)) return;
      e.preventDefault();
      const d = this.spread(p.ids);
      if (d === null || p.d0 <= 0) return;
      const z = Math.round(Math.min(PINCH_ZOOM_MAX, Math.max(PINCH_ZOOM_MIN, (p.z0 * d) / p.d0)) * 100) / 100;
      if (z !== p.last) {
        p.last = z;
        this.deps.zoom?.set(z);
      }
      return;
    }
    if (p.kind === "idle" || p.kind === "done" || e.pointerId !== p.id) return;
    e.preventDefault();
    if (p.kind === "drag") {
      if (!p.moved && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > TOUCH_SLOP_PX) {
        p.moved = true;
        this.deps.clearTimer(p.timer);
      }
      p.x = e.clientX;
      p.y = e.clientY;
      this.deps.mouse("mousemove", p.target, e.clientX, e.clientY, { button: 0, buttons: 1, detail: 0 });
      return;
    }
    if (p.kind === "pending") {
      if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) <= TOUCH_SLOP_PX) return;
      // A cell drag is a PAN (Excel): scroll by the whole movement so far.
      this.deps.clearTimer(p.timer);
      this.deps.pan(e.clientX - p.x, e.clientY - p.y, e.clientX, e.clientY);
      this.phase = { kind: "pan", id: p.id, x: e.clientX, y: e.clientY };
      return;
    }
    // pan
    this.deps.pan(e.clientX - p.x, e.clientY - p.y, e.clientX, e.clientY);
    p.x = e.clientX;
    p.y = e.clientY;
  }

  up(e: TouchPointerLike): void {
    this.fingers.delete(e.pointerId);
    const p = this.phase;
    if (p.kind === "pinch") {
      if (!p.ids.includes(e.pointerId)) return;
      e.preventDefault();
      // One finger lifted: the other does nothing until it lifts too.
      const other = p.ids[0] === e.pointerId ? p.ids[1] : p.ids[0];
      this.phase = this.fingers.has(other) ? { kind: "done", id: other } : { kind: "idle" };
      return;
    }
    if (p.kind === "idle" || e.pointerId !== p.id) return;
    e.preventDefault();
    if (p.kind === "drag") {
      this.deps.clearTimer(p.timer);
      this.deps.mouse("mouseup", p.target, e.clientX, e.clientY, { button: 0, buttons: 0, detail: 1 });
      if (!p.moved) {
        // A tap on an object: the click its mouse press would end in.
        this.deps.mouse("click", p.target, e.clientX, e.clientY, { button: 0, buttons: 0, detail: 1 });
        this.noteTap(e);
      }
    } else if (p.kind === "pending") {
      // A TAP: the mouse click at the press point.
      this.deps.clearTimer(p.timer);
      const second = this.isSecondTap(e);
      const detail = second ? 2 : 1;
      this.deps.mouse("mousedown", p.target, p.x0, p.y0, { button: 0, buttons: 1, detail });
      this.deps.mouse("mouseup", p.target, p.x0, p.y0, { button: 0, buttons: 0, detail });
      this.deps.mouse("click", p.target, p.x0, p.y0, { button: 0, buttons: 0, detail });
      if (second) {
        this.deps.mouse("dblclick", p.target, p.x0, p.y0, { button: 0, buttons: 0, detail: 2 });
        this.lastTap = null;
      } else {
        this.noteTap(e);
      }
    }
    this.phase = { kind: "idle" };
  }

  cancel(e: TouchPointerLike): void {
    this.fingers.delete(e.pointerId);
    const p = this.phase;
    if (p.kind === "pinch") {
      if (!p.ids.includes(e.pointerId)) return;
      const other = p.ids[0] === e.pointerId ? p.ids[1] : p.ids[0];
      this.phase = this.fingers.has(other) ? { kind: "done", id: other } : { kind: "idle" };
      return;
    }
    if (p.kind === "idle" || e.pointerId !== p.id) return;
    if (p.kind === "drag") {
      this.deps.clearTimer(p.timer);
      // Whoever started the gesture ends it: a cancelled drag still releases.
      this.deps.mouse("mouseup", p.target, p.x, p.y, { button: 0, buttons: 0, detail: 1 });
    } else if (p.kind === "pending") {
      this.deps.clearTimer(p.timer);
    }
    this.phase = { kind: "idle" };
  }

  /**
   * A second finger: end the first finger's gesture and start a PINCH from
   * the zoom as it is now. Nothing without a zoom door, a known first finger
   * or while a pinch (or its tail) is already running.
   */
  private startPinch(e: TouchPointerLike): void {
    const p = this.phase;
    const zoom = this.deps.zoom;
    if (!zoom || (p.kind !== "pending" && p.kind !== "pan" && p.kind !== "drag")) return;
    if (!this.fingers.has(p.id) || this.fingers.size !== 2) return;
    e.preventDefault();
    if (p.kind === "pending" || p.kind === "drag") this.deps.clearTimer(p.timer);
    // A held object press is released where it was, as a cancelled drag is.
    if (p.kind === "drag") this.deps.mouse("mouseup", p.target, p.x, p.y, { button: 0, buttons: 0, detail: 1 });
    const ids: [number, number] = [p.id, e.pointerId];
    const d0 = this.spread(ids) ?? 0;
    const z0 = zoom.get();
    this.lastTap = null;
    this.phase = { kind: "pinch", ids, d0, z0, last: z0 };
  }

  /** The distance between two fingers, or null when one is not known. */
  private spread(ids: [number, number]): number | null {
    const a = this.fingers.get(ids[0]);
    const b = this.fingers.get(ids[1]);
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : null;
  }

  /** A still finger held LONG_PRESS_MS: the context menu of what is under it. */
  private longPress(): void {
    const p = this.phase;
    if (p.kind !== "pending" && p.kind !== "drag") return;
    if (p.kind === "drag") {
      // Release the press the object gesture began, unmoved (it selects the
      // object, as the mouse's press-and-release would), before the menu.
      this.deps.mouse("mouseup", p.target, p.x0, p.y0, { button: 0, buttons: 0, detail: 1 });
    }
    const x = p.x0;
    const y = p.y0;
    // The mouse's right click: press (which selects the cell under it when it
    // is outside the selection), release, contextmenu.
    this.deps.mouse("mousedown", p.target, x, y, { button: 2, buttons: 2, detail: 1 });
    this.deps.mouse("mouseup", p.target, x, y, { button: 2, buttons: 0, detail: 1 });
    this.deps.mouse("contextmenu", p.target, x, y, { button: 2, buttons: 0, detail: 0 });
    this.lastTap = null;
    this.phase = { kind: "done", id: p.id };
  }

  private isSecondTap(e: TouchPointerLike): boolean {
    const last = this.lastTap;
    return (
      last !== null &&
      e.timeStamp - last.t <= DOUBLE_TAP_MS &&
      Math.hypot(e.clientX - last.x, e.clientY - last.y) <= DOUBLE_TAP_PX
    );
  }

  private noteTap(e: TouchPointerLike): void {
    this.lastTap = { t: e.timeStamp, x: e.clientX, y: e.clientY };
  }
}

/** True for DOM that keeps the browser's own touch handling (typing, picking). */
export function isNativeTouchTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false;
  const el = target as Element;
  if (el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return true;
  return false;
}

/**
 * How long after a bridged touch gesture ends (ms) the browser's OWN click,
 * dblclick and contextmenu for that touch are still swallowed (see
 * installTouchBridge). The browser sends them at the lift -- Chromium's click
 * and touch dblclick in the same task as pointerup or the next one, its
 * long-press contextmenu at the press or the lift -- so the window only has to
 * outlast that hop; it is kept short so a real mouse click soon after a touch
 * is never mistaken for one.
 */
export const TOUCH_GHOST_MS = 600;
/** How far (px) from the last touch point a native event may land and still
 *  be that touch's duplicate. The browser sends it AT the touch point. */
export const TOUCH_GHOST_PX = 2 * DOUBLE_TAP_PX;

/** The native events that duplicate a bridged gesture. */
const GHOST_TYPES = ["click", "dblclick", "contextmenu"] as const;

/**
 * Install the bridge on the grid area: pointer listeners in the CAPTURE phase
 * (so no descendant's own pointer handler sees a touch before the bridge has
 * decided it) and the DOM dispatch of the synthetic mouse events.
 *
 * THE BROWSER'S OWN DUPLICATES ARE SWALLOWED (rev-ui-6). `preventDefault` on
 * pointerdown cancels only the COMPATIBILITY mouse events (mousedown / mousemove
 * / mouseup). It does NOT cancel `click` (the Pointer Events spec fires it after
 * pointerup regardless), Chromium's `dblclick` for a double tap, or the
 * `contextmenu` a long press raises -- so a tap clicked twice, a double tap ran
 * the grid's onDoubleClick twice (Spreadsheet.tsx, `wrappedDoubleClick`) and a
 * press-and-hold could open the context menu twice. Every event the bridge
 * dispatches is STAMPED (a WeakSet of the event objects), and a window-level
 * CAPTURE listener -- ahead of every document, React-root and element listener
 * -- drops any click / dblclick / contextmenu inside the area that is not
 * stamped while a bridged gesture is in flight or for TOUCH_GHOST_MS after it,
 * near the touch point. A native event that SAYS it is not a touch (a click's
 * `pointerType` "mouse" or "pen", or `sourceCapabilities.firesTouchEvents`
 * false) is never dropped. A touch the bridge leaves alone (an input, a claimed
 * element) arms nothing, so its own native click still arrives.
 *
 * The caller must also set `touch-action: none` on `element`, or the browser
 * takes every touch drag for its own panning and cancels the pointer.
 */
export function installTouchBridge(
  element: HTMLElement,
  deps: Pick<TouchBridgeDeps, "classify" | "pan" | "zoom"> & { isNative?: (t: EventTarget | null) => boolean },
): () => void {
  const view = element.ownerDocument?.defaultView ?? window;
  /** The mouse events this bridge dispatched: never a duplicate. */
  const stamped = new WeakSet<Event>();
  /** Where the bridged touch last was, and until when its duplicates are dropped
   *  once it has ended (Date.now() ms; the in-flight gesture is `bridge.active`). */
  let ghost: { x: number; y: number; until: number } | null = null;
  const bridge = new TouchGestureBridge({
    classify: deps.classify,
    pan: deps.pan,
    ...(deps.zoom ? { zoom: deps.zoom } : {}),
    isNative: (t) => isNativeTouchTarget(t) || (deps.isNative?.(t) ?? false),
    mouse(type, target, clientX, clientY, init) {
      const ctor = view.MouseEvent ?? MouseEvent;
      const event = new ctor(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX,
        clientY,
        screenX: clientX,
        screenY: clientY,
        button: init.button,
        buttons: init.buttons,
        detail: init.detail,
      });
      stamped.add(event);
      target.dispatchEvent(event);
    },
    setTimer: (fn, ms) => view.setTimeout(fn, ms),
    clearTimer: (h) => view.clearTimeout(h as number),
  });
  /** Note the bridged touch's point; `ended` starts the after-window. */
  const track = (e: PointerEvent, ended: boolean) => {
    if (e.pointerType !== "touch" || !e.isPrimary) return;
    if (!ghost && !bridge.active) return;
    ghost = { x: e.clientX, y: e.clientY, until: ended ? Date.now() + TOUCH_GHOST_MS : Number.POSITIVE_INFINITY };
  };
  const onDown = (e: PointerEvent) => {
    const wasActive = bridge.active;
    bridge.down(e);
    if (!wasActive && bridge.active && e.pointerType === "touch") {
      ghost = { x: e.clientX, y: e.clientY, until: Number.POSITIVE_INFINITY };
      try {
        element.setPointerCapture?.(e.pointerId);
      } catch {
        // A pointer the browser already released: nothing to capture.
      }
    }
  };
  const onMove = (e: PointerEvent) => {
    const wasActive = bridge.active;
    bridge.move(e);
    if (wasActive) track(e, false);
  };
  const onUp = (e: PointerEvent) => {
    const wasActive = bridge.active;
    bridge.up(e);
    if (wasActive && !bridge.active) track(e, true);
  };
  const onCancel = (e: PointerEvent) => {
    const wasActive = bridge.active;
    bridge.cancel(e);
    if (wasActive && !bridge.active) track(e, true);
  };
  const onGhost = (e: Event) => {
    if (!ghost || stamped.has(e)) return;
    const target = e.target as Node | null;
    if (!target || typeof element.contains !== "function" || !element.contains(target)) return;
    if (!bridge.active && Date.now() > ghost.until) {
      ghost = null;
      return;
    }
    const m = e as MouseEvent & { pointerType?: string; sourceCapabilities?: { firesTouchEvents?: boolean } | null };
    // A native event that says it came from a mouse or a pen is the user's.
    if (typeof m.pointerType === "string" && m.pointerType !== "" && m.pointerType !== "touch") return;
    if (m.sourceCapabilities && m.sourceCapabilities.firesTouchEvents === false) return;
    if (Math.hypot((m.clientX ?? 0) - ghost.x, (m.clientY ?? 0) - ghost.y) > TOUCH_GHOST_PX) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  element.addEventListener("pointerdown", onDown, true);
  element.addEventListener("pointermove", onMove, true);
  element.addEventListener("pointerup", onUp, true);
  element.addEventListener("pointercancel", onCancel, true);
  for (const type of GHOST_TYPES) view.addEventListener(type, onGhost, true);
  return () => {
    element.removeEventListener("pointerdown", onDown, true);
    element.removeEventListener("pointermove", onMove, true);
    element.removeEventListener("pointerup", onUp, true);
    element.removeEventListener("pointercancel", onCancel, true);
    for (const type of GHOST_TYPES) view.removeEventListener(type, onGhost, true);
  };
}
